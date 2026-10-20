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
  NIGHTCAST_PRIVATE_STATE_ID,
  nightcastProviders,
  type NightcastProviders,
  openWallet,
  type Session,
} from '../network.js';
import type { DeploymentRecord } from '../record.js';
import { acceptOracleKey, deployNightcast } from '../steps.js';
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
  let maintenanceKey: string;

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

  it('deploys with the proposed oracle key and a single-key authority', async () => {
    const deployed = await deployNightcast(providers, {
      oraclePublicKey: oraclePublicKey(sk),
      operatorCommitment: pureCircuits.operatorCommitmentOf(operatorSecret),
      minWindow: 60n,
      maxWindow: 86_400n,
    });
    address = deployed.contractAddress;
    maintenanceKey = deployed.maintenanceKey;
    const state = await providers.publicDataProvider.queryContractState(address);
    expect(state).toBeTruthy();
    expect(isLocked(state!.maintenanceAuthority)).toBe(false);
    expect(Nightcast.ledger(state!.data).oracleKeyReady).toBe(false);
  }, 10 * 60_000);

  it('locks the maintenance authority for good', async () => {
    const locked = await lockMaintenanceAuthority(providers, address, maintenanceKey);
    expect(locked.authority.committee).toHaveLength(0);
    expect(locked.authority.threshold).toBe(1);
    // The old key can't do anything any more, and nor can any other.
    await expect(lockMaintenanceAuthority(providers, address, maintenanceKey)).rejects.toThrow(/already locked/);
    const nightcast = await findDeployedContract(providers, {
      contractAddress: address,
      compiledContract: compiledNightcast(),
      privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
      initialPrivateState: {},
      signingKey: maintenanceKey,
    });
    await expect(nightcast.circuitMaintenanceTx.fulfil.removeVerifierKey()).rejects.toThrow();
    await expect(nightcast.contractMaintenanceTx.replaceAuthority(sampleSigningKey())).rejects.toThrow();
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
});
