// What an operator should send next, worked out from the contract's ledger alone: so a process
// that stops and starts again picks up exactly where the chain is, and so this can be tested
// without a chain. Nothing here talks to the chain or holds a secret.
import { T, hex } from './common.mjs';
import { cellKeyOf, positionOf, seatKeyOf, shareKeyOf } from './threshold.mjs';

/**
 * The committee the contract would open with i independents and h active house operators (see
 * openEpoch in threshold-net.compact), or undefined when it would open none.
 */
export const committeeFor = (i, h) => {
  const mine7 = Math.min(i, 7), mine3 = Math.min(i, 3);
  const house7 = Math.min(h, 7 - mine7), house5 = Math.min(h, 5 - mine3);
  if (i >= 4 && mine7 + house7 >= 6) return { n: mine7 + house7, t: 4 };
  if (i >= 1 && i <= 3 && mine3 + house5 >= 4) return { n: mine3 + house5, t: 3 };
  if (i <= 2 && h >= 1) return { n: 1, t: 1 };
  return undefined;
};

/** How long before a deadline a call is still worth sending: its proof and its landing take a minute or two. */
export const MARGIN = 120n;

/**
 * Everything this operator could send now, most urgent first. Each is { key, what, circuit, keeper, ... }:
 * `key` names it (for backing off one that failed), `keeper` is true for the duties anyone may do.
 *
 * Its own duties: answer a request for one of its seats (paid if before the deadline; after it, still
 * useful while the request has no value yet), deal in a ceremony it is seated in, claim what it has
 * earned. Keeper duties: finish a ceremony, fill a seat, finalise a request with enough answers,
 * settle one past its deadline, open the next epoch, stand down an operator below the minimum bond.
 */
export const duties = (l, { id, now, claimAt = 1_000_000n, keeper = true }) => {
  const out = [];
  const mine = hex(id);
  const registered = l.operators.member(id);
  const seatOf = new Map(); // epoch -> this operator's position (0: none)
  const positionIn = (e) => { if (!seatOf.has(e)) seatOf.set(e, l.committees.member(e) ? positionOf(l, e, id) : 0); return seatOf.get(e); };
  const servedBy = (e) => { const p = l.committees.member(e) ? l.committees.lookup(e).phase : undefined; return p === T.Phase.serving; };

  // ---- its own: answers first, they have deadlines measured in minutes
  for (const [rid, q] of l.requests) {
    const i = positionIn(q.epoch);
    if (!i || l.shares.member(shareKeyOf(q.number, i))) continue;
    // A committee is "serving" once its ceremony ended well, and stays so after the next one takes over.
    if (!servedBy(q.epoch)) continue;
    const inTime = q.deadline > now + MARGIN;
    if (inTime || q.status === T.Status.pending) out.push({ key: `answer:${hex(rid)}`, what: `answer request ${q.number} (position ${i} of epoch ${q.epoch})${inTime ? '' : ', late: it still helps the value be worked out'}`, circuit: 'answer', rid, epoch: q.epoch, position: i, urgent: inTime });
  }
  // Late answers after the timely ones.
  out.sort((a, b) => Number(b.urgent) - Number(a.urgent));

  // ---- its own: dealing in the newest ceremony
  if (l.opened > 0n) {
    const e = l.opened;
    const c = l.committees.lookup(e);
    const d = positionIn(e);
    if (d && c.phase === T.Phase.dealing && c.dealBy > now + MARGIN) {
      if (!l.committed.member(seatKeyOf(e, d))) out.push({ key: `deal:${e}:commit`, what: `dealCommit (position ${d} of epoch ${e})`, circuit: 'dealCommit', epoch: e, position: d, t: Number(c.t) });
      else {
        for (let i = 1; i <= Number(c.n); i++) {
          if (l.parcels.member(cellKeyOf(e, d, i))) continue;
          out.push({ key: `deal:${e}:${i}`, what: `dealShare to position ${i} (position ${d} of epoch ${e})`, circuit: 'dealShare', epoch: e, position: d, to: i, t: Number(c.t) });
          break; // one at a time: the next is worked out again from the chain
        }
      }
    }
  }

  // ---- its own: collect what it has earned
  const owed = registered && l.earned.member(id) ? l.earned.lookup(id) : 0n;
  if (owed > 0n && owed >= claimAt) out.push({ key: 'claim', what: 'claim what it has earned', circuit: 'claim', amount: owed });

  if (!keeper) return out;

  // ---- keeper: the ceremony
  if (l.opened > 0n && l.opened !== l.current) {
    const e = l.opened;
    const c = l.committees.lookup(e);
    if (c.phase === T.Phase.dealing && c.dealt === c.n) out.push({ key: `finish:${e}`, what: `finish epoch ${e}'s ceremony (every dealer has finished)`, circuit: 'finish', keeper: true, epoch: e });
    else if ((c.phase === T.Phase.dealing || c.phase === T.Phase.seating) && now >= c.dealBy + 60n) out.push({ key: `finish:${e}`, what: `finish epoch ${e}'s ceremony (its deadline has passed)`, circuit: 'finish', keeper: true, epoch: e });
    else if (c.phase === T.Phase.seating && c.dealBy > now + MARGIN) out.push({ key: `seat:${e}:${c.seated + 1n}`, what: `seat ${c.seated + 1n} of ${c.n} in epoch ${e}`, circuit: 'seat', keeper: true, epoch: e });
  }

  // ---- keeper: requests
  for (const [rid, q] of l.requests) {
    const c = l.committees.member(q.epoch) ? l.committees.lookup(q.epoch) : undefined;
    if (!c) continue;
    if (q.status === T.Status.pending) {
      const have = [];
      for (let i = 1; i <= Number(c.n); i++) if (l.shares.member(shareKeyOf(q.number, i))) have.push(i);
      if (have.length >= Number(c.t)) out.push({ key: `finalise:${hex(rid)}`, what: `finalise request ${q.number} (${have.length} answers in, ${c.t} needed)`, circuit: 'finalise', keeper: true, rid, positions: have.slice(0, Number(c.t)) });
    }
    if (!q.settled && now >= q.deadline + 60n) out.push({ key: `settle:${hex(rid)}`, what: `settle request ${q.number} (its deadline has passed)`, circuit: 'settle', keeper: true, rid });
  }

  // ---- keeper: the next epoch
  const failed = l.opened !== l.current && l.committees.lookup(l.opened).phase === T.Phase.failed;
  const over = l.opened === l.current && (l.current === 0n || now >= l.committees.lookup(l.current).since + l.epochSecs + 60n);
  if ((failed || over) && committeeFor(Number(l.independents), Number(l.houseActive))) {
    out.push({ key: `open:${l.opened + 1n}`, what: `open epoch ${l.opened + 1n}${failed ? ` (epoch ${l.opened}'s ceremony failed)` : l.current === 0n ? '' : ` (epoch ${l.current} has served its length)`}`, circuit: 'openEpoch', keeper: true });
  }

  // ---- keeper: an operator below the minimum bond (not while a committee is being seated)
  const seating = l.opened !== l.current && l.committees.lookup(l.opened).phase === T.Phase.seating;
  if (!seating) {
    for (const [oid, o] of l.operators) {
      if (!o.active || hex(oid) === mine) continue;
      if (l.bonds.lookup(oid).read() < l.minBondSlots) out.push({ key: `standdown:${hex(oid)}`, what: `stand down ${hex(oid).slice(0, 12)} (bond below the minimum)`, circuit: 'standDown', keeper: true, operator: oid });
    }
  }
  return out;
};
