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
 *   ... topup --slots <n>       add bond
 *   ... claim                   collect what the operator has earned (to its payout address: this wallet)
 *   ... withdraw --slots <n> | --all   take bond back to the payout address
 *   ... leave                   stop being seated in new committees (a seat held keeps its duties)
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
import './operator-env.mjs';
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { walletAddressOf } from '@nightcast/deploy';
import {
  ROOT, T, ed25519Point, errorText, fromHex, hex, newOperatorFile, operatorFrom, poolIdOf, poolSign, poolSignatureFrom, readJson, readRecord, say, tn,
  walletSeedFrom, writeSecret,
} from './common.mjs';
import { clock, phaseName, positionOf, priorOf, seatKeyOf, shareKeyOf, short } from './threshold.mjs';
import { openRuntime, readContract } from './runtime.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' }, network: { type: 'string' }, contract: { type: 'string' }, 'proof-server-port': { type: 'string' },
    key: { type: 'string' }, wallet: { type: 'string' }, slots: { type: 'string' }, all: { type: 'boolean' },
    pool: { type: 'string' }, 'pool-key': { type: 'string' }, signature: { type: 'string' }, 'valid-hours': { type: 'string', default: '24' },
    'dust-spends': { type: 'string', default: '3' }, 'dust-wait': { type: 'string', default: '120' },
  },
});
const command = positionals[0];
const home = resolve(values.home ?? process.env.NIGHTCAST_OPERATOR_HOME ?? join(homedir(), '.nightcast-operator'));
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
  const key = operatorFrom(files.key);
  const seed = walletSeedFrom(files.wallet);
  return { config, key, seed, address: walletAddressOf(config.network, seed) };
};
const isHouse = (l, id) => [...l.house].some((x) => hex(x) === hex(id));

/** One process at a time uses the folder (two would spend the same DUST coins). */
const lock = () => {
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(files.lock, `${process.pid}\n`, { flag: 'wx' });
      process.on('exit', () => { try { unlinkSync(files.lock); } catch { /* gone already */ } });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(files.lock, 'utf8').trim());
      let running = false;
      try { process.kill(pid, 0); running = pid !== process.pid; } catch { /* not running */ }
      if (running) throw new Error(`another process (${pid}) is using ${home}: wait for it to finish, or stop it`);
      unlinkSync(files.lock); // left by a process that has ended
    }
  }
  throw new Error(`couldn't take ${files.lock}`);
};

/** The several-DUST-spends option needs the patch npm ci adds to the dust wallet. */
const dustPatchInstalled = () => {
  const repo = resolve(ROOT, '..', '..');
  let out;
  try {
    out = execFileSync(process.execPath, [join(repo, 'deploy', 'scripts', 'patch-dust-two-spends.mjs'), '--check'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`the dust wallet installed here isn't the one Nightcast's fee option was written for: ${String(e.stdout ?? '') + String(e.stderr ?? '')}`.trim());
  }
  if (!/already there|added to/.test(out)) throw new Error(`the fee option isn't installed in the dust wallet (run npm ci at the top of the repository): ${out.trim()}`);
};

/** The wallet open, as runtime.mjs gives it, plus this operator's contract handle. */
const withOperator = async (f) => {
  const op = load();
  lock();
  if (Number(values['dust-spends']) > 1) dustPatchInstalled();
  say(`operator ${hex(op.key.id)}, wallet ${op.address}`);
  say('opening the wallet (the first time, catching up with the chain can take a while)');
  return openRuntime({
    network: op.config.network, proofServerPort: op.config.proofServerPort, walletFile: files.wallet, address: op.config.contract, log: files.log, saveDir: home,
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
    const contract = values.contract ?? readRecord(network).contractAddress;
    writeFileSync(files.config, `${JSON.stringify({ network, contract, proofServerPort: Number(values['proof-server-port'] ?? 6300) }, null, 2)}\n`);
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
  const l = await readContract({ network: op.config.network, proofServerPort: op.config.proofServerPort, address: op.config.contract });
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
    const l = await readContract({ network: op.config.network, proofServerPort: op.config.proofServerPort, address: op.config.contract });
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

const wallet = () => withOperator(async ({ coinsNow, coinsText, spends }) => {
  say(`the wallet: ${coinsText(await coinsNow())}`);
  say(`each fee is paid with ${spends()} DUST coins (made when needed)`);
});

const commands = { init, status, wallet, register, link, topup, claim, withdraw, leave };
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
