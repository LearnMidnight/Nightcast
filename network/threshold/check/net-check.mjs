// The threshold network, stage 3a, in memory (compact-runtime): the registry and six epochs in a
// row on one contract. The committee's size follows the number of independents (1 of 1, 3 of 5,
// 4 of 7), seats go to the front of the queue and then to the house, a ceremony that fails costs
// the seats that didn't deal, and for each size EVERY set of t answers must give the off-chain
// value. Cheating and out-of-turn calls must fail, a void request must keep its value, fees must
// reach the seats that answered in time, and the NIGHT the contract holds must always equal the
// bonds, the pot, the fees of unsettled requests, what operators have earned and the dust.
// An operator counts as independent only once a stake pool's Ed25519 key (real signatures, from
// Node's crypto) on the contract's list has signed for it.
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
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
  quotient: ({ privateState }, total, k) => [privateState, privateState.badQuotient ?? total / k],
  poolPath: ({ privateState }, pool) => [privateState, pathOf(pool)],
};
// Ed25519 (RFC 8032): a 32-byte key or R as the point the runtime wants, and S as a number.
const q = (1n << 255n) - 19n;
const pw = (b, e) => { let x = 1n; b = mod(b, q); while (e > 0n) { if (e & 1n) x = mod(x * b, q); b = mod(b * b, q); e >>= 1n; } return x; };
const dEd = mod(-121665n * pw(121666n, q - 2n), q);
const le = (b) => BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
const decode = (b) => {
  const n = le(b), y = n & ((1n << 255n) - 1n), sgn = n >> 255n;
  const u = mod(y * y - 1n, q), v = mod(dEd * y * y + 1n, q);
  let x = mod(u * pw(v, 3n) * pw(u * pw(v, 7n), (q - 5n) / 8n), q);
  if (mod(v * x * x, q) !== u) x = mod(x * pw(2n, (q - 1n) / 4n), q);
  if (mod(v * x * x, q) !== u) throw new Error('not a point');
  if ((x & 1n) !== sgn) x = mod(-x, q);
  return { x, y };
};
/** A stake pool: an Ed25519 key pair, its key as a point, and its id in the contract. */
const pool = (name) => { const k = generateKeyPairSync('ed25519'); const key = decode(Buffer.from(k.publicKey.export({ format: 'jwk' }).x, 'base64url')); return { name, secret: k.privateKey, key, id: P.pureCircuits.poolIdOf(key) }; };
const signed = (p, msg) => { const g = sign(null, Buffer.from(msg), p.secret); return { r: decode(g.subarray(0, 32)), s: le(g.subarray(32)) }; };
// The contract's list: a 13-level Merkle tree of the listed pools' leaves, empty places 0.
const DEPTH = 13;
const POOLS = Array.from({ length: 7 }, (_, k) => pool(`pool${k}`));
const UNLISTED = pool('unlisted');
const levels = [new Map(POOLS.map((p, k) => [k, P.pureCircuits.poolLeafOf(p.id)]))];
const empty = [0n];
for (let d = 0; d < DEPTH; d++) {
  const up = new Map();
  for (const k of levels[d].keys()) { const j = k >> 1; if (!up.has(j)) up.set(j, P.pureCircuits.poolNodeOf(levels[d].get(2 * j) ?? empty[d], levels[d].get(2 * j + 1) ?? empty[d])); }
  levels.push(up);
  empty.push(P.pureCircuits.poolNodeOf(empty[d], empty[d]));
}
const ROOT = levels[DEPTH].get(0);
const pathOf = (id) => {
  let k = POOLS.findIndex((p) => hexOf(p.id) === hexOf(id));
  if (k < 0) k = 0; // not on the list: any path, and the root won't match
  return Array.from({ length: DEPTH }, (_, d) => { const step = { sibling: levels[d].get(k ^ 1) ?? empty[d], right: (k & 1) === 1 }; k >>= 1; return step; });
};
const hexOf = (b) => Buffer.from(b).toString('hex');
const G = (x) => rt.ecMulGenerator(x);
const ID = G(0n);
const NATIVE = '0'.repeat(64);
const SLOT = 1_000_000n, MINBOND = 10n, PENALTY = 2n, EPOCH = 3600n, FEE = 700_000n, BOUNTY = 100_000n, MISS = 1n, MISSES = 1n;
const REFUND = new Uint8Array(32).fill(0xfe), FINALISER = new Uint8Array(32).fill(0xfd);
// an operator: a secret, its id and a payout address
let made = 0;
const operator = (name) => { const op = rand(); made++; return { name, op, id: P.pureCircuits.keyIdOf(G(op)), payout: new Uint8Array(32).fill(made) }; };
const H = ['h0', 'h1', 'h2', 'h3'].map(operator);
const contract = new P.Contract(witnesses);
const address = rt.sampleContractAddress();
let state = (await contract.initialState(rt.createConstructorContext({}, COIN), MIN, MAX, EPOCH, SLOT, MINBOND, PENALTY, FEE, BOUNTY, MISS, MISSES, H.map((h) => h.id), ROOT)).currentContractState;
let balance = 0n;
let paidOut = new Map();
const snapshot = () => ({ data: state.data, balance, paidOut: new Map(paidOut) });
const restore = (s) => { state.data = s.data; balance = s.balance; paidOut = new Map(s.paidOut); };
const paid = (to) => paidOut.get(hexOf(to)) ?? 0n;
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
/** This contract's address as a pure circuit takes it. */
const SELF = () => ({ bytes: new Uint8Array(rt.encodeContractAddress ? rt.encodeContractAddress(address) : Buffer.from(address, 'hex')) });
/** The message pool p signs to back operator o now, and the link itself. */
const linkMessage = (o, p) => P.pureCircuits.linkMessageOf(SELF(), o.id, ledger().poolLinks.member(p.id) ? ledger().poolLinks.lookup(p.id) : 0n);
const link = (o, p = o.pool, sig = signed(p, linkMessage(o, p))) => call('linkPool', [o.id, sig, p.key]);
const linked = (o) => ledger().poolOf.member(o.id);
/** Register; an operator with a stake pool that isn't linked yet is linked too. */
const register = async (o, n = 12n) => { await call('register', [{ bytes: o.payout }, n], { op: o.op }); if (o.pool && !linked(o)) await link(o); };
const everyone = new Map(H.map((h) => [hexOf(h.id), h]));
let pooled = 0;
const independent = (name) => { const o = operator(name); o.pool = POOLS[pooled++]; everyone.set(hexOf(o.id), o); return o; };
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
  const rid = await ask(tag);
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...polys.values()].reduce((s, a) => s + a[0], 0n)); // nobody holds this: for the check only
  const expected = P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk)));
  for (let i = 1; i <= Number(c.n); i++) await call('answer', [rid, BigInt(i)], { sk: sk[i - 1] });
  const before = snapshot();
  let same = 0;
  const all = subsets(Number(c.n), Number(c.t));
  for (const s of all) {
    restore(before);
    const out = await fin(rid, s);
    if (Buffer.from(out).equals(Buffer.from(expected))) same++;
  }
  ok(same === all.length, `${c.t} of ${c.n}: all ${all.length} sets of ${c.t} answers give one value, the off-chain 720·sk·H's`);
  return { rid, before, expected };
};
const books = (what) => {
  const l = ledger();
  let slotsHeld = l.pot, atoms = l.dust;
  for (const [id] of l.operators) slotsHeld += l.bonds.lookup(id).read();
  for (const [, r] of l.requests) if (!r.settled) atoms += r.fee;
  for (const [, v] of l.earned) atoms += v;
  ok(balance === slotsHeld * SLOT + atoms, `${what}: the NIGHT the contract holds is exactly the bonds, the pot, unsettled fees, unclaimed earnings and dust`);
};
const dl = () => BigInt(now) + 1800n;
const ask = (tag, ps = {}) => call('request', [bytes(tag), BigInt(now) + 600n, { bytes: REFUND }], ps);
const fin = (rid, s, ps = {}) => call('finalise', [rid, slots(s), { bytes: FINALISER }], ps);
const finish = (e) => call('finish', [e, BigInt(now)]);
const earnedBy = (o) => (ledger().earned.member(o.id) ? ledger().earned.lookup(o.id) : 0n);
/** Open the next epoch once the serving one has served its length. */
const open = async () => { if (ledger().current > 0n && ledger().opened === ledger().current) now += Number(EPOCH); return call('openEpoch', [dl()]); };

// ---- the registry
await fails(ask('too early'), /no committee is serving/, 'no request before a committee serves');
await fails(call('openEpoch', [dl()]), /not enough house operators/, "no committee can open with nobody registered");
await fails(register(H[0], 9n), /below the minimum/, 'a bond below the minimum is refused');
for (const h of H) await register(h, 20n);
await fails(register(H[0]), /already registered/, 'an operator registers once');
ok(ledger().houseActive === 4n && ledger().independents === 0n && ledger().tail === 0n, 'the four keys named at deploy register as the house, and the house never queues');
books('after registering');

// ---- epoch 1: nobody independent, so 1 of 1, a house seat (today's single oracle)
const e1 = await open();
ok(ledger().committees.lookup(e1).n === 1n && ledger().committees.lookup(e1).t === 1n, 'with no independents the committee is 1 of 1');
await fails(call('openEpoch', [dl()]), /still running/, 'no new epoch while a ceremony is running');
await fails(call('seat', [e1, 4n]), /four slots/, 'the house has four slots');
await fill(e1, [1]);
ok(names(e1) === 'h1', 'a house operator takes the seat');
await fails(call('seat', [e1, 0n]), /isn't seating/, 'a full committee takes no more seats');
const p1 = await deal(e1, [1]);
await fails(call('finish', [e1, BigInt(now) + 1000n]), /isn't the time now/, "finish must be given the time now");
ok((await finish(e1)) === true && ledger().current === 1n && ledger().committees.lookup(e1).since === BigInt(now), 'epoch 1 serves once its one dealer has finished');
await fails(call('openEpoch', [dl()]), /isn't over/, 'the next epoch opens only once the serving one has served its length');
const sk1 = sharesOf(e1, p1);
ok(eq(shareKeyOnChain(1n, 1), G(sk1[0])), "its share key on chain is its share's");
await everySubset(e1, p1, sk1, 'draw 1');
const old = await ask('draw 1b');
await call('answer', [old, 1n], { sk: sk1[0] });
const oldExpected = P.pureCircuits.outputOf(rt.ecMul(ledger().requests.lookup(old).point, mod(D * p1.get(1)[0])));

// ---- epoch 2: two independents, so 3 of 5: they sit first, the house fills three seats
const A = independent('a'), B = independent('b');
{
  // the stake pool link, on a copy of the state (so the epochs below start as before)
  const before = snapshot();
  await call('register', [{ bytes: A.payout }, 12n], { op: A.op });
  ok(ledger().operators.lookup(A.id).active && !ledger().operators.lookup(A.id).queued && ledger().independents === 0n && ledger().tail === 0n, 'an operator that registers with no stake pool behind it is not an independent, and does not queue');
  await fails(link(H[0], POOLS[6]), /need no pool/, "the house's operators take no pool");
  await fails(link(B), /not a registered operator/, 'a pool links only a registered operator');
  await fails(link(A, UNLISTED), /isn't on this contract's list/, "a key that isn't on the contract's list of stake pools is refused, whatever it signs");
  await fails(link(A, A.pool, signed(POOLS[1], linkMessage(A, A.pool))), /didn't sign/, "a listed pool's key with another key's signature is refused");
  await fails(link(A, A.pool, signed(A.pool, linkMessage(B, A.pool))), /didn't sign/, 'and its signature for another operator');
  const first = signed(A.pool, linkMessage(A, A.pool));
  await link(A, A.pool, first);
  ok(linked(A) && ledger().operators.lookup(A.id).queued && ledger().independents === 1n && ledger().tail === 1n && hexOf(ledger().poolOperator.lookup(A.pool.id)) === hexOf(A.id), "once a listed pool's key has signed for it, the operator is an independent and joins the queue");
  ok(eq(ledger().poolKeys.lookup(A.pool.id), A.pool.key), "the pool's key is on chain for anyone to look up on Cardano");
  await fails(link(A, POOLS[1]), /is linked to a pool/, 'an operator is linked once');
  await call('register', [{ bytes: B.payout }, 12n], { op: B.op });
  await fails(link(B, A.pool), /still active/, 'a pool backs one operator at a time');
  await call('leave', [], { op: A.op });
  ok(ledger().independents === 0n, 'when it leaves it no longer counts');
  await fails(link(B, A.pool, signed(A.pool, P.pureCircuits.linkMessageOf(SELF(), B.id, 0n))), /didn't sign/, "a pool's next link signs its next number");
  await link(B, A.pool);
  ok(linked(B) && !linked(A) && ledger().poolLinks.lookup(A.pool.id) === 2n && ledger().independents === 1n, 'once its operator has left, the pool can move to another; the one that left is unlinked');
  await call('register', [{ bytes: A.payout }, 0n], { op: A.op });
  ok(!ledger().operators.lookup(A.id).queued && ledger().independents === 1n, 'the unlinked operator can register again, but waits for a pool');
  await fails(link(A, A.pool, first), /still active|didn't sign/, "and the pool's old signature doesn't bring it back");
  restore(before);
}
await register(A);
await register(B);
ok(ledger().independents === 2n && ledger().tail === 2n, 'anyone else who registers is an independent, and joins the queue');
const e2 = await open();
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
await fails(finish(e2), /deadline hasn't passed/, "a ceremony with a dealer missing can't finish before its deadline");
now += 1801;
ok((await finish(e2)) === true && ledger().current === 2n, 'past the deadline, 4 finished dealers of 5 are enough: epoch 2 serves');
const sk2 = sharesOf(e2, p2);
for (let i = 1; i <= 5; i++) ok(eq(shareKeyOnChain(2n, i), G(sk2[i - 1])), `epoch 2, position ${i} (${seated(e2)[i - 1].name}): the share it opened from its parcels matches its share key on chain${i === 5 ? ' (it never dealt, and still holds a share)' : ''}`);
const r2 = await everySubset(e2, p2, sk2, 'draw 2');
books('after epoch 2');

// ---- cheating on a request (epoch 2's, restored to before it was finalised)
restore(r2.before);
await fails(fin(r2.rid, [1, 2]), /threshold of them/, 'too few positions are refused');
await fails(fin(r2.rid, [1, 2, 3, 4]), /threshold of them/, 'and too many');
await fails(fin(r2.rid, [2, 1, 3]), /threshold of them/, 'and out of order');
await fails(fin(r2.rid, [1, 2, 6]), /threshold of them/, 'and a position outside the committee');
await fails(fin(r2.rid, [1, 2, 3], { badCoefficient: 1n }), /wrong coefficient/, 'a wrong coefficient is refused');
await fails(call('answer', [r2.rid, 3n], { sk: sk2[2] }), /already answered/, 'a position answers once');
{
  const before = balance;
  const rid = await ask('draw 2b');
  ok(balance === before + FEE, 'a request pays the fee into the contract');
  ok(hexOf(rid) !== hexOf(r2.rid), 'the same requester again gets a new id (the counter)');
  await fails(call('answer', [rid, 3n], { sk: sk2[3] }), /not this position's share/, "a position can't answer with another position's share");
  await fails(call('answer', [rid, 3n], { sk: rand() }), /not this position's share/, 'or with any other secret');
  await call('answer', [rid, 1n], { sk: sk2[0] });
  await call('answer', [rid, 2n], { sk: sk2[1] });
  await fails(fin(rid, [1, 2, 3]), /a share is missing/, 'two answers of three are not enough');
  await fails(call('settle', [rid]), /deadline has not passed/, "a request can't be settled before its deadline");
  now += 601;
  await call('settle', [rid]);
  ok(ledger().requests.lookup(rid).voided === true && paid(REFUND) === FEE + 3n * MISS * SLOT, 'past its deadline without a value the request is void: the requester gets the fee back, plus a slot of bond from each of the three seats that did not answer');
  ok(bond(H[0]) === 19n && bond(H[1]) === 19n && bond(H[2]) === 19n && bond(A) === 12n, 'those three seats each lost that slot; the two that answered lost nothing');
  await fails(call('settle', [rid]), /already settled/, 'a request is settled once');
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...p2.values()].reduce((s, a) => s + a[0], 0n));
  await call('answer', [rid, 5n], { sk: sk2[4] });
  const bounties = paid(FINALISER);
  const out = await fin(rid, [1, 2, 5]);
  ok(Buffer.from(out).equals(Buffer.from(P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk))))), 'a void request answered late gives the value it always had: silence buys no second roll');
  ok(paid(FINALISER) === bounties, 'and pays no bounty: its fee went back');
}
{
  // epoch 2's first request: all five answered in time; it is finalised only now, after its deadline
  const bounties = paid(FINALISER);
  await fin(r2.rid, [1, 2, 3]);
  ok(paid(FINALISER) === bounties + BOUNTY, 'whoever sends finalise is paid the bounty out of the fee');
  await fails(call('settle', [r2.rid], { badQuotient: 1n }), /shared equally/, "the fee can't be shared out unequally");
  await call('settle', [r2.rid]);
  const each = (FEE - BOUNTY) / 5n;
  ok(seated(e2).every((o) => earnedBy(o) === each), 'the rest of the fee is shared equally by the five seats that answered in time, whoever was combined');
  await call('claim', [], { op: A.op });
  ok(paid(A.payout) === each && earnedBy(A) === 0n, 'an operator claims what it earned, to its payout address');
  await fails(call('claim', [], { op: A.op }), /nothing to claim/, 'and only once');
}
books('after the fees of epoch 2');

// ---- epoch 3: four independents, so 4 of 7. Its ceremony fails, and that costs the seats that didn't deal
const C = independent('c'), Dd = independent('d');
await register(C);
await register(Dd);
const e3 = await open();
{
  const c = ledger().committees.lookup(e3);
  ok(c.n === 7n && c.t === 4n && c.indepSeats === 4n, 'with 4 independents the committee is 4 of 7: four seats for them, three for the house (below the threshold)');
}
await fill(e3, [0, 1, 2]);
ok(names(e3) === 'c d a b h0 h1 h2', 'the longest-waiting sit first: c and d, who had not served, then a and b from the committee that has');
await deal(e3, [1, 2, 5]); // c, d and h0 deal; a, b, h1 and h2 don't
now += 1801;
ok((await finish(e3)) === false && ledger().committees.lookup(e3).phase === P.Phase.failed && ledger().current === 2n, 'with 3 finished dealers of 7 (below the threshold) the ceremony fails at its deadline, and epoch 2 carries on');
await fails(finish(e3), /ceremony is over/, 'a ceremony ends once');
const e4 = await open();
ok(bond(A) === 10n && bond(B) === 10n && bond(H[1]) === 17n && bond(H[2]) === 17n && bond(C) === 12n && bond(Dd) === 12n && bond(H[0]) === 19n && ledger().pot === 8n, 'the four seats that did not finish dealing each lost 2 slots of bond to the pot; the three that did lost nothing');
books('after the failed ceremony');
await fill(e4, [3, 0, 1]);
ok(names(e4) === 'c d a b h3 h0 h1', 'the failed committee rejoined the queue in its order, and any active house operators fill the rest');
const p4 = await deal(e4, [1, 2, 3, 4, 5, 6, 7]);
ok((await finish(e4)) === true && ledger().current === 4n, 'epoch 4 (4 of 7) serves as soon as all 7 dealers have finished, before its deadline');
const sk4 = sharesOf(e4, p4);
await everySubset(e4, p4, sk4, 'draw 4');
{
  const rid = await ask('draw 4b');
  ok(ledger().requests.lookup(rid).epoch === 4n, 'a new request belongs to the epoch serving when it was made');
  await fails(call('answer', [rid, 1n], { sk: sk2[0] }), /not this position's share/, "an earlier epoch's share doesn't answer it");
}
ok(Buffer.from(await fin(old, [1])).equals(Buffer.from(oldExpected)), "with epoch 4 serving, epoch 1's open request is still finalised with epoch 1's key");

// ---- leaving, the queue's stale entries, and taking the bond back
await call('leave', [], { op: Dd.op });
await fails(call('leave', [], { op: Dd.op }), /already left/, 'an operator leaves once');
await fails(call('withdraw', [12n], { op: Dd.op }), /two epochs/, "an operator that left can't take its bond straight away");
await fails(call('withdraw', [3n], { op: C.op }), /keeps the minimum/, 'an active operator keeps the minimum bond');
await call('withdraw', [2n], { op: H[3].op });
ok(bond(H[3]) === 18n && paid(H[3].payout) === 2n * SLOT, 'bond above the minimum comes back to the payout address');
const E = independent('e');
await register(E);
await call('leave', [], { op: E.op });
ok(ledger().independents === 3n, 'd and e have left: three independents');
const e5 = await open();
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
ok((await finish(e5)) === true, 'epoch 5 serves');
const sk5 = sharesOf(e5, p5);
await everySubset(e5, p5, sk5, 'draw 5');
{
  // two requests that only the three independents answer in time: the pot of penalties goes with the first fee
  const x = await ask('draw 5x'), y = await ask('draw 5y');
  for (const rid of [x, y]) { for (const i of [1, 2, 3]) await call('answer', [rid, BigInt(i)], { sk: sk5[i - 1] }); await fin(rid, [1, 2, 3]); }
  const had = earnedBy(C);
  now += 601;
  await call('answer', [y, 4n], { sk: sk5[3] }); // h2, too late
  await call('settle', [x]);
  await call('settle', [y]);
  const first = FEE - BOUNTY + 8n * SLOT;
  ok(earnedBy(C) === had + first / 3n + (FEE - BOUNTY) / 3n && ledger().pot === 0n && ledger().dust === first % 3n, 'the penalties in the pot go to the seats that answered the next request in time; what does not divide stays as dust');
  ok(earnedBy(H[2]) === (FEE - BOUNTY) / 5n, 'an answer after the deadline earns nothing');
  ok(ledger().missed.lookup(H[2].id) === 2n && ledger().missed.lookup(H[3].id) === 2n && ledger().missed.lookup(C.id) === 0n, 'a miss is counted against each seat that did not answer in time');
  await call('claim', [], { op: C.op });
  ok(paid(C.payout) === had + first / 3n + (FEE - BOUNTY) / 3n, 'c claims its fees');
}
books('after the fees of epoch 5');
await fails(call('withdraw', [12n], { op: Dd.op }), /two epochs/, 'one served epoch after leaving is not enough');
const e6 = await open();
ok(!ledger().operators.lookup(H[2].id).active && !ledger().operators.lookup(H[3].id).active && ledger().houseActive === 2n, 'h2 and h3 missed more requests than a term allows: they are stood down when the next epoch opens');
await fill(e6, [0, 1]);
await register(H[2], 0n);
ok(ledger().operators.lookup(H[2].id).active && ledger().houseActive === 3n, 'a stood-down operator can register again, for a later committee');
await deal(e6, [1, 2, 3, 4, 5]);
ok((await finish(e6)) === true && ledger().current === 6n, 'epoch 6 serves');
await call('withdraw', [12n], { op: Dd.op });
ok(bond(Dd) === 0n && paid(Dd.payout) === 12n * SLOT, 'two served epochs after leaving, d takes its whole bond back');
await fails(call('withdraw', [1n], { op: Dd.op }), /not that much bond/, 'and no more than it has');
await register(Dd);
ok(ledger().operators.lookup(Dd.id).active && ledger().independents === 4n, 'd can rejoin with a fresh bond, at the back of the queue');
books('at the end');
console.log(`${checks} checks passed`);
