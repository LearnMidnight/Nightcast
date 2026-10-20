# Deployments

One file per network, written by `nightcast-deploy` and committed so anyone can check a live deployment against it.

| Field | Meaning |
|---|---|
| `contractAddress` | Where Nightcast lives on that network |
| `sourceCommit` | The commit it was built from (`-dirty` means uncommitted changes) |
| `compiler` | Compact compiler, language and runtime versions |
| `parameters` | Constructor arguments: oracle public key, operator commitment, request windows |
| `transactions` | Deploy, authority-lock and key-acceptance transaction ids |
| `maintenanceAuthority` | The authority after locking: an empty committee with threshold 1, which can never sign |
| `verifierKeys` | SHA-256 of each circuit's verifier key (the code's fingerprints) |

## Check a deployment yourself

```sh
npm install && npm run compact && npm run build
./nightcast verify --network preprod
```

`verify` reads the contract from the public indexer and checks that:

1. the maintenance authority is locked, so nobody can replace the contract's code;
2. the verifier keys on chain match the fingerprints in this file;
3. your own build of this commit produces the same fingerprints;
4. the oracle key is active and matches the record;
5. the request windows match.

It needs no wallet and no secrets.
