import {
  ContractMaintenanceAuthority,
  Intent,
  MaintenanceUpdate,
  ReplaceAuthority,
  type SigningKey,
  signData,
  Transaction,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
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

export type LockOptions = {
  /** Called as each stage starts, so a slow step is visible. */
  onStage?: (message: string) => void;
  /** Give up waiting for the lock to show on chain after this long (default 10 minutes). */
  confirmTimeoutMs?: number;
  /** How often to check the chain while waiting (default 10 seconds). */
  pollMs?: number;
};

const withTimeout = <T>(what: string, ms: number, p: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 60_000)} minutes`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/**
 * Replace a contract's maintenance authority with one nobody can use. After
 * this, no one (including the deployer) can change the contract's verifier
 * keys or its authority ever again.
 *
 * `currentKey` must be the key that is currently the contract's sole
 * authority (the one passed to `deployContract`).
 *
 * Each stage (prove, pay the fee, submit, confirm) is reported and has a time
 * limit: midnight-js's own `submitTx` waits forever for confirmation, so a
 * dropped transaction would hang with no message.
 */
export const lockMaintenanceAuthority = async (
  providers: NightcastProviders,
  contractAddress: string,
  currentKey: SigningKey,
  opts: LockOptions = {},
): Promise<{ txId: string; authority: AuthorityView }> => {
  const stage = opts.onStage ?? (() => undefined);
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

  stage('Lock: preparing the transaction (proof server)...');
  const provenTx = await withTimeout('Preparing the lock transaction', 5 * 60_000, providers.proofProvider.proveTx(unprovenTx));
  stage('Lock: paying the fee from the wallet (DUST)...');
  const balanced = await withTimeout('Paying the lock fee', 5 * 60_000, providers.walletProvider.balanceTx(provenTx));
  stage('Lock: sending the transaction...');
  const txId = await withTimeout('Sending the lock transaction', 2 * 60_000, providers.midnightProvider.submitTx(balanced));
  stage(`Lock: sent (tx ${txId}); waiting for it to appear on chain...`);

  const timeoutMs = opts.confirmTimeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = await providers.publicDataProvider.queryContractState(contractAddress).catch(() => undefined);
    if (after && isLocked(after.maintenanceAuthority)) {
      const a = after.maintenanceAuthority;
      return { txId, authority: { committee: a.committee, threshold: a.threshold, counter: a.counter } };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the lock transaction ${txId} was sent but hasn't shown up on chain after ${Math.round(timeoutMs / 60_000)} minutes ` +
          '(it may have been dropped)',
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
};