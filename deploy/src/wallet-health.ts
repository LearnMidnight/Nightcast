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
 */
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

/** The fee failed because the wallet found no coin to pay with (wallet SDK 2's `Wallet.InsufficientFunds`). */
export const isInsufficientFunds = (err: unknown): boolean => {
  const text = typeof err === 'string' ? err : `${err instanceof Error ? err.message : ''} ${inspect(err, { depth: 8 })}`;
  return /InsufficientFunds|Insufficient funds/i.test(text);
};

export type HealthOptions = { pendingMinutes?: number; dustStallMinutes?: number };

/** Minutes from the environment: NIGHTCAST_PENDING_MINUTES (default 8) and NIGHTCAST_DUST_STALL_MINUTES (default 10). */
export const healthOptions = (env: NodeJS.ProcessEnv = process.env): Required<HealthOptions> => {
  const minutes = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { pendingMinutes: minutes(env.NIGHTCAST_PENDING_MINUTES, 8), dustStallMinutes: minutes(env.NIGHTCAST_DUST_STALL_MINUTES, 10) };
};

export class WalletHealth {
  private dustAt = '';
  private dustMovedAt: number;
  private holdsDust = false;
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
  }

  /** Feed a wallet state. */
  see(state: unknown): void {
    const dust = dustOf(state);
    if (!dust) return;
    const now = this.clock();
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
