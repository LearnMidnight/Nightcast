/**
 * Runs the oracle's upkeep (upkeep.ts) once a minute, between its passes:
 * the bond refill, the top-up of the wallet it serves, and the status file.
 */
import { ledgerOf, oraclePublicKey, Status } from '@nightcast/contract';
import type { NightcastOracle } from '@nightcast/sdk';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { type NightcastProviders, readContractState, sendNight, type Session, walletBalances } from './network.js';
import { withTwoDustSpends } from './service.js';
import { depositBond } from './steps.js';
import { bondShortfall, type OracleTally, Pace, type ServedWallet, topUpDue, type UpkeepConfig, type UpkeepStatus, writeStatus } from './upkeep.js';
import { failureText } from './wallet.js';

type LogFn = (obj: unknown, ...rest: unknown[]) => void;

/** A logger like `logger` whose text lines (info, warn, error) are also passed to `hear`. */
export const talking = <L extends { info: LogFn; warn: LogFn; error: LogFn }>(logger: L, hear: (line: string) => void): L =>
  new Proxy(logger, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if ((prop === 'info' || prop === 'warn' || prop === 'error') && typeof v === 'function') {
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string') hear(args[0]);
          return (v as LogFn).apply(target, args as [unknown, ...unknown[]]);
        };
      }
      return typeof v === 'function' ? (v as LogFn).bind(target) : v;
    },
  });

const NIGHT = 1_000_000n;
const night = (atoms: bigint): string => {
  const frac = (atoms % NIGHT).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${atoms / NIGHT}.${frac}` : (atoms / NIGHT).toString();
};

/** What the served MCP server's /health says about its wallet (undefined if it can't be read). */
const readServed = async (url: string): Promise<ServedWallet | undefined> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { address?: unknown; night?: unknown };
    return { address: typeof j.address === 'string' ? j.address : undefined, night: typeof j.night === 'string' ? j.night : undefined };
  } catch {
    return undefined;
  }
};

export const startUpkeep = (o: {
  config: UpkeepConfig;
  session: Session;
  wallet: MidnightWalletProvider;
  providers: NightcastProviders;
  contractAddress: string;
  secretKey: bigint;
  oracle: NightcastOracle;
  tally: OracleTally;
  everyMs?: number;
}): (() => void) => {
  const { config, session, wallet, providers, contractAddress } = o;
  const log = session.logger;
  const pace = new Pace();
  const key = oraclePublicKey(o.secretKey);
  let lastDeposit: UpkeepStatus['lastDeposit'];
  let lastTopUp: UpkeepStatus['lastTopUp'];
  let running = false;
  const parts = [
    config.bondTarget !== undefined ? `the bond kept at ${config.bondTarget} slots` : '',
    config.topUp ? `${config.topUp.address.slice(0, 22)}… topped up with ${night(config.topUp.amount)} NIGHT when below ${night(config.topUp.below)}` : '',
    config.statusFile ? `status in ${config.statusFile}` : '',
  ].filter(Boolean);
  log.info(`Upkeep: ${parts.join('; ')} (this wallet keeps at least ${night(config.walletFloor)} NIGHT).`);

  const pass = async (): Promise<void> => {
    const state = await readContractState(providers.publicDataProvider, contractAddress);
    if (!state) return;
    const ledger = ledgerOf(state);
    let held = 0n;
    for (const [, r] of ledger.requests) {
      if (r.status === Status.pending && r.collateral > 0n && r.term === ledger.oracleTerm && r.oracleKey.x === key.x && r.oracleKey.y === key.y) held += 1n;
    }
    let { night: ours, dust } = await walletBalances(wallet);
    const served = config.topUp ? await readServed(config.topUp.healthUrl) : undefined;

    const slots = bondShortfall({ free: ledger.bondSlots, held, target: config.bondTarget, collateral: ledger.collateralPerRequest, night: ours, floor: config.walletFloor });
    if (slots > 0n && pace.due('deposit', 10 * 60_000)) {
      const at = new Date().toISOString();
      try {
        await o.oracle.between(() => withTwoDustSpends(() => depositBond(providers, contractAddress, slots)));
        log.info(`Bond topped up with ${slots} slot(s): back to ${config.bondTarget}.`);
        lastDeposit = { at, slots: String(slots), ok: true };
        ours -= slots * ledger.collateralPerRequest;
      } catch (err) {
        const note = failureText(err, 300);
        log.warn(`The bond could not be topped up (${slots} slot(s); trying again in 10 minutes): ${note}`);
        lastDeposit = { at, slots: String(slots), ok: false, note };
      }
    }

    const send = topUpDue({ served, config: config.topUp, night: ours, floor: config.walletFloor });
    if (config.topUp && send > 0n && pace.due('topup', 30 * 60_000)) {
      const at = new Date().toISOString();
      try {
        const txId = await o.oracle.between(() => sendNight(wallet, config.topUp!.address, send, session.config.walletNetworkId));
        log.info(`Sent ${night(send)} NIGHT to ${config.topUp.address} (it held ${night(BigInt(served!.night!))}): transaction ${txId}.`);
        lastTopUp = { at, night: String(send), ok: true };
      } catch (err) {
        const note = failureText(err, 300);
        log.warn(`The top-up of ${config.topUp.address} failed (trying again in 30 minutes): ${note}`);
        lastTopUp = { at, night: String(send), ok: false, note };
      }
    } else if (config.topUp && served && served.address !== undefined && served.address !== config.topUp.address && pace.due('wrong-address', 6 * 3_600_000)) {
      log.warn(`No top-up: ${config.topUp.healthUrl} reports a wallet other than NIGHTCAST_TOPUP_ADDRESS.`);
    }

    if (config.statusFile) {
      try {
        const fresh = await walletBalances(wallet);
        dust = fresh.dust;
        writeStatus(config.statusFile, {
          at: new Date().toISOString(),
          wallet: { night: String(fresh.night), dust: String(dust) },
          bond: { free: String(ledger.bondSlots), held: String(held), ...(config.bondTarget !== undefined ? { target: String(config.bondTarget) } : {}) },
          ...(served ? { served } : {}),
          fulfilled: o.tally.fulfilled,
          missed: o.tally.missed,
          lastFulfilledAt: o.tally.lastFulfilledAt,
          lastMissedAt: o.tally.lastMissedAt,
          lastDeposit,
          lastTopUp,
        });
      } catch (err) {
        if (pace.due('status-error', 3_600_000)) log.warn(`Could not write ${config.statusFile}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pass()
      .catch((err: unknown) => {
        if (pace.due('pass-error', 10 * 60_000)) log.warn(`Upkeep pass failed: ${failureText(err, 300)}`);
      })
      .finally(() => {
        running = false;
      });
  }, o.everyMs ?? 60_000);
  return () => clearInterval(timer);
};

