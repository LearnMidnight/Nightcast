/**
 * Declare each fee at the time the wallet's DUST view is from.
 *
 * wallet-sdk's dust wallet stamps a fee payment with the indexer's latest
 * block time (fetched fresh over HTTP), but builds the DUST spend proof from
 * its own DUST state, which arrives over a WebSocket subscription that can
 * run minutes behind. The node checks the proof "against the node's DUST state
 * at the transaction's declared time" (Midnight's node error 170,
 * InvalidDustSpendProof), so whenever the subscription lags, every fee is
 * refused, restart or not. On Preprod that happened most hours, worst for
 * the keeper's numbers step (draw 47, 31 Oct: refused after two restarts).
 *
 * The dust wallet takes an optional `currentTime`. Passing the DUST state's
 * own `syncTime` makes the declared time match what the proof was built
 * from. It must stay within the DUST grace period (else node error 171), so
 * a view older than the grace period less a margin falls back to the
 * library's default.
 *
 * Found and first used in Lunardraw (cli/src/dust-time.ts, PR #62, 31 Oct
 * 2026); here so every Nightcast wallet gets it (openWallet applies it unless
 * `declareFeesAtDustTime: false`).
 */

type Logger = { info(msg: string): void };

export interface DustTimeWallet {
  wallet: {
    dust: { balanceTransactions(secretKey: unknown, transactions: unknown, ttl: Date, currentTime?: Date): Promise<unknown> };
    state(): { subscribe(next: (s: unknown) => void): { unsubscribe(): void } };
  };
}

/** The DUST state's time and grace period, if the wallet state has them. */
export const dustClock = (state: unknown): { syncTime?: Date; graceSecs?: number } => {
  const local = (state as { dust?: { state?: { state?: { syncTime?: unknown; params?: { dustGracePeriodSeconds?: unknown } } } } })?.dust?.state?.state;
  const t = local?.syncTime;
  const g = local?.params?.dustGracePeriodSeconds;
  return {
    syncTime: t instanceof Date && !Number.isNaN(t.getTime()) ? t : undefined,
    graceSecs: typeof g === 'bigint' ? Number(g) : typeof g === 'number' ? g : undefined,
  };
};

/**
 * The time to declare: the DUST view's syncTime when it is in the past and
 * comfortably inside the grace period, else undefined (library default).
 */
export const declaredTime = (state: unknown, nowMs: number, marginSecs = 600): Date | undefined => {
  const { syncTime, graceSecs } = dustClock(state);
  if (!syncTime) return undefined;
  const ageSecs = (nowMs - syncTime.getTime()) / 1000;
  if (ageSecs < 0) return undefined;
  const limit = (graceSecs ?? 3600) - marginSecs;
  return ageSecs <= limit ? syncTime : undefined;
};

/** The wallet's current state, or undefined if it doesn't give one within 5 s. */
const latestState = (wallet: DustTimeWallet): Promise<unknown> =>
  new Promise((resolve) => {
    let sub: { unsubscribe(): void } | undefined;
    let done = false;
    const finish = (s: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
      queueMicrotask(() => sub?.unsubscribe());
    };
    const timer = setTimeout(() => finish(undefined), 5_000);
    sub = wallet.wallet.state().subscribe(finish);
    if (done) sub.unsubscribe();
  });

/** Patch the wallet's dust part so fees are declared at its DUST view's time. Returns an undo. */
export const declareFeesAtDustTime = (wallet: DustTimeWallet, logger?: Logger, now: () => number = Date.now): (() => void) => {
  const dust = wallet.wallet.dust;
  const original = dust.balanceTransactions;
  const bound = original.bind(dust);
  dust.balanceTransactions = async (secretKey, transactions, ttl, currentTime) => {
    if (currentTime) return bound(secretKey, transactions, ttl, currentTime);
    const at = declaredTime(await latestState(wallet), now());
    if (at) {
      const behind = Math.round((now() - at.getTime()) / 1000);
      if (behind >= 30) logger?.info(`declaring the fee at the wallet's DUST time, ${behind} s ago (its view of DUST is from then)`);
    }
    return bound(secretKey, transactions, ttl, at);
  };
  return () => {
    dust.balanceTransactions = original;
  };
};
