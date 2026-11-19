# The Nightcast operator network (draft, November 2026)

*Status: a design with a working contract and a test on Preprod. Experimental and unaudited. Testnets only.*

## The problem

Nightcast v1 has one oracle per deployment. Its answer is a VRF output: for one key and one request there is exactly one valid value, and the network checks the proof, so the oracle can't choose an answer. But whoever holds the key can **compute** the answer before anyone else, and can **withhold** it. When the same party also makes the requests (as Lunardraw does for LunaSpin), it could try seeds in private until one gives the result it wants, and nothing on chain would show it.

No single key holder should be able to know the result early, and one operator going offline shouldn't stop everything.

## The design

Anyone can join as an **operator** by registering a key and putting up a bond. Each request names a **group of three** operators. Each one answers with its own VRF share, and the random value combines all three. As long as one of the three is honest and keeps its key secret, nobody can know the value before that operator answers, and nobody can choose it.

It's a new contract (`network/src/network.compact`) beside Nightcast v1, with no change to Midnight itself.

### Operators

- `register(payout, slots)`: the caller proves it holds the secret of a Jubjub key (which rules out the identity point and keys nobody can use), names a payout address, and pays in a bond of `slots × collateralPerRequest`. The first registration needs at least `minBondSlots`. An operator is identified by `keyIdOf(key)`.
- `depositBond(keyId, slots)`: anyone can add to an operator's bond.
- `withdrawBond(slots, leave)`: an operator takes free slots back to its payout, and with `leave` stops being named in new requests. Requests already made still expect its share. It can rejoin later with `register`.

### Requests

- `request(tag, seed, deadline, refundTo, group)`: as in v1 (the id is `requestId(contract, requester, tag, seed)`, the deadline more than `minWindow` and at most `maxWindow` ahead), plus the three operators.
  - The contract checks they are different, registered, active, and each has a free bond slot. It takes one slot from each, and the caller pays `3 × operatorFee`.
- **Who picks the group:** the requester. The contract can't pick in a way a requester couldn't steer: a requester can try seeds until any rule (rotation, a hash of the id) picks the group it wants. So the group is part of the public request, and consumers show it (LunaSpin's certificate would name the three operators).

### Answers

- `answer(id)`: one of the three proves its share
  `share = SHA-256("nightcast:output:v0" ‖ H · sk)`, which is exactly Nightcast v1's output for that key, with the secret as a private witness.
  - It is paid its `operatorFee` and gets its slot back at once.
- `finalise(id)`: once all three shares are in, anyone records
  `output = SHA-256("nightcast:network:v1" ‖ id ‖ share₁ ‖ share₂ ‖ share₃)`, in the order the request named them.
  - `randomWord(output, i)` expands it as in v1, so the SDK's picking helpers work unchanged.
- `expire(id)`: after the deadline without all three shares, anyone marks the request void.
  - The fee and collateral of each operator that didn't answer go to the request's refund address.
  - Operators that did answer keep what they were paid.

### Money in one line

An operator that answers in time earns its fee. One that doesn't loses the collateral it put behind that request, to the requester. An operator can't give a wrong answer, because the proof forbids it. The only way to misbehave is to stay silent, and that costs money.

## Limits, honestly

- **All three colluding** can know the value early. Consumers should pick groups of operators that are independent of each other and of themselves, and show which ones answered.
- **The last to answer sees the result first**: it can compute the output from the other two shares. It can't change it. It can refuse, which voids the request and costs it the fee and its collateral; a void request can be redrawn, so a costly re-roll is possible. Consumers count re-draws, as LunaSpin already does. A commit-then-reveal round would close this, at the cost of an extra transaction per operator.
- **Liveness:** one silent operator voids the request. A threshold scheme (any 2 of 3) would not void, but plain VRF shares can't be combined that way without letting late operators choose which subset counts. That needs threshold cryptography (Nightcast #10).
- **Same-block requests:** on ledger 9 a transaction is held to the costs it declared when built. Adding to the request map after another transaction changed it can be refused ("ran out of gas budget"); the sender sends it again. Answers to the same request in one block don't clash (checked in memory).

## Checked so far

- `network/check/run.sh`: 46 in-memory checks with Compact 0.36 and the ledger 9 runtime. They cover registering, bonds, leaving and rejoining, groups, shares equal to v1's VRF, the combined output, payments, expiry and refunds, the books balancing after every step, and replaying calls made in the same block with Ledger 9's own transcript partitioning.
- `network/ops/deploy.mjs offline`: the locked deploy builds as a ledger 9 transaction with exactly the 7 circuits, using 0.371 of a block.

## The Preprod test

Five operators, three per request, run on one machine (`network/vm/net.sh`, its own proof server on 6304, nothing shared with LunaSpin or Starfall). It proves the mechanics, not independence: all five keys are Lunardraw's. What it measures:

- time from request to all three shares to the random value;
- how often requests clash or need a second try;
- what happens when an operator is paused (its requests go void and are refunded from its bond; the others carry on);
- an operator leaving, and a sixth joining.

## Towards a shared standard

A Midnight Improvement Proposal would standardise:
- the circuits and ledger fields above;
- the share and combination domains (`nightcast:output:v0`, `nightcast:network:v1`);
- an operator profile format (name, contact, the stake pool it runs, signed by the pool's key once Compact can check that signature);
- the refund rules.

Then any randomness provider can offer the same interface and apps can switch between them. The running test network is the evidence for that proposal.
