import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateOracleSecretKey, pureCircuits } from '@nightcast/contract';
import { cleanHex, combineDrawSeed, drawMidnight7, pickMoonball, pickNumbers, randomWords, seedCommitment, uniformInt } from '../derive.js';

describe('pickNumbers (Midnight Lotto rule)', () => {
  it('matches the published test vector', () => {
    // From the Midnight Lotto verification scheme: seed = 64 zeros, 6 from 45.
    expect(pickNumbers('0'.repeat(64), 6, 45)).toEqual([1, 3, 7, 21, 31, 35]);
    expect(seedCommitment('0'.repeat(64))).toBe('60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55');
  });

  it('matches the Midnight 7 + Moonball test vector', () => {
    // From the site's verification scheme (checked in PHP, JS and Python): 64 zeros.
    expect(drawMidnight7('0'.repeat(64))).toEqual({ numbers: [6, 7, 13, 23, 26, 31, 35], moonball: 14 });
    expect(pickMoonball('0'.repeat(64), 20)).toBe(14);
  });

  it('normalises the seed like the site does', () => {
    // Non-hex characters are dropped (not just a 0x prefix), matching the site's cleanSeed().
    const messy = ' ' + 'AB'.repeat(16) + '-' + 'CD'.repeat(16) + ' ';
    expect(pickNumbers(messy, 6, 45)).toEqual(pickNumbers('ab'.repeat(16) + 'cd'.repeat(16), 6, 45));
    expect(cleanHex('AB-cd 12')).toBe('abcd12');
  });

  it('returns distinct sorted numbers in range', () => {
    for (let i = 0; i < 100; i++) {
      const seed = createHash('sha256').update(`s${i}`).digest('hex');
      const nums = pickNumbers(seed, 5, 50);
      expect(new Set(nums).size).toBe(5);
      expect(nums).toEqual([...nums].sort((a, b) => a - b));
      expect(nums.every((n) => n >= 1 && n <= 50)).toBe(true);
    }
    expect(pickNumbers('ab', 45, 45)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
  });

  it('rejects impossible draws', () => {
    expect(() => pickNumbers('00', 7, 6)).toThrow();
    expect(() => pickNumbers('00', 0, 6)).toThrow();
  });
});

describe('combineDrawSeed', () => {
  it('depends on both the operator seed and the VRF output', () => {
    const out1 = pureCircuits.evaluate(generateOracleSecretKey(), new Uint8Array(32));
    const out2 = pureCircuits.evaluate(generateOracleSecretKey(), new Uint8Array(32));
    const a = combineDrawSeed('11'.repeat(32), out1);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(combineDrawSeed('11'.repeat(32), out1)).toBe(a);
    expect(combineDrawSeed('22'.repeat(32), out1)).not.toBe(a);
    expect(combineDrawSeed('11'.repeat(32), out2)).not.toBe(a);
  });
});

describe('randomWords and uniformInt', () => {
  it('expands an output into the contract words', () => {
    const out = pureCircuits.evaluate(generateOracleSecretKey(), new Uint8Array(32));
    const words = randomWords(out, 3);
    expect(words).toHaveLength(3);
    expect(Buffer.from(words[2]).toString('hex')).toBe(Buffer.from(pureCircuits.randomWord(out, 2n)).toString('hex'));
  });

  it('stays in range and covers it', () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 300; i++) {
      const v = uniformInt(createHash('sha256').update(`w${i}`).digest(), 6n);
      expect(v >= 0n && v < 6n).toBe(true);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
    expect(uniformInt(new Uint8Array(32), 1n)).toBe(0n);
  });
});
