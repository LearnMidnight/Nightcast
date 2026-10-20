import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Circuit name -> SHA-256 (hex) of its verifier key. */
export type Fingerprints = Record<string, string>;

export type CompilerInfo = { compiler: string; language: string; runtime: string };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Directory with the compiled contract (`keys/`, `zkir/`, `compiler/`): the
 * one published in `@nightcast/contract`, unless overridden.
 */
export const zkConfigPath = (override = process.env.NIGHTCAST_ZK_CONFIG_PATH): string => {
  if (override) return override;
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve('@nightcast/contract/package.json'));
  for (const candidate of [join(pkg, 'dist', 'managed', 'nightcast'), join(pkg, 'src', 'managed', 'nightcast')]) {
    if (existsSync(join(candidate, 'keys'))) return candidate;
  }
  throw new Error('No compiled contract with proving keys found. Run `npm run compact` then `npm run build`.');
};

/** Fingerprints of the verifier keys produced by the compiler. */
export const localFingerprints = (dir = zkConfigPath()): Fingerprints => {
  const keys = join(dir, 'keys');
  const out: Fingerprints = {};
  for (const file of readdirSync(keys).filter((f) => f.endsWith('.verifier')).sort()) {
    out[file.replace(/\.verifier$/, '')] = sha256(readFileSync(join(keys, file)));
  }
  if (Object.keys(out).length === 0) throw new Error(`no verifier keys in ${keys}`);
  return out;
};

export const compilerInfo = (dir = zkConfigPath()): CompilerInfo => {
  const info = JSON.parse(readFileSync(join(dir, 'compiler', 'contract-info.json'), 'utf8'));
  return { compiler: info['compiler-version'], language: info['language-version'], runtime: info['runtime-version'] };
};

/** The slice of a ledger `ContractState` needed to read its verifier keys. */
export type OperationsSource = {
  operations(): Array<string | Uint8Array>;
  operation(name: string | Uint8Array): { verifierKey: Uint8Array } | undefined;
};

/** Fingerprints of the verifier keys stored on chain for a contract. */
export const onChainFingerprints = (state: OperationsSource): Fingerprints => {
  const out: Fingerprints = {};
  for (const op of state.operations()) {
    const name = typeof op === 'string' ? op : Buffer.from(op).toString('utf8');
    const operation = state.operation(op);
    if (operation) out[name] = sha256(operation.verifierKey);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

/** Differences between two fingerprint sets, as readable lines (empty when equal). */
export const compareFingerprints = (expected: Fingerprints, actual: Fingerprints): string[] => {
  const problems: string[] = [];
  for (const [name, hash] of Object.entries(expected)) {
    if (!(name in actual)) problems.push(`${name}: missing`);
    else if (actual[name] !== hash) problems.push(`${name}: ${actual[name]} (expected ${hash})`);
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) problems.push(`${name}: unexpected circuit`);
  return problems;
};
