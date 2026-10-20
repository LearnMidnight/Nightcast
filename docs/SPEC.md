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
| `requests: Map<Bytes<32>, Request>` | By id: `status` (pending, fulfilled, expired), `requester`, `tag`, `point` (H), `oracleKey`, `deadline`, `output` |
| `requestCount: Counter` | Total requests (increment only, so concurrent requests don't conflict) |
| `oracleKey`, `oracleKeyReady` | Key bound to new requests, once accepted |
| `proposedOracleKey: Maybe<JubjubPoint>` | Key waiting for the oracle's proof of possession |
| `operator`, `proposedOperator` | `SHA(pad("nightcast:operator:v0"), secret)`, and a pending hand-over |
| `minWindow`, `maxWindow` (sealed) | Allowed deadline distance in seconds; `60 ≤ min < max ≤ 30 days` |

Circuits:

| Circuit | Who | Checks / effect |
|---|---|---|
| constructor `(pk, operatorCommitment, min, max)` | deployer | Window bounds. `pk` is only proposed. |
| `acceptOracleKey()` | oracle | A key is proposed; it isn't the identity; `G·sk` equals it. Activates it. |
| `request(tag, seed, deadline)` | requester | A key is active; `now + min < deadline ≤ now + max`; id is new. Stores a pending request with `H` and the current key. |
| `fulfil(id)` | oracle | Pending; `now < deadline`; `G·sk` equals the request's key. Stores the output. |
| `expire(id)` | anyone | Pending; `now ≥ deadline`. Marks it expired. |
| `proposeOracleKey(pk)` | operator | Proposes a key; the current one stays active until the oracle accepts. Pending requests keep their key. |
| `proposeOperator(c)` / `acceptOperator()` | operator / incoming operator | Two-step hand-over, so a mistyped commitment can't lock admin out. |

## 4. Threat model

| Actor | Can | Cannot |
|---|---|---|
| Requester | Choose `tag` and `seed` | Predict the output (needs `sk`); touch another requester's ids |
| Oracle | Compute any output in advance for an `alpha` it knows; decline to answer | Choose between outputs; answer late; answer with another key |
| Operator | Propose keys for future requests | Activate a key without the oracle; change a pending request's key; touch outputs |
| Maintenance authority | **Replace the contract's circuits** (§4.5) | (Nothing, while it holds a usable key) |
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

Requests are free in v0, so anyone can create many with short deadlines and push real requests back in the oracle's queue. The oracle service can be limited to known requester commitments (`requesters` option). Fees are on the roadmap.

### 4.4 Key and operator compromise

Whoever holds `sk` can predict every output for requests bound to it; rotation (`proposeOracleKey` + `acceptOracleKey`) only protects later requests. A compromised operator can propose a new key, but it only becomes active if the oracle proves possession of it, so an operator-only compromise cannot swap in its own key. Consumers that need more certainty should check `request.oracleKey` against a key they trust.

### 4.5 Contract maintenance authority (important)

Every Midnight contract has a maintenance authority that can remove and replace its verifier keys. midnight-js `deployContract` gives the deployer a working authority by default. Whoever holds it can install a `fulfil` circuit that skips the key check and stores any output, so **every guarantee above depends on the authority being unusable**. A production deployment must:

1. Deploy with, or immediately switch to, an authority that can never sign (for example an empty committee or a threshold above the committee size).
2. Publish the expected verifier key hashes for every circuit, built from a tagged commit with the pinned compiler.
3. Let consumers check both the authority and the verifier keys on chain before trusting outputs.

v0 does not automate any of this yet.

## 5. Consumer integration (v0)

v0 consumers read results off-chain (indexer or midnight-js `queryContractState`) and derive what they need with the SDK. Anyone can recompute the derivation from public data.

1. Commit to a secret if you use commit-reveal (e.g. publish `SHA-256(operatorSeedHex)` before ticket sales).
2. Close the outcome-relevant state.
3. `request(tag, seed, deadline)` with your requester secret; keep the returned id.
4. Wait for `requests[id].status`: `fulfilled`, or `expired` (void the round, §4.2).
5. Check `requests[id].requester` is your commitment and `oracleKey` is the key you expect.
6. Derive: `randomWords(output, n)`, `uniformInt(word, n)`, or for lotteries `pickNumbers(combineDrawSeed(operatorSeedHex, output), pick, pool)`, where `combineDrawSeed` is `SHA-256(seedHex + ":" + outputHex)`.

With commit-reveal, neither the consumer (no `sk`) nor the oracle (no seed) can predict the result alone; each can still abort (§4.2).

On-chain consumption (a consumer contract reading the result directly) waits on cross-contract calls being available on the target networks.

## 6. Roadmap

- Lock the maintenance authority and publish verifier key hashes as part of deployment tooling.
- Multiple oracles, with the output defined as the hash of every oracle's output for the same id (any one honest oracle keeps it unpredictable).
- Block-derived input once Compact exposes one.
- On-chain consumer callbacks via cross-contract calls.
- Fees (direct funding or subscriptions, as in Chainlink VRF v2.5), and pruning of old requests.
- Written confirmation of `hashToCurve` in-circuit behaviour from Midnight, and an independent audit.
