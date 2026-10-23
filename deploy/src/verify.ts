import { Nightcast } from '@nightcast/contract';
import { compareFingerprints, type Fingerprints, onChainFingerprints, type OperationsSource } from './fingerprints.js';
import { type AuthorityView, isLocked } from './lock.js';
import type { DeploymentRecord } from './record.js';

export type Check = { name: string; ok: boolean; detail: string };

/** The parts of an on-chain contract state that verification reads. */
export type ContractStateView = OperationsSource & {
  maintenanceAuthority: AuthorityView;
  data: Parameters<typeof Nightcast.ledger>[0];
};

/**
 * Check a live deployment against its published record. Needs only public
 * chain data. `local` (optional) is the fingerprint set of the code in this
 * checkout, to confirm it's the code that was deployed.
 */
export const verifyDeployment = (
  record: DeploymentRecord,
  state: ContractStateView | null | undefined,
  local?: Fingerprints,
): Check[] => {
  if (!state) {
    return [{ name: 'contract exists', ok: false, detail: `nothing at ${record.contractAddress}` }];
  }
  const checks: Check[] = [{ name: 'contract exists', ok: true, detail: record.contractAddress }];

  const cma = state.maintenanceAuthority;
  checks.push({
    name: 'maintenance authority locked',
    ok: isLocked(cma),
    detail: `committee of ${cma.committee.length}, threshold ${cma.threshold}, ${cma.counter} update(s) since deploy`,
  });

  const onChain = onChainFingerprints(state);
  const vs = compareFingerprints(record.verifierKeys, onChain);
  checks.push({
    name: 'verifier keys match the published fingerprints',
    ok: vs.length === 0,
    detail: vs.length === 0 ? `${Object.keys(onChain).length} circuits` : vs.join('; '),
  });

  if (local) {
    const vl = compareFingerprints(record.verifierKeys, local);
    checks.push({
      name: 'this checkout compiles to the deployed code',
      ok: vl.length === 0,
      detail: vl.length === 0 ? 'identical' : vl.join('; '),
    });
  }

  const ledger = Nightcast.ledger(state.data);
  const pk = record.parameters.oraclePublicKey;
  const keyMatches = ledger.oracleKey.x.toString() === pk.x && ledger.oracleKey.y.toString() === pk.y;
  checks.push({
    name: 'oracle key accepted',
    ok: ledger.oracleKeyReady && keyMatches,
    detail: ledger.oracleKeyReady
      ? keyMatches
        ? 'active and matches the record'
        : 'active but differs from the record (rotated?)'
      : 'not accepted yet: the oracle must call acceptOracleKey',
  });

  if (ledger.oracleKeyReady && ledger.proposedOracleKey.is_some) {
    const at = new Date(Number(ledger.oracleKeyChangeAt) * 1000).toISOString();
    checks.push({
      name: 'no oracle key change pending',
      ok: false,
      detail: `a new key is proposed; it can take effect ${ledger.oracleKeyApproved ? 'now (approved by the current oracle)' : `from ${at}`}; requests keep the key they were made with`,
    });
  } else {
    checks.push({ name: 'no oracle key change pending', ok: true, detail: `a change would wait ${ledger.oracleKeyDelay}s` });
  }

  const windowsMatch =
    ledger.minWindow.toString() === record.parameters.minWindow &&
    ledger.maxWindow.toString() === record.parameters.maxWindow;
  checks.push({
    name: 'request windows match',
    ok: windowsMatch,
    detail: `${ledger.minWindow}s to ${ledger.maxWindow}s`,
  });

  return checks;
};

export const formatChecks = (checks: Check[]): string =>
  checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n');
