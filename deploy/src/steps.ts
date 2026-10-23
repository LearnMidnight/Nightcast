import {
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractState as LedgerContractState,
  Intent,
  sampleSigningKey,
  type SigningKey,
  Transaction,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js/utils';
import {
  type ContractProviders,
  createUnprovenDeployTx,
  type DeployTxOptionsWithPrivateState,
  deployContract,
  findDeployedContract,
  submitTx,
} from '@midnight-ntwrk/midnight-js/contracts';
import type { Contract } from '@midnight-ntwrk/midnight-js-protocol/compact-js/effect/Contract';
import { Nightcast, oraclePublicKey } from '@nightcast/contract';
import { isLocked } from './lock.js';
import { compiledNightcast, NIGHTCAST_PRIVATE_STATE_ID, type NightcastProviders } from './network.js';

export type DeployParams = {
  oraclePublicKey: { x: bigint; y: bigint };
  operatorCommitment: Uint8Array;
  minWindow: bigint;
  maxWindow: bigint;
};

/**
 * Deploy Nightcast with a fresh, single-use maintenance key. The caller must
 * lock the authority straight afterwards. Prefer `deployNightcastLocked`.
 */
export const deployNightcast = async (
  providers: NightcastProviders,
  params: DeployParams,
  maintenanceKey: SigningKey = sampleSigningKey(),
): Promise<{ contractAddress: string; txId: string; maintenanceKey: SigningKey }> => {
  const deployed = await deployContract(providers, {
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: {},
    signingKey: maintenanceKey,
    args: [params.oraclePublicKey, params.operatorCommitment, params.minWindow, params.maxWindow],
  });
  const pub = deployed.deployTxData.public;
  return { contractAddress: pub.contractAddress, txId: pub.txId, maintenanceKey };
};

/**
 * Deploy Nightcast already locked: the contract is created in a single
 * transaction with a maintenance authority nobody can use (empty committee,
 * threshold 1), so there is never a key that could change its code and no
 * separate lock transaction to send.
 *
 * This repeats what midnight-js's `deployContract` does (run the constructor,
 * wrap the resulting state in a `ContractDeploy`) but replaces the authority
 * in between. The Nightcast constructor creates no coins, so the transaction
 * is only the deploy.
 */
export const deployNightcastLocked = async (
  providers: NightcastProviders,
  params: DeployParams,
): Promise<{ contractAddress: string; txId: string }> =>
  deployLocked(providers, {
    compiledContract: compiledNightcast(),
    initialPrivateState: {},
    signingKey: sampleSigningKey(), // never used: the authority is replaced before anything is sent
    args: [params.oraclePublicKey, params.operatorCommitment, params.minWindow, params.maxWindow],
  });

/**
 * Deploy any compiled contract already locked, in one transaction: run its
 * constructor, replace the maintenance authority with one nobody can use
 * (empty committee, threshold 1), and submit the deploy. For constructors that
 * create no coins (the transaction is only the deploy). Used for Nightcast and
 * for contracts that embed its VRF, such as Lunardraw's.
 */
export const deployLocked = async <C extends Contract.Any>(
  providers: ContractProviders<C, Contract.ProvableCircuitId<C>, unknown> | ContractProviders<C>,
  options: DeployTxOptionsWithPrivateState<C>,
): Promise<{ contractAddress: string; txId: string }> => {
  const built = await createUnprovenDeployTx(providers, options);

  // Same state the constructor produced, with the authority swapped.
  const state = LedgerContractState.deserialize(built.public.initialContractState.serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 0n);
  if (!isLocked(state.maintenanceAuthority)) throw new Error('internal: locked authority is not locked');

  const deploy = new ContractDeploy(state);
  const unprovenTx = Transaction.fromParts(getNetworkId(), undefined, undefined, Intent.new(ttlOneHour()).addDeploy(deploy));
  const result = await submitTx(providers, { unprovenTx });

  const onChain = await providers.publicDataProvider.queryContractState(deploy.address);
  if (!onChain) throw new Error(`deploy transaction ${result.txId} was accepted but no contract at ${deploy.address}`);
  if (!isLocked(onChain.maintenanceAuthority)) {
    throw new Error(`contract ${deploy.address} was deployed but its authority is not locked`);
  }
  return { contractAddress: deploy.address, txId: result.txId };
};

/**
 * The oracle proves it holds the proposed key, activating it. Runs with the
 * oracle secret only in memory.
 */
export const acceptOracleKey = async (
  providers: NightcastProviders,
  contractAddress: string,
  oracleSecretKey: bigint,
): Promise<{ txId: string }> => {
  const expected = oraclePublicKey(oracleSecretKey);
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: { oracleSecretKey },
  });
  const result = await nightcast.callTx.acceptOracleKey();
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new Error(`no contract at ${contractAddress}`);
  const ledger = Nightcast.ledger(state.data);
  if (!ledger.oracleKeyReady || ledger.oracleKey.x !== expected.x || ledger.oracleKey.y !== expected.y) {
    throw new Error('acceptOracleKey was accepted but the ledger does not show the key as active');
  }
  return { txId: result.public.txId };
};
