import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pureCircuits } from '../managed/nightcast/contract/index.js';

// Probe: what exactly does Compact's persistentHash hash? If a tuple of
// Bytes<32> hashes to plain SHA-256 of the concatenated bytes, contracts can
// reproduce byte-level SHA-256 rules (such as Midnight Lotto's draw rule).
const pad32 = (s: string): Buffer => {
  const b = Buffer.alloc(32);
  b.write(s, 'utf8');
  return b;
};
const sha = (...parts: Buffer[]): string => createHash('sha256').update(Buffer.concat(parts)).digest('hex');
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

describe('persistentHash encoding probe', () => {
  it('reports how [Bytes<32>, Bytes<32>] is hashed', () => {
    const secret = new Uint8Array(32).map((_, i) => i + 1);
    const got = hex(pureCircuits.requesterCommitmentOf(secret));
    const plain = sha(pad32('nightcast:requester:v0'), Buffer.from(secret));
    const summary = `persistentHash([pad,secret]) = ${got}; plain SHA-256(pad||secret) = ${plain}; equal = ${got === plain}`;
    console.log(`::notice title=persistentHash probe::${summary}`);
    expect(typeof got).toBe('string');
  });
});
