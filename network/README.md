# Nightcast network

A group of three operators answers each request, so no single key holder can know the random value early. The design, its limits and the test plan are in [docs/OPERATORS.md](../docs/OPERATORS.md).

- `src/network.compact`: the contract (Compact 0.36, ledger 9).
- `check/`: in-memory checks (`bash check/run.sh`, needs Compact 0.36 and `npm ci` at the top of the repository).
- `build.sh`: compile with proving keys into `build/` (what the scripts use).
- `ops/`:
  - `deploy.mjs offline|deploy`: the locked deploy.
  - `operators.mjs keys|register|run|leave|status`: one process running several operator keys, paying fees from one wallet.
  - `requester.mjs run|report`: the test requester and its report.
- `vm/net.sh`: the five-operator test on a VM, apart from everything live.

This folder isn't an npm workspace. Its `compact-runtime` is linked to the copy Midnight.js's `compact-js` uses, so the compiled contract and Midnight.js share one on-chain runtime. Run `npm ci` at the top of the repository first, then `npm install` here.
