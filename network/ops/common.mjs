// Shared parts of the Nightcast network scripts: the compiled contract (Compact 0.36, ledger 9),
// a Preprod session and wallet from @nightcast/deploy, reading the contract's state, calling
// circuits with retries, and small file helpers.
import '@nightcast/deploy/explain-errors';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blockfrostProjectId, connect, contractProviders, openWallet, walletAddress } from '@nightcast/deploy';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
// network/node_modules' runtime 0.21: the one the compiled contract in network/build uses too.
import { StateValue } from '@midnight-ntwrk/compact-runtime';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
/** The compiled contract with its keys (network/build.sh). */
export const BUILD = process.env.NIGHTCAST_NET_BUILD ?? join(ROOT, 'build');
export const STAR = 1_000_000n;
export const hex = (b) => Buffer.from(b).toString('hex');
export const fromHex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
export const say = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;
export const night = (s) => BigInt(Math.round(Number(s) * 1e6));
export const errorText = (e) => {
  const parts = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i++) parts.push(x instanceof Error ? `${x.name}: ${x.message}` : String(x));
  return parts.join(' <- ').replace(/\s+/g, ' ').slice(0, 600);
};

// ------------------------------------------------------------------ the contract
if (!existsSync(join(BUILD, 'contract', 'index.js'))) throw new Error(`no compiled contract in ${BUILD}: run network/build.sh first`);
export const N = await import(pathToFileURL(join(BUILD, 'contract', 'index.js')).href);

const witnesses = {
  oracleSecretKey: ({ privateState }) => {
    if (privateState.oracleSecretKey === undefined) throw new Error('no operator secret key in private state');
    return [privateState, privateState.oracleSecretKey];
  },
  requesterSecret: ({ privateState }) => {
    if (privateState.requesterSecret === undefined) throw new Error('no requester secret in private state');
    return [privateState, privateState.requesterSecret];
  },
};
export const compiled = () => CompiledContract.withCompiledFileAssets(CompiledContract.withWitnesses(CompiledContract.make('network', N.Contract), witnesses), BUILD);
export const circuitsBuilt = () => ['answer', 'depositBond', 'expire', 'finalise', 'register', 'request', 'withdrawBond'];

/** The contract's ledger from a ledger 9 contract state. */
export const ledgerOf = (state) => N.ledger(StateValue.decode(state.data.state.encode()));

// ------------------------------------------------------------------ the deployment record
export const recordFile = (network) => process.env.NIGHTCAST_NET_RECORD ?? join(ROOT, 'deployments', `${network}.json`);
export const readRecord = (network) => {
  const f = recordFile(network);
  if (!existsSync(f)) throw new Error(`no deployment record at ${f}: deploy first (network/ops/deploy.mjs deploy)`);
  return JSON.parse(readFileSync(f, 'utf8'));
};

// ------------------------------------------------------------------ keys and files
const JUBJUB_ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
export const newOperatorSecret = () => {
  for (;;) {
    let n = 0n;
    for (const b of webcrypto.getRandomValues(new Uint8Array(64))) n = (n << 8n) | BigInt(b);
    const sk = n % JUBJUB_ORDER;
    if (sk !== 0n) return sk;
  }
};
export const operatorIdOf = (sk) => N.pureCircuits.keyIdOf(N.pureCircuits.publicKey(sk));
export const writeSecret = (file, body) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
};
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const walletSeedFrom = (file) => {
  const w = readJson(file);
  if (w.role !== 'wallet' || !w.seed) throw new Error(`${file} is not a wallet file from \`./nightcast wallet new\``);
  return w.seed;
};
export const appendJsonl = (file, row) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v)) + '\n');
};
export const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ------------------------------------------------------------------ the chain
/**
 * A Preprod session and an open wallet (synced, with DUST), then `f({ session, wallet, providers,
 * read, handle })`. `read()` gives the contract's ledger; `handle(privateStateId, privateState)`
 * a contract handle whose `callTx` sends transactions. The wallet is stopped afterwards.
 */
export const withChain = async ({ network = 'preprod', proofServerPort, walletFile, address }, f) => {
  // Preprod is served by Blockfrost: its project id as the CLI finds it (NIGHTCAST_BLOCKFROST_PROJECT_ID,
  // else ~/nightcast-secrets/blockfrost-<network>.secret, saved by `./nightcast blockfrost save`).
  const session = await connect(network, { proofServerPort, projectId: blockfrostProjectId(network), waitForBlockfrost: true });
  try {
    const wallet = await openWallet(session, { seed: walletSeedFrom(walletFile) });
    try {
      const providers = contractProviders(session, wallet, BUILD);
      const readState = async (a = address) => {
        const r = await providers.publicDataProvider.queryContractState(a);
        if (!r) return null;
        return (r.contractState ?? r).deserialize({ v9: ContractState });
      };
      const read = async (a = address) => {
        const s = await readState(a);
        if (!s) throw new Error(`no contract at ${a}`);
        return ledgerOf(s);
      };
      const handles = new Map();
      const handle = async (privateStateId, privateState) => {
        if (!handles.has(privateStateId)) {
          handles.set(privateStateId, await findDeployedContract(providers, { contractAddress: address, compiledContract: compiled(), privateStateId, initialPrivateState: privateState }));
        }
        return handles.get(privateStateId);
      };
      return await f({ session, wallet, providers, read, readState, handle, me: walletAddress(wallet), meBytes: fromHex(wallet.unshieldedKeystore.getAddress()) });
    } finally {
      await wallet.stop().catch(() => undefined);
    }
  } finally {
    await session.shutdown().catch(() => undefined);
  }
};

/** A transaction the chain recorded as anything but a full success is a failure. */
export const succeeded = (r, what) => {
  const status = r?.public?.status ?? r?.status;
  if (status !== undefined && status !== 'SucceedEntirely') throw new Error(`${what}: the chain recorded it as ${status}${r?.public?.txId ? ` (transaction ${r.public.txId})` : ''}`);
  return r;
};

/**
 * Send a call, trying again (up to `tries`, `waitMs` apart) when it fails for a reason that can
 * pass: a fee or DUST hiccup, a busy proof server, or a clash with another transaction in the
 * same block (ledger 9 holds a transaction to the costs it declared, so adding to a map another
 * transaction just changed can be refused as "ran out of gas"). A contract assertion is final.
 */
export const send = async (what, call, { tries = 4, waitMs = 15_000, log = say } = {}) => {
  let last;
  for (let i = 1; i <= tries; i++) {
    const started = Date.now();
    try {
      const r = succeeded(await call(), what);
      return { result: r.private?.result, txId: r.public?.txId, seconds: (Date.now() - started) / 1000, tries: i };
    } catch (e) {
      last = e;
      const text = errorText(e);
      // The contract refused it (an assert): sending it again gives the same answer.
      if (/failed assert|assertion failed|not pending|already answered|already exists|not one of this request|has not passed|has expired/i.test(text)) throw e;
      if (i < tries) log(`${what}: try ${i} failed (${text.slice(0, 160)}); again in ${waitMs / 1000} s`);
    }
    await sleep(waitMs);
  }
  throw last;
};
