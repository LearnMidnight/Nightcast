// The threshold network, stage 10, in memory (compact-runtime): the registry and eight epochs in a
// row on one contract. The committee's size follows the number of independents (1 of 1, 3 of 5,
// 4 of 7), seats go round the ring of independents and then to the house, a ceremony that fails costs
// the seats that didn't deal, and for each size EVERY set of t answers must give the off-chain
// value. Cheating and out-of-turn calls must fail, a void request must keep its value, fees must
// reach the seats that answered in time, and the NIGHT the contract holds must always equal the
// bonds, the forfeited penalties, the fees requests hold, what operators have earned and the dust.
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
const SLACK = 60n, CEREMONY = 1800n, ANSWER = 600n, MAXP = 3n;
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
  bucketOf: ({ privateState }, deadline) => [privateState, privateState.badBucket ?? deadline / ANSWER],
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
// The contract's list: twelve pools, in batches of eight, each batch committed to with the ones
// after it. The contract is deployed with the first commitment.
const POOLS = Array.from({ length: 12 }, (_, k) => pool(`pool${k}`));
const UNLISTED = pool('unlisted');
const ZERO = new Uint8Array(32);
const BATCHES = [];
let ROOT = ZERO;
for (let k = Math.ceil(POOLS.length / 8) - 1; k >= 0; k--) {
  const ids = Array.from({ length: 8 }, (_, j) => POOLS[k * 8 + j]?.id ?? ZERO);
  BATCHES.unshift({ ids, next: ROOT });
  ROOT = P.pureCircuits.poolBatchOf(ids, ROOT);
}
const hexOf = (b) => Buffer.from(b).toString('hex');
const G = (x) => rt.ecMulGenerator(x);
const ID = G(0n);
const NATIVE = '0'.repeat(64);
const SLOT = 1_000_000n, MINBOND = 10n, PENALTY = 2n, EPOCH = 3600n, FEE = 700_000n, BOUNTY = 100_000n, MISS = 1n, MISSES = 3n;
const REFUND = new Uint8Array(32).fill(0xfe), FINALISER = new Uint8Array(32).fill(0xfd), SETTLER = new Uint8Array(32).fill(0xfc);
// an operator: a secret, its id and a payout address
let made = 0;
const operator = (name) => { const op = rand(); made++; return { name, op, id: P.pureCircuits.keyIdOf(G(op)), payout: new Uint8Array(32).fill(made) }; };
const H = ['h0', 'h1', 'h2', 'h3'].map(operator);
const contract = new P.Contract(witnesses);
const address = rt.sampleContractAddress();
const init = async (o = {}) => contract.initialState(rt.createConstructorContext({}, COIN), SLACK, EPOCH, o.ceremony ?? CEREMONY, ANSWER, SLOT, MINBOND, o.penalty ?? PENALTY, FEE, o.bounty ?? BOUNTY, o.miss ?? MISS, MISSES, MAXP, o.house ?? H.map((h) => h.id), ROOT);
let state = (await init()).currentContractState;
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
const linkMessage = (o, p, revoke = false) => P.pureCircuits.linkMessageOf(SELF(), o.id, ledger().poolLinks.member(p.id) ? ledger().poolLinks.lookup(p.id) : 0n, revoke);
/** A pool's place in the list (0: not loaded), and the occupied place in the ring just before place i. */
const placeIn = (p) => (ledger().listed.member(p.id) ? ledger().listed.lookup(p.id) : 0n);
const prior = (i) => { let best = 0n; for (const [k] of ledger().ringOp) if (k < i && k > best) best = k; return best; };
const link = (o, p = o.pool, sig = signed(p, linkMessage(o, p)), hint = prior(placeIn(p))) => call('linkPool', [o.id, sig, p.key, false, BigInt(now), hint]);
const revoke = (o, p = o.pool, sig = signed(p, linkMessage(o, p, true))) => call('linkPool', [o.id, sig, p.key, true, BigInt(now), 0n]);
const loadPools = (b) => call('loadPools', [b.ids, b.next]);
const linked = (o) => ledger().poolOf.member(o.id);
/** Register; an operator with a stake pool that isn't linked yet is linked too. */
const register = async (o, n = 12n) => { await call('register', [{ bytes: o.payout }, n, linked(o) ? prior(placeIn(o.pool)) : 0n], { op: o.op }); if (o.pool && !linked(o)) await link(o); };
const everyone = new Map(H.map((h) => [hexOf(h.id), h]));
let pooled = 0;
const independent = (name) => { const o = operator(name); o.pool = POOLS[pooled++]; everyone.set(hexOf(o.id), o); return o; };
/** Who sits where in epoch e, as the ledger has it. */
const seated = (e) => { const c = ledger().committees.lookup(e); return Array.from({ length: Number(c.seated) }, (_, k) => everyone.get(hexOf(ledger().members.lookup(P.pureCircuits.seatKey(e, BigInt(k + 1)))))); };
const names = (e) => seated(e).map((o) => o.name).join(' ');
const seat = (e) => call('seat', [e, BigInt(now)]);
/** Fill epoch e's committee: the ring for the independents' seats, then the house in turn. */
const fill = async (e) => { for (let guard = 0; guard < 40 && ledger().committees.lookup(e).phase === P.Phase.seating; guard++) await seat(e); };
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
  let slotsHeld = l.forfeited, atoms = l.dust;
  for (const [id] of l.operators) slotsHeld += l.bonds.lookup(id).read();
  for (const [, r] of l.requests) atoms += r.fee;
  for (const [, v] of l.earned) atoms += v;
  ok(balance === slotsHeld * SLOT + atoms, `${what}: the NIGHT the contract holds is exactly the bonds, the forfeited penalties, the fees requests hold, unclaimed earnings and dust`);
};
const dl = () => BigInt(now);
const leave = (o) => call('leave', [BigInt(now)], { op: o.op });
const settle = (rid, ps = {}) => call('settle', [rid, { bytes: SETTLER }], ps);
const pendingNow = () => { const p = ledger().pending; return typeof p === 'bigint' ? p : p.read(); };
const active = (o) => ledger().operators.lookup(o.id).active;
const ask = (tag, ps = {}) => call('request', [bytes(tag), BigInt(now), { bytes: REFUND }], ps);
const fin = (rid, s, ps = {}) => call('finalise', [rid, slots(s), { bytes: FINALISER }], ps);
const finish = (e) => call('finish', [e, BigInt(now)]);
const earnedBy = (o) => (ledger().earned.member(o.id) ? ledger().earned.lookup(o.id) : 0n);
// Two contracts the committee might recommend moving to, and a seat naming one.
const NEXT_X = new Uint8Array(32).fill(0xa1), NEXT_Y = new Uint8Array(32).fill(0xa2), NONE = hexOf(new Uint8Array(32));
const name = (e, i, to, ps = {}) => call('recommend', [BigInt(i), { bytes: to }], { op: seated(e)[i - 1]?.op ?? rand(), ...ps });
/** Open the next epoch once the serving one has served its length. */
const open = async () => { if (ledger().current > 0n && ledger().opened === ledger().current) now += Number(EPOCH); return call('openEpoch', [dl()]); };

// ---- how wide is the pad on a dealt share? (it should cover a share: 252 bits)
{
  let widest = 0;
  for (let k = 1n; k <= 400n; k++) widest = Math.max(widest, P.pureCircuits.padOf(G(k), k, 1n, 2n).toString(2).length);
  console.log(`note  the widest of 400 pads is ${widest} bits (a share is up to ${r.toString(2).length} bits, the field ${fp.toString(2).length})`);
}

// ---- what the contract refuses to be deployed with
await fails(init({ miss: 0n }), /at least one slot/, "a contract can't be deployed with a free miss");
await fails(init({ bounty: FEE }), /half the fee/, 'or with a bounty that leaves the seats nothing');
await fails(init({ ceremony: 600n }), /thirty times the slack/, 'or with a ceremony too short to deal in');
await fails(init({ house: [H[0].id, H[1].id, H[2].id, H[0].id] }), /four different operators/, 'or without four different house operators');

// ---- the pool list: loaded after deploy, and only as committed
await fails(loadPools(BATCHES[1]), /not the next batch/, "a batch that isn't the next one of the list the contract was deployed with is refused");
await fails(loadPools({ ids: [UNLISTED.id, ...BATCHES[0].ids.slice(1)], next: BATCHES[0].next }), /not the next batch/, 'and so is one with another key slipped in');
await loadPools(BATCHES[0]);
ok(ledger().listed.member(POOLS[0].id) && !ledger().listed.member(POOLS[8].id) && !ledger().listed.member(UNLISTED.id), 'anyone loads the next batch of the list: its eight pool keys are now in the ledger');

// ---- the registry
await fails(ask('too early'), /no committee is serving/, 'no request before a committee serves');
await fails(call('openEpoch', [dl()]), /not enough house operators/, "no committee can open with nobody registered");
await fails(register(H[0], 9n), /below the minimum/, 'a bond below the minimum is refused');
for (const h of H) await register(h, 20n);
await fails(register(H[0]), /already registered/, 'an operator registers once');
ok(ledger().houseActive === 4n && ledger().independents === 0n && ledger().ringNext.lookup(0n) === 0n, 'the four keys named at deploy register as the house, and the house has no place in the ring');
books('after registering');

// ---- epoch 1: nobody independent, so 1 of 1, a house seat (today's single oracle)
await fails(call('openEpoch', [BigInt(now) + 1000n]), /isn't the time now/, 'whoever opens an epoch gives the time now, and no other');
const e1 = await open();
ok(ledger().committees.lookup(e1).dealBy === BigInt(now) + CEREMONY, "the seats must be filled within one fixed ceremony length: nobody chooses the deadline");
ok(ledger().committees.lookup(e1).n === 1n && ledger().committees.lookup(e1).t === 1n, 'with no independents the committee is 1 of 1');
await fails(call('openEpoch', [dl()]), /still running/, 'no new epoch while a ceremony is running');
await fails(leave(H[3]), /being seated/, 'nobody leaves while a committee is being seated');
now += 300;
await fill(e1);
ok(names(e1) === 'h0' && ledger().committees.lookup(e1).dealBy === BigInt(now) + CEREMONY, 'the first house operator in turn takes the seat (nobody picks which), and dealing has its own ceremony length from the moment the last seat is taken');
await fails(seat(e1), /isn't seating/, 'a full committee takes no more seats');
const p1 = await deal(e1, [1]);
await fails(call('finish', [e1, BigInt(now) + 1000n]), /isn't the time now/, "finish must be given the time now");
ok((await finish(e1)) === true && ledger().current === 1n && ledger().committees.lookup(e1).since === BigInt(now), 'epoch 1 serves once its one dealer has finished');
await fails(call('openEpoch', [dl()]), /isn't over/, 'the next epoch opens only once the serving one has served its length');
const sk1 = sharesOf(e1, p1);
ok(eq(shareKeyOnChain(1n, 1), G(sk1[0])), "its share key on chain is its share's");
await everySubset(e1, p1, sk1, 'draw 1');
ok(pendingNow() === 0n, 'a request finalised with its answers in time no longer counts as open');
const old = await ask('draw 1b');
await call('answer', [old, 1n], { sk: sk1[0] });
const oldExpected = P.pureCircuits.outputOf(rt.ecMul(ledger().requests.lookup(old).point, mod(D * p1.get(1)[0])));

// ---- epoch 2: two independents, so 3 of 5: they sit first, the house fills three seats
const A = independent('a'), B = independent('b');
{
  // the stake pool link, on a copy of the state (so the epochs below start as before)
  const before = snapshot(), t0 = now;
  await call('register', [{ bytes: A.payout }, 12n, 0n], { op: A.op });
  ok(active(A) && !ledger().ringOp.member(1n) && ledger().independents === 0n, 'an operator that registers with no stake pool behind it is not an independent, and has no place in the ring');
  await fails(link(H[0], POOLS[6]), /need no pool/, "the house's operators take no pool");
  await fails(link(B), /not a registered operator/, 'a pool links only a registered operator');
  await fails(link(A, UNLISTED), /isn't on this contract's list/, "a key that isn't on the contract's list of stake pools is refused, whatever it signs");
  await fails(link(A, POOLS[8]), /isn't on this contract's list/, "a listed key whose batch isn't loaded yet has to wait for it");
  await loadPools(BATCHES[1]);
  ok(ledger().listed.member(POOLS[8].id), 'the last batch completes the list');
  await fails(loadPools(BATCHES[1]), /whole list is loaded/, 'and nothing can be added after it');
  await fails(link(A, A.pool, signed(POOLS[1], linkMessage(A, A.pool))), /didn't sign/, "a listed pool's key with another key's signature is refused");
  await fails(link(A, A.pool, signed(A.pool, linkMessage(B, A.pool))), /didn't sign/, 'and its signature for another operator');
  const first = signed(A.pool, linkMessage(A, A.pool));
  await link(A, A.pool, first);
  ok(linked(A) && hexOf(ledger().ringOp.lookup(1n)) === hexOf(A.id) && ledger().independents === 1n && hexOf(ledger().poolOperator.lookup(A.pool.id)) === hexOf(A.id), "once a listed pool's key has signed for it, the operator is an independent and takes its pool's place in the ring: the pool's place in the list");
  ok(eq(ledger().poolKeys.lookup(A.pool.id), A.pool.key), "the pool's key is on chain for anyone to look up on Cardano");
  await fails(link(A, POOLS[1]), /is linked to a pool/, 'an operator is linked once');
  await call('register', [{ bytes: B.payout }, 12n, 0n], { op: B.op });
  await fails(link(B, A.pool), /still active/, 'a pool backs one operator at a time');
  await fails(link(B, POOLS[2], signed(POOLS[2], linkMessage(B, POOLS[2])), 0n), /place before this pool's/, "an operator can't be put anywhere in the ring but its pool's place");
  await fails(link(B, POOLS[2], signed(POOLS[2], linkMessage(B, POOLS[2])), 7n), /isn't a place in the ring/, 'nor after a place nobody holds');
  await fails(revoke(A, A.pool, signed(A.pool, linkMessage(A, A.pool))), /didn't sign/, "a pool's signature to link isn't one to revoke");
  await fails(revoke(B, A.pool), /doesn't back this operator/, 'a pool revokes only the operator it backs');
  await revoke(A);
  ok(!active(A) && !linked(A) && ledger().independents === 0n, "the pool's key revokes its operator: it is stood down, is no longer linked and no longer counts");
  await fails(revoke(A), /doesn't back this operator/, 'once');
  await fails(link(B, A.pool), /pool sits out/, "the pool can't move to a fresh key straight away: it sits out two epoch lengths");
  await fails(call('register', [{ bytes: A.payout }, 0n, 0n], { op: A.op }), /sits out/, 'and the operator it revoked sits out as long');
  now += 2 * Number(EPOCH);
  await call('register', [{ bytes: A.payout }, 0n, 0n], { op: A.op });
  ok(active(A) && !linked(A) && ledger().independents === 0n, 'after the sit-out the revoked operator can register again, but it has no pool');
  await fails(link(B, A.pool, signed(A.pool, P.pureCircuits.linkMessageOf(SELF(), B.id, 0n, false))), /didn't sign/, "a pool's next link signs its next number");
  await link(B, A.pool);
  ok(linked(B) && !linked(A) && ledger().poolLinks.lookup(A.pool.id) === 3n && ledger().independents === 1n, "and the pool can back another operator, whatever the one it revoked is doing: it can't hold the pool");
  await fails(link(A, A.pool, first), /still active/, "and the pool's old signature doesn't bring it back");
  now = t0;
  restore(before);
}
await register(A);
await register(B);
ok(ledger().independents === 2n && ledger().ringNext.lookup(1n) === 2n && ledger().ringNext.lookup(2n) === 0n, 'a and b stand in the ring in the order of their pools in the list');
const e2 = await open();
{
  const c = ledger().committees.lookup(e2);
  ok(c.n === 5n && c.t === 3n && c.indepSeats === 2n, 'with 1 to 3 independents the committee is 3 of 5, with a seat for each independent');
}
await fill(e2);
ok(names(e2) === 'a b h1 h2 h3', 'the independents sit first, in ring order, then the house, taking up its turn where it left off');
{
  const who = seated(e2);
  const a = Array.from({ length: 4 }, (_, k) => (k < 3 ? rand() : 0n));
  await fails(call('dealCommit', [e2, 1n, a.map(G)], { op: who[1].op, a }), /not this position's holder/, "only a position's operator deals for it");
  await fails(call('dealCommit', [e2, 1n, [G(a[0]), G(a[1]), G(rand()), ID]], { op: who[0].op, a }), /not this coefficient/, "a commitment the dealer doesn't know the number of can't be posted");
  await fails(call('dealCommit', [e2, 1n, [G(a[0]), G(a[1]), G(a[2]), G(1n)]], { op: who[0].op, a }), /past the threshold/, 'nor a polynomial of too high a degree');
}
const p2 = await deal(e2, [1, 2, 3, 4]); // position 5 (h3) never finishes dealing
await fails(call('dealShare', [e2, 1n, 2n], { s: at(p2.get(1), 2) }), /already sent/, 'a parcel is sent once');
{
  // h3 posts its commitments, then tries a wrong share, and stops there
  const a = Array.from({ length: 4 }, (_, k) => (k < 3 ? rand() : 0n));
  await call('dealCommit', [e2, 5n, a.map(G)], { op: seated(e2)[4].op, a });
  await fails(call('dealCommit', [e2, 5n, a.map(G)], { op: seated(e2)[4].op, a }), /has dealt/, 'a position posts its commitments once');
  await fails(call('dealShare', [e2, 5n, 2n], { s: mod(at(a, 2) + 1n) }), /not this dealer's share/, "a wrong share can't be posted");
  await fails(call('dealShare', [e2, 5n, 2n], { s: at(a, 3) }), /not this dealer's share/, "nor another position's share");
}
await fails(finish(e2), /deadline hasn't passed/, "a ceremony with a dealer missing can't finish before its deadline");
now += 1801;
ok((await finish(e2)) === true && ledger().current === 2n, 'past the deadline, 4 finished dealers of 5 are enough: epoch 2 serves');
ok(bond(H[3]) === 18n && ledger().forfeited === 2n && bond(H[0]) === 20n, 'the seat that did not deal forfeits the ceremony penalty, though the ceremony succeeded');
ok(!active(H[3]) && ledger().houseActive === 3n, 'and being a house operator, it is stood down');
await register(H[3], 0n);
ok(active(H[3]) && ledger().houseActive === 4n, 'a house operator registers again at once (it has no sit-out)');
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
  ok(balance === before + FEE && ledger().requests.lookup(rid).deadline === BigInt(now) + ANSWER, 'a request pays the fee into the contract, and the committee has one fixed answering time: the requester does not choose it');
  ok(hexOf(rid) !== hexOf(r2.rid), 'the same requester again gets a new id (the counter)');
  ok(pendingNow() === MAXP, 'three requests are open');
  await fails(ask('one too many'), /too many requests/, 'only so many requests can be open at once');
  await fails(call('answer', [rid, 3n], { sk: sk2[3] }), /not this position's share/, "a position can't answer with another position's share");
  await fails(call('answer', [rid, 3n], { sk: rand() }), /not this position's share/, 'or with any other secret');
  await call('answer', [rid, 1n], { sk: sk2[0] });
  await call('answer', [rid, 2n], { sk: sk2[1] });
  await fails(fin(rid, [1, 2, 3]), /a share is missing/, 'two answers of three are not enough');
  await fails(settle(rid), /deadline has not passed/, "a request can't be settled before its deadline");
  now += 601;
  const req = ledger().requests.lookup(rid);
  const groupSk = mod([...p2.values()].reduce((s, a) => s + a[0], 0n));
  await call('answer', [rid, 5n], { sk: sk2[4] }); // too late
  const bounties = paid(FINALISER);
  const out = await fin(rid, [1, 2, 5]);
  ok(Buffer.from(out).equals(Buffer.from(P.pureCircuits.outputOf(rt.ecMul(req.point, mod(D * groupSk))))), 'a request answered late gives the value it always had: silence buys no second roll');
  ok(paid(FINALISER) === bounties && pendingNow() === MAXP, 'finalised late it pays no bounty (its fee is owed back), and still counts as open until it is settled');
  await settle(rid);
  ok(ledger().requests.lookup(rid).voided === true && paid(REFUND) === FEE && paid(SETTLER) === 0n && pendingNow() === MAXP - 1n, 'with fewer than three answers in time the request is void: the requester gets the whole fee back, whoever settles it in the first answering time after the deadline, and nothing more');
  ok(bond(H[1]) === 19n && bond(H[2]) === 19n && bond(H[3]) === 17n && bond(A) === 12n && ledger().forfeited === 5n, 'the three seats that did not answer in time each forfeit a slot of bond, to nobody; the two that answered lose nothing');
  await fails(settle(rid), /already settled/, 'a request is settled once');
}
{
  // epoch 2's first request: all five answered in time; it is finalised only now, after its deadline
  const bounties = paid(FINALISER);
  await fin(r2.rid, [1, 2, 3]);
  ok(paid(FINALISER) === bounties + BOUNTY, 'whoever sends finalise is paid the bounty out of the fee');
  await fails(settle(r2.rid, { badQuotient: 1n }), /shared equally/, "the fee can't be shared out unequally");
  await settle(r2.rid);
  const each = (FEE - BOUNTY) / 5n;
  ok(seated(e2).every((o) => earnedBy(o) === each) && ledger().forfeited === 5n, 'the rest of the fee is shared equally by the five seats that answered in time, whoever was combined; forfeited bond goes to nobody');
  await call('claim', [], { op: A.op });
  ok(paid(A.payout) === each && earnedBy(A) === 0n, 'an operator claims what it earned, to its payout address');
  await fails(call('claim', [], { op: A.op }), /nothing to claim/, 'and only once');
}
{
  // three of five answer in time and nobody sends finalise before the deadline: that is not void
  const rid = await ask('draw 2c');
  for (const i of [1, 2, 3]) await call('answer', [rid, BigInt(i)], { sk: sk2[i - 1] });
  now += 601;
  const refunds = paid(REFUND), hadB = earnedBy(B), bonds0 = bond(H[1]);
  await settle(rid);
  const r = ledger().requests.lookup(rid);
  ok(!r.voided && r.fee === BOUNTY && paid(REFUND) === refunds && bond(H[1]) === bonds0 && earnedBy(B) === hadB + (FEE - BOUNTY) / 3n, 'a request with enough answers in time is paid, not void, even before anyone sends finalise: no refund, no bond taken');
  const bounties = paid(FINALISER);
  await fin(rid, [1, 2, 3]);
  ok(paid(FINALISER) === bounties + BOUNTY && ledger().requests.lookup(rid).fee === 0n, 'and its bounty waited for whoever finalised it');
}
{
  // a void request nobody settles for a whole answering time (on a copy of the state)
  const before = snapshot(), t0 = now;
  await fails(ask('wrong time', { badBucket: 1n }), /answering time the deadline falls in/, "a request's answering time is worked out, not chosen");
  const rid = await ask('draw 2d');
  now += 601 + Number(ANSWER);
  const tips = paid(SETTLER), refunds = paid(REFUND);
  await settle(rid);
  ok(paid(SETTLER) === tips + BOUNTY && paid(REFUND) === refunds + FEE - BOUNTY, 'left unsettled for a whole answering time, a void request tips whoever settles it out of its fee, so none waits for ever');
  now = t0;
  restore(before);
}
books('after the fees of epoch 2');
{
  // the recommended successor: epoch 2 (5 seats) names X
  await fails(name(e2, 1, NEXT_X, { op: rand() }), /not this position's holder/, "only a seat's holder names a successor for it");
  await fails(name(e2, 6, NEXT_X), /no such position/, 'and only a seat of the serving committee');
  await fails(name(e2, 1, rt.encodeContractAddress(address)), /that is this contract/, "a contract can't be its own successor");
  for (const i of [1, 2, 3]) await name(e2, i, NEXT_X);
  await fails(name(e2, 1, NEXT_Y), /has named an address/, 'a seat names one address in an epoch');
  ok(ledger().backedEpoch === 0n, 'three seats of five are not two-thirds');
  await name(e2, 4, NEXT_X);
  ok(ledger().backedEpoch === 2n && hexOf(ledger().backed) === hexOf(NEXT_X) && hexOf(ledger().successor) === NONE, "four of five are: X is epoch 2's address, and one epoch recommends nothing yet");
}

// ---- epoch 3: four independents, so 4 of 7. Its ceremony fails, and that costs the seats that didn't deal
const C = independent('c'), Dd = independent('d');
await register(C);
await register(Dd);
const e3 = await open();
{
  const c = ledger().committees.lookup(e3);
  ok(c.n === 7n && c.t === 4n && c.indepSeats === 4n, 'with 4 independents the committee is 4 of 7: four seats for them, three for the house (below the threshold)');
}
await fails(leave(A), /being seated/, "an operator the committee was sized for can't leave while it is being seated");
const F = operator('f');
F.pool = POOLS[7];
await call('register', [{ bytes: F.payout }, 12n, 0n], { op: F.op });
await fails(link(F), /joins the ring while a committee is being seated/, "and nobody can join the ring while it is being seated: a place just after the turn would take a seat the committee wasn't sized for");
{
  // the seats aren't all filled in time (on a copy of the state)
  const before = snapshot(), t0 = now;
  await seat(e3);
  await seat(e3);
  await fails(finish(e3), /deadline hasn't passed/, "a committee still being seated can't be ended before its deadline");
  now += 1801;
  await fails(seat(e3), /seating is over/, 'past the seating deadline no more seats are taken');
  const bonds0 = [C, Dd, A, B].map(bond).join(), lost = ledger().forfeited;
  ok((await finish(e3)) === false && ledger().committees.lookup(e3).phase === P.Phase.failed, 'a committee whose seats were not filled in time fails');
  await open();
  ok([C, Dd, A, B].map(bond).join() === bonds0 && ledger().forfeited === lost, 'and that costs nobody any bond: only dealing can');
  now = t0;
  restore(before);
}
await fill(e3);
ok(names(e3) === 'c d a b h0 h1 h2', 'the turn goes on round the ring from where it stopped: c and d, who had not served, then round to a and b');
await deal(e3, [1, 2, 5]); // c, d and h0 deal; a, b, h1 and h2 don't
now += 1801;
ok((await finish(e3)) === false && ledger().committees.lookup(e3).phase === P.Phase.failed && ledger().current === 2n, 'with 3 finished dealers of 7 (below the threshold) the ceremony fails at its deadline, and epoch 2 carries on');
await fails(finish(e3), /ceremony is over/, 'a ceremony ends once');
ok(bond(A) === 10n && bond(B) === 10n && bond(H[1]) === 17n && bond(H[2]) === 17n && bond(C) === 12n && bond(Dd) === 12n && bond(H[0]) === 20n && ledger().forfeited === 13n, 'the four seats that did not finish dealing each forfeit 2 slots of bond, as soon as the ceremony ends; the three that did lose nothing');
ok(!active(H[1]) && !active(H[2]) && ledger().houseActive === 2n, 'and the two house operators among them are stood down');
{
  // with only two house operators active, 4 of 7 can't be filled (on a copy of the state)
  const before = snapshot();
  const opened = await open();
  const c = ledger().committees.lookup(opened);
  ok(c.n === 5n && c.t === 3n && c.indepSeats === 4n, "when the house can't fill the size the independents call for, the committee is the largest it can: 3 of 5 with four independents, not no epoch at all");
  restore(before);
}
await register(H[1], 0n);
await register(H[2], 0n);
const e4 = await open();
books('after the failed ceremony');
await fill(e4);
ok(names(e4) === 'c d a b h3 h0 h1', 'after a failed ceremony the turn simply goes on round the ring, and the house fills the rest');
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
{
  ok(ledger().previous === 2n, 'the epoch served before epoch 4 is epoch 2 (epoch 3 never served)');
  for (const i of [1, 2, 3, 4]) await name(e4, i, NEXT_X);
  ok(ledger().backedEpoch === 2n && hexOf(ledger().successor) === NONE, 'four seats of seven are not two-thirds');
  await name(e4, 5, NEXT_X);
  ok(ledger().backedEpoch === 4n && hexOf(ledger().successor) === hexOf(NEXT_X) && ledger().successorEpoch === 4n, 'five of seven are: named by two served epochs in a row, X is the recommended successor');
  const before = balance;
  await name(e4, 6, NEXT_Y);
  ok(hexOf(ledger().successor) === hexOf(NEXT_X) && balance === before && ledger().current === 4n, 'a recommendation moves no NIGHT and changes nothing else');
}

{
  // a bond that has fallen below the minimum (on a copy of the state)
  const before = snapshot(), t0 = now;
  const rid = await ask('draw 4c');
  now += 601;
  await settle(rid); // nobody answered: every seat of epoch 4 forfeits a slot, so a and b fall to 9
  ok(bond(A) === 9n && bond(C) === 11n, 'a void request takes a and b below the minimum bond');
  await fails(call('standDown', [C.id, BigInt(now)]), /isn't below the minimum/, "an operator with its bond in order can't be stood down by anyone");
  await call('standDown', [A.id, BigInt(now)]);
  ok(!active(A) && !ledger().ringOp.member(1n) && ledger().independents === 3n, 'anyone can stand down an operator whose bond is below the minimum: it leaves the ring until it has made its bond up and sat out');
  await fails(call('standDown', [A.id, BigInt(now)]), /isn't active/, 'once');
  now = t0;
  restore(before);
}

// ---- leaving, the ring, and taking the bond back
await leave(Dd);
await fails(leave(Dd), /already left/, 'an operator leaves once');
await fails(call('withdraw', [12n], { op: Dd.op }), /one epoch length/, "an operator that left can't take its bond straight away");
await fails(call('withdraw', [3n], { op: C.op }), /keeps the minimum/, 'an active operator keeps the minimum bond');
await call('withdraw', [2n], { op: H[3].op });
ok(bond(H[3]) === 15n && paid(H[3].payout) === 2n * SLOT, 'bond above the minimum comes back to the payout address');
await call('topUp', [H[3].id, 2n]);
ok(bond(H[3]) === 17n, 'anyone can add bond to an operator');
const E = independent('e');
await register(E);
await leave(E);
ok(ledger().independents === 3n, 'd and e have left: three independents');
{
  // d left but still sits in the serving committee: its bond stays behind its seat (on a copy)
  const before = snapshot(), t0 = now;
  now += Number(EPOCH);
  await fails(call('withdraw', [12n], { op: Dd.op }), /serving seat keeps its bond/, 'a seat of the serving committee keeps its bond behind it, however long ago its operator left');
  now += 3 * Number(EPOCH) + 1;
  await fails(ask('too late'), /overstayed/, 'a committee that has served four epoch lengths takes no more requests: a new epoch must open');
  now += 4 * Number(ANSWER);
  await call('withdraw', [12n], { op: Dd.op });
  ok(bond(Dd) === 0n, 'and once it has overstayed and its last requests could be settled, its seats get their bonds back: a bond is never stuck');
  now = t0;
  restore(before);
}
const e5 = await open();
{
  const c = ledger().committees.lookup(e5);
  ok(c.n === 5n && c.t === 3n && c.indepSeats === 3n, 'with 3 independents the committee is 3 of 5 again: three seats for them, two for the house');
}
ok(!ledger().ringOp.member(4n) && !ledger().ringOp.member(5n) && ledger().ringNext.lookup(3n) === 0n, 'd and e, who left, are no longer in the ring: there is nothing to pass over');
await seat(e5);
ok(ledger().committees.lookup(e5).seated === 1n && ledger().cursor === 3n, "the turn goes on to c");
await fill(e5);
ok(names(e5) === 'c a b h2 h3', 'd, who left while serving, is not seated again; the rest keep their order');
const p5 = await deal(e5, [1, 2, 3, 4, 5]);
ok((await finish(e5)) === true, 'epoch 5 serves');
const sk5 = sharesOf(e5, p5);
await everySubset(e5, p5, sk5, 'draw 5');
await fails(call('withdraw', [12n], { op: Dd.op }), /requests can be settled/, "d's committee has been replaced, but its bond waits until that committee's last requests could be settled");
{
  // requests that c and a (positions 1 and 2) don't answer in time, over four answering times
  const had = earnedBy(B), hadC = earnedBy(C), lost = ledger().forfeited;
  const round = async (tags) => {
    const rids = [];
    for (const tag of tags) {
      const rid = await ask(tag);
      for (const i of [3, 4, 5]) await call('answer', [rid, BigInt(i)], { sk: sk5[i - 1] });
      await fin(rid, [3, 4, 5]);
      rids.push(rid);
    }
    now += 601;
    return rids;
  };
  for (const rid of await round(['draw 5v', 'draw 5w'])) await settle(rid);
  ok(ledger().missed.lookup(C.id) === 1n && ledger().missed.lookup(A.id) === 1n, 'two requests missed in the same answering time count as one miss: a burst of requests can\'t stand a seat down');
  const [x] = await round(['draw 5x']), [y] = await round(['draw 5y']), [last] = await round(['draw 5z']);
  await call('answer', [last, 1n], { sk: sk5[0] }); // c, too late
  for (const rid of [last, y, x]) await settle(rid); // settled latest first: the order makes no difference
  ok(earnedBy(B) === had + 5n * ((FEE - BOUNTY) / 3n) && ledger().forfeited === lost && ledger().dust === 0n, 'each fee is shared by the three seats that answered in time; a paid request takes no bond');
  ok(earnedBy(C) === hadC, 'an answer after the deadline earns nothing');
  ok(ledger().missed.lookup(C.id) === 4n && ledger().missed.lookup(A.id) === 4n && ledger().missed.lookup(B.id) === 0n, 'a miss is counted, once per answering time and in whatever order the requests are settled, against each seat that did not answer in time');
  await call('claim', [], { op: B.op });
  ok(paid(B.payout) === had + 5n * ((FEE - BOUNTY) / 3n), 'b claims its fees');
}
books('after the fees of epoch 5');
for (const i of [1, 2, 3, 4]) await name(e5, i, NEXT_Y);
ok(ledger().backedEpoch === 5n && hexOf(ledger().backed) === hexOf(NEXT_Y) && hexOf(ledger().successor) === hexOf(NEXT_X), 'epoch 5 names Y instead: one epoch does not replace the recommendation');
await call('withdraw', [12n], { op: Dd.op });
ok(bond(Dd) === 0n && paid(Dd.payout) === 12n * SLOT, 'once they could be, d takes its whole bond back');
await fails(call('withdraw', [1n], { op: Dd.op }), /not that much bond/, 'and no more than it has');
{
  // a lone independent, and a house operator away (on a copy of the state)
  const before = snapshot(), t0 = now;
  await leave(H[0]);
  const opened = await open();
  const c = ledger().committees.lookup(opened);
  ok(ledger().independents === 1n && ledger().houseActive === 3n && c.n === 1n && c.indepSeats === 0n, 'one independent needs four house operators for 3 of 5; with three, the committee falls back to 1 of 1 and the epoch still opens');
  now = t0;
  restore(before);
}
const e6 = await open();
ok(!ledger().operators.lookup(C.id).active && !ledger().operators.lookup(A.id).active && ledger().independents === 1n && ledger().houseActive === 4n, 'c and a missed more requests than a term allows: they are stood down when the next epoch opens');
await fails(register(C, 0n), /sits out/, 'a stood-down operator sits out before it can register again');
const X = operator('x');
await call('register', [{ bytes: X.payout }, 12n, 0n], { op: X.op });
await fails(link(X, C.pool), /pool sits out/, "and its pool can't simply back a fresh key: the pool sits out too");
await fill(e6);
ok(names(e6) === 'b h0 h1 h2 h3', 'the house fills the seats they left');
const p6 = await deal(e6, [1, 2, 3, 4, 5]);
ok((await finish(e6)) === true && ledger().current === 6n, 'epoch 6 serves');
for (const i of [1, 2, 3, 4]) await name(e6, i, NEXT_Y);
ok(hexOf(ledger().successor) === hexOf(NEXT_Y) && ledger().successorEpoch === 6n, 'epoch 6 names Y too: now Y is the recommended successor');
await register(Dd);
ok(ledger().operators.lookup(Dd.id).active && ledger().independents === 2n && ledger().ringNext.lookup(2n) === 4n, 'd, who left more than two epoch lengths ago, can rejoin with a fresh bond, at its pool\'s place in the ring');
{
  // only so many requests can be open at once; one finalised in time frees its place
  const sk6 = sharesOf(e6, p6);
  let last, n = 0;
  while (pendingNow() < MAXP) last = await ask(`fill ${n++}`);
  await fails(ask('one too many'), /too many requests/, 'with the open requests at their limit, another is refused');
  for (const i of [1, 2, 3]) await call('answer', [last, BigInt(i)], { sk: sk6[i - 1] });
  await fin(last, [1, 2, 3]);
  await ask('room again');
  ok(pendingNow() === MAXP, 'once one of them has its answers and is finalised, there is room for another');
}

// ---- a ring larger than a committee: nine independents, seven seats
await loadPools(BATCHES[1]);
everyone.set(hexOf(F.id), F);
const more = [[5, 'p6'], [6, 'p7'], [8, 'p9'], [9, 'p10'], [10, 'p11'], [11, 'p12']].map(([k, name]) => { const o = operator(name); o.pool = POOLS[k]; everyone.set(hexOf(o.id), o); return o; });
await link(F);
await call('register', [{ bytes: more[2].payout }, 12n, 0n], { op: more[2].op });
await fails(link(more[2], more[2].pool, signed(more[2].pool, linkMessage(more[2], more[2].pool)), 4n), /place before this pool's/, "a place that is in the ring but isn't the one just before the pool's is refused too");
await link(more[2]);
for (const o of more) if (o !== more[2]) await register(o);
const ringOrder = () => { const out = []; for (let k = ledger().ringNext.lookup(0n); k !== 0n; k = ledger().ringNext.lookup(k)) out.push(Number(k)); return out.join(' '); };
ok(ringOrder() === '2 4 6 7 8 9 10 11 12' && ledger().independents === 9n, 'nine independents stand in the ring in the order of their pools in the list, whatever order they joined in');
const e7 = await open();
{
  const c = ledger().committees.lookup(e7);
  ok(c.n === 7n && c.t === 4n && c.indepSeats === 7n, 'from seven independents the committee is 4 of 7 with no seat for the house');
}
await fill(e7);
ok(names(e7) === 'd p6 p7 f p9 p10 p11' && ledger().cursor === 11n, 'the turn goes on from b, who sat last: the next seven round the ring, and two wait');
await deal(e7, [1, 2, 3, 4, 5, 6, 7]);
ok((await finish(e7)) === true && ledger().current === 7n, 'epoch 7 serves');
await leave(more[4]);
ok(ledger().cursor === 10n && !ledger().ringOp.member(11n) && ringOrder() === '2 4 6 7 8 9 10 12', 'when the operator that sat last leaves the ring, the turn stays where it was');
const e8 = await open();
await fill(e8);
ok(names(e8) === 'p12 b d p6 p7 f p9' && ledger().cursor === 9n, 'the next committee starts with the two that waited, then goes round past the start of the list: everyone sits in turn, and nobody twice in one committee');
books('at the end');
console.log(`${checks} checks passed`);
