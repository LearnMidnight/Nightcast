#!/usr/bin/env node
/**
 * Pay fees with two DUST spends, when asked to (ledger 9 workaround).
 *
 * Ledger 9 can refuse a small contract call whose fee is paid with exactly one
 * DUST spend: `1010 custom error 231`, OutsideTimeToDismiss. One spend adds
 * about 3 KB and 2.7 ms of apply time but barely raises the size-based time
 * allowance (2 µs a byte, at least 15 ms), so a call costing about 10 ms goes
 * just over. With zero, two or more spends it passes. Midnight lists it in the
 * ledger 9 release notes ("pay the fee with two or more DUST spends") and
 * tracks a fix as midnight-ledger#838 (an npm upgrade when it ships). Nightcast
 * hit it on 10 Nov 2026 with `depositBond`.
 *
 * The dust wallet (5.x, wallet SDK 2) picks the fewest coins that cover the
 * fee, which is always one, and has no setting for more. This patch adds one:
 * with `NIGHTCAST_DUST_MIN_SPENDS=2` in the environment, once the fee is
 * covered by fewer coins than that, the smallest other coins are added (as
 * long as the wallet has them), and every coin pays at least 1 speck so each
 * is a real spend. Without the variable nothing changes. A wallet with one
 * DUST coin still pays with one: give it a second NIGHT UTXO registered for
 * DUST (see `NIGHTCAST_REGISTER_NEW_NIGHT` in network.ts).
 *
 * Idempotent; runs on `npm install` next to patch-dust-fee-loop.mjs.
 *   node deploy/scripts/patch-dust-two-spends.mjs [--quiet] [--check] [--root <dir>]
 * --check exits 1 if a 5.x dust wallet is found whose code isn't the code this
 * patch knows (a release with the fix, or a change to rebase on).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '/* nightcast: two dust spends */';

/** Where the fee, once covered, is spread over the chosen coins (dust-wallet 5.0.0, dist/v2/Transacting.js). */
export const BASE_CASE = `        if (deficit <= 0n) {
            return { fee, recipeInputs: distributeFeeAcrossInputs(inputs, fee - existingDust) };
        }`;
/** The end of distributeFeeAcrossInputs, after which the helpers go. */
export const SPREAD_END = '}, { result: [], remaining: fee }).result;\n';

export const HELPERS = `${MARKER}
const __nightcastMinSpends = () => {
    const raw = typeof process !== 'undefined' ? process.env?.NIGHTCAST_DUST_MIN_SPENDS : undefined;
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 4) : 1;
};
/** Like distributeFeeAcrossInputs, but with several coins asked for, every one pays at least 1 speck and the first the rest. */
const __nightcastSpread = (inputs, fee) => {
    if (__nightcastMinSpends() < 2 || inputs.length < 2 || fee < BigInt(inputs.length)) return distributeFeeAcrossInputs(inputs, fee);
    const first = fee - BigInt(inputs.length - 1);
    if (first > inputs[0].value) return distributeFeeAcrossInputs(inputs, fee);
    return inputs.map((input, i) => ({ ...input, value: i === 0 ? first : 1n }));
};
`;

export const NEW_BASE_CASE = `        if (deficit <= 0n) {
            ${MARKER}
            const wanted = __nightcastMinSpends();
            if (inputs.length > 0 && inputs.length < wanted && remaining.length > 0) {
                const extra = [...remaining].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, wanted - inputs.length);
                const nextInputs = EArray.appendAll(inputs, extra);
                const nextFee = yield* feeWith(nextInputs);
                const rest = remaining.filter((coin) => !extra.some((taken) => taken.token.nonce === coin.token.nonce));
                return yield* go(rest, nextInputs, nextFee);
            }
            return { fee, recipeInputs: __nightcastSpread(inputs, fee - existingDust) };
        }`;

/** Patch one Transacting.js source: the new source, 'already', or 'unknown'. */
export const patchSource = (src) => {
  if (src.includes(MARKER)) return 'already';
  if (src.split(BASE_CASE).length !== 2 || src.split(SPREAD_END).length !== 2) return 'unknown';
  return src.replace(SPREAD_END, `${SPREAD_END}${HELPERS}`).replace(BASE_CASE, NEW_BASE_CASE);
};

const main = () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const quiet = process.argv.includes('--quiet');
  const check = process.argv.includes('--check');
  const extraRoots = process.argv.flatMap((a, i, all) => (a === '--root' && all[i + 1] ? [resolve(all[i + 1])] : []));

  const targets = new Set();
  const visit = (nmDir, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(nmDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = join(nmDir, e.name);
      const pkgs = e.name.startsWith('@') ? readdirSync(p, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(p, x.name)) : [p];
      for (const pkg of pkgs) {
        if (pkg.endsWith('wallet-sdk-dust-wallet')) {
          const f = join(pkg, 'dist', 'v2', 'Transacting.js');
          try {
            if (statSync(f).size > 0) targets.add(f);
          } catch {
            // a 4.x dust wallet: no v2 variant, nothing to do
          }
        }
        visit(join(pkg, 'node_modules'), depth + 1);
      }
    }
  };
  for (const dir of ['.', 'contract', 'sdk', 'deploy']) visit(join(root, dir, 'node_modules'));
  for (const extra of extraRoots) visit(join(extra, 'node_modules'));

  let patched = 0;
  let already = 0;
  let unknown = 0;
  for (const file of targets) {
    const result = patchSource(readFileSync(file, 'utf8'));
    if (result === 'already') already += 1;
    else if (result === 'unknown') unknown += 1;
    else {
      writeFileSync(file, result);
      patched += 1;
    }
  }
  if (!quiet || patched > 0) {
    const parts = [];
    if (patched) parts.push(`added to ${patched} file(s)`);
    if (already) parts.push(`${already} already there`);
    if (unknown) parts.push(`${unknown} with different code left alone`);
    if (!parts.length) parts.push('no dust wallet 5.x found');
    process.stderr.write(`Two-DUST-spend option (NIGHTCAST_DUST_MIN_SPENDS): ${parts.join(', ')}\n`);
  }
  if (check && unknown > 0) process.exit(1);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
