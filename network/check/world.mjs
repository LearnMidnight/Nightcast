// The Nightcast network contract running in memory (compact-runtime 0.21, as compiled by Compact
// 0.36), with a controllable clock and a small ledger for unshielded NIGHT: what users paid in,
// what the contract holds and what it paid out, call by call.
import { webcrypto } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as N from './out/contract/index.js';
import { createRequire } from 'node:module';
// Ledger 9's own transcript partitioning (as Midnight.js uses it), for the same-block replay.
const L = createRequire(import.meta.url)('@midnightntwrk/ledger-v9');

const COIN = '0'.repeat(64);
const NATIVE = '0'.repeat(64);
const BLOCK = '11'.repeat(32);
export const hex = (b) => Buffer.from(b).toString('hex');
export const bytes = (s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
export const addr = (n) => new Uint8Array(32).fill(n);

const JUBJUB_ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
export const newKey = () => {
  for (;;) {
    let n = 0n;
    for (const b of webcrypto.getRandomValues(new Uint8Array(64))) n = (n << 8n) | BigInt(b);
    const sk = n % JUBJUB_ORDER;
    if (sk !== 0n) return sk;
  }
};
export const operatorIdOf = (sk) => N.pureCircuits.keyIdOf(N.pureCircuits.publicKey(sk));

const witnesses = {
  oracleSecretKey: ({ privateState }) => {
    if (privateState.oracleSecretKey === undefined) throw new Error('no operator secret key in private state');
    return [privateState, privateState.oracleSecretKey];
  },
  requesterSecret: ({ privateState }) => {
    if (privateState.requesterSecret === undefined) throw new Error('no requester secret in private state');
    return [privateState, privateState.requesterSecret];
  },
};

const sum = (m) => { let t = 0n; for (const [k, v] of m ?? []) if (k.tag === 'unshielded' && k.raw === NATIVE) t += BigInt(v); return t; };

export class World {
  static async create({ minWindow = 60n, maxWindow = 3600n, fee = 0n, collateral = 0n, minBond = 0n } = {}) {
    const w = new World();
    w.now = 1_800_000_000;
    w.contract = new N.Contract(witnesses);
    w.address = rt.sampleContractAddress();
    w.o = { minWindow, maxWindow, fee, collateral, minBond };
    const s0 = await w.contract.initialState(rt.createConstructorContext({}, COIN), minWindow, maxWindow, fee, collateral, minBond);
    w.state = s0.currentContractState;
    w.balance = 0n;
    w.paidIn = 0n;
    w.paidOut = new Map();
    return w;
  }

  ledger() { return N.ledger(this.state.data); }
  advance(s) { this.now += s; }
  paid(to) { return this.paidOut.get(hex(to)) ?? 0n; }
  freeSlots(id) { const b = this.ledger().bonds; return b.member(id) ? b.lookup(id).read() : 0n; }

  /**
   * Run one circuit as one transaction, built against `on` (default: the current state), and
   * return { result, state }: the state after it, and the transcript replayed is checked by the
   * same runtime. `commit: false` leaves the world's state alone (to build two calls against one
   * state, as two parties acting in the same block do).
   */
  async run(circuit, args, privateState = {}, { funding = 0n, commit = true, on } = {}) {
    const base = on ?? this.state;
    base.balance = new Map([[{ tag: 'unshielded', raw: NATIVE }, this.balance]]);
    const ctx = rt.createCircuitContext({ circuitId: circuit, contractAddress: this.address, coinPublicKeyOrZswapState: COIN, contractState: base, privateState, time: this.now, parentBlockHash: BLOCK });
    const out = await this.contract.impureCircuits[circuit](ctx, ...args);
    const fx = out.context.callProofDataTrace[0].finalQueryContext.effects;
    const received = sum(fx.unshieldedInputs);
    const sent = sum(fx.unshieldedOutputs);
    if (received !== funding) throw new Error(`${circuit}: the contract takes ${received} from the sender, expected ${funding}`);
    const toUsers = [];
    let claimed = 0n;
    for (const [[token, to], amount] of fx.claimedUnshieldedSpends ?? []) {
      if (token.tag !== 'unshielded' || token.raw !== NATIVE) throw new Error('unexpected token');
      if (to.tag === 'contract') throw new Error('unexpected payment to a contract');
      claimed += BigInt(amount);
      toUsers.push([typeof to.address === 'string' ? to.address.toLowerCase() : hex(to.address), BigInt(amount)]);
    }
    if (claimed !== sent) throw new Error(`${circuit}: sends ${sent} but names recipients for ${claimed}`);
    const after = out.context.queryContexts[this.address].state;
    if (commit) {
      if (this.balance + received - sent < 0n) throw new Error(`${circuit}: the contract would go below zero`);
      this.balance += received - sent;
      this.paidIn += funding;
      for (const [to, amount] of toUsers) this.paidOut.set(to, (this.paidOut.get(to) ?? 0n) + amount);
      this.state.data = after;
    }
    return { result: out.result, after, publicTranscript: out.context.callProofDataTrace[0].publicTranscript, effects: fx };
  }

  /** NIGHT in the contract equals every free bond plus what pending requests hold for operators that haven't answered. */
  accounts() {
    const l = this.ledger();
    let held = 0n;
    for (const [k] of l.operators) held += l.bonds.lookup(k).read() * this.o.collateral;
    for (const [id, r] of l.requests) {
      if (r.status !== N.Status.pending) continue;
      for (const k of r.operators) if (!l.shares.member(N.pureCircuits.shareKeyOf(id, k))) held += r.fee + r.collateral;
    }
    return { held, balance: this.balance, conserved: this.paidIn === this.balance + [...this.paidOut.values()].reduce((a, b) => a + b, 0n) };
  }

  // ---- the circuits
  register(sk, payout, slots) { return this.run('register', [{ bytes: payout }, slots], { oracleSecretKey: sk }, { funding: slots * this.o.collateral }).then((r) => r.result); }
  depositBond(id, slots) { return this.run('depositBond', [id, slots], {}, { funding: slots * this.o.collateral }).then((r) => r.result); }
  withdrawBond(sk, slots, leave = false) { return this.run('withdrawBond', [slots, leave], { oracleSecretKey: sk }).then((r) => r.result); }
  request(tag, seed, deadline, group, { secret = addr(7), refundTo = addr(0x0b), ...o } = {}) {
    return this.run('request', [tag, seed, deadline, { bytes: refundTo }, group], { requesterSecret: secret }, { funding: 3n * this.o.fee, ...o });
  }
  answer(id, sk, o = {}) { return this.run('answer', [id], { oracleSecretKey: sk }, o); }
  finalise(id) { return this.run('finalise', [id]).then((r) => r.result); }
  expire(id) { return this.run('expire', [id]).then((r) => r.result); }

  /** The id `request(tag, seed)` produces for a requester secret. */
  idFor(tag, seed, secret = addr(7)) {
    return N.pureCircuits.requestId({ bytes: rt.encodeContractAddress(this.address) }, N.pureCircuits.requesterCommitmentOf(secret), tag, seed);
  }

  /**
   * Two calls built against the same state (the same block): `first` lands, then `second`'s public
   * transcript (built before `first`) is replayed on top, as the chain applies a transaction proven
   * earlier. Throws if the second no longer applies.
   */
  async sameBlock(first, second) {
    const before = this.state;
    const qcOf = (state) => {
      const qc = new L.QueryContext(new L.ChargedState(L.StateValue.decode(state.data.state.encode())), this.address);
      qc.block = { ...qc.block, secondsSinceEpoch: BigInt(this.now) };
      return qc;
    };
    const b = await second({ commit: false, on: before });
    // The second call's transcripts, with the gas Midnight.js would give them, built against the state it saw.
    const [parts] = L.partitionTranscripts([new L.PreTranscript(qcOf(before), b.publicTranscript)], L.LedgerParameters.initialParameters());
    await first();
    let qc = qcOf(this.state);
    for (const t of parts) if (t) qc = qc.runTranscript(t, L.CostModel.initialCostModel());
  }

}

export { N };
