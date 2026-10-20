import { oraclePublicKey, pureCircuits, Status } from '@nightcast/contract';
import { type NightcastChain, type RequestEntry, sameKey } from './chain.js';

export type OracleLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type OracleOptions = {
  chain: NightcastChain;
  /** The oracle's secret scalar. Used only to recognise its own requests and pre-compute outputs. */
  secretKey: bigint;
  /** How often to look for new requests, in ms. */
  pollMs?: number;
  /** Skip a request whose deadline is closer than this many seconds (the tx wouldn't land in time). */
  safetyMarginSecs?: number;
  /** Failed attempts allowed per request before giving up on it. */
  maxAttempts?: number;
  logger?: OracleLogger;
};

export type TickReport = {
  fulfilled: string[];
  failed: { id: string; error: string }[];
  skipped: { id: string; reason: string }[];
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const silent: OracleLogger = { info() {}, warn() {}, error() {} };

/**
 * Requests this oracle should answer now: pending, bound to its key, with
 * enough time left. Earliest deadline first.
 */
export const selectWork = (
  entries: RequestEntry[],
  key: { x: bigint; y: bigint },
  nowSecs: number,
  safetyMarginSecs: number,
): { todo: RequestEntry[]; tooLate: RequestEntry[] } => {
  const mine = entries.filter((e) => e.request.status === Status.pending && sameKey(e.request.oracleKey, key));
  const cutoff = BigInt(Math.floor(nowSecs) + safetyMarginSecs);
  return {
    todo: mine.filter((e) => e.request.deadline > cutoff).sort((a, b) => Number(a.request.deadline - b.request.deadline)),
    tooLate: mine.filter((e) => e.request.deadline <= cutoff),
  };
};

/**
 * Watches a Nightcast deployment and fulfils every pending request bound to
 * its key. Fulfils one at a time, which keeps wallet balancing simple and
 * avoids two transactions competing for the same fees.
 *
 * The oracle cannot choose outputs: each one is fixed by the key and the
 * request id. Its only power is to answer or not, which is why requests carry
 * deadlines and anyone can `expire` a missed one.
 */
export class NightcastOracle {
  readonly publicKey: { x: bigint; y: bigint };
  private readonly attempts = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private busy: Promise<TickReport> | undefined;
  private readonly opts: Required<Omit<OracleOptions, 'chain' | 'secretKey'>>;

  constructor(private readonly options: OracleOptions) {
    this.publicKey = oraclePublicKey(options.secretKey);
    this.opts = {
      pollMs: options.pollMs ?? 5_000,
      safetyMarginSecs: options.safetyMarginSecs ?? 30,
      maxAttempts: options.maxAttempts ?? 3,
      logger: options.logger ?? silent,
    };
  }

  /** The output this oracle will publish for a request id (handy for logs and checks). */
  expectedOutput(id: Uint8Array): Uint8Array {
    return pureCircuits.evaluate(this.options.secretKey, id);
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
    const { logger, safetyMarginSecs, maxAttempts } = this.opts;
    const report: TickReport = { fulfilled: [], failed: [], skipped: [] };

    const now = chain.now ? await chain.now() : Date.now() / 1000;
    const { todo, tooLate } = selectWork(await chain.listRequests(), this.publicKey, now, safetyMarginSecs);

    for (const e of tooLate) {
      const id = hex(e.id);
      if (!this.attempts.has(`late:${id}`)) {
        this.attempts.set(`late:${id}`, 1);
        logger.warn(`request ${id} is too close to its deadline (${e.request.deadline}); leaving it to expire`);
      }
      report.skipped.push({ id, reason: 'too close to deadline' });
    }

    for (const e of todo) {
      const id = hex(e.id);
      const tries = this.attempts.get(id) ?? 0;
      if (tries >= maxAttempts) {
        report.skipped.push({ id, reason: `gave up after ${tries} attempts` });
        continue;
      }
      try {
        await chain.fulfil(e.id);
        this.attempts.delete(id);
        report.fulfilled.push(id);
        logger.info(`fulfilled ${id} -> ${hex(this.expectedOutput(e.id))}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.attempts.set(id, tries + 1);
        report.failed.push({ id, error: message });
        logger.error(`fulfil ${id} failed (attempt ${tries + 1}/${maxAttempts}): ${message}`);
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
        this.opts.logger.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.running) this.timer = setTimeout(loop, this.opts.pollMs);
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
