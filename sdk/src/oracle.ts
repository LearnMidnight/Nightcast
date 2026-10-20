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
  /** First retry delay after a failed fulfil, in ms; doubles each failure up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Only answer requests from these requester commitments (hex). Leave unset
   * to answer everyone. Useful against spam, since v0 requests are free.
   */
  requesters?: Iterable<string>;
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
 * retried with exponential backoff until the deadline gets too close.
 *
 * The oracle cannot choose outputs: each one is fixed by the key and the
 * request's stored point. Its only power is to answer or not, which is why
 * requests carry deadlines and anyone can `expire` a missed one.
 */
export class NightcastOracle {
  readonly publicKey: { x: bigint; y: bigint };
  private readonly retries = new Map<string, Retry>();
  private readonly warnedLate = new Set<string>();
  private readonly requesters: ReadonlySet<string> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private busy: Promise<TickReport> | undefined;
  private readonly cfg: { pollMs: number; safetyMarginSecs: number; backoffMs: number; maxBackoffMs: number };
  private readonly logger: OracleLogger;

  constructor(private readonly options: OracleOptions) {
    this.publicKey = oraclePublicKey(options.secretKey);
    this.cfg = {
      pollMs: options.pollMs ?? 5_000,
      safetyMarginSecs: options.safetyMarginSecs ?? 120,
      backoffMs: options.backoffMs ?? 5_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
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
    const { safetyMarginSecs, backoffMs, maxBackoffMs } = this.cfg;
    const report: TickReport = { fulfilled: [], failed: [], skipped: [] };

    const entries = await chain.listRequests();
    const { todo, tooLate } = selectWork(entries, this.publicKey, await this.nowSecs(), safetyMarginSecs, this.requesters);

    // Forget state for requests that are no longer pending for us.
    const live = new Set(todo.map((e) => hex(e.id)));
    for (const id of this.retries.keys()) if (!live.has(id)) this.retries.delete(id);
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

    for (const e of todo) {
      const id = hex(e.id);
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
        report.fulfilled.push(id);
        this.logger.info(`fulfilled ${id} -> ${hex(this.expectedOutput(e))}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
