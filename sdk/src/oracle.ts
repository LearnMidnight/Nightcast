import { oraclePublicKey, pureCircuits, Status } from '@nightcast/contract';
import { type NightcastChain, type RequestEntry, sameKey } from './chain.js';

export type OracleLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type OracleOptions = {
  chain: NightcastChain;
  /** The oracle's secret scalar. Used to recognise its own requests and pre-compute outputs. */
  secretKey: bigint;
  /** How often to look for new requests, in ms. */
  pollMs?: number;
  /**
   * Don't start a fulfil with less than this many seconds to the deadline:
   * proving and inclusion have to finish first. Keep it below the contract's
   * minWindow.
   */
  safetyMarginSecs?: number;
  /**
   * Wait this long (ms) after first seeing a request before answering it. The
   * indexer can show a new request a few seconds before the node we submit to
   * has it, and a fulfil sent too early is rejected. Default 20 s.
   */
  newRequestDelayMs?: number;
  /**
   * After a fulfil succeeds, don't try that request again for this long (ms)
   * even if the indexer still lists it as pending: it lags behind the chain,
   * and a second fulfil would only be rejected. Default 10 minutes; after
   * that, a request still pending is retried (its transaction may have been
   * dropped).
   */
  answeredGraceMs?: number;
  /** First retry delay after a failed fulfil, in ms; doubles each failure up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Only answer requests from these requester commitments (hex). Leave unset
   * to answer everyone. Useful against spam, since v0 requests are free.
   */
  requesters?: Iterable<string>;
  /**
   * Mark a request this oracle missed as expired once its deadline has passed
   * (one a tick, retried every 5 minutes), so the requester gets the fee and
   * the collateral back without having to ask. Off by default; needs a chain
   * with `expire`.
   */
  expireMissed?: boolean;
  /** Clock in seconds; defaults to the chain's clock if it has one, else the local clock. */
  now?: () => Promise<number> | number;
  logger?: OracleLogger;
};

export type TickReport = {
  fulfilled: string[];
  failed: { id: string; error: string }[];
  skipped: { id: string; reason: string }[];
};

type Retry = { failures: number; nextTryAt: number };

/** How long after its deadline a missed request is marked expired, and how long before another try. */
const EXPIRE_AFTER_SECS = 60;
const EXPIRE_RETRY_MS = 5 * 60_000;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const silent: OracleLogger = { info() {}, warn() {}, error() {} };

/**
 * Requests this oracle should answer now: pending, bound to its key, from an
 * allowed requester, with enough time left. Earliest deadline first.
 */
export const selectWork = (
  entries: RequestEntry[],
  key: { x: bigint; y: bigint },
  nowSecs: number,
  safetyMarginSecs: number,
  requesters?: ReadonlySet<string>,
): { todo: RequestEntry[]; tooLate: RequestEntry[] } => {
  const mine = entries.filter(
    (e) =>
      e.request.status === Status.pending &&
      sameKey(e.request.oracleKey, key) &&
      (!requesters || requesters.has(hex(e.request.requester))),
  );
  const cutoff = BigInt(Math.floor(nowSecs) + safetyMarginSecs);
  return {
    todo: mine.filter((e) => e.request.deadline > cutoff).sort((a, b) => Number(a.request.deadline - b.request.deadline)),
    tooLate: mine.filter((e) => e.request.deadline <= cutoff),
  };
};

/**
 * Watches a Nightcast deployment and fulfils every pending request bound to
 * its key. Fulfils one at a time, which keeps wallet balancing simple and
 * avoids two transactions competing for the same fees. Failed fulfils are
 * retried with exponential backoff until the deadline gets too close. It
 * reads requests from an indexer, which can be a little ahead of the node it
 * submits to (a new request) or behind the chain (a request it has just
 * answered), so it waits briefly before answering a new request and doesn't
 * answer the same one twice in quick succession.
 *
 * The oracle cannot choose outputs: each one is fixed by the key and the
 * request's stored point. Its only power is to answer or not, which is why
 * requests carry deadlines and anyone can `expire` a missed one.
 */

/**
 * An error's message followed by its causes' (`message <- cause <- cause`).
 * Midnight.js reports a failed step as "balanceTx rejected the transaction
 * ... The provider's own failure is on `cause`"; the reason is in the causes
 * (redacted by Midnight.js of transaction and witness material).
 */
export const withCauses = (err: unknown, depth = 0): string => {
  if (err === undefined || err === null || depth > 6) return '';
  const message = err instanceof Error ? err.message : String(err);
  const cause = typeof err === 'object' && 'cause' in err ? withCauses((err as { cause?: unknown }).cause, depth + 1) : '';
  return cause && !message.includes(cause) ? `${message} <- ${cause}` : message;
};

export class NightcastOracle {
  readonly publicKey: { x: bigint; y: bigint };
  private readonly retries = new Map<string, Retry>();
  private readonly warnedLate = new Set<string>();
  /** Missed requests this oracle has tried to mark expired, and when to try each again. */
  private readonly expireTries = new Map<string, number>();
  /** When each pending request was first seen (ms, local clock). */
  private readonly firstSeen = new Map<string, number>();
  /** When each request was last fulfilled successfully (ms, local clock). */
  private readonly answered = new Map<string, number>();
  private readonly requesters: ReadonlySet<string> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private busy: Promise<TickReport> | undefined;
  private readonly cfg: {
    pollMs: number;
    safetyMarginSecs: number;
    backoffMs: number;
    maxBackoffMs: number;
    newRequestDelayMs: number;
    answeredGraceMs: number;
  };
  private readonly logger: OracleLogger;

  constructor(private readonly options: OracleOptions) {
    this.publicKey = oraclePublicKey(options.secretKey);
    this.cfg = {
      pollMs: options.pollMs ?? 5_000,
      safetyMarginSecs: options.safetyMarginSecs ?? 120,
      backoffMs: options.backoffMs ?? 5_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      newRequestDelayMs: options.newRequestDelayMs ?? 20_000,
      answeredGraceMs: options.answeredGraceMs ?? 10 * 60_000,
    };
    this.requesters = options.requesters ? new Set([...options.requesters].map((r) => r.toLowerCase())) : undefined;
    this.logger = options.logger ?? silent;
  }

  /** The output this oracle will publish for a request (handy for logs and checks). */
  expectedOutput(entry: RequestEntry): Uint8Array {
    return pureCircuits.evaluateAt(this.options.secretKey, entry.request.point);
  }

  private async nowSecs(): Promise<number> {
    if (this.options.now) return this.options.now();
    if (this.options.chain.now) return this.options.chain.now();
    return Date.now() / 1000;
  }

  /**
   * Run `work` between passes, never during one: for another transaction from
   * the oracle's wallet (a bond deposit, a transfer), which would otherwise
   * compete with an answer for the same fee coins.
   */
  async between<T>(work: () => Promise<T>): Promise<T> {
    while (this.busy) await this.busy.catch(() => undefined);
    let out: { value: T } | { error: unknown } | undefined;
    const idle: TickReport = { fulfilled: [], failed: [], skipped: [] };
    this.busy = work()
      .then(
        (value) => {
          out = { value };
        },
        (error: unknown) => {
          out = { error };
        },
      )
      .then(() => idle)
      .finally(() => {
        this.busy = undefined;
      });
    await this.busy;
    if (out && 'error' in out) throw out.error;
    return (out as { value: T }).value;
  }

  /** One pass: find work, fulfil it, report. Never runs twice at once. */
  tick(): Promise<TickReport> {
    if (!this.busy) {
      this.busy = this.doTick().finally(() => {
        this.busy = undefined;
      });
    }
    return this.busy;
  }

  private async doTick(): Promise<TickReport> {
    const { chain } = this.options;
    const { safetyMarginSecs, backoffMs, maxBackoffMs, newRequestDelayMs, answeredGraceMs } = this.cfg;
    const report: TickReport = { fulfilled: [], failed: [], skipped: [] };

    const entries = await chain.listRequests();
    const { todo, tooLate } = selectWork(entries, this.publicKey, await this.nowSecs(), safetyMarginSecs, this.requesters);

    // Forget state for requests that are no longer pending for us.
    const live = new Set(todo.map((e) => hex(e.id)));
    for (const id of this.retries.keys()) if (!live.has(id)) this.retries.delete(id);
    for (const id of this.firstSeen.keys()) if (!live.has(id)) this.firstSeen.delete(id);
    for (const id of this.answered.keys()) if (!live.has(id)) this.answered.delete(id);
    const late = new Set(tooLate.map((e) => hex(e.id)));
    for (const id of this.warnedLate) if (!late.has(id)) this.warnedLate.delete(id);

    for (const e of tooLate) {
      const id = hex(e.id);
      if (!this.warnedLate.has(id)) {
        this.warnedLate.add(id);
        this.logger.warn(`request ${id} is too close to its deadline (${e.request.deadline}); leaving it to expire`);
      }
      report.skipped.push({ id, reason: 'too close to deadline' });
    }

    if (this.options.expireMissed && chain.expire) {
      // A minute past the deadline, so the node's clock agrees it has passed.
      const passed = BigInt(Math.floor(await this.nowSecs()) - EXPIRE_AFTER_SECS);
      for (const id of this.expireTries.keys()) if (!late.has(id)) this.expireTries.delete(id);
      const due = tooLate.find((e) => e.request.deadline <= passed && Date.now() >= (this.expireTries.get(hex(e.id)) ?? 0));
      if (due) {
        const id = hex(due.id);
        this.expireTries.set(id, Date.now() + EXPIRE_RETRY_MS);
        try {
          await chain.expire(due.id);
          this.logger.info(`marked ${id} expired: its fee and collateral go back to the requester`);
        } catch (err) {
          this.logger.warn(`could not mark ${id} expired (trying again in ${EXPIRE_RETRY_MS / 60_000} minutes): ${withCauses(err)}`);
        }
      }
    }

    for (const e of todo) {
      const id = hex(e.id);
      const seenAt = this.firstSeen.get(id) ?? Date.now();
      if (!this.firstSeen.has(id)) this.firstSeen.set(id, seenAt);
      if (Date.now() - seenAt < newRequestDelayMs) {
        report.skipped.push({ id, reason: 'new; letting the node catch up' });
        continue;
      }
      const answeredAt = this.answered.get(id);
      if (answeredAt !== undefined && Date.now() - answeredAt < answeredGraceMs) {
        report.skipped.push({ id, reason: 'answered; waiting for the indexer' });
        continue;
      }
      const retry = this.retries.get(id);
      if (retry && Date.now() < retry.nextTryAt) {
        report.skipped.push({ id, reason: 'backing off' });
        continue;
      }
      // Proving takes time, so check the deadline again right before each fulfil.
      if (e.request.deadline <= BigInt(Math.floor(await this.nowSecs()) + safetyMarginSecs)) {
        report.skipped.push({ id, reason: 'too close to deadline' });
        continue;
      }
      try {
        await chain.fulfil(e.id);
        this.retries.delete(id);
        this.answered.set(id, Date.now());
        report.fulfilled.push(id);
        this.logger.info(`fulfilled ${id} -> ${hex(this.expectedOutput(e))}`);
      } catch (err) {
        const message = withCauses(err);
        const failures = (retry?.failures ?? 0) + 1;
        const delay = Math.min(backoffMs * 2 ** (failures - 1), maxBackoffMs);
        this.retries.set(id, { failures, nextTryAt: Date.now() + delay });
        report.failed.push({ id, error: message });
        this.logger.error(`fulfil ${id} failed (attempt ${failures}, retry in ${delay} ms): ${message}`);
      }
    }
    return report;
  }

  /** Poll until {@link stop} is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.running) this.timer = setTimeout(loop, this.cfg.pollMs);
    };
    void loop();
  }

  /** Stop polling; resolves after any in-flight pass finishes. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy) await this.busy.catch(() => undefined);
  }
}
