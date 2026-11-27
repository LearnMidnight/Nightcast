import { createHash, randomBytes } from 'node:crypto';

/**
 * Batches: many people's random numbers from one Nightcast request.
 *
 * Everyone who asks within a few seconds is one entry in a Merkle tree; the
 * tree's root is the seed of one ordinary `request` (tag {@link BATCH_TAG}).
 * Each person's number comes from that request's output and their own entry:
 *
 *   leaf  = SHA-256("nightcast:batch:leaf:v1" ‖ client ‖ ref ‖ commit)
 *   value = SHA-256("nightcast:batch:value:v1" ‖ output ‖ leaf ‖ salt)
 *
 * `commit` = SHA-256("nightcast:batch:salt:v1" ‖ salt), where the salt is 32
 * random bytes kept by whoever asked until they show their receipt. As the
 * entry was sealed on chain before the output existed, and nobody else knows
 * the salt, nobody can work out a person's number in advance: not the batch
 * service, not the oracle, nor the two together. (A salt of 32 zero bytes is
 * allowed for numbers anyone may compute; it gives up that protection.)
 *
 * Everything here is plain SHA-256 off chain; nothing in this file needs the
 * contract. See receipt.ts for checking a number against the chain.
 */

const label = (s: string): Uint8Array => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s));
  return b;
};
const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const be64 = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const bytes32 = (b: Uint8Array, what: string): Uint8Array => {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new TypeError(`${what} must be 32 bytes`);
  return b;
};

/** The tag of every batch request. */
export const BATCH_TAG = label('nightcast:batch:v1');
const LEAF = label('nightcast:batch:leaf:v1');
const NODE = label('nightcast:batch:node:v1');
const ROOT = label('nightcast:batch:root:v1');
const VALUE = label('nightcast:batch:value:v1');
const SALT = label('nightcast:batch:salt:v1');
const CLIENT = label('nightcast:batch:client:v1');
const REF = label('nightcast:batch:ref:v1');

/** The largest batch (entries in one tree). */
export const MAX_BATCH = 1 << 24;

/** 32 random bytes to keep with a request until its receipt is shown. */
export const newSalt = (): Uint8Array => new Uint8Array(randomBytes(32));
/** The salt that gives up privacy: anyone may compute the number. */
export const PUBLIC_SALT = new Uint8Array(32);
/** What goes in the entry for a salt. */
export const commitOf = (salt: Uint8Array): Uint8Array => sha256(SALT, bytes32(salt, 'a salt'));
/** An app's 32-byte id from its name (or pass 32 bytes of your own). */
export const clientId = (name: string): Uint8Array => sha256(CLIENT, new TextEncoder().encode(name));
/** A 32-byte reference from an app's own name for a request (a game round, a user and a time), or pass 32 bytes. */
export const refId = (name: string): Uint8Array => sha256(REF, new TextEncoder().encode(name));

/** One person's (or one call's) entry in a batch. */
export type BatchEntry = {
  /** The app that asked (see {@link clientId}). */
  client: Uint8Array;
  /** The app's own name for what this number is for (see {@link refId}); one entry per ref is the app's rule against asking again. */
  ref: Uint8Array;
  /** {@link commitOf} the salt. */
  commit: Uint8Array;
};

export const leafOf = (e: BatchEntry): Uint8Array =>
  sha256(LEAF, bytes32(e.client, 'client'), bytes32(e.ref, 'ref'), bytes32(e.commit, 'commit'));

const node = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(NODE, l, r);
/** The request's seed: the tree's top hash, bound to how many entries there are. */
const rootOf = (top: Uint8Array, size: number): Uint8Array => sha256(ROOT, be64(size), top);

const checkSize = (size: number) => {
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) throw new RangeError(`a batch has 1 to ${MAX_BATCH} entries`);
};

/**
 * Walk from entry `index` of a batch of `size` to the top. At each level an
 * entry is paired with its neighbour; the last entry of an odd level has none
 * and moves up unchanged. So the path's shape follows from (index, size), and a
 * path can't be passed off as another entry's.
 */
const walk = (index: number, size: number, step: (hasSibling: boolean, siblingOnLeft: boolean, level: number, at: number) => void) => {
  let i = index;
  let n = size;
  let level = 0;
  while (n > 1) {
    if (i % 2 === 1) step(true, true, level, i);
    else if (i + 1 < n) step(true, false, level, i);
    else step(false, false, level, i);
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
    level++;
  }
};

/** A sealed batch: its seed for `request(BATCH_TAG, seed)`, and each entry's path for its receipt. */
export type SealedBatch = {
  seed: Uint8Array;
  size: number;
  leaves: Uint8Array[];
  /** The sibling hashes from entry `index` up to the top. */
  pathOf(index: number): Uint8Array[];
};

/** Seal entries, in the order given, into one batch. */
export const sealBatch = (entries: BatchEntry[]): SealedBatch => {
  checkSize(entries.length);
  const leaves = entries.map(leafOf);
  const seen = new Set<string>();
  for (const l of leaves) {
    const k = Buffer.from(l).toString('hex');
    if (seen.has(k)) throw new Error('two entries are the same (same client, ref and salt): they would get the same number');
    seen.add(k);
  }
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? node(prev[i], prev[i + 1]) : prev[i]);
    levels.push(next);
  }
  const size = leaves.length;
  return {
    seed: rootOf(levels[levels.length - 1][0], size),
    size,
    leaves,
    pathOf(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= size) throw new RangeError(`no entry ${index} in a batch of ${size}`);
      const path: Uint8Array[] = [];
      walk(index, size, (has, left, level, at) => {
        if (has) path.push(levels[level][left ? at - 1 : at + 1]);
      });
      return path;
    },
  };
};

/** The seed a leaf and its path lead to, or undefined if the path doesn't fit entry `index` of a batch of `size`. */
export const seedFromPath = (leaf: Uint8Array, index: number, size: number, path: Uint8Array[]): Uint8Array | undefined => {
  checkSize(size);
  if (!Number.isInteger(index) || index < 0 || index >= size) return undefined;
  let h = bytes32(leaf, 'leaf');
  let used = 0;
  let fits = true;
  walk(index, size, (has, left) => {
    if (!has) return;
    const sib = path[used++];
    if (!sib || sib.length !== 32) { fits = false; return; }
    h = left ? node(sib, h) : node(h, sib);
  });
  if (!fits || used !== path.length) return undefined;
  return rootOf(h, size);
};

/** A person's number from the batch request's output, their leaf and their salt. */
export const valueOf = (output: Uint8Array, leaf: Uint8Array, salt: Uint8Array): Uint8Array =>
  sha256(VALUE, bytes32(output, 'output'), bytes32(leaf, 'leaf'), bytes32(salt, 'salt'));
