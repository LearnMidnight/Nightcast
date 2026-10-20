import { describe, it, expect, beforeEach } from 'vitest';
import { pureCircuits, Status } from '../managed/nightcast/contract/index.js';
import { NightcastSimulator } from '../simulator.js';
import {
  generateOperatorSecret,
  generateOracleSecretKey,
  oraclePublicKey,
  JUBJUB_ORDER,
  parseOracleSecretKey,
  formatOracleSecretKey,
} from '../keys.js';

const bytes = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).slice(0, 32));
  return out;
};
const ZERO = new Uint8Array(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const MIN = 60n;
const MAX = 3_600n;

const fresh = () => {
  const oracleSecretKey = generateOracleSecretKey();
  const operatorSecret = generateOperatorSecret();
  const sim = new NightcastSimulator({
    oracleSecretKey,
    operatorSecret,
    operatorCommitment: pureCircuits.operatorCommitmentOf(operatorSecret),
    minWindow: MIN,
    maxWindow: MAX,
  });
  return { sim, oracleSecretKey, operatorSecret };
};

describe('keys', () => {
  it('generates secret keys inside the Jubjub scalar range', () => {
    for (let i = 0; i < 50; i++) {
      const sk = generateOracleSecretKey();
      expect(sk > 0n && sk < JUBJUB_ORDER).toBe(true);
    }
  });

  it('round-trips a secret key through hex', () => {
    const sk = generateOracleSecretKey();
    expect(parseOracleSecretKey(formatOracleSecretKey(sk))).toBe(sk);
    expect(() => parseOracleSecretKey('00')).toThrow();
    expect(() => parseOracleSecretKey(JUBJUB_ORDER.toString(16))).toThrow();
  });

  it('derives the same public key for the same secret and different ones otherwise', () => {
    const sk = generateOracleSecretKey();
    expect(oraclePublicKey(sk)).toEqual(oraclePublicKey(sk));
    expect(oraclePublicKey(sk)).not.toEqual(oraclePublicKey(generateOracleSecretKey()));
  });
});

describe('deployment', () => {
  it('records the oracle key, operator and windows', () => {
    const { sim, oracleSecretKey, operatorSecret } = fresh();
    const l = sim.getLedger();
    expect(l.oracleKey).toEqual(oraclePublicKey(oracleSecretKey));
    expect(hex(l.operator)).toBe(hex(pureCircuits.operatorCommitmentOf(operatorSecret)));
    expect(l.minWindow).toBe(MIN);
    expect(l.maxWindow).toBe(MAX);
    expect(l.requestCount).toBe(0n);
    expect(l.requests.isEmpty()).toBe(true);
  });
});

describe('request', () => {
  let sim: NightcastSimulator;
  beforeEach(() => ({ sim } = fresh()));

  it('stores a pending request whose id is the published requestId', () => {
    const tag = bytes('midnight-lotto|m6|1001');
    const seed = bytes('seed-1');
    const deadline = BigInt(sim.now) + 600n;
    const id = sim.request(tag, seed, deadline);

    expect(hex(id)).toBe(hex(pureCircuits.requestId({ bytes: sim.addressBytes }, tag, seed)));
    const l = sim.getLedger();
    expect(l.requestCount).toBe(1n);
    const r = l.requests.lookup(id);
    expect(r.status).toBe(Status.pending);
    expect(hex(r.tag)).toBe(hex(tag));
    expect(r.deadline).toBe(deadline);
    expect(r.oracleKey).toEqual(l.oracleKey);
    expect(hex(r.output)).toBe(hex(ZERO));
  });

  it('rejects a repeated tag and seed', () => {
    const deadline = BigInt(sim.now) + 600n;
    sim.request(bytes('t'), bytes('s'), deadline);
    expect(() => sim.request(bytes('t'), bytes('s'), deadline)).toThrow(/already exists/);
    // A new seed for the same tag is a new request.
    sim.request(bytes('t'), bytes('s2'), deadline);
    expect(sim.getLedger().requestCount).toBe(2n);
  });

  it('gives different ids to different deployments', () => {
    const other = fresh().sim;
    const id1 = sim.request(bytes('t'), bytes('s'), BigInt(sim.now) + 600n);
    expect(hex(pureCircuits.requestId({ bytes: other.addressBytes }, bytes('t'), bytes('s')))).not.toBe(
      hex(id1),
    );
  });

  it('enforces the deadline window', () => {
    const now = BigInt(sim.now);
    expect(() => sim.request(bytes('t'), bytes('a'), now + MIN)).toThrow(/too soon/);
    expect(() => sim.request(bytes('t'), bytes('b'), now + MAX + 1n)).toThrow(/too far/);
    expect(() => sim.request(bytes('t'), bytes('c'), 5n)).toThrow(/out of range/);
    sim.request(bytes('t'), bytes('d'), now + MIN + 1n);
    sim.request(bytes('t'), bytes('e'), now + MAX);
    expect(sim.getLedger().requestCount).toBe(2n);
  });
});

describe('fulfil', () => {
  let sim: NightcastSimulator;
  let sk: bigint;
  let id: Uint8Array;
  let deadline: bigint;

  beforeEach(() => {
    ({ sim, oracleSecretKey: sk } = fresh());
    deadline = BigInt(sim.now) + 600n;
    id = sim.request(bytes('game'), bytes('draw-1'), deadline);
  });

  it('stores the VRF output for the request', () => {
    const out = sim.fulfil(id);
    expect(hex(out)).toBe(hex(pureCircuits.evaluate(sk, id)));
    expect(hex(out)).not.toBe(hex(ZERO));
    const r = sim.getLedger().requests.lookup(id);
    expect(r.status).toBe(Status.fulfilled);
    expect(hex(r.output)).toBe(hex(out));
  });

  it('rejects anyone without the oracle key', () => {
    expect(() => sim.fulfil(id, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the oracle/);
    expect(() => sim.fulfil(id, sim.anyone)).toThrow(/no oracle secret key/);
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.pending);
  });

  it('cannot be fulfilled twice', () => {
    sim.fulfil(id);
    expect(() => sim.fulfil(id)).toThrow(/not pending/);
  });

  it('rejects unknown requests', () => {
    expect(() => sim.fulfil(bytes('nope'))).toThrow(/unknown request/);
  });

  it('must land before the deadline', () => {
    sim.now = Number(deadline);
    expect(() => sim.fulfil(id)).toThrow(/expired/);
  });

  it('gives the same output for the same key and input, and different outputs otherwise', () => {
    const id2 = sim.request(bytes('game'), bytes('draw-2'), deadline);
    const a = sim.fulfil(id);
    const b = sim.fulfil(id2);
    expect(hex(a)).not.toBe(hex(b));
    expect(hex(pureCircuits.evaluate(sk, id))).toBe(hex(a));
    expect(hex(pureCircuits.evaluate(generateOracleSecretKey(), id))).not.toBe(hex(a));
  });
});

describe('expire', () => {
  it('voids a request the oracle missed', () => {
    const { sim } = fresh();
    const deadline = BigInt(sim.now) + 600n;
    const id = sim.request(bytes('t'), bytes('s'), deadline);
    expect(() => sim.expire(id)).toThrow(/not passed/);
    sim.now = Number(deadline);
    sim.expire(id);
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.expired);
    expect(() => sim.fulfil(id)).toThrow(/not pending/);
    expect(() => sim.expire(id)).toThrow(/not pending/);
  });

  it('cannot void a fulfilled request', () => {
    const { sim } = fresh();
    const deadline = BigInt(sim.now) + 600n;
    const id = sim.request(bytes('t'), bytes('s'), deadline);
    sim.fulfil(id);
    sim.now = Number(deadline) + 1;
    expect(() => sim.expire(id)).toThrow(/not pending/);
  });
});

describe('operator', () => {
  it('rotates the oracle key for new requests only', () => {
    const { sim, oracleSecretKey: oldSk } = fresh();
    const deadline = BigInt(sim.now) + 600n;
    const oldId = sim.request(bytes('t'), bytes('before'), deadline);

    const newSk = generateOracleSecretKey();
    sim.setOracleKey(oraclePublicKey(newSk));
    const newId = sim.request(bytes('t'), bytes('after'), deadline);

    expect(sim.getLedger().requests.lookup(newId).oracleKey).toEqual(oraclePublicKey(newSk));
    // The old request stays bound to the old key.
    expect(() => sim.fulfil(oldId, { oracleSecretKey: newSk })).toThrow(/not the oracle/);
    expect(() => sim.fulfil(newId, { oracleSecretKey: oldSk })).toThrow(/not the oracle/);
    expect(hex(sim.fulfil(oldId, { oracleSecretKey: oldSk }))).toBe(hex(pureCircuits.evaluate(oldSk, oldId)));
    expect(hex(sim.fulfil(newId, { oracleSecretKey: newSk }))).toBe(hex(pureCircuits.evaluate(newSk, newId)));
  });

  it('only lets the operator change settings', () => {
    const { sim } = fresh();
    const stranger = { operatorSecret: generateOperatorSecret() };
    expect(() => sim.setOracleKey(oraclePublicKey(generateOracleSecretKey()), stranger)).toThrow(/not the operator/);
    expect(() => sim.setOperator(new Uint8Array(32), stranger)).toThrow(/not the operator/);
    expect(() => sim.setOracleKey(oraclePublicKey(generateOracleSecretKey()), sim.anyone)).toThrow(
      /no operator secret/,
    );
  });

  it('hands over the operator role', () => {
    const { sim } = fresh();
    const next = generateOperatorSecret();
    sim.setOperator(pureCircuits.operatorCommitmentOf(next));
    expect(() => sim.setOracleKey(oraclePublicKey(generateOracleSecretKey()))).toThrow(/not the operator/);
    sim.setOracleKey(oraclePublicKey(generateOracleSecretKey()), { operatorSecret: next });
  });
});

describe('randomWord', () => {
  it('expands one output into distinct, repeatable words', () => {
    const out = pureCircuits.evaluate(generateOracleSecretKey(), bytes('x'));
    const words = Array.from({ length: 8 }, (_, i) => hex(pureCircuits.randomWord(out, BigInt(i))));
    expect(new Set(words).size).toBe(8);
    expect(hex(pureCircuits.randomWord(out, 3n))).toBe(words[3]);
  });

  it('produces outputs with balanced bits', () => {
    const sk = generateOracleSecretKey();
    let ones = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const out = pureCircuits.evaluate(sk, bytes(`input-${i}`));
      for (const byte of out) for (let b = 0; b < 8; b++) ones += (byte >> b) & 1;
    }
    const share = ones / (n * 256);
    expect(share).toBeGreaterThan(0.48);
    expect(share).toBeLessThan(0.52);
  });
});
