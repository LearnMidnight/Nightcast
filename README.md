# Nightcast

Nightcast is an independent, experimental verifiable randomness protocol for Midnight, designed to power smart contracts, lotteries, games and AI agents with publicly verifiable randomness.

It works like [Chainlink VRF](https://docs.chain.link/vrf): you request randomness, an oracle answers, and the answer comes with a proof. On Midnight the proof is the transaction itself. The oracle's `fulfil` circuit evaluates the VRF with its secret key as a private input, so the network only accepts the one output that key can produce for that request, and the key is never revealed.

> **Status: v0, experimental and unaudited.** Don't secure real value with it yet. Read the [threat model](docs/SPEC.md#4-threat-model) first, especially the note on grinding.

## How it works

```
requester                     Nightcast contract                       oracle
    |  request(tag, seed, deadline) |                                        |
    |------------------------------>|  id = alpha = SHA(addr, tag, seed)     |
    |                               |  status = pending, key = oracleKey     |
    |                               |<---------------------------------------|  watches for pending ids
    |                               |  fulfil(id), proving in ZK that:       |
    |                               |    G·sk == request key                 |
    |                               |    output = SHA(hashToCurve(id)·sk)    |
    |  read requests[id].output     |  status = fulfilled                    |
    |<------------------------------|                                        |
```

- **Unbiasable:** one key and one request id give exactly one output, so the oracle can't pick a favourable result.
- **Unpredictable:** computing the output needs the oracle's secret key.
- **Verifiable:** the chain checks the proof before storing the output, and everything a consumer derives from it can be recomputed from public data.
- **Bounded withholding:** every request has a deadline; anyone can `expire` a request the oracle missed.

The full construction, ledger layout and threat model are in [docs/SPEC.md](docs/SPEC.md).

## Repository

| Path | What it is |
|---|---|
| `contract/src/nightcast.compact` | The contract: `request`, `fulfil`, `expire`, `setOracleKey`, `setOperator`, plus pure circuits for ids, keys, evaluation and word expansion |
| `contract/src/keys.ts` | Key generation and parsing |
| `contract/src/simulator.ts` | Runs the compiled contract in memory with several actors and a controllable clock |
| `sdk/src/oracle.ts` | The oracle service: polls, fulfils pending requests bound to its key, retries, respects deadlines |
| `sdk/src/chain.ts` | Chain adapters: simulator, and live Midnight via midnight-js |
| `sdk/src/derive.ts` | Turning an output into numbers: `randomWords`, `uniformInt`, `pickNumbers`, `combineDrawSeed` |
| `sdk/src/keygen.ts` | `nightcast-keygen` CLI |

## Getting started

Versions follow Midnight's [support matrix](https://docs.midnight.network/relnotes/support-matrix): Compact toolchain 0.31.1, compact-runtime 0.16.0, Node 22.

```sh
# Compact toolchain
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update 0.31.1

npm install
npm run compact     # compile the contract and generate proving keys
npm run build
npm test
```

`npm run compact:fast -w @nightcast/contract` skips proving keys for quick edits.

### Generate keys

```sh
npx nightcast-keygen --out oracle.secret
```

This writes the oracle secret key and operator secret to `oracle.secret` (mode 600; `*.secret` is git-ignored) and prints what the deployment needs: the oracle public key and the operator commitment.

### Deploy and run an oracle

Deploy with midnight-js as in Midnight's [example-counter](https://github.com/midnightntwrk/example-counter), passing the constructor arguments `(oraclePublicKey, operatorCommitment, minWindowSecs, maxWindowSecs)`. Then join the deployment with a private state holding the oracle key and start the service:

```ts
import { MidnightChain, NightcastOracle } from '@nightcast/sdk';
import { parseOracleSecretKey } from '@nightcast/contract';

const secretKey = parseOracleSecretKey(process.env.NIGHTCAST_ORACLE_KEY!);
// `nightcast` comes from findDeployedContract(..., { initialPrivateState: { oracleSecretKey: secretKey } })
const chain = new MidnightChain(nightcast, providers.publicDataProvider, contractAddress);
const oracle = new NightcastOracle({ chain, secretKey, logger: console });
oracle.start();
```

### Use the randomness

```ts
import { combineDrawSeed, pickNumbers } from '@nightcast/sdk';

// Lottery: commit SHA-256(operatorSeed) before sales, request after sales close,
// then reveal operatorSeed once the request is fulfilled.
const drawSeed = combineDrawSeed(operatorSeed, request.output);
const numbers = pickNumbers(drawSeed, 6, 45);
```

`pickNumbers` is the same rule as the Midnight Lotto verification page (test vector: 64 zeros, 6 from 45 gives 1 3 7 21 31 35).

## Limitations of v0

- One oracle. It can withhold an answer (until the deadline) and, if it can influence a request's input, grind for favourable outputs. Consumers should close their state before requesting and mix in their own commit-reveal secret ([SPEC §4.1](docs/SPEC.md#41-grinding-main-caveat)).
- Results are read off-chain; on-chain consumer callbacks come with cross-contract calls.
- No fees.
- Not audited.

## Licence

MIT
