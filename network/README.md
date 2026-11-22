# Nightcast network

A group of three operators answers each request, so no single key holder can know the random value early. The design, its limits and the test plan are in [docs/OPERATORS.md](../docs/OPERATORS.md).

- `src/network.compact`: the contract (Compact 0.36, ledger 9).
- `check/`: in-memory checks (`bash check/run.sh`, needs Compact 0.36 and `npm ci` at the top of the repository).
- `build.sh`: compile with proving keys into `build/` (what the scripts use).
- `ops/`:
  - `deploy.mjs offline|deploy`: the locked deploy.
  - `operators.mjs keys|register|run|leave|status`: `run --key op-N` runs one operator with its own wallet (how a real operator runs); without `--key`, every key in one process from one wallet.
  - `requester.mjs run|report`: the test requester and its report.
  - `stall-watch.mjs`: a running operator or requester exits with code 75 for a restart when its wallet's DUST sync hasn't moved for 10 minutes (`--stall-after`, 0 for never), or three transactions in a row are refused as from a wallet that fell behind.
- `vm/net.sh`: the five-operator test on a VM, apart from everything live.

This folder isn't an npm workspace. Its `compact-runtime` is linked to the copy Midnight.js's `compact-js` uses, so the compiled contract and Midnight.js share one on-chain runtime. Run `npm ci` at the top of the repository first, then `npm install` here.
