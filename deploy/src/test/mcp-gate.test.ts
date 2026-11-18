import { describe, expect, it } from 'vitest';
import { FeeGate, feeCoinsOf, mcpParallelFromEnv } from '../mcp/gate.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A job that stays in flight until released, and records how many ran at once. */
const jobs = () => {
  const seen = { now: 0, most: 0 };
  const releases: (() => void)[] = [];
  const job = () =>
    new Promise<string>((resolve) => {
      seen.now += 1;
      seen.most = Math.max(seen.most, seen.now);
      releases.push(() => {
        seen.now -= 1;
        resolve('done');
      });
    });
  return { seen, releases, job };
};

describe('FeeGate: requests in flight at once', () => {
  it('sends one at a time when parallel is 1', async () => {
    const g = new FeeGate(1, () => ({ free: 5, booked: 0 }), undefined, 10);
    const { seen, releases, job } = jobs();
    const all = [g.run(job), g.run(job), g.run(job)];
    await tick();
    expect(seen.now).toBe(1);
    while (releases.length) {
      releases.shift()!();
      await tick(20);
    }
    await Promise.all(all);
    expect(seen.most).toBe(1);
    g.stop();
  });

  it('sends two at once with two coins, and the third when one finishes', async () => {
    const g = new FeeGate(2, () => ({ free: 2, booked: 0 }), undefined, 10);
    const { seen, releases, job } = jobs();
    const all = [g.run(job), g.run(job), g.run(job)];
    await tick();
    expect(seen.now).toBe(2);
    releases.shift()!();
    await tick(20);
    expect(seen.now).toBe(2);
    while (releases.length) {
      releases.shift()!();
      await tick(20);
    }
    await Promise.all(all);
    expect(seen.most).toBe(2);
    g.stop();
  });

  it('counts coins its own sends have booked, and holds a send when the wallet has one coin', async () => {
    let coins = { free: 1, booked: 0 };
    const waits: string[] = [];
    const g = new FeeGate(2, () => coins, (why) => waits.push(why), 10);
    const { seen, releases, job } = jobs();
    const first = g.run(job);
    await tick();
    coins = { free: 0, booked: 1 }; // the first send balanced: its coin is booked
    const second = g.run(job);
    await tick(30);
    expect(seen.now).toBe(1);
    expect(waits).toEqual(['1 request(s) sending; the wallet can pay 1 fee(s) at once']);
    coins = { free: 1, booked: 1 }; // a second coin appears
    await tick(30);
    expect(seen.now).toBe(2);
    releases.shift()!();
    releases.shift()!();
    await Promise.all([first, second]);
    g.stop();
  });

  it('runs an exclusive job alone, after the sends in flight', async () => {
    const g = new FeeGate(2, () => ({ free: 2, booked: 0 }), undefined, 10);
    const { seen, releases, job } = jobs();
    const a = g.run(job);
    await tick();
    let alone = false;
    const ex = g.exclusive(async () => {
      alone = seen.now === 0;
      return 'split';
    });
    const b = g.run(job); // queued behind the exclusive job
    await tick(20);
    expect(seen.now).toBe(1);
    releases.shift()!();
    expect(await ex).toBe('split');
    expect(alone).toBe(true);
    await tick(20);
    releases.shift()!();
    await Promise.all([a, b]);
    g.stop();
  });

  it('never goes below one at a time, whatever the coins say', () => {
    expect(new FeeGate(3, () => ({ free: 0, booked: 0 })).width()).toBe(1);
    expect(new FeeGate(3, () => { throw new Error('not synced'); }).width()).toBe(1);
    expect(new FeeGate(3, () => ({ free: 5, booked: 1 })).width()).toBe(3);
  });
});

describe('feeCoinsOf and NIGHTCAST_MCP_PARALLEL', () => {
  it('counts free coins holding DUST and booked coins', () => {
    expect(feeCoinsOf({ dust: { availableCoins: [{ generatedNow: 3n }, { generatedNow: 0n }], pendingCoins: [{}] } })).toEqual({ free: 1, booked: 1 });
    expect(feeCoinsOf(undefined)).toEqual({ free: 0, booked: 0 });
  });
  it('reads NIGHTCAST_MCP_PARALLEL, 1 by default, 1 to 8', () => {
    expect(mcpParallelFromEnv({})).toBe(1);
    expect(mcpParallelFromEnv({ NIGHTCAST_MCP_PARALLEL: '2' })).toBe(2);
    expect(mcpParallelFromEnv({ NIGHTCAST_MCP_PARALLEL: '99' })).toBe(8);
    expect(mcpParallelFromEnv({ NIGHTCAST_MCP_PARALLEL: 'x' })).toBe(1);
  });
});
