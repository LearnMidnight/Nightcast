# Nightcast v0 specification

Status: experimental, unaudited. Targets Compact toolchain 0.31.1 (language 0.23), compact-runtime 0.16.0 and ledger 8, the versions on Midnight Preview, Preprod and Mainnet as of October 2026.

## 1. Goal

Give Midnight contracts and applications random values that:

- nobody can predict before the request is answered, except the oracle;
- the oracle cannot choose: for each request there is exactly one output it can publish (it can only decline to publish);
- the chain checks before storing them, so consumers can rely on any fulfilled output given the contract's verifier keys (see §4.5).

Nightcast follows the shape of [Chainlink VRF](https://docs.chain.link/vrf) (request, then a later fulfilment that carries a proof), but uses Midnight's zero-knowledge transactions as the proof instead of a separate VRF proof checked by a coordinator contract.

## 2. Construction

Notation: `G` is the generator of the prime-order Jubjub subgroup Midnight uses as its embedded curve; `r` is that subgroup's order; `H2C` is Compact's `hashToCurve`; `SHA` is Compact's `persistentHash` (SHA-256 over the value's canonical encoding); `pad(s)` is `s` padded to 32 bytes.

**Keys.** The oracle picks `sk` uniformly in `[1, r)` and publishes `pk = G·sk`. A key only becomes active when the oracle proves possession of `sk` on chain (`acceptOracleKey`), which also rules out the identity point.

**Requester.** Each requester holds a secret `s` and is identified by `req = SHA(pad("nightcast:requester:v0"), s)`.

**Request id / VRF input.** For a deployment at address `A`, requester `req`, a label `tag` and a requester-chosen `seed`:

```
alpha = SHA({ pad("nightcast:alpha:v0"), A, req, tag, seed })
```

`alpha` doubles as the request id. Including `req` means nobody else can create, burn or spoof a requester's ids.

**Input point.** `request` computes `H = H2C([ pad("nightcast:h2c:v0"), alpha ])` and stores it with the request.

**Evaluation.**

```
gamma  = H · sk
output = SHA({ pad("nightcast:output:v0"), gamma })
```

**Proof.** `fulfil(alpha)` is a Compact circuit. With `sk` as a private witness it asserts `G·sk = pk_request`, computes `output` from the stored `H` as above, and stores it. The transaction's ZK proof shows the circuit ran correctly, so the chain only accepts the output fixed by `(pk_request, H)`. `sk` never leaves the oracle.

**Extra words.** `word_i = SHA({ pad("nightcast:word:v0"), output, i })` gives any number of independent 32-byte values from one output.

The pure circuits `requestId`, `requesterCommitmentOf`, `inputPoint`, `publicKey`, `evaluate`, `evaluateAt` and `randomWord` are exported so off-chain code uses the compiled contract's own encoding.

### Why the output is unique

- `pk` fixes `sk` modulo `r`, and `G` and `H` lie in the prime-order subgroup, so `gamma = H·sk` depends only on `sk mod r`. Any witness that passes the key check (for example `sk + r`) gives the same `gamma`. In-circuit, the scalar is decomposed canonically and the multiplication is effectively mod `r`; off-circuit, the JS runtime rejects a scalar `≥ r` outright (a test checks this).
- `H` is fixed when the request is made, not recomputed by the oracle. Compact documents that `hashToCurve` outputs "are not guaranteed to be unique" in-circuit; storing `H` at request time means that, whatever freedom exists, it belongs to the requester (who can't evaluate the VRF), not the oracle. The requester's proof still guarantees `H` is a valid `hashToCurve` output with unknown discrete logarithm.

### Why it is unpredictable

Computing `gamma` without `sk` means solving a discrete-log-type problem on Jubjub; the output is a hash of `gamma`. This is the standard EC-VRF argument (RFC 9381), with the ZK proof standing in for the DLEQ proof. Unlike RFC 9381, there is no standalone proof anyone can check off-chain: verification is the chain's check of the `fulfil` proof against the contract's verifier key.

## 3. Contract

Ledger:

| Field | Meaning |
|---|---|
| `requests: Map<Bytes<32>, Request>` | By id: `status` (pending, fulfilled, expired), `requester`, `tag`, `point` (H), `oracleKey`, `deadline`, `output`, and since v1 `fee`, `collateral`, `refundTo`, `payout`, `term` |
| `requestCount: Counter` | Total requests (increment only, so concurrent requests don't conflict) |
| `oracleKey`, `oracleKeyReady` | Key bound to new requests, once accepted |
| `proposedOracleKey: Maybe<JubjubPoint>`, `oracleKeyChangeAt`, `oracleKeyApproved` | Key waiting for the oracle's proof of possession; the earliest time it may be accepted; whether the current oracle agreed to it |
| `oracleKeyDelay` (sealed) | The wait before a replacement key can be accepted: `maxWindow` |
| `operator`, `proposedOperator` | `SHA(pad("nightcast:operator:v0"), secret)`, and a pending hand-over |
| `minWindow`, `maxWindow` (sealed) | Allowed deadline distance in seconds; `60 ≤ min < max ≤ 30 days` |
| `requestFee`, `collateralPerRequest` (sealed, v1) | What a request pays the oracle, and how much of the oracle's bond it sets aside (one slot), in NIGHT atoms (either may be 0) |
| `bondSlots: Counter` (v1) | The current oracle's free bond, in slots of `collateralPerRequest` |
| `oraclePayout` (v1) | Where the current oracle is paid: fees, and its bond when withdrawn or handed over |
| `oracleTerm` (v1) | Counts key acceptances; a request answered in the term it was made in gives its slot back |

Circuits:

| Circuit | Who | Checks / effect |
|---|---|---|
| constructor `(pk, operatorCommitment, min, max, fee, collateral)` | deployer | Window bounds. `pk` is only proposed. |
| `acceptOracleKey(payout)` | oracle | A key is proposed; it isn't the identity; `G·sk` equals it; if a key is already active, `now ≥ oracleKeyChangeAt` or the current oracle approved. Activates it with its payout address and starts a new term. A replacement doesn't inherit the bond: its free slots go back to the old payout. |
| `approveOracleKey(key)` | current oracle | `key` is the one proposed (so a proposal made after the oracle decided isn't approved); `G·sk` equals the active key. Lifts the wait for this proposal. |
| `request(tag, seed, deadline, refundTo)` | requester | A key is active; `now + min < deadline ≤ now + max`; id is new; a free slot, if the deployment takes collateral. Pays `fee` in; takes one slot from the bond into the request. Stores a pending request with `H`, the current key, payout and term. |
| `fulfil(id)` | oracle | Pending; `now < deadline`; `G·sk` equals the request's key. Stores the output. Pays the fee to the request's `payout`; the slot goes back to the bond if the request's term is the current one, else its collateral goes to `payout` too. |
| `expire(id)` | anyone | Pending; `now ≥ deadline`. Marks it expired. Pays fee and collateral to `refundTo`. |
| `depositBond(slots)` | anyone | A key is active; the deployment takes collateral. Pays `slots × collateralPerRequest` in and adds the slots. |
| `withdrawBond(slots)` | current oracle | That many free slots. Pays them to `oraclePayout`. Slots pending requests hold aren't free. |
| `proposeOracleKey(pk, now)` | operator | `now` within 10 minutes of block time. Proposes a key, acceptable from `now + 10 minutes + oracleKeyDelay` (the caller's `now` may be up to 10 minutes behind the block, so the wait is never shorter than `oracleKeyDelay`) (or sooner with the current oracle's approval); proposing again restarts the wait. The current key stays active until the new one is accepted. Pending requests keep their key. |
| `proposeOperator(c)` / `acceptOperator()` | operator / incoming operator | Two-step hand-over, so a mistyped commitment can't lock admin out. |

## 4. Threat model

| Actor | Can | Cannot |
|---|---|---|
| Requester | Choose `tag` and `seed` | Predict the output (needs `sk`); touch another requester's ids |
| Oracle | Compute any output in advance for an `alpha` it knows; decline to answer | Choose between outputs; answer late; answer with another key |
| Operator | Propose keys for future requests | Activate a key without the oracle; change a pending request's key; touch outputs |
| Maintenance authority | Nothing once locked at deployment (§4.5) | Replace circuits or itself after the lock |
| Anyone | Read every output; expire missed requests; make requests (free in v0) | Fulfil without `sk` |

### 4.1 Grinding

The oracle can evaluate the VRF privately for any input. If the oracle (or someone colluding with it) can influence `alpha` before the request is made, for example by adding entries to a lottery whose state feeds the seed, it can search for an input with a favourable output. Chainlink limits this by mixing in the request's block hash; Compact 0.31 exposes no block hash, so v0 cannot. Consumers should request only after the outcome-relevant state is closed, and combine the output with their own commit-reveal secret (§5).

### 4.2 Withholding and aborts

Each party that learns the result before others can refuse to continue:

- **The oracle** sees every output before publishing and can let a request expire.
- **A consumer using commit-reveal** (§5) reveals its seed last, so it can compute the final result and refuse to reveal.

These are aborts, not choices, but an abort is only harmless if the consumer's fallback does not give the aborting party a second draw. In particular, re-requesting with a fresh seed after an expiry hands the oracle a re-roll. Consumers should:

- Make an expired request or an unrevealed seed **void the round** (refund entries) rather than redraw it.
- Back the operator's reveal with a bond or penalty, and run the oracle independently of anyone who profits from outcomes.
- Monitor the oracle's expiry rate; a high rate is a signal of selective withholding.

### 4.3 Spam

Requests were free in v0, so anyone could create many with short deadlines and push real requests back in the oracle's queue. Since v1 each request pays `requestFee` (to the oracle that answers it), and each one also needs a free slot of bond, so the number of open requests is bounded by the bond. A requester who fills the bond with requests pays the fee for each, and gets nothing back unless the oracle skips them. The oracle service can still be limited to known requester commitments (`requesters` option).

### 4.3a Fees and bonds (v1, issues #13 and #9)

The oracle has something at stake for every request. Its bond is counted in slots of `collateralPerRequest`, and a request takes one slot. If the oracle answers in time, the slot goes back to the bond and the oracle is paid the fee. If it lets the request expire, the fee and the collateral both go to the request's `refundTo`, once anyone calls `expire`.

**Accounting.** The contract's NIGHT always equals the free slots times `collateralPerRequest`, plus the fee and collateral of every pending request. The simulator tests check this after every step, including over a long random mix of every call.

**What is guaranteed: each request's own collateral.** Nobody can take it: not the oracle, the operator or a new oracle. It goes back to the bond, or to the oracle that answered, or to the requester.

**What isn't: the free bond.** The oracle may withdraw free slots at any time. An earlier draft made withdrawals wait, but a wait can't be enforced: an oracle can always tie its free bond up in requests to itself (with its own refund address) and let them expire, getting it back in about `minWindow`. So a consumer should count on the collateral its request took, and check that there's a free slot when it plans to request. Lunardraw-style consumers, which request only after selling, should void and refund a draw whose request is refused for want of bond.

**Key changes.** A replacement key doesn't inherit the old oracle's bond: its free slots go back to the old payout. Requests made under the old key (in its term) keep their collateral. It goes to the old oracle's payout when that oracle answers them, or to their requesters if they expire. `oracleTerm` tells terms apart even when a key comes back (A, then B, then A again). `approveOracleKey(key)` names the key it approves, so the operator can't slip a different proposal in ahead of the approval.

**Requests and answers at the same time.** The free slots are a `Counter`. A request checks that at least one slot is free (`lessThan(1)`, which publishes only the yes/no) and takes one. An answer gives one back. Neither reads the count itself, so requests and answers built against the same state don't invalidate each other's proofs, which a plain number cell would. Only the last free slot can be taken once. The tests replay transactions built against an earlier state to check this.

**Limits:**
- The collateral bounds the oracle's incentive to withhold only up to its value. An oracle that gains more from a skipped draw than the collateral still can, so choose `collateralPerRequest` for the stakes.
- There's one payout per oracle term. To change it, the oracle rotates its key.
- There's no slashing for anything but expiry. A wrong answer is impossible (the proof), and grinding (§4.1) is prevented by the input design, not by the bond.
- `refundTo`, and the wallet paying the fee, are public. That's more than v0 showed about a requester.

### 4.4 Key and operator compromise

Whoever holds `sk` can predict every output for requests bound to it; rotation (`proposeOracleKey` + `acceptOracleKey`) only protects later requests.

The proof of possession in `acceptOracleKey` shows that *someone* holds the proposed key's secret; it can't tell the oracle from an operator who generated the key itself. So a compromised (or dishonest) operator **can** install a key it controls, and every later request would be bound to it. (An earlier version of this section claimed otherwise; the security review of 23 Oct 2026 corrected it.) The contract limits this in two ways:

- A replacement key waits `oracleKeyDelay` (= `maxWindow`) from its proposal before it can be accepted, unless the current oracle approves it. Every request open at the proposal is answered or expired under the old key first, and the proposal is on chain, with its earliest effective time, for at least that long. `nightcast verify` and `check` report a pending change.
- Each request records the key it was made under, and `fulfil` only accepts that key.

A planned hand-over (the current oracle calls `approveOracleKey`) needs no wait. Consumers should check `request.oracleKey` against a key they trust before relying on an output, and treat a pending key change they didn't expect as a sign of operator compromise.

### 4.5 Contract maintenance authority (important)

Every Midnight contract has a maintenance authority: a committee of signing keys and a threshold. Enough committee signatures can remove and replace the contract's verifier keys, or replace the authority itself. Whoever controlled it could install a `fulfil` circuit that skips the key check and stores any output, so **every guarantee above depends on the authority being unusable**.

`nightcast-deploy` handles this:

1. It runs the constructor and, before anything is sent, sets the contract's authority to `{ committee: [], threshold: 1 }` in the initial state. The ledger accepts a maintenance update only with at least `threshold` valid signatures from committee members, and an empty committee can produce none, so no maintenance update of any kind can ever be applied. (midnight-js's `deployContract` always deploys with a fresh key as the authority; Nightcast builds the deploy transaction itself to avoid that.)
2. The contract is therefore locked from its first block: there is no window in which any key could change it, and no second "lock" transaction. The authority counter stays at 0.
3. It records the SHA-256 of every circuit's verifier key in `deployments/<network>.json`.

Anyone can check a deployment with `./nightcast verify`: the authority on chain must have `threshold > committee size`, and the on-chain verifier keys must match the published fingerprints (and, if they build the same commit, their own). Consumers should run this check, or rely on someone they trust who has, before trusting outputs. Verification checks the state on chain rather than trusting the deployer; contracts deployed by older versions (locked in a second transaction, counter 1) pass the same check.

### 4.6 The proof server

A Compact circuit's witnesses, including the oracle's `sk`, the operator secret and a requester secret, are handed to the proof server that builds the proof. A hosted or shared proof server therefore learns them. The oracle and the operator must run their own proof server, on the machine holding the secret, reachable only from that machine; `nightcast-deploy` starts one in Docker bound to `127.0.0.1`.

## 5. Consumer integration (v0)

v0 consumers read results off-chain (indexer or midnight-js `queryContractState`) and derive what they need with the SDK. Anyone can recompute the derivation from public data.

1. Commit to a secret if you use commit-reveal (e.g. publish `SHA-256(operatorSeedHex)` before ticket sales).
2. Close the outcome-relevant state.
3. `request(tag, seed, deadline)` with your requester secret; keep the returned id.
4. Wait for `requests[id].status`: `fulfilled`, or `expired` (void the round, §4.2).
5. Check `requests[id].requester` is your commitment and `oracleKey` is the key you expect.
6. Derive: `randomWords(output, n)`, `uniformInt(word, n)`, or for lotteries `pickNumbers(combineDrawSeed(operatorSeedHex, output), pick, pool)`, where `combineDrawSeed` is `SHA-256(seedHex + ":" + outputHex)`.

With commit-reveal, neither the consumer (no `sk`) nor the oracle (no seed) can predict the result alone; each can still abort (§4.2).

### 5.1 On-chain consumers: embed, don't call (decision, 22 Oct 2026)

A contract that needs randomness on chain (for example [Lunardraw](https://github.com/LearnMidnight/Lunardraw)'s Starfall contract, #6) cannot call the Nightcast contract yet, so it **embeds the same VRF** instead.

- **Cross-contract calls are not available on the networks we target.** They arrived with Compact 0.33.0 alongside ledger 9 (`crossContractCall()` in compact-runtime 0.19, assembled by midnight-js 5.0). Preprod and Mainnet run ledger 8 with Compact 0.31.1 and midnight-js 4.1.1, and toolchains from 0.32.110 on are not compatible with them. Midnight's documentation still describes cross-contract interaction as unavailable and will change only once Compact 0.33+ is supported on Preview ([midnight-docs#1291](https://github.com/midnightntwrk/midnight-docs/issues/1291)).
- **A contract can't read another contract's state in a circuit either**, so "call Nightcast, then read its output" isn't possible by any route today.
- **So the consumer carries its own copy of the VRF.** In Lunardraw, `contract/src/vrf.compact` holds the same construction as §2, with the same domain separators (`nightcast:h2c:v0`, `nightcast:output:v0`), and the consumer has its own request/fulfil circuits and oracle key (with the same proof-of-possession activation). For the same key and input, it gives exactly the output Nightcast would. The oracle service watches both contracts.
- **The consumer keeps Nightcast's guarantees.** The input is fixed by public data before the oracle can act, the oracle proves `gamma = H·sk` in-circuit, the consumer is deployed locked (§4.5) and verified the same way, and an expiry voids rather than redraws (§4.2).
- **Cost:** the VRF circuits are deployed twice, and the consumer's verifier keys need their own published fingerprints.
- **When cross-contract calls reach ledger 8's successors on Preprod and Mainnet**, the consumer can call Nightcast directly, and the embedded copy goes. The VRF and domain separators stay the same, so outputs don't change.

The Nightcast contract itself is untouched, so its deployed verifier keys still match this checkout.

## 6. Roadmap

- Multiple oracles, with the output defined as the hash of every oracle's output for the same id (any one honest oracle keeps it unpredictable).
- Block-derived input once Compact exposes one.
- On-chain consumer callbacks via cross-contract calls, replacing the embedded VRF (§5.1), once Preprod and Mainnet support them.
- Pruning of old requests. (Request fees and oracle bonds are in v1, §4.3a.)
- Written confirmation of `hashToCurve` in-circuit behaviour from Midnight, and an independent audit.
