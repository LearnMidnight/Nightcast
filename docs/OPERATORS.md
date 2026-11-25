# The Nightcast operator network: the three-operator prototype (November 2026)

> **Superseded.** This describes the first prototype, `network/src/network.compact`: each request named three operators and needed all three answers. It ran on Preprod from 21 to 23 Nov 2026 (with one wallet per operator, 20 of 20 requests answered). Its lessons shaped the threshold network, which replaces it: any *t* of a committee answer, the contract seats the committee, and fewer than half can neither know a value early nor stop one. See **[THRESHOLD.md](THRESHOLD.md)**.

*By Jack Baker, founder of Lunardraw and Nightcast.*

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

## Who can be an operator (next version)

*Decided 20 Nov 2026 (Jack): Cardano stake pool operators required, Midnight block producers preferred. Not in the contract yet.*

More operators is good only if they are really different people. Anyone can register many keys (a Sybil), and whoever holds a fraction `f` of the keys in a draw's pool controls all three of a random group with chance `f³`: 0.1% at 10%, 0.8% at 20%, 3.7% at 33% (about once a month for a daily draw).

- **Requirement: a Cardano stake pool operator.** Every operator key is linked to a registered Cardano pool, one pool per operator. Pools are public, carry real stake, and already run servers around the clock. There are thousands today.
- **Preferred: Midnight block producers.** Midnight is a Cardano partner chain: every Midnight block producer is first a Cardano SPO that also runs a Midnight node. They are chosen more often, or need a smaller bond. They have shown they can run Midnight infrastructure, and it rewards the people securing the chain.
- **Proving the link**, in order of strength:
  1. The pool's key signs "operator key K is mine", and anyone checks it against Cardano's public pool list. The website, the SDK and the community check this, outside the contract. This works today, so it comes first on Preprod.
  2. The contract checks the pool's Ed25519 signature itself, if Compact can verify it in a circuit. This is to be checked.
  3. Midnight's own record of its block producers, if it ever becomes readable by contracts. It isn't today.
- **Other defences:**
  - **Bigger groups for bigger jackpots:** 5 of N instead of 3 turns 0.8% at 20% into 0.03%. The fee is paid per answer, so only the draws worth attacking pay more.
  - **Bonds that grow with what is at stake:** the collateral per request is a share of the jackpot it protects, so many keys tie up a lot of money and a refusal costs more than a re-roll could gain.
  - **Every result names its group,** so a group that keeps answering together is visible.
  - **When the consumer is a contract with a fixed seed** (a Starfall draw: the seed comes from the previous draw), the consumer contract itself can pick the group from that seed and the operator list, because nobody can try other seeds. Free-form requesters still name their own group, as above.

## Paying operators and keepers (next Starfall)

*Simulated 20 Nov 2026 (Lunardraw's notes: `helper-pay-split-sim-20-nov-2026`). This is a starting point; it needs re-running with real server prices and mainnet fees.*

Starfall keeps players' 1.0 a game for prizes and the Treasury's 0.10, and splits the operator's 0.20:

- **0.10 to Lunardraw, 0.04 to the draw's randomness operators, 0.06 to the keepers who carry the draw through.** Keepers settle, pay out and pay most of the fees, so they get more than operators, about 60:40.
- **A minimum per draw for the helpers, taken from Lunardraw's share first:** about 150 NIGHT at US$0.05. Servers are a fixed cost (about US$7 a day keeps 7 operators and 3 keepers running), so no per-game share works at low sales.
  - Below about 750 games a draw, the helpers take all 0.20.
  - Above about 1,500, the plain split applies.
- With this split the network pays outside helpers from about 1,500 games a day at NIGHT US$0.05:
  - about 4,300 at US$0.02;
  - about 770 at US$0.10;
  - about 600 if operators are stake pools on machines they already run.
- Keepers are paid only for steps that move a draw forward, so nobody gains by triggering cheap steps early.

## Towards a shared standard

A Midnight Improvement Proposal would standardise:
- the circuits and ledger fields above;
- the share and combination domains (`nightcast:output:v0`, `nightcast:network:v1`);
- an operator profile format (name, contact, the stake pool it runs, signed by the pool's key once Compact can check that signature);
- the refund rules.

Then any randomness provider can offer the same interface and apps can switch between them. The running test network is the evidence for that proposal.
