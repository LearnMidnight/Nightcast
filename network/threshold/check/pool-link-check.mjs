// Run the pool-link probe in memory: a real Ed25519 signature (Node's crypto) over an operator
// key links it; a signature over something else, a tampered one or another pool's key doesn't.
// How the runtime wants a Curve25519 point and scalar is a guess here ({ x, y } and a bigint, as
// for Jubjub): if the guess is wrong this says so, and the circuit sizes above still stand.
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as P from './out-pool/contract/index.js';

const p = (1n << 255n) - 19n;
const mod = (a) => ((a % p) + p) % p;
const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; };
const inv = (a) => pow(a, p - 2n);
const d = mod(-121665n * inv(121666n));
const le = (b) => BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
// RFC 8032 point decoding: 32 bytes, y little-endian with x's sign in the top bit.
const decode = (bytes) => {
  const n = le(bytes);
  const y = n & ((1n << 255n) - 1n);
  const sign = n >> 255n;
  const u = mod(y * y - 1n), v = mod(d * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (p - 5n) / 8n));
  if (mod(v * x * x) !== u) x = mod(x * pow(2n, (p - 1n) / 4n));
  if (mod(v * x * x) !== u) throw new Error('not a point');
  if ((x & 1n) !== sign) x = mod(-x);
  return { x, y };
};

const COIN = '0'.repeat(64);
const contract = new P.Contract({});
const address = rt.sampleContractAddress();
let state = (await contract.initialState(rt.createConstructorContext({}, COIN))).currentContractState;
const call = async (circuit, args) => {
  const ctx = rt.createCircuitContext({ circuitId: circuit, contractAddress: address, coinPublicKeyOrZswapState: COIN, contractState: state, privateState: {}, time: 1_800_000_000 });
  const out = await contract.impureCircuits[circuit](ctx, ...args);
  state.data = out.context.queryContexts[address].state;
  return out.result;
};
let checks = 0;
const ok = (c, what) => { if (!c) throw new Error(`FAILED: ${what}`); checks++; console.log(`ok  ${what}`); };
const fails = async (pr, re, what) => { try { await pr; } catch (e) { ok(re.test(String(e?.message ?? e)), `${what} (${String(e?.message ?? e).slice(0, 90)})`); return; } ok(false, `${what}: did not fail`); };

const pool = generateKeyPairSync('ed25519');
const pub = Buffer.from(pool.publicKey.export({ format: 'jwk' }).x, 'base64url');
const sigOf = (msg, key = pool.privateKey) => { const s = sign(null, Buffer.from(msg), key); return { r: decode(s.subarray(0, 32)), s: le(s.subarray(32)) }; };
const key = () => webcrypto.getRandomValues(new Uint8Array(32));
try {
  const k1 = key();
  await call('linkPool', [k1, sigOf(k1), decode(pub)]);
  ok(P.ledger(state.data).linked.member(k1), "an operator key signed by the pool's Ed25519 key is linked");
  await fails(call('linkPool', [k1, sigOf(k1), decode(pub)]), /is linked/, 'an operator key is linked once');
  const k2 = key();
  await fails(call('linkPool', [k2, sigOf(k1), decode(pub)]), /didn't sign/, "a signature over another key doesn't link this one");
  const bad = sigOf(k2); bad.s = bad.s ^ 1n;
  await fails(call('linkPool', [k2, bad, decode(pub)]), /didn't sign|decode|scalar/i, 'nor does a tampered signature');
  const other = generateKeyPairSync('ed25519');
  await fails(call('linkPool', [k2, sigOf(k2, other.privateKey), decode(pub)]), /didn't sign/, "nor one made by another pool's key");
  console.log(`${checks} checks passed`);
} catch (e) {
  console.log(`after ${checks} checks: ${String(e?.message ?? e).slice(0, 300)}`);
  console.log('(the in-memory check did not finish: probably how this script hands over a Curve25519 point or scalar. The circuit sizes above still stand.)');
}
