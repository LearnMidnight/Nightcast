import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pureCircuits } from '../managed/nightcast/contract/index.js';

// Compact's persistentHash of byte strings is plain SHA-256 of the bytes. The
// Lunardraw contract relies on this to reproduce the site's draw rule
// (contract/src/draw.compact in LearnMidnight/Lunardraw), so check it stays true.
const pad32 = (s: string): Buffer => {
  const b = Buffer.alloc(32);
  b.write(s, 'utf8');
  return b;
};
const sha = (...parts: Buffer[]): string => createHash('sha256').update(Buffer.concat(parts)).digest('hex');
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

describe('persistentHash encoding', () => {
  it('hashes byte strings as plain SHA-256 of the concatenation (the lotto draw rule relies on it)', () => {
    const secret = new Uint8Array(32).map((_, i) => i + 1);
    const got = hex(pureCircuits.requesterCommitmentOf(secret));
    const plain = sha(pad32('nightcast:requester:v0'), Buffer.from(secret));
    expect(got, `persistentHash([pad,secret]) vs plain SHA-256(pad||secret)`).toBe(plain);
  });
});
