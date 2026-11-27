import { describe, expect, it } from 'vitest';
import { generateOperatorSecret, generateOracleSecretKey, NightcastSimulator, oraclePublicKey, pureCircuits } from '@nightcast/contract';
import { BATCH_TAG, clientId, commitOf, leafOf, newSalt, PUBLIC_SALT, refId, sealBatch, seedFromPath, valueOf } from '../batch.js';
import { SimulatorChain } from '../chain.js';
import { checkFastAnswer, fastAnswer, JUBJUB_ORDER, outputOfGamma } from '../fast-answer.js';
import { batchRequest, checkReceipt, checkReceiptOnChain, makeReceipt, withSalt } from '../receipt.js';
import { ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && hex(a) === hex(b);

describe('batch tree', () => {
  it('gives every entry a path to the seed, for every size up to 70', () => {
    for (let n = 1; n <= 70; n++) {
      const entries = Array.from({ length: n }, (_, i) => ({ client: clientId('app'), ref: refId(`round ${i}`), commit: commitOf(PUBLIC_SALT) }));
      const b = sealBatch(entries);
      for (let i = 0; i < n; i++) {
        const path = b.pathOf(i);
        expect(same(seedFromPath(b.leaves[i], i, n, path), b.seed)).toBe(true);
        // The same path doesn't lead there as another entry, in a batch of another size, or altered.
        if (n > 1) expect(same(seedFromPath(b.leaves[i], (i + 1) % n, n, path), b.seed)).toBe(false);
        expect(same(seedFromPath(b.leaves[i], i, n + 1, path), b.seed)).toBe(false);
        if (path.length) {
          const bad = [...path];
          bad[bad.length - 1] = new Uint8Array(32);
          expect(same(seedFromPath(b.leaves[i], i, n, bad), b.seed)).toBe(false);
          expect(seedFromPath(b.leaves[i], i, n, path.slice(1))).toBeUndefined();
        }
      }
    }
  });

  it('refuses two identical entries and an empty batch', () => {
    const e = { client: clientId('app'), ref: refId('x'), commit: commitOf(PUBLIC_SALT) };
    expect(() => sealBatch([e, { ...e }])).toThrow(/same/);
    expect(() => sealBatch([])).toThrow(RangeError);
  });

  it('changes the seed when an entry, the order or the size changes', () => {
    const es = Array.from({ length: 5 }, (_, i) => ({ client: clientId('app'), ref: refId(`r${i}`), commit: commitOf(newSalt()) }));
    const a = sealBatch(es).seed;
    expect(same(sealBatch([...es].reverse()).seed, a)).toBe(false);
    expect(same(sealBatch(es.slice(0, 4)).seed, a)).toBe(false);
    expect(same(sealBatch([{ ...es[0], ref: refId('other') }, ...es.slice(1)]).seed, a)).toBe(false);
  });
});

describe('fast answer', () => {
  it("gives the contract's own output (evaluate) for the request's point", () => {
    for (let i = 0; i < 5; i++) {
      const sk = generateOracleSecretKey();
      const alpha = Uint8Array.from(Buffer.from(newSalt()));
      const point = pureCircuits.inputPoint(alpha);
      const a = fastAnswer(sk, point);
      expect(hex(a.output)).toBe(hex(pureCircuits.evaluate(sk, alpha)));
      expect(hex(outputOfGamma(a.gamma))).toBe(hex(pureCircuits.evaluateAt(sk, point)));
      expect(checkFastAnswer(oraclePublicKey(sk), point, a.gamma, a.proof)).toBe(true);
    }
  });

  it('is refused for another key, another point, another gamma or an altered proof', () => {
    const sk = generateOracleSecretKey();
    const point = pureCircuits.inputPoint(newSalt());
    const a = fastAnswer(sk, point);
    const pk = oraclePublicKey(sk);
    expect(checkFastAnswer(oraclePublicKey(generateOracleSecretKey()), point, a.gamma, a.proof)).toBe(false);
    expect(checkFastAnswer(pk, pureCircuits.inputPoint(newSalt()), a.gamma, a.proof)).toBe(false);
    expect(checkFastAnswer(pk, point, ecMulGenerator(5n), a.proof)).toBe(false);
    expect(checkFastAnswer(pk, point, a.gamma, { ...a.proof, s: (a.proof.s + 1n) % JUBJUB_ORDER })).toBe(false);
    expect(checkFastAnswer(pk, point, a.gamma, { ...a.proof, u: ecMul(a.proof.u, 2n) })).toBe(false);
    expect(checkFastAnswer(pk, point, { x: 5n, y: 7n }, a.proof)).toBe(false);
  });

  it('is the same each time (no randomness needed)', () => {
    const sk = generateOracleSecretKey();
    const point = pureCircuits.inputPoint(newSalt());
    const a = fastAnswer(sk, point);
    const b = fastAnswer(sk, point);
    expect(a.proof.s).toBe(b.proof.s);
    expect(hex(a.output)).toBe(hex(b.output));
  });
});

describe('a batch through the simulated contract', () => {
  const setup = (n: number) => {
    const sk = generateOracleSecretKey();
    const sim = new NightcastSimulator({ oracleSecretKey: sk, operatorSecret: generateOperatorSecret(), minWindow: 60n, maxWindow: 3_600n });
    const chain = new SimulatorChain(sim, sk);
    const salts = Array.from({ length: n }, () => newSalt());
    const entries = salts.map((salt, i) => ({ client: clientId('raffle-app'), ref: refId(`ticket ${i}`), commit: commitOf(salt) }));
    const batch = sealBatch(entries);
    const requester = pureCircuits.requesterCommitmentOf(sim.requester.requesterSecret!);
    const id = sim.request(BATCH_TAG, batch.seed, BigInt(sim.now + 600));
    const point = sim.getLedger().requests.lookup(id).point;
    const answer = fastAnswer(sk, point);
    const receipt = (i: number, salt?: Uint8Array) =>
      makeReceipt({
        contract: sim.addressBytes, requester, oracleKey: oraclePublicKey(sk), size: n, requestId: id, index: i,
        entry: entries[i], path: batch.pathOf(i), answer, salt,
      });
    return { sk, sim, chain, salts, entries, batch, requester, id, point, answer, receipt };
  };

  it('works out the same request and point as the contract', () => {
    const t = setup(7);
    const br = batchRequest(t.sim.addressBytes, t.requester, t.batch.seed);
    expect(hex(br.id)).toBe(hex(t.id));
    expect(br.point).toEqual(t.point);
  });

  it("gives each person a checked number, and the on-chain answer matches", async () => {
    const t = setup(25);
    const values = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = t.receipt(i, t.salts[i]);
      const c = checkReceipt(JSON.parse(JSON.stringify(r)));
      expect(c.problems).toEqual([]);
      expect(c.ok).toBe(true);
      expect(hex(c.value!)).toBe(hex(valueOf(t.answer.output, leafOf(t.entries[i]), t.salts[i])));
      values.add(hex(c.value!));
      const before = await checkReceiptOnChain(r, t.chain);
      expect(before.ok).toBe(true);
      expect(before.onChain).toEqual({ requested: true, answered: false });
    }
    expect(values.size).toBe(25);
    t.sim.fulfil(t.id);
    const after = await checkReceiptOnChain(t.receipt(3, t.salts[3]), t.chain);
    expect(after.ok).toBe(true);
    expect(after.onChain).toEqual({ requested: true, answered: true });
    expect(hex(t.sim.getLedger().requests.lookup(t.id).output)).toBe(hex(t.answer.output));
  });

  it('checks a receipt without the salt, and adds the number once the salt is shown', () => {
    const t = setup(3);
    const r = t.receipt(1);
    const c = checkReceipt(r);
    expect(c.ok).toBe(true);
    expect(c.value).toBeUndefined();
    const shown = withSalt(r, t.salts[1]);
    expect(checkReceipt(shown).ok).toBe(true);
    expect(() => withSalt(r, t.salts[0])).toThrow(/salt/);
  });

  it('refuses altered receipts', async () => {
    const t = setup(6);
    const good = t.receipt(2, t.salts[2]);
    const variants = [
      { ...good, entry: { ...good.entry, index: 3 } },
      { ...good, entry: { ...good.entry, ref: hex(refId('another round')) } },
      { ...good, entry: { ...good.entry, salt: hex(t.salts[1]) } },
      { ...good, value: hex(new Uint8Array(32)) },
      { ...good, batch: { ...good.batch, size: 7 } },
      { ...good, requester: hex(new Uint8Array(32).fill(9)) },
      { ...good, oracleKey: { x: oraclePublicKey(generateOracleSecretKey()).x.toString(16), y: oraclePublicKey(generateOracleSecretKey()).y.toString(16) } },
      { ...good, answer: { ...good.answer, proof: { ...good.answer.proof, s: '1' } } },
      { ...good, format: 'something else' as 'nightcast-batch-receipt/1' },
    ];
    for (const v of variants) expect(checkReceipt(v).ok).toBe(false);
    // A receipt for a request that was never made.
    const other = setup(6);
    expect((await checkReceiptOnChain(good, other.chain)).ok).toBe(false);
  });
});
