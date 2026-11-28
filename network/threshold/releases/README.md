# Releases of the threshold network contract

One file per network (`preprod.json`) names the deployed contract and the build an operator needs to make its proofs: the compiled contract and its proving keys, about 120 MB packed, published as a file of a GitHub release.

```json
{
  "network": "preprod",
  "contract": "<the contract's address>",
  "compiler": "0.36.1",
  "circuits": 18,
  "build": { "url": "<the release file's download link>", "sha256": "<its SHA-256>", "bytes": 0 }
}
```

`nightcast-operator keys` downloads `build.url` and refuses it unless its SHA-256 is the one here, then refuses it again unless every circuit's verifier key is the one on chain. This file is what an operator trusts, so it changes only by a reviewed commit.

The file is made on the machine that compiled and deployed the contract: `bash network/threshold/vm/tnet.sh bundle` checks the build against the chain, packs it, and prints the lines to put here. The packed file is then attached to a GitHub release, and its download link goes in `build.url`.
