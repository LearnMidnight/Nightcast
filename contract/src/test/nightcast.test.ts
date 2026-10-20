import { describe, it, expect, beforeEach } from 'vitest';
import { Contract, pureCircuits, Status } from '../managed/nightcast/contract/index.js';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { NightcastSimulator } from '../simulator.js';
import { witnesses } from '../witnesses.js';
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
const IDENTITY = { x: 0n, y: 1n };

const MIN = 60n;
const MAX = 3_600n;

const fresh = (extra: { acceptKey?: boolean } = {}) => {
  const oracleSecretKey = generateOracleSecretKey();
  const operatorSecret = generateOperatorSecret();
  const sim = new NightcastSimulator({ oracleSecretKey, operatorSecret, minWindow: MIN, maxWindow: MAX, ...extra });
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

  it('maps the zero scalar to the identity point', () => {
    expect(pureCircuits.publicKey(0n)).toEqual(IDENTITY);
  });
});

describe('deployment', () => {
  it('records the proposed key, operator and windows, and waits for the oracle', () => {
    const { sim, oracleSecretKey, operatorSecret } = fresh({ acceptKey: false });
    const l = sim.getLedger();
    expect(l.oracleKeyReady).toBe(false);
    expect(l.proposedOracleKey.is_some).toBe(true);
    expect(l.proposedOracleKey.value).toEqual(oraclePublicKey(oracleSecretKey));
    expect(hex(l.operator)).toBe(hex(pureCircuits.operatorCommitmentOf(operatorSecret)));
    expect(l.minWindow).toBe(MIN);
    expect(l.maxWindow).toBe(MAX);
    expect(l.requestCount).toBe(0n);
    expect(l.requests.isEmpty()).toBe(true);
    expect(() => sim.request(bytes('t'), bytes('s'), BigInt(sim.now + 600))).toThrow(/no active oracle key/);
  });

  it('activates the key only for its holder', () => {
    const { sim, oracleSecretKey } = fresh({ acceptKey: false });
    expect(() => sim.acceptOracleKey({ oracleSecretKey: generateOracleSecretKey() })).toThrow(/does not match/);
    sim.acceptOracleKey();
    const l = sim.getLedger();
    expect(l.oracleKeyReady).toBe(true);
    expect(l.oracleKey).toEqual(oraclePublicKey(oracleSecretKey));
    expect(l.proposedOracleKey.is_some).toBe(false);
    expect(() => sim.acceptOracleKey()).toThrow(/no key proposed/);
  });

  it('refuses the identity point as a key', () => {
    const { sim } = fresh({ acceptKey: false });
    sim.proposeOracleKey(IDENTITY);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: 0n })).toThrow(/identity key/);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: JUBJUB_ORDER })).toThrow(/identity key/);
  });

  it('validates the window settings', () => {
    const c = new Contract(witnesses);
    const ctx = () => createConstructorContext({}, '0'.repeat(64));
    const key = oraclePublicKey(generateOracleSecretKey());
    expect(() => c.initialState(ctx(), key, ZERO, 59n, 600n)).toThrow(/at least 60/);
    expect(() => c.initialState(ctx(), key, ZERO, 600n, 600n)).toThrow(/below maxWindow/);
    expect(() => c.initialState(ctx(), key, ZERO, 60n, 2_592_001n)).toThrow(/at most 30 days/);
  });
});

describe('request', () => {
  let sim: NightcastSimulator;
  beforeEach(() => ({ sim } = fresh()));

  it('stores a pending request bound to its requester, key and input point', () => {
    const tag = bytes('midnight-lotto|m6|1001');
    const seed = bytes('seed-1');
    const deadline = BigInt(sim.now) + 600n;
    const id = sim.request(tag, seed, deadline);

    expect(hex(id)).toBe(hex(sim.idFor(tag, seed)));
    const l = sim.getLedger();
    expect(l.requestCount).toBe(1n);
    const r = l.requests.lookup(id);
    expect(r.status).toBe(Status.pending);
    expect(hex(r.requester)).toBe(hex(pureCircuits.requesterCommitmentOf(sim.requester.requesterSecret!)));
    expect(hex(r.tag)).toBe(hex(tag));
    expect(r.point).toEqual(pureCircuits.inputPoint(id));
    expect(r.deadline).toBe(deadline);
    expect(r.oracleKey).toEqual(l.oracleKey);
    expect(hex(r.output)).toBe(hex(ZERO));
  });

  it('needs a requester secret', () => {
    expect(() => sim.request(bytes('t'), bytes('s'), BigInt(sim.now) + 600n, sim.anyone)).toThrow(
      /no requester secret/,
    );
  });

  it('rejects a repeated tag and seed from the same requester', () => {
    const deadline = BigInt(sim.now) + 600n;
    sim.request(bytes('t'), bytes('s'), deadline);
    expect(() => sim.request(bytes('t'), bytes('s'), deadline)).toThrow(/already exists/);
    sim.request(bytes('t'), bytes('s2'), deadline);
    expect(sim.getLedger().requestCount).toBe(2n);
  });

  it("can't be squatted: someone else's identical tag and seed get a different id", () => {
    const deadline = BigInt(sim.now) + 600n;
    const attacker = { requesterSecret: bytes('attacker') };
    const theirs = sim.request(bytes('t'), bytes('s'), deadline, attacker);
    const mine = sim.request(bytes('t'), bytes('s'), deadline);
    expect(hex(theirs)).not.toBe(hex(mine));
    expect(hex(sim.getLedger().requests.lookup(mine).requester)).toBe(
      hex(pureCircuits.requesterCommitmentOf(sim.requester.requesterSecret!)),
    );
  });

  it('gives different ids to different deployments', () => {
    const other = fresh().sim;
    const id1 = sim.request(bytes('t'), bytes('s'), BigInt(sim.now) + 600n);
    expect(hex(other.idFor(bytes('t'), bytes('s')))).not.toBe(hex(id1));
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
    expect(hex(out)).toBe(hex(pureCircuits.evaluateAt(sk, sim.getLedger().requests.lookup(id).point)));
    expect(hex(out)).not.toBe(hex(ZERO));
    const r = sim.getLedger().requests.lookup(id);
    expect(r.status).toBe(Status.fulfilled);
    expect(hex(r.output)).toBe(hex(out));
  });

  it('gives the same output for a scalar congruent to the key', () => {
    // sk + order passes the key check but cannot change the result.
    const out = sim.fulfil(id, { oracleSecretKey: sk + JUBJUB_ORDER });
    expect(hex(out)).toBe(hex(pureCircuits.evaluate(sk, id)));
  });

  it('rejects anyone without the oracle key', () => {
    expect(() => sim.fulfil(id, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the oracle/);
    expect(() => sim.fulfil(id, { oracleSecretKey: 0n })).toThrow(/not the oracle/);
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

describe('key rotation', () => {
  it('applies to new requests only, and only once the new oracle accepts', () => {
    const { sim, oracleSecretKey: oldSk } = fresh();
    const deadline = BigInt(sim.now) + 600n;
    const oldId = sim.request(bytes('t'), bytes('before'), deadline);

    const newSk = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(newSk));
    // Still the old key until accepted.
    const midId = sim.request(bytes('t'), bytes('during'), deadline);
    expect(sim.getLedger().requests.lookup(midId).oracleKey).toEqual(oraclePublicKey(oldSk));

    sim.acceptOracleKey({ oracleSecretKey: newSk });
    const newId = sim.request(bytes('t'), bytes('after'), deadline);
    expect(sim.getLedger().requests.lookup(newId).oracleKey).toEqual(oraclePublicKey(newSk));

    expect(() => sim.fulfil(oldId, { oracleSecretKey: newSk })).toThrow(/not the oracle/);
    expect(() => sim.fulfil(newId, { oracleSecretKey: oldSk })).toThrow(/not the oracle/);
    expect(hex(sim.fulfil(oldId, { oracleSecretKey: oldSk }))).toBe(hex(pureCircuits.evaluate(oldSk, oldId)));
    expect(hex(sim.fulfil(newId, { oracleSecretKey: newSk }))).toBe(hex(pureCircuits.evaluate(newSk, newId)));
  });
});

describe('operator', () => {
  it('only lets the operator propose changes', () => {
    const { sim } = fresh();
    const stranger = { operatorSecret: generateOperatorSecret() };
    expect(() => sim.proposeOracleKey(oraclePublicKey(generateOracleSecretKey()), stranger)).toThrow(
      /not the operator/,
    );
    expect(() => sim.proposeOperator(new Uint8Array(32), stranger)).toThrow(/not the operator/);
    expect(() => sim.proposeOracleKey(oraclePublicKey(generateOracleSecretKey()), sim.anyone)).toThrow(
      /no operator secret/,
    );
  });

  it('hands over the role in two steps', () => {
    const { sim, operatorSecret } = fresh();
    const next = generateOperatorSecret();
    expect(() => sim.acceptOperator({ operatorSecret: next })).toThrow(/no operator proposed/);
    sim.proposeOperator(pureCircuits.operatorCommitmentOf(next));
    // A typo'd or wrong secret can't take over, and the old operator stays in charge.
    expect(() => sim.acceptOperator({ operatorSecret: generateOperatorSecret() })).toThrow(/not the proposed/);
    sim.proposeOracleKey(oraclePublicKey(generateOracleSecretKey()), { operatorSecret });

    sim.acceptOperator({ operatorSecret: next });
    expect(hex(sim.getLedger().operator)).toBe(hex(pureCircuits.operatorCommitmentOf(next)));
    expect(() => sim.proposeOracleKey(oraclePublicKey(generateOracleSecretKey()), { operatorSecret })).toThrow(
      /not the operator/,
    );
    sim.proposeOracleKey(oraclePublicKey(generateOracleSecretKey()), { operatorSecret: next });
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
