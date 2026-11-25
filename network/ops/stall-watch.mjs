// A watchdog for a long-running network service (an operator, the test requester): it follows the
// wallet's sync and the transactions sent, and says when the process should exit for a restart
// (systemd starts it again 30 s later, and a fresh start resyncs in a minute or two).
//
// Why: on the 21 Nov 2026 run the requester's wallet stopped following the chain's DUST (its view
// went from 303 s to 1,991 s old) and every request failed "balanceTx rejected" until it was
// restarted by hand; the operators' wallet did the same an hour later. Lunardraw's keeper and
// house agents restart themselves the same way.
import { inspect } from 'node:util';

/** Exit code asking the service manager for a restart (as the Nightcast CLI's services use). */
export const RESTART = 75;

const progressOf = (p) => {
  try {
    return p?.progress ?? p?.state?.progress; // wallet SDK 2, then SDK 1
  } catch {
    return undefined; // a getter that throws before its part has started
  }
};
const pos = (p) => {
  const g = progressOf(p);
  const v = g?.appliedIndex ?? g?.appliedId;
  return v === undefined ? '?' : String(v);
};

/** How far each part of the wallet has applied the chain's events. */
export const positionsOf = (state) => ({ shielded: pos(state?.shielded), unshielded: pos(state?.unshielded), dust: pos(state?.dust) });

/** A transaction refused for a fee the node calls stale, or that the wallet couldn't balance: what a wallet that fell behind produces. */
export const isBehindError = (err) => /Custom error: 170\b|balanceTx rejected/i.test(`${String(err)} ${err instanceof Error ? err.message : ''} ${inspect(err, { depth: 6 })}`);

/**
 * The decisions, apart from the wallet and the clock.
 * - DUST is what the fees are dated by, and the chain's DUST moves every few seconds: if the wallet's
 *   DUST position hasn't moved for `minutes`, its view is that old and transactions start failing.
 *   (Before the DUST position is known, any part moving counts: a first sync.)
 * - `failures` transactions in a row refused as from a wallet that fell behind.
 */
export const stallWatch = ({ minutes = 10, failures = 3, now = Date.now } = {}) => {
  let last = '';
  let movedAt = now();
  let behind = 0;
  let reason;
  return {
    see(state) {
      const p = positionsOf(state);
      const key = p.dust !== '?' ? `dust:${p.dust}` : `${p.shielded}|${p.unshielded}`;
      if (key !== last) {
        last = key;
        movedAt = now();
      }
    },
    sent() {
      behind = 0;
    },
    failed(err) {
      if (isBehindError(err)) behind += 1;
      if (behind >= failures) reason ??= `${behind} transactions in a row were refused as from a wallet that fell behind the chain`;
    },
    /** A reason to restart now, if there is one. */
    check() {
      const stalled = (now() - movedAt) / 60_000;
      if (minutes > 0 && stalled >= minutes) reason ??= `the wallet's sync hasn't moved for ${Math.floor(stalled)} minutes (${last || 'nothing seen yet'})`;
      return reason;
    },
  };
};

/**
 * Follow `wallet` (a Midnight wallet provider) and exit with RESTART when the watch says so.
 * Returns the watch (for `sent` / `failed`) with `stop()`.
 */
export const watchWallet = (wallet, { minutes = 10, failures = 3, log = console.log, exit = (code) => process.exit(code) } = {}) => {
  const watch = stallWatch({ minutes, failures });
  let sub;
  try {
    sub = wallet.wallet.state().subscribe({ next: (s) => watch.see(s), error: () => undefined });
  } catch {
    sub = undefined; // no state stream: the failures still count
  }
  const timer = setInterval(() => {
    const why = watch.check();
    if (!why) return;
    clearInterval(timer);
    log(`${why}; restarting to resync it`);
    exit(RESTART);
  }, 30_000);
  timer.unref?.();
  return {
    ...watch,
    stop() {
      clearInterval(timer);
      try {
        sub?.unsubscribe();
      } catch {
        /* already closed */
      }
    },
  };
};
