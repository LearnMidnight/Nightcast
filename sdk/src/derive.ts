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
  if (n < 1n || n > 1n << 256n) throw new RangeError('n must be in 1..2^256');
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
 * Lunardraw commit-reveal combination (scheme "nightcast-lotto-v0").
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

/** The site's draw loop over SHA-256(prefix + ":" + i), 2-byte rejection sampling, no repeats. */
const drawFrom = (prefix: string, pick: number, pool: number): number[] => {
  if (!Number.isInteger(pool) || pool < 1 || pool > 65536) throw new RangeError('pool must be 1..65536');
  if (!Number.isInteger(pick) || pick < 1 || pick > pool) throw new RangeError('pick must be 1..pool');
  const limit = 65536 - (65536 % pool);
  const out: number[] = [];
  for (let i = 0; out.length < pick; i++) {
    const d = createHash('sha256').update(`${prefix}:${i}`).digest();
    for (let j = 0; j + 1 < d.length && out.length < pick; j += 2) {
      const v = (d[j] << 8) | d[j + 1];
      if (v >= limit) continue;
      const n = (v % pool) + 1;
      if (!out.includes(n)) out.push(n);
    }
  }
  return out.sort((a, b) => a - b);
};

/**
 * Pick `pick` distinct numbers from 1..`pool`, sorted ascending.
 * Same rule as the Lunardraw site: for i = 0, 1, …, take
 * d = SHA-256(seed + ":" + i), read 2 bytes at a time (big-endian), skip
 * v ≥ 65536 − (65536 mod pool), n = v mod pool + 1, skip repeats.
 */
export const pickNumbers = (seedHex: string, pick: number, pool: number): number[] =>
  drawFrom(cleanHex(seedHex), pick, pool);

/**
 * The Moonball (bonus ball): the same rule run on seed + ":mb" for one number
 * from the bonus pool, as the site's `midnight_lotto_derive_bonus()`. It may
 * repeat a main number.
 */
export const pickMoonball = (seedHex: string, pool: number): number => drawFrom(`${cleanHex(seedHex)}:mb`, 1, pool)[0];

/** Starfall: 7 numbers from 35 and a Moonball from 20. */
export const STARFALL = { pick: 7, pool: 35, moonballPool: 20 } as const;

/** A full Starfall draw from a draw seed. */
export const drawStarfall = (seedHex: string): { numbers: number[]; moonball: number } => ({
  numbers: pickNumbers(seedHex, STARFALL.pick, STARFALL.pool),
  moonball: pickMoonball(seedHex, STARFALL.moonballPool),
});

/** @deprecated Starfall's earlier name; use {@link STARFALL}. */
export const MIDNIGHT_7 = STARFALL;
/** @deprecated Starfall's earlier name; use {@link drawStarfall}. */
export const drawMidnight7 = drawStarfall;

/**
 * Strip anything that isn't hex and lowercase, as the Lunardraw site does.
 * Note this keeps the leading 0 of a "0x" prefix, so always write seeds without one.
 */
export const cleanHex = (s: string): string => s.replace(/[^0-9a-f]/gi, '').toLowerCase();
