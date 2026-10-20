import { sampleSigningKey, type SigningKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { Nightcast, oraclePublicKey } from '@nightcast/contract';
import { compiledNightcast, NIGHTCAST_PRIVATE_STATE_ID, type NightcastProviders } from './network.js';

export type DeployParams = {
  oraclePublicKey: { x: bigint; y: bigint };
  operatorCommitment: Uint8Array;
  minWindow: bigint;
  maxWindow: bigint;
};

/**
 * Deploy Nightcast with a fresh, single-use maintenance key. The caller must
 * lock the authority straight afterwards; the key only lives in memory.
 */
export const deployNightcast = async (
  providers: NightcastProviders,
  params: DeployParams,
): Promise<{ contractAddress: string; txId: string; maintenanceKey: SigningKey }> => {
  const maintenanceKey = sampleSigningKey();
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
