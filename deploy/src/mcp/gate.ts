/**
 * How many requests the MCP server's wallet may be sending at once (NIGHTCAST_MCP_PARALLEL).
 *
 * Each request pays its fee from a DUST coin. The wallet books the coin it pays with when it balances the
 * transaction (inside one state update, so two balances never take the same coin) and gets the change back
 * once the transaction lands. Before 18 Nov 2026 the server sent one request at a time, so a burst of
 * LunaSpin spins queued here: four made in two seconds reached the chain about 40-70 s apart.
 *
 * `run` lets a send start while fewer are in flight than both `parallel` and the coins the wallet has for
 * them (free coins holding DUST, plus the coins our own sends in flight have booked). `exclusive` runs a
 * job alone (a transfer to split the wallet's NIGHT), waiting for every send to finish first.
 */
export type FeeCoins = { free: number; booked: number };

export class FeeGate {
  private inFlight = 0;
  private alone = false;
  /** Exclusive jobs waiting: new sends wait behind them, so they aren't starved. */
  private queuedAlone = 0;
  private waiters: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly parallel: number,
    private readonly coins: () => FeeCoins,
    private readonly onWait: (why: string) => void = () => undefined,
    recheckMs = 2_000,
  ) {
    // Coins come back when a send lands, which nothing here waits on: look again now and then.
    this.timer = setInterval(() => this.wake(), recheckMs);
    this.timer.unref?.();
  }

  /** How many sends may be in flight right now (at least 1). */
  width(): number {
    if (this.parallel <= 1) return 1;
    let c: FeeCoins;
    try {
      c = this.coins();
    } catch {
      return 1;
    }
    const usable = Math.floor((Number.isFinite(c.free) ? c.free : 0) + (Number.isFinite(c.booked) ? c.booked : 0));
    return Math.max(1, Math.min(this.parallel, usable));
  }

  sending(): number {
    return this.inFlight;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    let told = false;
    while (this.alone || this.queuedAlone > 0 || this.inFlight >= this.width()) {
      if (!told && !this.alone && this.queuedAlone === 0 && this.inFlight < this.parallel) {
        told = true;
        this.onWait(`${this.inFlight} request(s) sending; the wallet can pay ${this.width()} fee(s) at once`);
      }
      await this.next();
    }
    this.inFlight += 1;
    try {
      return await job();
    } finally {
      this.inFlight -= 1;
      this.wake();
    }
  }

  async exclusive<T>(job: () => Promise<T>): Promise<T> {
    this.queuedAlone += 1;
    try {
      while (this.alone || this.inFlight > 0) await this.next();
    } finally {
      this.queuedAlone -= 1;
    }
    this.alone = true;
    try {
      return await job();
    } finally {
      this.alone = false;
      this.wake();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.wake();
  }

  private next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}

/** Free DUST coins holding DUST, and booked ones, from a wallet state (both 0 when it can't be read). */
export const feeCoinsOf = (state: unknown): FeeCoins => {
  try {
    const d = (state as { dust?: { availableCoins?: readonly { generatedNow?: bigint }[]; pendingCoins?: readonly unknown[] } }).dust;
    const free = Array.isArray(d?.availableCoins) ? d!.availableCoins!.filter((c) => typeof c.generatedNow !== 'bigint' || c.generatedNow > 0n).length : 0;
    const booked = Array.isArray(d?.pendingCoins) ? d!.pendingCoins!.length : 0;
    return { free, booked };
  } catch {
    return { free: 0, booked: 0 };
  }
};

/** NIGHTCAST_MCP_PARALLEL: how many requests the MCP server may send at once (default 1, at most 8). */
export const mcpParallelFromEnv = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.NIGHTCAST_MCP_PARALLEL ?? '1');
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 1;
};
