/**
 * The shared contract-state read (state-cache.ts): many checks in a window
 * cost one read of the chain.
 */
import { describe, expect, it } from 'vitest';
import { cachedReader, DEFAULT_STATE_CACHE_SECS, stateCacheSecs } from '../state-cache.js';

const counter = () => {
  let n = 0;
  return { read: async () => ({ version: ++n }), count: () => n };
};

describe('cachedReader', () => {
  it('answers every call in the window from one read', async () => {
    let t = 0;
    const src = counter();
    const get = cachedReader(src.read, 15_000, () => t);
    expect(await get()).toEqual({ version: 1 });
    t = 14_999;
    expect(await get()).toEqual({ version: 1 });
    expect(src.count()).toBe(1);
    t = 15_000;
    expect(await get()).toEqual({ version: 2 });
    expect(src.count()).toBe(2);
    expect(get.reads()).toBe(2);
  });

  it('50 waiting spins checked at once: one read', async () => {
    const src = counter();
    const get = cachedReader(src.read, 15_000);
    const all = await Promise.all(Array.from({ length: 50 }, () => get()));
    expect(new Set(all.map((s) => s.version))).toEqual(new Set([1]));
    expect(src.count()).toBe(1);
  });

  it('calls during a slow read wait for it instead of reading again', async () => {
    let release!: () => void;
    let reads = 0;
    const get = cachedReader(
      () =>
        new Promise<number>((res) => {
          reads++;
          release = () => res(reads);
        }),
      15_000,
    );
    const a = get();
    const b = get();
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(reads).toBe(1);
  });

  it("doesn't keep a failed read", async () => {
    let fail = true;
    let reads = 0;
    const get = cachedReader(async () => {
      reads++;
      if (fail) throw new Error('indexer down');
      return 'state';
    }, 15_000);
    await expect(get()).rejects.toThrow('indexer down');
    fail = false;
    expect(await get()).toBe('state');
    expect(reads).toBe(2);
  });

  it('a window of 0 reads every time', async () => {
    const src = counter();
    const get = cachedReader(src.read, 0);
    await get();
    await get();
    expect(src.count()).toBe(2);
  });

  it('the window counts from when the read started, so a slow read is not kept longer', async () => {
    let t = 0;
    const get = cachedReader(
      async () => {
        t += 10_000; // the read took 10 s
        return t;
      },
      15_000,
      () => t,
    );
    await get(); // started at 0, done at 10 s
    t = 15_000;
    await get();
    expect(get.reads()).toBe(2);
  });
});

describe('stateCacheSecs', () => {
  it('defaults, takes a number, takes 0, refuses nonsense', () => {
    expect(stateCacheSecs({})).toBe(DEFAULT_STATE_CACHE_SECS);
    expect(stateCacheSecs({ NIGHTCAST_STATE_CACHE_SECS: '30' })).toBe(30);
    expect(stateCacheSecs({ NIGHTCAST_STATE_CACHE_SECS: '0' })).toBe(0);
    expect(() => stateCacheSecs({ NIGHTCAST_STATE_CACHE_SECS: 'soon' })).toThrow(/number of seconds/);
    expect(() => stateCacheSecs({ NIGHTCAST_STATE_CACHE_SECS: '-1' })).toThrow(/number of seconds/);
  });
});
