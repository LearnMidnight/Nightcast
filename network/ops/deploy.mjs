#!/usr/bin/env node
/**
 * Deploy the Nightcast network contract on a ledger 9 network, locked from the start (its
 * maintenance authority is an empty committee in the deploy transaction itself, so nobody ever
 * holds a key that could change it), and check it on the chain.
 *
 *   node network/ops/deploy.mjs offline [settings]
 *       No network: runs the constructor, builds the locked deploy, prices it against the block
 *       limits and checks the circuits and settings.
 *   node network/ops/deploy.mjs deploy --wallet <file> [settings] [--network preprod] [--proof-server-port 6304]
 *       The deployment; writes network/deployments/<network>.json.
 *
 * Settings (tNIGHT): --fee 0.1 (to each of a request's three operators) --collateral 1 (one slot
 * of each named operator's bond) --min-bond 10 (slots) --min 60 --max 3600 (seconds a deadline may
 * be from now).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createUnprovenDeployTx, submitTx, verifierKeysEqual } from '@midnight-ntwrk/midnight-js/contracts';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { inMemoryPrivateStateProvider } from '@midnight-ntwrk/testkit-js';
import { ContractDeploy, ContractMaintenanceAuthority, ContractState, Intent, LedgerParameters, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { isLocked, TX_TTL_SECONDS } from '@nightcast/deploy';
import { BUILD, compiled, circuitsBuilt, hex, ledgerOf, night, recordFile, say, sleep, tn, withChain } from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
    fee: { type: 'string', default: '0.1' }, collateral: { type: 'string', default: '1' }, 'min-bond': { type: 'string', default: '10' },
    min: { type: 'string', default: '60' }, max: { type: 'string', default: '3600' },
  },
});
const mode = positionals[0];
const S = { fee: night(values.fee), collateral: night(values.collateral), minBond: BigInt(values['min-bond']), minWindow: BigInt(values.min), maxWindow: BigInt(values.max) };
const args = [S.minWindow, S.maxWindow, S.fee, S.collateral, S.minBond];
const ttl = () => new Date(Date.now() + TX_TTL_SECONDS * 1000);
const opNames = (state) => state.operations().map((o) => (typeof o === 'string' ? o : Buffer.from(o).toString())).sort();
/** The largest share of a block's limit the transaction uses (the Starfall v2 deploys stay under 0.55). */
const fullnessOf = (tx) => {
  const p = LedgerParameters.initialParameters();
  try {
    const n = p.normalizeFullness(tx.cost(p));
    const d = ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned'].reduce((a, b) => (n[b] > n[a] ? b : a));
    return { max: n[d], dimension: d };
  } catch {
    return { max: Infinity, dimension: 'over a limit' };
  }
};

/** The locked deploy: the constructor as Midnight.js runs it, with the authority replaced by an empty committee. */
const lockedDeploy = async (providers, networkId) => {
  const built = await createUnprovenDeployTx(providers, { compiledContract: compiled(), privateStateId: 'network-deploy', initialPrivateState: {}, args });
  const state = ContractState.deserialize(built.public.initialContractState.serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority([], 1, 0n);
  const deploy = new ContractDeploy(state);
  const tx = Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl()).addDeploy(deploy));
  return { deploy, address: String(deploy.address), tx, unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx) };
};

/** Exactly the compiled circuits, each with its compiled verifier key. */
const checkCircuits = (state) => {
  const want = circuitsBuilt();
  const have = opNames(state);
  const wrong = want.filter((o) => have.includes(o) && !verifierKeysEqual(state.operation(o).verifierKey, readFileSync(join(BUILD, 'keys', `${o}.verifier`))));
  return { ok: have.join() === want.join() && wrong.length === 0, detail: `${have.join(', ')}${wrong.length ? `; keys differ: ${wrong.join(', ')}` : ''}` };
};
const checkSettings = (l) => [
  [`fee ${tn(S.fee)} to each operator, collateral ${tn(S.collateral)} a slot, minimum bond ${S.minBond} slots`, l.operatorFee === S.fee && l.collateralPerRequest === S.collateral && l.minBondSlots === S.minBond],
  [`deadlines ${S.minWindow}-${S.maxWindow} s ahead`, l.minWindow === S.minWindow && l.maxWindow === S.maxWindow],
  ['no operators and no requests yet', l.operatorCount === 0n && l.requestCount === 0n],
];

if (mode === 'offline') {
  let failed = 0;
  const check = (name, ok, detail = '') => { if (!ok) failed++; say(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); };
  const empty = () => null;
  const chain = {
    queryBlock: async () => ({ hash: '11'.repeat(32), height: 1, timestamp: Date.now() }),
    queryContractState: empty, queryZSwapAndContractState: empty, queryDeployContractState: empty,
  };
  const providers = {
    privateStateProvider: inMemoryPrivateStateProvider(), publicDataProvider: chain,
    walletProvider: { getCoinPublicKey: () => '0'.repeat(64), getEncryptionPublicKey: () => '0'.repeat(64) },
    config: { networkId: 'preprod', ttlSeconds: TX_TTL_SECONDS }, zkConfigProvider: new NodeZkConfigProvider(BUILD, { verify: 'require-if-present' }),
  };
  const d = await lockedDeploy(providers, 'preprod');
  const f = fullnessOf(d.tx);
  check(`the deploy builds as a ledger 9 transaction`, d.unprovenTx.era === 'v9');
  check(`it is locked from the start (an empty committee)`, isLocked(d.deploy.initialState.maintenanceAuthority));
  check(`it carries exactly the 7 circuits with their compiled keys`, checkCircuits(d.deploy.initialState).ok, checkCircuits(d.deploy.initialState).detail);
  check(`it fits a block: ${f.max.toFixed(3)} of its ${f.dimension} (the Starfall v2 deploys stay under 0.55)`, f.max <= 0.55);
  for (const [name, ok] of checkSettings(ledgerOf(d.deploy.initialState))) check(`settings: ${name}`, ok);
  say(failed ? `${failed} FAILED` : 'all offline checks passed');
  process.exitCode = failed ? 1 : 0;
} else if (mode === 'deploy') {
  if (!values.wallet) throw new Error('--wallet <file> is required');
  const out = recordFile(values.network);
  if (existsSync(out)) throw new Error(`${out} exists: move it away first`);
  await withChain({ network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet }, async ({ session, providers, readState, me }) => {
    say(`deploying from ${me}`);
    const d = await lockedDeploy(providers, session.config.networkId);
    const f = fullnessOf(d.tx);
    say(`the deploy uses ${f.max.toFixed(3)} of a block's ${f.dimension}`);
    const r = await submitTx(providers, { unprovenTx: d.unprovenTx });
    if (r.status && r.status !== 'SucceedEntirely') throw new Error(`the deploy was recorded as ${r.status} (${r.txId})`);
    say(`deployed at ${d.address} (tx ${r.txId}); waiting for the indexer`);
    let st;
    for (let i = 0; i < 36 && !st; i++) { st = await readState(d.address).catch(() => null); if (!st) await sleep(5_000); }
    if (!st) throw new Error(`the indexer doesn't show ${d.address} after 3 minutes`);
    const checks = [
      ['locked: nobody can ever change its code', isLocked(st.maintenanceAuthority)],
      ['exactly its 7 circuits, each with the compiled verifier key', checkCircuits(st).ok],
      ...checkSettings(ledgerOf(st)),
    ];
    for (const [name, ok] of checks) say(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      network: values.network, contractAddress: d.address, deployedAt: new Date().toISOString(), txId: r.txId,
      compiler: JSON.parse(readFileSync(join(BUILD, 'compiler', 'contract-info.json'), 'utf8'))['compiler-version'],
      settings: { operatorFee: S.fee.toString(), collateralPerRequest: S.collateral.toString(), minBondSlots: S.minBond.toString(), minWindow: S.minWindow.toString(), maxWindow: S.maxWindow.toString() },
      verifierKeys: Object.fromEntries(circuitsBuilt().map((c) => [c, hex(readFileSync(join(BUILD, 'keys', `${c}.verifier`))).slice(0, 16)])),
      checks: checks.map(([name, ok]) => ({ name, ok })),
    }, null, 2) + '\n');
    say(`record written to ${out}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  });
} else {
  process.stderr.write('usage: node network/ops/deploy.mjs offline|deploy [--wallet <file>] [--fee 0.1] [--collateral 1] [--min-bond 10] [--min 60] [--max 3600]\n');
  process.exitCode = 2;
}
