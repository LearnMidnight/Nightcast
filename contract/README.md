# @nightcast/contract

The [Nightcast](https://github.com/LearnMidnight/Nightcast) verifiable randomness contract for [Midnight](https://midnight.network): the compiled Compact contract with its proving and verifier keys, key helpers, and an in-memory simulator for tests.

> **Experimental and unaudited.** Use it on testnets (Preprod, Preview). Don't secure real value with it yet.

```bash
npm install @nightcast/contract
```

Most apps want [`@nightcast/sdk`](https://www.npmjs.com/package/@nightcast/sdk) too, which turns an answer into picks, shuffles, dice and draws.

## What's in it

| | |
|---|---|
| `Contract`, `ledger`, `pureCircuits`, `Status` | The compiled contract (`dist/managed/nightcast`), for midnight-js (`findDeployedContract`, `queryContractState`) |
| `pureCircuits.requestId`, `randomWord`, `evaluate`, `publicKey` | Recompute a request's id, expand an answer into words, check an output against a key |
| `witnesses`, `NightcastPrivateState` | The private state the circuits read (requester, oracle and operator secrets) |
| `generateOracleSecretKey`, `oraclePublicKey`, `fromHex`, `toHex`, … | Key and hex helpers |
| `NightcastSimulator` | Runs the contract in memory with a controllable clock: request, fulfil, expire, without a network |
| `dist/nightcast.compact` | The contract's source, for reading or for embedding its VRF in your own contract |

```ts
import { NightcastSimulator, generateOracleSecretKey } from '@nightcast/contract';

const sim = new NightcastSimulator({ oracleSecretKey: generateOracleSecretKey(), operatorSecret: new Uint8Array(32).fill(1) });
const id = sim.request(tag, seed, BigInt(sim.now + 600)); // tag, seed: 32 bytes each
sim.fulfil(id);
const { output } = sim.getLedger().requests.lookup(id);
```

## Links

- [Developer guide](https://github.com/LearnMidnight/Nightcast/blob/main/docs/GUIDE.md)
- [Specification and threat model](https://github.com/LearnMidnight/Nightcast/blob/main/docs/SPEC.md)
- [Live deployments and their verifier-key fingerprints](https://github.com/LearnMidnight/Nightcast#live-deployment)

Built with Compact toolchain 0.31.1. MIT licence.
