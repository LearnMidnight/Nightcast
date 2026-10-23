/**
 * End-to-end test on a throwaway local Midnight network in Docker.
 * Run with NIGHTCAST_E2E=1 (CI does this in its own job); skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import {
  generateOperatorSecret,
  generateOracleSecretKey,
  Nightcast,
  oraclePublicKey,
  pureCircuits,
  Status,
} from '@nightcast/contract';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { compilerInfo, localFingerprints } from '../fingerprints.js';
import { isLocked, lockMaintenanceAuthority } from '../lock.js';
import {
  compiledNightcast,
  connect,
  LOCAL_GENESIS_SEEDS,
  NIGHTCAST_PRIVATE_STATE_ID,
  nightcastProviders,
  type NightcastProviders,
  openWallet,
  type Session,
} from '../network.js';
import type { DeploymentRecord } from '../record.js';
import { acceptOracleKey, deployNightcast, deployNightcastLocked } from '../steps.js';
import { checkRequest } from '../check.js';
import { expireRequest, readRequest, startOracleService, type SubmittedRequest, submitRequest, waitForResult } from '../service.js';
import { verifyDeployment } from '../verify.js';

const enabled = process.env.NIGHTCAST_E2E === '1';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const label = (s: string) => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s).slice(0, 32));
  return b;
};

describe.runIf(enabled)('Nightcast on a local Midnight network', () => {
  let session: Session;
  let wallet: MidnightWalletProvider;
  let providers: NightcastProviders;
  const sk = generateOracleSecretKey();
  const operatorSecret = generateOperatorSecret();
  let address: string;

  /** The record a publisher would write for this deployment. */
  const recordNow = (): DeploymentRecord => {
    const pk = oraclePublicKey(sk);
    return {
      network: 'local',
      contractAddress: address,
      deployedAt: new Date().toISOString(),
      compiler: compilerInfo(),
      parameters: {
        oraclePublicKey: { x: pk.x.toString(), y: pk.y.toString() },
        operatorCommitment: hex(pureCircuits.operatorCommitmentOf(operatorSecret)),
        minWindow: '60',
        maxWindow: '86400',
      },
      transactions: {},
      verifierKeys: localFingerprints(),
    };
  };

  beforeAll(async () => {
    process.env.NIGHTCAST_DEPLOYMENTS_DIR = mkdtempSync(join(tmpdir(), 'nightcast-deployments-'));
    session = await connect('local');
    wallet = await openWallet(session);
    providers = nightcastProviders(session, wallet);
  }, 15 * 60_000);

  afterAll(async () => {
    await wallet?.stop().catch(() => undefined);
    await session?.shutdown().catch(() => undefined);
  }, 5 * 60_000);

  it('deploys already locked, with the proposed oracle key', async () => {
    const deployed = await deployNightcastLocked(providers, {
      oraclePublicKey: oraclePublicKey(sk),
      operatorCommitment: pureCircuits.operatorCommitmentOf(operatorSecret),
      minWindow: 60n,
      maxWindow: 86_400n,
    });
    address = deployed.contractAddress;
    const state = await providers.publicDataProvider.queryContractState(address);
    expect(state).toBeTruthy();
    expect(isLocked(state!.maintenanceAuthority)).toBe(true);
    expect(state!.maintenanceAuthority.committee).toHaveLength(0);
    expect(state!.maintenanceAuthority.threshold).toBe(1);
    expect(Nightcast.ledger(state!.data).oracleKeyReady).toBe(false);
  }, 10 * 60_000);

  it('cannot be changed by anyone, and the old-style lock is refused', async () => {
    // Any key: there is no committee member, so no signature can ever count.
    const someKey = sampleSigningKey();
    await expect(lockMaintenanceAuthority(providers, address, someKey)).rejects.toThrow(/already locked/);
    const nightcast = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: compiledNightcast(),
      privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
      initialPrivateState: {},
      signingKey: someKey,
    });
    await expect(nightcast.circuitMaintenanceTx.fulfil.removeVerifierKey()).rejects.toThrow();
    await expect(nightcast.contractMaintenanceTx.replaceAuthority(sampleSigningKey())).rejects.toThrow();
  }, 10 * 60_000);

  it('still supports the old deploy-then-lock path', async () => {
    const deployed = await deployNightcast(providers, {
      oraclePublicKey: oraclePublicKey(sk),
      operatorCommitment: pureCircuits.operatorCommitmentOf(operatorSecret),
      minWindow: 60n,
      maxWindow: 86_400n,
    });
    const before = await providers.publicDataProvider.queryContractState(deployed.contractAddress);
    expect(isLocked(before!.maintenanceAuthority)).toBe(false);
    const locked = await lockMaintenanceAuthority(providers, deployed.contractAddress, deployed.maintenanceKey);
    expect(locked.authority.committee).toHaveLength(0);
    expect(locked.authority.threshold).toBe(1);
  }, 10 * 60_000);

  it('activates the oracle key', async () => {
    await expect(acceptOracleKey(providers, address, generateOracleSecretKey())).rejects.toThrow();
    await acceptOracleKey(providers, address, sk);
  }, 10 * 60_000);

  it('matches the published fingerprints', async () => {
    const pk = oraclePublicKey(sk);
    const fps = localFingerprints();
    const record: DeploymentRecord = {
      network: 'local',
      contractAddress: address,
      deployedAt: new Date().toISOString(),
      compiler: compilerInfo(),
      parameters: {
        oraclePublicKey: { x: pk.x.toString(), y: pk.y.toString() },
        operatorCommitment: hex(pureCircuits.operatorCommitmentOf(operatorSecret)),
        minWindow: '60',
        maxWindow: '86400',
      },
      transactions: {},
      verifierKeys: fps,
    };
    const state = await providers.publicDataProvider.queryContractState(address);
    const checks = verifyDeployment(record, state, fps);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(Object.keys(fps).sort()).toEqual(
      ['acceptOperator', 'acceptOracleKey', 'expire', 'fulfil', 'proposeOperator', 'proposeOracleKey', 'request'].sort(),
    );
  }, 5 * 60_000);

  it('serves a real request: request, fulfil, check the output', async () => {
    const requesterSecret = label('e2e-requester');
    const nightcast = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: compiledNightcast(),
      privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
      initialPrivateState: { oracleSecretKey: sk, requesterSecret },
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const requested = await nightcast.callTx.request(label('e2e'), label('seed-1'), deadline);
    const id = requested.private.result as Uint8Array;

    await nightcast.callTx.fulfil(id);
    const state = await providers.publicDataProvider.queryContractState(address);
    const r = Nightcast.ledger(state!.data).requests.lookup(id);
    expect(r.status).toBe(Status.fulfilled);
    expect(hex(r.requester)).toBe(hex(pureCircuits.requesterCommitmentOf(requesterSecret)));
    expect(hex(r.output)).toBe(hex(pureCircuits.evaluateAt(sk, r.point)));
    expect(hex(r.output)).toBe(hex(pureCircuits.evaluate(sk, id)));
  }, 15 * 60_000);

  it('runs the oracle service: another wallet requests, the service fulfils', async () => {
    // A second wallet, as a separate requester would have.
    const requesterWallet = await openWallet(session, { seed: LOCAL_GENESIS_SEEDS[1] });
    const requesterProviders = nightcastProviders(session, requesterWallet);
    const running = await startOracleService(providers, address, sk, session.logger, { pollMs: 2_000, safetyMarginSecs: 60 });
    try {
      const requesterSecret = label('service-requester');
      const req = await submitRequest(requesterProviders, address, requesterSecret, { tag: 'e2e-service', deadlineSecs: 1_800 });
      const r = await waitForResult(requesterProviders, address, req.id, { pollMs: 2_000, timeoutMs: 10 * 60_000 });
      expect(r?.status).toBe(Status.fulfilled);
      expect(hex(r!.requester)).toBe(hex(pureCircuits.requesterCommitmentOf(requesterSecret)));
      expect(hex(r!.output)).toBe(hex(pureCircuits.evaluate(sk, req.id)));
      // Everything `check` confirms from public data, on a real deployment.
      const state = await requesterProviders.publicDataProvider.queryContractState(address);
      const checks = checkRequest(recordNow(), state, req.id, r, { inputs: { tag: req.tag, seed: req.seed } });
      expect(checks.filter((c) => !c.ok)).toEqual([]);
    } finally {
      await running.stop();
      await requesterWallet.stop().catch(() => undefined);
    }
  }, 20 * 60_000);

  it('expires a request nobody answers, and the checks agree', async () => {
    const requesterSecret = label('expire-requester');
    let req: SubmittedRequest | undefined;
    // As short a deadline as the contract allows, with room for the proof.
    for (let attempt = 0; attempt < 3 && !req; attempt++) {
      req = await submitRequest(providers, address, requesterSecret, { tag: 'e2e-expire', deadlineSecs: 120 + 60 * attempt }).catch(
        () => undefined,
      );
    }
    expect(req).toBeDefined();
    const id = req!.id;
    await expect(expireRequest(providers, address, id)).rejects.toThrow();
    while (Date.now() / 1000 < Number(req!.deadline) + 15) await new Promise((res) => setTimeout(res, 5_000));
    let r = await readRequest(providers, address, id);
    for (let attempt = 0; attempt < 5 && r?.status === Status.pending; attempt++) {
      await expireRequest(providers, address, id).catch(() => new Promise((res) => setTimeout(res, 20_000)));
      r = await readRequest(providers, address, id);
    }
    expect(r?.status).toBe(Status.expired);
    const state = await providers.publicDataProvider.queryContractState(address);
    const checks = checkRequest(recordNow(), state, id, r, { inputs: { tag: req!.tag, seed: req!.seed }, expect: 'expired' });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  }, 20 * 60_000);
});
