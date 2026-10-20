#!/usr/bin/env node
/**
 * Generate Nightcast secrets. The oracle and the operator are separate roles
 * and should be kept on separate machines, so each gets its own file:
 *
 *   ./nightcast keygen oracle   --out oracle.secret
 *   ./nightcast keygen operator --out operator.secret
 *   ./nightcast keygen requester --out requester.secret
 *
 * Each file is created with mode 600 and never overwritten. Only the public
 * value (oracle public key, operator or requester commitment) is printed.
 */
import { writeFileSync, realpathSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  formatOracleSecretKey,
  generateOperatorSecret,
  generateOracleSecretKey,
  oraclePublicKey,
  pureCircuits,
  toHex,
} from '@nightcast/contract';

export type Role = 'oracle' | 'operator' | 'requester';

export type GeneratedSecret = {
  role: Role;
  /** Hex. The oracle's is a Jubjub scalar; the others are 32 random bytes. */
  secret: string;
  /** What goes on chain or in config: the oracle public key, or a commitment. */
  public: { x: string; y: string } | string;
};

export const generateSecret = (role: Role): GeneratedSecret => {
  switch (role) {
    case 'oracle': {
      const sk = generateOracleSecretKey();
      const pk = oraclePublicKey(sk);
      return { role, secret: formatOracleSecretKey(sk), public: { x: pk.x.toString(), y: pk.y.toString() } };
    }
    case 'operator': {
      const s = generateOperatorSecret();
      return { role, secret: toHex(s), public: toHex(pureCircuits.operatorCommitmentOf(s)) };
    }
    case 'requester': {
      const s = webcrypto.getRandomValues(new Uint8Array(32));
      return { role, secret: toHex(s), public: toHex(pureCircuits.requesterCommitmentOf(s)) };
    }
  }
};

const USAGE = 'usage: ./nightcast keygen <oracle|operator|requester> --out <file>';

const main = (argv: string[]): void => {
  const role = argv[0] as Role;
  if (!['oracle', 'operator', 'requester'].includes(role)) throw new Error(USAGE);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (!out) throw new Error(USAGE);

  const generated = generateSecret(role);
  // 'wx' fails if the path exists (including a symlink), so a key file is never overwritten.
  try {
    writeFileSync(out, JSON.stringify(generated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${out} already exists; refusing to overwrite`);
    throw err;
  }
  process.stdout.write(`${role} secret written to ${out} (keep it private).\n`);
  process.stdout.write(JSON.stringify({ role, public: generated.public }, null, 2) + '\n');
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
