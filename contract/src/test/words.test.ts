/**
 * NightcastWords: the JS twins give what the circuit gives (checked by the
 * zkir check a proof server runs before proving), the SHA-256 word is the
 * Nightcast contract's own, and the Poseidon word has the shape the docs say.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  type ChargedState,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  proofDataIntoSerializedPreimage,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as zkir from '@midnight-ntwrk/zkir-v2';
import { pureCircuits as nightcast } from '../managed/nightcast/contract/index.js';
import { FIELD_SIZE, words } from '../words.js';
import { Contract } from './managed/words-probe/contract/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ZKIR = fileURLToPath(new URL('./managed/words-probe/zkir/probe.zkir', import.meta.url));

const ir = zkir.jsonIrToBinary(readFileSync(ZKIR, 'utf8'));
const provider = {
  async lookupKey() {
    return { ir, proverKey: new Uint8Array(), verifierKey: new Uint8Array() };
  },
  async getParams(): Promise<Uint8Array> {
    throw new Error('checking needs no parameters');
  },
};

const probe = new Contract({});
const address = sampleContractAddress();
let state: ContractState | ChargedState = probe.initialState(createConstructorContext({}, '0'.repeat(64))).currentContractState;

/** Runs the probe circuit with these expectations, then the zkir check on that run. */
const proveSame = async (output: Uint8Array, index: bigint, sha: Uint8Array, poseidon: Uint8Array, field: bigint) => {
  const ctx = createCircuitContext(address, '0'.repeat(64), state, {});
  const r = probe.impureCircuits.probe(ctx, output, index, sha, poseidon, field);
  state = r.context.currentQueryContext.state;
  const p = r.proofData;
  const preimage = proofDataIntoSerializedPreimage(p.input, p.output, p.publicTranscript, p.privateTranscriptOutputs, 'probe');
  await zkir.check(preimage, provider);
};

describe('NightcastWords', () => {
  it('randomWord is the Nightcast contract’s own (SHA-256)', () => {
    for (let i = 0; i < 5; i++) {
      const out = webcrypto.getRandomValues(new Uint8Array(32));
      expect(hex(words.randomWord(out, BigInt(i)))).toBe(hex(nightcast.randomWord(out, BigInt(i))));
    }
  });

  it('gives in a circuit exactly what the JS gives, for both hashes', async () => {
    for (let i = 0; i < 6; i++) {
      const out = webcrypto.getRandomValues(new Uint8Array(32));
      const n = BigInt(i * 1000 + i);
      await proveSame(out, n, words.randomWord(out, n), words.randomWordPoseidon(out, n), words.randomWordPoseidonField(out, n));
    }
  }, 60_000);

  it('a wrong word fails in the circuit', () => {
    const out = new Uint8Array(32).fill(3);
    const wrong = words.randomWordPoseidon(out, 1n);
    expect(() =>
      probe.impureCircuits.probe(
        createCircuitContext(address, '0'.repeat(64), state, {}),
        out,
        0n,
        words.randomWord(out, 0n),
        wrong,
        words.randomWordPoseidonField(out, 0n),
      ),
    ).toThrow(/Poseidon word differs/);
  });

  it('test vectors (Compact 0.31.1, compact-runtime 0.16.0)', () => {
    const zero = new Uint8Array(32);
    expect(hex(words.randomWord(zero, 0n))).toBe(hex(nightcast.randomWord(zero, 0n)));
    expect(words.randomWordPoseidonField(zero, 0n).toString(16)).toBe('71a405339645d2728bb60151f251f7b47e92e77573efd1b3564c2fe8506ed575');
    expect(hex(words.randomWordPoseidon(zero, 0n))).toBe('75d56e50e82f4c56b3d1ef7375e7927eb4f751f25101b68b72d245963305a400');
    expect(hex(words.randomWordPoseidon(zero, 1n))).toBe('69f503ac50cfd4c7eb3236e3a5d6af775eb49c14f5d61ab70226360b1eb08f00');
  });

  it('a Poseidon word is a field element: below FIELD_SIZE, bytes little-endian with the top byte dropped', () => {
    expect(FIELD_SIZE.toString(16)).toBe('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001');
    for (let i = 0; i < 50; i++) {
      const out = webcrypto.getRandomValues(new Uint8Array(32));
      const f = words.randomWordPoseidonField(out, BigInt(i));
      const b = words.randomWordPoseidon(out, BigInt(i));
      expect(f < FIELD_SIZE).toBe(true);
      expect(b[31]).toBe(0);
      const le = BigInt('0x' + hex(Uint8Array.from(b).reverse()));
      expect(le).toBe(f % (1n << 248n));
    }
  });

  it('SHA-256 and Poseidon words for the same output and index are unrelated', () => {
    const out = new Uint8Array(32).fill(1);
    expect(hex(words.randomWordPoseidon(out, 0n))).not.toBe(hex(words.randomWord(out, 0n)));
  });
});
