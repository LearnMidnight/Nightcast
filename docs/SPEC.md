# Nightcast v0 specification

Status: experimental, unaudited. Targets Compact toolchain 0.31.1 (language 0.23), compact-runtime 0.16.0 and ledger 8, the versions on Midnight Preview, Preprod and Mainnet as of October 2026.

## 1. Goal

Give Midnight contracts and applications random values that:

- nobody can predict before the request is answered, except the oracle;
- nobody can bias, including the oracle, the requester and the operator;
- anyone can check, from public chain data alone.

Nightcast follows the shape of [Chainlink VRF](https://docs.chain.link/vrf) (request, then a later fulfilment that carries a proof), but uses Midnight's zero-knowledge transactions as the proof instead of a separate VRF proof checked by a coordinator contract.

## 2. Construction

Notation: `G` is the generator of the prime-order Jubjub subgroup Midnight uses as its embedded curve; `r` is that subgroup's order; `H2C` is Compact's `hashToCurve`; `SHA` is Compact's `persistentHash` (SHA-256 over the value's canonical encoding); `pad(s)` is `s` padded to 32 bytes.

**Keys.** The oracle picks `sk` uniformly in `[1, r)` and publishes `pk = G·sk`.

**Request id / VRF input.** For a deployment at address `A`, a consumer label `tag` and a requester-chosen `seed`:

```
alpha = SHA({ pad("nightcast:alpha:v0"), A, tag, seed })
```

`alpha` doubles as the request id, so a `(tag, seed)` pair can be used once per deployment.

**Evaluation.**

```
gamma  = H2C([ pad("nightcast:h2c:v0"), alpha ]) · sk
output = SHA({ pad("nightcast:output:v0"), gamma })
```

**Proof.** `fulfil(alpha)` is a Compact circuit. With `sk` as a private witness it asserts `G·sk = pk_request` and computes `output` exactly as above, then stores it. The transaction's ZK proof shows the circuit ran correctly, so the chain only accepts an output that is the evaluation for `(pk_request, alpha)`. `sk` never leaves the oracle.

**Extra words.** `word_i = SHA({ pad("nightcast:word:v0"), output, i })` gives any number of independent 32-byte values from one output.

All of these are exported as pure circuits (`requestId`, `publicKey`, `evaluate`, `randomWord`) so off-chain code uses the compiled contract's own encoding.

### Why the output is unique

`pk` fixes `sk` modulo `r`. `gamma = H2C(alpha)·sk` depends only on `sk mod r`, because `H2C` returns points in the prime-order subgroup (the ledger's `EmbeddedGroupAffine` wraps `JubjubSubgroup`). So any witness that passes the key check gives the same `gamma`, hence the same `output`. The oracle's only freedom is whether to answer.

### Why it is unpredictable

Computing `gamma` without `sk` means solving a discrete-log-type problem on Jubjub; the output is a hash of `gamma`. This is the standard EC-VRF argument (RFC 9381), with the ZK proof standing in for the DLEQ proof.

## 3. Contract

Ledger:

| Field | Meaning |
|---|---|
| `requests: Map<Bytes<32>, Request>` | By id: `status` (pending, fulfilled, expired), `tag`, `oracleKey`, `deadline`, `output` |
| `requestCount: Counter` | Total requests (increment only, so concurrent requests don't conflict) |
| `oracleKey: JubjubPoint` | Key bound to new requests |
| `operator: Bytes<32>` | `SHA(pad("nightcast:operator:v0"), secret)` |
| `minWindow`, `maxWindow` (sealed) | Allowed deadline distance in seconds |

Circuits:

| Circuit | Who | Checks |
|---|---|---|
| `request(tag, seed, deadline)` | anyone | `now + minWindow < deadline ≤ now + maxWindow`; id is new. Stores a pending request bound to the current `oracleKey`. |
| `fulfil(id)` | oracle | Request pending; `now < deadline`; `G·sk` equals the request's key. Stores the output. |
| `expire(id)` | anyone | Request pending; `now ≥ deadline`. Marks it expired. |
| `setOracleKey(pk)` | operator | Operator secret matches. Affects new requests only. |
| `setOperator(commitment)` | operator | Operator secret matches. |

## 4. Threat model

| Actor | Can | Cannot |
|---|---|---|
| Requester | Choose `tag` and `seed` | Predict the output (needs `sk`), or reuse an id |
| Oracle | Compute any output in advance for an `alpha` it knows; refuse to answer | Choose between outputs; answer late; answer with a different key |
| Operator | Rotate the key for future requests | Change the key of a pending request; touch outputs |
| Anyone | Read every output; expire missed requests | Fulfil without `sk` |

### 4.1 Grinding (main caveat)

The oracle can evaluate the VRF privately for any input. If the oracle (or someone colluding with it) can influence `alpha` before the request is made, for example by adding entries to a lottery whose state feeds the seed, it can search for an input with a favourable output. Chainlink limits this by mixing in the request's block hash; Compact 0.31 exposes no block hash, so Nightcast v0 cannot.

Consumers should therefore:

1. Request only after the outcome-relevant state is closed (ticket sales, game moves).
2. Combine the output with their own commit-reveal secret. The operator publishes `SHA-256(operatorSeed)` before sales, requests Nightcast after sales close, then reveals the seed; the draw seed is `SHA-256(operatorSeed + ":" + outputHex)` (`combineDrawSeed` in the SDK). The operator can't predict the output (no `sk`) and the oracle can't predict the seed, so only collusion between the two breaks fairness.

### 4.2 Withholding

The oracle sees the output before anyone else and could decline to post an unfavourable one. Deadlines bound this: a missed request can be expired by anyone, and consumers must treat an expired request as void (refund, re-request with a fresh seed) rather than retrying in a way that lets the oracle choose. Running the oracle separately from anyone who profits from outcomes, and (later) several oracles, reduces the incentive.

### 4.3 Key compromise

Whoever holds `sk` can predict every output for requests bound to it. Keep `sk` in a secrets manager, rotate with `setOracleKey`, and note that rotation only protects requests made afterwards.

### 4.4 Operator compromise

The operator can point new requests at a key it controls. Consumers that need stronger guarantees should check `request.oracleKey` against a key they trust before relying on an output.

## 5. Consumer integration (v0)

v0 consumers read results off-chain (indexer or midnight-js `queryContractState`) and derive what they need with the SDK. Anyone can recompute the derivation from public data.

1. Close the outcome-relevant state.
2. `request(tag, seed, deadline)`; keep the returned id.
3. Wait for `requests[id].status == fulfilled` (or `expired`).
4. Derive: `randomWords(output, n)`, `uniformInt(word, n)`, or for lotteries `pickNumbers(combineDrawSeed(operatorSeed, output), pick, pool)`.

On-chain consumption (a consumer contract reading the result directly) waits on cross-contract calls being available on the target networks.

## 6. Roadmap

- Multiple oracles, with the output defined as the hash of every oracle's output for the same id (any one honest oracle keeps it unpredictable).
- Block-derived input once Compact exposes one.
- On-chain consumer callbacks via cross-contract calls.
- Fees (direct funding or subscriptions, as in Chainlink VRF v2.5).
- Independent audit.
