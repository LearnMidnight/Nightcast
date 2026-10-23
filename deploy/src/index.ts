/**
 * Nightcast's deploy and wallet tooling as a library, for projects that run
 * their own contracts on Midnight next to (or embedding) Nightcast, such as
 * Lunardraw. The `./nightcast` command line is `cli.js`.
 *
 * Importing this hides Blockfrost project ids in everything written to stdout
 * and stderr. For readable wallet sync errors, also import
 * `@nightcast/deploy/explain-errors` first thing in your program.
 */
export {
  BLOCKFROST,
  blockfrostProjectId,
  connect,
  contractProviders,
  createLogger,
  describeSync,
  FAUCETS,
  isNetwork,
  LOCAL_GENESIS_SEEDS,
  type Network,
  NETWORKS,
  openWallet,
  publicEndpoints,
  type Session,
  type WalletOptions,
  walletAddress,
  walletBalances,
  waitForSpendableDust,
} from './network.js';
export { deployLocked } from './steps.js';
export { isLocked, type AuthorityView } from './lock.js';
export {
  compareFingerprints,
  compilerInfo,
  type CompilerInfo,
  type Fingerprints,
  localFingerprints,
  onChainFingerprints,
  type OperationsSource,
} from './fingerprints.js';
export { forgetWalletState, walletStateFile } from './wallet.js';
export { redact } from './redact-output.js';
