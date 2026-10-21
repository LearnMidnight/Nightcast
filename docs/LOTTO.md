# Midnight Lotto contract: v0 design

Status: design, 22 Oct 2026 (#7). A Midnight 7 + Moonball lottery on Preprod with verifiable draws, using Nightcast's VRF embedded in the contract (SPEC §5.1).

## Choices for v0

| | v0 | Later |
|---|---|---|
| Game | Midnight 7 + Moonball: 7 from 35, plus 1 Moonball from 20 | Other games (Agent 5, Pixel Pick) |
| Entries | Standard lines, 1 to 5 per ticket | Systems, Picks, Moonball Sweep |
| Money | tNIGHT (unshielded), a fixed price per line | Shielded payments once they work on Preprod |
| Prizes | A shared pool: ticket sales plus any rollover, split across all nine divisions; an unwon division rolls over to the next draw | Fixed, organiser-funded jackpot |
| Privacy | Only a commitment to the numbers is stored at purchase; a winner reveals one line when claiming | |
| Who draws | Anyone with the revealed seed, once sales close; the oracle answers | Several oracles (Phase 3) |

Why unshielded: shielded kernel operations (`receiveShielded`, `sendShielded`, `mintShieldedToken`) currently fail on Preprod (open forum reports since April 2026), while `receiveUnshielded` / `sendUnshielded` work. So a purchase shows the buyer's address and how many lines they bought, but not their numbers.

## Draw life cycle

```
open ── sales close ──▶ requested ── oracle ──▶ drawn ── claim window ──▶ settled
  │                         │
  └─ no reveal in time ─────┴─ oracle misses its deadline ──▶ void (refunds)
```

1. **Open.** The organiser opens draw *n* with its sales-close time and `seedCommitment = SHA-256(seedHex)`, exactly as the site publishes today. The organiser is identified by a commitment to a secret, as in Nightcast.
2. **Buy.** Before sales close, a player sends `price × lines` tNIGHT with a ticket commitment and the number of lines. The commitment binds the draw number, every line and a random salt, so it reveals nothing and can't be reused for another draw.
3. **Request.** After sales close, anyone holding the seed calls `requestDraw(n, seed)`. The contract checks the seed against the commitment and fixes the VRF input `alpha = H(contract, n, seed)` and its curve point. From here, nobody can change what the draw will be. The organiser publishes the seed when sales close; if it doesn't by the reveal deadline, the draw is void.
4. **Draw.** The oracle proves `gamma = H·sk` in-circuit before the draw deadline; the contract stores the output and works out the numbers with the site's rule (below).
5. **Claim.** During the claim window, a winner proves one of their lines matches enough numbers, without revealing the others, and names where to pay. Each line can be registered once; the contract counts winners per division.
6. **Settle.** After the window, the pool is split by division shares and each registered line is paid its division's share. Divisions nobody won, and rounding remainders, roll over to the next draw.
7. **Void.** If the seed isn't revealed by the reveal deadline, or the oracle misses the draw deadline, anyone can void the draw. Every ticket is then refunded in full, and any rollover the draw carried goes back to the carry for the next one. **A void draw is never redrawn** (SPEC §4.2).

Neither the organiser (no oracle key) nor the oracle (no seed until sales close) can know the numbers while tickets are on sale. Each can still abort; aborting only triggers refunds.

## Numbers: the site's rule, in the contract

The contract reproduces the Midnight Lotto verification scheme exactly, so the Verification page can check real draws with the code it already has:

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

Ledger: `organiser` (commitment), `oracleKey`/`oracleKeyReady`, `linePrice`, `carry`, `draws: Map<drawId, Draw>`, `tickets: Map<commitment, Ticket>`, `wins: Map<lineId, Win>`.

Circuits:
- `acceptOracleKey()`: the oracle proves it holds the key (as in Nightcast).
- `openDraw(n, salesClose, seedCommitment)`: organiser only.
- `buyTicket(n, commitment, lines)`: before sales close; takes the tNIGHT.
- `requestDraw(n, seed)`: anyone, after sales close and before the reveal deadline.
- `fulfilDraw(n)`: the oracle, before the draw deadline; stores the output.
- `computeNumbers(n)`: anyone; derives and stores the numbers (separate so each circuit stays a manageable size).
- `registerWin(n, line, recipient)`: a ticket holder, during the claim window.
- `settleDraw(n)`: anyone, after the claim window; fixes each division's prize per line and the rollover.
- `payWin(lineId)`: anyone, after settlement; pays the recorded recipient.
- `voidDraw(n)` and `refundTicket(n, recipient)`: the refund path.

Deployed locked like Nightcast (no maintenance authority), with its own published fingerprints.

## Not in v0

Systems, Picks and Sweep; shielded payments; a house share; cancelling an open draw; multiple oracles and oracle bonds (Phase 3).
