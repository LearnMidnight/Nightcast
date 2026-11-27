import { createHash } from 'node:crypto';
import {
  type CompactType,
  CompactTypeBytes,
  CompactTypeJubjubPoint,
  ecAdd,
  ecMul,
  ecMulGenerator,
  type JubjubPoint,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime';

/**
 * The fast answer: a request's output given out as soon as the request is on
 * chain, before the oracle's `fulfil` proof.
 *
 * Once `request` has stored its point H, the output is fixed:
 * gamma = sk · H and output = SHA-256 of ("nightcast:output:v0", gamma), as
 * the contract's `evaluateAt` computes it. The oracle sends gamma with a
 * Chaum–Pedersen proof of equal discrete logarithms (the proof inside ECVRF,
 * RFC 9381): the same sk links the oracle's key pk = sk · G and gamma = sk · H.
 * Anyone can check it against the key and point on chain; `fulfil` later
 * produces the same gamma, as a curve point has one multiple by a given sk.
 */

/** The order of the Jubjub subgroup the keys and points live in. */
export const JUBJUB_ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

const label = (s: string): Uint8Array => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s));
  return b;
};
const OUTPUT = label('nightcast:output:v0');
const CHALLENGE = label('nightcast:fast:challenge:v1');
const NONCE = label('nightcast:fast:nonce:v1');

const be32 = (n: bigint): Uint8Array => {
  if (n < 0n || n >= 1n << 256n) throw new RangeError('out of range for 32 bytes');
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
};
const pointBytes = (p: JubjubPoint): Uint8Array => new Uint8Array([...be32(p.x), ...be32(p.y)]);
export const samePoint = (a: JubjubPoint, b: JubjubPoint): boolean => a.x === b.x && a.y === b.y;
const isIdentity = (p: JubjubPoint): boolean => p.x === 0n && p.y === 1n;
/**
 * In the prime-order subgroup. Jubjub's full group has 8 times as many points: a
 * gamma with a small-order part added could pass the proof's equations for one
 * challenge in 8, giving a different output. So every point is checked.
 */
// (ecMul takes scalars below the order, so r·p is computed as (r − 1)·p + p.)
const inSubgroup = (p: JubjubPoint): boolean => !isIdentity(p) && isIdentity(ecAdd(ecMul(p, JUBJUB_ORDER - 1n), p));

/** A number in [0, JUBJUB_ORDER) from 64 bytes of SHA-256 output, so the reduction has no noticeable bias. */
const hashToScalar = (...parts: Uint8Array[]): bigint => {
  const wide = Buffer.concat([0, 1].map((i) => {
    const h = createHash('sha256').update(Uint8Array.of(i));
    for (const p of parts) h.update(p);
    return h.digest();
  }));
  return BigInt(`0x${wide.toString('hex')}`) % JUBJUB_ORDER;
};

// The contract's OutputPreimage { domain: Bytes<32>, gamma: JubjubPoint }, as persistentHash sees it.
const bytes32Type = new CompactTypeBytes(32);
const OutputPreimage: CompactType<{ domain: Uint8Array; gamma: JubjubPoint }> = {
  alignment: () => [...bytes32Type.alignment(), ...CompactTypeJubjubPoint.alignment()],
  toValue: (v) => [...bytes32Type.toValue(v.domain), ...CompactTypeJubjubPoint.toValue(v.gamma)],
  fromValue: (value) => ({ domain: bytes32Type.fromValue(value), gamma: CompactTypeJubjubPoint.fromValue(value) }),
};

/** A request's output from its gamma: what the contract's `evaluateAt` returns. */
export const outputOfGamma = (gamma: JubjubPoint): Uint8Array => persistentHash(OutputPreimage, { domain: OUTPUT, gamma });

/** The proof that one secret links the oracle's key and gamma: two points and a scalar. */
export type FastProof = { u: JubjubPoint; v: JubjubPoint; s: bigint };
export type FastAnswer = { gamma: JubjubPoint; proof: FastProof; output: Uint8Array };

const G = (): JubjubPoint => ecMulGenerator(1n);
const challenge = (pk: JubjubPoint, h: JubjubPoint, gamma: JubjubPoint, u: JubjubPoint, v: JubjubPoint): bigint =>
  hashToScalar(CHALLENGE, pointBytes(G()), pointBytes(h), pointBytes(pk), pointBytes(gamma), pointBytes(u), pointBytes(v));

/**
 * The oracle's fast answer for a request whose stored point is `point`.
 * The nonce is derived from the key and the point (as RFC 9381 does), so it
 * is never reused for different points and needs no randomness.
 */
export const fastAnswer = (sk: bigint, point: JubjubPoint): FastAnswer => {
  const x = sk % JUBJUB_ORDER;
  if (x === 0n) throw new RangeError('not a usable oracle key');
  if (isIdentity(point)) throw new RangeError('not a request point');
  const gamma = ecMul(point, x);
  const k = hashToScalar(NONCE, be32(x), pointBytes(point));
  if (k === 0n) throw new Error('nonce is zero (vanishingly unlikely): no proof for this point');
  const u = ecMulGenerator(k);
  const v = ecMul(point, k);
  const pk = ecMulGenerator(x);
  const c = challenge(pk, point, gamma, u, v);
  const s = (k + c * x) % JUBJUB_ORDER;
  return { gamma, proof: { u, v, s }, output: outputOfGamma(gamma) };
};

/** True when `proof` shows the holder of `oracleKey`'s secret made `gamma` from `point`. */
export const checkFastAnswer = (oracleKey: JubjubPoint, point: JubjubPoint, gamma: JubjubPoint, proof: FastProof): boolean => {
  try {
    if (![oracleKey, point, gamma, proof.u, proof.v].every(inSubgroup)) return false;
    if (proof.s < 0n || proof.s >= JUBJUB_ORDER) return false;
    const c = challenge(oracleKey, point, gamma, proof.u, proof.v);
    // s·G = u + c·pk and s·H = v + c·gamma
    return samePoint(ecMulGenerator(proof.s), ecAdd(proof.u, ecMul(oracleKey, c)))
      && samePoint(ecMul(point, proof.s), ecAdd(proof.v, ecMul(gamma, c)));
  } catch {
    return false; // not points on the curve
  }
};
