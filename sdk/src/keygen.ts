#!/usr/bin/env node
/**
 * Generate a Nightcast oracle key and operator secret.
 *
 *   npx nightcast-keygen --out oracle.secret
 *
 * Writes the secrets to the file (mode 600) and prints only the public values
 * needed to deploy: the oracle public key and the operator commitment.
 */
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  formatOracleSecretKey,
  generateOperatorSecret,
  generateOracleSecretKey,
  oraclePublicKey,
  pureCircuits,
  toHex,
} from '@nightcast/contract';

export type GeneratedKeys = {
  oracleSecretKey: string;
  operatorSecret: string;
  oraclePublicKey: { x: string; y: string };
  operatorCommitment: string;
};

export const generateKeys = (): GeneratedKeys => {
  const sk = generateOracleSecretKey();
  const op = generateOperatorSecret();
  const pk = oraclePublicKey(sk);
  return {
    oracleSecretKey: formatOracleSecretKey(sk),
    operatorSecret: toHex(op),
    oraclePublicKey: { x: pk.x.toString(), y: pk.y.toString() },
    operatorCommitment: toHex(pureCircuits.operatorCommitmentOf(op)),
  };
};

const main = (argv: string[]): void => {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !out) throw new Error('--out needs a file name');

  const keys = generateKeys();
  const publicPart = { oraclePublicKey: keys.oraclePublicKey, operatorCommitment: keys.operatorCommitment };

  if (out) {
    if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite a key file`);
    writeFileSync(out, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`Secrets written to ${out} (keep it private).\n`);
    process.stdout.write(JSON.stringify(publicPart, null, 2) + '\n');
  } else {
    process.stderr.write('No --out given: printing secrets to stdout. Store them somewhere safe.\n');
    process.stdout.write(JSON.stringify(keys, null, 2) + '\n');
  }
};

const invokedDirectly = (): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
