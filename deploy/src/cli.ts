#!/usr/bin/env node
/**
 * nightcast-deploy: deploy Nightcast already locked (no admin key ever
 * exists), activate the oracle key and publish fingerprints anyone can check.
 *
 *   ./nightcast deploy     --network preprod --oracle oracle.secret --operator operator.secret
 *   ./nightcast accept-key --network preprod --oracle oracle.secret
 *   ./nightcast lock       --network preprod --maintenance-key-file <file>
 *   ./nightcast verify     --network preprod
 *   ./nightcast fingerprints
 *   ./nightcast wallet new  --out wallet.secret
 *   ./nightcast wallet show --network preprod --wallet wallet.secret
 *   ./nightcast oracle     --network preprod --oracle oracle.secret --wallet wallet.secret
 *   ./nightcast request    --network preprod --requester requester.secret --wallet wallet.secret --wait
 *   ./nightcast status     --network preprod --id <request id>
 *   ./nightcast blockfrost save --network preprod
 *
 * Preprod's public node and indexer are run by Blockfrost and need a project
 * id: `blockfrost save` stores it in ~/nightcast-secrets/blockfrost-preprod.secret,
 * or pass --blockfrost <file> or set NIGHTCAST_BLOCKFROST_PROJECT_ID.
 *
 * The wallet that pays fees comes from --wallet (a file from `wallet new`) or
 * NIGHTCAST_WALLET_SEED (hex); on the `local` network a genesis wallet is the
 * default.
 */
// First, so nothing can print a Blockfrost project id before the filter is in place.
import './redact-output.js';
import { webcrypto } from 'node:crypto';
import { totalmem } from 'node:os';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromHex, oraclePublicKey, parseOracleSecretKey, pureCircuits, Status, toHex } from '@nightcast/contract';
import { drawStarfall } from '@nightcast/sdk';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { compilerInfo, type Fingerprints, localFingerprints } from './fingerprints.js';
import { isLocked, lockMaintenanceAuthority } from './lock.js';
import {
  BLOCKFROST,
  blockfrostProjectId,
  connect,
  createLogger,
  defaultBlockfrostFile,
  redact,
  isNetwork,
  type Network,
  NETWORKS,
  nightcastProviders,
  openWallet,
  FAUCETS,
  publicEndpoints,
  type Session,
  type WalletOptions,
  walletAddress,
  walletBalances,
  waitForSpendableDust,
} from './network.js';
import { currentCommit, type DeploymentRecord, readRecord, recordPath, writeRecord } from './record.js';
import { describeRequest, readRequest, startOracleService, submitRequest, waitForResult } from './service.js';
import { acceptOracleKey, deployNightcastLocked } from './steps.js';
import { formatChecks, verifyDeployment } from './verify.js';

const USAGE = `usage:
  ./nightcast deploy       --network <${NETWORKS.join('|')}> --oracle <file> --operator <file> --wallet <file> [--min 60] [--max 86400] [--accept] [--proof-server-port <port>]
  ./nightcast accept-key   --network <network> --oracle <oracle secret file> --wallet <file> [--proof-server-port <port>]
  ./nightcast lock         --network <network> --maintenance-key-file <file> --wallet <file> [--proof-server-port <port>]
                           (only for contracts deployed by older versions, which locked in a second transaction)
  ./nightcast verify       --network <network> [--address <contract address>]
  ./nightcast fingerprints
  ./nightcast doctor       --network <network> [--proof-server-port <port>]
  ./nightcast wallet new   --out <file>
  ./nightcast wallet show  --network <network> --wallet <file> [--proof-server-port <port>]
  ./nightcast oracle       --network <network> --oracle <oracle secret file> --wallet <file> [--requesters <hex,...>] [--poll 5] [--proof-server-port <port>]
  ./nightcast request      --network <network> --requester <requester secret file> --wallet <file> [--tag <text>] [--deadline-mins 30] [--wait] [--proof-server-port <port>]
  ./nightcast status       --network <network> --id <request id>
  ./nightcast blockfrost save --network <network> [--out <file>]

--oracle, --operator and --requester take files from \`./nightcast keygen\`. --wallet takes a
file from \`./nightcast wallet new\` (or set NIGHTCAST_WALLET_SEED). Deploy uses only the
public parts of key files, except with --accept, which needs the oracle secret.

Preprod needs a Blockfrost project id (https://blockfrost.io): save it once with
\`./nightcast blockfrost save --network preprod\`, or pass --blockfrost <file> to any
command, or set NIGHTCAST_BLOCKFROST_PROJECT_ID.`;

/** --blockfrost <file>, if given. */
let blockfrostFileArg: string | undefined;

/** The Blockfrost project id for a network that needs one, else undefined. */
const projectIdFor = (network: Network): string | undefined =>
  BLOCKFROST[network] ? blockfrostProjectId(network, blockfrostFileArg) : undefined;

/**
 * Read a line without echoing it (for pasting a project id). Falls back to
 * reading all of stdin when it isn't a terminal.
 */
const askHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c: string) => (data += c));
      stdin.on('end', () => resolve(data));
      stdin.on('error', reject);
      return;
    }
    process.stdout.write(question);
    let input = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return resolve(input);
        }
        if (ch === '\u0003') {
          finish();
          return reject(new Error('cancelled'));
        }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });

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

/** Wallet seed from --wallet <file> or NIGHTCAST_WALLET_SEED. */
const walletSeed = (file: string | undefined): string | undefined => {
  if (file) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { role?: string; seed?: string };
    if (parsed.role !== 'wallet' || !parsed.seed) throw new Error(`${file} is not a wallet file from \`./nightcast wallet new\``);
    return parsed.seed;
  }
  return process.env.NIGHTCAST_WALLET_SEED;
};

/** Wallet options that tell the user what's happening while the wallet gets ready. */
const walletOptions = (network: Network, seed: string | undefined, showAddress = false): WalletOptions => ({
  seed,
  onAddress: (address) => {
    if (!showAddress) return;
    const faucet = FAUCETS[network];
    process.stdout.write(
      `\nWallet address: ${address}\n\n` +
        (faucet ? `New wallet? You can request test NIGHT now, while it syncs: open ${faucet}\nand paste the address above.\n\n` : '') +
        `Syncing the wallet. A new wallet reads the whole chain, which can take a while;\n` +
        `progress is shown every 30 seconds...\n`,
    );
  },
  onNoFunds: (address) =>
    process.stdout.write(
      `\nThis wallet has no NIGHT yet. Get some from the ${network} faucet:\n` +
        `  1. Open ${FAUCETS[network] ?? 'the faucet for this network'}\n` +
        `  2. Paste this address: ${address}\n` +
        `  3. Complete the captcha and request tokens.\n` +
        `Waiting for the NIGHT to arrive (leave this running)...\n\n`,
    ),
  onWaitingForDust: () =>
    process.stdout.write('Registered the NIGHT for DUST (the fee token). Waiting for the first DUST...\n'),
});

const formatNight = (atoms: bigint): string => {
  const whole = atoms / 1_000_000n;
  const frac = (atoms % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};

const networkArg = (value: string | undefined): Network => {
  if (!value || !isNetwork(value)) throw new Error(`--network must be one of ${NETWORKS.join(', ')}`);
  return value;
};

const portArg = (value: string | undefined): number | undefined => (value ? Number.parseInt(value, 10) : undefined);

const withSession = async <T>(network: Network, proofServerPort: number | undefined, run: (s: Session) => Promise<T>) => {
  const session = await connect(network, { proofServerPort, projectId: projectIdFor(network) });
  try {
    return await run(session);
  } finally {
    await session.shutdown().catch((e) => session.logger.warn(`shutdown: ${e}`));
  }
};

const runVerify = async (session: Session | undefined, network: Network, address?: string): Promise<boolean> => {
  const record = readRecord(network);
  if (address && address !== record.contractAddress) throw new Error(`record is for ${record.contractAddress}, not ${address}`);
  const publicConfig = () => {
    if (network === 'local') throw new Error('verify on `local` must run inside the same session as the deploy');
    const logger = createLogger('warn');
    const c = publicEndpoints(network, logger, projectIdFor(network));
    setNetworkId(c.networkId);
    return c;
  };
  const config = session ? session.config : publicConfig();
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
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      wallet: { type: 'string' },
      requester: { type: 'string' },
      requesters: { type: 'string' },
      poll: { type: 'string', default: '5' },
      tag: { type: 'string' },
      'deadline-mins': { type: 'string', default: '30' },
      wait: { type: 'boolean', default: false },
      id: { type: 'string' },
      out: { type: 'string' },
      network: { type: 'string' },
      oracle: { type: 'string' },
      operator: { type: 'string' },
      min: { type: 'string', default: '60' },
      max: { type: 'string', default: '86400' },
      accept: { type: 'boolean', default: false },
      address: { type: 'string' },
      'maintenance-key-file': { type: 'string' },
      'proof-server-port': { type: 'string' },
      blockfrost: { type: 'string' },
    },
    strict: true,
  });
  blockfrostFileArg = values.blockfrost;

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
        const wallet = await openWallet(session, walletOptions(network, walletSeed(values.wallet)));
        try {
          const providers = nightcastProviders(session, wallet);
          session.logger.info('Deploying Nightcast, locked from the start (no admin key ever exists)...');
          const deployed = await deployNightcastLocked(providers, params);
          session.logger.info(`Deployed at ${deployed.contractAddress} (tx ${deployed.txId}); nobody can change its code`);

          const onChain = await providers.publicDataProvider.queryContractState(deployed.contractAddress);
          const authority = onChain!.maintenanceAuthority;
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
            // Locked in the deploy transaction itself, so there is no separate lock transaction.
            transactions: { deploy: deployed.txId, lockAuthority: deployed.txId },
            maintenanceAuthority: {
              committeeSize: authority.committee.length,
              threshold: authority.threshold,
              counter: authority.counter.toString(),
            },
            verifierKeys: fingerprints,
          };
          writeRecord(record);

          if (values.accept) {
            await waitForSpendableDust(wallet, session.logger);
            session.logger.info('Activating the oracle key...');
            const accepted = await acceptOracleKey(providers, deployed.contractAddress, parseOracleSecretKey(oracleFile.secret!));
            record.transactions.acceptOracleKey = accepted.txId;
            writeRecord(record);
          }

          session.logger.info(`Record written to ${recordPath(network)}`);
          const ok = await runVerify(session, network);
          if (!values.accept) {
            session.logger.info(
              `Next: the oracle runs \`./nightcast accept-key --network ${network} --oracle <oracle secret file>\``,
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
        const wallet = await openWallet(session, walletOptions(network, walletSeed(values.wallet)));
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
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { contractAddress: string | null; maintenanceKey: string };
      const record = readRecord(network);
      if (saved.contractAddress && saved.contractAddress !== record.contractAddress) {
        throw new Error('key file is for a different deployment');
      }
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, walletOptions(network, walletSeed(values.wallet)));
        try {
          const providers = nightcastProviders(session, wallet);
          const state = await providers.publicDataProvider.queryContractState(record.contractAddress);
          if (state && isLocked(state.maintenanceAuthority)) {
            session.logger.info('Already locked.');
          } else {
            const locked = await lockMaintenanceAuthority(providers, record.contractAddress, saved.maintenanceKey, {
              onStage: (m) => session.logger.info(m),
            });
            record.transactions.lockAuthority = locked.txId;
            record.maintenanceAuthority = {
              committeeSize: locked.authority.committee.length,
              threshold: locked.authority.threshold,
              counter: locked.authority.counter.toString(),
            };
            writeRecord(record);
          }
          rmSync(file, { force: true });
          session.logger.info(`Locked. Deleted ${file}; the key can no longer do anything.`);
          return (await runVerify(session, network)) ? 0 : 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'doctor': {
      const network = networkArg(values.network);
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const c = session.config;
        process.stdout.write(
          redact(
            `\nNetwork:      ${network} (${c.networkId})\nNode:         ${c.node}\nIndexer:      ${c.indexer}\nProof server: ${c.proofServer}\n\n`,
          ) +
            (session.problems.length === 0
              ? 'Everything answered. You are ready to go.\n'
              : `Problems:\n${session.problems.map((p) => `  - ${p}`).join('\n')}\n`),
        );
        const gb = totalmem() / 1024 ** 3;
        if (gb < 5) {
          process.stdout.write(
            `\nWarning: this computer (or Ubuntu on Windows) has only ${gb.toFixed(1)} GB of memory. Paying fees on Preprod\n` +
              `can need more. On Windows, add 'memory=6GB' under [wsl2] in %UserProfile%\\.wslconfig, run 'wsl --shutdown'\n` +
              `and restart Docker Desktop (see docs/preprod-guide.md).\n`,
          );
        }
        return session.problems.length === 0 ? 0 : 1;
      });
    }

    case 'blockfrost': {
      if (positionals[0] !== 'save') throw new Error('usage: ./nightcast blockfrost save --network <network> [--out <file>]');
      const network = networkArg(values.network);
      const endpoints = BLOCKFROST[network];
      if (!endpoints) throw new Error(`${network} doesn't use Blockfrost; no project id needed`);
      const out = values.out ?? defaultBlockfrostFile(network);
      process.stdout.write(
        `Paste your Blockfrost project id for Midnight ${network} and press Enter.\n` +
          `(Nothing shows while you paste; that's on purpose.)\n`,
      );
      // Project ids are letters and digits; drop anything else a paste may carry.
      const id = (await askHidden('Project id: ')).replace(/[^A-Za-z0-9]/g, '');
      if (!id) throw new Error('nothing was pasted; run the command again');
      const res = await fetch(`${endpoints.indexer}?project_id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"query":"{ __typename }"}',
        signal: AbortSignal.timeout(30_000),
      }).catch((err: unknown) => err as Error);
      if (res instanceof Error) {
        process.stdout.write(`Couldn't reach Blockfrost to check it (${res.message}); saving it anyway.\n`);
      } else if (!res.ok) {
        throw new Error(
          `Blockfrost refused that project id (HTTP ${res.status}). Check you copied the whole id, and that the project's ` +
            `network is Midnight ${network}. Nothing was saved.`,
        );
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, id + '\n', { mode: 0o600 });
      chmodSync(out, 0o600);
      process.stdout.write(
        `${res instanceof Error ? '' : 'Blockfrost accepted it. '}Saved to ${out} (${id.length} characters; keep it private).\n` +
          `Next: ./nightcast doctor --network ${network}\n`,
      );
      return 0;
    }

    case 'wallet': {
      const sub = positionals[0];
      if (sub === 'new') {
        if (!values.out) throw new Error('usage: ./nightcast wallet new --out <file>');
        const seed = toHex(webcrypto.getRandomValues(new Uint8Array(32)));
        writeFileSync(values.out, JSON.stringify({ role: 'wallet', seed }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        process.stdout.write(
          `New wallet seed written to ${values.out} (keep it private; anyone with it can spend from the wallet).\n` +
            `Next: ./nightcast wallet show --network preprod --wallet ${values.out}\n`,
        );
        return 0;
      }
      if (sub !== 'show') throw new Error('usage: ./nightcast wallet <new|show> ...');
      const network = networkArg(values.network);
      const seed = walletSeed(values.wallet);
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, walletOptions(network, seed, true));
        try {
          const { night, dust } = await walletBalances(wallet);
          process.stdout.write(`NIGHT: ${formatNight(night)} (${night} STAR)\nDUST:  ${dust} (pays transaction fees; it builds up over time)\n`);
          return 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'oracle': {
      const network = networkArg(values.network);
      if (!values.oracle) throw new Error(USAGE);
      const oracleFile = readKeyFile(values.oracle, 'oracle');
      if (!oracleFile.secret) throw new Error(`${values.oracle} has no secret`);
      const secretKey = parseOracleSecretKey(oracleFile.secret);
      const record = readRecord(network);
      const requesters = values.requesters?.split(',').map((r) => r.trim()).filter(Boolean);
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, walletOptions(network, walletSeed(values.wallet)));
        try {
          const { night, dust } = await walletBalances(wallet);
          session.logger.info(`Wallet ${walletAddress(wallet)}: ${formatNight(night)} NIGHT, ${dust} DUST`);
          const providers = nightcastProviders(session, wallet);
          const running = await startOracleService(providers, record.contractAddress, secretKey, session.logger, {
            pollMs: Number(values.poll) * 1000,
            requesters,
          });
          session.logger.info('Press Ctrl+C to stop.');
          await new Promise<void>((resolve) => {
            process.once('SIGINT', resolve);
            process.once('SIGTERM', resolve);
          });
          session.logger.info('Stopping the oracle...');
          await running.stop();
          return 0;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'request': {
      const network = networkArg(values.network);
      if (!values.requester) throw new Error(USAGE);
      const requesterFile = readKeyFile(values.requester, 'requester');
      if (!requesterFile.secret) throw new Error(`${values.requester} has no secret`);
      const requesterSecret = fromHex(requesterFile.secret);
      const record = readRecord(network);
      const maxMins = Number(record.parameters.maxWindow) / 60;
      const mins = Math.min(Number(values['deadline-mins']), maxMins);
      return withSession(network, portArg(values['proof-server-port']), async (session) => {
        const wallet = await openWallet(session, walletOptions(network, walletSeed(values.wallet)));
        try {
          const providers = nightcastProviders(session, wallet);
          session.logger.info('Submitting a request...');
          const req = await submitRequest(providers, record.contractAddress, requesterSecret, {
            tag: values.tag,
            deadlineSecs: Math.floor(mins * 60),
          });
          process.stdout.write(`\nRequest id: ${toHex(req.id)}\nDeadline:   ${new Date(Number(req.deadline) * 1000).toISOString()}\n\n`);
          if (!values.wait) {
            process.stdout.write(`Check it with: ./nightcast status --network ${network} --id ${toHex(req.id)}\n`);
            return 0;
          }
          session.logger.info('Waiting for the oracle to answer...');
          const result = await waitForResult(providers, record.contractAddress, req.id, {
            timeoutMs: (mins + 1) * 60_000,
          });
          process.stdout.write(describeRequest(req.id, result) + '\n');
          if (result?.status === Status.fulfilled) {
            const words = [0n, 1n].map((i) => toHex(pureCircuits.randomWord(result.output, i)));
            const draw = drawStarfall(toHex(result.output));
            process.stdout.write(
              `words    ${words.join(' ')}\nlotto    ${draw.numbers.join(' ')} + Moonball ${draw.moonball} (Starfall example)\n`,
            );
            return 0;
          }
          return 1;
        } finally {
          await wallet.stop().catch(() => undefined);
        }
      });
    }

    case 'status': {
      const network = networkArg(values.network);
      if (!values.id) throw new Error(USAGE);
      const record = readRecord(network);
      const id = fromHex(values.id);
      if (network === 'local') throw new Error('status on `local` must run inside the same session');
      const logger = createLogger('warn');
      const config = publicEndpoints(network, logger, projectIdFor(network));
      setNetworkId(config.networkId);
      const publicDataProvider = indexerPublicDataProvider(config.indexer, config.indexerWS);
      const r = await readRequest({ publicDataProvider }, record.contractAddress, id);
      process.stdout.write(describeRequest(id, r) + '\n');
      return 0;
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

/**
 * Ctrl+C: some libraries we use install their own signal handlers, which
 * stops Node's default exit. The first press asks the command to stop (the
 * oracle shuts down cleanly) and exits after 20 seconds at most; a second
 * press exits at once. Wallet progress is saved every 2 minutes regardless.
 */
const installStopKeys = (): void => {
  let presses = 0;
  const stop = () => {
    presses += 1;
    if (presses > 1) {
      process.stderr.write('\nStopped.\n');
      process.exit(130);
    }
    process.stderr.write('\nStopping... (press Ctrl+C again to stop immediately)\n');
    setTimeout(() => {
      process.stderr.write('Stopped.\n');
      process.exit(130);
    }, 20_000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};

if (invokedDirectly()) {
  installStopKeys();
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(redact(`${err instanceof Error ? err.message : String(err)}`) + '\n');
      process.exit(1);
    },
  );
}

export { main };
