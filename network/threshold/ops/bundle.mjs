#!/usr/bin/env node
/**
 * The compiled threshold contract an operator needs (its JavaScript, and the proving and verifier
 * keys: about 560 MB, 120 MB packed, too big for npm), as one file published with a GitHub release.
 *
 *   node network/threshold/ops/bundle.mjs pack --build <dir> --out <file.tar.gz> [--network preprod] [--contract <address>]
 *       Check the build's verifier keys against the contract on chain, then pack it. Prints the
 *       lines for network/threshold/releases/<network>.json (its SHA-256 and size).
 *   node network/threshold/ops/bundle.mjs fetch --into <dir> [--release <file>]
 *       Download the release's file, refuse it unless its SHA-256 is the one in the release file
 *       (which is in the repository), unpack it, and refuse it again unless every circuit's
 *       verifier key is the one on chain. Only then is <dir> put in place.
 *   node network/threshold/ops/bundle.mjs check --build <dir> [--network preprod] [--contract <address>]
 *       Only the check against the chain.
 *
 * Nothing here loads the compiled contract, so it works before there is one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { blockfrostProjectId, compareFingerprints, connect, localFingerprints, onChainFingerprints } from '@nightcast/deploy';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The releases kept in the repository: network -> { contract, build: { url, sha256, bytes } }. */
export const releaseFile = (network) => join(HERE, '..', 'releases', `${network}.json`);
const say = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const mb = (n) => `${(Number(n) / 1048576).toFixed(0)} MB`;
const sha256File = async (file) => {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _e, done) { h.update(chunk); done(); } }));
  return h.digest('hex');
};
export const readRelease = (network, file = releaseFile(network)) => {
  if (!existsSync(file)) throw new Error(`no release for ${network}: ${file} is missing`);
  const r = JSON.parse(readFileSync(file, 'utf8'));
  if (!r.contract || !r.build?.url || !/^[0-9a-f]{64}$/.test(r.build?.sha256 ?? '')) throw new Error(`${file} doesn't name a contract and a build (url, sha256)`);
  return r;
};

/** The verifier keys of the contract on chain, by circuit (SHA-256 of each). */
export const chainFingerprints = async ({ network = 'preprod', contract, proofServerPort, proofServerUrl }) => {
  // Reading the chain needs no proofs, but the connection asks after a proof server: given none, it would start one
  // in Docker (27 Nov). The usual one (6300, or Docker's NIGHTCAST_PROOF_SERVER_URL) is named instead.
  if (!proofServerPort && !proofServerUrl) proofServerUrl = process.env.NIGHTCAST_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';
  const session = await connect(network, { proofServerPort, proofServerUrl, projectId: blockfrostProjectId(network), waitForBlockfrost: true });
  try {
    const r = await indexerPublicDataProvider(session.config.indexer, session.config.indexerWS).queryContractState(contract);
    if (!r) throw new Error(`the indexer shows no contract at ${contract}`);
    return onChainFingerprints((r.contractState ?? r).deserialize({ v9: ContractState }));
  } finally {
    await session.shutdown().catch(() => undefined);
  }
};
/** Throws unless the build in `dir` has exactly the contract's circuits, each with the verifier key on chain. */
export const checkAgainstChain = async (dir, opts) => {
  for (const sub of ['contract', 'keys', 'zkir']) if (!existsSync(join(dir, sub))) throw new Error(`${dir} has no ${sub}/: not a compiled contract`);
  const onChain = await chainFingerprints(opts);
  const problems = compareFingerprints(onChain, localFingerprints(dir));
  if (problems.length) throw new Error(`the build in ${dir} isn't the contract at ${opts.contract}:\n  ${problems.join('\n  ')}`);
  return Object.keys(onChain).length;
};

const pack = async ({ build, out, network, contract, ...prover }) => {
  const n = await checkAgainstChain(build, { network, contract, ...prover });
  say(`all ${n} circuits' verifier keys are the ones on chain`);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  // The contents only, with no owner or time that differs from one packing to the next.
  const parts = ['contract', 'keys', 'zkir', 'compiler'].filter((p) => existsSync(join(build, p)));
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=2026-01-01 00:00Z', '-czf', resolve(out), '-C', build, ...parts], { stdio: 'inherit' });
  const sha256 = await sha256File(out), bytes = statSync(out).size;
  say(`packed: ${out}, ${mb(bytes)}`);
  let compiler;
  try { compiler = JSON.parse(readFileSync(join(build, 'compiler', 'contract-info.json'), 'utf8'))['compiler-version']; } catch { /* left out */ }
  say(`for network/threshold/releases/${network}.json:`);
  process.stdout.write(`${JSON.stringify({ network, contract, compiler, circuits: n, build: { url: '<the release file\'s download link>', sha256, bytes } }, null, 2)}\n`);
};

const fetchBuild = async ({ into, release }) => {
  const r = readRelease(undefined, release);
  const target = resolve(into);
  if (existsSync(join(target, '.checked.json')) && JSON.parse(readFileSync(join(target, '.checked.json'), 'utf8')).sha256 === r.build.sha256) {
    say(`${target} already holds this build, checked`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const file = `${target}.download`, tmp = `${target}.unpacking`;
  // A download that is already whole (a run stopped while unpacking) isn't fetched again.
  if (!(existsSync(file) && statSync(file).size === r.build.bytes && (await sha256File(file)) === r.build.sha256)) {
    say(`downloading ${mb(r.build.bytes)} from ${r.build.url}`);
    const res = await fetch(r.build.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`the download was refused: HTTP ${res.status}`);
    let got = 0, told = 0;
    const count = new Transform({
      transform(chunk, _e, done) {
        got += chunk.length;
        if (got - told > r.build.bytes / 10) { say(`  ${Math.round((100 * got) / r.build.bytes)}%`); told = got; }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), count, createWriteStream(file));
  }
  const sha256 = await sha256File(file);
  if (sha256 !== r.build.sha256) {
    rmSync(file, { force: true });
    throw new Error(`the download isn't the published build (SHA-256 ${sha256}, the release says ${r.build.sha256}): refused and deleted`);
  }
  say('the download is the published build (its SHA-256 matches the one in the repository)');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', tmp, '--no-same-owner', '--no-same-permissions'], { stdio: 'inherit' });
  const n = await checkAgainstChain(tmp, { network: r.network, contract: r.contract });
  say(`all ${n} circuits' verifier keys are the ones on chain`);
  writeFileSync(join(tmp, '.checked.json'), `${JSON.stringify({ network: r.network, contract: r.contract, sha256, circuits: n, checked: new Date().toISOString() }, null, 2)}\n`);
  rmSync(target, { recursive: true, force: true });
  renameSync(tmp, target);
  rmSync(file, { force: true });
  say(`the build is in place: ${target}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { build: { type: 'string' }, out: { type: 'string' }, into: { type: 'string' }, release: { type: 'string' }, network: { type: 'string', default: 'preprod' }, contract: { type: 'string' }, 'proof-server-port': { type: 'string' } },
  });
  const contractOf = () => values.contract ?? readRelease(values.network).contract;
  const prover = values['proof-server-port'] ? { proofServerPort: Number(values['proof-server-port']) } : {};
  try {
    if (positionals[0] === 'pack') {
      if (!values.build || !values.out || !values.contract) throw new Error('pack takes --build <dir> --out <file.tar.gz> --contract <address>');
      await pack({ build: values.build, out: values.out, network: values.network, contract: values.contract, ...prover });
    } else if (positionals[0] === 'fetch') {
      if (!values.into) throw new Error('fetch takes --into <dir>');
      await fetchBuild({ into: values.into, release: values.release ?? releaseFile(values.network) });
    } else if (positionals[0] === 'check') {
      if (!values.build) throw new Error('check takes --build <dir>');
      say(`all ${await checkAgainstChain(values.build, { network: values.network, contract: contractOf(), ...prover })} circuits' verifier keys are the ones on chain`);
    } else {
      process.stderr.write('usage: node network/threshold/ops/bundle.mjs pack | fetch | check (see the top of this file)\n');
      process.exitCode = 2;
    }
  } catch (e) {
    say(`stopped: ${e?.message ?? e}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
export { fetchBuild };
