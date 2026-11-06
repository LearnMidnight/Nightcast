#!/usr/bin/env node
/**
 * Checks what `npm pack --json` would publish, before anything goes to npm:
 * only built files, docs and licence; no secrets, wallets, env files, tests or
 * sources of the TypeScript; the compiled contract with its keys; sensible
 * sizes. Prints each package's contents as GitHub notices.
 *
 *   npm pack -w @nightcast/contract -w @nightcast/sdk --dry-run --json > pack.json
 *   node scripts/check-pack.mjs pack.json
 */
import { readFileSync } from 'node:fs';

const packs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const FORBIDDEN = [
  [/\.secret$|\.key$|(^|\/)\.env(\.|$)|\.seed$|wallet/i, 'a secret, key, wallet or env file'],
  [/(^|\/)test\/|\.test\.(js|ts|d\.ts)$/, 'a test'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/(^|\/)src\/.*\.ts$/, 'TypeScript source (dist only)'],
  [/\.tgz$|\.log$/, 'a tarball or log'],
];
const REQUIRED = {
  '@nightcast/contract': ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/nightcast.compact', 'dist/managed/nightcast/contract/index.js', 'dist/NightcastWords.compact', 'dist/words.js', 'dist/managed/words/contract/index.js'],
  '@nightcast/sdk': ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/pick.js', 'dist/keygen.js'],
};
const MAX_UNPACKED = 250 * 2 ** 20;

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`::error title=pack check::${msg}`);
};

for (const p of packs) {
  const paths = p.files.map((f) => f.path);
  for (const path of paths) for (const [re, what] of FORBIDDEN) if (re.test(path)) fail(`${p.name} would publish ${path} (${what})`);
  for (const need of REQUIRED[p.name] ?? []) if (!paths.includes(need)) fail(`${p.name} is missing ${need}`);
  if (!REQUIRED[p.name]) fail(`unexpected package ${p.name}`);
  if (p.unpackedSize > MAX_UNPACKED) fail(`${p.name} unpacks to ${(p.unpackedSize / 2 ** 20).toFixed(1)} MB`);
  const keys = paths.filter((x) => /managed\/nightcast\/keys\//.test(x));
  if (p.name === '@nightcast/contract' && !keys.some((k) => k.endsWith('.prover')) ) fail('@nightcast/contract has no proving keys (compile with keys, not --skip-zk)');
  const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`;
  const biggest = [...p.files].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => `${f.path} ${mb(f.size)}`).join(', ');
  console.log(`::notice title=${p.name}@${p.version}::${p.entryCount} files, ${mb(p.size)} packed, ${mb(p.unpackedSize)} unpacked; largest: ${biggest}`);
  console.log(`${p.name}@${p.version} (${p.filename})\n  ${paths.join('\n  ')}\n`);
}
process.exit(failed ? 1 : 0);
