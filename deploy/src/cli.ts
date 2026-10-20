#!/usr/bin/env node
/**
 * nightcast-deploy: deploy Nightcast, lock it, activate the oracle key and
 * publish fingerprints anyone can check.
 *
 *   nightcast-deploy deploy     --network preprod --oracle oracle.secret --operator operator.secret
 *   nightcast-deploy accept-key --network preprod --oracle oracle.secret
 *   nightcast-deploy lock       --network preprod --maintenance-key-file <file>
 *   nightcast-deploy verify     --network preprod
 *   nightcast-deploy fingerprints
 *
 * The wallet that pays fees comes from NIGHTCAST_WALLET_SEED (hex); on the
 * `local` network a genesis wallet is used instead.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromHex, oraclePublicKey, parseOracleSecretKey } from '@nightcast/contract';
import { PreprodTestEnvironment, PreviewTestEnvironment } from '@midnight-ntwrk/testkit-js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { compilerInfo, type Fingerprints, localFingerprints } from './fingerprints.js';
import { isLocked, lockMaintenanceAuthority } from './lock.js';
import {
  connect,
  createLogger,
  isNetwork,
  type Network,
  NETWORKS,
  nightcastProviders,
  openWallet,
  type Session,
} from './network.js';
import { currentCommit, type DeploymentRecord, readRecord, recordPath, writeRecord } from './record.js';
import { acceptOracleKey, deployNightcast } from './steps.js';
import { formatChecks, verifyDeployment } from './verify.js';

const USAGE = `usage:
  nightcast-deploy deploy       --network <${NETWORKS.join('|')}> --oracle <file> --operator <file> [--min 60] [--max 86400] [--accept] [--proof-server-port <port>]
  nightcast-deploy accept-key   --network <network> --oracle <oracle secret file> [--proof-server-port <port>]
  nightcast-deploy lock         --network <network> --maintenance-key-file <file> [--proof-server-port <port>]
  nightcast-deploy verify       --network <network> [--address <contract address>]
  nightcast-deploy fingerprints

--oracle and --operator take files from \`nightcast-keygen\`. Only the public part
is used, except with --accept (deploy) or accept-key, which need the oracle secret.`;

type KeyFile = { role: string; secret?: string; public: unknown };

const readKeyFile = (path: string, role: string): KeyFile => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as KeyFile;
  if (parsed.role !== role) throw new Error(`${path} is a ${parsed.role} file, expected ${role}`);
  return parsed;
};

const oraclePublicFrom = (file: KeyFile): { x: bigint; y: bigint } => {
  const pub = file.public as { x: string; y: string };
  const key = { x: BigInt(pub.x), y: BigInt(pub.y) };
  if (file.secret) {
    const derived = oraclePublicKey(parseOracleSecretKey(file.secret));
    if (derived.x !== key.x || derived.y !== key.y) throw new Error('oracle file: public key does not match its secret');
  }
  return key;
};

const networkArg = (value: string | undefined): Network => {
  if (!value || !isNetwork(value)) throw new Error(`--network must be one of ${NETWORKS.join(', ')}`);
  return value;
};

const portArg = (value: string | undefined): number | undefined => (value ? Number.parseInt(value, 10) : undefined);

/** Keep the one-time maintenance key only if locking failed, so `lock` can be retried. */
const saveMaintenanceKeyForRetry = (network: Network, address: string, key: string): string => {
  const dir = join(process.cwd(), '.nightcast');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${network}-${address.slice(0, 12)}-maintenance.key`);
  writeFileSync(path, JSON.stringify({ network, contractAddress: address, maintenanceKey: key }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return path;
};

const withSession = async <T>(network: Network, proofServerPort: number | undefined, run: (s: Session) => Promise<T>) => {
  const session = await connect(network, { proofServerPort });
  try {
    return await run(session);
  } finally {
    await session.shutdown().catch((e) => session.logger.warn(`shutdown: ${e}`));
  }
};

const runVerify = async (session: Session | undefined, network: Network, address?: string): Promise<boolean> => {
  const record = readRecord(network);
  if (address && address !== record.contractAddress) throw new Error(`record is for ${record.contractAddress}, not ${address}`);
  let config = session?.config;
  if (!config) {
    if (network === 'local') throw new Error('verify on `local` must run inside the same session as the deploy');
    const logger = createLogger('warn');
    config = (network === 'preprod' ? new PreprodTestEnvironment(logger) : new PreviewTestEnvironment(logger)).getEnvironmentConfiguration();
    setNetworkId(config.networkId);
  }
  const state = await indexerPublicDataProvider(config.indexer, config.indexerWS).queryContractState(record.contractAddress);
  let local: Fingerprints | undefined;
  try {
    local = localFingerprints();
  } catch {
    local = undefined;
  }
  const checks = verifyDeployment(record, state, local);
  process.stdout.write(`Nightcast on ${network} at ${record.contractAddress}\n${formatChecks(checks)}\n`);
  return checks.every((c) => c.ok);
};

const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      network: { type: 'string' },
      oracle: { type: 'string' },
      operator: { type: 'string' },
      min: { type: 'string', default: '60' },
      max: { type: 'string', default: '86400' },
      accept: { type: 'boolean', default: false },
      address: { type: 'string' },
      'maintenance-key-file': { type: 'string' },
      'proof-server-port': { type: 'string' },
    },
    strict: true,
  });

  switch (command) {
    case 'fingerprints': {
      process.stdout.write(JSON.stringify({ compiler: compilerInfo(), verifierKeys: localFingerprints() }, null, 2) + '\n');
      return 0;
    }

    case 'verify': {
      return (await runVerify(undefined, networkArg(values.network), values.address)) ? 0 : 1;
    }

    case 'deploy': {
      const network = networkArg(values.network);
      if (!values.oracle || !values.operator) throw new Error(USAGE);
      const oracleFile = readKeyFile(values.oracle, 'oracle');
      const operatorFile = readKeyFile(values.operator, 'operator');
      const oracleKey = oraclePublicFrom(oracleFile);
      const operatorCommitment = String(operatorFile.public);
      if (values.accept && !oracleFile.secret) throw new Error('--accept needs the oracle secret file');
      const params = {
        oraclePublicKey: oracleKey,
        operatorCommitment: fromHex(operatorCommitment),
        minWindow: BigInt(values.min!),
        maxWindow: BigInt(values.max!),
      };
      const fingerprints = localFingerprints();

      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, process.env.NIGHTCAST_WALLET_SEED);
        try {
          const providers = nightcastProviders(session, wallet);
          session.logger.info('Deploying Nightcast...');
          const deployed = await deployNightcast(providers, params);
          session.logger.info(`Deployed at ${deployed.contractAddress} (tx ${deployed.txId})`);

          const record: DeploymentRecord = {
            network,
            contractAddress: deployed.contractAddress,
            deployedAt: new Date().toISOString(),
            sourceCommit: currentCommit(),
            compiler: compilerInfo(),
            parameters: {
              oraclePublicKey: { x: oracleKey.x.toString(), y: oracleKey.y.toString() },
              operatorCommitment,
              minWindow: params.minWindow.toString(),
              maxWindow: params.maxWindow.toString(),
            },
            transactions: { deploy: deployed.txId },
            verifierKeys: fingerprints,
          };
          writeRecord(record);

          session.logger.info('Locking the maintenance authority...');
          try {
            const locked = await lockMaintenanceAuthority(providers, deployed.contractAddress, deployed.maintenanceKey);
            record.transactions.lockAuthority = locked.txId;
            record.maintenanceAuthority = {
              committeeSize: locked.authority.committee.length,
              threshold: locked.authority.threshold,
              counter: locked.authority.counter.toString(),
            };
            writeRecord(record);
            session.logger.info(`Locked (tx ${locked.txId}); nobody can change the contract's code any more`);
          } catch (err) {
            const keyPath = saveMaintenanceKeyForRetry(network, deployed.contractAddress, deployed.maintenanceKey);
            session.logger.error(
              `Locking failed: ${err instanceof Error ? err.message : String(err)}. The one-time maintenance key is in ${keyPath}; ` +
                `retry with \`nightcast-deploy lock --network ${network} --maintenance-key-file ${keyPath}\` and delete the file afterwards.`,
            );
            return 1;
          }

          if (values.accept) {
            session.logger.info('Activating the oracle key...');
            const accepted = await acceptOracleKey(providers, deployed.contractAddress, parseOracleSecretKey(oracleFile.secret!));
            record.transactions.acceptOracleKey = accepted.txId;
            writeRecord(record);
          }

          session.logger.info(`Record written to ${recordPath(network)}`);
          const ok = await runVerify(session, network);
          if (!values.accept) {
            session.logger.info(
              `Next: the oracle runs \`nightcast-deploy accept-key --network ${network} --oracle <oracle secret file>\``,
            );
          }
          return ok || !values.accept ? 0 : 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'accept-key': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(USAGE);
      const oracleFile = readKeyFile(values.oracle, 'oracle');
      if (!oracleFile.secret) throw new Error(`${values.oracle} has no secret`);
      const record = readRecord(network);
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, process.env.NIGHTCAST_WALLET_SEED);
        try {
          const providers = nightcastProviders(session, wallet);
          const accepted = await acceptOracleKey(providers, record.contractAddress, parseOracleSecretKey(oracleFile.secret!));
          record.transactions.acceptOracleKey = accepted.txId;
          writeRecord(record);
          return (await runVerify(session, network)) ? 0 : 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'lock': {
      const network = networkArg(values.network);
      const file = values['maintenance-key-file'];
      if (!file) throw new Error(USAGE);
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { contractAddress: string; maintenanceKey: string };
      const record = readRecord(network);
      if (saved.contractAddress !== record.contractAddress) throw new Error('key file is for a different deployment');
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, process.env.NIGHTCAST_WALLET_SEED);
        try {
          const providers = nightcastProviders(session, wallet);
          const state = await providers.publicDataProvider.queryContractState(record.contractAddress);
          if (state && isLocked(state.maintenanceAuthority)) {
            session.logger.info('Already locked.');
          } else {
            const locked = await lockMaintenanceAuthority(providers, record.contractAddress, saved.maintenanceKey);
            record.transactions.lockAuthority = locked.txId;
            record.maintenanceAuthority = {
              committeeSize: locked.authority.committee.length,
              threshold: locked.authority.threshold,
              counter: locked.authority.counter.toString(),
            };
            writeRecord(record);
          }
          session.logger.info(`Locked. Delete ${file} now; the key can no longer do anything.`);
          return (await runVerify(session, network)) ? 0 : 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    default:
      process.stderr.write(USAGE + '\n');
      return command ? 1 : 0;
  }
};

const invokedDirectly = (): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

export { main };
