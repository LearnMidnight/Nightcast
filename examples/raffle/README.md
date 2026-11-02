# A fair raffle with Nightcast

Picks winners from a list with Nightcast randomness, using only the published packages (`@nightcast/contract` and `@nightcast/sdk`). Copy this folder anywhere, then:

```bash
npm install
npm start
```

It runs the whole flow on the in-memory simulator, so it needs no network or wallet:

1. Fix the entrant list ([names.txt](names.txt)) and compute its fingerprint (`listCommitment`).
2. Request randomness with the fingerprint as the request's seed, so the answer is bound to this exact list.
3. The oracle answers.
4. Draw the winners (`pickMany`).
5. Check it all again the way anyone could: the same list gives the same request id, the same answer gives the same winners, and a list changed afterwards no longer matches.

To draw from a real answer, make the request with the list's fingerprint as its seed, then draw from its output:

```bash
node raffle.mjs --fingerprint --names names.txt     # the seed for the request
```

```bash
node raffle.mjs --output <the request's 64-hex output> --seed <its seed> --names names.txt --winners 3
```

With `--seed`, it refuses to draw if the list isn't the one the request was made with. See the [guide](../../docs/GUIDE.md#a-fair-raffle) for making the request.
