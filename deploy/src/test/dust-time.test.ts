import { describe, expect, it } from 'vitest';
import { declaredTime, declareFeesAtDustTime } from '../dust-time.js';

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
