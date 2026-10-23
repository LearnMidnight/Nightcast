/**
 * Check one request's result from public data alone.
 *
 * What a third party can confirm without any secret:
 *  - the deployment is the published one, locked, with the published
 *    verifier keys (so the network checked the oracle's proof with the
 *    `fulfil` circuit everyone can read);
 *  - the request is bound to the published oracle key;
 *  - its curve point is the one fixed by its id (so the oracle couldn't pick
 *    the input it evaluated);
 *  - it was answered, with a non-zero output;
 *  - given the requester's tag and seed, that the id is the one they asked
 *    for (so nobody swapped the input).
 *
 * The output itself needs the oracle's secret to recompute; the network did
 * that check, by verifying the fulfil proof that output = H(H·sk) for the
 * bound key.
 */
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits, type Request, Status } from '@nightcast/contract';
import type { Fingerprints } from './fingerprints.js';
import type { DeploymentRecord } from './record.js';
import { type Check, type ContractStateView, verifyDeployment } from './verify.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const STATUS = ['pending', 'fulfilled', 'expired'];

export type RequestInputs = {
  /** The 32-byte tag the requester used (as passed to `request`). */
  tag: Uint8Array;
  /** The 32-byte seed the requester used. */
  seed: Uint8Array;
};

/**
 * Checks for request `id` against the published record. `expect` says which
 * outcome to require: `fulfilled` (default) or `expired`.
 */
export const checkRequest = (
  record: DeploymentRecord,
  state: ContractStateView | null | undefined,
  id: Uint8Array,
  request: Request | undefined,
  opts: { inputs?: RequestInputs; local?: Fingerprints; expect?: 'fulfilled' | 'expired'; deployment?: boolean } = {},
): Check[] => {
  // The deployment checks (as `verify`), unless the caller has just shown them.
  const checks = opts.deployment === false ? [] : verifyDeployment(record, state, opts.local);
  if (!state) {
    return checks.length > 0 ? checks : [{ name: 'contract exists', ok: false, detail: `nothing at ${record.contractAddress}` }];
  }
  if (!request) {
    checks.push({ name: 'request exists', ok: false, detail: `no request ${hex(id)} in this contract` });
    return checks;
  }
  checks.push({ name: 'request exists', ok: true, detail: hex(id) });

  const point = pureCircuits.inputPoint(id);
  checks.push({
    name: 'input fixed by the request id',
    ok: request.point.x === point.x && request.point.y === point.y,
    detail:
      request.point.x === point.x && request.point.y === point.y
        ? 'the stored point is hashToCurve(id), so the oracle could not choose it'
        : 'the stored point is not hashToCurve(id)',
  });

  const pk = record.parameters.oraclePublicKey;
  const bound = request.oracleKey.x.toString() === pk.x && request.oracleKey.y.toString() === pk.y;
  checks.push({
    name: 'bound to the published oracle key',
    ok: bound,
    detail: bound ? 'yes' : 'a different key (was the oracle key rotated?)',
  });

  if (opts.inputs) {
    const expected = pureCircuits.requestId(
      { bytes: encodeContractAddress(record.contractAddress) },
      request.requester,
      opts.inputs.tag,
      opts.inputs.seed,
    );
    checks.push({
      name: 'id matches the tag and seed',
      ok: hex(expected) === hex(id),
      detail: hex(expected) === hex(id) ? 'the request is the one that was asked for' : `they give ${hex(expected)}`,
    });
  }

  const want = opts.expect ?? 'fulfilled';
  const status = STATUS[request.status] ?? String(request.status);
  if (want === 'fulfilled') {
    const ok = request.status === Status.fulfilled && request.output.some((b) => b !== 0);
    checks.push({
      name: 'answered',
      ok,
      detail: ok
        ? `output ${hex(request.output)} (its proof was verified by the network)`
        : status === 'expired'
          ? 'expired: the oracle did not answer in time, so the round must be voided, never redrawn'
          : `status ${status}`,
    });
  } else {
    checks.push({
      name: 'expired',
      ok: request.status === Status.expired,
      detail: `status ${status}`,
    });
  }
  return checks;
};
