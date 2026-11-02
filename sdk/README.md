# @nightcast/sdk

Fair, checkable randomness for apps and AI agents on [Midnight](https://midnight.network), from [Nightcast](https://github.com/LearnMidnight/Nightcast).

You ask Nightcast for randomness, an oracle answers, and the Midnight network only accepts the one answer the oracle's key can give for that request: the oracle can't pick a result, only fail to answer. This package turns that answer into the choice you need.

> **Experimental and unaudited.** Use it on testnets (Preprod, Preview). Don't secure real value with it yet.

```bash
npm install @nightcast/sdk @nightcast/contract
```

```ts
import { pick, pickMany, shuffle, rollDice, weightedPick, randomInt, listCommitment } from '@nightcast/sdk';

// `output` is the request's answer: 32 bytes, or 64 hex characters
const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella'];

pick(output, names);                                    // one winner
pickMany(output, names, 3);                             // three different winners, in draw order
shuffle(output, names);                                 // everyone, in a fair random order
rollDice(output, 2, 6);                                 // two six-sided dice
randomInt(output, 1, 100);                              // a whole number from 1 to 100
weightedPick(output, { gold: 1, silver: 3, bronze: 6 }); // bronze 6 times in 10
```

Every helper is deterministic: the same answer and the same list always give the same result, so anyone can check it. No modulo bias, no repeats in `pickMany`.

**For a fair draw, fix the list first.** Make the request with `listCommitment(names)` as its seed and publish the list, so nobody can change the list after seeing the answer. The [guide](https://github.com/LearnMidnight/Nightcast/blob/main/docs/GUIDE.md#a-fair-raffle) walks through it.

## Also in the package

| | |
|---|---|
| `NightcastOracle`, `SimulatorChain`, `MidnightChain` | The oracle service and its chain adapters, for running an oracle |
| `randomWords`, `uniformInt` | The building blocks: independent words from one answer, and an unbiased number from a word |
| `pickNumbers`, `drawStarfall`, `combineDrawSeed` | Lottery draws (the rule [Lunardraw](https://github.com/LearnMidnight/Lunardraw) uses) |
| `nightcast-keygen` | Command to generate oracle, operator and requester secrets |

## Links

- [Developer guide](https://github.com/LearnMidnight/Nightcast/blob/main/docs/GUIDE.md): requesting, verifying, fair raffles, AI agents, embedding in a contract
- [Specification and threat model](https://github.com/LearnMidnight/Nightcast/blob/main/docs/SPEC.md)
- [Live deployments](https://github.com/LearnMidnight/Nightcast#live-deployment)

MIT licence.
