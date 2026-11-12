import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bondShortfall, LowWatch, OracleTally, Pace, readsLow, TOPUP_LOW_FOR_MS, topUpDue, upkeepConfig, upkeepWanted, writeStatus } from '../upkeep.js';

const N = 1_000_000n;

describe('upkeep settings', () => {
  it('is off unless asked for', () => {
    const c = upkeepConfig({});
    expect(c).toEqual({ bondTarget: undefined, walletFloor: 2_000n * N, topUp: undefined, statusFile: undefined, readEveryMs: 300_000 });
    expect(upkeepWanted(c)).toBe(false);
  });
  it('reads the bond target, the top-up and the floor', () => {
    const c = upkeepConfig({
      NIGHTCAST_BOND_TARGET: '50',
      NIGHTCAST_TOPUP_ADDRESS: 'mn_addr_preprod1abc',
      NIGHTCAST_TOPUP_HEALTH: 'http://127.0.0.1:6350/health',
      NIGHTCAST_TOPUP_BELOW: '500',
      NIGHTCAST_TOPUP_AMOUNT: '1500.5',
      NIGHTCAST_WALLET_FLOOR: '3000',
      NIGHTCAST_STATUS_FILE: '/tmp/x.json',
    });
    expect(c.bondTarget).toBe(50n);
    expect(c.walletFloor).toBe(3_000n * N);
    expect(c.topUp).toEqual({ address: 'mn_addr_preprod1abc', healthUrl: 'http://127.0.0.1:6350/health', below: 500n * N, amount: 1_500_500_000n });
    expect(upkeepWanted(c)).toBe(true);
    expect(upkeepConfig({ NIGHTCAST_BOND_TARGET: '0' }).bondTarget).toBeUndefined();
    expect(upkeepConfig({ NIGHTCAST_BOND_TARGET: 'lots' }).bondTarget).toBeUndefined();
    expect(upkeepConfig({ NIGHTCAST_TOPUP_ADDRESS: 'mn_addr_preprod1abc' }).topUp).toBeUndefined(); // needs the health URL too
    expect(upkeepConfig({ NIGHTCAST_UPKEEP_READ_SECS: '120' }).readEveryMs).toBe(120_000);
    expect(upkeepConfig({ NIGHTCAST_UPKEEP_READ_SECS: '5' }).readEveryMs).toBe(30_000); // never faster than every 30 s
    expect(upkeepConfig({ NIGHTCAST_UPKEEP_READ_SECS: 'often' }).readEveryMs).toBe(300_000);
  });
});

describe('the bond refill', () => {
  const base = { collateral: N, night: 5_950n * N, floor: 2_000n * N };
  it('deposits what missed requests took, counting slots that pending requests hold', () => {
    expect(bondShortfall({ ...base, free: 48n, held: 0n, target: 50n })).toBe(2n);
    expect(bondShortfall({ ...base, free: 45n, held: 3n, target: 50n })).toBe(2n);
    expect(bondShortfall({ ...base, free: 47n, held: 3n, target: 50n })).toBe(0n);
    expect(bondShortfall({ ...base, free: 60n, held: 0n, target: 50n })).toBe(0n);
  });
  it('is off without a target or a collateral, and never takes the wallet below its floor', () => {
    expect(bondShortfall({ ...base, free: 10n, held: 0n })).toBe(0n);
    expect(bondShortfall({ ...base, free: 10n, held: 0n, target: 50n, collateral: 0n })).toBe(0n);
    expect(bondShortfall({ ...base, free: 10n, held: 0n, target: 50n, night: 2_005n * N })).toBe(5n);
    expect(bondShortfall({ ...base, free: 10n, held: 0n, target: 50n, night: 1_000n * N })).toBe(0n);
  });
});

describe('the top-up of the served wallet', () => {
  const config = { address: 'mn_addr_preprod1spin', healthUrl: 'http://127.0.0.1:6350/health', below: 1_000n * N, amount: 2_000n * N };
  const ours = { night: 5_950n * N, floor: 2_000n * N, lowForMs: TOPUP_LOW_FOR_MS };
  it('sends when the served wallet is low', () => {
    expect(topUpDue({ ...ours, config, served: { address: 'mn_addr_preprod1spin', night: String(999n * N) } })).toBe(2_000n * N);
    expect(topUpDue({ ...ours, config, served: { address: 'mn_addr_preprod1spin', night: String(1_000n * N) } })).toBe(0n);
  });
  it('sends nothing to another address, with no reading, or below our own floor', () => {
    expect(topUpDue({ ...ours, config, served: { address: 'mn_addr_preprod1other', night: '0' } })).toBe(0n);
    expect(topUpDue({ ...ours, config, served: undefined })).toBe(0n);
    expect(topUpDue({ ...ours, config, served: { address: 'mn_addr_preprod1spin' } })).toBe(0n);
    expect(topUpDue({ ...ours, config: undefined, served: { address: 'mn_addr_preprod1spin', night: '0' } })).toBe(0n);
    expect(topUpDue({ night: 3_999n * N, floor: 2_000n * N, lowForMs: TOPUP_LOW_FOR_MS, config, served: { address: 'mn_addr_preprod1spin', night: '0' } })).toBe(0n);
  });
  it('waits until the wallet has read low for 10 minutes on end (12 Nov 2026: one reading of 0 mid-request sent 2,000)', () => {
    const served = { address: 'mn_addr_preprod1spin', night: '0' };
    expect(topUpDue({ ...ours, config, served, lowForMs: 0 })).toBe(0n);
    expect(topUpDue({ ...ours, config, served, lowForMs: TOPUP_LOW_FOR_MS - 1 })).toBe(0n);
    expect(topUpDue({ ...ours, config, served, lowForMs: TOPUP_LOW_FOR_MS })).toBe(2_000n * N);

    let now = 0;
    const watch = new LowWatch(() => now);
    const low = readsLow(served, config);
    expect(low).toBe(true);
    expect(watch.see(low)).toBe(0);
    now = 9 * 60_000;
    expect(watch.see(low)).toBe(9 * 60_000);
    // one good reading (the coin's change came back) starts the count again
    now = 9.5 * 60_000;
    expect(watch.see(readsLow({ address: 'mn_addr_preprod1spin', night: String(9_999n * N) }, config))).toBe(0);
    now = 10 * 60_000;
    expect(watch.see(low)).toBe(0);
    now = 20 * 60_000;
    expect(watch.see(low)).toBe(TOPUP_LOW_FOR_MS);
    // a reading that can't be had is not "low"
    expect(readsLow(undefined, config)).toBe(false);
    expect(readsLow({ address: 'mn_addr_preprod1spin' }, config)).toBe(false);
    expect(readsLow({ address: 'mn_addr_preprod1other', night: '0' }, config)).toBe(false);
  });
});

describe('the tally, the pace and the status file', () => {
  it("counts answers and misses from the oracle's lines", () => {
    const t = new OracleTally(() => Date.UTC(2026, 10, 11, 5, 0, 0));
    t.see(`fulfilled ${'a'.repeat(64)} -> ${'b'.repeat(64)}`);
    t.see(`request ${'c'.repeat(64)} is too close to its deadline (1794360025); leaving it to expire`);
    t.see('Oracle running');
    expect([t.fulfilled, t.missed, t.lastFulfilledAt, t.lastMissedAt]).toEqual([1, 1, '2026-11-11T05:00:00.000Z', '2026-11-11T05:00:00.000Z']);
  });
  it('spaces repeated tries', () => {
    let now = 0;
    const p = new Pace(() => now);
    expect(p.due('deposit', 600_000)).toBe(true);
    now = 599_999;
    expect(p.due('deposit', 600_000)).toBe(false);
    expect(p.due('topup', 600_000)).toBe(true);
    now = 600_000;
    expect(p.due('deposit', 600_000)).toBe(true);
  });
  it('writes the status file whole', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'upkeep-')), 'oracle.json');
    writeStatus(file, { at: '2026-11-11T05:00:00.000Z', wallet: { night: '5950000000', dust: '7' }, bond: { free: '48', held: '0', target: '50' }, fulfilled: 3, missed: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ bond: { free: '48', target: '50' }, missed: 1 });
  });
});
