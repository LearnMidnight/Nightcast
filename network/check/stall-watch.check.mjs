// node network/check/stall-watch.check.mjs : the stall watchdog's decisions (no chain, no wallet).
import assert from 'node:assert/strict';
import { RESTART, isBehindError, positionsOf, stallWatch, watchWallet } from '../ops/stall-watch.mjs';

let t = 0;
const now = () => t;
const min = (n) => { t += n * 60_000; };
const state = (dust, unshielded = 834721n, shielded = 2046998n) => ({
  shielded: { progress: { appliedIndex: shielded } },
  unshielded: { progress: { appliedId: unshielded } },
  dust: dust === undefined ? {} : { progress: { appliedIndex: dust } },
});
let n = 0;
const ok = (what, f) => { f(); n++; console.log(`ok ${what}`); };

ok('reads SDK 2 and SDK 1 positions', () => {
  assert.deepEqual(positionsOf(state(2048639n)), { shielded: '2046998', unshielded: '834721', dust: '2048639' });
  assert.deepEqual(positionsOf({ dust: { state: { progress: { appliedIndex: 7n } } } }), { shielded: '?', unshielded: '?', dust: '7' });
  assert.deepEqual(positionsOf(undefined), { shielded: '?', unshielded: '?', dust: '?' });
});

ok('stays quiet while DUST keeps moving', () => {
  t = 0;
  const w = stallWatch({ minutes: 10, now });
  for (let i = 0; i < 60; i++) { min(1); w.see(state(2048000n + BigInt(i))); assert.equal(w.check(), undefined); }
});

ok('restarts when DUST stops, even though other parts move (the requester, 21 Nov)', () => {
  t = 0;
  const w = stallWatch({ minutes: 10, now });
  w.see(state(2048639n));
  for (let i = 1; i <= 9; i++) { min(1); w.see(state(2048639n, 834721n + BigInt(i))); }
  assert.equal(w.check(), undefined);
  min(1);
  assert.match(w.check(), /hasn't moved for 10 minutes \(dust:2048639\)/);
});

ok('a first sync with no DUST position yet counts any part moving, and a wallet that never reports restarts', () => {
  t = 0;
  const w = stallWatch({ minutes: 10, now });
  for (let i = 0; i < 30; i++) { min(1); w.see(state(undefined, 1000n + BigInt(i))); assert.equal(w.check(), undefined); }
  t = 0;
  const silent = stallWatch({ minutes: 10, now });
  min(9); assert.equal(silent.check(), undefined);
  min(1); assert.match(silent.check(), /nothing seen yet/);
});

ok('restarts after three behind-the-chain refusals in a row, not for other failures', () => {
  t = 0;
  const w = stallWatch({ minutes: 10, now });
  const stale = new Error('1010: Invalid Transaction: Custom error: 170');
  const balance = new Error('balanceTx rejected');
  assert.equal(isBehindError(stale), true);
  assert.equal(isBehindError(balance), true);
  assert.equal(isBehindError(new Error('request is not pending')), false);
  w.failed(stale); w.failed(balance); w.sent(); w.failed(stale); w.failed(new Error('request has expired')); w.failed(balance);
  assert.equal(w.check(), undefined);
  w.failed(stale);
  assert.match(w.check(), /3 transactions in a row/);
});

ok('watchWallet follows the wallet and asks for exit code 75', () => {
  let next;
  const wallet = { wallet: { state: () => ({ subscribe: (o) => { next = o.next; return { unsubscribe() {} }; } }) } };
  const exits = [];
  const w = watchWallet(wallet, { minutes: 10, log: () => undefined, exit: (c) => exits.push(c) });
  next(state(1n));
  assert.equal(w.check(), undefined);
  w.stop();
  assert.equal(RESTART, 75);
  assert.deepEqual(exits, []);
});

console.log(`${n} checks passed`);
