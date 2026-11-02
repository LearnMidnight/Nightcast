import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateOracleSecretKey, NightcastSimulator, toHex } from '@nightcast/contract';
import { listCommitment, outputBytes, pick, pickMany, randomInt, rollDice, shuffle, weightedPick } from '../pick.js';

// Stand-in outputs: any 32 bytes behave like an oracle's answer here.
const output = (i: number | string): Uint8Array => createHash('sha256').update(`output ${i}`).digest();
const NAMES = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella'];

// thousands of draws per distribution test: allow for a slow runner
describe('picking from a Nightcast output', { timeout: 120_000 }, () => {
  it('takes the output as bytes or hex, and nothing else', () => {
    const o = output(1);
    expect(outputBytes(toHex(o))).toEqual(o);
    expect(outputBytes('0x' + toHex(o).toUpperCase())).toEqual(o);
    expect(pick(toHex(o), NAMES)).toBe(pick(o, NAMES));
    expect(() => outputBytes('abc')).toThrow(/64 hex/);
    expect(() => outputBytes(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('gives the same answer for the same output and list, every time', () => {
    for (let i = 0; i < 20; i++) {
      const o = output(i);
      expect(pick(o, NAMES)).toBe(pick(Uint8Array.from(o), [...NAMES]));
      expect(shuffle(o, NAMES)).toEqual(shuffle(o, NAMES));
      expect(rollDice(o, 3, 20)).toEqual(rollDice(o, 3, 20));
    }
  });

  it('picks every name about equally often', () => {
    const counts = new Map(NAMES.map((n) => [n, 0]));
    const runs = 5000;
    for (let i = 0; i < runs; i++) {
      const n = pick(output(i), NAMES);
      counts.set(n, counts.get(n)! + 1);
    }
    // 1000 expected each; 5 standard deviations is about ±140
    for (const c of counts.values()) expect(Math.abs(c - runs / NAMES.length)).toBeLessThan(150);
  });

  it('picks several different names, the first of a full shuffle, and leaves the list alone', () => {
    const list = Object.freeze([...NAMES]);
    for (let i = 0; i < 200; i++) {
      const o = output(i);
      const three = pickMany(o, list, 3);
      expect(new Set(three).size).toBe(3);
      expect(three.every((n) => NAMES.includes(n))).toBe(true);
      const all = shuffle(o, list);
      expect([...all].sort()).toEqual([...NAMES].sort());
      expect(all.slice(0, 3)).toEqual(three);
      expect(pickMany(o, list, 0)).toEqual([]);
    }
    expect(list).toEqual(NAMES);
    expect(() => pickMany(output(1), NAMES, 6)).toThrow(/0 to 5/);
    expect(() => pick(output(1), [])).toThrow(/empty/);
  });

  it('shuffles fairly: each name lands first equally often', () => {
    const first = new Map(NAMES.map((n) => [n, 0]));
    for (let i = 0; i < 5000; i++) {
      const s = shuffle(output(`s${i}`), NAMES);
      first.set(s[0], first.get(s[0])! + 1);
    }
    for (const c of first.values()) expect(Math.abs(c - 1000)).toBeLessThan(150);
  });

  it('rolls dice and whole numbers within range, reading separate words with `from`', () => {
    for (let i = 0; i < 300; i++) {
      const o = output(i);
      for (const d of rollDice(o, 4)) expect(d >= 1 && d <= 6).toBe(true);
      const n = randomInt(o, -3, 3);
      expect(n >= -3 && n <= 3).toBe(true);
      expect(randomInt(o, 7, 7)).toBe(7);
      // die i of a roll reads word from + i
      expect(rollDice(o, 2, 6, { from: 5 })).toEqual([rollDice(o, 1, 6, { from: 5 })[0], rollDice(o, 1, 6, { from: 6 })[0]]);
    }
    const sixes = Array.from({ length: 6000 }, (_, i) => rollDice(output(`d${i}`))[0]).filter((d) => d === 6).length;
    expect(Math.abs(sixes - 1000)).toBeLessThan(150);
    expect(() => randomInt(output(1), 5, 4)).toThrow(/min ≤ max/);
    expect(() => rollDice(output(1), 1, 1)).toThrow(/sides/);
    expect(() => pick(output(1), NAMES, { from: -1 })).toThrow(/from/);
  });

  it('picks by weight, exactly as often as the weights say, never a weight of 0', () => {
    const counts: Record<string, number> = { gold: 0, silver: 0, bronze: 0, none: 0 };
    for (let i = 0; i < 10_000; i++) counts[weightedPick(output(`w${i}`), { gold: 1, silver: 3, bronze: 6, none: 0 })]++;
    expect(counts.none).toBe(0);
    expect(Math.abs(counts.gold - 1000)).toBeLessThan(150);
    expect(Math.abs(counts.silver - 3000)).toBeLessThan(250);
    expect(Math.abs(counts.bronze - 6000)).toBeLessThan(250);
    // pairs keep any kind of choice
    const prize = weightedPick(output(1), [[{ id: 1 }, 1], [{ id: 2 }, 1]] as const);
    expect([1, 2]).toContain(prize.id);
    expect(() => weightedPick(output(1), { a: 0 })).toThrow(/more than 0/);
    expect(() => weightedPick(output(1), { a: 1.5 })).toThrow(/whole number/);
    expect(() => weightedPick(output(1), {})).toThrow(/no weights/);
  });

  it("fingerprints a list so that any change shows, matching the published vectors", () => {
    expect(listCommitment(NAMES)).toBe('c3ebd384df5168f0c0f987dffed832806684c536ffd0316ec05748ae25d3ce42');
    expect(listCommitment([])).toBe('b9123b4146e414e61c4593d1ad565052a98e5d0c68ffa370cb411daecc79325e');
    expect(listCommitment(['Zoë'])).toBe('94ffe568f03482a52cdfc82bfedc8056617f872d5f8b84959c453cdc71fd2a0b');
    // joining items, reordering or adding one changes it
    expect(listCommitment(['AvaBen'])).not.toBe(listCommitment(['Ava', 'Ben']));
    expect(listCommitment(['Ben', 'Ava', 'Chloe', 'Dev', 'Ella'])).not.toBe(listCommitment(NAMES));
  });

  it('runs a fair raffle end to end on the simulator: list fixed in the request, answer, winners anyone can recheck', () => {
    const sim = new NightcastSimulator({ oracleSecretKey: generateOracleSecretKey(), operatorSecret: new Uint8Array(32).fill(1) });
    const seed = Buffer.from(listCommitment(NAMES), 'hex');
    const tag = Buffer.alloc(32);
    tag.write('raffle #1');
    const id = sim.request(tag, seed, BigInt(sim.now + 600));
    sim.fulfil(id);
    const answered = sim.getLedger().requests.lookup(id);
    const winners = pickMany(answered.output, NAMES, 2);
    expect(new Set(winners).size).toBe(2);
    // someone checking later: the same published list gives the same seed, id and winners
    expect(toHex(sim.idFor(tag, Buffer.from(listCommitment([...NAMES]), 'hex')))).toBe(toHex(id));
    expect(pickMany(toHex(answered.output), [...NAMES], 2)).toEqual(winners);
    // a list changed afterwards no longer matches the request
    expect(toHex(sim.idFor(tag, Buffer.from(listCommitment([...NAMES, 'Finn']), 'hex')))).not.toBe(toHex(id));
  });
});
