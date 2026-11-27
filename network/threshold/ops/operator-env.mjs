// What an operator runs with unless told otherwise: imported first, before anything reads it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The operator's folder: --home, else NIGHTCAST_OPERATOR_HOME, else ~/.nightcast-operator. */
export const homeOf = (argv = process.argv) => {
  const i = argv.findIndex((a) => a === '--home' || a.startsWith('--home='));
  const given = i < 0 ? undefined : argv[i].includes('=') ? argv[i].slice('--home='.length) : argv[i + 1];
  return resolve(given ?? process.env.NIGHTCAST_OPERATOR_HOME ?? join(homedir(), '.nightcast-operator'));
};

// The compiled contract: the one `keys` downloaded and checked into the folder, unless told otherwise
// (or, in a checkout that compiled it, network/threshold/check/out-net).
const build = join(homeOf(), 'build');
if (!process.env.NIGHTCAST_TNET_BUILD && existsSync(join(build, '.checked.json'))) process.env.NIGHTCAST_TNET_BUILD = build;
// Midnight's own Preprod node was retired on 24 Nov 2026, so the chain is reached through Blockfrost's.
process.env.NIGHTCAST_NODE_URL ??= 'blockfrost';
process.env.NIGHTCAST_NODE_WS ??= 'blockfrost';
// Fees are gathered from the largest DUST coins first: an operator is paid in small amounts, and each payment
// registered for DUST is one more small coin, which the wallet's own order would spend first (26 Nov 2026: 8 spends a fee).
process.env.NIGHTCAST_DUST_LARGEST_FIRST ??= '1';
// NIGHT that arrives, or comes back as change, is registered for DUST when the wallet opens.
process.env.NIGHTCAST_REGISTER_NEW_NIGHT ??= '1';
