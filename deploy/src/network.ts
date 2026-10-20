import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';
import { filter, firstValueFrom } from 'rxjs';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { CompiledContract, type ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  defaultContainersConfiguration,
  type EnvironmentConfiguration,
  inMemoryPrivateStateProvider,
  LocalTestEnvironment,
  MidnightWalletProvider,
  PreprodTestEnvironment,
  PreviewTestEnvironment,
  setContainersConfiguration,
  StaticProofServerContainer,
  type TestEnvironment,
} from '@midnight-ntwrk/testkit-js';
import { Nightcast, type NightcastPrivateState, witnesses } from '@nightcast/contract';
import { zkConfigPath } from './fingerprints.js';

export const NETWORKS = ['preprod', 'preview', 'local'] as const;
export type Network = (typeof NETWORKS)[number];

export const isNetwork = (s: string): s is Network => (NETWORKS as readonly string[]).includes(s);

export const NIGHTCAST_PRIVATE_STATE_ID = 'nightcast';

export type NightcastContract = Nightcast.Contract<NightcastPrivateState>;
export type NightcastCircuits = ProvableCircuitId<NightcastContract>;
export type NightcastProviders = MidnightProviders<NightcastCircuits, typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>;

const dockerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker');

export const createLogger = (level = process.env.NIGHTCAST_LOG_LEVEL ?? 'info'): Logger =>
  pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } });

/** The compiled Nightcast contract with its witnesses and proving keys, as midnight-js expects it. */
export const compiledNightcast = (dir = zkConfigPath()) =>
  CompiledContract.make('nightcast', Nightcast.Contract<NightcastPrivateState>).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(dir),
  );

export type Session = {
  network: Network;
  logger: Logger;
  config: EnvironmentConfiguration;
  env: TestEnvironment;
  shutdown(): Promise<void>;
};

/**
 * Connect to a network. For Preprod and Preview a proof server is started in
 * Docker unless `proofServerPort` points at one already running; `local`
 * starts a whole throwaway network (node, indexer, proof server) in Docker.
 */
export const connect = async (network: Network, opts: { proofServerPort?: number; logger?: Logger } = {}): Promise<Session> => {
  const logger = opts.logger ?? createLogger();
  setContainersConfiguration({
    ...defaultContainersConfiguration,
    proofServer: { ...defaultContainersConfiguration.proofServer, path: dockerDir, fileName: 'proof-server.yml' },
    standalone: { ...defaultContainersConfiguration.standalone, path: dockerDir, fileName: 'compose.yml' },
  });

  let env: TestEnvironment;
  switch (network) {
    case 'preprod':
      env = new PreprodTestEnvironment(logger);
      break;
    case 'preview':
      env = new PreviewTestEnvironment(logger);
      break;
    case 'local':
      setNetworkId('undeployed');
      env = new LocalTestEnvironment(logger);
      break;
  }
  const proofServer = opts.proofServerPort ? new StaticProofServerContainer(opts.proofServerPort) : undefined;
  const config = await env.start(network === 'local' ? undefined : proofServer);
  setNetworkId(config.networkId);
  return { network, logger, config, env, shutdown: () => env.shutdown() };
};

/** Seeds of the pre-funded wallets on a `local` network. */
export const LOCAL_GENESIS_SEEDS = [
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000003',
  '0000000000000000000000000000000000000000000000000000000000000004',
] as const;

export type WalletOptions = {
  /** Hex wallet seed. On `local`, defaults to the first genesis wallet. */
  seed?: string;
  /** Called with the wallet's unshielded address before waiting for funds. */
  onAddress?: (address: string) => void;
};

/**
 * Open and sync a wallet. On Preprod and Preview, if it holds no NIGHT the
 * testkit asks the faucet for some and waits; once funded it registers the
 * NIGHT for DUST generation (DUST pays transaction fees).
 */
export const openWallet = async (session: Session, opts: WalletOptions = {}): Promise<MidnightWalletProvider> => {
  const seed = opts.seed ?? (session.network === 'local' ? LOCAL_GENESIS_SEEDS[0] : undefined);
  if (!seed) throw new Error('No wallet: pass --wallet <file from `nightcast-deploy wallet new`> or set NIGHTCAST_WALLET_SEED.');
  const wallet = await MidnightWalletProvider.build(session.logger, session.config, seed);
  opts.onAddress?.(walletAddress(wallet));
  await wallet.start();
  return wallet;
};

/** The address to send test NIGHT to (faucet, transfers). */
export const walletAddress = (wallet: MidnightWalletProvider): string =>
  wallet.unshieldedKeystore.getBech32Address().asString();

/** NIGHT and DUST balances of a synced wallet. */
export const walletBalances = async (wallet: MidnightWalletProvider): Promise<{ night: bigint; dust: bigint }> => {
  const state = await firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
  return {
    night: state.unshielded.balances[unshieldedToken().raw] ?? 0n,
    dust: state.dust.balance(new Date()),
  };
};

/**
 * midnight-js providers for Nightcast. Private state is kept in memory only:
 * the deployer's temporary maintenance key and any oracle secret passed in
 * never touch the disk.
 */
export const nightcastProviders = (
  session: Session,
  wallet: MidnightWalletProvider,
  dir = zkConfigPath(),
): NightcastProviders => {
  const zkConfigProvider = new NodeZkConfigProvider<NightcastCircuits>(dir);
  return {
    privateStateProvider: inMemoryPrivateStateProvider<typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>(),
    publicDataProvider: indexerPublicDataProvider(session.config.indexer, session.config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(session.config.proofServer, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
};

