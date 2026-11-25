#!/usr/bin/env node
/**
 * Keys for a test deployment of the threshold network. Prints public values only; the secrets
 * stay in the files (mode 600), and an existing file is never overwritten.
 *
 *   node network/threshold/ops/keys.mjs house --dir <dir>
 *       The house's four operator keys, house-1.secret ... house-4.secret. Their ids are what the
 *       contract is deployed with.
 *   node network/threshold/ops/keys.mjs pools --dir <dir> [--count 12]
 *       Test stake pool keys pool-1.secret ... (Ed25519, standing in for real pools' keys) and the
 *       public list <dir>/pool-list.json: the keys in order, and the commitment the contract is
 *       deployed with. A real list is built from Cardano by a public rule, not here.
 *   node network/threshold/ops/keys.mjs operators --dir <dir> [--count 5]
 *       Independent operators' keys op-1.secret ... (each will need a pool's signature to count).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hex, jsonText, newOperatorFile, newPoolFile, operatorFrom, poolList, readJson, say } from './common.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, count: { type: 'string' } } });
const mode = positionals[0];
if (!values.dir) throw new Error('--dir <dir> is required (where the key files are kept)');
const dir = values.dir;

const operatorFiles = (prefix, count) => {
  for (let n = 1; n <= count; n++) {
    const file = join(dir, `${prefix}-${n}.secret`);
    const made = !existsSync(file);
    const id = made ? newOperatorFile(file, `${prefix}-${n}`) : operatorFrom(file).id;
    say(`${`${prefix}-${n}`.padEnd(8)} ${hex(id)}${made ? '  (new)' : ''}`);
  }
};

if (mode === 'house') {
  operatorFiles('house', 4);
} else if (mode === 'operators') {
  operatorFiles('op', Number(values.count ?? 5));
} else if (mode === 'pools') {
  const count = Number(values.count ?? 12);
  const pools = [];
  for (let n = 1; n <= count; n++) {
    const file = join(dir, `pool-${n}.secret`);
    const made = !existsSync(file);
    const pub = made ? newPoolFile(file, `pool-${n}`) : readJson(file).public;
    pools.push({ name: `pool-${n}`, public: pub });
    say(`${`pool-${n}`.padEnd(8)} ${pub}${made ? '  (new)' : ''}`);
  }
  const list = poolList(pools.map((p) => p.public));
  const out = join(dir, 'pool-list.json');
  writeFileSync(out, jsonText({ note: 'Test stake pool keys, in list order. The contract is deployed with `root`.', pools, batches: list.batches.length, root: hex(list.root) }));
  say(`${count} pools in ${list.batches.length} batches; the list's commitment is ${hex(list.root)}`);
  say(`written to ${out}`);
} else {
  process.stderr.write('usage: node network/threshold/ops/keys.mjs house|pools|operators --dir <dir> [--count N]\n');
  process.exitCode = 2;
}
