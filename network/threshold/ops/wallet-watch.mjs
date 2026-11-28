// Two things to watch in a wallet the operator package keeps open for days (seen on the VM's team, 27 to 28 Nov 2026):
//
// - Its first sync can take over an hour, and moves on all the time. Starting again because it hasn't finished within a
//   fixed time only throws away a minute or two of it each time: what counts is whether it is still moving on.
// - A DUST coin booked by a transaction that can no longer land stays booked: the dust wallet (5.1) never releases it,
//   and opening the saved wallet does once the booking is older than STALE_DUST_BOOKING_MS (dust-bookings.ts). On
//   28 Nov house-2 had 3 coins booked for nearly 9 hours and couldn't pay a fee, so it didn't deal in epoch 6's
//   ceremony until it was started again by hand.
//
// No imports: these are checked with plain node (wallet-watch.check.mjs).

/** How far each part of a wallet's state has synced, as a string that changes whenever any part moves on. */
export const syncMark = (state) =>
  ['shielded', 'unshielded', 'dust']
    .map((part) => {
      try {
        const p = state?.[part]?.progress ?? state?.[part]?.state?.progress;
        if (p?.isStrictlyComplete?.()) return 'done';
        return String(p?.appliedIndex ?? p?.appliedId ?? '');
      } catch {
        return ''; // a getter that throws before its part has started
      }
    })
    .join('/');

/**
 * Follows the coins a wallet has booked (its dust state's `pendingCoins`) and how long this process has seen each one
 * booked. Seen for longer than `staleMs` means booked at least that long, so opening the wallet again releases it.
 */
export const bookingWatch = (staleMs, now = () => Date.now()) => {
  const since = new Map();
  const keyOf = (coin) => {
    // The dust wallet's pendingCoins are { token: coin, ...its DUST now } (5.1); a bare coin or { coin } is read too.
    const n = coin?.token?.nonce ?? coin?.nonce ?? coin?.coin?.nonce;
    return n === undefined || n === null ? undefined : String(n);
  };
  return {
    /** Record the coins booked now; those no longer booked are forgotten. */
    note(pending) {
      const t = now(), seen = new Set();
      for (const coin of pending ?? []) {
        const k = keyOf(coin);
        if (k === undefined) continue;
        seen.add(k);
        if (!since.has(k)) since.set(k, t);
      }
      for (const k of [...since.keys()]) if (!seen.has(k)) since.delete(k);
    },
    /** How many coins have been seen booked for longer than `staleMs`. */
    stale() {
      const t = now();
      let n = 0;
      for (const at of since.values()) if (t - at > staleMs) n++;
      return n;
    },
  };
};

/**
 * Whether stuck bookings are a reason to start the wallet again: the fees need more free coins than it has, the booked
 * ones would make up the difference, and some have been booked long enough to be released when it opens.
 */
export const restartForBookings = ({ dustCoins, booked }, wanted, stale) => stale > 0 && booked > 0 && dustCoins < wanted && dustCoins + booked >= wanted;
