import { describe, expect, it } from 'vitest';
import { V2Tag } from '@midnightntwrk/wallet-sdk/dust/v2';
import { VariantState } from '@midnightntwrk/wallet-sdk-abstractions';
import { declaredTime, declareFeesAtDustTime, dustLocalOf } from '../dust-time.js';

const at = (iso: string) => new Date(iso);
const stateAt = (syncTime: Date | undefined, grace: bigint | null = 10_800n) => ({
  dust: { state: { state: { syncTime, params: grace === null ? {} : { dustGracePeriodSeconds: grace } } } },
});
const NOW = at('2026-10-31T05:10:00Z').getTime();

describe('declaredTime', () => {
  it('uses the DUST view time when it is inside the grace period', () => {
    expect(declaredTime(stateAt(at('2026-10-31T05:07:00Z')), NOW)).toEqual(at('2026-10-31T05:07:00Z'));
  });
  it('falls back (undefined) when the view is too old, in the future, or unknown', () => {
    expect(declaredTime(stateAt(at('2026-10-31T02:30:00Z')), NOW)).toEqual(at('2026-10-31T02:30:00Z')); // 2h40 old: inside 3h less 10 min
    expect(declaredTime(stateAt(at('2026-10-31T02:15:00Z')), NOW)).toBeUndefined(); // 2h55 old: outside
    expect(declaredTime(stateAt(at('2026-10-31T05:11:00Z')), NOW)).toBeUndefined();
    expect(declaredTime(stateAt(undefined), NOW)).toBeUndefined();
    expect(declaredTime({}, NOW)).toBeUndefined();
  });
  it('assumes an hour of grace when the parameters are missing', () => {
    expect(declaredTime(stateAt(at('2026-10-31T04:30:00Z'), null), NOW)).toEqual(at('2026-10-31T04:30:00Z'));
    expect(declaredTime(stateAt(at('2026-10-31T04:15:00Z'), null), NOW)).toBeUndefined();
  });
});

describe("wallet SDK 2's sealed dust state", () => {
  // SDK 2 seals the DustLocalState inside the part's state; only coreStateOf (dust wallet v2) reads it back.
  const sealedAt = (syncTime: Date, grace = 10_800n) => ({
    dust: { state: VariantState.seal(V2Tag, { state: { syncTime, params: { dustGracePeriodSeconds: grace } } }) },
  });
  it('reads the time from the sealed state, as the real library seals it', () => {
    expect(dustLocalOf(sealedAt(at('2026-11-10T10:00:00Z')))?.syncTime).toEqual(at('2026-11-10T10:00:00Z'));
    expect(declaredTime(sealedAt(at('2026-10-31T05:07:00Z')), NOW)).toEqual(at('2026-10-31T05:07:00Z'));
    expect(declaredTime(sealedAt(at('2026-10-31T02:15:00Z')), NOW)).toBeUndefined(); // outside the grace period
  });
  it('gives nothing for a state another variant sealed, or none at all', () => {
    const v1 = { dust: { state: VariantState.seal(Symbol('V1'), { state: { syncTime: at('2026-10-31T05:07:00Z') } }) } };
    expect(dustLocalOf(v1)).toBeUndefined();
    expect(declaredTime(v1, NOW)).toBeUndefined();
    expect(dustLocalOf({ dust: {} })).toBeUndefined();
    expect(dustLocalOf(undefined)).toBeUndefined();
  });
  it('still reads SDK 1\'s open state', () => {
    expect(dustLocalOf(stateAt(at('2026-10-31T05:07:00Z')))?.syncTime).toEqual(at('2026-10-31T05:07:00Z'));
  });
});

describe('declareFeesAtDustTime', () => {
  const fake = (state: unknown) => {
    const calls: Array<Date | undefined> = [];
    const wallet = {
      wallet: {
        dust: {
          tag: 'dust',
          balanceTransactions: async function (this: { tag: string }, _sk: unknown, _txs: unknown, _ttl: Date, currentTime?: Date) {
            calls.push(currentTime);
            return this.tag;
          },
        },
        state: () => ({
          subscribe: (next: (s: unknown) => void) => {
            next(state);
            return { unsubscribe: () => {} };
          },
        }),
      },
    };
    return { wallet, calls };
  };

  it("passes the DUST view's time, keeps `this`, and logs when it is well behind", async () => {
    const { wallet, calls } = fake(stateAt(at('2026-10-31T05:08:00Z')));
    const logs: string[] = [];
    declareFeesAtDustTime(wallet, { info: (m) => logs.push(m) }, () => NOW);
    await expect(wallet.wallet.dust.balanceTransactions('sk', [], new Date(NOW + 3_600_000))).resolves.toBe('dust');
    expect(calls).toEqual([at('2026-10-31T05:08:00Z')]);
    expect(logs).toEqual(["declaring the fee at the wallet's DUST time, 120 s ago (its view of DUST is from then)"]);
  });

  it('leaves an explicit time alone, falls back when the view is too old, and can be undone', async () => {
    const { wallet, calls } = fake(stateAt(at('2026-10-31T01:00:00Z')));
    const undo = declareFeesAtDustTime(wallet, undefined, () => NOW);
    await wallet.wallet.dust.balanceTransactions('sk', [], new Date(), at('2026-10-31T05:09:00Z'));
    await wallet.wallet.dust.balanceTransactions('sk', [], new Date());
    expect(calls).toEqual([at('2026-10-31T05:09:00Z'), undefined]);
    undo();
    await wallet.wallet.dust.balanceTransactions('sk', [], new Date());
    expect(calls).toHaveLength(3);
  });
});
