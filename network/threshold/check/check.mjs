// Run the threshold probe in memory (compact-runtime 0.21): a 7-position ceremony, a request, all
// 7 answers, then every 4 of them combined on chain must give one value (the off-chain one), and
// cheating must fail.
import { webcrypto } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as P from './out/contract/index.js';

const r = rt.JUBJUB_SCALAR_MODULUS;
const mod = (a) => ((a % r) + r) % r;
const rand = () => mod(BigInt('0x' + Buffer.from(webcrypto.getRandomValues(new Uint8Array(40))).toString('hex')));
const N = 7, T = 4, D = 720n;
const COIN = '0'.repeat(64);
const bytes = (s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
let checks = 0;
const ok = (c, what) => { if (!c) throw new Error(`FAILED: ${what}`); checks++; console.log(`ok  ${what}`); };
const fails = async (p, re, what) => { try { await p; } catch (e) { ok(re.test(String(e?.message ?? e)), `${what} (${String(e?.message ?? e).slice(0, 80)})`); return; } ok(false, `${what}: did not fail`); };

const coeff = (i, others) => {
  let num = D, den = 1n;
  for (const j of others) { num *= BigInt(j); den *= BigInt(j > i ? j - i : i - j); }
  if (num % den) throw new Error('not an integer');
  return num / den;
};
const witnesses = {
  shareSecret: ({ privateState }) => [privateState, privateState.sk],
  coefficient: ({ privateState }, i, a, b, c) => [privateState, privateState.badCoefficient ?? coeff(Number(i), [a, b, c].map(Number))],
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

// ---- the ceremony: each position deals a polynomial of degree T-1; shares go privately to each position
const polys = Array.from({ length: N }, () => Array.from({ length: T }, rand));
const at = (a, x) => mod(a.reduce((s, c, k) => s + c * BigInt(x) ** BigInt(k), 0n));
for (let d = 1; d <= N; d++) await call('deal', [BigInt(d), polys[d - 1].map((c) => rt.ecMulGenerator(c))]);
ok([...ledger().aggregate].length === T, 'the group key: 4 commitments, the sums of every dealer\'s');
const sk = Array.from({ length: N }, (_, i) => mod(polys.reduce((s, a) => s + at(a, i + 1), 0n)));
for (let i = 1; i <= N; i++) ok(eq(await call('shareKey', [BigInt(i)]), rt.ecMulGenerator(sk[i - 1])), `position ${i}'s share key, worked out on chain from the commitments, is its share's`);
await fails(call('deal', [3n, polys[2].map((c) => rt.ecMulGenerator(c))]), /has dealt/, 'a position deals only once');
// a complaint against an honest dealer fails; against a bad share it disqualifies
await fails(call('complain', [2n, 5n, at(polys[1], 5)]), /matches the commitments/, 'a false complaint is refused');
await call('complain', [2n, 5n, mod(at(polys[1], 5) + 1n)]);
ok(ledger().disqualified.member(2n), 'a share that doesn\'t match its dealer\'s commitments disqualifies the dealer');

// ---- a request, and every position answers
const groupSk = mod(polys.reduce((s, a) => s + a[0], 0n)); // nobody holds this: for the check only
const rid = await call('request', [bytes('draw 1')]);
const H = ledger().requests.lookup(rid);
await fails(call('answer', [rid, 3n], { sk: sk[3] }), /not this position's share/, 'a position can\'t answer with another position\'s share');
await fails(call('answer', [rid, 3n], { sk: rand() }), /not this position's share/, 'or with any other secret');
for (let i = 1; i <= N; i++) await call('answer', [rid, BigInt(i)], { sk: sk[i - 1] });
const expected = P.pureCircuits.outputOf(rt.ecMul(H, mod(D * groupSk)));

// ---- any 4 give the same value: try them all, each on a fresh copy of the state
const subsets = (k, from = 1) => (k === 0 ? [[]] : from > N ? [] : [...subsets(k - 1, from + 1).map((s) => [from, ...s]), ...subsets(k, from + 1)]);
const snapshot = state.data;
const seen = new Set();
for (const S of subsets(T)) {
  state.data = snapshot;
  seen.add(Buffer.from(await call('finalise', [rid, S.map(BigInt)])).toString('hex'));
}
ok(seen.size === 1 && seen.has(Buffer.from(expected).toString('hex')), `all ${subsets(T).length} sets of 4 answers give one value, D·sk·H's`);
state.data = snapshot;
await fails(call('finalise', [rid, [1n, 2n, 3n, 4n]], { badCoefficient: 1n }), /wrong coefficient/, 'a wrong coefficient is refused');
await fails(call('finalise', [rid, [2n, 1n, 3n, 4n]]), /in order/, 'positions out of order are refused');
await fails(call('finalise', [rid, [1n, 1n, 3n, 4n]]), /in order/, 'a position twice is refused');
// only 3 answers: no value
const rid2 = await call('request', [bytes('draw 2')]);
for (const i of [1, 2, 3]) await call('answer', [rid2, BigInt(i)], { sk: sk[i - 1] });
await fails(call('finalise', [rid2, [1n, 2n, 3n, 4n]]), /a share is missing/, 'three answers are not enough');
console.log(`\n${checks} checks passed`);
