# Lunardraw contract: v0 design

Status: design, 22 Oct 2026 (#7). A Starfall lottery (7 from 35 + Moonball) on Preprod with verifiable draws, using Nightcast's VRF embedded in the contract (SPEC §5.1).

## Choices for v0

| | v0 | Later |
|---|---|---|
| Game | Starfall: 7 from 35, plus 1 Moonball from 20 | Other games (Agent 5, Pixel Pick) |
| Entries | Standard lines, 1 to 5 per ticket | Systems, Picks, Moonball Sweep |
| Money | tNIGHT (unshielded), a fixed price per line | Shielded payments once they work on Preprod |
| Prizes | A shared pool: ticket sales plus any rollover, split across all nine divisions; an unwon division rolls over to the next draw | Fixed, organiser-funded jackpot |
| Privacy | Only a commitment to the numbers is stored at purchase; a winner reveals one line when claiming | |
| Who draws | The organiser (in practice a keeper bot) reveals its sealed seed once sales close; the oracle answers | Several oracles (Phase 3) |
| Draws | Numbered 1, 2, 3, …; one sells at a time, and revealing a draw's seed opens the next, so draws roll on weekly; a sales period between set limits | Draws sold ahead |

Why unshielded: shielded kernel operations (`receiveShielded`, `sendShielded`, `mintShieldedToken`) currently fail on Preprod (open forum reports since April 2026), while `receiveUnshielded` / `sendUnshielded` work. So a purchase shows the buyer's address and how many lines they bought, but not their numbers.

## Draw life cycle

```
open ── sales close ──▶ requested ── oracle ──▶ drawn ── claim window ──▶ settled
  │                         │
  └─ no reveal in time ─────┴─ oracle misses its deadline ──▶ void (refunds)
```

1. **Open.** The organiser opens the next draw with its sales-close time and `seedCommitment = SHA-256(seedHex)`, exactly as the site publishes today. The organiser is identified by a commitment to a secret, as in Nightcast. Only one draw sells at a time. Normally the next draw opens in the same transaction that reveals the previous draw's seed (step 3); the organiser opens one directly only for the first draw, or after a draw that wasn't followed by one. The sales period must be between the contract's minimum and maximum (set at deployment), counted from when the draw opens, and a seed commitment can never be used twice.
2. **Buy.** Before sales close, a player sends `price × lines` tNIGHT with a ticket commitment and the number of lines. The commitment binds the draw number, every line and a random salt, so it reveals nothing and can't be reused for another draw.
3. **Request.** After sales close, the organiser calls `requestDraw(n, seed)`. The contract checks the seed against the commitment and fixes the VRF input `alpha = H(contract, n, seed)` and its curve point. From here, nobody can change what the draw will be. In the same transaction the organiser can open the next draw, giving its sales-close time and seed commitment, so closing one draw starts the next. If the organiser doesn't reveal by the reveal deadline, the draw is void.

   Only the organiser may do this. Compact doesn't guarantee that in-circuit `hashToCurve` has a single valid output (SPEC §2). The organiser can't evaluate the VRF, so that freedom is useless to it; the oracle could use it to pick an outcome. (Issue #7 originally said "anyone can trigger the request"; the security review changed this.)
4. **Draw.** The oracle proves `gamma = H·sk` in-circuit before the draw deadline; the contract stores the output. Then anyone runs `computeNumbers`, which works out the numbers with the site's rule (below). The claim window starts then, so a late computation never shortens it.
5. **Claim.** During the claim window, a winner proves one of their lines matches enough numbers, without revealing the others, and names where to pay. Each line can be registered once; the contract counts winners per division.
6. **Settle.** After the window, the pool is split by division shares and each registered line is paid its division's share. Draws settle in order: a draw can settle only once the one before it is settled or void, and then all the rollover so far joins its pool. Divisions nobody won, and rounding remainders, roll over to the next draw that settles. So the rollover always goes to the next draw in line, and nobody can steer it into a draw of their choosing.
7. **Void.** If the seed isn't revealed by the reveal deadline, the oracle misses the draw deadline, or nobody computes the numbers before the deadline for that, anyone can void the draw. Computing and voiding are never possible at the same moment, so nobody can choose between "finish the draw" and "cancel it" once the outcome is public. Every ticket is then refunded in full; the rollover isn't touched and goes to the next draw that settles. **A void draw is never redrawn** (SPEC §4.2).

Neither the organiser (no oracle key) nor the oracle (no seed until sales close) can know the numbers while tickets are on sale. Each can still abort; aborting only triggers refunds.

## Why a sealed seed, not the entries (decision, 22 Oct 2026)

The self-running plan suggested using the entries at sales close as the VRF input, so no organiser would be needed. That isn't safe: the oracle can evaluate the VRF on any input, so an oracle that also buys tickets could try many versions of its own last ticket (a different salt each time), work out the numbers each would lead to, and buy the one that wins. Nobody could detect it.

With a seed sealed before sales open, nothing a player does changes the VRF input, and the oracle never learns the seed until sales close. The organiser role is run by the **keeper bot**, which holds the organiser secret and a fresh random seed for each draw. Once sales close it reveals the seed and opens the next draw (step 3), so the draws keep rolling without anyone at the keyboard. The keeper must keep each seed until its draw is revealed: losing one voids that draw (refunds), and the next draw can then be opened directly. Every other step (`computeNumbers`, `settleDraw`, `payWin`, `voidDraw`, refunds) can be sent by anyone, the keeper included.

## Numbers: the site's rule, in the contract

The contract reproduces the Lunardraw verification scheme exactly, so the Verification page can check real draws with the code it already has:

- `drawSeed = SHA-256(seedHex + ":" + outputHex)` (the SDK's `combineDrawSeed`);
- main numbers: for i = 0, 1, …: `d = SHA-256(drawSeedHex + ":" + i)`, read 2 bytes at a time, skip `v ≥ 65536 − (65536 mod 35)`, `n = v mod 35 + 1`, skip repeats, stop at 7, sort;
- Moonball: the same on `drawSeedHex + ":mb"`, 1 from 20 (it may repeat a main number).

Test vector: a draw seed of 64 zeros gives 6 7 13 23 26 31 35 + Moonball 14.

Compact has no `/` or `%`, so the circuit takes each quotient as a witness and checks `v = 35·q + r` with `r < 35`. It converts bytes to hex with checked nibble splits. Three SHA-256 blocks of candidates for the main numbers (48 candidates) are always enough in practice (the chance of fewer than 7 distinct values is far below 10⁻²⁰); if they weren't, the draw would fail to settle, time out and be refunded.

## Prize divisions

| Division | Match | Share of the pool |
|---|---|---|
| 1 | 7 + Moonball | 30% |
| 2 | 7 | 7% |
| 3 | 6 + Moonball | 5.6% |
| 4 | 6 | 5.6% |
| 5 | 5 + Moonball | 6.3% |
| 6 | 4 + Moonball | 7% |
| 7 | 5 | 7% |
| 8 | 3 + Moonball | 14% |
| 9 | 2 + Moonball | 17.5% |

Divisions 2–9 keep the site's relative shares (10/8/8/9/10/10/20/25), scaled to the 70% left after the 30% jackpot share. In v0 the whole of each draw's sales goes to the pool (no house share). Each division's share is split evenly between its winning lines.

## What's public, what's private

- **Public:** draw times, the seed commitment and (after sales close) the seed, the VRF output and numbers, each purchase's buyer address, line count and commitment, each claim's division and payout address, and all payouts.
- **Private:** the numbers on a ticket, unless its owner claims a line, which reveals that one line's division (not its numbers) and links it to the purchase.
- A ticket's preimage (lines and salt) lives only in the buyer's private state. Losing it means losing the ability to claim or be refunded.

## Contract outline

Ledger: `organiser` (commitment), `oracleKey`/`oracleKeyReady`/`proposedOracleKey`, `linePrice`, sales limits and windows, `carry`, `lastDraw`, `draws: Map<drawId, Draw>`, `drawLines: Map<drawId, Counter>`, `winnerCounts: Map<drawId·16+division, Counter>`, `tickets: Map<commitment, Ticket>`, `wins: Map<lineId, Win>`, `usedCommitments: Set`.

Purchases and claims only add to counters and insert new entries, so many can land in the same block without conflicting; the `Draw` record changes only when the draw moves to its next stage.

Circuits:
- `acceptOracleKey()`: the oracle proves it holds the key (as in Nightcast); `proposeOracleKey(key)`: the organiser proposes a replacement.
- `openDraw(salesClose, seedCommitment)`: organiser only, for the first draw or after a draw that wasn't followed by one; returns the new draw's number.
- `buyTicket(n, commitment, lines)`: before sales close; takes the tNIGHT.
- `requestDraw(n, seed, next)`: organiser only, after sales close and before the reveal deadline; `next` (optional) opens the next draw in the same transaction.
- `fulfilDraw(n)`: the oracle, before the draw deadline; stores the output.
- `computeNumbers(n, now)`: anyone; derives and stores the numbers and starts the claim window (`now` must be within 10 minutes of block time). It's separate because it's the biggest circuit by far (about 145 MB of proving key).
- `registerWin(n, line, recipient)`: a ticket holder, during the claim window.
- `settleDraw(n)`: anyone, after the claim window and once draw n − 1 is settled or void; fixes each division's prize per line and the rollover.
- `payWin(lineId)`: anyone, after settlement; pays the recorded recipient.
- `voidDraw(n)` and `refundTicket(n, recipient)`: the refund path.

Deployed locked like Nightcast (no maintenance authority), with its own published fingerprints.

## Trust that remains (v0)

From the security review (22 Oct 2026). The contract can't fix these by itself:

- **The oracle sees the output first and can stay silent.** The draw is then void and refunded. If the oracle or a friend holds tickets, that's a free option to skip draws it doesn't like. Mitigation: an independent oracle, a public record of its missed draws, and deposits it loses for missing one (Phase 3, #9).
- **An organiser and oracle working together know the numbers during sales.** Keep them independent: the keeper bot (organiser) and the oracle should run on separate machines, under separate people, with separate keys.
- **Only the keeper opens new draws.** If it stops, the current draw voids and is refunded, and no new draw opens until someone with the organiser secret starts it again.
- **A lost ticket preimage can't be refunded**, and nothing sweeps the money. Players (and agents) must back up their private state.
- **A claim reveals which line of the ticket won** and the running winner counts per division.

## Not in v0

Systems, Picks and Sweep; shielded payments; a house share; cancelling an open draw; multiple oracles and oracle bonds (Phase 3).
