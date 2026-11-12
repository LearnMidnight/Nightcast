/**
 * One contract-state read shared by everyone who asks within a short window.
 *
 * The contract's state holds every request, so one read answers a check of
 * any of them. Without this, the MCP server read the whole state once per
 * nightcast_check_request call: a website polling each waiting spin every
 * few seconds, for each visitor watching it, turned into that many indexer
 * requests (metered on Blockfrost). With it, the server reads at most once
 * per window however many spins are waiting or however many people watch.
 *
 * Calls that arrive while a read is in flight wait for that read. A failed
 * read isn't kept: the next call tries again.
 */
export type StateReader<S> = () => Promise<S>;

export const DEFAULT_STATE_CACHE_SECS = 15;

/** Seconds from NIGHTCAST_STATE_CACHE_SECS (0 turns the cache off), else the default. */
export const stateCacheSecs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.NIGHTCAST_STATE_CACHE_SECS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STATE_CACHE_SECS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`NIGHTCAST_STATE_CACHE_SECS must be a number of seconds (0 or more), not "${raw}"`);
  return n;
};

export const cachedReader = <S>(read: StateReader<S>, ttlMs: number, now: () => number = Date.now): StateReader<S> & { reads: () => number } => {
  let value: { at: number; state: S } | undefined;
  let inFlight: Promise<S> | undefined;
  let count = 0;
  const get = (() => {
    if (ttlMs <= 0) {
      count++;
      return read();
    }
    if (value && now() - value.at < ttlMs) return Promise.resolve(value.state);
    if (inFlight) return inFlight;
    count++;
    const started = now();
    inFlight = read().then(
      (state) => {
        value = { at: started, state };
        inFlight = undefined;
        return state;
      },
      (err: unknown) => {
        inFlight = undefined;
        throw err;
      },
    );
    return inFlight;
  }) as StateReader<S> & { reads: () => number };
  get.reads = () => count;
  return get;
};
