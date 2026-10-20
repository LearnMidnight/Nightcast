import { describe, it, expect } from 'vitest';
import { generateOperatorSecret, generateOracleSecretKey, NightcastSimulator, oraclePublicKey } from '@nightcast/contract';
import { compareFingerprints, onChainFingerprints } from '../fingerprints.js';
import { isLocked } from '../lock.js';
import type { DeploymentRecord } from '../record.js';
import { type ContractStateView, verifyDeployment } from '../verify.js';

const vk = (s: string) => new TextEncoder().encode(s);

const fakeState = (opts: {
  committee: number;
  threshold: number;
  keys: Record<string, string>;
  acceptKey?: boolean;
  sk?: bigint;
}): { state: ContractStateView; sk: bigint } => {
  const sk = opts.sk ?? generateOracleSecretKey();
  const sim = new NightcastSimulator({
    oracleSecretKey: sk,
    operatorSecret: generateOperatorSecret(),
    minWindow: 60n,
    maxWindow: 86_400n,
    acceptKey: opts.acceptKey ?? true,
  });
  const state: ContractStateView = {
    maintenanceAuthority: { committee: Array(opts.committee).fill('k'), threshold: opts.threshold, counter: 1n },
    operations: () => Object.keys(opts.keys),
    operation: (name) => ({ verifierKey: vk(opts.keys[name as string]) }),
    data: sim.publicState(),
  };
  return { state, sk };
};

const recordFor = (sk: bigint, verifierKeys: Record<string, string>): DeploymentRecord => {
  const pk = oraclePublicKey(sk);
  return {
    network: 'local',
    contractAddress: 'addr',
    deployedAt: '2026-10-20T00:00:00Z',
    compiler: { compiler: '0.31.1', language: '0.23.0', runtime: '0.16.0' },
    parameters: { oraclePublicKey: { x: pk.x.toString(), y: pk.y.toString() }, operatorCommitment: '00', minWindow: '60', maxWindow: '86400' },
    transactions: {},
    verifierKeys,
  };
};

describe('isLocked', () => {
  it('is true only when the threshold exceeds the committee', () => {
    expect(isLocked({ committee: [], threshold: 1, counter: 1n })).toBe(true);
    expect(isLocked({ committee: ['a'], threshold: 2, counter: 1n })).toBe(true);
    expect(isLocked({ committee: ['a'], threshold: 1, counter: 0n })).toBe(false);
    expect(isLocked({ committee: ['a', 'b'], threshold: 2, counter: 0n })).toBe(false);
  });
});

describe('fingerprints', () => {
  it('hashes on-chain verifier keys and reports differences', () => {
    const chain = onChainFingerprints({
      operations: () => ['fulfil', 'request'],
      operation: (n) => ({ verifierKey: vk(`key-${String(n)}`) }),
    });
    expect(Object.keys(chain)).toEqual(['fulfil', 'request']);
    expect(chain.fulfil).toMatch(/^[0-9a-f]{64}$/);
    expect(compareFingerprints(chain, chain)).toEqual([]);
    expect(compareFingerprints({ ...chain, expire: 'x' }, chain)).toEqual(['expire: missing']);
    expect(compareFingerprints(chain, { ...chain, request: 'y' })).toEqual([`request: y (expected ${chain.request})`]);
    expect(compareFingerprints({ fulfil: chain.fulfil }, chain)).toEqual(['request: unexpected circuit']);
  });
});

describe('verifyDeployment', () => {
  const keys = { fulfil: 'kf', request: 'kr' };
  const fps = onChainFingerprints({ operations: () => Object.keys(keys), operation: (n) => ({ verifierKey: vk(keys[n as 'fulfil']) }) });

  it('passes a locked deployment with the published keys and an active oracle key', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys });
    const checks = verifyDeployment(recordFor(sk, fps), state, fps);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('fails when the authority can still sign', () => {
    const { state, sk } = fakeState({ committee: 1, threshold: 1, keys });
    const failed = verifyDeployment(recordFor(sk, fps), state).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['maintenance authority locked']);
  });

  it('fails when a verifier key was swapped', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys: { ...keys, fulfil: 'evil' } });
    const failed = verifyDeployment(recordFor(sk, fps), state).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['verifier keys match the published fingerprints']);
  });

  it('fails when the oracle has not accepted its key', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys, acceptKey: false });
    const failed = verifyDeployment(recordFor(sk, fps), state).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['oracle key accepted']);
  });

  it('reports a missing contract', () => {
    expect(verifyDeployment(recordFor(1n, fps), null)).toEqual([
      { name: 'contract exists', ok: false, detail: 'nothing at addr' },
    ]);
  });
});
