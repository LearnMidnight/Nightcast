// The threshold network, stage 1, in memory (compact-runtime): three epochs in a row on one
// contract (1 of 1, then 3 of 5 with a dealer missing, then 4 of 7), each with its ceremony, a
// request, and EVERY set of t answers combined: all must give the off-chain value. Cheating and
// out-of-turn calls must fail, and a void request must keep its value.
import { webcrypto } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as P from './out-net/contract/index.js';

const r = rt.JUBJUB_SCALAR_MODULUS;
const fp = 52435875175126190479447740508185965837690552500527637822603658699938581184513n; // the proof system's field
const mod = (a, m = r) => ((a % m) + m) % m;
const rand = () => mod(BigInt('0x' + Buffer.from(webcrypto.getRandomValues(new Uint8Array(40))).toString('hex')));
const D = 720n;
const COIN = '0'.repeat(64);
const MIN = 60n, MAX = 3600n;
const bytes = (s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
let now = 1_800_000_000;
let checks = 0;
const ok = (c, what) => { if (!c) throw new Error(`FAILED: ${what}`); checks++; console.log(`ok  ${what}`); };
const fails = async (pr, re, what) => { try { await pr; } catch (e) { ok(re.test(String(e?.message ?? e)), `${what} (${String(e?.message ?? e).slice(0, 70)})`); return; } ok(false, `${what}: did not fail`); };

const coeff = (i, others) => {
  let num = D, den = 1n;
  for (const j of others) { if (!j) continue; num *= BigInt(j); den *= BigInt(j > i ? j - i : i - j); }
  if (num % den) throw new Error('not an integer');
  return num / den;
};
const witnesses = {
  seatSecret: ({ privateState }) => [privateState, privateState.seat],
  coefficients: ({ privateState }) => [privateState, privateState.a],
  shareFor: ({ privateState }) => [privateState, privateState.s],
  ephemeral: ({ privateState }) => [privateState, privateState.x ?? rand()],
  shareSecret: ({ privateState }) => [privateState, privateState.sk],
  coefficient: ({ privateState }, i, a, b, c) => [privateState, privateState.badCoefficient ?? coeff(Number(i), [a, b, c].map(Number))],
  requesterSecret: ({ privateState }) => [privateState, privateState.requester ?? bytes('requester')],
};
const contract = new P.Contract(witnesses);
const address = rt.sampleContractAddress();
let state = (await contract.initialState(rt.createConstructorContext({}, COIN), MIN, MAX)).currentContractState;
const call = async (circuit, args, ps = {}) => {
  const ctx = rt.createCircuitContext({ circuitId: circuit, contractAddress: address, coinPublicKeyOrZswapState: COIN, contractState: state, privateState: ps, time: now });
  const out = await contract.impureCircuits[circuit](ctx, ...args);
  state.data = out.context.queryContexts[address].state;
  return out.result;
};
const ledger = () => P.ledger(state.data);
const eq = (a, b) => a.x === b.x && a.y === b.y;
const at = (a, x) => mod(a.reduce((s, c, k) => s + c * BigInt(x) ** BigInt(k), 0n));
const G = (x) => rt.ecMulGenerator(x);
const ID = G(0n);
const subsets = (n, t) => { const out = []; const go = (from, acc) => { if (acc.length === t) { out.push(acc); return; } for (let i = from; i <= n; i++) go(i + 1, [...acc, i]); }; go(1, []); return out; };
const slots = (s) => [...s, 0, 0, 0, 0].slice(0, 4).map(BigInt);

/** Run epoch e's ceremony: every position sits, the dealers in `dealers` deal; returns the secrets. */
const ceremony = async (n, t, dealers) => {
  const e = await call('openEpoch', [BigInt(n), BigInt(t), BigInt(now) + 1800n]);
  const seat = Array.from({ length: n }, rand);
  for (let i = 1; i <= n; i++) await call('takeSeat', [e, BigInt(i), G(seat[i - 1])], { seat: seat[i - 1] });
  const polys = new Map();
  for (const d of dealers) {
    const a = Array.from({ length: 4 }, (_, k) => (k < t ? rand() : 0n));
    polys.set(d, a);
    await call('dealCommit', [e, BigInt(d), a.map(G)], { seat: seat[d - 1], a });
    for (let i = 1; i <= n; i++) await call('dealShare', [e, BigInt(d), BigInt(i)], { s: at(a, i) });
  }
  return { e, n, t, seat, polys };
};
/** Each position opens its parcels from the finished dealers and adds them up: its share. */
const sharesOf = (c) => Array.from({ length: c.n }, (_, k) => {
  const i = k + 1;
  let sk = 0n;
  for (const d of c.polys.keys()) {
    const parcel = ledger().parcels.lookup(P.pureCircuits.cellKey(c.e, BigInt(d), BigInt(i)));
    const shared = rt.ecMul(parcel.r, c.seat[k]);
    sk += mod(mod(parcel.c - P.pureCircuits.padOf(shared, c.e, BigInt(d), BigInt(i)), fp));
  }
  return mod(sk);
});
/** A request to the serving committee; everyone answers; every t-set finalises to one value. */
const everySubset = async (c, sk, tag) => {
  const rid = await call('request', [bytes(tag), BigInt(now) + 600n]);
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...c.polys.values()].reduce((s, a) => s + a[0], 0n)); // nobody holds this: for the check only
  const expected = P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk)));
  for (let i = 1; i <= c.n; i++) await call('answer', [rid, BigInt(i)], { sk: sk[i - 1] });
  const before = state.data;
  let same = 0;
  const all = subsets(c.n, c.t);
  for (const s of all) {
    state.data = before;
    const out = await call('finalise', [rid, slots(s)]);
    if (Buffer.from(out).equals(Buffer.from(expected))) same++;
  }
  ok(same === all.length, `${c.t} of ${c.n}: all ${all.length} sets of ${c.t} answers give one value, the off-chain 720·sk·H's`);
  return { rid, before, expected };
};

// ---- before any committee
await fails(call('request', [bytes('too early'), BigInt(now) + 600n]), /no committee is serving/, 'no request before a committee serves');
await fails(call('openEpoch', [4n, 2n, BigInt(now) + 1800n]), /1 of 1, 3 of 5 or 4 of 7/, 'a committee is one of the three sizes');

// ---- epoch 1: 1 of 1 (today's single oracle)
const c1 = await ceremony(1, 1, [1]);
await fails(call('openEpoch', [5n, 3n, BigInt(now) + 1800n]), /still running/, 'no new epoch while a ceremony is running');
ok((await call('finish', [c1.e])) === true && ledger().current === 1n, 'epoch 1 (1 of 1) serves once its one dealer has finished');
const sk1 = sharesOf(c1);
ok(eq(await call('shareKey', [1n, 1n]), G(sk1[0])), "its share key on chain is its share's");
await everySubset(c1, sk1, 'draw 1');
// one more epoch-1 request, answered and left open until epoch 3 is serving
const old = await call('request', [bytes('draw 1b'), BigInt(now) + 600n]);
await call('answer', [old, 1n], { sk: sk1[0] });
const oldExpected = P.pureCircuits.outputOf(rt.ecMul(ledger().requests.lookup(old).point, mod(D * c1.polys.get(1)[0])));

// ---- epoch 2: 3 of 5, and one dealer never deals
const c2open = await call('openEpoch', [5n, 3n, BigInt(now) + 1800n]);
const seat2 = Array.from({ length: 5 }, rand);
await fails(call('takeSeat', [c2open, 6n, G(seat2[0])], { seat: seat2[0] }), /no such position/, 'no seat past the committee');
await fails(call('takeSeat', [c2open, 1n, G(rand())], { seat: seat2[0] }), /not this secret/, "a seat's key must be its secret's");
for (let i = 1; i <= 5; i++) await call('takeSeat', [c2open, BigInt(i), G(seat2[i - 1])], { seat: seat2[i - 1] });
await fails(call('takeSeat', [c2open, 2n, G(seat2[1])], { seat: seat2[1] }), /isn't seating/, 'a full committee takes no more seats');
const polys2 = new Map();
const a2 = (t) => Array.from({ length: 4 }, (_, k) => (k < t ? rand() : 0n));
{
  const a = a2(3);
  await fails(call('dealCommit', [c2open, 1n, a.map(G)], { seat: seat2[1], a }), /not this position's holder/, "only a position's holder deals for it");
  await fails(call('dealCommit', [c2open, 1n, [G(a[0]), G(a[1]), G(rand()), ID]], { seat: seat2[0], a }), /not this coefficient/, "a commitment the dealer doesn't know the number of can't be posted");
  await fails(call('dealCommit', [c2open, 1n, [G(a[0]), G(a[1]), G(a[2]), G(1n)]], { seat: seat2[0], a }), /past the threshold/, 'nor a polynomial of too high a degree');
}
for (const d of [1, 2, 3, 4]) { // position 5 never deals
  const a = a2(3);
  polys2.set(d, a);
  await call('dealCommit', [c2open, BigInt(d), a.map(G)], { seat: seat2[d - 1], a });
  if (d === 1) {
    await fails(call('dealShare', [c2open, 1n, 2n], { s: mod(at(a, 2) + 1n) }), /not this dealer's share/, "a wrong share can't be posted");
    await fails(call('dealCommit', [c2open, 1n, a.map(G)], { seat: seat2[0], a }), /has dealt/, 'a position deals once');
  }
  for (let i = 1; i <= 5; i++) await call('dealShare', [c2open, BigInt(d), BigInt(i)], { s: at(a, i) });
}
await fails(call('dealShare', [c2open, 1n, 2n], { s: at(polys2.get(1), 2) }), /already sent/, 'a parcel is sent once');
await fails(call('finish', [c2open]), /deadline hasn't passed/, "a ceremony with a dealer missing can't finish before its deadline");
ok(ledger().current === 1n, 'meanwhile epoch 1 still serves');
now += 1801;
ok((await call('finish', [c2open])) === true && ledger().current === 2n, 'past the deadline, 4 finished dealers of 5 (at least the threshold) are enough: epoch 2 serves');
await fails(call('dealShare', [c2open, 5n, 1n], { s: 1n }), /isn't dealing/, 'no dealing after the ceremony');
const c2 = { e: c2open, n: 5, t: 3, seat: seat2, polys: polys2 };
const sk2 = sharesOf(c2);
for (let i = 1; i <= 5; i++) ok(eq(await call('shareKey', [2n, BigInt(i)]), G(sk2[i - 1])), `epoch 2, position ${i}: the share it opened from its parcels matches its share key on chain${i === 5 ? " (it never dealt, and still holds a share)" : ''}`);
const r2 = await everySubset(c2, sk2, 'draw 2');

// ---- cheating on a request (epoch 2's, restored to before it was finalised)
state.data = r2.before;
await fails(call('finalise', [r2.rid, slots([1, 2])]), /threshold of them/, 'too few positions are refused');
await fails(call('finalise', [r2.rid, slots([1, 2, 3, 4])]), /threshold of them/, 'and too many');
await fails(call('finalise', [r2.rid, slots([2, 1, 3])]), /threshold of them/, 'and out of order');
await fails(call('finalise', [r2.rid, slots([1, 2, 6])]), /threshold of them/, 'and a position outside the committee');
await fails(call('finalise', [r2.rid, slots([1, 2, 3])], { badCoefficient: 1n }), /wrong coefficient/, 'a wrong coefficient is refused');
await fails(call('answer', [r2.rid, 3n], { sk: sk2[2] }), /already answered/, 'a position answers once');
{
  const rid = await call('request', [bytes('draw 2b'), BigInt(now) + 600n]);
  ok(Buffer.from(rid).toString('hex') !== Buffer.from(r2.rid).toString('hex'), 'the same tag again is a new request with a new id (the counter)');
  await fails(call('answer', [rid, 3n], { sk: sk2[3] }), /not this position's share/, "a position can't answer with another position's share");
  await fails(call('answer', [rid, 3n], { sk: rand() }), /not this position's share/, 'or with any other secret');
  await call('answer', [rid, 1n], { sk: sk2[0] });
  await call('answer', [rid, 2n], { sk: sk2[1] });
  await fails(call('finalise', [rid, slots([1, 2, 3])]), /a share is missing/, 'two answers of three are not enough');
  // it goes void, and its value is still the one it always had
  await fails(call('expire', [rid]), /deadline has not passed/, "a request can't be made void before its deadline");
  now += 601;
  await call('expire', [rid]);
  ok(ledger().requests.lookup(rid).voided === true, 'past its deadline without a value, the request is void');
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...polys2.values()].reduce((s, a) => s + a[0], 0n));
  await call('answer', [rid, 5n], { sk: sk2[4] });
  const out = await call('finalise', [rid, slots([1, 2, 5])]);
  ok(Buffer.from(out).equals(Buffer.from(P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk))))), 'a void request answered late gives the value it always had: silence buys no second roll');
  await fails(call('expire', [rid]), /has its value/, 'a request with its value is not made void');
}

// ---- epoch 3: 4 of 7; epoch 1's old request is still its own committee's
const c3 = await ceremony(7, 4, [1, 2, 3, 4, 5, 6, 7]);
ok((await call('finish', [c3.e])) === true && ledger().current === 3n, 'epoch 3 (4 of 7) serves as soon as all 7 dealers have finished, before its deadline');
const sk3 = sharesOf(c3);
await everySubset(c3, sk3, 'draw 3');
{
  const rid = await call('request', [bytes('draw 3b'), BigInt(now) + 600n]);
  ok(ledger().requests.lookup(rid).epoch === 3n, 'a new request belongs to the epoch serving when it was made');
  await fails(call('answer', [rid, 1n], { sk: sk2[0] }), /not this position's share/, "an earlier epoch's share doesn't answer it");
}
ok(Buffer.from(await call('finalise', [old, slots([1])])).equals(Buffer.from(oldExpected)), "with epoch 3 serving, epoch 1's open request is still finalised with epoch 1's key");

// ---- a ceremony that fails
{
  const e = await call('openEpoch', [5n, 3n, BigInt(now) + 1800n]);
  now += 1801;
  ok((await call('finish', [e])) === false && ledger().committees.lookup(e).phase === P.Phase.failed && ledger().current === 3n, 'a ceremony nobody finished fails at its deadline, and the epoch before carries on');
  await fails(call('finish', [e]), /ceremony is over/, 'a ceremony ends once');
  const e2 = await call('openEpoch', [1n, 1n, BigInt(now) + 1800n]);
  ok(e2 === e + 1n, 'after a failed ceremony the next epoch can be opened');
}
console.log(`${checks} checks passed`);
