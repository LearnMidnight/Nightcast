import {
  ContractMaintenanceAuthority,
  Intent,
  MaintenanceUpdate,
  ReplaceAuthority,
  type SigningKey,
  signData,
  Transaction,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { submitTx } from '@midnight-ntwrk/midnight-js/contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js/utils';
import type { NightcastProviders } from './network.js';

/** The parts of a ledger maintenance authority that decide whether it can act. */
export type AuthorityView = { committee: readonly unknown[]; threshold: number; counter: bigint };

/**
 * An authority can never sign anything when its threshold is larger than its
 * committee (the ledger needs `threshold` valid signatures from committee
 * members). An empty committee with threshold 1 is the canonical locked form.
 */
export const isLocked = (authority: AuthorityView): boolean => authority.threshold > authority.committee.length;

/**
 * Replace a contract's maintenance authority with one nobody can use. After
 * this, no one (including the deployer) can change the contract's verifier
 * keys or its authority ever again.
 *
 * `currentKey` must be the key that is currently the contract's sole
 * authority (the one passed to `deployContract`).
 */
export const lockMaintenanceAuthority = async (
  providers: NightcastProviders,
  contractAddress: string,
  currentKey: SigningKey,
): Promise<{ txId: string; authority: AuthorityView }> => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new Error(`no contract at ${contractAddress}`);
  const current = state.maintenanceAuthority;
  if (isLocked(current)) throw new Error('maintenance authority is already locked');
  if (current.committee.length !== 1 || current.threshold !== 1) {
    throw new Error('expected a single-key maintenance authority; lock it with its own committee instead');
  }

  const locked = new ContractMaintenanceAuthority([], 1, current.counter + 1n);
  const unsigned = new MaintenanceUpdate(contractAddress, [new ReplaceAuthority(locked)], current.counter);
  const update = unsigned.addSignature(0n, signData(currentKey, unsigned.dataToSign));
  const unprovenTx = Transaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    Intent.new(ttlOneHour()).addMaintenanceUpdate(update),
  );
  const result = await submitTx(providers, { unprovenTx });

  const after = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!after || !isLocked(after.maintenanceAuthority)) {
    throw new Error(`lock transaction ${result.txId} was accepted but the authority is not locked`);
  }
  const a = after.maintenanceAuthority;
  return { txId: result.txId, authority: { committee: a.committee, threshold: a.threshold, counter: a.counter } };
};
