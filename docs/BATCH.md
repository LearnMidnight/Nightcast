# Batches: many random numbers from one request

> **Status:** stage 1 of [#98](https://github.com/LearnMidnight/Nightcast/issues/98). The SDK pieces below are built and tested in the simulator. The batch service, the oracle's fast-answer publishing and the certificate pages come next. Experimental and unaudited.

A Nightcast request costs two transactions and about a minute. Batches let one request serve everyone who asked within a few seconds. Each person still gets their own number, which nobody could work out in advance, with a receipt anyone can check. The v1 contract is unchanged: a batch is an ordinary `request`.

## How a number is made

Everyone who asks within a few seconds is one **entry** in a Merkle tree:

```
commit = SHA-256("nightcast:batch:salt:v1" ‖ salt)            the salt: 32 random bytes kept by whoever asked
leaf   = SHA-256("nightcast:batch:leaf:v1" ‖ client ‖ ref ‖ commit)
node   = SHA-256("nightcast:batch:node:v1" ‖ left ‖ right)     the last entry of an odd level moves up unchanged
seed   = SHA-256("nightcast:batch:root:v1" ‖ size (8 bytes, big-endian) ‖ top)
```

The labels are UTF-8, padded with zeros to 32 bytes, as the contract's `pad(32, ...)` does.

- `client` is the app that asked (`clientId(name)`).
- `ref` is the app's own name for what the number is for, such as a game round (`refId(name)`). An app accepts one entry per `ref`, so nobody can ask again until they like the answer.

The batch service sends `request(BATCH_TAG, seed, deadline)`, where `BATCH_TAG` is `"nightcast:batch:v1"`. Once the request's output is known:

```
value = SHA-256("nightcast:batch:value:v1" ‖ output ‖ leaf ‖ salt)
```

Turn `value` into dice, picks or shuffles with the SDK's usual helpers (`uniformInt`, `pickNumbers`, ...).

## The fast answer

Once the request is on chain, its output is fixed: `gamma = sk · H`, where `H` is the point `request` stored and `sk` is the oracle's key, and `output` is `evaluateAt`'s hash of `gamma`. So the oracle can send `gamma` straight away (`fastAnswer(sk, H)`), with a Chaum–Pedersen proof that the same `sk` links its on-chain key and `gamma`. That is the proof inside ECVRF (RFC 9381).

- The proof is two points and a scalar, with a nonce derived from the key and the point.
- `checkFastAnswer(key, H, gamma, proof)` also refuses points outside Jubjub's prime-order subgroup.
- The oracle's later `fulfil` gives the same output. `checkReceiptOnChain` confirms it once it lands.

## Receipts

`makeReceipt` produces JSON with these parts:
- the deployment and the batch service's requester commitment;
- the oracle key;
- the batch's size and request id;
- the entry (index, client, ref, commit, Merkle path) and, once shown, its salt;
- `gamma` and its proof.

| Check | What it shows |
|---|---|
| `checkReceipt(receipt)` (offline) | The entry is in the batch, and the batch is the request's seed. The answer is the only one the oracle's key could give for that request. With the salt, it also gives the number. |
| `checkReceiptOnChain(receipt, chain)` | The request is on chain, bound to that key at that point. Once it has been answered, the output is the same. |

## Who can cheat

- **The batch service** can refuse an entry, but it can't change a number.
- **The oracle** has no choice over an answer. It can withhold one: the request then expires and its fee and collateral are refunded.
- **The salt** means that neither of them, even working together, can work out a person's number in advance.
- **Two cases remain.** Someone colluding with both could steer their own number, and the oracle can withhold an answer. The threshold network removes both.
- **A salt of 32 zero bytes** (`PUBLIC_SALT`) is allowed for numbers anyone may compute. It gives up the protection above.

## Using it

```ts
import { sealBatch, clientId, refId, newSalt, commitOf, BATCH_TAG, fastAnswer, makeReceipt, checkReceipt } from '@nightcast/sdk';

// The person's side (or the app's server): keep the salt.
const salt = newSalt();
const entry = { client: clientId('my-raffle'), ref: refId('draw 42 / ticket 7'), commit: commitOf(salt) };

// The batch service: seal everyone, request with the seed.
const batch = sealBatch(entries);
// ... request(BATCH_TAG, batch.seed, deadline) on chain; read the request's point H

// The oracle: the fast answer.
const answer = fastAnswer(oracleSecretKey, H);

// The receipt, and anyone's check.
const receipt = makeReceipt({ contract, requester, oracleKey, size: batch.size, requestId, index, entry, path: batch.pathOf(index), answer, salt });
const { ok, value } = checkReceipt(receipt);
```
