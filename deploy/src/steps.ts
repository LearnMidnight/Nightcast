import { ContractDeploy, ContractMaintenanceAuthority, ContractState as LedgerContractState, Intent, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v8';
import { sampleSigningKey, type SigningKey } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js/utils';
import {
  createUnprovenDeployTx,
  deployContract,
  findDeployedContract,
  type Ledger8CircuitId,
  type Ledger8Contract,
  type Ledger8ContractProviders,
  type Ledger8DeployContractOptions,
  submitTx,
} from '@midnight-ntwrk/midnight-js/contracts';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js/types';
import { ledgerOf, oraclePublicKey } from '@nightcast/contract';
import { isLocked } from './lock.js';
import { compiledNightcast, NIGHTCAST_PRIVATE_STATE_ID, type NightcastProviders, readContractState } from './network.js';

export type DeployParams = {
  oraclePublicKey: { x: bigint; y: bigint };
  operatorCommitment: Uint8Array;
  minWindow: bigint;
  maxWindow: bigint;
  /** What each request pays the oracle, in NIGHT atoms (default 0). */
  requestFee?: bigint;
  /** How much of the oracle's bond each request sets aside, in NIGHT atoms (default 0). */
  collateralPerRequest?: bigint;
};

const constructorArgs = (p: DeployParams) =>
  [p.oraclePublicKey, p.operatorCommitment, p.minWindow, p.maxWindow, p.requestFee ?? 0n, p.collateralPerRequest ?? 0n] as const;

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
    args: [...constructorArgs(params)] as never,
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
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: {},
    signingKey: sampleSigningKey(), // never used: the authority is replaced before anything is sent
    args: [...constructorArgs(params)] as never,
  });

/**
 * Deploy any compiled contract already locked, in one transaction: run its
 * constructor, replace the maintenance authority with one nobody can use
 * (empty committee, threshold 1), and submit the deploy. For constructors that
 * create no coins (the transaction is only the deploy). Used for Nightcast and
 * for contracts that embed its VRF, such as Lunardraw's.
 *
 * This is the ledger 8 pipeline, for contracts compiled with Compact 0.31
 * (compact-runtime 0.16). A network that has crossed the ledger 9 hard fork
 * refuses new ledger 8 deployments (Midnight.js raises `EraMismatchError`,
 * reason `ledger8-deploy-on-ledger9-network`): the contracts already deployed
 * keep working, and a new deployment needs the contract recompiled with the
 * ledger 9 toolchain (Compact 0.36) and the ledger 9 deploy path.
 */
export const deployLocked = async <C extends Ledger8Contract>(
  providers: Ledger8ContractProviders<C, Ledger8CircuitId<C>>,
  options: Ledger8DeployContractOptions<C>,
): Promise<{ contractAddress: string; txId: string }> => {
  const built = await createUnprovenDeployTx(providers, options);

  // Same state the constructor produced, with the authority swapped.
  const state = LedgerContractState.deserialize(built.public.initialContractState.serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 0n);
  if (!isLocked(state.maintenanceAuthority)) throw new Error('internal: locked authority is not locked');

  const deploy = new ContractDeploy(state);
  const tx = Transaction.fromParts(providers.config.networkId, undefined, undefined, Intent.new(ttlOneHour()).addDeploy(deploy));
  const result = await submitTx(providers, { unprovenTx: LedgerTransaction.seal('v8', 'Unproven', tx) });

  const onChain = await readContractState(providers.publicDataProvider, deploy.address);
  if (!onChain) throw new Error(`deploy transaction ${result.txId} was accepted but no contract at ${deploy.address}`);
  if (!isLocked(onChain.maintenanceAuthority)) {
    throw new Error(`contract ${deploy.address} was deployed but its authority is not locked`);
  }
  return { contractAddress: deploy.address, txId: result.txId };
};

/**
 * The oracle proves it holds the proposed key, activating it, and names the
 * address it's paid at (request fees, and its bond when it withdraws).
 * Runs with the oracle secret only in memory.
 */
export const acceptOracleKey = async (
  providers: NightcastProviders,
  contractAddress: string,
  oracleSecretKey: bigint,
  payout: Uint8Array,
): Promise<{ txId: string }> => {
  const expected = oraclePublicKey(oracleSecretKey);
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: { oracleSecretKey },
  });
  const result = await nightcast.callTx.acceptOracleKey({ bytes: payout });
  const state = await readContractState(providers.publicDataProvider, contractAddress);
  if (!state) throw new Error(`no contract at ${contractAddress}`);
  const ledger = ledgerOf(state);
  if (!ledger.oracleKeyReady || ledger.oracleKey.x !== expected.x || ledger.oracleKey.y !== expected.y) {
    throw new Error('acceptOracleKey was accepted but the ledger does not show the key as active');
  }
  return { txId: result.public.txId };
};

/** Add `slots` slots of collateral (slots × collateralPerRequest NIGHT atoms) to the current oracle's bond, from this wallet. */
export const depositBond = async (providers: NightcastProviders, contractAddress: string, slots: bigint): Promise<{ txId: string }> => {
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
  const result = await nightcast.callTx.depositBond(slots);
  return { txId: result.public.txId };
};

/** The current oracle takes `slots` free slots of its bond back, to its payout. */
export const withdrawBond = async (
  providers: NightcastProviders,
  contractAddress: string,
  oracleSecretKey: bigint,
  slots: bigint,
): Promise<{ txId: string }> => {
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: { oracleSecretKey },
  });
  const result = await nightcast.callTx.withdrawBond(slots);
  return { txId: result.public.txId };
};
