# Nightcast

Nightcast is an independent, experimental verifiable randomness protocol for Midnight, designed to power smart contracts, lotteries, games and AI agents with publicly verifiable randomness.

It works like [Chainlink VRF](https://docs.chain.link/vrf): you request randomness, an oracle answers, and the answer comes with a proof. On Midnight the proof is the transaction itself. The oracle's `fulfil` circuit evaluates the VRF with its secret key as a private input, so the network only accepts the one output that key can produce for that request, and the key is never revealed.

> **Status: v0, experimental and unaudited.** Don't secure real value with it yet. Read the [threat model](docs/SPEC.md#4-threat-model) first, especially [withholding](docs/SPEC.md#42-withholding-and-aborts).

## How it works

```
requester                        Nightcast contract                          oracle
    |  request(tag, seed, deadline)   |                                           |
    |-------------------------------->|  id = SHA(addr, requester, tag, seed)     |
    |                                 |  H = hashToCurve(id), key = oracleKey     |
    |                                 |  status = pending                         |
    |                                 |<------------------------------------------|  watches for pending ids
    |                                 |  fulfil(id), proving in ZK that:          |
    |                                 |    G·sk == request key                    |
    |                                 |    output = SHA(H·sk)                     |
    |  read requests[id].output       |  status = fulfilled                       |
    |<--------------------------------|                                           |
```

- **The oracle can't choose:** one key and one request give exactly one output. Its only power is to not answer.
- **Unpredictable:** computing the output needs the oracle's secret key.
- **Checked on chain:** the network verifies the proof before storing the output, and everything a consumer derives from it can be recomputed from public data.
- **Bounded withholding:** every request has a deadline, and anyone can `expire` a request the oracle missed.
- **Your ids are yours:** request ids include the requester's commitment, so nobody else can claim, burn or spoof them.

The construction, ledger layout and threat model are in [docs/SPEC.md](docs/SPEC.md).

## Repository

| Path | What it is |
|---|---|
| `contract/src/nightcast.compact` | The contract: `request`, `fulfil`, `expire`, key and operator management, and pure circuits for ids, keys and evaluation |
| `contract/src/keys.ts` | Key generation and parsing |
| `contract/src/simulator.ts` | Runs the compiled contract in memory with several actors and a controllable clock |
| `sdk/src/oracle.ts` | The oracle service: polls, fulfils pending requests bound to its key, retries with backoff, respects deadlines, optional requester allowlist |
| `sdk/src/chain.ts` | Chain adapters: simulator, and live Midnight via midnight-js |
| `sdk/src/derive.ts` | Turning an output into numbers: `randomWords`, `uniformInt`, `pickNumbers`, `combineDrawSeed` |
| `sdk/src/keygen.ts` | `nightcast-keygen` CLI |
| `deploy/` | `nightcast-deploy` CLI: deploy, lock the maintenance authority, accept the oracle key, verify fingerprints |
| `deployments/` | Published records of live deployments |

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

### Generate secrets

The oracle, operator and each requester are separate roles; keep their secrets on separate machines.

```sh
npx nightcast-keygen oracle    --out oracle.secret     # prints the oracle public key
npx nightcast-keygen operator  --out operator.secret   # prints the operator commitment
npx nightcast-keygen requester --out requester.secret  # prints the requester commitment
```

Files are created with mode 600, never overwritten, and `*.secret` is git-ignored.

### Deploy

You need Docker (for a local proof server) and a funded Preprod wallet seed (hex). The deploy tool handles the rest:

```sh
export NIGHTCAST_WALLET_SEED=<hex seed of a wallet with tNIGHT>
npx nightcast-deploy deploy --network preprod --oracle oracle.secret --operator operator.secret --accept
```

In one run this:

1. starts a proof server in Docker (or use `--proof-server-port 6300` for one you already run);
2. deploys the contract with a one-time maintenance key;
3. **locks the maintenance authority** straight away by replacing it with an empty committee, so nobody, including you, can ever replace the contract's code ([SPEC §4.5](docs/SPEC.md#45-contract-maintenance-authority-important));
4. with `--accept`, has the oracle prove it holds its key (`acceptOracleKey`). Leave `--accept` out to keep the oracle secret off the deploying machine; the oracle then runs `nightcast-deploy accept-key --network preprod --oracle oracle.secret` itself;
5. writes `deployments/preprod.json` with the address, transactions and the SHA-256 **fingerprint of every circuit's verifier key**, then verifies all of it on chain.

Commit `deployments/preprod.json` to publish it. Anyone can then check the live contract with `npx nightcast-deploy verify --network preprod`; see [deployments/README.md](deployments/README.md). The wallet only pays fees. Only the public parts of the key files are used (plus the oracle secret with `--accept`, kept in memory), and the one-time maintenance key is never written to disk (unless locking fails, so it can be retried with `nightcast-deploy lock`).

`--network preview` works the same way. `--network local` starts a throwaway Midnight network in Docker, which is what CI uses for its end-to-end test.

### Run an oracle

Start the service with a contract handle joined using a private state that holds the oracle key:

```ts
import { MidnightChain, NightcastOracle } from '@nightcast/sdk';
import { parseOracleSecretKey } from '@nightcast/contract';

const secretKey = parseOracleSecretKey(process.env.NIGHTCAST_ORACLE_KEY!);
// `nightcast` comes from findDeployedContract(..., { initialPrivateState: { oracleSecretKey: secretKey } })
const chain = new MidnightChain(nightcast, providers.publicDataProvider, contractAddress);
const oracle = new NightcastOracle({
  chain,
  secretKey,
  requesters: ['<requester commitment hex>'], // optional allowlist against spam
  logger: console,
});
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

`pickNumbers` is the same rule as the Midnight Lotto verification page (test vector: 64 zeros, 6 from 45 gives 1 3 7 21 31 35). If a request expires or the seed is never revealed, void the round and refund it rather than drawing again ([SPEC §4.2](docs/SPEC.md#42-withholding-and-aborts)).

## Limitations of v0

- One oracle. It can withhold an answer until the deadline and, if it can influence a request's input, grind for favourable outputs ([SPEC §4.1](docs/SPEC.md#41-grinding)).
- Results are read off-chain; on-chain consumer callbacks come with cross-contract calls.
- Requests are free, so an oracle open to everyone can be spammed; use the requester allowlist.
- Not audited.

## Licence

MIT
