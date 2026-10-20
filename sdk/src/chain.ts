import type { ChargedState, JubjubPoint } from '@midnight-ntwrk/compact-runtime';
import { ledger, type NightcastSimulator, type Request } from '@nightcast/contract';

/** A request as the oracle sees it. */
export type RequestEntry = { id: Uint8Array; request: Request };

/**
 * What the oracle needs from a Nightcast deployment. Implemented for the
 * in-memory simulator (tests, local experiments) and for a live Midnight
 * deployment via midnight-js ({@link MidnightChain}).
 */
export interface NightcastChain {
  /** Every request currently in the contract's ledger. */
  listRequests(): Promise<RequestEntry[]>;
  /** Submit `fulfil(id)`. Resolves once the transaction is final. */
  fulfil(id: Uint8Array): Promise<void>;
  /** Current chain time in seconds (defaults to the local clock). */
  now?(): Promise<number>;
}

const entriesOf = (requests: Iterable<[Uint8Array, Request]>): RequestEntry[] =>
  Array.from(requests, ([id, request]) => ({ id, request }));

/** Chain backed by a {@link NightcastSimulator}; the oracle's own key is supplied per call. */
export class SimulatorChain implements NightcastChain {
  constructor(
    readonly sim: NightcastSimulator,
    private readonly oracleSecretKey: bigint,
  ) {}

  async listRequests(): Promise<RequestEntry[]> {
    return entriesOf(this.sim.getLedger().requests);
  }

  async fulfil(id: Uint8Array): Promise<void> {
    this.sim.fulfil(id, { oracleSecretKey: this.oracleSecretKey });
  }

  async now(): Promise<number> {
    return this.sim.now;
  }
}

// ---------------------------------------------------------------- midnight-js

/**
 * The slice of midnight-js this adapter uses. A `FoundContract` /
 * `DeployedContract` for the Nightcast contract and a `PublicDataProvider`
 * from `@midnight-ntwrk/midnight-js` satisfy these shapes, so the adapter
 * doesn't pin a midnight-js version.
 */
export interface NightcastCallTx {
  callTx: { fulfil(id: Uint8Array): Promise<unknown> };
}

export interface ContractStateSource {
  queryContractState(address: string): Promise<{ data: ChargedState } | null | undefined>;
}

/**
 * Chain for a live deployment. `contract` must have been joined with
 * `findDeployedContract` using a private state that holds the oracle secret key
 * (see `NightcastPrivateState`), so the `oracleSecretKey` witness can answer.
 */
export class MidnightChain implements NightcastChain {
  constructor(
    private readonly contract: NightcastCallTx,
    private readonly publicData: ContractStateSource,
    private readonly contractAddress: string,
    /**
     * Chain time in seconds, e.g. the latest block's timestamp from the indexer.
     * Without it the oracle uses the local clock, so keep that in sync (NTP).
     */
    clock?: () => Promise<number>,
  ) {
    if (clock) this.now = clock;
  }

  now?: () => Promise<number>;

  async listRequests(): Promise<RequestEntry[]> {
    const state = await this.publicData.queryContractState(this.contractAddress);
    if (!state) throw new Error(`no Nightcast contract at ${this.contractAddress}`);
    return entriesOf(ledger(state.data).requests);
  }

  async fulfil(id: Uint8Array): Promise<void> {
    await this.contract.callTx.fulfil(id);
  }
}

export const sameKey = (a: JubjubPoint, b: JubjubPoint): boolean => a.x === b.x && a.y === b.y;
