#!/usr/bin/env node
/**
 * Deploy the Nightcast threshold network contract on a ledger 9 network and lock it.
 *
 * Its 18 circuits' verifier keys are too many for one transaction (a block's limits), so:
 *   1. the contract is deployed with as many circuits as fit (DEPLOY_BUDGET of a block, smallest
 *      key first) and a single-use maintenance key that exists only in this process's memory;
 *   2. the other circuits' keys are added in as few maintenance updates as fit;
 *   3. the contract is locked: its authority is replaced by an empty committee, so nobody can
 *      ever change it again;
 *   4. the chain is checked: exactly the compiled circuits, each with its compiled verifier key,
 *      the lock, and the settings.
 * If the process dies between 1 and 3 that deployment is useless (the key is gone): deploy again.
 * Nothing can be registered or paid in before the lock, because this script does nothing else.
 *
 *   node network/threshold/ops/deploy.mjs offline [settings]
 *       No network: runs the constructor (its own checks too), builds the deploy, the updates
 *       and the lock, prices each against the block limits, and checks circuits and settings.
 *       Without --house and --pools it makes up the house's ids and the list's commitment.
 *   node network/threshold/ops/deploy.mjs deploy --wallet <file> --house <dir> --pools <file> [settings]
 *       The deployment. --house holds house-1..4.secret, --pools is pool-list.json (keys.mjs makes
 *       both for a test). Writes network/threshold/deployments/<network>.json.
 *   Both: [--network preprod] [--proof-server-port 6304]
 *
 * Settings, fixed for the life of the contract (seconds; tNIGHT; bond slots). The defaults are
 * for a first measuring run on Preprod, with very generous times, since nothing has been proved
 * yet: --slack 600 (how far from the block's time a sender's "now" may be) --answer 6000
 * --ceremony 18000 --epoch 36000 --slot 1 (tNIGHT a bond slot) --min-bond 10 --penalty 2 (slots,
 * not finishing dealing) --fee 0.5 --bounty 0.1 --miss 1 (slots, a void request) --misses 3
 * --pending 3.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createUnprovenDeployTx, submitTx, verifierKeysEqual } from '@midnight-ntwrk/midnight-js/contracts';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { inMemoryPrivateStateProvider } from '@midnight-ntwrk/testkit-js';
import {
  ContractDeploy, ContractMaintenanceAuthority, ContractOperationVersionedVerifierKey, ContractState, Intent, LedgerParameters,
  MaintenanceUpdate, ReplaceAuthority, Transaction, VerifierKeyInsert, signData,
} from '@midnight-ntwrk/midnight-js-protocol/v9';
import { isLocked, TX_TTL_SECONDS } from '@nightcast/deploy';
import {
  BUILD, circuitsBuilt, compiled, errorText, hex, jsonText, ledgerOf, night, operatorFrom, operatorIdOf, poolList, randomScalar,
  readJson, recordFile, say, sleep, succeeded, tn, verifierKey, withChain,
} from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
    house: { type: 'string' }, pools: { type: 'string' },
    slack: { type: 'string', default: '600' }, answer: { type: 'string', default: '6000' }, ceremony: { type: 'string', default: '18000' }, epoch: { type: 'string', default: '36000' },
    slot: { type: 'string', default: '1' }, 'min-bond': { type: 'string', default: '10' }, penalty: { type: 'string', default: '2' },
    fee: { type: 'string', default: '0.5' }, bounty: { type: 'string', default: '0.1' }, miss: { type: 'string', default: '1' }, misses: { type: 'string', default: '3' }, pending: { type: 'string', default: '3' },
  },
});
const mode = positionals[0];
const S = {
  slack: BigInt(values.slack), epoch: BigInt(values.epoch), ceremony: BigInt(values.ceremony), answer: BigInt(values.answer),
  slot: night(values.slot), minBond: BigInt(values['min-bond']), penalty: BigInt(values.penalty), fee: night(values.fee), bounty: night(values.bounty),
  miss: BigInt(values.miss), misses: BigInt(values.misses), pending: BigInt(values.pending),
};
/** How full of a block (its largest cost dimension) a transaction here may be: Preprod took 0.600 and refused 0.677 (Starfall v2, 15 Nov 2026). */
const DEPLOY_BUDGET = 0.55;
const COST_DIMENSIONS = ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned'];
const ttl = () => new Date(Date.now() + TX_TTL_SECONDS * 1000);
const opNames = (state) => state.operations().map((o) => (typeof o === 'string' ? o : Buffer.from(o).toString())).sort();
const txOf = (networkId, intent) => Transaction.fromParts(networkId, undefined, undefined, intent);
const sealed = (tx) => LedgerTransaction.seal('v9', 'Unproven', tx);
/** The largest share of a block's limit the transaction uses, and in which dimension (Infinity if over a limit). */
const fullnessOf = (tx) => {
  const p = LedgerParameters.initialParameters();
  try {
    const n = p.normalizeFullness(tx.cost(p));
    const dimension = COST_DIMENSIONS.reduce((a, b) => (n[b] > n[a] ? b : a));
    return { max: n[dimension], dimension };
  } catch {
    return { max: Infinity, dimension: 'over a limit' };
  }
};
const full3 = (f) => `${f.max.toFixed(3)} of a block's ${f.dimension}`;

// ------------------------------------------------------------------ what it is deployed with
/** The house's four operator ids and the pool list's commitment: from files, or made up (offline only). */
const inputs = () => {
  const house = values.house
    ? [1, 2, 3, 4].map((n) => operatorFrom(join(values.house, `house-${n}.secret`)).id)
    : [1, 2, 3, 4].map(() => operatorIdOf(randomScalar()));
  if (!values.pools) {
    // no list: 32 random bytes stand in for its commitment (the contract takes any; nothing could be loaded against it)
    return { house, poolsRoot: webcrypto.getRandomValues(new Uint8Array(32)), listed: 0, madeUp: true };
  }
  const file = readJson(values.pools);
  const list = poolList(file.pools.map((p) => p.public));
  if (hex(list.root) !== file.root) throw new Error(`${values.pools}: its keys give the commitment ${hex(list.root)}, not the ${file.root} written in it`);
  return { house, poolsRoot: list.root, listed: file.pools.length, madeUp: !values.house };
};
const argsOf = (inp) => [S.slack, S.epoch, S.ceremony, S.answer, S.slot, S.minBond, S.penalty, S.fee, S.bounty, S.miss, S.misses, S.pending, inp.house, inp.poolsRoot];

// ------------------------------------------------------------------ the transactions
/** A deploy of `full`'s data, balance and authority with only the operations `ops`. */
const withOps = (full, ops, networkId) => {
  const state = new ContractState();
  state.data = full.data;
  state.balance = full.balance;
  state.maintenanceAuthority = full.maintenanceAuthority;
  for (const op of ops) state.setOperation(op, full.operation(op));
  const deploy = new ContractDeploy(state);
  const tx = txOf(networkId, Intent.new(ttl()).addDeploy(deploy));
  return { deploy, address: String(deploy.address), tx, unprovenTx: sealed(tx) };
};
/** Verifier keys for `ops` in one maintenance update at `counter`, signed with the single-use key. */
const addKeysUpdate = (address, ops, counter, signingKey) => {
  const update = new MaintenanceUpdate(address, ops.map((o) => new VerifierKeyInsert(o, new ContractOperationVersionedVerifierKey('v4', verifierKey(o)))), counter);
  return update.addSignature(0n, signData(signingKey, update.dataToSign));
};
/** The lock: the authority replaced by an empty committee (threshold 1: nobody can ever sign). */
const lockUpdate = (address, counter, signingKey) => {
  const update = new MaintenanceUpdate(address, [new ReplaceAuthority(new ContractMaintenanceAuthority([], 1, counter + 1n))], counter);
  return update.addSignature(0n, signData(signingKey, update.dataToSign));
};
const updateTx = (networkId, update) => txOf(networkId, Intent.new(ttl()).addMaintenanceUpdate(update));

/**
 * The whole plan: the constructor as Midnight.js runs it (which also samples the single-use
 * maintenance key and puts it in the authority), the circuits that fit in the deploy, and the
 * rest grouped into maintenance updates that each fit too.
 */
const planFor = async (providers, networkId, args) => {
  const built = await createUnprovenDeployTx(providers, { compiledContract: compiled(), privateStateId: 'threshold-deploy', initialPrivateState: {}, args });
  const full = ContractState.deserialize(built.public.initialContractState.serialize());
  const signingKey = built.private.signingKey;
  const size = (o) => verifierKey(o).length;
  const order = opNames(full).sort((a, b) => size(a) - size(b) || (a < b ? -1 : 1));
  const dataOnly = fullnessOf(withOps(full, [], networkId).tx);
  if (dataOnly.max > DEPLOY_BUDGET) throw new Error(`the contract's starting data alone is ${full3(dataOnly)}: over the budget of ${DEPLOY_BUDGET}`);
  const inDeploy = [];
  for (const o of order) {
    if (fullnessOf(withOps(full, [...inDeploy, o], networkId).tx).max > DEPLOY_BUDGET) break;
    inDeploy.push(o);
  }
  const d = withOps(full, inDeploy, networkId);
  const groups = [];
  let group = [];
  for (const o of order.filter((x) => !inDeploy.includes(x))) {
    if (group.length && fullnessOf(updateTx(networkId, addKeysUpdate(d.address, [...group, o], 0n, signingKey))).max > DEPLOY_BUDGET) {
      groups.push(group);
      group = [];
    }
    group.push(o);
  }
  if (group.length) groups.push(group);
  for (const g of groups) {
    const f = fullnessOf(updateTx(networkId, addKeysUpdate(d.address, g, 0n, signingKey)));
    if (f.max > DEPLOY_BUDGET) throw new Error(`the key of ${g.join(', ')} alone is ${full3(f)}: over the budget`);
  }
  return { ...d, full, signingKey, inDeploy, groups, dataOnly, fullness: fullnessOf(d.tx), keyBytes: (ops) => ops.reduce((s, o) => s + size(o), 0) };
};

// ------------------------------------------------------------------ checks
/** Exactly the compiled circuits, each with its compiled verifier key. */
const checkCircuits = (state) => {
  const want = circuitsBuilt();
  const have = opNames(state);
  const extra = have.filter((o) => !want.includes(o));
  const missing = want.filter((o) => !have.includes(o));
  const wrong = want.filter((o) => have.includes(o) && !verifierKeysEqual(state.operation(o).verifierKey, verifierKey(o)));
  return { ok: !extra.length && !missing.length && !wrong.length, detail: `${have.length} circuits${extra.length ? `; extra: ${extra.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}${wrong.length ? `; keys differ: ${wrong.join(', ')}` : ''}` };
};
const checkSettings = (l, inp) => [
  [`times: a sender's "now" within ${S.slack} s; answering ${S.answer} s; ceremony ${S.ceremony} s; epoch ${S.epoch} s`, l.slack === S.slack && l.answerSecs === S.answer && l.ceremonySecs === S.ceremony && l.epochSecs === S.epoch],
  [`bond: ${tn(S.slot)} a slot, at least ${S.minBond} slots; ${S.penalty} slots for not finishing dealing, ${S.miss} for a void request`, l.collateralPerSlot === S.slot && l.minBondSlots === S.minBond && l.ceremonyPenalty === S.penalty && l.missPenalty === S.miss],
  [`requests: fee ${tn(S.fee)}, of which ${tn(S.bounty)} to whoever finalises; ${S.misses} missed answering times allowed; ${S.pending} open at once`, l.requestFee === S.fee && l.finaliseBounty === S.bounty && l.allowedMisses === S.misses && l.maxPending === S.pending],
  ['the house is the four operator ids given', l.house.length === 4 && l.house.every((h, k) => hex(h) === hex(inp.house[k]))],
  ['the pool list is the commitment given, and none of it is loaded yet', hex(l.poolsRoot) === hex(inp.poolsRoot) && hex(l.poolsNext) === hex(inp.poolsRoot) && l.poolCount === 0n],
  ['no epoch, no operators and no requests yet', l.current === 0n && l.opened === 0n && l.independents === 0n && l.houseActive === 0n && l.nextRequest === 0n],
];

// ------------------------------------------------------------------ the modes
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
  const inp = inputs();
  const want = circuitsBuilt();
  say(`${want.length} compiled circuits, ${want.reduce((s, o) => s + verifierKey(o).length, 0).toLocaleString('en')} bytes of verifier keys${inp.madeUp ? '; house ids and pool list made up for this check' : ''}`);
  const p = await planFor(providers, 'preprod', argsOf(inp));
  check('the constructor accepts the settings (its own checks passed)', true);
  check('the deploy builds as a ledger 9 transaction', p.unprovenTx.era === 'v9');
  check(`the starting data alone is ${full3(p.dataOnly)}`, p.dataOnly.max <= DEPLOY_BUDGET);
  check(`the deploy carries ${p.inDeploy.length} circuits (${p.keyBytes(p.inDeploy).toLocaleString('en')} bytes of keys), ${full3(p.fullness)} (budget ${DEPLOY_BUDGET}): ${p.inDeploy.join(', ')}`,
    p.inDeploy.length >= 1 && opNames(p.deploy.initialState).length === p.inDeploy.length && p.fullness.max <= DEPLOY_BUDGET);
  check('its authority is the single-use key alone, counter 0', p.full.maintenanceAuthority.committee.length === 1 && p.full.maintenanceAuthority.threshold === 1 && p.full.maintenanceAuthority.counter === 0n);
  let counter = 0n;
  for (const g of p.groups) {
    const u = addKeysUpdate(p.address, g, counter, p.signingKey);
    const f = fullnessOf(updateTx('preprod', u));
    check(`maintenance update ${counter + 1n} adds ${g.length} circuits (${p.keyBytes(g).toLocaleString('en')} bytes of keys), ${full3(f)}: ${g.join(', ')}`, u.updates.length === g.length && u.counter === counter && u.signatures.length === 1 && f.max <= DEPLOY_BUDGET);
    counter += 1n;
  }
  check(`deploy and updates together carry all ${want.length} circuits, each once`, [...p.inDeploy, ...p.groups.flat()].sort().join() === want.join());
  check('the full contract (what the chain holds after the updates) has exactly the compiled circuits and keys', checkCircuits(p.full).ok, checkCircuits(p.full).detail);
  const lock = lockUpdate(p.address, counter, p.signingKey);
  const lf = fullnessOf(updateTx('preprod', lock));
  check(`the lock, at counter ${counter}, replaces the authority with an empty committee (${full3(lf)})`, lock.counter === counter && isLocked(lock.updates[0].authority) && lock.updates[0].authority.counter === counter + 1n && lock.signatures.length === 1);
  for (const [name, ok] of checkSettings(ledgerOf(p.deploy.initialState), inp)) check(`settings: ${name}`, ok);
  say(`${2 + p.groups.length} transactions in all: the deploy, ${p.groups.length} update${p.groups.length === 1 ? '' : 's'}, the lock`);
  say(failed ? `${failed} FAILED` : 'all offline checks passed');
  process.exitCode = failed ? 1 : 0;
} else if (mode === 'deploy') {
  if (!values.wallet) throw new Error('--wallet <file> is required');
  if (!values.house || !values.pools) throw new Error('--house <dir> and --pools <pool-list.json> are required (keys.mjs makes test ones)');
  const out = recordFile(values.network);
  if (existsSync(out)) throw new Error(`${out} exists: move it away first`);
  const inp = inputs();
  await withChain({ network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet }, async ({ session, providers, readState, me }) => {
    const networkId = session.config.networkId;
    const record = { network: values.network, deployer: me, started: new Date().toISOString(), steps: [] };
    const step = async (name, f) => {
      const started = Date.now();
      say(`== ${name}`);
      try {
        const r = (await f()) ?? {};
        const seconds = Math.round((Date.now() - started) / 1000);
        record.steps.push({ step: name, ok: true, seconds, ...r });
        say(`   ok (${seconds} s)${r.txId ? `, transaction ${r.txId}` : ''}`);
        return r;
      } catch (e) {
        record.steps.push({ step: name, ok: false, error: errorText(e) });
        say(`   FAILED: ${errorText(e)}`);
        throw e;
      }
    };
    /** The contract's state once the indexer shows `ok` (it can lag the block a little). */
    const settled = async (address, ok, what, ms = 240_000) => {
      const until = Date.now() + ms;
      for (;;) {
        const st = await readState(address).catch(() => null);
        if (st && ok(st)) return st;
        if (Date.now() > until) throw new Error(`the chain did not show ${what} within ${ms / 1000} s`);
        await sleep(5_000);
      }
    };
    const send = async (tx, what) => succeeded(await submitTx(providers, { unprovenTx: tx }), what);
    say(`deploying from ${me}`);
    const p = await planFor(providers, networkId, argsOf(inp));
    const total = circuitsBuilt().length;
    await step(`1. deploy with ${p.inDeploy.length} of the ${total} circuits (${full3(p.fullness)}) and a single-use maintenance key`, async () => {
      const r = await send(p.unprovenTx, 'the deploy');
      await settled(p.address, (st) => opNames(st).length === p.inDeploy.length, `the contract with ${p.inDeploy.length} circuits`);
      say(`   the contract is at ${p.address}`);
      return { txId: r.txId, address: p.address, circuits: p.inDeploy };
    });
    let counter = 0n;
    let onChain = p.inDeploy.length;
    for (const g of p.groups) {
      const at = counter;
      const expect = onChain + g.length;
      await step(`${2n + at}. add ${g.length} more circuits' keys (maintenance update ${at + 1n}): ${g.join(', ')}`, async () => {
        const st = await readState(p.address);
        if (!st || st.maintenanceAuthority.counter !== at) throw new Error(`the maintenance counter on chain is ${st?.maintenanceAuthority.counter}, not ${at}`);
        const r = await send(sealed(updateTx(networkId, addKeysUpdate(p.address, g, at, p.signingKey))), 'adding the keys');
        await settled(p.address, (s) => s.maintenanceAuthority.counter === at + 1n && opNames(s).length === expect, `${expect} circuits at counter ${at + 1n}`);
        return { txId: r.txId, circuits: g };
      });
      counter += 1n;
      onChain = expect;
    }
    await step(`${2n + counter}. lock the contract: its authority replaced by an empty committee`, async () => {
      const r = await send(sealed(updateTx(networkId, lockUpdate(p.address, counter, p.signingKey))), 'the lock');
      await settled(p.address, (s) => isLocked(s.maintenanceAuthority), 'the contract locked');
      return { txId: r.txId };
    });
    const st = await readState(p.address);
    const checks = [
      ['locked: nobody can ever change its code', isLocked(st.maintenanceAuthority)],
      [`exactly its ${total} circuits, each with the compiled verifier key`, checkCircuits(st).ok],
      ...checkSettings(ledgerOf(st), inp),
    ];
    for (const [name, ok] of checks) say(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, jsonText({
      network: values.network, contractAddress: p.address, deployedAt: new Date().toISOString(), deployer: me,
      compiler: JSON.parse(readFileSync(join(BUILD, 'compiler', 'contract-info.json'), 'utf8'))['compiler-version'],
      settings: Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.toString()])),
      house: inp.house.map(hex), poolsRoot: hex(inp.poolsRoot), pools: inp.listed,
      verifierKeys: Object.fromEntries(circuitsBuilt().map((c) => [c, hex(verifierKey(c)).slice(0, 16)])),
      steps: record.steps, checks: checks.map(([name, ok]) => ({ name, ok })),
    }));
    say(`record written to ${out}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  });
} else {
  process.stderr.write('usage: node network/threshold/ops/deploy.mjs offline|deploy [--wallet <file>] [--house <dir>] [--pools <pool-list.json>] [settings]\n');
  process.exitCode = 2;
}
