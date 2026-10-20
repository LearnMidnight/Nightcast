import {
  type ChargedState,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, type Ledger, ledger } from './managed/nightcast/contract/index.js';
import { type NightcastPrivateState, witnesses } from './witnesses.js';
import { oraclePublicKey } from './keys.js';

const COIN_PUBLIC_KEY = '0'.repeat(64);

export type SimulatorOptions = {
  oracleSecretKey: bigint;
  operatorSecret: Uint8Array;
  operatorCommitment: Uint8Array;
  minWindow?: bigint;
  maxWindow?: bigint;
  /** Starting block time, seconds since the epoch. */
  now?: number;
};

/**
 * Runs the compiled Nightcast contract in memory. Several actors (requester,
 * oracle, operator, anyone) share one ledger; each call picks whose private
 * state the witnesses see.
 */
export class NightcastSimulator {
  readonly contract = new Contract<NightcastPrivateState>(witnesses);
  readonly address = sampleContractAddress();
  readonly addressBytes: Uint8Array;
  now: number;
  private state: ContractState | ChargedState;

  constructor(readonly opts: SimulatorOptions) {
    this.now = opts.now ?? 1_800_000_000;
    this.addressBytes = encodeContractAddress(this.address);
    const result = this.contract.initialState(
      createConstructorContext<NightcastPrivateState>({}, COIN_PUBLIC_KEY),
      oraclePublicKey(opts.oracleSecretKey),
      opts.operatorCommitment,
      opts.minWindow ?? 60n,
      opts.maxWindow ?? 3_600n,
    );
    this.state = result.currentContractState;
  }

  get oracle(): NightcastPrivateState {
    return { oracleSecretKey: this.opts.oracleSecretKey };
  }

  get operator(): NightcastPrivateState {
    return { operatorSecret: this.opts.operatorSecret };
  }

  readonly anyone: NightcastPrivateState = {};

  advance(seconds: number): void {
    this.now += seconds;
  }

  getLedger(): Ledger {
    const s = this.state as ContractState;
    return ledger('data' in s ? s.data : (this.state as ChargedState));
  }

  private run<R>(
    privateState: NightcastPrivateState,
    call: (ctx: ReturnType<typeof createCircuitContext<NightcastPrivateState>>) => {
      result: R;
      context: { currentQueryContext: { state: ChargedState } };
    },
  ): R {
    const ctx = createCircuitContext<NightcastPrivateState>(
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      privateState,
      undefined,
      undefined,
      this.now,
    );
    const out = call(ctx);
    this.state = out.context.currentQueryContext.state;
    return out.result;
  }

  request(tag: Uint8Array, seed: Uint8Array, deadline: bigint, as: NightcastPrivateState = this.anyone): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.request(ctx, tag, seed, deadline));
  }

  fulfil(id: Uint8Array, as: NightcastPrivateState = this.oracle): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.fulfil(ctx, id));
  }

  expire(id: Uint8Array, as: NightcastPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.expire(ctx, id));
  }

  setOracleKey(key: { x: bigint; y: bigint }, as: NightcastPrivateState = this.operator): void {
    this.run(as, (ctx) => this.contract.impureCircuits.setOracleKey(ctx, key));
  }

  setOperator(commitment: Uint8Array, as: NightcastPrivateState = this.operator): void {
    this.run(as, (ctx) => this.contract.impureCircuits.setOperator(ctx, commitment));
  }
}
