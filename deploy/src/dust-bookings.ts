/**
 * Release DUST bookings in a saved wallet that no transaction can still use.
 *
 * When the wallet pays a fee it books the DUST coins it spends (`pendingDust`
 * in its saved state) until the chain spends them or the transaction is given
 * up. A booking survives a restart. If the process stops while a transaction
 * is being proved (or the build fails as it stops), the saved state keeps the
 * booking, and the wallet SDK 2 (dust wallet 5.0/5.1) never releases it: on 17
 * Nov 2026 the Starfall v2 keeper had all 13 of its coins booked this way, so
 * "0 coin(s) available, 13 pending" for 8 hours, through dozens of restarts,
 * until its saved state was dropped.
 *
 * A booking whose transaction declared its time more than `olderThanMs` ago
 * can't belong to a transaction that may still land: a transaction expires at
 * its TTL (TX_TTL_SECONDS after it was built), and the declared time is at
 * most the DUST grace period earlier than that (dust-time.ts declares the fee
 * at the wallet's DUST time when its view lags). So the default is the grace
 * period (3 h on ledger 9) plus the TTL plus 15 minutes. Each such booking is
 * released the way the SDK releases a failed transaction's coins
 * (CoreWallet.applyFailed): the coin goes back into the local state and leaves
 * `pendingDust`.
 *
 * Works on the dust wallet's own JSON snapshot (format v2, ledger 9 state).
 * Anything it doesn't recognise is returned unchanged.
 */
import { DustLocalState } from '@midnightntwrk/wallet-sdk/ledger/v9';

export const DUST_GRACE_SECONDS = 3 * 3600;
/** Kept in step with network.ts's TX_TTL_SECONDS (imported there; a constant here keeps this module light). */
const TTL_SECONDS = 3600;
export const STALE_DUST_BOOKING_MS = (DUST_GRACE_SECONDS + TTL_SECONDS + 15 * 60) * 1000;

type SavedCoin = {
  initialValue: string;
  owner: string;
  nonce: string;
  seq: number;
  ctime: string;
  backingNight: string;
  mtIndex: string;
};
type SavedBooking = { coin: SavedCoin; nullifier: string; declaredTime: string };

export type ReleaseResult = {
  /** The snapshot to restore from: the input itself when nothing was released. */
  serialized: string;
  released: number;
  /** Bookings left in place (recent enough that their transaction may still be out there). */
  kept: number;
  /** Why the snapshot was left alone, if it couldn't be read. */
  skipped?: string;
};

const coinOf = (c: SavedCoin) => ({
  initialValue: BigInt(c.initialValue),
  owner: BigInt(c.owner),
  nonce: BigInt(c.nonce),
  seq: c.seq,
  ctime: new Date(c.ctime),
  backingNight: c.backingNight,
  mtIndex: BigInt(c.mtIndex),
});

export const releaseStaleDustBookings = (
  serialized: string,
  now: Date = new Date(),
  olderThanMs: number = STALE_DUST_BOOKING_MS,
): ReleaseResult => {
  const unchanged = (skipped?: string, kept = 0): ReleaseResult => ({ serialized, released: 0, kept, ...(skipped ? { skipped } : {}) });
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return unchanged('not JSON');
  }
  const pending = snap.pendingDust;
  if (!Array.isArray(pending) || pending.length === 0) return unchanged();
  if (snap.version !== 'v2' || typeof snap.state !== 'string') return unchanged(`snapshot format ${String(snap.version)}`, pending.length);
  const isStale = (b: SavedBooking) => {
    const at = Date.parse(b?.declaredTime);
    return Number.isFinite(at) && now.getTime() - at > olderThanMs;
  };
  const stale = (pending as SavedBooking[]).filter(isStale);
  if (stale.length === 0) return unchanged(undefined, pending.length);
  try {
    let state = DustLocalState.deserialize(Buffer.from(snap.state, 'hex'));
    for (const b of stale) {
      const nullifier = BigInt(b.nullifier);
      if (state.findUtxoByNullifier(nullifier) === undefined) state = state.addUtxo(nullifier, coinOf(b.coin) as never);
    }
    const left = (pending as SavedBooking[]).filter((b) => !isStale(b));
    return {
      serialized: JSON.stringify({ ...snap, state: Buffer.from(state.serialize()).toString('hex'), pendingDust: left }),
      released: stale.length,
      kept: left.length,
    };
  } catch (err) {
    return unchanged(`could not release them: ${err instanceof Error ? err.message : String(err)}`, pending.length);
  }
};
