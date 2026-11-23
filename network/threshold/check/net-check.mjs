// The threshold network, stage 2a, in memory (compact-runtime): the registry and six epochs in a
// row on one contract. The committee's size follows the number of independents (1 of 1, 3 of 5,
// 4 of 7), seats go to the front of the queue and then to the house, a ceremony that fails costs
// the seats that didn't deal, and for each size EVERY set of t answers must give the off-chain
// value. Cheating and out-of-turn calls must fail, a void request must keep its value, and the
// NIGHT the contract holds must equal the bonds and the penalty pot.
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
  operatorSecret: ({ privateState }) => [privateState, privateState.op],
  coefficients: ({ privateState }) => [privateState, privateState.a],
  shareFor: ({ privateState }) => [privateState, privateState.s],
  ephemeral: ({ privateState }) => [privateState, privateState.x ?? rand()],
  shareSecret: ({ privateState }) => [privateState, privateState.sk],
  coefficient: ({ privateState }, i, a, b, c) => [privateState, privateState.badCoefficient ?? coeff(Number(i), [a, b, c].map(Number))],
  requesterSecret: ({ privateState }) => [privateState, privateState.requester ?? bytes('requester')],
};
const G = (x) => rt.ecMulGenerator(x);
const ID = G(0n);
const hexOf = (b) => Buffer.from(b).toString('hex');
const NATIVE = '0'.repeat(64);
const SLOT = 1_000_000n, MINBOND = 10n, PENALTY = 2n;
// an operator: a secret, its id and a payout address
let made = 0;
const operator = (name) => { const op = rand(); made++; return { name, op, id: P.pureCircuits.keyIdOf(G(op)), payout: new Uint8Array(32).fill(made) }; };
const H = ['h0', 'h1', 'h2', 'h3'].map(operator);
const contract = new P.Contract(witnesses);
const address = rt.sampleContractAddress();
let state = (await contract.initialState(rt.createConstructorContext({}, COIN), MIN, MAX, SLOT, MINBOND, PENALTY, H.map((h) => h.id))).currentContractState;
let balance = 0n;
const paidOut = new Map();
const sum = (m) => { let t = 0n; for (const [k, v] of m ?? []) if (k.tag === 'unshielded' && k.raw === NATIVE) t += BigInt(v); return t; };
const call = async (circuit, args, ps = {}) => {
  state.balance = new Map([[{ tag: 'unshielded', raw: NATIVE }, balance]]);
  const ctx = rt.createCircuitContext({ circuitId: circuit, contractAddress: address, coinPublicKeyOrZswapState: COIN, contractState: state, privateState: ps, time: now });
  const out = await contract.impureCircuits[circuit](ctx, ...args);
  const fx = out.context.callProofDataTrace[0].finalQueryContext.effects;
  balance += sum(fx.unshieldedInputs) - sum(fx.unshieldedOutputs);
  for (const [[, to], amount] of fx.claimedUnshieldedSpends ?? []) {
    const k = typeof to.address === 'string' ? to.address.toLowerCase() : hexOf(to.address);
    paidOut.set(k, (paidOut.get(k) ?? 0n) + BigInt(amount));
  }
  state.data = out.context.queryContexts[address].state;
  return out.result;
};
const ledger = () => P.ledger(state.data);
const eq = (a, b) => a.x === b.x && a.y === b.y;
const at = (a, x) => mod(a.reduce((s, c, k) => s + c * BigInt(x) ** BigInt(k), 0n));
const subsets = (n, t) => { const out = []; const go = (from, acc) => { if (acc.length === t) { out.push(acc); return; } for (let i = from; i <= n; i++) go(i + 1, [...acc, i]); }; go(1, []); return out; };
const slots = (s) => [...s, 0, 0, 0, 0].slice(0, 4).map(BigInt);
const bond = (o) => ledger().bonds.lookup(o.id).read();
const register = (o, n = MINBOND) => call('register', [{ bytes: o.payout }, n], { op: o.op });
const everyone = new Map(H.map((h) => [hexOf(h.id), h]));
const independent = (name) => { const o = operator(name); everyone.set(hexOf(o.id), o); return o; };
/** Who sits where in epoch e, as the ledger has it. */
const seated = (e) => { const c = ledger().committees.lookup(e); return Array.from({ length: Number(c.seated) }, (_, k) => everyone.get(hexOf(ledger().members.lookup(P.pureCircuits.seatKey(e, BigInt(k + 1)))))); };
const names = (e) => seated(e).map((o) => o.name).join(' ');
/** Fill epoch e's committee: the queue for the independents' seats, then the house slots given. */
const fill = async (e, houseSlots) => {
  for (let guard = 0; guard < 40 && ledger().committees.lookup(e).seated < ledger().committees.lookup(e).indepSeats; guard++) await call('seat', [e, 0n]);
  for (const h of houseSlots) await call('seat', [e, BigInt(h)]);
};
/** The dealers at `positions` deal in full. Returns their polynomials. */
const deal = async (e, positions, polys = new Map()) => {
  const c = ledger().committees.lookup(e);
  const who = seated(e);
  for (const d of positions) {
    const a = Array.from({ length: 4 }, (_, k) => (k < Number(c.t) ? rand() : 0n));
    polys.set(d, a);
    await call('dealCommit', [e, BigInt(d), a.map(G)], { op: who[d - 1].op, a });
    for (let i = 1; i <= Number(c.n); i++) await call('dealShare', [e, BigInt(d), BigInt(i)], { s: at(a, i) });
  }
  return polys;
};
/** Each position opens its parcels from the finished dealers and adds them up: its share. */
const sharesOf = (e, polys) => seated(e).map((o, k) => {
  const i = k + 1;
  let sk = 0n;
  for (const d of polys.keys()) {
    const parcel = ledger().parcels.lookup(P.pureCircuits.cellKey(e, BigInt(d), BigInt(i)));
    const shared = rt.ecMul(parcel.r, o.op);
    sk += mod(mod(parcel.c - P.pureCircuits.padOf(shared, e, BigInt(d), BigInt(i)), fp));
  }
  return mod(sk);
});
const shareKeyOnChain = (e, i) => { const A = [0, 1, 2, 3].map((k) => ledger().aggregate.lookup(P.pureCircuits.seatKey(e, BigInt(k)))); return P.pureCircuits.evalCommitments(A[0], A[1], A[2], A[3], BigInt(i)); };
/** A request to the serving committee; everyone answers; every t-set finalises to one value. */
const everySubset = async (e, polys, sk, tag) => {
  const c = ledger().committees.lookup(e);
  const rid = await call('request', [bytes(tag), BigInt(now) + 600n]);
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...polys.values()].reduce((s, a) => s + a[0], 0n)); // nobody holds this: for the check only
  const expected = P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk)));
  for (let i = 1; i <= Number(c.n); i++) await call('answer', [rid, BigInt(i)], { sk: sk[i - 1] });
  const before = state.data;
  let same = 0;
  const all = subsets(Number(c.n), Number(c.t));
  for (const s of all) {
    state.data = before;
    const out = await call('finalise', [rid, slots(s)]);
    if (Buffer.from(out).equals(Buffer.from(expected))) same++;
  }
  ok(same === all.length, `${c.t} of ${c.n}: all ${all.length} sets of ${c.t} answers give one value, the off-chain 720·sk·H's`);
  return { rid, before, expected };
};
const books = (what) => {
  let held = 0n;
  for (const [id] of ledger().operators) held += ledger().bonds.lookup(id).read();
  ok(balance === (held + ledger().pot) * SLOT, `${what}: the NIGHT the contract holds is exactly the bonds plus the penalty pot`);
};
const dl = () => BigInt(now) + 1800n;

// ---- the registry
await fails(call('request', [bytes('too early'), BigInt(now) + 600n]), /no committee is serving/, 'no request before a committee serves');
await fails(call('openEpoch', [dl()]), /not enough house operators/, "no committee can open with nobody registered");
await fails(register(H[0], 9n), /below the minimum/, 'a bond below the minimum is refused');
for (const h of H) await register(h, h === H[3] ? 12n : MINBOND);
await fails(register(H[0]), /already registered/, 'an operator registers once');
ok(ledger().houseActive === 4n && ledger().independents === 0n && ledger().tail === 0n, 'the four keys named at deploy register as the house, and the house never queues');
books('after registering');

// ---- epoch 1: nobody independent, so 1 of 1, a house seat (today's single oracle)
const e1 = await call('openEpoch', [dl()]);
ok(ledger().committees.lookup(e1).n === 1n && ledger().committees.lookup(e1).t === 1n, 'with no independents the committee is 1 of 1');
await fails(call('openEpoch', [dl()]), /still running/, 'no new epoch while a ceremony is running');
await fails(call('seat', [e1, 4n]), /four slots/, 'the house has four slots');
await fill(e1, [1]);
ok(names(e1) === 'h1', 'a house operator takes the seat');
await fails(call('seat', [e1, 0n]), /isn't seating/, 'a full committee takes no more seats');
const p1 = await deal(e1, [1]);
ok((await call('finish', [e1])) === true && ledger().current === 1n, 'epoch 1 serves once its one dealer has finished');
const sk1 = sharesOf(e1, p1);
ok(eq(shareKeyOnChain(1n, 1), G(sk1[0])), "its share key on chain is its share's");
await everySubset(e1, p1, sk1, 'draw 1');
const old = await call('request', [bytes('draw 1b'), BigInt(now) + 600n]);
await call('answer', [old, 1n], { sk: sk1[0] });
const oldExpected = P.pureCircuits.outputOf(rt.ecMul(ledger().requests.lookup(old).point, mod(D * p1.get(1)[0])));

// ---- epoch 2: two independents, so 3 of 5: they sit first, the house fills three seats
const A = independent('a'), B = independent('b');
await register(A);
await register(B);
ok(ledger().independents === 2n && ledger().tail === 2n, 'anyone else who registers is an independent, and joins the queue');
const e2 = await call('openEpoch', [dl()]);
{
  const c = ledger().committees.lookup(e2);
  ok(c.n === 5n && c.t === 3n && c.indepSeats === 2n, 'with 1 to 3 independents the committee is 3 of 5, with a seat for each independent');
}
await fill(e2, [0]);
await fails(call('seat', [e2, 0n]), /already seated/, 'a house operator takes one seat in a committee');
await fill(e2, [1, 2]);
ok(names(e2) === 'a b h0 h1 h2', 'the independents sit first, in the order they queued, then the house');
{
  const who = seated(e2);
  const a = Array.from({ length: 4 }, (_, k) => (k < 3 ? rand() : 0n));
  await fails(call('dealCommit', [e2, 1n, a.map(G)], { op: who[1].op, a }), /not this position's holder/, "only a position's operator deals for it");
  await fails(call('dealCommit', [e2, 1n, [G(a[0]), G(a[1]), G(rand()), ID]], { op: who[0].op, a }), /not this coefficient/, "a commitment the dealer doesn't know the number of can't be posted");
  await fails(call('dealCommit', [e2, 1n, [G(a[0]), G(a[1]), G(a[2]), G(1n)]], { op: who[0].op, a }), /past the threshold/, 'nor a polynomial of too high a degree');
}
const p2 = await deal(e2, [1, 2, 3, 4]); // position 5 (h2) never finishes dealing
await fails(call('dealShare', [e2, 1n, 2n], { s: at(p2.get(1), 2) }), /already sent/, 'a parcel is sent once');
{
  // h2 posts its commitments, then tries a wrong share, and stops there
  const a = Array.from({ length: 4 }, (_, k) => (k < 3 ? rand() : 0n));
  await call('dealCommit', [e2, 5n, a.map(G)], { op: seated(e2)[4].op, a });
  await fails(call('dealCommit', [e2, 5n, a.map(G)], { op: seated(e2)[4].op, a }), /has dealt/, 'a position posts its commitments once');
  await fails(call('dealShare', [e2, 5n, 2n], { s: mod(at(a, 2) + 1n) }), /not this dealer's share/, "a wrong share can't be posted");
  await fails(call('dealShare', [e2, 5n, 2n], { s: at(a, 3) }), /not this dealer's share/, "nor another position's share");
}
await fails(call('finish', [e2]), /deadline hasn't passed/, "a ceremony with a dealer missing can't finish before its deadline");
now += 1801;
ok((await call('finish', [e2])) === true && ledger().current === 2n, 'past the deadline, 4 finished dealers of 5 are enough: epoch 2 serves');
const sk2 = sharesOf(e2, p2);
for (let i = 1; i <= 5; i++) ok(eq(shareKeyOnChain(2n, i), G(sk2[i - 1])), `epoch 2, position ${i} (${seated(e2)[i - 1].name}): the share it opened from its parcels matches its share key on chain${i === 5 ? ' (it never dealt, and still holds a share)' : ''}`);
const r2 = await everySubset(e2, p2, sk2, 'draw 2');
books('after epoch 2');

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
  ok(hexOf(rid) !== hexOf(r2.rid), 'the same requester again gets a new id (the counter)');
  await fails(call('answer', [rid, 3n], { sk: sk2[3] }), /not this position's share/, "a position can't answer with another position's share");
  await fails(call('answer', [rid, 3n], { sk: rand() }), /not this position's share/, 'or with any other secret');
  await call('answer', [rid, 1n], { sk: sk2[0] });
  await call('answer', [rid, 2n], { sk: sk2[1] });
  await fails(call('finalise', [rid, slots([1, 2, 3])]), /a share is missing/, 'two answers of three are not enough');
  await fails(call('expire', [rid]), /deadline has not passed/, "a request can't be made void before its deadline");
  now += 601;
  await call('expire', [rid]);
  ok(ledger().requests.lookup(rid).voided === true, 'past its deadline without a value, the request is void');
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...p2.values()].reduce((s, a) => s + a[0], 0n));
  await call('answer', [rid, 5n], { sk: sk2[4] });
  const out = await call('finalise', [rid, slots([1, 2, 5])]);
  ok(Buffer.from(out).equals(Buffer.from(P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk))))), 'a void request answered late gives the value it always had: silence buys no second roll');
  await fails(call('expire', [rid]), /has its value/, 'a request with its value is not made void');
}

// ---- epoch 3: four independents, so 4 of 7. Its ceremony fails, and that costs the seats that didn't deal
const C = independent('c'), Dd = independent('d');
await register(C);
await register(Dd);
const e3 = await call('openEpoch', [dl()]);
{
  const c = ledger().committees.lookup(e3);
  ok(c.n === 7n && c.t === 4n && c.indepSeats === 4n, 'with 4 independents the committee is 4 of 7: four seats for them, three for the house (below the threshold)');
}
await fill(e3, [0, 1, 2]);
ok(names(e3) === 'c d a b h0 h1 h2', 'the longest-waiting sit first: c and d, who had not served, then a and b from the committee that has');
await deal(e3, [1, 2, 5]); // c, d and h0 deal; a, b, h1 and h2 don't
now += 1801;
ok((await call('finish', [e3])) === false && ledger().committees.lookup(e3).phase === P.Phase.failed && ledger().current === 2n, 'with 3 finished dealers of 7 (below the threshold) the ceremony fails at its deadline, and epoch 2 carries on');
await fails(call('finish', [e3]), /ceremony is over/, 'a ceremony ends once');
const e4 = await call('openEpoch', [dl()]);
ok(bond(A) === 8n && bond(B) === 8n && bond(H[1]) === 8n && bond(H[2]) === 8n && bond(C) === 10n && bond(Dd) === 10n && bond(H[0]) === 10n && ledger().pot === 8n, 'the four seats that did not finish dealing each lost 2 slots of bond to the pot; the three that did lost nothing');
books('after the failed ceremony');
await fill(e4, [3, 0, 1]);
ok(names(e4) === 'c d a b h3 h0 h1', 'the failed committee rejoined the queue in its order, and any active house operators fill the rest');
const p4 = await deal(e4, [1, 2, 3, 4, 5, 6, 7]);
ok((await call('finish', [e4])) === true && ledger().current === 4n, 'epoch 4 (4 of 7) serves as soon as all 7 dealers have finished, before its deadline');
const sk4 = sharesOf(e4, p4);
await everySubset(e4, p4, sk4, 'draw 4');
{
  const rid = await call('request', [bytes('draw 4b'), BigInt(now) + 600n]);
  ok(ledger().requests.lookup(rid).epoch === 4n, 'a new request belongs to the epoch serving when it was made');
  await fails(call('answer', [rid, 1n], { sk: sk2[0] }), /not this position's share/, "an earlier epoch's share doesn't answer it");
}
ok(Buffer.from(await call('finalise', [old, slots([1])])).equals(Buffer.from(oldExpected)), "with epoch 4 serving, epoch 1's open request is still finalised with epoch 1's key");

// ---- leaving, the queue's stale entries, and taking the bond back
await call('leave', [], { op: Dd.op });
await fails(call('leave', [], { op: Dd.op }), /already left/, 'an operator leaves once');
await fails(call('withdraw', [10n], { op: Dd.op }), /two epochs/, "an operator that left can't take its bond straight away");
await fails(call('withdraw', [1n], { op: C.op }), /keeps the minimum/, 'an active operator keeps the minimum bond');
await call('withdraw', [2n], { op: H[3].op });
ok(bond(H[3]) === 10n && paidOut.get(hexOf(H[3].payout)) === 2n * SLOT, 'bond above the minimum comes back to the payout address');
const E = independent('e');
await register(E);
await call('leave', [], { op: E.op });
ok(ledger().independents === 3n, 'd and e have left: three independents');
const e5 = await call('openEpoch', [dl()]);
{
  const c = ledger().committees.lookup(e5);
  ok(c.n === 5n && c.t === 3n && c.indepSeats === 3n, 'with 3 independents the committee is 3 of 5 again: three seats for them, two for the house');
}
const headBefore = ledger().head;
await call('seat', [e5, 0n]);
ok(ledger().committees.lookup(e5).seated === 0n && ledger().head === headBefore + 1n, "e queued and then left: its entry is dropped at the front of the queue, and seats nobody");
await fill(e5, [2, 3]);
ok(names(e5) === 'c a b h2 h3', 'd, who left while serving, is not seated again; the rest keep their order');
const p5 = await deal(e5, [1, 2, 3, 4, 5]);
ok((await call('finish', [e5])) === true, 'epoch 5 serves');
await everySubset(e5, p5, sharesOf(e5, p5), 'draw 5');
await fails(call('withdraw', [10n], { op: Dd.op }), /two epochs/, 'one served epoch after leaving is not enough');
const e6 = await call('openEpoch', [dl()]);
await fill(e6, [0, 1]);
await deal(e6, [1, 2, 3, 4, 5]);
ok((await call('finish', [e6])) === true && ledger().current === 6n, 'epoch 6 serves');
await call('withdraw', [10n], { op: Dd.op });
ok(bond(Dd) === 0n && paidOut.get(hexOf(Dd.payout)) === 10n * SLOT, 'two served epochs after leaving, d takes its whole bond back');
await fails(call('withdraw', [1n], { op: Dd.op }), /not that much bond/, 'and no more than it has');
await register(Dd);
ok(ledger().operators.lookup(Dd.id).active && ledger().independents === 4n, 'd can rejoin with a fresh bond, at the back of the queue');
books('at the end');
console.log(`${checks} checks passed`);
