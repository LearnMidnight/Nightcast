# Nightcast

Nightcast is an independent, experimental verifiable randomness protocol for Midnight, designed to power smart contracts, lotteries, games and AI agents with publicly verifiable randomness.

It works like [Chainlink VRF](https://docs.chain.link/vrf): you request randomness, an oracle answers, and the answer comes with a proof. On Midnight the proof is the transaction itself. The oracle's `fulfil` circuit evaluates the VRF with its secret key as a private input, so the network only accepts the one output that key can produce for that request, and the key is never revealed.

> **Status: v1, experimental and unaudited.** Don't secure real value with it yet. Read the [threat model](docs/SPEC.md#4-threat-model) first, especially [withholding](docs/SPEC.md#42-withholding-and-aborts).

## Live deployment

| Network | Contract | Status |
|---|---|---|
| Preprod | `eaae909ead81a20f6a8873aec8bdcd0c428424672771991550c483b044a73adb` | **v1** (request fees and oracle bonds). Deployed locked (no admin key ever existed) on 9 Nov 2026 from `9e7203e`, compiled with Compact 0.31.1; it carried over the ledger 9 fork the same day and is called through Midnight.js 5. Oracle key active; payout to the operator's treasury. Fee **0.1 tNIGHT** a request, collateral **1 tNIGHT** a request. |
| Preprod (v0, retired) | `f3083513bae7010e32acac41e3f3dbfdfa0516c6ca80382c5847dd3529cf158e` | 24 Oct 2026, v0. Still on chain; no oracle answers it any more. |

Check it yourself with `./nightcast verify --network preprod` (record: [deployments/preprod.json](deployments/preprod.json)).

**v1: request fees and oracle bonds** ([SPEC §4.3a](docs/SPEC.md#43a-fees-and-bonds-v1-issues-13-and-9)). Each request pays the fee to the oracle when it's answered and holds one slot of the oracle's bond as collateral; if the oracle misses the deadline, `expire` returns the fee and the collateral to the requester. `./nightcast verify` reports the free bond slots.

**Ledger 9.** Preprod moved to ledger 9 on 9 Nov 2026 (in place: contracts and balances carried over). `main` is on the ledger 9 stack (Midnight.js 5, wallet SDK 2, proof server 9.0.0, Midnight's public Preprod node). Contracts compiled with Compact 0.31.1, like the one above, keep working; a *new* deployment on ledger 9 needs a Compact 0.36 compile, which is still to do ([#58](https://github.com/LearnMidnight/Nightcast/issues/58)).

**What that means today.** Everything that uses the live deployment works: requests, the oracle, `verify`, `check`, the MCP server. `./nightcast deploy` can't make a *new* deployment on Preprod until #58, and the local test network (ledger 8 images) doesn't work with this stack either, so CI's local end-to-end steps are switched off for now.

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
| `contract/src/nightcast.compact` | The contract: `request`, `fulfil`, `expire`, key management (a replacement key waits the longest request window unless the current oracle approves it) and operator hand-over, and pure circuits for ids, keys and evaluation |
| `contract/src/keys.ts` | Key generation and parsing |
| `contract/src/simulator.ts` | Runs the compiled contract in memory with several actors and a controllable clock |
| `sdk/src/oracle.ts` | The oracle service: polls, fulfils pending requests bound to its key, retries with backoff, respects deadlines, marks a request it missed as expired (so the requester is refunded), optional requester allowlist |
| `sdk/src/chain.ts` | Chain adapters: simulator, and live Midnight via midnight-js |
| `sdk/src/derive.ts` | Turning an output into numbers: `randomWords` (SHA-256 or, for in-circuit use, Poseidon), `randomFieldWords`, `uniformInt`, `pickNumbers`, `pickMoonball`, `drawStarfall`, `combineDrawSeed` |
| `contract/src/NightcastWords.compact` | A module your contract imports to expand an output into words in-circuit: `randomWord` (SHA-256) or `randomWordPoseidon` (about 20 times cheaper, internal use only) |
| `sdk/src/keygen.ts` | `./nightcast keygen`: generate oracle, operator and requester secrets |
| `deploy/` | `./nightcast` commands: deploy (locked from the start), accept the oracle key, verify, wallets, the oracle's bond, run the oracle, test requests, the MCP server |
| `nightcast` | Wrapper script that runs the tools from a checkout |
| `deployments/` | Published records of live deployments |
| `sdk/src/pick.ts` | Everyday choices from one answer: `pick`, `pickMany`, `shuffle`, `randomInt`, `rollDice`, `weightedPick`, and `listCommitment` for fair draws |
| `examples/raffle/` | A fair raffle using only the published packages |
| `docs/GUIDE.md` | The developer guide |

## Built on Nightcast

- [Lunardraw](https://github.com/LearnMidnight/Lunardraw): a self-running lottery for AI agents (daily Starfall draws). Its contract embeds Nightcast's VRF ([SPEC §5.1](docs/SPEC.md#51-on-chain-consumers-embed-dont-call-decision-22-oct-2026)) and uses this repo as a submodule.
- [LunaSpin](https://lunardraw.io/spin/): a free name draw with a certificate anyone can check. Each spin is a request to the live deployment above, made through the MCP server.

## For AI agents

`./nightcast mcp` is an MCP server with tools to fingerprint a list, request a random value, check a request and turn the answer into a result (a winner, an order, dice...). It runs over stdio for an AI app on your computer, or over HTTP to host it for agents anywhere. See [docs/MCP.md](docs/MCP.md).

## Use it in your app

```bash
npm install @nightcast/sdk @nightcast/contract
```

```ts
import { pickMany, listCommitment } from '@nightcast/sdk';

const winners = pickMany(output, names, 3); // three fair winners from a Nightcast answer
```

Picking names, shuffles, dice, weighted prizes and lottery numbers from one answer, and running a raffle anyone can check: see the **[developer guide](docs/GUIDE.md)** and the [raffle example](examples/raffle). The packages are published from this repository by [GitHub Actions with provenance](docs/PUBLISHING.md).

**Which version is on npm.** 0.1.0 (2 Nov 2026) holds the v0 contract. The picking helpers and the simulator work as described. To call the live v1 deployment from your own code you need the v1 contract, so build `@nightcast/contract` from this repository until the next release is published.

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

**Run your own proof server.** Every secret a circuit uses (the oracle key in `fulfil` and `acceptOracleKey`, the operator secret, a requester secret) is sent to the proof server to build the proof. So the oracle and the operator must each use a proof server on their own machine, never a hosted or shared one. The tools start one in Docker bound to `127.0.0.1`, so nothing else on the network can reach it.

```sh
./nightcast keygen oracle    --out oracle.secret     # prints the oracle public key
./nightcast keygen operator  --out operator.secret   # prints the operator commitment
./nightcast keygen requester --out requester.secret  # prints the requester commitment
```

Files are created with mode 600, never overwritten, and `*.secret` is git-ignored.

### Deploy

**New to Midnight?** Follow the step-by-step [Preprod guide](docs/preprod-guide.md) (written for Windows, works on macOS and Linux too). It covers installing everything, wallets and test tokens, deploying, running the oracle and making a test request.

You need Docker (for a local proof server) and a funded Preprod wallet seed (hex). The deploy tool handles the rest:

```sh
./nightcast wallet new --out wallet.secret      # then fund it: wallet show --network preprod --wallet wallet.secret
./nightcast deploy --network preprod --oracle oracle.secret --operator operator.secret --wallet wallet.secret --accept
```

(A new deployment on Preprod waits for [#58](https://github.com/LearnMidnight/Nightcast/issues/58); see [Ledger 9](#live-deployment) above. The live deployment was made this way on 9 Nov 2026, with `--fee 0.1 --collateral 1`.)

`--fee <NIGHT>` is what each request pays the oracle and `--collateral <NIGHT>` how much of the oracle's bond each request sets aside (paid to the requester if it expires). Both default to 0.

In one run this:

1. starts a proof server in Docker (or use `--proof-server-port 6300` for one you already run);
2. deploys the contract **already locked**: its maintenance authority is an empty committee from the first block, so nobody, including you, can ever replace the contract's code ([SPEC §4.5](docs/SPEC.md#45-contract-maintenance-authority-important));
3. with `--accept`, has the oracle prove it holds its key (`acceptOracleKey`). Leave `--accept` out to keep the oracle secret off the deploying machine; the oracle then runs `./nightcast accept-key --network preprod --oracle oracle.secret` itself;
4. writes `deployments/preprod.json` with the address, transactions and the SHA-256 **fingerprint of every circuit's verifier key**, then verifies all of it on chain.

Commit `deployments/preprod.json` to publish it. Anyone can then check the live contract with `./nightcast verify --network preprod`; see [deployments/README.md](deployments/README.md). The wallet only pays fees. Only the public parts of the key files are used (plus the oracle secret with `--accept`, kept in memory); no admin key for the contract ever exists.

`--network local` starts a throwaway Midnight network in Docker for the end-to-end tests; those are switched off in CI until #58. `--network preview` hasn't been tested again since the move to the ledger 9 stack.

### Run an oracle

```sh
./nightcast oracle  --network preprod --oracle oracle.secret --wallet wallet.secret
./nightcast request --network preprod --requester requester.secret --wallet other-wallet.secret --wait
```

`oracle` joins the deployment in `deployments/preprod.json` and answers every request bound to its key until you press Ctrl+C (`--requesters <hex,...>` limits it to known requesters). A request it misses, it marks expired a minute after the deadline, so the requester gets the fee and the collateral back. `request --wait` makes a test request and prints the result; `status --id <id>` looks one up from public data.

On a deployment that takes collateral the oracle needs a bond before anyone can request: `./nightcast bond deposit --network preprod --slots 50 --wallet wallet.secret` adds 50 slots (one per open request). `./nightcast verify` shows how many are free.

### Check a result, end to end

```sh
./nightcast check    --network preprod --id <request id> --tag <text> --seed <hex>
./nightcast selftest --network preprod --requester requester.secret --wallet other-wallet.secret
```

`check` confirms a request from public data alone, with no secrets:
- the deployment is the published, locked one;
- the request is bound to the published oracle key;
- its curve point is `hashToCurve(id)`, so the oracle couldn't choose its input;
- it was answered;
- given the tag and seed (`request` prints both), its id is the one that was asked for.

The output itself was checked by the network, which verified the oracle's `fulfil` proof against the published verifier key. `request --wait` runs these checks on its result.

`selftest` is the full end-to-end run (with the oracle running):
1. It makes a request, waits for the answer, and checks it as above.
2. It makes a second request too close to its deadline for the oracle to take, waits for the deadline, and marks it expired with `expire`, which anyone can do. That is what happens to a round the oracle doesn't answer: it is voided, never redrawn.

To embed the oracle in your own service, use `NightcastOracle` with a `MidnightChain` from `@nightcast/sdk` (see `deploy/src/service.ts` for how the CLI does it).

### Use the randomness

```ts
import { combineDrawSeed, drawStarfall, pickNumbers } from '@nightcast/sdk';

// Lottery: commit SHA-256(operatorSeed) before sales, request after sales close,
// then reveal operatorSeed once the request is fulfilled.
const drawSeed = combineDrawSeed(operatorSeed, request.output);
const { numbers, moonball } = drawStarfall(drawSeed); // 7 from 35 + Moonball from 20
const other = pickNumbers(drawSeed, 6, 45);             // any other pick/pool
```

`pickNumbers` and `pickMoonball` are the same rules as the Lunardraw verification page (test vectors: 64 zeros gives Starfall 6 7 13 23 26 31 35 + Moonball 14, and 6 from 45 gives 1 3 7 21 31 35). If a request expires or the seed is never revealed, void the round and refund it rather than drawing again ([SPEC §4.2](docs/SPEC.md#42-withholding-and-aborts)).

## Limitations

- One oracle. It can withhold an answer until the deadline and, if it can influence a request's input, grind for favourable outputs ([SPEC §4.1](docs/SPEC.md#41-grinding)). Its collateral makes withholding cost it something, up to the collateral's value.
- Results are read off-chain; on-chain consumer callbacks come with cross-contract calls.
- The number of open requests is bounded by the oracle's bond, and each one pays the fee ([SPEC §4.3](docs/SPEC.md#43-spam)); the requester allowlist is still there for an oracle that shouldn't serve everyone.
- A new deployment needs the Compact 0.36 recompile ([#58](https://github.com/LearnMidnight/Nightcast/issues/58)).
- Not audited.

## Licence

MIT
