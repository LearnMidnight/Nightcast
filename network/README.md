# Nightcast network

Two contracts, beside Nightcast v1 (which is in [`contract/`](../contract)):

| Folder | What it is | State |
|---|---|---|
| [`threshold/`](threshold) | **The threshold network.** A committee shares one key that nobody holds; any *t* of *n* members produce a value. Design: [docs/THRESHOLD.md](../docs/THRESHOLD.md). | On Preprod for measurement since 24 Nov 2026 |
| `src/`, `check/`, `ops/`, `vm/` | The three-operator prototype it replaces: each request named three operators and needed all three. Design: [docs/OPERATORS.md](../docs/OPERATORS.md). | Superseded; ran on Preprod 21 to 23 Nov 2026 |

Both are Compact 0.36 contracts for ledger 9.

## The threshold network

- `threshold/src/threshold-net.compact`: the contract.
- `threshold/check/`: in-memory checks. `bash threshold/check/run-net.sh` compiles the contract with keys into `threshold/check/out-net` and runs the 224 checks of `net-check.mjs`. It needs Compact 0.36.1 (`COMPACTC` points at the compiler) and `npm ci` at the top of the repository, then `npm install` here.
- `threshold/ops/`:
  - `keys.mjs house|pools|operators`: test keys. Secrets are written with mode 600 and never printed.
  - `deploy.mjs offline|deploy`: the deploy. The contract has more circuits than fit one transaction, so it is deployed with as many verifier keys as fit, the rest are added by maintenance updates, and then the maintenance authority is replaced by an empty committee: nobody can change the contract after that.
  - `ops.mjs status|do <actions>`: every call (load the pool list, register, link, leave, open, seat, deal, finish, request, answer, finalise, settle, claim), each with its proof time, the proof server's peak memory, and the transaction's size, DUST spends, fee and time-to-dismiss allowance.
  - `midnight-committee.mjs`: read-only: who produces Midnight's blocks (for the pool list rule).
- `threshold/vm/tnet.sh`: the Preprod test as it is run, with background runs that restart themselves when the wallet loses the network.
- `threshold/src/*-probe.compact`: small contracts that checked each building block first (hash to curve, Ed25519 inside a circuit, a proved deal).

## The prototype

- `src/network.compact`: the contract.
- `check/`: in-memory checks (`bash check/run.sh`).
- `build.sh`: compile with proving keys into `build/`.
- `ops/`: `deploy.mjs`, `operators.mjs` (`run --key op-N` runs one operator with its own wallet), `requester.mjs`, `stall-watch.mjs`.
- `vm/net.sh`: the five-operator test on a VM.

This folder isn't an npm workspace. Its `compact-runtime` is linked to the copy Midnight.js's `compact-js` uses, so the compiled contract and Midnight.js share one on-chain runtime. Run `npm ci` at the top of the repository first, then `npm install` here.
