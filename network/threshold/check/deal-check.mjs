// Run the deal probe in memory (compact-runtime): a dealer proves its commitments and each
// encrypted share as it posts them; each position opens its parcel; cheating can't be posted.
// The edge cases at the end only REPORT what the runtime does (they don't pass or fail).
import { webcrypto } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as P from './out-deal/contract/index.js';

const r = rt.JUBJUB_SCALAR_MODULUS;
const p = 52435875175126190479447740508185965837690552500527637822603658699938581184513n; // the proof system's field
const mod = (a, m = r) => ((a % m) + m) % m;
const rand = () => mod(BigInt('0x' + Buffer.from(webcrypto.getRandomValues(new Uint8Array(40))).toString('hex')));
const N = 7, T = 4;
const COIN = '0'.repeat(64);
let checks = 0;
const ok = (c, what) => { if (!c) throw new Error(`FAILED: ${what}`); checks++; console.log(`ok  ${what}`); };
const fails = async (pr, re, what) => { try { await pr; } catch (e) { ok(re.test(String(e?.message ?? e)), `${what} (${String(e?.message ?? e).slice(0, 80)})`); return; } ok(false, `${what}: did not fail`); };

const witnesses = {
  coefficients: ({ privateState }) => [privateState, privateState.a],
  shareFor: ({ privateState }) => [privateState, privateState.s],
  ephemeral: ({ privateState }) => [privateState, privateState.e],
  encSecret: ({ privateState }) => [privateState, privateState.ek],
};
const contract = new P.Contract(witnesses);
const address = rt.sampleContractAddress();
let state = (await contract.initialState(rt.createConstructorContext({}, COIN))).currentContractState;
const call = async (circuit, args, ps = {}) => {
  const ctx = rt.createCircuitContext({ circuitId: circuit, contractAddress: address, coinPublicKeyOrZswapState: COIN, contractState: state, privateState: ps, time: 1_800_000_000 });
  const out = await contract.impureCircuits[circuit](ctx, ...args);
  state.data = out.context.queryContexts[address].state;
  return out.result;
};
const ledger = () => P.ledger(state.data);
const eq = (a, b) => a.x === b.x && a.y === b.y;
const at = (a, x) => mod(a.reduce((s, c, k) => s + c * BigInt(x) ** BigInt(k), 0n));

// ---- every position posts an encryption key
const ek = Array.from({ length: N }, rand);
for (let i = 1; i <= N; i++) await call('registerKey', [BigInt(i)], { ek: ek[i - 1] });
ok(eq(ledger().encKeys.lookup(3n), rt.ecMulGenerator(ek[2])), "a position's encryption key is its secret's");

// ---- dealer 1 proves its commitments, then each share
const a = Array.from({ length: T }, rand);
await call('dealCommit', [1n], { a });
ok([0, 1, 2, 3].every((k) => eq(ledger().commitments.lookup(P.pureCircuits.cell(1n, BigInt(k))), rt.ecMulGenerator(a[k]))), 'the commitments are made in the circuit from the dealer\'s secret numbers');
await fails(call('dealCommit', [1n], { a }), /has dealt/, 'a position deals only once');

await fails(call('dealShare', [1n, 5n], { s: mod(at(a, 5) + 1n), e: rand() }), /not this dealer's share/, 'a wrong share can\'t be posted');
await fails(call('dealShare', [1n, 5n], { s: at(a, 4), e: rand() }), /not this dealer's share/, 'nor another position\'s share');
for (let i = 1; i <= N; i++) await call('dealShare', [1n, BigInt(i)], { s: at(a, i), e: rand() });
for (let i = 1; i <= N; i++) {
  const parcel = ledger().parcels.lookup(P.pureCircuits.cell(1n, BigInt(i)));
  const k = rt.ecMul(parcel.r, ek[i - 1]);
  const s = mod(mod(parcel.c - P.pureCircuits.padOf(k, 1n, BigInt(i)), p));
  ok(s === at(a, i), `position ${i} opens its parcel with its own secret and gets its share`);
}
{
  const parcel = ledger().parcels.lookup(P.pureCircuits.cell(1n, 2n));
  const k = rt.ecMul(parcel.r, ek[4]); // position 5's secret on position 2's parcel
  ok(mod(mod(parcel.c - P.pureCircuits.padOf(k, 1n, 2n), p)) !== at(a, 2), "another position's secret doesn't open it");
}
await fails(call('dealShare', [1n, 3n], { s: at(a, 3), e: rand() }), /already sent/, 'a parcel is sent once');
console.log(`${checks} checks passed`);

// ---- edge cases: what the runtime does (reported, not judged)
const report = async (what, f) => { try { console.log(`edge  ${what}: ${await f()}`); } catch (e) { console.log(`edge  ${what}: REFUSED (${String(e?.message ?? e).slice(0, 100)})`); } };
const G = rt.ecMulGenerator(1n);
const show = (pt) => (eq(pt, G) ? 'gave 1·G (so it was reduced mod r)' : pt.x === 0n && pt.y === 1n ? 'gave the identity (so it was reduced mod r)' : `gave another point x=${String(pt.x).slice(0, 12)}…`);
await report('a scalar equal to r', async () => show(await call('castEdge', [r])));
await report('a scalar equal to r + 1', async () => show(await call('castEdge', [r + 1n])));
await report('a share of s + r (the same point)', async () => { await call('dealCommit', [2n], { a }); await call('dealShare', [2n, 1n], { s: at(a, 1) + r, e: rand() }); return 'accepted (the receiver must reduce what it opens mod r)'; });
await report('a point off the curve (1, 2)', async () => { const q = await call('pointEdge', [{ x: 1n, y: 2n }]); return `accepted, doubled to x=${String(q.x).slice(0, 12)}…`; });
await report('the point of order 2 (0, -1)', async () => { const q = await call('pointEdge', [{ x: 0n, y: p - 1n }]); return `accepted, doubled to (${q.x}, ${q.y})${q.x === 0n && q.y === 1n ? ' = the identity' : ''}`; });
