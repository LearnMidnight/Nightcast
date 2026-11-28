#!/usr/bin/env node
/**
 * A Nightcast threshold-network operator: one operator key and one wallet, kept in one folder.
 *
 *   node network/threshold/ops/operator.mjs init [--key <operator key file>] [--wallet <wallet file>]
 *       Make the folder: a new operator key and a new wallet (or ones you bring), and the settings.
 *       Prints the operator's id and the wallet's address to send tNIGHT to. Never overwrites.
 *   ... status                  what the chain shows about this operator (no wallet needed)
 *   ... wallet                  the wallet's NIGHT and DUST
 *   ... register [--slots <n>]  join with n slots of bond (the minimum and 2 more by default); again after leaving
 *   ... link --pool-key <file>  a test stake pool's key signs for this operator, and the link is sent
 *   ... link --pool <key>       for a real pool: prints the 32 bytes its key is to sign (saved for the next step)
 *   ... link --signature <hex>  sends that link with the pool's signature (64 bytes)
 *   ... send --to <address> --amount <tNIGHT>   send tNIGHT from this operator's wallet
 *   ... topup --slots <n>       add bond
 *   ... claim                   collect what the operator has earned (to its payout address: this wallet)
 *   ... withdraw --slots <n> | --all   take bond back to the payout address
 *   ... leave                   stop being seated in new committees (a seat held keeps its duties)
 *   ... run [--no-keeper] [--every 60] [--claim-at 1]
 *       Keep going, doing its duties as the chain shows them, until stopped: its own (answer
 *       every request for its seats, deal in its ceremonies, claim what it earns once it is
 *       --claim-at tNIGHT or more) and, unless --no-keeper, the ones anyone may send to keep the
 *       network moving (open the next epoch, seat, finish, finalise, settle, stand down), each
 *       after a random wait of up to 90 s so keepers seldom send the same one. Run it under
 *       something that starts it again when it ends with code 75 (Docker's restart, systemd).
 *
 * Every command takes [--home <folder>] (NIGHTCAST_OPERATOR_HOME, else ~/.nightcast-operator).
 * init also takes [--network preprod] [--contract <address>] (the repository's deployment record
 * by default) and [--proof-server-port 6300]; they are kept in <home>/config.json.
 *
 * The folder holds operator.secret and wallet.secret (mode 600: anyone with them can act as this
 * operator and spend its bond's payouts) and the epochs' polynomials once it deals. Nothing here
 * prints a secret. One process at a time uses the folder (<home>/.lock).
 *
 * Calls are sent the way the Preprod test found works (network/threshold/ops/runtime.mjs): each fee
 * is paid with 3 DUST coins, largest first, and a call waits for DUST rather than failing. A
 * process that loses the network ends with code 75, to be started again.
 */
import { homeOf } from './operator-env.mjs';
import { spawnSync } from 'node:child_process';
import { createPublicKey, randomInt, verify, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ecMulGenerator, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { walletAddressOf } from '@nightcast/deploy';
import {
  BUILD, ROOT, T, ed25519Point, errorText, fromHex, hex, newOperatorFile, night, operatorFrom, poolIdOf, poolSign, poolSignatureFrom, readJson, readRecord, say, tn,
  sleep, walletSeedFrom, writeSecret,
} from './common.mjs';
import { cellKeyOf, clock, phaseName, polynomialFor, positionOf, priorOf, seatKeyOf, shareKeyOf, shareOf, short } from './threshold.mjs';
import { duties } from './duties.mjs';
import { openRuntime, readContract } from './runtime.mjs';
import { checkAgainstChain, readRelease } from './bundle.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' }, network: { type: 'string' }, contract: { type: 'string' }, 'proof-server-port': { type: 'string' }, 'proof-server-url': { type: 'string' },
    key: { type: 'string' }, wallet: { type: 'string' }, slots: { type: 'string' }, all: { type: 'boolean' },
    pool: { type: 'string' }, 'pool-key': { type: 'string' }, signature: { type: 'string' }, 'valid-hours': { type: 'string', default: '24' },
    'dust-spends': { type: 'string', default: '3' }, 'dust-wait': { type: 'string', default: '120' },
    to: { type: 'string' }, amount: { type: 'string' },
    'no-keeper': { type: 'boolean' }, every: { type: 'string', default: '60' }, 'claim-at': { type: 'string', default: '1' },
  },
});
const command = positionals[0];
const home = homeOf();
const files = {
  key: join(home, 'operator.secret'), wallet: join(home, 'wallet.secret'), config: join(home, 'config.json'),
  lock: join(home, '.lock'), link: join(home, 'link-request.json'), log: join(home, 'calls.jsonl'),
};
const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));
const plural = (n, word) => `${n} ${word}${BigInt(n) === 1n ? '' : 's'}`;

// ------------------------------------------------------------------ the folder
const setUp = () => existsSync(files.key) && existsSync(files.wallet) && existsSync(files.config);
const load = () => {
  if (!setUp()) throw new Error(`${home} isn't an operator's folder yet: run init first`);
  const config = readJson(files.config);
  // The proof server: NIGHTCAST_PROOF_SERVER_URL (Docker's), else the settings' URL, else its port on this machine.
  config.proofServerUrl = process.env.NIGHTCAST_PROOF_SERVER_URL ?? config.proofServerUrl;
  if (config.proofServerUrl) delete config.proofServerPort;
  const key = operatorFrom(files.key);
  const seed = walletSeedFrom(files.wallet);
  return { config, key, seed, address: walletAddressOf(config.network, seed) };
};
const isHouse = (l, id) => [...l.house].some((x) => hex(x) === hex(id));

/**
 * One process at a time uses the folder (two would spend the same DUST coins). The lock names its process and
 * machine (a container is a machine here: every one's process can be number 1) and is touched every 30 s, so one
 * left by a process that has ended is known: same machine and the process is gone, or untouched for 3 minutes.
 */
const lock = () => {
  const me = `${process.pid} ${hostname()}`;
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(files.lock, `${me}\n`, { flag: 'wx' });
      const touch = setInterval(() => { try { const t = new Date(); utimesSync(files.lock, t, t); } catch { /* gone */ } }, 30_000);
      touch.unref();
      process.on('exit', () => { try { if (readFileSync(files.lock, 'utf8').trim() === me) unlinkSync(files.lock); } catch { /* gone already */ } });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const [pid, host] = readFileSync(files.lock, 'utf8').trim().split(' ');
      const fresh = Date.now() - statSync(files.lock).mtimeMs < 3 * 60_000;
      let running = fresh;
      if (fresh && host === hostname()) { try { process.kill(Number(pid), 0); running = Number(pid) !== process.pid; } catch { running = false; } }
      if (running) throw new Error(`another process (${pid} on ${host}) is using ${home}: wait for it to finish, or stop it`);
      unlinkSync(files.lock); // left by a process that has ended
    }
  }
  throw new Error(`couldn't take ${files.lock}`);
};

/**
 * The several-DUST-spends option needs the patch npm ci adds to the dust wallet. The patch
 * script reports on stderr, so both streams are read (reading only stdout saw nothing and
 * refused a wallet that had the option: found when the team first ran on the VM, 27 Nov).
 */
export const dustPatchVerdict = (status, stdout, stderr) => {
  const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
  if (status !== 0) return `the dust wallet installed here isn't the one Nightcast's fee option was written for: ${out}`;
  if (!/already there|added to/.test(out)) return `the fee option isn't installed in the dust wallet (run npm ci at the top of the repository): ${out}`;
  return null;
};
const dustPatchInstalled = () => {
  const repo = resolve(ROOT, '..', '..');
  const r = spawnSync(process.execPath, [join(repo, 'deploy', 'scripts', 'patch-dust-two-spends.mjs'), '--check'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const problem = r.error ? `couldn't run the fee option's check: ${r.error.message}` : dustPatchVerdict(r.status, r.stdout, r.stderr);
  if (problem) throw new Error(problem);
};

/** The wallet open, as runtime.mjs gives it, plus this operator's contract handle. */
const withOperator = async (f) => {
  const op = load();
  lock();
  if (Number(values['dust-spends']) > 1) dustPatchInstalled();
  say(`operator ${hex(op.key.id)}, wallet ${op.address}`);
  // Proofs made with keys that aren't the contract's would only be refused, each after its fee is booked.
  const circuits = await checkAgainstChain(BUILD, { network: op.config.network, contract: op.config.contract, proofServerPort: op.config.proofServerPort, proofServerUrl: op.config.proofServerUrl });
  say(`the compiled contract here is the one on chain (all ${circuits} circuits' verifier keys match)`);
  say('opening the wallet (the first time, catching up with the chain can take a while)');
  return openRuntime({
    network: op.config.network, proofServerPort: op.config.proofServerPort, proofServerUrl: op.config.proofServerUrl, walletFile: files.wallet, address: op.config.contract, log: files.log, saveDir: home,
    dustSpends: values['dust-spends'], dustWait: values['dust-wait'], handlePrefix: `op-${short(op.key.id)}`,
  }, async (rt) => {
    const mine = () => rt.handle(`op-${short(op.key.id)}`, { operatorSecret: op.key.secret, answerSecs: rt.l0.answerSecs });
    /** Before a first call: enough DUST coins to pay each fee with (a new wallet has one per NIGHT UTXO). */
    const coinsFirst = async () => {
      const c = await rt.coinsNow();
      if (c.dustCoins + c.booked >= rt.spends()) return;
      say(`each fee is paid with ${rt.spends()} DUST coins and the wallet has ${c.dustCoins}: splitting its NIGHT to make more`);
      say(`the wallet now: ${rt.coinsText(await rt.makeCoins(rt.spends()))}`);
    };
    return f({ ...rt, op, mine, coinsFirst });
  });
};

// ------------------------------------------------------------------ init
const init = () => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!existsSync(files.key)) {
    if (values.key) {
      const k = operatorFrom(values.key);
      writeSecret(files.key, readJson(values.key));
      say(`operator key brought from ${values.key} (${k.name ?? 'unnamed'})`);
    } else {
      newOperatorFile(files.key, 'operator');
      say(`new operator key made: ${files.key}`);
    }
  } else say(`there is an operator key already: ${files.key}`);
  if (!existsSync(files.wallet)) {
    const seed = values.wallet ? walletSeedFrom(values.wallet) : hex(webcrypto.getRandomValues(new Uint8Array(32)));
    writeSecret(files.wallet, { role: 'wallet', seed });
    say(values.wallet ? `wallet brought from ${values.wallet}` : `new wallet made: ${files.wallet}`);
  } else say(`there is a wallet already: ${files.wallet}`);
  if (!existsSync(files.config)) {
    const network = values.network ?? 'preprod';
    // The contract: the one this repository's release names, else (where it was deployed from) the deployment record.
    let contract = values.contract;
    if (!contract) { try { contract = readRelease(network).contract; } catch { contract = readRecord(network).contractAddress; } }
    const prover = values['proof-server-url'] ? { proofServerUrl: values['proof-server-url'] } : { proofServerPort: Number(values['proof-server-port'] ?? 6300) };
    writeFileSync(files.config, `${JSON.stringify({ network, contract, ...prover }, null, 2)}\n`);
    say(`settings kept in ${files.config}`);
  } else say(`there are settings already: ${files.config}`);
  const op = load();
  say('');
  say(`operator id:     ${hex(op.key.id)}`);
  say(`wallet address:  ${op.address}`);
  say(`network:         ${op.config.network}, contract ${op.config.contract}`);
  say('');
  say(`Keep ${home} private and backed up: the two .secret files are this operator.`);
  say(`Next: send tNIGHT to the wallet address (the bond, about 12 tNIGHT on this test contract, and about 100 more to make DUST for fees), then: register`);
};

// ------------------------------------------------------------------ status
const status = async () => {
  const op = load();
  const l = await readContract({ network: op.config.network, proofServerPort: op.config.proofServerPort, proofServerUrl: op.config.proofServerUrl, address: op.config.contract });
  const id = op.key.id;
  say(`contract ${op.config.contract} (${op.config.network})`);
  say(`operator ${hex(id)}${isHouse(l, id) ? ': one of the house\'s operators' : ''}`);
  say(`wallet   ${op.address}`);
  if (!l.operators.member(id)) {
    say(`not registered. The bond is at least ${plural(l.minBondSlots, 'slot')} of ${tn(l.collateralPerSlot)}: register`);
    return;
  }
  const o = l.operators.lookup(id);
  const bond = l.bonds.lookup(id).read();
  say(`${o.active ? 'active' : `left at ${clock(o.leftTime)}`}; bond ${plural(bond, 'slot')} (${tn(bond * l.collateralPerSlot)}; the minimum is ${l.minBondSlots})`);
  if (!o.house) {
    if (l.poolOf.member(id)) say(`backed by the stake pool at place ${l.listed.lookup(l.poolOf.lookup(id))} of the list${o.active ? ', so it takes its turn in the ring' : ''}`);
    else say('no stake pool backs it yet, so it isn\'t seated: link');
  }
  const owed = l.earned.member(id) ? l.earned.lookup(id) : 0n;
  say(`earned and not yet claimed: ${tn(owed)}`);
  const epochs = l.opened !== l.current ? [l.current, l.opened] : [l.current];
  for (const e of epochs.filter((x) => x > 0n)) {
    const c = l.committees.lookup(e);
    const i = positionOf(l, e, id);
    const role = e === l.current ? 'serving' : `newest (${phaseName(c.phase)})`;
    if (!i) { say(`epoch ${e} (${role}, ${c.t} of ${c.n}): no seat`); continue; }
    const sk = seatKeyOf(e, i);
    const misses = l.missed.member(sk) ? Number(l.missed.lookup(sk)) : 0;
    let line = `epoch ${e} (${role}, ${c.t} of ${c.n}): position ${i}`;
    if (c.phase === T.Phase.dealing) line += `; ${l.committed.member(sk) ? 'commitments sent' : 'commitments not sent'}, ${l.finished.member(sk) ? 'finished dealing' : `dealing until ${clock(c.dealBy)}`}`;
    if (c.phase === T.Phase.serving) line += `; ${l.finished.member(sk) ? 'it dealt' : 'it didn\'t finish dealing'}; missed ${plural(misses, 'answering time')} (${l.allowedMisses} allowed)`;
    say(line);
    if (c.phase === T.Phase.serving) {
      let open = 0;
      for (const [, q] of l.requests) if (q.epoch === e && q.status === T.Status.pending && !l.shares.member(shareKeyOf(q.number, i)) && q.deadline > nowSecs()) open++;
      if (open) say(`  ${plural(open, 'request')} waiting for this seat's answer`);
    }
  }
};

// ------------------------------------------------------------------ the chain's rules, said before a proof is made for nothing
const sittingOut = (l, o) => !o.house && o.leftTime + 2n * l.epochSecs > nowSecs();
const seatingNow = (l) => l.opened !== l.current && l.committees.lookup(l.opened).phase === T.Phase.seating;

const register = () => withOperator(async ({ op, mine, read, call, shown, coinsNow, coinsText, coinsFirst, meBytes }) => {
  const id = op.key.id;
  const l = await read();
  const known = l.operators.member(id);
  const o = known ? l.operators.lookup(id) : undefined;
  if (o?.active) { say('already registered and active'); return; }
  if (o && sittingOut(l, o)) throw new Error(`an operator that left sits out two epoch lengths: it can register again after ${clock(o.leftTime + 2n * l.epochSecs)}`);
  const bond = known ? l.bonds.lookup(id).read() : 0n;
  const missing = bond < l.minBondSlots ? l.minBondSlots - bond : 0n;
  const slots = values.slots !== undefined ? BigInt(values.slots) : known ? missing : l.minBondSlots + 2n;
  if (bond + slots < l.minBondSlots) throw new Error(`the bond would be ${plural(bond + slots, 'slot')}; the minimum is ${l.minBondSlots}`);
  const c = await coinsNow();
  if (c.night < slots * l.collateralPerSlot) throw new Error(`the bond is ${tn(slots * l.collateralPerSlot)} and the wallet has ${coinsText(c)}: send more tNIGHT to ${op.address}`);
  await coinsFirst();
  const prior = l.poolOf.member(id) ? priorOf(l, l.listed.lookup(l.poolOf.lookup(id))) : 0n;
  await call(`register${known ? ' again' : ''} with ${plural(slots, 'slot')} of bond (${tn(slots * l.collateralPerSlot)})`, 'register', async () => (await mine()).callTx.register({ bytes: meBytes }, slots, prior));
  await shown((x) => x.operators.member(id) && x.operators.lookup(id).active, 'the registration');
  const la = await read();
  say(`registered: bond ${plural(la.bonds.lookup(id).read(), 'slot')}; fees and bond come back to ${op.address}`);
  if (isHouse(la, id)) say('one of the house\'s operators: it fills the seats independents can\'t');
  else if (!la.poolOf.member(id)) say('Next: link a stake pool to it (link --pool <its key>), so it takes its turn');
});

/** A pool's 32-byte Ed25519 public key: hex, cardano-cli's CBOR hex (5820...), or a .vkey file. */
const poolKeyOf = (arg) => {
  let text = String(arg).trim();
  if (existsSync(text)) {
    const body = readFileSync(text, 'utf8');
    try { text = JSON.parse(body).cborHex ?? body; } catch { text = body; }
  }
  text = text.trim().replace(/^0x/, '');
  if (/^5820[0-9a-f]{64}$/i.test(text)) text = text.slice(4);
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('a pool key is 32 bytes: 64 hex characters, or a .vkey file');
  ed25519Point(fromHex(text)); // throws if it isn't a key
  return text.toLowerCase();
};
const goodSignature = (pub, message, sig) => {
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub, 'hex').toString('base64url') } });
  return verify(null, Buffer.from(message), key, Buffer.from(sig));
};
/** Why this operator can't be linked to that pool now, said before a 100-second proof, or nothing. */
const linkProblem = (l, id, pid) => {
  if (!l.operators.member(id)) return 'register first';
  const o = l.operators.lookup(id);
  if (!o.active) return 'the operator has left: register again first';
  if (o.house) return 'the house\'s operators need no pool';
  if (l.poolOf.member(id)) return 'a pool backs this operator already';
  if (!l.listed.member(pid)) return 'that key isn\'t on this contract\'s list of stake pools';
  return undefined;
};

const link = async () => {
  if (values.pool && !values.signature) {
    // A real pool: what its key is to sign. Nothing is sent.
    const op = load();
    const pub = poolKeyOf(values.pool);
    const pid = poolIdOf(pub);
    const l = await readContract({ network: op.config.network, proofServerPort: op.config.proofServerPort, proofServerUrl: op.config.proofServerUrl, address: op.config.contract });
    const problem = linkProblem(l, op.key.id, pid);
    if (problem) throw new Error(problem);
    const count = l.poolLinks.member(pid) ? l.poolLinks.lookup(pid) : 0n;
    const until = nowSecs() + BigInt(Math.round(Number(values['valid-hours']) * 3600));
    const message = T.pureCircuits.linkMessageOf({ bytes: encodeContractAddress(op.config.contract) }, op.key.id, count, false, until);
    writeFileSync(files.link, `${JSON.stringify({ pool: pub, count: count.toString(), until: until.toString(), message: hex(message) }, null, 2)}\n`);
    say(`the stake pool at place ${l.listed.lookup(pid)} of the list is to sign these 32 bytes with its key:`);
    say('');
    say(`  ${hex(message)}`);
    say('');
    say(`They name this contract, this operator and the pool's ${count === 0n ? 'first link' : `link number ${count + 1n}`}, and the signature is good until ${clock(until)}.`);
    say(`Sign them as raw bytes (hex) with the pool's Ed25519 key, then: link --signature <the 64-byte signature, in hex>`);
    return;
  }
  if (!values.signature && !values['pool-key']) throw new Error('link takes --pool <key> (a real pool: what to sign), --signature <hex> (then), or --pool-key <file> (a test pool)');
  let pending;
  if (values.signature) {
    if (!existsSync(files.link)) throw new Error('no link is waiting for a signature: link --pool <key> first');
    pending = readJson(files.link);
    const sig = fromHex(values.signature.trim());
    if (sig.length !== 64) throw new Error(`an Ed25519 signature is 64 bytes (128 hex characters), not ${sig.length}`);
    if (!goodSignature(pending.pool, fromHex(pending.message), sig)) throw new Error(`that isn't the pool's signature over ${pending.message} (check it was made with the key ${pending.pool}, over those bytes as hex)`);
    if (BigInt(pending.until) < nowSecs() + 600n) throw new Error('the signature runs out within 10 minutes: link --pool again for a new message');
    pending.sig = sig;
  }
  await withOperator(async ({ op, mine, read, call, shown, stamp, leadLink, coinsFirst }) => {
    const id = op.key.id;
    const pub = pending ? pending.pool : readJson(values['pool-key']).public;
    const pid = poolIdOf(pub);
    const l = await read();
    const problem = linkProblem(l, id, pid);
    if (problem) throw new Error(problem);
    const count = l.poolLinks.member(pid) ? l.poolLinks.lookup(pid) : 0n;
    if (pending && BigInt(pending.count) !== count) throw new Error('the pool has been linked or unlinked since that message was made: link --pool again for a new one');
    const place = l.listed.lookup(pid);
    await coinsFirst();
    await call(`linkPool: the pool at place ${place} backs this operator`, 'linkPool', async () => {
      const until = pending ? BigInt(pending.until) : stamp(leadLink) + 86_400n;
      const sig = pending
        ? poolSignatureFrom(pending.sig)
        : poolSign(values['pool-key'], T.pureCircuits.linkMessageOf({ bytes: encodeContractAddress(op.config.contract) }, id, count, false, until));
      return (await mine()).callTx.linkPool(id, sig, ed25519Point(fromHex(pub)), false, stamp(leadLink), priorOf(l, place), until);
    });
    await shown((x) => x.poolOf.member(id), 'the link');
    if (pending) unlinkSync(files.link);
    say(`linked: the pool at place ${place} backs this operator, which now takes its turn in the ring`);
  });
};

const topup = () => withOperator(async ({ op, read, call, shown, anyone, coinsFirst }) => {
  const id = op.key.id;
  const n = BigInt(values.slots ?? 1);
  if (n < 1n) throw new Error('--slots is 1 or more');
  const l = await read();
  if (!l.operators.member(id)) throw new Error('register first');
  const before = l.bonds.lookup(id).read();
  await coinsFirst();
  await call(`topUp: ${plural(n, 'slot')} more (${tn(n * l.collateralPerSlot)})`, 'topUp', async () => (await anyone()).callTx.topUp(id, n));
  await shown((x) => x.bonds.lookup(id).read() === before + n, 'the bond');
  say(`bond: ${before} -> ${before + n} slots`);
});

const claim = () => withOperator(async ({ op, mine, read, call, shown, coinsFirst }) => {
  const id = op.key.id;
  const l = await read();
  const amount = l.earned.member(id) ? l.earned.lookup(id) : 0n;
  if (amount === 0n) { say('nothing to claim'); return; }
  await coinsFirst();
  await call(`claim ${tn(amount)}`, 'claim', async () => (await mine()).callTx.claim());
  await shown((x) => !x.earned.member(id) || x.earned.lookup(id) === 0n, 'the payment');
  say(`${tn(amount)} sent to the payout address`);
});

const withdraw = () => withOperator(async ({ op, mine, read, call, shown, coinsFirst }) => {
  const id = op.key.id;
  const l = await read();
  if (!l.operators.member(id)) throw new Error('not registered');
  const o = l.operators.lookup(id);
  const bond = l.bonds.lookup(id).read();
  const n = values.all ? bond : BigInt(values.slots ?? 0);
  if (n < 1n) throw new Error(values.all ? 'there is no bond to withdraw' : 'withdraw takes --slots <n> or --all');
  if (n > bond) throw new Error(`the bond is ${plural(bond, 'slot')}`);
  if (o.active && bond - n < l.minBondSlots) throw new Error(`an active operator keeps the minimum of ${l.minBondSlots} slots: it can take ${bond > l.minBondSlots ? bond - l.minBondSlots : 0n} (or leave first, then take it all later)`);
  if (!o.active && o.leftTime + l.epochSecs > nowSecs()) throw new Error(`the bond waits one epoch length after leaving: from ${clock(o.leftTime + l.epochSecs)}`);
  await coinsFirst();
  // The contract also keeps the bond under a seat that still has duties, and says so if it does.
  await call(`withdraw ${plural(n, 'slot')} (${tn(n * l.collateralPerSlot)})`, 'withdraw', async () => (await mine()).callTx.withdraw(n));
  await shown((x) => x.bonds.lookup(id).read() === bond - n, 'the bond');
  say(`bond: ${bond} -> ${bond - n} slots; ${tn(n * l.collateralPerSlot)} sent to the payout address`);
});

const leave = () => withOperator(async ({ op, mine, read, call, shown, stamp, coinsFirst }) => {
  const id = op.key.id;
  const l = await read();
  if (!l.operators.member(id)) throw new Error('not registered');
  if (!l.operators.lookup(id).active) { say('already left'); return; }
  if (seatingNow(l)) throw new Error(`a committee is being seated (epoch ${l.opened}): nobody leaves until it is, try again in a few minutes`);
  await coinsFirst();
  await call('leave', 'leave', async () => (await mine()).callTx.leave(stamp()));
  await shown((x) => !x.operators.lookup(id).active, 'the leaving');
  const e = [l.current, l.opened].filter((x) => x > 0n && positionOf(l, x, id));
  say(`left: it won't be seated in new committees${e.length ? `. It still holds a seat in epoch ${e.join(' and ')}: keep it running until that's over` : ''}`);
  say(`its bond can be taken back from ${clock(nowSecs() + l.epochSecs)} (withdraw --all)`);
});

const send = () => withOperator(async ({ coinsNow, coinsText, coinsUntil, sendNight }) => {
  const amount = night(values.amount ?? 0);
  if (!values.to?.startsWith('mn_addr') || !(amount > 0n)) throw new Error('send takes --to <mn_addr_... address> --amount <tNIGHT>');
  const before = await coinsNow();
  if (before.night < amount) throw new Error(`the wallet has ${coinsText(before)}`);
  say(`${tn(amount)} sent to ${values.to}, transaction ${await sendNight(values.to, amount)}`);
  // Until it lands, the UTXO it spent is out of the wallet with all its change.
  await coinsUntil((x) => x.night < before.night && x.night >= before.night - amount, 'the transfer and its change didn\'t show within 10 minutes', 10 * 60_000);
  say(`the wallet now: ${coinsText(await coinsNow())}`);
});

const wallet = () => withOperator(async ({ coinsNow, coinsText, spends }) => {
  say(`the wallet: ${coinsText(await coinsNow())}`);
  say(`each fee is paid with ${spends()} DUST coins (made when needed)`);
});

// ------------------------------------------------------------------ run
const run = () => withOperator(async ({ op, mine, anyone, handle, read, call, shown, stamp, l0, meBytes, coinsFirst, checkCoins }) => {
  const id = op.key.id;
  const keeper = !values['no-keeper'];
  const every = Math.max(20, Number(values.every) || 60) * 1000;
  const claimAt = night(values['claim-at']);
  const options = () => ({ id, now: nowSecs(), claimAt, keeper });
  /** A duty that failed isn't tried again for a while (one that would be refused again costs a proof each time). */
  const notBefore = new Map();
  const tag = `op-${short(id)}`;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { say(`stopping (${signal})`); process.exit(0); });

  const perform = async (d, l) => {
    const e = d.epoch;
    if (d.circuit === 'answer') {
      const q = l.requests.lookup(d.rid);
      const share = shareOf(l, q.epoch, d.position, op.key.secret);
      const ha = await handle(`${tag}-answer-${q.epoch}`, { operatorSecret: op.key.secret, shareSecret: share, answerSecs: l0.answerSecs });
      await call(d.what, 'answer', async () => ha.callTx.answer(d.rid, BigInt(d.position)));
      await shown((x) => x.shares.member(shareKeyOf(q.number, d.position)), 'the answer');
    } else if (d.circuit === 'dealCommit' || d.circuit === 'dealShare') {
      // The polynomial is made once for the epoch and kept, so a process started again deals with the same one.
      const poly = polynomialFor(home, 'operator', e, d.t);
      const hd = await handle(`${tag}-deal-${e}`, { operatorSecret: op.key.secret, coefficients: poly, answerSecs: l0.answerSecs });
      if (d.circuit === 'dealCommit') {
        await call(d.what, 'dealCommit', async () => hd.callTx.dealCommit(e, BigInt(d.position), poly.map((x) => ecMulGenerator(x))));
        await shown((x) => x.committed.member(seatKeyOf(e, d.position)), 'the commitments');
      } else {
        await call(d.what, 'dealShare', async () => hd.callTx.dealShare(e, BigInt(d.position), BigInt(d.to)));
        await shown((x) => x.parcels.member(cellKeyOf(e, d.position, d.to)), 'the parcel');
      }
    } else if (d.circuit === 'claim') {
      await call(`claim ${tn(d.amount)}`, 'claim', async () => (await mine()).callTx.claim());
      await shown((x) => !x.earned.member(id) || x.earned.lookup(id) === 0n, 'the payment');
    } else if (d.circuit === 'seat') {
      const before = l.committees.lookup(e).seated;
      await call(d.what, 'seat', async () => (await anyone()).callTx.seat(e, stamp()));
      await shown((x) => x.committees.lookup(e).seated > before, 'the seat taken');
    } else if (d.circuit === 'finish') {
      await call(d.what, 'finish', async () => (await anyone()).callTx.finish(e, stamp()));
      await shown((x) => [T.Phase.serving, T.Phase.failed].includes(x.committees.lookup(e).phase), 'the ceremony ended');
      const c = (await read()).committees.lookup(e);
      say(c.phase === T.Phase.serving ? `epoch ${e} serves: ${c.t} of ${c.n}` : `epoch ${e}'s ceremony failed: ${c.dealt} dealers finished, ${c.t} were needed`);
    } else if (d.circuit === 'finalise') {
      const positions = [...d.positions, 0, 0, 0, 0].slice(0, 4).map(BigInt);
      await call(d.what, 'finalise', async () => (await anyone()).callTx.finalise(d.rid, positions, { bytes: meBytes }));
      await shown((x) => x.requests.lookup(d.rid).status === T.Status.fulfilled, 'the value');
      say(`  the value: ${hex((await read()).requests.lookup(d.rid).output)}`);
    } else if (d.circuit === 'settle') {
      await call(d.what, 'settle', async () => (await anyone()).callTx.settle(d.rid, { bytes: meBytes }));
      await shown((x) => x.requests.lookup(d.rid).settled, 'the settling');
      say(`  ${(await read()).requests.lookup(d.rid).voided ? 'void: too few answered in time, and its fee went back' : 'paid to the seats that answered in time'}`);
    } else if (d.circuit === 'openEpoch') {
      const before = l.opened;
      const r = await call(d.what, 'openEpoch', async () => (await anyone()).callTx.openEpoch(stamp()));
      if (r.private?.result === 0n) {
        say('  no committee of an allowed size can be made yet: trying again in an hour');
        notBefore.set(d.key, Date.now() + 3_600_000);
        return;
      }
      await shown((x) => x.opened > before, 'the new epoch');
      const la = await read();
      const c = la.committees.lookup(la.opened);
      say(`  epoch ${la.opened} is open: ${c.t} of ${c.n}, to be seated and dealt by ${clock(c.dealBy)}`);
    } else if (d.circuit === 'standDown') {
      await call(d.what, 'standDown', async () => (await anyone()).callTx.standDown(d.operator, stamp()));
      await shown((x) => !x.operators.lookup(d.operator).active, 'the stand-down');
    } else {
      throw new Error(`no way to send ${d.circuit}`);
    }
  };

  const l = await read();
  if (!l.operators.member(id)) throw new Error('register first');
  say(`running: its own duties${keeper ? ', and the keeper\'s (each after a random wait of up to 90 s)' : ''}; it looks at the chain every ${every / 1000} s. Stop it with Ctrl-C`);
  await coinsFirst();
  let quiet = 0;
  for (;;) {
    const ready = (x) => !(notBefore.get(x.key) > Date.now());
    const lNow = await read();
    let d = duties(lNow, options()).find(ready);
    if (!d) {
      // Something to say now and then, so the log shows it is alive.
      if (Date.now() - quiet > 30 * 60_000) { say('nothing to do: watching the chain'); quiet = Date.now(); }
      // DUST coins stuck as booked would leave it unable to pay for its next duty: free them now, not when it's due.
      await checkCoins();
      await sleep(every);
      continue;
    }
    let l = lNow;
    if (d.keeper) {
      const wait = randomInt(0, 90_001);
      await sleep(wait);
      l = await read();
      const again = duties(l, options()).find((x) => x.key === d.key && ready(x));
      if (!again) continue; // another keeper sent it meanwhile, or it isn't needed any more
      d = again;
    }
    try {
      await perform(d, l);
    } catch (e) {
      const text = errorText(e);
      // Another keeper's transaction landing first is the usual reason a keeper's call is refused.
      say(`not done: ${d.what}: ${text.slice(0, 300)}${d.keeper ? ' (another keeper may have sent it first)' : ''}; not tried again for 10 minutes`);
      notBefore.set(d.key, Date.now() + 10 * 60_000);
    }
  }
});

const commands = { init, status, wallet, register, link, topup, claim, withdraw, leave, send, run };
if (!commands[command]) {
  process.stderr.write(`usage: node network/threshold/ops/operator.mjs ${Object.keys(commands).join(' | ')} [--home <folder>] ...\n(see the top of this file)\n`);
  process.exitCode = 2;
} else {
  try {
    await commands[command]();
  } catch (e) {
    say(`stopped: ${errorText(e)}`);
    process.exitCode = 1;
  }
}
// Leave no wallet connection holding the process open.
if (command !== 'init') process.exit(process.exitCode ?? 0);
