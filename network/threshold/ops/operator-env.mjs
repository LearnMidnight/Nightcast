// What an operator runs with unless told otherwise: imported first, before anything reads it.
// Midnight's own Preprod node was retired on 24 Nov 2026, so the chain is reached through Blockfrost's.
process.env.NIGHTCAST_NODE_URL ??= 'blockfrost';
process.env.NIGHTCAST_NODE_WS ??= 'blockfrost';
// Fees are gathered from the largest DUST coins first: an operator is paid in small amounts, and each payment
// registered for DUST is one more small coin, which the wallet's own order would spend first (26 Nov 2026: 8 spends a fee).
process.env.NIGHTCAST_DUST_LARGEST_FIRST ??= '1';
// NIGHT that arrives, or comes back as change, is registered for DUST when the wallet opens.
process.env.NIGHTCAST_REGISTER_NEW_NIGHT ??= '1';
