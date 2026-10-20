import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
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

/**
 * A funded wallet. On `local` it's one of the network's genesis wallets; on
 * Preprod and Preview it comes from `seed` (hex), and the testkit asks the
 * faucet for funds and registers NIGHT for DUST if the wallet is empty.
 */
export const openWallet = async (session: Session, seed?: string): Promise<MidnightWalletProvider> => {
  if (session.network === 'local') return session.env.getMidnightWalletProvider();
  if (!seed) throw new Error('Set NIGHTCAST_WALLET_SEED to the hex seed of a funded wallet.');
  const wallet = await MidnightWalletProvider.build(session.logger, session.config, seed);
  await wallet.start();
  return wallet;
};

/**
 * midnight-js providers for Nightcast. Private state is kept in memory only:
 * the deployer's temporary maintenance key and any oracle secret passed in
 * never touch the disk.
 */
export const nightcastProviders = (session: Session, wallet: MidnightWalletProvider, dir = zkConfigPath()) => {
  const zkConfigProvider = new NodeZkConfigProvider<string>(dir);
  return {
    privateStateProvider: inMemoryPrivateStateProvider<string, NightcastPrivateState>(),
    publicDataProvider: indexerPublicDataProvider(session.config.indexer, session.config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(session.config.proofServer, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
};

export type NightcastProviders = ReturnType<typeof nightcastProviders>;
