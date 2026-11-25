# Run Nightcast v1: build, deploy, run an oracle, check a result

This is the hands-on guide to Nightcast v1, the single-oracle contract that is live on Preprod. For what Nightcast is, start with the [README](../README.md). For using the randomness in an app, the [developer guide](GUIDE.md) is shorter.

**Chain access.** Midnight retired its own Preprod indexer (9 Oct 2026) and its public Preprod node (23 Nov 2026). Nightcast reaches Preprod through [Blockfrost](https://blockfrost.io) for both, so every command that touches Preprod needs a Blockfrost project id: `./nightcast blockfrost save` stores one. To use your own node instead, set `NIGHTCAST_NODE_URL` and `NIGHTCAST_NODE_WS`.

## Build from source

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

## Generate secrets

The oracle, operator and each requester are separate roles; keep their secrets on separate machines.

**Run your own proof server.** Every secret a circuit uses (the oracle key in `fulfil` and `acceptOracleKey`, the operator secret, a requester secret) is sent to the proof server to build the proof. So the oracle and the operator must each use a proof server on their own machine, never a hosted or shared one. The tools start one in Docker bound to `127.0.0.1`, so nothing else on the network can reach it.

```sh
./nightcast keygen oracle    --out oracle.secret     # prints the oracle public key
./nightcast keygen operator  --out operator.secret   # prints the operator commitment
./nightcast keygen requester --out requester.secret  # prints the requester commitment
```

Files are created with mode 600, never overwritten, and `*.secret` is git-ignored.

## Deploy

**New to Midnight?** Follow the step-by-step [Preprod guide](preprod-guide.md) (written for Windows, works on macOS and Linux too). It covers installing everything, wallets and test tokens, deploying, running the oracle and making a test request.

You need Docker (for a local proof server) and a funded Preprod wallet seed (hex). The deploy tool handles the rest:

```sh
./nightcast wallet new --out wallet.secret      # then fund it: wallet show --network preprod --wallet wallet.secret
./nightcast deploy --network preprod --oracle oracle.secret --operator operator.secret --wallet wallet.secret --accept
```

(A *new* v1 deployment on ledger 9 needs the v1 contract compiled with Compact 0.36 first, which is still to do: [#58](https://github.com/LearnMidnight/Nightcast/issues/58). Contracts compiled with 0.31.1, like the live one, keep working. The live deployment was made this way on 9 Nov 2026, with `--fee 0.1 --collateral 1`.)

`--fee <NIGHT>` is what each request pays the oracle and `--collateral <NIGHT>` how much of the oracle's bond each request sets aside (paid to the requester if it expires). Both default to 0.

In one run this:

1. starts a proof server in Docker (or use `--proof-server-port 6300` for one you already run);
2. deploys the contract **already locked**: its maintenance authority is an empty committee from the first block, so nobody, including you, can ever replace the contract's code ([SPEC §4.5](SPEC.md#45-contract-maintenance-authority-important));
3. with `--accept`, has the oracle prove it holds its key (`acceptOracleKey`). Leave `--accept` out to keep the oracle secret off the deploying machine; the oracle then runs `./nightcast accept-key --network preprod --oracle oracle.secret` itself;
4. writes `deployments/preprod.json` with the address, transactions and the SHA-256 **fingerprint of every circuit's verifier key**, then verifies all of it on chain.

Commit `deployments/preprod.json` to publish it. Anyone can then check the live contract with `./nightcast verify --network preprod`; see [deployments/README.md](../deployments/README.md). The wallet only pays fees. Only the public parts of the key files are used (plus the oracle secret with `--accept`, kept in memory); no admin key for the contract ever exists.

`--network local` starts a throwaway Midnight network in Docker for the end-to-end tests; those are switched off in CI until #58. `--network preview` hasn't been tested again since the move to the ledger 9 stack.

## Run an oracle

```sh
./nightcast oracle  --network preprod --oracle oracle.secret --wallet wallet.secret
./nightcast request --network preprod --requester requester.secret --wallet other-wallet.secret --wait
```

`oracle` joins the deployment in `deployments/preprod.json` and answers every request bound to its key until you press Ctrl+C (`--requesters <hex,...>` limits it to known requesters). A request it misses, it marks expired a minute after the deadline, so the requester gets the fee and the collateral back. `request --wait` makes a test request and prints the result; `status --id <id>` looks one up from public data.

On a deployment that takes collateral the oracle needs a bond before anyone can request: `./nightcast bond deposit --network preprod --slots 50 --wallet wallet.secret` adds 50 slots (one per open request). `./nightcast verify` shows how many are free.

## Check a result, end to end

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

To embed the oracle in your own service, use `NightcastOracle` with a `MidnightChain` from `@nightcast/sdk` (see [`deploy/src/service.ts`](../deploy/src/service.ts) for how the CLI does it).

## Use the randomness

```ts
import { combineDrawSeed, drawStarfall, pickNumbers } from '@nightcast/sdk';

// Lottery: commit SHA-256(operatorSeed) before sales, request after sales close,
// then reveal operatorSeed once the request is fulfilled.
const drawSeed = combineDrawSeed(operatorSeed, request.output);
const { numbers, moonball } = drawStarfall(drawSeed); // 7 from 35 + Moonball from 20
const other = pickNumbers(drawSeed, 6, 45);             // any other pick/pool
```

`pickNumbers` and `pickMoonball` are the same rules as the Lunardraw verification page (test vectors: 64 zeros gives Starfall 6 7 13 23 26 31 35 + Moonball 14, and 6 from 45 gives 1 3 7 21 31 35). If a request expires or the seed is never revealed, void the round and refund it rather than drawing again ([SPEC §4.2](SPEC.md#42-withholding-and-aborts)).
