import { describe, it, expect } from 'vitest';
import {
  generateOperatorSecret,
  generateOracleSecretKey,
  NightcastSimulator,
  oraclePublicKey,
  pureCircuits,
  Status,
} from '@nightcast/contract';
import { SimulatorChain } from '../chain.js';
import { NightcastOracle, selectWork } from '../oracle.js';
import { generateKeys } from '../keygen.js';

const label = (s: string): Uint8Array => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s).slice(0, 32));
  return b;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const setup = () => {
  const sk = generateOracleSecretKey();
  const operatorSecret = generateOperatorSecret();
  const sim = new NightcastSimulator({
    oracleSecretKey: sk,
    operatorSecret,
    operatorCommitment: pureCircuits.operatorCommitmentOf(operatorSecret),
    minWindow: 60n,
    maxWindow: 3_600n,
  });
  const oracle = new NightcastOracle({ chain: new SimulatorChain(sim, sk), secretKey: sk, safetyMarginSecs: 30 });
  return { sk, sim, oracle };
};

describe('NightcastOracle', () => {
  it('fulfils every pending request with the expected output', async () => {
    const { sim, oracle, sk } = setup();
    const ids = [1, 2, 3].map((i) => sim.request(label('game'), label(`draw-${i}`), BigInt(sim.now + 600)));

    const report = await oracle.tick();
    expect(report.fulfilled.sort()).toEqual(ids.map(hex).sort());

    for (const id of ids) {
      const r = sim.getLedger().requests.lookup(id);
      expect(r.status).toBe(Status.fulfilled);
      expect(hex(r.output)).toBe(hex(pureCircuits.evaluate(sk, id)));
      expect(hex(oracle.expectedOutput(id))).toBe(hex(r.output));
    }

    // Nothing left to do on the next pass.
    expect((await oracle.tick()).fulfilled).toEqual([]);
  });

  it('ignores requests bound to another key', async () => {
    const { sim, oracle } = setup();
    const other = generateOracleSecretKey();
    sim.setOracleKey(oraclePublicKey(other));
    const id = sim.request(label('g'), label('s'), BigInt(sim.now + 600));
    const report = await oracle.tick();
    expect(report.fulfilled).toEqual([]);
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.pending);
  });

  it('leaves requests that are too close to their deadline', async () => {
    const { sim, oracle } = setup();
    const id = sim.request(label('g'), label('s'), BigInt(sim.now + 100));
    sim.advance(80); // 20 s left, under the 30 s margin
    const report = await oracle.tick();
    expect(report.fulfilled).toEqual([]);
    expect(report.skipped).toEqual([{ id: hex(id), reason: 'too close to deadline' }]);
  });

  it('records failures and gives up after maxAttempts', async () => {
    const { sim, sk } = setup();
    const id = sim.request(label('g'), label('s'), BigInt(sim.now + 600));
    let calls = 0;
    const chain = new SimulatorChain(sim, sk);
    const flaky = {
      listRequests: () => chain.listRequests(),
      now: () => chain.now(),
      fulfil: async () => {
        calls++;
        throw new Error('node unavailable');
      },
    };
    const oracle = new NightcastOracle({ chain: flaky, secretKey: sk, maxAttempts: 2 });
    expect((await oracle.tick()).failed).toEqual([{ id: hex(id), error: 'node unavailable' }]);
    expect((await oracle.tick()).failed).toHaveLength(1);
    expect((await oracle.tick()).skipped).toEqual([{ id: hex(id), reason: 'gave up after 2 attempts' }]);
    expect(calls).toBe(2);
  });

  it('never runs two passes at once', async () => {
    const { sim, oracle } = setup();
    sim.request(label('g'), label('s'), BigInt(sim.now + 600));
    const [a, b] = await Promise.all([oracle.tick(), oracle.tick()]);
    expect(a).toBe(b);
    expect(a.fulfilled).toHaveLength(1);
  });

  it('polls until stopped', async () => {
    const { sim, sk } = setup();
    const oracle = new NightcastOracle({ chain: new SimulatorChain(sim, sk), secretKey: sk, pollMs: 10 });
    oracle.start();
    const id = sim.request(label('g'), label('later'), BigInt(sim.now + 600));
    for (let i = 0; i < 50 && sim.getLedger().requests.lookup(id).status !== Status.fulfilled; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await oracle.stop();
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.fulfilled);
  });
});

describe('selectWork', () => {
  it('orders by deadline and splits off late requests', () => {
    const key = { x: 1n, y: 2n };
    const mk = (id: number, deadline: bigint, status = Status.pending, k = key) => ({
      id: new Uint8Array([id]),
      request: { status, tag: new Uint8Array(32), oracleKey: k, deadline, output: new Uint8Array(32) },
    });
    const { todo, tooLate } = selectWork(
      [mk(1, 500n), mk(2, 200n), mk(3, 120n), mk(4, 400n, Status.fulfilled), mk(5, 300n, Status.pending, { x: 9n, y: 9n })],
      key,
      100,
      30,
    );
    expect(todo.map((e) => e.id[0])).toEqual([2, 1]);
    expect(tooLate.map((e) => e.id[0])).toEqual([3]);
  });
});

describe('generateKeys', () => {
  it('produces a matching key pair and operator commitment', () => {
    const k = generateKeys();
    const pk = oraclePublicKey(BigInt('0x' + k.oracleSecretKey));
    expect(k.oraclePublicKey).toEqual({ x: pk.x.toString(), y: pk.y.toString() });
    expect(k.operatorCommitment).toBe(hex(pureCircuits.operatorCommitmentOf(Buffer.from(k.operatorSecret, 'hex'))));
  });
});
