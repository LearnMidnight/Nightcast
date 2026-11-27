#!/usr/bin/env node
/**
 * nightcast-operator: run an operator of the Nightcast threshold network.
 *
 *   nightcast-operator keys [--home <folder>] [--network preprod]
 *       Download the compiled contract and its proving keys (about 560 MB) into <folder>/build.
 *       The download is refused unless its SHA-256 is the one in this repository
 *       (network/threshold/releases/<network>.json) and every circuit's verifier key is the one
 *       on chain. First, before anything else.
 *   nightcast-operator init | status | wallet | register | link | topup | claim | withdraw | leave | send | run ...
 *       See network/threshold/ops/operator.mjs.
 */
import { homeOf } from './operator-env.mjs';

if (process.argv[2] === 'keys') {
  const { join } = await import('node:path');
  const { parseArgs } = await import('node:util');
  const { fetchBuild, releaseFile } = await import('./bundle.mjs');
  const { values } = parseArgs({ allowPositionals: true, options: { home: { type: 'string' }, network: { type: 'string', default: 'preprod' }, release: { type: 'string' } } });
  try {
    await fetchBuild({ into: join(homeOf(), 'build'), release: values.release ?? releaseFile(values.network) });
    process.stdout.write('Next: nightcast-operator init\n');
  } catch (e) {
    process.stdout.write(`stopped: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
} else {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const build = process.env.NIGHTCAST_TNET_BUILD ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'check', 'out-net');
  if (!existsSync(join(build, 'contract', 'index.js'))) {
    process.stdout.write(`no compiled contract yet (looked in ${build}): run nightcast-operator keys first\n`);
    process.exit(1);
  }
  await import('./operator.mjs');
}
