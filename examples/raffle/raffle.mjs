#!/usr/bin/env node
/**
 * A fair raffle with Nightcast, using only the published packages
 * (@nightcast/contract and @nightcast/sdk from npm).
 *
 *   npm start
 *     The whole flow on the in-memory simulator: fix the list, request,
 *     the oracle answers, pick the winners, and check it all again.
 *
 *   node raffle.mjs --fingerprint --names names.txt
 *     Print the list's fingerprint: the seed to make a real request with.
 *
 *   node raffle.mjs --output <64 hex> --names names.txt [--winners 3] [--seed <64 hex>]
 *     Pick winners from a real Nightcast answer (for example one from Preprod).
 *     With --seed, the request's seed, it first checks the list is the one the
 *     request was made with.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fromHex, generateOracleSecretKey, NightcastSimulator, Status, toHex } from '@nightcast/contract';
import { listCommitment, pickMany } from '@nightcast/sdk';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    names: { type: 'string', default: new URL('./names.txt', import.meta.url).pathname },
    winners: { type: 'string', default: '3' },
    seed: { type: 'string' },
    fingerprint: { type: 'boolean', default: false },
  },
});

const names = readFileSync(values.names, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
const winners = Number(values.winners);
const say = (s = '') => process.stdout.write(s + '\n');

const fingerprint = listCommitment(names);

if (values.fingerprint) {
  say(fingerprint);
  process.exit(0);
}

if (values.output) {
  // A real answer: check the list against the request's seed, then pick.
  if (values.seed && values.seed.replace(/^0x/i, '').toLowerCase() !== fingerprint) {
    say(`This list's fingerprint is ${fingerprint}, but the request's seed is ${values.seed}.`);
    say('The list is not the one the request was made with: not drawing.');
    process.exit(1);
  }
  say(`${names.length} entrants, fingerprint ${fingerprint}${values.seed ? ' (matches the request)' : ''}`);
  pickMany(values.output, names, winners).forEach((n, i) => say(`  ${i + 1}. ${n}`));
  process.exit(0);
}

// 1. Fix the list before any randomness exists, and publish it with its fingerprint.
say(`1. The entrants (${names.length}), published before the draw:`);
say(`   ${names.join(', ')}`);
say(`   fingerprint: ${fingerprint}`);

// 2. Ask Nightcast, with the fingerprint as the request's seed. Here the
//    contract runs in memory, with a throwaway oracle key.
const sim = new NightcastSimulator({ oracleSecretKey: generateOracleSecretKey(), operatorSecret: new Uint8Array(32).fill(1) });
const tag = new Uint8Array(32);
tag.set(new TextEncoder().encode('raffle-demo-1'));
const seed = fromHex(fingerprint);
const id = sim.request(tag, seed, BigInt(sim.now + 600));
say(`\n2. Requested randomness. Request id: ${toHex(id)}`);

// 3. The oracle answers. On a real network this is a transaction the network
//    only accepts with the one output its key can give for this request.
sim.fulfil(id);
const answer = sim.getLedger().requests.lookup(id);
say(`\n3. The oracle answered: ${toHex(answer.output)}`);

// 4. Draw.
const drawn = pickMany(answer.output, names, winners);
say(`\n4. Winners:`);
drawn.forEach((n, i) => say(`   ${i + 1}. ${n}`));

// 5. Anyone can check: the published list gives the same fingerprint and so
//    the same request id; the stored answer gives the same winners; a list
//    changed afterwards doesn't match the request.
const again = listCommitment([...names]);
const checks = [
  ['the request is answered', answer.status === Status.fulfilled],
  ['the published list matches the request', toHex(sim.idFor(tag, fromHex(again))) === toHex(id)],
  ['the answer gives the same winners', JSON.stringify(pickMany(toHex(answer.output), names, winners)) === JSON.stringify(drawn)],
  ['a changed list would not match', toHex(sim.idFor(tag, fromHex(listCommitment([...names, 'Late Entry'])))) !== toHex(id)],
];
say('\n5. Checks anyone can run:');
for (const [what, ok] of checks) say(`   ${ok ? '✓' : '✗'} ${what}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
