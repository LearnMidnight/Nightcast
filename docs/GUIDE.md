# Using Nightcast: a developer guide

Nightcast gives apps, contracts and AI agents on Midnight a random value that nobody chose: you ask for randomness, an oracle answers, and the network only accepts the one answer the oracle's key can give for your request. Then you turn that answer into what you need: a winner, a shuffled list, dice, lottery numbers.

> **Experimental and unaudited.** Use it on testnets (Preprod, Preview) and don't secure real value with it yet. The [threat model](SPEC.md#4-threat-model) says what it does and doesn't protect against; read [withholding](SPEC.md#42-withholding-and-aborts) at least.

- [Install](#install)
- [How a draw works](#how-a-draw-works)
- [Turning an answer into choices](#turning-an-answer-into-choices)
- [A fair raffle](#a-fair-raffle)
- [Making a request](#making-a-request)
- [Reading and checking an answer](#reading-and-checking-an-answer)
- [For AI agents](#for-ai-agents)
- [Testing without a network](#testing-without-a-network)
- [Randomness inside your own contract](#randomness-inside-your-own-contract)
- [What Nightcast can't do](#what-nightcast-cant-do)

## Install

```bash
npm install @nightcast/sdk @nightcast/contract
```

Node 22 or later. `@nightcast/contract` is the compiled contract (with its keys), its helpers and a simulator; `@nightcast/sdk` turns answers into choices and runs an oracle. Both are ES modules with TypeScript types.

## How a draw works

1. **Decide what you're drawing for, and fix it.** The entrants, the prizes, the rules. Once randomness exists, nothing it decides may change.
2. **Request** randomness from the Nightcast contract: `request(tag, seed, deadline)`. The `tag` is your label (32 bytes, e.g. `"raffle #12"`), the `seed` is 32 bytes you choose (for a raffle, the list's fingerprint), and the deadline is when the oracle must have answered. The request's id is fixed by the contract's address, your requester commitment, the tag and the seed.
3. **The oracle answers** (`fulfil`), usually within a couple of minutes. Its answer, `output`, is 32 bytes stored with the request. The network checked a zero-knowledge proof that it's the one output the oracle's key gives for this request.
4. **Use the answer**: turn `output` into your result with the SDK. Anyone with the same output and the same inputs gets the same result.
5. **If the deadline passes unanswered**, anyone can mark the request `expired`. Decide in advance what then happens (usually: cancel that draw and announce a new one), never "ask again until it looks right".

## Turning an answer into choices

```ts
import { pick, pickMany, shuffle, randomInt, rollDice, weightedPick } from '@nightcast/sdk';

// `output`: the request's answer, as 32 bytes or 64 hex characters
const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella'];

pick(output, names);                                     // one winner
pickMany(output, names, 3);                              // three different winners, first drawn first
shuffle(output, names);                                  // the whole list in a random order
randomInt(output, 1, 100);                               // 1 to 100, both included
rollDice(output, 2, 6);                                  // two six-sided dice, e.g. [4, 1]
weightedPick(output, { gold: 1, silver: 3, bronze: 6 }); // bronze 6 times in 10
```

- **Deterministic.** Same answer and same list, same result, on any machine. That is what lets others check you.
- **Unbiased.** Every helper reads 32-byte words from the answer (the contract's own `randomWord(output, i)`) and turns them into numbers by rejection sampling, so no entry is ever slightly more likely than another.
- **No repeats** in `pickMany`; `pickMany(output, list, k)` is always the first `k` of `shuffle(output, list)`.
- **Weights are whole numbers**, so the odds are exact. The order you list them in is part of the rule: publish it.
- **One answer decides one thing.** Two helpers run on the same answer read the same words, so their results are linked. Make a request per decision, or give each a different starting word with `{ from }` (`pick(output, names, { from: 10 })`).

Lower level: `randomWords(output, n)` gives n independent 32-byte words (SHA-256; for Poseidon see [Randomness inside your own contract](#randomness-inside-your-own-contract)), and `uniformInt(word, n)` an unbiased integer below n. Lotteries: `pickNumbers`, `drawStarfall` and `combineDrawSeed` (the rule [Lunardraw](https://github.com/LearnMidnight/Lunardraw) uses, with the operator's commit-reveal seed).

## A fair raffle

The point of verifiable randomness is that people who don't trust you can check the draw. That only works if the list can't change after the answer is known. So the list goes **into the request**.

1. **Fix the list** and compute its fingerprint:
   ```ts
   import { listCommitment } from '@nightcast/sdk';
   const fingerprint = listCommitment(names); // 64 hex characters
   ```
   Any change, an added name, a different order, a typo, gives a different fingerprint.
2. **Publish before you request**: the list (in its exact order), the fingerprint, the tag you'll use and how many winners. For example on your site or in the channel where entrants will look.
3. **Request** with the fingerprint as the seed:
   ```bash
   ./nightcast request --network preprod --requester requester.secret --wallet wallet.secret \
     --tag "raffle #12" --seed <fingerprint> --wait
   ```
   (or `request(tag, fromHex(fingerprint), deadline)` from your own code; see [Making a request](#making-a-request)). **Publish the request id straight away.** It is the draw: one request per raffle.
4. **When it's answered**, draw:
   ```ts
   const winners = pickMany(output, names, 3);
   ```
5. **Publish the winners with how to check them**: the request id, and "`listCommitment` of the list is the request's seed; `pickMany(output, list, 3)` gives the winners".

Anyone can then check, from public data only, that the request was made with this list (its id is `requestId(contract, requester, tag, listCommitment(list))`), that the oracle answered it, and that the winners follow from the answer. [examples/raffle](../examples/raffle) does all of this, on the simulator or from a real answer.

**Why announce the request id first?** You can't predict an answer, but you could make several requests and only show the one you like. Announcing the one request that decides the raffle, before it's answered, rules that out. The same goes for an expired request: what happens next is a rule you published before, not a choice.

## Making a request

A request is a transaction on the Nightcast contract, paid in DUST by your wallet, with your requester secret (`./nightcast keygen requester`) as its witness. The published deployments are in the [README](../README.md#live-deployment) and [deployments/](../deployments).

- **From the command line:** the repository's `./nightcast request` (set up as in the [Preprod guide](preprod-guide.md), Parts 1, 2 and 5). `--seed` sets the seed (a raffle's fingerprint; random otherwise), `--wait` waits for the answer and checks it.
- **From your own code:** with midnight-js, join the deployment with `findDeployedContract` using the compiled contract from `@nightcast/contract` and a private state holding `{ requesterSecret }`, then call `callTx.request(tag, seed, deadline)`. The request's id is its result. [deploy/src/service.ts](../deploy/src/service.ts) (`submitRequest`, `waitForResult`) is a complete, working example on midnight-js 4.1.1.

The deadline must be within the deployment's request window (`minWindow` to `maxWindow`, in its deployment record); 30 minutes is a good default.

## Reading and checking an answer

The answer is public: read the contract's state from an indexer and look the request up.

```ts
import { ledger, Status, toHex } from '@nightcast/contract';

const state = await publicDataProvider.queryContractState(contractAddress); // midnight-js
const r = ledger(state!.data).requests.lookup(id);
if (r.status === Status.fulfilled) {
  const output = r.output; // 32 bytes
}
```

`./nightcast status --network preprod --id <id>` does the same from the command line.

To check someone else's draw from public data (`./nightcast check --network preprod --id <id> --tag <text> --seed <hex>` runs these checks):

- the contract is the published, locked deployment (`./nightcast verify`);
- `r.oracleKey` is the deployment's published oracle key, and `r.status` is fulfilled;
- the id is the request that was announced, made with the seed they say:
  ```ts
  import { pureCircuits, fromHex, toHex } from '@nightcast/contract';
  import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
  const sameRequest = toHex(pureCircuits.requestId({ bytes: encodeContractAddress(contractAddress) }, r.requester, r.tag, fromHex(listCommitment(list)))) === toHex(id);
  ```
- the result follows from `r.output` with the published rule.

The output itself needs no checking by you: the network verified the oracle's proof before storing it.

## For AI agents

An agent can run a draw that its users can audit, by following the steps exactly and keeping what it published:

1. Build the list (strings), in a fixed order. Compute `listCommitment(list)`.
2. Publish the list, the fingerprint, the tag and the rule (e.g. "`pickMany`, 3 winners") **before** requesting. Keep the published text.
3. Request once with `seed = fingerprint`. Publish the request id at once.
4. Poll the request every 30 seconds or so until `fulfilled` or `expired`. If expired, follow the rule you published (cancel, or a new announced request), never a silent retry.
5. Compute the result with the published rule and publish it with the request id and the check above.
6. Store the list, fingerprint, tag, request id, output and result together. Everything needed to recheck it later.

Things agents get wrong: changing the list after step 2 (even trimming spaces or sorting), using one answer for two decisions without `{ from }`, and retrying a draw because the result looked odd. Every one of these breaks the guarantee, and the checks above expose it.

## Testing without a network

`NightcastSimulator` runs the real compiled contract in memory, with a clock you control:

```ts
import { NightcastSimulator, generateOracleSecretKey, fromHex } from '@nightcast/contract';
import { listCommitment, pickMany } from '@nightcast/sdk';

const sim = new NightcastSimulator({ oracleSecretKey: generateOracleSecretKey(), operatorSecret: new Uint8Array(32).fill(1) });
const tag = new Uint8Array(32); tag.set(new TextEncoder().encode('raffle #1'));
const id = sim.request(tag, fromHex(listCommitment(names)), BigInt(sim.now + 600));
sim.fulfil(id);                                  // the oracle answers
const winners = pickMany(sim.getLedger().requests.lookup(id).output, names, 3);

sim.advance(700); sim.expire(otherId);           // deadlines and expiry too
```

Outputs from the simulator come from a throwaway key, so they differ from a live deployment's; the logic around them is the same.

## Randomness inside your own contract

A Compact contract can't call the Nightcast contract or read its state today (cross-contract calls aren't available on Preprod or Mainnet yet). A contract that needs randomness in-circuit embeds the same VRF, as Lunardraw's Starfall contract does: [SPEC §5.1](SPEC.md#51-on-chain-consumers-embed-dont-call-decision-22-oct-2026). `dist/nightcast.compact` in `@nightcast/contract` is the reference.

### Many words from one answer: SHA-256 or Poseidon

Once your contract has an answer, it usually needs many random words from it (one per number drawn, say). `dist/NightcastWords.compact` in `@nightcast/contract` is a module you import for that. Copy it next to your contract and:

```compact
import "NightcastWords" prefix Words$;

const w = Words$randomWord(output, 0);           // SHA-256: the default
const p = Words$randomWordPoseidon(output, 0);   // Poseidon: in-circuit only, see below
```

The same words off-chain, from the SDK:

```ts
import { randomWords, randomFieldWords } from '@nightcast/sdk';

randomWords(output, 8);                                  // SHA-256, as randomWord
randomWords(output, 8, { hash: 'poseidon-internal' });   // as randomWordPoseidon
randomFieldWords(output, 8);                             // as randomWordPoseidonField (bigints)
```

**Which to use.** Measured with Compact 0.31.1, one word costs about **9,600 rows** of a circuit with SHA-256 and about **450** with Poseidon. Eight words are k=17 (about 1 GB to prove) with SHA-256 and k=12 with Poseidon. The saving is real, and so are the rules:

| | SHA-256 (`randomWord`) | Poseidon (`randomWordPoseidon`) |
|---|---|---|
| Cost in a circuit | ~9,600 rows a word | ~450 rows a word |
| Anyone can recompute it | Yes, with any SHA-256 tool | Only with Midnight's runtime, same version |
| Stays the same across Midnight upgrades | Guaranteed | Not guaranteed |
| For results you publish | Yes | **No** |
| Uniform bits | All 256 | Bytes 0-15 only (see below) |

Use Poseidon only when **all** of these hold:

1. **It's internal.** The words feed checks or choices inside your own circuits. Anything you publish as the result (the numbers drawn, the winner) can still be worked out by others, but only with Midnight's runtime; if you want anyone to check it with ordinary tools, use SHA-256. The Nightcast output and request stay SHA-256 either way: there's no Poseidon oracle.
2. **Your contract is deployed locked.** Compact says Poseidon (`transientHash`) "is not guaranteed to persist between upgrades" and "should not be used to derive state data". A locked contract's circuits never change, so neither does its hash.
3. **Off-chain code uses the same version.** Recompute with the `@nightcast/contract` (and so `@midnight-ntwrk/compact-runtime`) version your contract was compiled with, and pin it.
4. **You use the right bits.** A Poseidon word is a field element, uniform below `FIELD_SIZE` (about 2^254.9), not 256 random bits. As bytes it is the element little-endian with the top byte dropped: byte 31 is always 0, and byte 30 is about 1% off uniform. **Take numbers from bytes 0-15 only** (the low 128 bits, uniform to within 2^-126), or reduce a field word by rejection against `FIELD_SIZE`.

The two hashes give unrelated words for the same answer and index, so a contract uses one or the other for a decision, never a mix. The off-chain helpers above (`pick`, `shuffle` and the rest) always use SHA-256.

## What Nightcast can't do

- **The oracle can refuse to answer.** It can't choose a result, but it can let a request expire. Deadlines bound that, and expiring is public; plan what an expiry means for you.
- **It's one oracle.** Several oracles, so that any one honest oracle keeps results unpredictable, are on the [roadmap](SPEC.md#6-roadmap).
- **No secrets in the request.** Tag, seed and output are public. Don't put anything private in them.
- **Unaudited.** Testnets only, for now.
