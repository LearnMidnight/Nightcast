/**
 * The oracle looking after itself: its bond, the requester wallet it serves,
 * and a status file for monitoring.
 *
 * Decided with Jack on 11 Nov 2026 (LunaSpin on Preprod). All off unless set:
 *
 * - NIGHTCAST_BOND_TARGET=<slots>: keep the bond at this many slots. A request
 *   the oracle misses takes one slot for good (its collateral goes to the
 *   requester); when the bond (free slots plus the ones pending requests hold)
 *   is below the target, the oracle deposits the difference from its wallet.
 *   Anyone may deposit, so this needs no key but the wallet's.
 * - NIGHTCAST_TOPUP_ADDRESS=<mn_addr...> with NIGHTCAST_TOPUP_HEALTH=<url>:
 *   when the wallet behind that MCP server's /health (LunaSpin's) holds less
 *   than NIGHTCAST_TOPUP_BELOW NIGHT (default 1000), send it
 *   NIGHTCAST_TOPUP_AMOUNT (default 2000). The address must be the one
 *   /health reports, so a wrong URL can't redirect the money.
 * - NIGHTCAST_WALLET_FLOOR=<NIGHT> (default 2000): the oracle's wallet never
 *   goes below this for either (its NIGHT is what makes its DUST).
 * - NIGHTCAST_STATUS_FILE=<path>: a JSON file rewritten each pass, for the
 *   monitor: balances, the bond, misses and what upkeep did.
 */
import { renameSync, writeFileSync } from 'node:fs';

const NIGHT = 1_000_000n;

export type UpkeepConfig = {
  bondTarget?: bigint;
  walletFloor: bigint;
  topUp?: { address: string; healthUrl: string; below: bigint; amount: bigint };
  statusFile?: string;
};

const nightOf = (v: string | undefined, fallback: bigint): bigint => {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec((v ?? '').trim());
  return m ? BigInt(m[1]!) * NIGHT + BigInt((m[2] ?? '').padEnd(6, '0')) : fallback;
};

/** The upkeep settings from the environment (see the top of this file). */
export const upkeepConfig = (env: NodeJS.ProcessEnv = process.env): UpkeepConfig => {
  const target = /^\d{1,5}$/.test(env.NIGHTCAST_BOND_TARGET ?? '') ? BigInt(env.NIGHTCAST_BOND_TARGET as string) : undefined;
  const address = env.NIGHTCAST_TOPUP_ADDRESS?.trim();
  const healthUrl = env.NIGHTCAST_TOPUP_HEALTH?.trim();
  return {
    bondTarget: target !== undefined && target > 0n && target <= 65_535n ? target : undefined,
    walletFloor: nightOf(env.NIGHTCAST_WALLET_FLOOR, 2_000n * NIGHT),
    topUp:
      address && healthUrl
        ? { address, healthUrl, below: nightOf(env.NIGHTCAST_TOPUP_BELOW, 1_000n * NIGHT), amount: nightOf(env.NIGHTCAST_TOPUP_AMOUNT, 2_000n * NIGHT) }
        : undefined,
    statusFile: env.NIGHTCAST_STATUS_FILE?.trim() || undefined,
  };
};

/** Whether anything is switched on. */
export const upkeepWanted = (c: UpkeepConfig): boolean => c.bondTarget !== undefined || c.topUp !== undefined || c.statusFile !== undefined;

/** Slots to deposit so the bond (free + held by pending requests) is back at the target; 0 if it is, or if the wallet can't spare them. */
export const bondShortfall = (o: { free: bigint; held: bigint; target?: bigint; collateral: bigint; night: bigint; floor: bigint }): bigint => {
  if (o.target === undefined || o.collateral <= 0n) return 0n;
  const missing = o.target - (o.free + o.held);
  if (missing <= 0n) return 0n;
  const spare = o.night - o.floor;
  const affordable = spare > 0n ? spare / o.collateral : 0n;
  return missing < affordable ? missing : affordable;
};

/** What /health of the served MCP server says about its wallet. */
export type ServedWallet = { address?: string; night?: string };

/** NIGHT atoms to send the served wallet now; 0 if it has enough, isn't the address we were told, or we can't spare it. */
export const topUpDue = (o: { served: ServedWallet | undefined; config: UpkeepConfig['topUp']; night: bigint; floor: bigint }): bigint => {
  const c = o.config;
  if (!c || !o.served || o.served.address !== c.address || !/^\d+$/.test(o.served.night ?? '')) return 0n;
  if (BigInt(o.served.night as string) >= c.below) return 0n;
  return o.night - c.amount >= o.floor ? c.amount : 0n;
};

export type UpkeepStatus = {
  at: string;
  wallet: { night: string; dust: string };
  bond: { free: string; held: string; target?: string };
  served?: ServedWallet;
  fulfilled: number;
  missed: number;
  lastFulfilledAt?: string;
  lastMissedAt?: string;
  lastDeposit?: { at: string; slots: string; ok: boolean; note?: string };
  lastTopUp?: { at: string; night: string; ok: boolean; note?: string };
};

/** Write the status file in one step (a reader never sees half of it). */
export const writeStatus = (file: string, status: UpkeepStatus): void => {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o644 });
  renameSync(tmp, file);
};

/** Counts answers and misses from the oracle's own log lines. */
export class OracleTally {
  fulfilled = 0;
  missed = 0;
  lastFulfilledAt?: string;
  lastMissedAt?: string;
  constructor(private readonly clock: () => number = Date.now) {}
  see(line: string): void {
    const at = new Date(this.clock()).toISOString();
    if (/^fulfilled [0-9a-f]{64}/.test(line)) {
      this.fulfilled += 1;
      this.lastFulfilledAt = at;
    } else if (/leaving it to expire/.test(line)) {
      this.missed += 1;
      this.lastMissedAt = at;
    }
  }
}

/** A minimum gap between tries of the same upkeep action. */
export class Pace {
  private last = new Map<string, number>();
  constructor(private readonly clock: () => number = Date.now) {}
  due(action: string, everyMs: number): boolean {
    const now = this.clock();
    if (now - (this.last.get(action) ?? -Infinity) < everyMs) return false;
    this.last.set(action, now);
    return true;
  }
}
