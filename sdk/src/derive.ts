import { createHash } from 'node:crypto';
import { pureCircuits } from '@nightcast/contract';

/**
 * Helpers for turning a Nightcast output into the values an application needs.
 * Everything here is deterministic: anyone holding the public output can
 * recompute it.
 */

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** `count` independent 32-byte words from one output (same as the contract's `randomWord`). */
export const randomWords = (output: Uint8Array, count: number): Uint8Array[] => {
  if (!Number.isInteger(count) || count < 1 || count > 2 ** 32) throw new RangeError('count must be 1..2^32');
  return Array.from({ length: count }, (_, i) => pureCircuits.randomWord(output, BigInt(i)));
};

/**
 * A uniform integer in [0, n) from a word, by rejection sampling over
 * successive SHA-256 blocks so there is no modulo bias.
 */
export const uniformInt = (word: Uint8Array, n: bigint): bigint => {
  if (n < 1n) throw new RangeError('n must be at least 1');
  if (n === 1n) return 0n;
  const space = 1n << 256n;
  const limit = space - (space % n);
  for (let i = 0; ; i++) {
    const block = i === 0 ? word : createHash('sha256').update(word).update(`:${i}`).digest();
    const v = BigInt('0x' + hex(block));
    if (v < limit) return v % n;
  }
};

/**
 * Midnight Lotto commit-reveal combination (scheme "nightcast-lotto-v0").
 *
 * The operator publishes SHA-256(operatorSeedHex) before ticket sales close,
 * requests Nightcast randomness after they close, then reveals the seed. The
 * draw seed mixes both, so neither the operator (who doesn't know the oracle
 * key) nor the oracle (who doesn't know the operator seed) can predict or
 * steer the result alone.
 *
 * Returns a 64-char hex draw seed for {@link pickNumbers}.
 */
export const combineDrawSeed = (operatorSeedHex: string, vrfOutput: Uint8Array): string => {
  const seed = cleanHex(operatorSeedHex);
  return createHash('sha256').update(`${seed}:${hex(vrfOutput)}`).digest('hex');
};

/** SHA-256 commitment of an operator seed, published before the draw. */
export const seedCommitment = (operatorSeedHex: string): string =>
  createHash('sha256').update(cleanHex(operatorSeedHex)).digest('hex');

/**
 * Pick `pick` distinct numbers from 1..`pool`, sorted ascending.
 * Same rule as the Midnight Lotto site: for i = 0, 1, …, take
 * d = SHA-256(seed + ":" + i), read 2 bytes at a time (big-endian), skip
 * v ≥ 65536 − (65536 mod pool), n = v mod pool + 1, skip repeats.
 */
export const pickNumbers = (seedHex: string, pick: number, pool: number): number[] => {
  if (!Number.isInteger(pool) || pool < 1 || pool > 65536) throw new RangeError('pool must be 1..65536');
  if (!Number.isInteger(pick) || pick < 1 || pick > pool) throw new RangeError('pick must be 1..pool');
  const seed = cleanHex(seedHex);
  const limit = 65536 - (65536 % pool);
  const out: number[] = [];
  for (let i = 0; out.length < pick; i++) {
    const d = createHash('sha256').update(`${seed}:${i}`).digest();
    for (let j = 0; j + 1 < d.length && out.length < pick; j += 2) {
      const v = (d[j] << 8) | d[j + 1];
      if (v >= limit) continue;
      const n = (v % pool) + 1;
      if (!out.includes(n)) out.push(n);
    }
  }
  return out.sort((a, b) => a - b);
};

/** Strip anything that isn't hex and lowercase, as the Midnight Lotto site does. */
export const cleanHex = (s: string): string => s.replace(/[^0-9a-f]/gi, '').toLowerCase();
