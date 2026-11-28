// Checks for wallet-watch.mjs: node network/threshold/ops/wallet-watch.check.mjs
import assert from 'node:assert/strict';
import { bookingWatch, restartForBookings, syncMark } from './wallet-watch.mjs';

// syncMark: changes when any part moves on, and reads both state shapes.
const st = (s, u, d) => ({ shielded: { progress: { appliedIndex: s } }, unshielded: { state: { progress: { appliedId: u } } }, dust: { progress: d } });
assert.equal(syncMark(st(1n, 2n, { appliedIndex: 3n })), '1/2/3');
assert.notEqual(syncMark(st(1n, 2n, { appliedIndex: 3n })), syncMark(st(1n, 2n, { appliedIndex: 4n })));
assert.equal(syncMark(st(1n, 2n, { isStrictlyComplete: () => true })), '1/2/done');
assert.equal(syncMark({ shielded: { get progress() { throw new Error('not yet'); } } }), '//');
assert.equal(syncMark(undefined), '//');

// bookingWatch: ages count from when this process first saw the coin booked.
let t = 0;
const w = bookingWatch(100, () => t);
w.note([{ nonce: 1n }, { nonce: 2n }]);
t = 50;
w.note([{ nonce: 1n }, { nonce: 2n }, { nonce: 3n }]);
assert.equal(w.stale(), 0);
t = 101;
assert.equal(w.stale(), 2);
w.note([{ nonce: 3n }]); // 1 and 2 left (spent or released): forgotten
assert.equal(w.stale(), 0);
t = 151;
assert.equal(w.stale(), 1);
w.note([{ token: { nonce: 3n }, generatedNow: 5n }, {}, null]); // the dust wallet's shape; coins without a nonce are left out
assert.equal(w.stale(), 1);
w.note([{ coin: { nonce: 3n } }]);
assert.equal(w.stale(), 1);
w.note([]);
assert.equal(w.stale(), 0);

// restartForBookings: only when stale bookings are what stands between the wallet and paying a fee.
assert.equal(restartForBookings({ dustCoins: 1, booked: 3 }, 3, 3), true); // house-2 on 28 Nov
assert.equal(restartForBookings({ dustCoins: 1, booked: 3 }, 3, 0), false); // recent bookings: their transactions may land
assert.equal(restartForBookings({ dustCoins: 3, booked: 3 }, 3, 3), false); // enough free coins anyway
assert.equal(restartForBookings({ dustCoins: 0, booked: 1 }, 3, 1), false); // releasing them wouldn't be enough
assert.equal(restartForBookings({ dustCoins: 1, booked: 0 }, 3, 0), false);

console.log('wallet-watch: all checks passed');
