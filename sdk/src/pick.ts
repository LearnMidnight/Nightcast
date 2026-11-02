/**
 * Turning one Nightcast answer into everyday choices: a winner from a list,
 * several winners, a shuffled order, dice, a weighted prize.
 *
 * Every helper takes the request's output (the 32 bytes the oracle stored, or
 * its 64-character hex) and is deterministic: anyone holding the same output
 * and the same list gets the same result, so a result can be checked. Each
 * draws its words from the contract's own `randomWord(output, i)` (i = 0, 1,
 * …) and turns a word into a number with {@link uniformInt}, which has no
 * modulo bias.
 *
 * One output decides one thing. Two helpers run on the same output read the
 * same words, so their results are related; to decide two things, make two
 * requests (or pass a different `from` to each).
 *
 * For a fair draw the list must be fixed before the randomness exists: put
 * {@link listCommitment} of the list into the request (as its seed) and
 * publish the list, so anyone can check it wasn't changed after the answer.
 * See docs/GUIDE.md, "A fair raffle".
 */
import { createHash } from 'node:crypto';
import { pureCircuits } from '@nightcast/contract';
import { uniformInt } from './derive.js';

/** A Nightcast output: its 32 bytes, or 64 hex characters (an optional 0x prefix is fine). */
export type Randomness = Uint8Array | string;

/** Where in the output's word stream a helper starts (default 0). */
export type From = { from?: number };

/** The output's 32 bytes. */
export const outputBytes = (r: Randomness): Uint8Array => {
  if (typeof r !== 'string') {
    if (r.length !== 32) throw new RangeError(`a Nightcast output is 32 bytes, not ${r.length}`);
    return r;
  }
  const h = r.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new RangeError('a Nightcast output is 64 hex characters');
  return Uint8Array.from(Buffer.from(h, 'hex'));
};

const word = (output: Uint8Array, i: number): Uint8Array => pureCircuits.randomWord(output, BigInt(i));

const start = (opts: From | undefined): number => {
  const f = opts?.from ?? 0;
  if (!Number.isSafeInteger(f) || f < 0) throw new RangeError('from must be a whole number, 0 or more');
  return f;
};

/** A whole number from `min` to `max`, both included. */
export const randomInt = (r: Randomness, min: number, max: number, opts?: From): number => {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError('min and max must be whole numbers with min ≤ max');
  return min + Number(uniformInt(word(outputBytes(r), start(opts)), BigInt(max - min + 1)));
};

/** One item from `items`, each equally likely. */
export const pick = <T>(r: Randomness, items: readonly T[], opts?: From): T => {
  if (items.length === 0) throw new RangeError('nothing to pick from: the list is empty');
  return items[Number(uniformInt(word(outputBytes(r), start(opts)), BigInt(items.length)))];
};

/**
 * `count` different items from `items` (never the same position twice), in
 * the order they were drawn: the first is the first winner. A Fisher–Yates
 * shuffle stopped after `count` steps, so `pickMany(r, items, k)` is always
 * the first k of `shuffle(r, items)`.
 */
export const pickMany = <T>(r: Randomness, items: readonly T[], count: number, opts?: From): T[] => {
  if (!Number.isSafeInteger(count) || count < 0 || count > items.length) throw new RangeError(`count must be 0 to ${items.length} (the list's length)`);
  const out = outputBytes(r);
  const f = start(opts);
  const a = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + Number(uniformInt(word(out, f + i), BigInt(a.length - i)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
};

/** All of `items` in a random order (a new array; the list itself is left alone). */
export const shuffle = <T>(r: Randomness, items: readonly T[], opts?: From): T[] => pickMany(r, items, items.length, opts);

/** `count` dice with `sides` sides each (default one six-sided die), each 1 to `sides`. */
export const rollDice = (r: Randomness, count = 1, sides = 6, opts?: From): number[] => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new RangeError('count must be 1 to 10000');
  if (!Number.isSafeInteger(sides) || sides < 2) throw new RangeError('sides must be a whole number, 2 or more');
  const out = outputBytes(r);
  const f = start(opts);
  return Array.from({ length: count }, (_, i) => 1 + Number(uniformInt(word(out, f + i), BigInt(sides))));
};

/**
 * One choice, each as likely as its weight: `{ gold: 1, silver: 3, bronze: 6 }`
 * gives bronze 6 times in 10. Weights are whole numbers (0 means never), so
 * the odds are exact and the same everywhere. Order matters for the result,
 * so publish the weights in the order you pass them: an object's keys in
 * their written order, or a list of `[choice, weight]` pairs.
 */
export function weightedPick<K extends string>(r: Randomness, weights: Readonly<Record<K, number>>, opts?: From): K;
export function weightedPick<T>(r: Randomness, weights: readonly (readonly [T, number])[], opts?: From): T;
export function weightedPick<T>(r: Randomness, weights: Readonly<Record<string, number>> | readonly (readonly [T, number])[], opts?: From): T | string {
  const pairs: (readonly [T | string, number])[] = Array.isArray(weights) ? [...weights] : Object.entries(weights as Record<string, number>);
  if (pairs.length === 0) throw new RangeError('nothing to pick from: no weights');
  let total = 0n;
  for (const [choice, w] of pairs) {
    if (!Number.isSafeInteger(w) || w < 0) throw new RangeError(`the weight of ${String(choice)} must be a whole number, 0 or more`);
    total += BigInt(w);
  }
  if (total === 0n) throw new RangeError('at least one weight must be more than 0');
  let roll = uniformInt(word(outputBytes(r), start(opts)), total);
  for (const [choice, w] of pairs) {
    if (roll < BigInt(w)) return choice;
    roll -= BigInt(w);
  }
  throw new Error('unreachable');
}

/**
 * A fingerprint of a list (64 hex characters): SHA-256 of
 * "nightcast:list:v1", the number of items and each item's length and UTF-8
 * bytes (lengths as 4-byte big-endian). Any change to the list, its order or
 * any item changes it. Use it as the request's 32-byte seed
 * (`fromHex(listCommitment(names))`) so the answer is bound to this exact list.
 */
export const listCommitment = (items: readonly string[]): string => {
  const h = createHash('sha256').update('nightcast:list:v1');
  const n = Buffer.alloc(4);
  n.writeUInt32BE(items.length);
  h.update(n);
  for (const item of items) {
    if (typeof item !== 'string') throw new TypeError('listCommitment takes a list of strings');
    const b = Buffer.from(item, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    h.update(len).update(b);
  }
  return h.digest('hex');
};
