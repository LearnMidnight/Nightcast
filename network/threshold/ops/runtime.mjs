// A wallet session for sending the threshold contract's calls, with what the Preprod test taught
// (24 to 27 Nov 2026): fees paid with several DUST coins, largest first; a call waits for DUST
// rather than failing; each proof and transaction is timed and reported; a transaction the node
// refuses is saved; and a watchdog ends the process with code 75 when the wallet loses the network
// (no sign of life for `stall` minutes, a wallet still behind the chain after waiting a minute for it,
// a sync that hasn't moved on for `openWait` minutes, or DUST coins booked for hours by transactions
// that can no longer land), so whatever supervises it starts it again. Everything that uses it
// re-reads the chain before acting, so starting again is always safe.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState, unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { filter, firstValueFrom } from 'rxjs';
import { STALE_DUST_BOOKING_MS, TX_TTL_SECONDS, blockfrostProjectId, connect, walletBalances } from '@nightcast/deploy';
import { errorText, ledgerOf, say, sleep, succeeded, tn, withChain } from './common.mjs';
import { describeTx, dustText, txText } from './threshold.mjs';
import { bookingWatch, restartForBookings, syncMark } from './wallet-watch.mjs';

/** The contract's ledger as the indexer shows it now, without a wallet. */
export const readContract = async ({ network = 'preprod', proofServerPort, proofServerUrl, address }) => {
  const session = await connect(network, { proofServerPort, proofServerUrl, projectId: blockfrostProjectId(network), waitForBlockfrost: true });
  try {
    const r = await indexerPublicDataProvider(session.config.indexer, session.config.indexerWS).queryContractState(address);
    if (!r) throw new Error(`the indexer shows no contract at ${address}`);
    return ledgerOf((r.contractState ?? r).deserialize({ v9: ContractState }));
  } finally {
    await session.shutdown().catch(() => undefined);
  }
};

/** The process's exit code for "stalled: start me again". */
export const STALLED = 75;
const stop = (why) => { say(why); process.exit(STALLED); };

/**
 * Open the wallet and run `f(rt)`. Options: network, proofServerPort (or proofServerUrl), walletFile, address (the contract), log (a
 * JSON-lines file for every call), saveDir (where refused transactions are kept), dustSpends (3), dustWait (120
 * minutes), stall (10 minutes), openWait (30 minutes: the sync not moving on for that long while the wallet opens), lead (60 s), leadLink (240 s), proofContainer (a docker name,
 * for the proof server's memory), handlePrefix (private state ids), proofLock (a file: several processes on one machine
 * sharing one proof server make their proofs one at a time, as one proof can take 5 GB; NIGHTCAST_PROOF_LOCK).
 */
export const openRuntime = async (opts, f) => {
  const {
    network = 'preprod', proofServerPort, proofServerUrl, walletFile, address, log: logFile, saveDir, dustSpends = 3, dustWait = 120, stall = 10,
    openWait = 30, lead = 60, leadLink = 240, proofContainer, handlePrefix = 'tnet', proofLock = process.env.NIGHTCAST_PROOF_LOCK,
  } = opts;
  const log = (row) => {
    if (!logFile) return;
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify(row) + '\n');
  };
  // Signs of life: every look at the chain or the wallet that came back, and every proof asked for or made.
  let lastSign = Date.now();
  const alive = () => { lastSign = Date.now(); };
  const stallMs = Math.max(3, Number(stall) || 10) * 60_000;
  // How many DUST coins pay each fee (the patched dust wallet reads this each time it balances a transaction).
  let wantSpends;
  const setSpends = (n) => {
    wantSpends = Math.max(1, Math.min(4, Math.floor(Number(n)) || 1));
    if (wantSpends > 1) process.env.NIGHTCAST_DUST_MIN_SPENDS = String(wantSpends);
    else delete process.env.NIGHTCAST_DUST_MIN_SPENDS;
  };
  setSpends(dustSpends);
  // Before the wallet is open it catches up with the chain, which can also stall for good after a lost connection. A
  // first sync can take over an hour (27 Nov 2026: about 75 minutes for each of the team's five), so what counts is
  // whether it is still moving on, not how long it has taken.
  const openWaitMs = Math.max(5, Number(openWait) || 30) * 60_000;
  let moved = Date.now(), mark, following;
  const opening = setInterval(() => {
    if (Date.now() - moved < openWaitMs) return;
    stop(`stalled: the wallet's sync hasn't moved on in ${Math.round(openWaitMs / 60_000)} minutes. Stopping, to be started again`);
  }, 30_000);
  const onWallet = (w) => {
    following = w.wallet.state().subscribe((s) => {
      const m = syncMark(s);
      if (m !== mark) { mark = m; moved = Date.now(); }
    });
  };
  const opened = () => { clearInterval(opening); following?.unsubscribe(); };
  try {
    return await withChain({ network, proofServerPort, proofServerUrl, walletFile, address, onWallet }, async ({ session, wallet, providers, read: readChain, readState, handle, me, meBytes }) => {
      opened();
      alive();
      const watchdog = setInterval(() => {
        if (Date.now() - lastSign < stallMs) return;
        stop(`stalled: no sign of life for ${Math.round(stallMs / 60_000)} minutes (the wallet has probably lost the network). Stopping, to be started again: it goes on from what the chain shows`);
      }, 30_000);
      watchdog.unref();
      const read = async (...a) => { const l = await readChain(...a); alive(); return l; };
      // Look at each transaction as it is sent.
      let lastTx, lastHandle;
      const sender = providers.midnightProvider;
      providers.midnightProvider = new Proxy(sender, {
        get: (t, k) => {
          const v = t[k];
          if (typeof v !== 'function') return v;
          if (k !== 'submitTx') return v.bind(t);
          return async (tx, ...rest) => { lastHandle = tx; lastTx = describeTx(tx); alive(); try { return await v.call(t, tx, ...rest); } finally { alive(); } };
        },
      });
      const syncedState = () => firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
      // Coins booked by a transaction that can no longer land stay booked until the wallet is opened again (wallet-watch.mjs).
      const bookings = bookingWatch(STALE_DUST_BOOKING_MS);
      /** The wallet's NIGHT UTXOs (and how many generate DUST) and its DUST coins: free to pay with, and booked by a transaction that hasn't landed. */
      const coinsNow = async () => {
        const pending = (await syncedState()).dust.pendingCoins ?? [];
        bookings.note(pending);
        const c = { ...(await walletBalances(wallet)), booked: pending.length };
        alive();
        return c;
      };
      /** Start again (code 75) when coins booked for hours are all that keep the wallet from paying a fee: opening it frees them. */
      const freeStuckCoins = (c) => {
        const stale = bookings.stale();
        if (!restartForBookings(c, wantSpends, stale)) return;
        stop(`${stale} DUST coin${stale === 1 ? ' has' : 's have'} been booked for over ${Math.round(STALE_DUST_BOOKING_MS / 3_600_000)} hours by transactions that can no longer land, and the wallet frees them when it opens: stopping, to be started again`);
      };
      /** Between duties: the same check, so stuck coins are freed before a fee is needed. A wallet not in step just now is
       * left alone (looked at again on the next pass): waiting on it here would hold up reading the chain. */
      const checkCoins = async () => {
        const c = await Promise.race([coinsNow(), sleep(30_000).then(() => undefined)]).catch(() => undefined);
        if (c) freeStuckCoins(c);
      };
      const coinsText = (c) => `${tn(c.night)} in ${c.nightUtxos} NIGHT UTXO${c.nightUtxos === 1 ? '' : 's'} (${c.nightRegistered} generating DUST); ${dustText(c.dust)} DUST in ${c.dustCoins} coin${c.dustCoins === 1 ? '' : 's'} free to pay with${c.booked ? `, ${c.booked} more booked by transactions that haven't landed` : ''}`;
      /** Register NIGHT that doesn't generate DUST yet (change, or NIGHT that has just arrived). */
      const registerNew = async () => {
        const raw = unshieldedToken().raw, ks = wallet.unshieldedKeystore;
        const coins = (await syncedState()).unshielded.availableCoins.filter((x) => x.utxo.type === raw && x.meta.registeredForDustGeneration === false);
        if (!coins.length) return;
        const recipe = await wallet.wallet.registerNightUtxosForDustGeneration(coins, ks.getPublicKey(), (payload) => ks.signDataAsync(payload));
        const txId = await wallet.wallet.submitTransaction(await wallet.wallet.finalizeRecipe(recipe));
        say(`${coins.length} NIGHT UTXO${coins.length === 1 ? '' : 's'} registered to generate DUST, transaction ${txId}`);
      };
      /** Wait until `ok(coins)`, looking every 10 s. */
      const coinsUntil = async (ok, what, ms) => {
        const until = Date.now() + ms;
        for (;;) {
          const c = await coinsNow();
          if (ok(c)) return c;
          if (Date.now() > until) throw new Error(`${what} (the wallet: ${coinsText(c)})`);
          await sleep(10_000);
        }
      };
      /** Split the wallet's NIGHT so it has `n` DUST coins to pay fees with (a transfer to itself, then registration). */
      const makeCoins = async (n) => {
        let c = await coinsNow();
        if (c.dustCoins >= n) { say(`the wallet has ${c.dustCoins} DUST coins free: nothing to make`); return c; }
        const w = wallet.wallet, ks = wallet.unshieldedKeystore, raw = unshieldedToken().raw;
        // A registered NIGHT UTXO has one DUST coin. Coins booked by a transaction that didn't land can stay booked
        // for hours, so UTXOs are made for n coins besides those.
        const utxos = Math.min(8, n + c.booked);
        if (c.nightUtxos < utxos) {
          const make = utxos - c.nightUtxos, each = c.night / BigInt(utxos);
          if (each < 1_000_000n) throw new Error(`too little NIGHT to split into ${utxos}: ${tn(c.night)}`);
          const to = MidnightBech32m.parse(me).decode(UnshieldedAddress, session.config.walletNetworkId);
          const recipe = await w.transferTransaction([{ type: 'unshielded', outputs: Array.from({ length: make }, () => ({ amount: each, receiverAddress: to, type: raw })) }], { ttl: new Date(Date.now() + TX_TTL_SECONDS * 1000) });
          const signed = await w.signRecipe(recipe, (payload) => ks.signDataAsync(payload));
          const txId = await w.submitTransaction(await w.finalizeRecipe(signed));
          say(`the wallet's NIGHT is being split: ${make} part${make === 1 ? '' : 's'} of ${tn(each)} sent to its own address, transaction ${txId}`);
          c = await coinsUntil((x) => x.nightUtxos >= utxos, `the split didn't show within 10 minutes`, 10 * 60_000);
        }
        if (c.nightRegistered < c.nightUtxos) await registerNew();
        return coinsUntil((x) => x.dustCoins >= n, `the new DUST coins didn't show within 15 minutes`, 15 * 60_000);
      };
      /** Send `amount` of NIGHT (in its millionths) to a wallet address (mn_addr_...). Returns the transaction id. */
      const sendNight = async (toAddress, amount) => {
        const w = wallet.wallet, ks = wallet.unshieldedKeystore, raw = unshieldedToken().raw;
        let to;
        try { to = MidnightBech32m.parse(toAddress).decode(UnshieldedAddress, session.config.walletNetworkId); } catch (e) { throw new Error(`${toAddress} isn't a wallet address on this network: ${errorText(e).slice(0, 200)}`); }
        const recipe = await w.transferTransaction([{ type: 'unshielded', outputs: [{ amount, receiverAddress: to, type: raw }] }], { ttl: new Date(Date.now() + TX_TTL_SECONDS * 1000) });
        const signed = await w.signRecipe(recipe, (payload) => ks.signDataAsync(payload));
        const txId = await w.submitTransaction(await w.finalizeRecipe(signed));
        alive();
        return txId;
      };
      // About what the next fee takes, in specks: a quarter more than the last one paid. Until one has been, 1.2 DUST.
      let needDust = 1_200_000_000_000_000n;
      const dustWaitMs = Math.max(1, Number(dustWait) || 120) * 60_000;
      /** Before a call: the coins its fee is to be paid with are free, and the wallet holds about a fee's worth of DUST. */
      const coinsReady = async (what) => {
        const started = Date.now();
        let told = 0, registered = 0;
        for (;;) {
          const c = await coinsNow();
          const enoughCoins = wantSpends < 2 || c.dustCoins >= wantSpends;
          if (enoughCoins && c.dust >= needDust) return;
          if (!enoughCoins) freeStuckCoins(c);
          const waited = Date.now() - started;
          if (!enoughCoins && waited > 5 * 60_000) throw new Error(`${what} isn't sent: after 5 minutes the wallet still has fewer than ${wantSpends} DUST coins free (${coinsText(c)}). Make more with the coins action, or pay with fewer`);
          if (waited > dustWaitMs) throw new Error(`${what} isn't sent: after ${Math.round(dustWaitMs / 60_000)} minutes the wallet still has too little DUST (${coinsText(c)}; a fee takes about ${dustText(needDust)}). It needs more NIGHT, or more time`);
          if (enoughCoins && Date.now() - told > 5 * 60_000) {
            say(`waiting for DUST before ${what}: the wallet has ${dustText(c.dust)} and a fee takes about ${dustText(needDust)} (DUST builds up from the wallet's ${tn(c.night)})`);
            told = Date.now();
          }
          if (c.nightRegistered < c.nightUtxos && Date.now() - registered > 5 * 60_000) {
            registered = Date.now();
            await registerNew().catch((e) => say(`registering new NIGHT for DUST failed (trying again later): ${errorText(e).slice(0, 200)}`));
          }
          await sleep(15_000);
        }
      };
      /** One proof at a time among the processes sharing proofLock: taken by writing our pid; one left by a process that ended, or held over 15 minutes, is taken over. */
      const lockedProof = async (f) => {
        if (!proofLock) return f();
        let told = false;
        for (;;) {
          try { writeFileSync(proofLock, `${process.pid}\n`, { flag: 'wx' }); break; } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let stale = false;
            try {
              const pid = Number(readFileSync(proofLock, 'utf8').trim());
              try { process.kill(pid, 0); } catch { stale = true; }
              if (Date.now() - statSync(proofLock).mtimeMs > 15 * 60_000) stale = true;
            } catch { stale = true; }
            if (stale) { try { unlinkSync(proofLock); } catch { /* taken meanwhile */ } continue; }
            if (!told) { say('waiting for another operator\'s proof to finish (they share the proof server)'); told = true; }
            alive();
            await sleep(2_000);
          }
        }
        try { return await f(); } finally { try { if (readFileSync(proofLock, 'utf8').trim() === String(process.pid)) unlinkSync(proofLock); } catch { /* gone */ } }
      };
      // Time the proof server's part of each call.
      let proving = 0;
      const prover = providers.proofProvider;
      providers.proofProvider = new Proxy(prover, {
        get: (t, k) => {
          const v = t[k];
          if (typeof v !== 'function') return v;
          return (...a) => lockedProof(async () => { const s = Date.now(); alive(); try { return await v.apply(t, a); } finally { proving += Date.now() - s; alive(); } });
        },
      });
      const l0 = await read();
      if (BigInt(Math.max(lead, leadLink)) >= l0.slack) throw new Error(`a lead of ${Math.max(lead, leadLink)} s is not inside the contract's slack of ${l0.slack} s`);
      /** A time `lead` seconds ahead: proofs are made before sending, so a stamped time is set a little in the future. */
      const stamp = (s = lead) => BigInt(Math.floor(Date.now() / 1000) + s);
      const anyone = () => handle(`${handlePrefix}-anyone`, { answerSecs: l0.answerSecs });
      /** Wait until the indexer shows what a transaction did. */
      const shown = async (ok, what, ms = 180_000) => {
        const until = Date.now() + ms;
        for (;;) {
          if (ok(await read())) return;
          if (Date.now() > until) throw new Error(`the chain did not show ${what} within ${ms / 1000} s`);
          await sleep(5_000);
        }
      };
      /** Wait until a time (ms), asking the wallet for its coins each minute so a wallet that has gone quiet stalls the run. */
      const waitUntil = async (due) => {
        while (Date.now() < due) { coinsNow().catch(() => {}); await sleep(Math.min(60_000, due - Date.now())); }
      };
      /** The proof server container's memory in MiB now, or undefined. */
      const memoryNow = () => new Promise((done) => {
        if (!proofContainer) return done(undefined);
        execFile('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', proofContainer], { timeout: 10_000 }, (err, out) => {
          const m = /^\s*([\d.]+)\s*(KiB|MiB|GiB|B)/.exec(String(out ?? ''));
          if (err || !m) return done(undefined);
          done(Math.round(Number(m[1]) * { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]));
        });
      });
      /** One call: up to three tries when it fails for a reason that can pass; a contract assertion is final. */
      const call = async (what, circuit, send) => {
        for (let i = 1; ; i++) {
          proving = 0;
          const started = Date.now();
          let peak;
          let sampling = false;
          const sampler = setInterval(async () => {
            if (sampling) return;
            sampling = true;
            const m = await memoryNow();
            if (m !== undefined && (peak === undefined || m > peak)) peak = m;
            sampling = false;
          }, 5_000);
          const memory = () => (peak === undefined ? '' : `, proof server up to ${(peak / 1024).toFixed(1)} GiB`);
          lastTx = undefined;
          lastHandle = undefined;
          try {
            await coinsReady(what);
            const r = succeeded(await send(), what);
            clearInterval(sampler);
            const row = { time: new Date().toISOString(), what, circuit, ok: true, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, peakProofServerMiB: peak, txId: r.public?.txId, tx: lastTx };
            log(row);
            say(`ok   ${what}: proof ${row.provingSeconds} s, ${row.totalSeconds} s in all${memory()}${i > 1 ? ` (try ${i})` : ''}, transaction ${row.txId}${txText(lastTx)}`);
            if (lastTx?.feeSpecks) needDust = (BigInt(lastTx.feeSpecks) * 5n) / 4n;
            return r;
          } catch (e) {
            clearInterval(sampler);
            const text = errorText(e);
            // A transaction the node refused: keep it, for whoever looks into why.
            let saved;
            if (saveDir && lastHandle && /1010|Invalid Transaction|time to dismiss|Custom error/i.test(text)) {
              try {
                saved = join(saveDir, `refused-${circuit}-${new Date().toISOString().replace(/[:.]/g, '-')}.tx`);
                writeFileSync(saved, `${Buffer.from(lastHandle.serialize()).toString('hex')}\n`);
                writeFileSync(`${saved}.json`, `${JSON.stringify({ what, circuit, error: text, tx: lastTx, dustSpendsWanted: wantSpends }, null, 2)}\n`);
              } catch (err) { saved = undefined; say(`the refused transaction couldn't be saved: ${errorText(err).slice(0, 200)}`); }
            }
            log({ time: new Date().toISOString(), what, circuit, ok: false, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, peakProofServerMiB: peak, error: text, tx: lastTx, saved });
            if (saved) say(`the refused transaction is saved: ${saved} (and .json)`);
            say(`FAIL ${what} (try ${i}; proof ${Math.round(proving / 1000)} s, ${Math.round((Date.now() - started) / 1000)} s in all${memory()}): ${text}${txText(lastTx)}`);
            // A wallet a block or two behind the chain usually catches up within a minute (28 Nov 2026: each time a restart
            // followed, the call went through just after it). Still behind after that: start again (the watchdog's code).
            if (/Wallet\.Sync|DustTreesNotAtBlock|No Dust spend can be dated/i.test(text)) {
              if (i >= 2) stop('the wallet is still behind the chain: stopping, to be started again with a fresh view of it');
              say('the wallet is behind the chain: waiting a minute for it to catch up, then trying again');
              await sleep(60_000);
              continue;
            }
            // A proof server that failed is not asked again at once: it may have run out of memory. A transaction
            // over its time allowance would be built the same way again, and each try books DUST coins.
            if (i >= 3 || /failed assert|assertion failed|Proof Server request failed|isn't sent|time to dismiss|Custom error: 231/i.test(text)) throw e;
            // Out of DUST: the next try waits until the wallet holds more than it was thought to need.
            if (/insufficient\s*funds|could not balance dust/i.test(text)) {
              const have = (await coinsNow()).dust;
              const floor = needDust > have ? needDust : have;
              needDust = (floor * 3n) / 2n;
            }
            await sleep(20_000);
          }
        }
      };
      return await f({
        session, wallet, providers, handle, anyone, readState, me, meBytes, l0, read, shown, waitUntil, call, stamp, lead, leadLink, alive,
        coinsNow, coinsText, coinsUntil, makeCoins, registerNew, sendNight, checkCoins,
        setSpends, spends: () => wantSpends, address,
      });
    });
  } finally {
    opened();
  }
};
