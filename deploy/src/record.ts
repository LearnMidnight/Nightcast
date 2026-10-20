import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CompilerInfo, Fingerprints } from './fingerprints.js';

/**
 * What gets published for a deployment, in `deployments/<network>.json`.
 * Everything here is public; no secrets.
 */
export type DeploymentRecord = {
  network: string;
  contractAddress: string;
  deployedAt: string;
  sourceCommit?: string;
  compiler: CompilerInfo;
  parameters: {
    oraclePublicKey: { x: string; y: string };
    operatorCommitment: string;
    minWindow: string;
    maxWindow: string;
  };
  transactions: {
    deploy?: string;
    lockAuthority?: string;
    acceptOracleKey?: string;
  };
  /** The maintenance authority after locking: an empty committee can never sign. */
  maintenanceAuthority?: { committeeSize: number; threshold: number; counter: string };
  /** SHA-256 of each circuit's verifier key, as compiled and as stored on chain. */
  verifierKeys: Fingerprints;
};

/** Repo-root `deployments/` folder (override with NIGHTCAST_DEPLOYMENTS_DIR). */
export const deploymentsDir = (): string =>
  process.env.NIGHTCAST_DEPLOYMENTS_DIR ?? resolve(dirname(new URL(import.meta.url).pathname), '..', '..', 'deployments');

export const recordPath = (network: string): string => join(deploymentsDir(), `${network}.json`);

export const readRecord = (network: string): DeploymentRecord => {
  const path = recordPath(network);
  if (!existsSync(path)) throw new Error(`no deployment record at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
};

export const writeRecord = (record: DeploymentRecord): string => {
  const path = recordPath(record.network);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return path;
};

export const currentCommit = (): string | undefined => {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
};
