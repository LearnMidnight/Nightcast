#!/usr/bin/env node
/**
 * Fix an endless loop in Midnight's dust wallet (wallet-sdk-dust-wallet 4.x)
 * when it works out a transaction's fee.
 *
 * `computeBalancingRecipe` seeds its first pass with the transaction's dust
 * imbalance (a deficit, negative) and every later pass with the fee it just
 * computed (positive). The balancer reads a non-negative seed as a surplus,
 * adds a change output and picks no coins, so if the first pass picked none
 * (its estimate was zero) the loop repeats forever, synchronously, with memory
 * growing until the ledger WASM aborts ("RuntimeError: unreachable" in
 * Transaction.merge). On Preprod this hit every call and maintenance
 * transaction; deploys happened to pick a coin first time.
 *
 * Midnight fixed it in dust-wallet 5.0 (changelog entry 7ee351c), which needs
 * ledger 9; Preprod runs ledger 8. Until then this applies the minimal fix to
 * the installed 4.x code: seed every pass with the outstanding fee as a
 * deficit, so the balancer always picks coins to cover it.
 *
 * A second fix (7 Nov 2026), "minimum dust fee": on a quiet chain ledger 8's
 * fee price falls so low that a transaction's fee comes out as 0. The wallet
 * then pays it with no DUST spends at all (an empty DustActions), which the
 * node refuses as not normal (`1010 custom error 117`, NotNormalized: Preprod's
 * keeper paid 1 speck a transaction all day, then couldn't open a draw). Ledger
 * 9 has a fee floor (min_block_price). Until then every fee is at least 1
 * speck: a zero fee is seeded as a deficit of 1 and paid as 1.
 *
 * Idempotent. Runs on `npm install` and before every ./nightcast command.
 *   node deploy/scripts/patch-dust-fee-loop.mjs [--quiet] [--check] [--root <dir>]
 * --check exits 1 if an unpatched copy is found (for CI). --root also patches
 * <dir>/node_modules: a project that uses Nightcast as a submodule (Lunardraw)
 * runs it with --root . from its own folder.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '/* nightcast: dust fee-loop fix */';
const PATTERN = /fromEntry\((['"])dust\1,\s*currentFee\)/g;
const MIN_MARKER = '/* nightcast: minimum dust fee */';
// after the first fix: the seed, and where the fee is spread over the chosen coins
const SEED = '(currentFee > 0n ? -currentFee : currentFee))';
const SPREAD = /distributeFeeAcrossInputs\(recipeInputs,\s*currentFee\)/g;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const quiet = process.argv.includes('--quiet');
const extraRoots = process.argv.flatMap((a, i, all) => (a === '--root' && all[i + 1] ? [resolve(all[i + 1])] : []));
const check = process.argv.includes('--check');

/** Every Transacting.js in any installed copy of the dust wallet package, following npm's layout. */
const walkModules = (nmDir, out, depth = 0) => {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = join(nmDir, e.name);
    if (e.name.startsWith('@')) {
      let pkgs = [];
      try {
        pkgs = readdirSync(p, { withFileTypes: true });
      } catch {
        pkgs = [];
      }
      for (const pkg of pkgs) if (pkg.isDirectory()) visitPackage(join(p, pkg.name), out, depth);
    } else {
      visitPackage(p, out, depth);
    }
  }
  return out;
};

const visitPackage = (pkgDir, out, depth) => {
  if (pkgDir.endsWith('wallet-sdk-dust-wallet')) collectTransacting(join(pkgDir, 'dist'), out);
  walkModules(join(pkgDir, 'node_modules'), out, depth + 1);
};

const collectTransacting = (dir, out) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectTransacting(p, out);
    else if (/^Transacting\.(c|m)?js$/.test(e.name) && statSync(p).size > 0) out.push(p);
  }
};

const targets = [];
for (const dir of ['.', 'contract', 'sdk', 'deploy']) walkModules(join(root, dir, 'node_modules'), targets);
for (const extra of extraRoots) walkModules(join(extra, 'node_modules'), targets);
let patched = 0;
let already = 0;
let unknown = 0;
for (const file of new Set(targets)) {
  let src = readFileSync(file, 'utf8');
  let changed = false;
  if (!src.includes(MARKER)) {
    const matches = src.match(PATTERN);
    if (!matches || matches.length !== 1) {
      // Not the code we know (e.g. a fixed release): leave it alone.
      if (src.includes('computeBalancingRecipe')) unknown += 1;
      continue;
    }
    src = src.replace(PATTERN, (_m, q) => `fromEntry(${q}dust${q}, ${MARKER} ${SEED}`);
    changed = true;
  }
  if (!src.includes(MIN_MARKER)) {
    const seeds = src.split(SEED).length - 1;
    const spreads = (src.match(SPREAD) ?? []).length;
    if (seeds !== 1 || spreads !== 1) {
      if (changed) writeFileSync(file, src);
      unknown += 1;
      continue;
    }
    src = src
      .replace(SEED, `${MIN_MARKER} (currentFee > 0n ? -currentFee : currentFee < 0n ? currentFee : -1n))`)
      .replace(SPREAD, 'distributeFeeAcrossInputs(recipeInputs, currentFee > 0n ? currentFee : 1n)');
    changed = true;
  }
  if (changed) {
    writeFileSync(file, src);
    patched += 1;
  } else already += 1;
}

const total = patched + already;
if (!quiet || patched > 0) {
  const parts = [];
  if (patched) parts.push(`fixed ${patched} file(s)`);
  if (already) parts.push(`${already} already fixed`);
  if (unknown) parts.push(`${unknown} with different code left alone`);
  if (!parts.length) parts.push('no dust wallet found (run npm install)');
  process.stderr.write(`Dust fee-loop and minimum-fee fixes: ${parts.join(', ')}\n`);
}
if (check && total === 0) process.exit(1);
