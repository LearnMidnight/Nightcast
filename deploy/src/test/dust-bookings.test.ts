import { describe, expect, it } from 'vitest';
import { Either } from 'effect';
import { CoreWallet, Serialization } from '@midnightntwrk/wallet-sdk-dust-wallet/v2';
import { DustLocalState, LedgerParameters } from '@midnightntwrk/wallet-sdk/ledger/v9';
import { DUST_GRACE_SECONDS, releaseStaleDustBookings, STALE_DUST_BOOKING_MS } from '../dust-bookings.js';
import { TX_TTL_SECONDS } from '../network.js';

const NOW = new Date('2026-11-18T05:00:00Z');
const coin = (nonce: bigint, mtIndex: bigint) => ({
  initialValue: 5n * 10n ** 15n,
  owner: 7n,
  nonce,
  seq: 0,
  ctime: new Date('2026-11-17T10:00:00Z'),
  backingNight: 'ab'.repeat(32),
  mtIndex,
});

/** A real snapshot, written by the dust wallet's own serializer: one coin held, two booked (one 8 h ago, one 10 min ago). */
const snapshot = () => {
  let state = new DustLocalState(LedgerParameters.initialParameters().dust);
  state = state.addUtxo(1n, coin(101n, 0n) as never);
  const pending = [
    { coin: coin(102n, 1n), nullifier: 2n, declaredTime: new Date(NOW.getTime() - 8 * 3600_000) },
    { coin: coin(103n, 2n), nullifier: 3n, declaredTime: new Date(NOW.getTime() - 10 * 60_000) },
  ];
  const progress = { appliedIndex: 1987000n, highestRelevantWalletIndex: 0n, highestIndex: 0n, highestRelevantIndex: 0n };
  const wallet = CoreWallet.restore(state, { publicKey: 7n } as never, pending as never, progress as never, 2001100n, 'preprod', 'events' as never);
  return Serialization.makeDefaultV2SerializationCapability().serialize(wallet as never) as string;
};

const restore = (serialized: string) => {
  const r = Serialization.makeDefaultV2SerializationCapability().deserialize(undefined as never, serialized) as Either.Either<
    { state: DustLocalState; pendingDust: readonly { nullifier: bigint }[] },
    unknown
  >;
  if (Either.isLeft(r)) throw new Error(`the dust wallet refused the snapshot: ${String(r.left)}`);
  return r.right;
};

describe('releasing stale DUST bookings from a saved wallet', () => {
  it('gives an old booking its coin back and keeps a recent one, in a snapshot the dust wallet restores', () => {
    const before = restore(snapshot());
    expect(before.state.utxos.length).toBe(1);
    expect(before.pendingDust.length).toBe(2);

    const r = releaseStaleDustBookings(snapshot(), NOW);
    expect(r).toMatchObject({ released: 1, kept: 1 });
    const after = restore(r.serialized);
    expect(after.pendingDust.map((b) => b.nullifier)).toEqual([3n]);
    expect(after.state.utxos.length).toBe(2);
    expect(after.state.findUtxoByNullifier(2n)?.nonce).toBe(102n);
    expect(after.state.findUtxoByNullifier(3n)).toBeUndefined();
    // everything else in the snapshot is as it was
    const [a, b] = [JSON.parse(snapshot()), JSON.parse(r.serialized)];
    for (const k of Object.keys(a)) if (k !== 'state' && k !== 'pendingDust') expect(b[k]).toEqual(a[k]);
  });

  it('waits the DUST grace period plus the TTL before treating a booking as stale', () => {
    expect(STALE_DUST_BOOKING_MS).toBe((3 * 3600 + 3600 + 900) * 1000);
    expect(STALE_DUST_BOOKING_MS).toBe((DUST_GRACE_SECONDS + TX_TTL_SECONDS + 900) * 1000);
    expect(BigInt(DUST_GRACE_SECONDS)).toBe(LedgerParameters.initialParameters().dust.dustGracePeriodSeconds);
    const fourHoursOn = new Date(NOW.getTime() - 8 * 3600_000 + 4 * 3600_000);
    expect(releaseStaleDustBookings(snapshot(), fourHoursOn)).toMatchObject({ released: 0, kept: 2 });
    const later = new Date(fourHoursOn.getTime() + 16 * 60_000);
    expect(releaseStaleDustBookings(snapshot(), later)).toMatchObject({ released: 1, kept: 1 });
  });

  it('leaves alone a snapshot with nothing booked, or one it does not recognise', () => {
    let state = new DustLocalState(LedgerParameters.initialParameters().dust);
    state = state.addUtxo(1n, coin(101n, 0n) as never);
    const progress = { appliedIndex: 5n, highestRelevantWalletIndex: 0n, highestIndex: 0n, highestRelevantIndex: 0n };
    const empty = Serialization.makeDefaultV2SerializationCapability().serialize(
      CoreWallet.restore(state, { publicKey: 7n } as never, [] as never, progress as never, 2001100n, 'preprod', 'events' as never) as never,
    ) as string;
    expect(releaseStaleDustBookings(empty, NOW)).toEqual({ serialized: empty, released: 0, kept: 0 });
    expect(releaseStaleDustBookings('not json', NOW)).toMatchObject({ serialized: 'not json', released: 0, skipped: 'not JSON' });
    const v1 = JSON.stringify({ version: 'v1', state: 'zz', pendingDust: [{ declaredTime: '2026-01-01T00:00:00Z' }] });
    expect(releaseStaleDustBookings(v1, NOW)).toMatchObject({ serialized: v1, released: 0, kept: 1 });
    const broken = JSON.stringify({ version: 'v2', state: 'zz', pendingDust: [{ declaredTime: '2026-01-01T00:00:00Z', nullifier: '1' }] });
    expect(releaseStaleDustBookings(broken, NOW)).toMatchObject({ serialized: broken, released: 0, skipped: expect.stringMatching(/could not release/) });
  });
});
