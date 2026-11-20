/**
 * Noticing when a long-running service's wallet is stuck, so it can restart.
 *
 * Seen on Preprod (11 Nov 2026, wallet SDK 2 over Blockfrost): a service
 * whose wallet had just opened paid for one to three transactions, one per
 * DUST coin it held, and then every fee failed with `Wallet.InsufficientFunds`
 * although its balance was thousands of DUST. A transaction books the coin
 * its fee comes from ("pending") until the wallet sees that transaction on
 * chain; in these services that never happened, while its view of DUST fell
 * further and further behind. A restart, which syncs afresh from the saved
 * state, freed the coins every time.
 *
 * So a service reports it is stuck (and restarts, exit code 75) when:
 * - a fee fails for insufficient funds while the wallet holds DUST;
 * - a coin has been booked for longer than `pendingMinutes` (a healthy wallet
 *   frees it within a few minutes of the transaction landing); or
 * - the DUST part hasn't applied a new chain event for `dustStallMinutes`
 *   (Preprod has DUST events every minute or so).
 *
 * Seen on Preprod (14 Nov 2026, a LunaSpin request): the oracle's DUST view
 * stalled while a request waited. The first fulfil spent two minutes proving,
 * then failed with `DustTreesNotAtBlock` ("No Dust spend can be dated yet"),
 * and the 10-minute stall rule restarted the oracle with two minutes left
 * before the request's deadline. So, sooner, when there is something to pay
 * for:
 * - a fee that fails because the wallet's DUST trees are behind the chain
 *   restarts at once; and
 * - before a fulfil, `readyToPay()` refuses to start one (and the service
 *   restarts) when the DUST view hasn't moved for `answerStallMinutes`.
 */
import { dustClock } from './dust-time.js';
import { inspect } from 'node:util';

type Progress = { appliedIndex?: bigint; appliedId?: bigint };
type Coin = { token?: { nonce?: unknown } };
type DustPart = { progress?: Progress; state?: { progress?: Progress }; pendingCoins?: readonly Coin[]; balance?: (at: Date) => bigint };

/** The DUST part of a wallet state, read defensively (its getters throw before the part has started). */
const dustOf = (state: unknown): DustPart | undefined => {
  try {
    return (state as { dust?: DustPart })?.dust;
  } catch {
    return undefined;
  }
};

const read = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

/** The fee failed because the wallet's DUST trees are behind the chain (wallet SDK 2's `DustTreesNotAtBlock`). */
export const isDustBehindChain = (err: unknown): boolean => {
  const text = typeof err === 'string' ? err : `${err instanceof Error ? err.message : ''} ${inspect(err, { depth: 8 })}`;
  return /DustTreesNotAtBlock|No Dust spend can be dated/i.test(text);
};

/**
 * An answer failed because the oracle's key is no longer in its private state. Something replaced the
 * private state the oracle shares (16 Nov 2026: the upkeep's bond deposit); a restart loads the key again.
 */
export const isKeyMissing = (err: unknown): boolean => {
  const text = typeof err === 'string' ? err : `${err instanceof Error ? err.message : ''} ${inspect(err, { depth: 8 })}`;
  return /no oracle secret key in private state/i.test(text);
};

/** The fee failed because the wallet found no coin to pay with (wallet SDK 2's `Wallet.InsufficientFunds`). */
export const isInsufficientFunds = (err: unknown): boolean => {
  const text = typeof err === 'string' ? err : `${err instanceof Error ? err.message : ''} ${inspect(err, { depth: 8 })}`;
  return /InsufficientFunds|Insufficient funds/i.test(text);
};

export type HealthOptions = {
  pendingMinutes?: number;
  dustStallMinutes?: number;
  answerStallMinutes?: number;
  /**
   * How long after starting before a DUST view too old to date a fee restarts an idle service
   * (NIGHTCAST_DUST_AGE_STARTUP_MINUTES, default 20): a fresh sync gets its chance first, and a
   * chain with no DUST events for a while can't make the service restart over and over.
   */
  dustAgeStartupMinutes?: number;
};

/**
 * Seconds short of the DUST grace period at which a view counts as too old to date a fee: the same
 * margin dust-time.ts uses before falling back to the wallet library's default, which then retries
 * for 2 minutes and fails with DustTreesNotAtBlock (LunaSpin, 20 Nov 2026: a spin 4 minutes late).
 */
export const DUST_AGE_MARGIN_SECS = 600;

/**
 * Minutes from the environment: NIGHTCAST_PENDING_MINUTES (default 8), NIGHTCAST_DUST_STALL_MINUTES
 * (default 10) and NIGHTCAST_ANSWER_STALL_MINUTES (default 3: how stale the DUST view may be when
 * a request is about to be answered).
 */
/** A number of minutes from an environment value, or `fallback` when it's unset or not a positive number. */
export const minutesFromEnv = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export const healthOptions = (env: NodeJS.ProcessEnv = process.env): Required<HealthOptions> => {
  const minutes = minutesFromEnv;
  return {
    pendingMinutes: minutes(env.NIGHTCAST_PENDING_MINUTES, 8),
    dustStallMinutes: minutes(env.NIGHTCAST_DUST_STALL_MINUTES, 10),
    answerStallMinutes: minutes(env.NIGHTCAST_ANSWER_STALL_MINUTES, 3),
    dustAgeStartupMinutes: minutes(env.NIGHTCAST_DUST_AGE_STARTUP_MINUTES, 20),
  };
};

export class WalletHealth {
  private dustAt = '';
  private dustMovedAt: number;
  private holdsDust = false;
  /** The latest wallet state, read for the DUST view's own time (syncTime) only when asked. */
  private lastState?: unknown;
  /** Set once the wallet has opened (synced): before that an old DUST view is just a sync in progress. */
  private open = false;
  private readonly startedAt: number;
  /** Each booked coin (by nonce) and when it was first seen booked. */
  private readonly pendingSince = new Map<string, number>();
  private reason?: string;
  private readonly o: Required<HealthOptions>;

  constructor(
    options: HealthOptions = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.o = { ...healthOptions({}), ...options };
    this.dustMovedAt = clock();
    this.startedAt = clock();
  }

  /** Feed a wallet state. */
  see(state: unknown): void {
    const dust = dustOf(state);
    if (!dust) return;
    const now = this.clock();
    this.lastState = state;
    const p = read(() => dust.progress ?? dust.state?.progress);
    const at = String(p?.appliedIndex ?? p?.appliedId ?? '');
    if (at !== '' && at !== this.dustAt) {
      this.dustAt = at;
      this.dustMovedAt = now;
    }
    const balance = read(() => dust.balance?.(new Date(now)));
    if (balance !== undefined) this.holdsDust = balance > 0n;
    const pending = read(() => dust.pendingCoins);
    if (pending) {
      const nonces = new Set(pending.map((c, i) => String(c?.token?.nonce ?? `#${i}`)));
      for (const n of [...this.pendingSince.keys()]) if (!nonces.has(n)) this.pendingSince.delete(n);
      for (const n of nonces) if (!this.pendingSince.has(n)) this.pendingSince.set(n, now);
    }
  }

  /** Feed a failed transaction (or the text of one). */
  failed(err: unknown): void {
    if (isInsufficientFunds(err) && this.holdsDust) {
      this.reason ??= 'a fee failed for insufficient funds although the wallet holds DUST (its coins are stuck as booked)';
    }
    if (isDustBehindChain(err)) {
      this.reason ??= "a fee failed because the wallet's DUST view is behind the chain";
    }
    if (isKeyMissing(err)) {
      this.reason ??= "an answer failed because the oracle's key is missing from its private state";
    }
  }

  /** How old the DUST view is, in seconds (from its own syncTime), once known. */
  dustAgeSecs(): number | undefined {
    const t = read(() => dustClock(this.lastState).syncTime);
    return t === undefined ? undefined : Math.max(0, Math.round((this.clock() - t.getTime()) / 1000));
  }

  /** Call once the wallet has opened (synced); the DUST-age checks only apply after that. */
  walletOpen(): void {
    this.open = true;
  }

  /**
   * The DUST view is too old for a fee to be dated at its time (dust-time.ts would fall back to the
   * library's default) while it is still applying events: it is lagging behind the chain. A view
   * that is old because the chain has had no DUST events doesn't count (the library's default dates
   * such a fee fine, and the stall rule above already covers a view that stops moving).
   */
  private dustTooOld(): string | undefined {
    if (!this.open) return undefined;
    if (this.dustAt === '' || (this.clock() - this.dustMovedAt) / 60_000 >= this.o.answerStallMinutes) return undefined;
    const age = this.dustAgeSecs();
    if (age === undefined) return undefined;
    const grace = read(() => dustClock(this.lastState).graceSecs) ?? 3600;
    if (age <= grace - DUST_AGE_MARGIN_SECS) return undefined;
    return `the wallet's DUST view is ${Math.floor(age / 60)} minutes behind the chain, too far to date a fee`;
  }

  /**
   * Call before sending a request (the MCP server). Returns why not, and marks the wallet stuck, when
   * its DUST view is too old to date a fee: the fee would fail after the library's 2-minute retry,
   * while a restart resyncs in about a minute and the caller sends again.
   */
  readyToSend(): string | undefined {
    const old = this.dustTooOld();
    if (!old) return undefined;
    const why = `a request came in and ${old}`;
    this.reason ??= why;
    return why;
  }

  /**
   * Call before paying for something that can't wait (the oracle's fulfil). Returns why not, and
   * marks the wallet stuck, when its DUST view hasn't moved for `answerStallMinutes`: a fee would
   * likely fail after minutes of proving, and a restart syncs afresh in about a minute.
   */
  readyToPay(): string | undefined {
    const old = this.dustTooOld();
    if (old) {
      const why = `a request is waiting and ${old}`;
      this.reason ??= why;
      return why;
    }
    if (this.dustAt === '') return undefined;
    const idle = (this.clock() - this.dustMovedAt) / 60_000;
    if (idle < this.o.answerStallMinutes) return undefined;
    const why = `a request is waiting and the wallet's DUST view hasn't moved for ${Math.floor(idle)} minutes`;
    this.reason ??= why;
    return why;
  }

  /** Why the wallet looks stuck, if it does. */
  stuck(): string | undefined {
    if (this.reason) return this.reason;
    const now = this.clock();
    const oldest = Math.min(...this.pendingSince.values());
    if (Number.isFinite(oldest) && (now - oldest) / 60_000 >= this.o.pendingMinutes) {
      return `a DUST coin has been booked for ${Math.floor((now - oldest) / 60_000)} minutes without the wallet seeing its transaction`;
    }
    if (this.dustAt !== '' && (now - this.dustMovedAt) / 60_000 >= this.o.dustStallMinutes) {
      return `the wallet's DUST view hasn't moved for ${Math.floor((now - this.dustMovedAt) / 60_000)} minutes`;
    }
    // Idle: restart before the next request meets a view too old to pay with (not in the first minutes after a start).
    if ((now - this.startedAt) / 60_000 >= this.o.dustAgeStartupMinutes) {
      const old = this.dustTooOld();
      if (old) return old;
    }
    return undefined;
  }
}

type LogFn = (obj: unknown, ...rest: unknown[]) => void;

/**
 * A logger like `logger` whose error and warning lines are also passed to
 * `onFailure` (the oracle reports a failed answer only by logging it).
 */
export const noticingFailures = <L extends { error: LogFn; warn: LogFn }>(logger: L, onFailure: (text: string) => void): L =>
  new Proxy(logger, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if ((prop === 'error' || prop === 'warn') && typeof v === 'function') {
        return (...args: unknown[]) => {
          onFailure(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' '));
          return (v as LogFn).apply(target, args as [unknown, ...unknown[]]);
        };
      }
      return typeof v === 'function' ? (v as LogFn).bind(target) : v;
    },
  });

/**
 * How many fees the wallet can pay at once: its DUST coins that are free (not booked by a transaction still
 * on its way) and hold some DUST. At least 1, so a wallet state of an unexpected shape never stops answering.
 */
export const freeDustCoins = (state: unknown): number => {
  try {
    const coins = (state as { dust?: { availableCoins?: readonly { generatedNow?: bigint }[] } }).dust?.availableCoins;
    if (!Array.isArray(coins)) return 1;
    const usable = coins.filter((c) => typeof c.generatedNow !== 'bigint' || c.generatedNow > 0n).length;
    return Math.max(1, usable);
  } catch {
    return 1;
  }
};

/** NIGHTCAST_PARALLEL: how many requests the oracle may answer at once (default 1, at most 8). */
export const parallelFromEnv = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.NIGHTCAST_PARALLEL ?? '1');
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 1;
};

/**
 * The wallet's fee coins in a few words, for the log line when requests wait together but it can pay fewer
 * fees at once than NIGHTCAST_PARALLEL: free DUST coins holding DUST, all free ones, booked ones, and NIGHT
 * UTXOs (each registered one generates DUST).
 */
export const describeFeeCoins = (state: unknown): string => {
  try {
    const s = state as {
      dust?: { availableCoins?: readonly { generatedNow?: bigint }[]; pendingCoins?: readonly unknown[] };
      unshielded?: { availableCoins?: readonly { utxo?: { type?: string } }[] };
    };
    const free = Array.isArray(s.dust?.availableCoins) ? s.dust!.availableCoins! : [];
    const holding = free.filter((c) => typeof c.generatedNow !== 'bigint' || c.generatedNow > 0n).length;
    const booked = Array.isArray(s.dust?.pendingCoins) ? s.dust!.pendingCoins!.length : 0;
    const night = Array.isArray(s.unshielded?.availableCoins) ? s.unshielded!.availableCoins!.length : undefined;
    return `${holding} DUST coin(s) holding DUST of ${free.length} free, ${booked} booked${night !== undefined ? `; ${night} unshielded UTXO(s)` : ''}`;
  } catch {
    return '';
  }
};

/**
 * How quickly the oracle answers (18 Nov 2026: a LunaSpin spin took about 90 s, about 30 s of it the
 * oracle's own waiting):
 * - NIGHTCAST_NEW_REQUEST_DELAY_SECS (0-60, default 20): the pause after first seeing a request, for
 *   the node to catch up with the indexer (a fulfil sent too early is refused);
 * - NIGHTCAST_BUSY_POLL_SECS (1-5, default 5): how often it looks while a request is waiting.
 */
export const oracleSpeedFromEnv = (env: NodeJS.ProcessEnv = process.env): { newRequestDelaySecs: number; busyPollSecs: number } => {
  const num = (v: string | undefined, min: number, max: number, dflt: number): number => {
    if (v === undefined || v.trim() === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : dflt;
  };
  return { newRequestDelaySecs: num(env.NIGHTCAST_NEW_REQUEST_DELAY_SECS, 0, 60, 20), busyPollSecs: num(env.NIGHTCAST_BUSY_POLL_SECS, 1, 5, 5) };
};
