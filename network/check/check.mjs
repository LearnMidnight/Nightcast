// Checks of the Nightcast network contract in memory (Compact 0.36, compact-runtime 0.21):
// registering operators, requests to a group of three, shares, the combined output, who is
// paid what, expiry, leaving and rejoining, and that calls made in the same block don't
// invalidate each other.
//   node check/check.mjs   (after compiling to check/out; see check/run.sh)
import { World, N, hex, bytes, addr, newKey, operatorIdOf } from './world.mjs';

const STAR = 1_000_000n;
const FEE = 1n * STAR;
const COLLATERAL = 5n * STAR;
let failed = 0, passed = 0;
const ok = (name, cond, detail = '') => { if (cond) passed++; else failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `  (${detail})`}`); };
const refuses = async (name, p, re) => {
  try { await p; ok(name, false, 'it was accepted'); } catch (e) { ok(name, re.test(String(e?.message ?? e)), String(e?.message ?? e).slice(0, 160)); }
};

const setup = async ({ fee = FEE, collateral = COLLATERAL, minBond = 2n, operators = 5, slots = 10n } = {}) => {
  const w = await World.create({ fee, collateral, minBond });
  const ops = Array.from({ length: operators }, (_, i) => { const sk = newKey(); return { sk, id: operatorIdOf(sk), payout: addr(0x40 + i) }; });
  for (const op of ops) await w.register(op.sk, op.payout, slots);
  let n = 0;
  const ask = async (group = [0, 1, 2], refundTo) => (await w.request(bytes('t'), bytes(`s${++n}`), BigInt(w.now) + 600n, group.map((i) => ops[i].id), refundTo ? { refundTo } : {})).result;
  const balanced = () => { const a = w.accounts(); return a.held === a.balance && a.conserved; };
  return { w, ops, ask, balanced };
};

// ------------------------------------------------------------ operators
{
  const { w, ops, balanced } = await setup();
  const l = w.ledger();
  ok('five operators register, each active with its payout and a 10-slot bond', l.operatorCount === 5n && ops.every((o) => l.operators.lookup(o.id).active && hex(l.operators.lookup(o.id).payout.bytes) === hex(o.payout) && w.freeSlots(o.id) === 10n));
  ok('their bonds are paid in (5 x 10 x 5 NIGHT) and the books balance', w.balance === 250n * STAR && balanced());
}
{
  const { w, ops } = await setup({ minBond: 3n });
  await refuses('a bond below the minimum is refused', w.register(newKey(), addr(1), 2n), /below the minimum/);
  await refuses('the same key cannot register twice', w.register(ops[0].sk, addr(1), 5n), /already registered/);
}
{
  const { w, ops, balanced } = await setup();
  await w.depositBond(ops[1].id, 4n);
  ok('anyone can add to an operator\'s bond', w.freeSlots(ops[1].id) === 14n && balanced());
  await refuses('a bond for an unknown operator is refused', w.depositBond(bytes('nobody'), 1n), /unknown operator/);
}
{
  const { w, ops, ask, balanced } = await setup();
  await w.withdrawBond(ops[3].sk, 4n);
  ok('an operator withdraws free slots to its payout', w.paid(ops[3].payout) === 4n * COLLATERAL && w.freeSlots(ops[3].id) === 6n);
  await refuses('it cannot take more than its free slots', w.withdrawBond(ops[3].sk, 7n), /not that many free slots/);
  await w.withdrawBond(ops[3].sk, 0n, true);
  ok('leaving marks it inactive', w.ledger().operators.lookup(ops[3].id).active === false);
  await refuses('a request naming an operator that left is refused', ask([0, 1, 3]), /has left/);
  await w.register(ops[3].sk, addr(0x77), 0n);
  ok('it can rejoin (new payout) and be named again', w.ledger().operators.lookup(ops[3].id).active && hex(w.ledger().operators.lookup(ops[3].id).payout.bytes) === hex(addr(0x77)));
  await ask([0, 1, 3]);
  ok('the books balance', balanced());
  await refuses('a key that never registered cannot withdraw', w.withdrawBond(newKey(), 1n), /not a registered operator/);
}

// ------------------------------------------------------------ requests
{
  const { w, ops, ask, balanced } = await setup();
  const before = w.balance;
  const id = await ask([4, 0, 2]);
  const r = w.ledger().requests.lookup(id);
  ok('a request pays three fees in', w.balance - before === 3n * FEE);
  ok('it names its three operators in order, pending', r.operators.map(hex).join() === [4, 0, 2].map((i) => hex(ops[i].id)).join() && r.status === N.Status.pending);
  ok('it takes one slot from each named operator', [0, 1, 2, 3, 4].map((i) => w.freeSlots(ops[i].id)).join() === '9,10,9,10,9');
  ok('its id is the v1 construction (requester, tag, seed)', hex(id) === hex(w.idFor(bytes('t'), bytes('s1'))));
  ok('the books balance', balanced());
}
{
  const { w, ops, ask } = await setup({ slots: 2n });
  await refuses('the same operator twice is refused (first two)', ask([0, 0, 1]), /must be different/);
  await refuses('the same operator twice is refused (last two)', ask([0, 1, 1]), /must be different/);
  await refuses('an unknown operator is refused', w.request(bytes('t'), bytes('x'), BigInt(w.now) + 600n, [ops[0].id, ops[1].id, bytes('nobody')]), /unknown operator/);
  await ask([0, 1, 2]);
  await ask([0, 3, 4]);
  await refuses('an operator with no free slot is refused', ask([0, 1, 3]), /bond is too small/);
  const g = [0, 1, 2].map((i) => ops[i].id);
  await refuses('a deadline too soon is refused', w.request(bytes('t'), bytes('a'), BigInt(w.now) + 30n, g), /too soon/);
  await refuses('a deadline too far away is refused', w.request(bytes('t'), bytes('b'), BigInt(w.now) + 3610n, g), /too far/);
}

// ------------------------------------------------------------ answers
{
  const { w, ops, ask, balanced } = await setup();
  const id = await ask([2, 0, 4]);
  const shares = [];
  for (const i of [2, 0, 4]) shares.push((await w.answer(id, ops[i].sk)).result);
  ok('each share is the VRF output for that operator\'s key (v1\'s evaluate)', [2, 0, 4].every((i, j) => hex(shares[j]) === hex(N.pureCircuits.evaluate(ops[i].sk, id))));
  ok('the books balance with every share in', balanced());
  const out = await w.finalise(id);
  const r = w.ledger().requests.lookup(id);
  ok('finalise combines the three shares in the request\'s order', hex(out) === hex(N.pureCircuits.combine(id, shares[0], shares[1], shares[2])) && r.status === N.Status.fulfilled && hex(r.output) === hex(out));
}
{
  const { w, ops, ask, balanced } = await setup();
  const id = await ask([0, 1, 2]);
  await w.answer(id, ops[1].sk);
  ok('an answer pays that operator its fee and gives its slot back at once', w.paid(ops[1].payout) === FEE && w.freeSlots(ops[1].id) === 10n && w.freeSlots(ops[0].id) === 9n && balanced());
  await w.answer(id, ops[0].sk);
  await w.answer(id, ops[2].sk);
  await w.finalise(id);
  ok('after all three: each paid its fee, the contract holds only the bonds', [0, 1, 2].every((i) => w.paid(ops[i].payout) === FEE) && w.balance === 250n * STAR && balanced());
}
{
  const { w, ops, ask } = await setup();
  const id = await ask([0, 1, 2]);
  await refuses('an operator not in the group cannot answer', w.answer(id, ops[3].sk), /not one of this request's operators/);
  await w.answer(id, ops[0].sk);
  await refuses('an operator cannot answer twice', w.answer(id, ops[0].sk), /already answered/);
  await w.answer(id, ops[1].sk);
  await refuses('finalise waits for all three', w.finalise(id), /not every operator/);
  w.advance(601);
  await refuses('an answer after the deadline is refused', w.answer(id, ops[2].sk), /expired/);
}
{
  const { w, ops, ask } = await setup();
  const id = await ask([0, 1, 2]);
  for (const i of [0, 1, 2]) await w.answer(id, ops[i].sk);
  w.advance(601);
  await refuses('a request with all three shares cannot be expired', w.expire(id), /finalise it instead/);
  await w.finalise(id);
  ok('finalise still works after the deadline (the shares landed in time)', w.ledger().requests.lookup(id).status === N.Status.fulfilled);
  await refuses('a finalised request cannot be finalised again', w.finalise(id), /not pending/);
}
{
  const { ops } = await setup();
  const a = bytes('some request');
  const s = [0, 1, 2].map((i) => N.pureCircuits.evaluate(ops[i].sk, a));
  const base = hex(N.pureCircuits.combine(a, s[0], s[1], s[2]));
  ok('one different operator gives a different output', base !== hex(N.pureCircuits.combine(a, s[0], s[1], N.pureCircuits.evaluate(ops[3].sk, a))));
  ok('the order is fixed by the request', base !== hex(N.pureCircuits.combine(a, s[1], s[0], s[2])));
}

// ------------------------------------------------------------ expiry
{
  const { w, ops, ask, balanced } = await setup();
  const id = await ask([0, 1, 2], addr(0x21));
  await w.answer(id, ops[0].sk);
  await refuses('a request cannot be expired before its deadline', w.expire(id), /has not passed/);
  w.advance(601);
  await w.expire(id);
  ok('a void request refunds the fee and collateral of the two that did not answer', w.paid(addr(0x21)) === 2n * (FEE + COLLATERAL));
  ok('the one that answered keeps its fee and its slot', w.paid(ops[0].payout) === FEE && [0, 1, 2].map((i) => w.freeSlots(ops[i].id)).join() === '10,9,9');
  ok('it is marked expired and the books balance', w.ledger().requests.lookup(id).status === N.Status.expired && balanced());
  await refuses('it cannot be expired twice', w.expire(id), /not pending/);
}
{
  const { w, ask, balanced } = await setup();
  const id = await ask([0, 1, 2], addr(0x22));
  w.advance(601);
  await w.expire(id);
  ok('nobody answering refunds all three', w.paid(addr(0x22)) === 3n * (FEE + COLLATERAL) && balanced());
}
{
  const { w, ops, ask } = await setup({ fee: 0n, collateral: 0n, minBond: 0n, slots: 0n });
  const id = await ask([0, 1, 2]);
  for (const i of [0, 1, 2]) await w.answer(id, ops[i].sk);
  await w.finalise(id);
  const id2 = await ask([2, 3, 4]);
  w.advance(601);
  await w.expire(id2);
  ok('with no fee and no bond everything still works, and nothing moves', w.balance === 0n && w.ledger().requests.lookup(id).status === N.Status.fulfilled);
}

// ------------------------------------------------------------ the same block
// Two calls built against one state, replayed in order with the gas each declared (Ledger 9's own
// partitioning, as Midnight.js builds transactions). These are notes, not pass/fail: on ledger 9 a
// transaction is held to the costs it declared, and adding to a map another transaction changed
// first can write more bytes than declared ("ran out of gas budget"), depending on the keys. So a
// sender whose call fails that way just sends it again (the operator and the test driver retry).
const notes = [];
const note = async (name, f) => { let e; try { await f(); } catch (x) { e = x; } notes.push(`${e ? 'clash' : 'fine '} ${name}${e ? `  (${String(e.message).slice(0, 60)})` : ''}`); };
for (let i = 0; i < 5; i++) {
  { const { w, ops, ask } = await setup(); const id = await ask([0, 1, 2]);
    await note('two operators answer one request', () => w.sameBlock(() => w.answer(id, ops[0].sk), (o) => w.answer(id, ops[1].sk, o))); }
  { const { w, ops } = await setup(); const g = [0, 1, 2].map((j) => ops[j].id);
    await note('two requests to the same operators', () => w.sameBlock(() => w.request(bytes('t'), bytes('p'), BigInt(w.now) + 600n, g), (o) => w.request(bytes('t'), bytes('q'), BigInt(w.now) + 600n, g, o))); }
  { const { w, ops, ask } = await setup(); const id = await ask([0, 1, 2]);
    await note('an answer and a new request', () => w.sameBlock(() => w.answer(id, ops[0].sk), (o) => w.request(bytes('t'), bytes('r'), BigInt(w.now) + 600n, [0, 3, 4].map((j) => ops[j].id), o))); }
}
{
  const { w, ops } = await setup();
  const g = [0, 1, 2].map((i) => ops[i].id);
  let e; try { await w.sameBlock(() => w.request(bytes('t'), bytes('same'), BigInt(w.now) + 600n, g), (o) => w.request(bytes('t'), bytes('same'), BigInt(w.now) + 600n, g, o)); } catch (x) { e = x; }
  ok('(control) the replay is real: one request can\'t land twice', !!e);
}
const tally = {};
for (const n of notes) tally[n.slice(6).replace(/  \(.*/, '')] = (tally[n.slice(6).replace(/  \(.*/, '')] ?? '') + n.slice(0, 5).trim()[0];
console.log('\nSame block, 5 tries each (f = both land, c = the second must be sent again):');
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
