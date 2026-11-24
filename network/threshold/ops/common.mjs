// Shared parts of the threshold network's scripts: the compiled contract (Compact 0.36.1, ledger
// 9) with its witnesses, operator and stake pool keys, the pool list and its commitment, and a
// Preprod session with a wallet from @nightcast/deploy.
import '@nightcast/deploy/explain-errors';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createPrivateKey, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { blockfrostProjectId, connect, contractProviders, openWallet, walletAddress } from '@nightcast/deploy';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
// network/node_modules' runtime: the one the compiled contract uses too.
import { StateValue, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
/** The compiled contract with its keys: what `check/run-net.sh` leaves in check/out-net. */
export const BUILD = process.env.NIGHTCAST_TNET_BUILD ?? join(ROOT, 'check', 'out-net');
export const hex = (b) => Buffer.from(b).toString('hex');
export const fromHex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
export const say = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tn = (star) => `${(Number(star) / 1e6).toLocaleString('en', { maximumFractionDigits: 6 })} tNIGHT`;
export const night = (s) => BigInt(Math.round(Number(s) * 1e6));
export const errorText = (e) => {
  const parts = [];
  for (let x = e, i = 0; x && i < 6; x = x.cause, i++) parts.push(x instanceof Error ? `${x.name}: ${x.message}` : String(x));
  return parts.join(' <- ').replace(/\s+/g, ' ').slice(0, 900);
};
export const jsonText = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x), 2) + '\n';

// ------------------------------------------------------------------ the contract
if (!existsSync(join(BUILD, 'contract', 'index.js'))) throw new Error(`no compiled contract in ${BUILD}: run network/threshold/check/run-net.sh first`);
export const T = await import(pathToFileURL(join(BUILD, 'contract', 'index.js')).href);

/** The order of Jubjub's prime subgroup: operator secrets, shares and polynomials live below it. */
export const R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
const mod = (a, m = R) => ((a % m) + m) % m;
export const randomScalar = () => {
  for (;;) {
    let n = 0n;
    for (const b of webcrypto.getRandomValues(new Uint8Array(64))) n = (n << 8n) | BigInt(b);
    if (n % R !== 0n) return n % R;
  }
};
const need = (v, what) => { if (v === undefined) throw new Error(`no ${what} in private state`); return v; };
/** 720 · Π j/(j − i) over the other positions (0: no such other), as a whole number without its sign. */
const lagrange = (i, others) => {
  let num = 720n, den = 1n;
  for (const j of others) { if (!j) continue; num *= BigInt(j); den *= BigInt(j > i ? j - i : i - j); }
  if (num % den) throw new Error('not a whole coefficient');
  return num / den;
};
/**
 * What a circuit asks its caller for. Private state: operatorSecret (an operator's key), coefficients
 * (a dealer's polynomial, four numbers, zeros past the threshold), shareSecret (a seat's share of
 * the group key), requesterSecret (32 bytes), answerSecs (the contract's answering time).
 */
export const witnesses = {
  operatorSecret: ({ privateState }) => [privateState, need(privateState.operatorSecret, 'operator secret')],
  coefficients: ({ privateState }) => [privateState, need(privateState.coefficients, 'polynomial')],
  shareFor: ({ privateState }, i) => [privateState, mod(need(privateState.coefficients, 'polynomial').reduce((s, c, k) => s + c * BigInt(i) ** BigInt(k), 0n))],
  ephemeral: ({ privateState }) => [privateState, randomScalar()],
  shareSecret: ({ privateState }) => [privateState, need(privateState.shareSecret, 'share of the group key')],
  coefficient: ({ privateState }, i, a, b, c) => [privateState, lagrange(Number(i), [a, b, c].map(Number))],
  requesterSecret: ({ privateState }) => [privateState, need(privateState.requesterSecret, 'requester secret')],
  quotient: ({ privateState }, total, k) => [privateState, total / k],
  bucketOf: ({ privateState }, deadline) => [privateState, deadline / need(privateState.answerSecs, 'answering time')],
};
export const compiled = () => CompiledContract.withCompiledFileAssets(CompiledContract.withWitnesses(CompiledContract.make('threshold-net', T.Contract), witnesses), BUILD);
/** The circuits that were compiled with keys, by name. */
export const circuitsBuilt = () => readdirSync(join(BUILD, 'keys')).filter((f) => f.endsWith('.verifier')).map((f) => f.slice(0, -'.verifier'.length)).sort();
export const verifierKey = (circuit) => readFileSync(join(BUILD, 'keys', `${circuit}.verifier`));
/** The contract's ledger from a ledger 9 contract state. */
export const ledgerOf = (state) => T.ledger(StateValue.decode(state.data.state.encode()));

// ------------------------------------------------------------------ operator keys
export const operatorIdOf = (secret) => T.pureCircuits.keyIdOf(ecMulGenerator(secret));
/** Make an operator key file (mode 600; never overwrites). Returns its public id. */
export const newOperatorFile = (file, name) => {
  const secret = randomScalar();
  const id = operatorIdOf(secret);
  writeSecret(file, { role: 'threshold-operator', name, secret: secret.toString(16).padStart(64, '0'), public: hex(id) });
  return id;
};
export const operatorFrom = (file) => {
  const k = readJson(file);
  if (k.role !== 'threshold-operator') throw new Error(`${file} is not a threshold operator key`);
  return { name: k.name, secret: BigInt('0x' + k.secret), id: fromHex(k.public) };
};

// ------------------------------------------------------------------ stake pool keys and the list
// Ed25519 (RFC 8032): a 32-byte public key as the curve point the contract takes.
const Q = (1n << 255n) - 19n;
const pw = (b, e) => { let x = 1n; b = mod(b, Q); while (e > 0n) { if (e & 1n) x = mod(x * b, Q); b = mod(b * b, Q); e >>= 1n; } return x; };
const D_ED = mod(-121665n * pw(121666n, Q - 2n), Q);
const le = (b) => BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
export const ed25519Point = (bytes) => {
  const n = le(bytes), y = n & ((1n << 255n) - 1n), sgn = n >> 255n;
  const u = mod(y * y - 1n, Q), v = mod(D_ED * y * y + 1n, Q);
  let x = mod(u * pw(v, 3n) * pw(u * pw(v, 7n), (Q - 5n) / 8n), Q);
  if (mod(v * x * x, Q) !== u) x = mod(x * pw(2n, (Q - 1n) / 4n), Q);
  if (mod(v * x * x, Q) !== u) throw new Error('not an Ed25519 point');
  if ((x & 1n) !== sgn) x = mod(-x, Q);
  return { x, y };
};
/** A pool's id in the contract, from its 32-byte Ed25519 public key (hex). */
export const poolIdOf = (publicHex) => T.pureCircuits.poolIdOf(ed25519Point(fromHex(publicHex)));
/** Make a test stake pool key file (mode 600; never overwrites). Returns its public key (hex). */
export const newPoolFile = (file, name) => {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const pub = hex(Buffer.from(jwk.x, 'base64url'));
  writeSecret(file, { role: 'test-pool', name, secret: hex(Buffer.from(jwk.d, 'base64url')), public: pub });
  return pub;
};
/** A pool key file's signature over a 32-byte message, as the contract takes it. */
export const poolSign = (file, message) => {
  const k = readJson(file);
  if (k.role !== 'test-pool') throw new Error(`${file} is not a test pool key`);
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(k.secret, 'hex').toString('base64url'), x: Buffer.from(k.public, 'hex').toString('base64url') } });
  const g = sign(null, Buffer.from(message), key);
  return { r: ed25519Point(g.subarray(0, 32)), s: le(g.subarray(32)) };
};
const ZERO = new Uint8Array(32);
/**
 * The list as the contract takes it: batches of eight pool ids (zeros fill the last), each
 * committed to together with the batches after it. `root` is what the contract is deployed with;
 * `batches[k]` is what `loadPools` is called with, in order.
 */
export const poolList = (publicKeys) => {
  const ids = publicKeys.map(poolIdOf);
  const batches = [];
  let root = ZERO;
  for (let k = Math.ceil(ids.length / 8) - 1; k >= 0; k--) {
    const batch = Array.from({ length: 8 }, (_, j) => ids[k * 8 + j] ?? ZERO);
    batches.unshift({ ids: batch, next: root });
    root = T.pureCircuits.poolBatchOf(batch, root);
  }
  return { ids, batches, root };
};

// ------------------------------------------------------------------ files
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const writeSecret = (file, body) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
};
export const walletSeedFrom = (file) => {
  const w = readJson(file);
  if (w.role !== 'wallet' || !w.seed) throw new Error(`${file} is not a wallet file from \`./nightcast wallet new\``);
  return w.seed;
};
export const recordFile = (network) => process.env.NIGHTCAST_TNET_RECORD ?? join(ROOT, 'deployments', `${network}.json`);
export const readRecord = (network) => {
  const f = recordFile(network);
  if (!existsSync(f)) throw new Error(`no deployment record at ${f}: deploy first (network/threshold/ops/deploy.mjs deploy)`);
  return readJson(f);
};

// ------------------------------------------------------------------ the chain
/**
 * A Preprod session and an open wallet (synced, with DUST), then `f({ session, wallet, providers,
 * read, readState, handle, me })`. `readState(address)` gives a contract's ledger 9 state (null if
 * the indexer doesn't show it), `read(address)` its ledger, and `handle(id, privateState)` a
 * contract handle whose `callTx` sends transactions. The wallet is stopped afterwards.
 */
export const withChain = async ({ network = 'preprod', proofServerPort, walletFile, address }, f) => {
  // Preprod is served by Blockfrost: its project id as the CLI finds it (NIGHTCAST_BLOCKFROST_PROJECT_ID,
  // else ~/nightcast-secrets/blockfrost-<network>.secret).
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
  const txId = r?.public?.txId ?? r?.txId;
  if (status !== undefined && status !== 'SucceedEntirely') throw new Error(`${what}: the chain recorded it as ${status}${txId ? ` (transaction ${txId})` : ''}`);
  return r;
};
