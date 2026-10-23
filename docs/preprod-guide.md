# Running Nightcast on Preprod: a step-by-step guide

This walks you through putting Nightcast on Midnight's Preprod test network, running the oracle, and making a test request to see it answer. No previous Midnight experience needed. It's written for **Windows**; on macOS or Linux skip Part 1 steps 1–2 and run everything in a normal terminal.

Preprod uses test tokens with no real value, so nothing here costs money.

**Preview instead of Preprod:** Midnight's other test network, Preview, needs no Blockfrost account. To use it, skip step 8 and write `--network preview` wherever this guide says `--network preprod`; its faucet is <https://midnight-tmnight-preview.nethermind.dev/>. Preprod is the one meant for final testing before Mainnet.

**Time:** about an hour of hands-on work, plus up to an hour (unattended) for the wallets' first sync.

---

## Part 1: One-time setup

### 1. Install Ubuntu inside Windows (WSL)

Midnight's tools run on Linux, so Windows runs them inside Ubuntu using WSL.

1. Click Start, type **PowerShell**, right-click it and choose **Run as administrator**.
2. Run:
   ```powershell
   wsl --install -d ubuntu
   ```
3. Restart your computer when asked. This can take 5–15 minutes.
4. After the restart, an **Ubuntu** window opens. Pick a username and password. (The password doesn't show while you type; that's normal.)

From now on, "the Ubuntu terminal" means: Start → type **Ubuntu** → open it. **Run every command below in the Ubuntu terminal**, not in PowerShell.

### 2. Give Ubuntu enough memory

By default Windows gives Ubuntu only half your RAM, and Docker shares it. Nightcast's wallet needs about 4 GB, so on an 8 GB PC raise the limit. In PowerShell:

```powershell
notepad $env:USERPROFILE\.wslconfig
```

Click **Yes** if asked to create the file, and make it read:

```
[wsl2]
memory=6GB
swap=8GB
```

Save, close Notepad, and run `wsl --shutdown`. (If Ubuntu can't reach github.com later, add the line `networkingMode=mirrored` under `[wsl2]` too.)

### 2b. Install Docker Desktop

Docker runs the Midnight proof server, which creates the zero-knowledge proofs. It sees your oracle secret while it works, so it must run on your own PC (the tools start it there, listening only to your PC); never point the tools at somebody else's proof server.

1. Download Docker Desktop from [docker.com](https://www.docker.com/products/docker-desktop/) and install it. Keep **Use WSL 2** ticked.
2. Open Docker Desktop → **Settings → Resources → WSL integration**, switch on **Ubuntu**, then **Apply & restart**.
3. Check it works, in the Ubuntu terminal:
   ```bash
   docker run --rm hello-world
   ```
   You should see "Hello from Docker!". Docker Desktop must be running whenever you use Nightcast.

### 3. Install Node.js 22

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
node --version
```

The last line should print `v22.` followed by some numbers.

### 4. Install the Compact compiler

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
source ~/.bashrc
compact update 0.31.1
compact compile --version
```

The last line should print `0.31.1`, the version Preprod runs.

### 5. Download and build Nightcast

```bash
git clone https://github.com/LearnMidnight/Nightcast.git ~/nightcast
cd ~/nightcast
npm install
npm run compact
npm run build
```

`npm run compact` takes a minute or two: it compiles the contract and creates its proving keys.

---

## Part 2: Secrets and wallets

You need three secrets and two wallets. Keep them in a folder outside the code, so they're never committed by accident:

```bash
mkdir -p ~/nightcast-secrets
cd ~/nightcast
```

### 6. Create the secrets

```bash
./nightcast keygen oracle    --out ~/nightcast-secrets/oracle.secret
./nightcast keygen operator  --out ~/nightcast-secrets/operator.secret
./nightcast keygen requester --out ~/nightcast-secrets/requester.secret
```

| File | What it is |
|---|---|
| `oracle.secret` | The oracle's dice. Whoever has it can roll; keep it private. |
| `operator.secret` | Lets you propose a new oracle key or hand over the operator role later. |
| `requester.secret` | Identifies you when you ask for randomness. |

### 7. Create two wallets

The wallets hold test tokens that pay transaction fees. One is for the oracle, one for making test requests (like a separate customer).

```bash
./nightcast wallet new --out ~/nightcast-secrets/oracle-wallet.secret
./nightcast wallet new --out ~/nightcast-secrets/requester-wallet.secret
```

**Back up `~/nightcast-secrets`** (for example to a USB stick). If you lose these files you lose the oracle key and the wallets.

### 8. Get a Blockfrost project ID

Since 9 October 2026, Preprod's public servers are run by **Blockfrost**, and every connection needs a free Blockfrost *project ID* (like an API key).

1. Sign up at <https://blockfrost.io> (the free plan is enough).
2. In the dashboard, click **Add project**, give it a name (e.g. `nightcast`), and choose the network **Midnight Preprod**.
3. Copy the project's **project ID**.
4. In Ubuntu, run:
   ```bash
   ./nightcast blockfrost save --network preprod
   ```
   Paste the ID (right-click pastes in the Ubuntu window) and press Enter. Nothing shows while you paste; that's on purpose. It checks the ID with Blockfrost and saves it to `~/nightcast-secrets/blockfrost-preprod.secret`.

Every command finds the ID there automatically. Keep it private like your other secrets: don't paste it into chats or commit it.

### 9. Check the connection, then fund the wallets

First check your computer can reach Preprod:

```bash
./nightcast doctor --network preprod
```

It starts the proof server and checks the Preprod node and indexer (including the live WebSocket feed the wallet uses). It should end with `Everything answered. You are ready to go.`

Now fund the oracle wallet:

```bash
./nightcast wallet show --network preprod --wallet ~/nightcast-secrets/oracle-wallet.secret
```

It prints the wallet address (starting `mn_addr_preprod1...`), then starts syncing.

1. Open the Preprod faucet: <https://midnight-tmnight-preprod.nethermind.dev/>
2. Paste the address, complete the captcha and click **Request tokens**. You can do this straight away; you don't need to wait for the sync.
3. Leave the terminal running.

**The first sync takes a while.** A new wallet reads the network's whole history: about 10 minutes on Preview and roughly an hour on Preprod (1.7 million events), depending on your computer and connection. Every 30 seconds it prints progress like:

```
Syncing: shielded 12.3% (33493/271763), unshielded done, dust 14.2% (38670/272206)
```

Progress is saved every 2 minutes in `~/nightcast-secrets/wallet-state/`, so if you close the window or your computer sleeps, run the same command again and it carries on where it stopped. After the first sync, later commands only catch up on what's new, which takes seconds to minutes.

You can sync both wallets at the same time: open a second Ubuntu terminal for the requester wallet (below).

When the sync finishes it shows the NIGHT arriving, registers it for DUST, and waits for the first DUST.

**NIGHT and DUST:** NIGHT is the token; DUST is what pays fees. Holding registered NIGHT slowly generates DUST, so after funding there's a short wait before the wallet can send transactions. The command finishes by printing both balances.

Do the same for the requester wallet:

```bash
./nightcast wallet show --network preprod --wallet ~/nightcast-secrets/requester-wallet.secret
```

If the faucet says you're rate-limited, wait a few hours and try again.

---

## Part 3: Deploy Nightcast

### 10. Deploy, lock and activate

```bash
./nightcast deploy --network preprod \
  --oracle ~/nightcast-secrets/oracle.secret \
  --operator ~/nightcast-secrets/operator.secret \
  --wallet ~/nightcast-secrets/oracle-wallet.secret \
  --accept
```

This takes a few minutes. It:

1. starts a proof server in Docker;
2. deploys the contract **already locked**: it's created with an admin setting nobody can ever use, so there is no key that could change its code, not even yours;
3. activates the oracle key;
4. writes `deployments/preprod.json` and checks everything.

It ends with a checklist. Every line should say **PASS**:

```
PASS  contract exists: ...
PASS  maintenance authority locked: committee of 0, threshold 1, 0 update(s) since deploy
PASS  verifier keys match the published fingerprints: 7 circuits
PASS  this checkout compiles to the deployed code: identical
PASS  oracle key accepted: active and matches the record
PASS  request windows match: 60s to 86400s
```

---

## Part 4: Run the oracle

### 11. Start the oracle

```bash
cd ~/nightcast
./nightcast oracle --network preprod \
  --oracle ~/nightcast-secrets/oracle.secret \
  --wallet ~/nightcast-secrets/oracle-wallet.secret
```

When it says `Oracle running for ...` and `Press Ctrl+C to stop.`, it's watching for requests. **Leave this window open.**

---

## Part 5: Test it

### 12. Ask for randomness

Open a **second** Ubuntu terminal:

```bash
cd ~/nightcast
./nightcast request --network preprod \
  --requester ~/nightcast-secrets/requester.secret \
  --wallet ~/nightcast-secrets/requester-wallet.secret \
  --wait
```

It submits a request, prints its id, and waits. In the oracle window you'll see `fulfilled <id> -> <output>`. Back in this window you'll see something like:

```
request  4f2c...
status   fulfilled
deadline 2026-10-21T01:23:45.000Z
output   9a71...
words    3be0... 77c1...
lotto    8 13 14 22 27 28 31 + Moonball 10 (Starfall example)
```

That's live, verifiable randomness on Preprod.

You can look up any request later without a wallet:

```bash
./nightcast status --network preprod --id <request id>
```

### 13. Run the full self-test (optional, about 5 minutes)

With the oracle still running in the first window, run this in the second one:

```bash
./nightcast selftest --network preprod \
  --requester ~/nightcast-secrets/requester.secret \
  --wallet ~/nightcast-secrets/requester-wallet.secret
```

It checks the deployment, then does two things:
1. It asks for randomness and checks the answer from public data only.
2. It makes a request with too little time left for the oracle to answer, waits for it to run out, and marks it expired.

You should see only `PASS` lines and `Selftest passed` at the end. If it says the oracle answered the short request, just run it again.

### 14. Stop the oracle

Press **Ctrl+C** in the oracle window. Requests made while it's stopped wait until it's back, up to their deadline (30 minutes by default); after that anyone can mark them expired.

---

## Part 6: Publish the deployment

`deployments/preprod.json` holds the contract address and the code fingerprints. Commit it so anyone can check the deployment:

```bash
./nightcast verify --network preprod
git add deployments/preprod.json
git commit -m "Publish the Preprod deployment"
git push
```

(Pushing needs you signed in to GitHub from Ubuntu. If that's not set up, send the file to whoever maintains the repo.)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `preprod needs a Blockfrost project id` | Do step 8. |
| `the Blockfrost project id was refused` (401 or 403) | The ID is wrong or for another network. Check the project's network is **Midnight Preprod**, then run `./nightcast blockfrost save --network preprod` again. |
| A step sits for many minutes with Node at 200–300% CPU, and Ctrl+C does nothing | Ubuntu is short of memory: see step 2. Stop it with Ctrl+\\ and run the command again. |
| Repeated `Wallet sync problem: ...` | The wallet retries by itself, so a few are fine. If it keeps repeating, press Ctrl+C and run `./nightcast doctor --network preprod`; it shows which connection fails. If everything answers, check your Blockfrost project's daily request usage on blockfrost.io. |
| `doctor` reports a problem, or a command says `did not answer` | Check your internet connection and run `./nightcast doctor --network preprod` again; Preprod is sometimes briefly down. |
| `Cannot connect to the Docker daemon` | Open Docker Desktop and check WSL integration is on for Ubuntu (step 2). |
| `compact: command not found` or `nvm: command not found` | Run `source ~/.bashrc`, or close and reopen the Ubuntu terminal. |
| Sync progress stops moving for many minutes | Press Ctrl+C, run `./nightcast doctor --network preprod`, then run the command again; it resumes from the last save. |
| Stuck on "Waiting for the NIGHT to arrive" | Check you pasted the `mn_addr_preprod1...` address into the faucet, with no spaces. |
| Stuck on "Waiting for the first DUST" | Normal for a few minutes after funding; DUST builds up over time. A `Waiting for DUST` line every minute shows what the wallet sees. If a wallet that had DUST before shows 0 for more than 15 minutes, its saved sync state is probably stale: press Ctrl+C, run `./nightcast wallet forget --network preprod --wallet <its wallet file>`, then start again (it syncs from the beginning, which takes a while). |
| `the oracle key is not active yet` | Run `./nightcast accept-key --network preprod --oracle ~/nightcast-secrets/oracle.secret --wallet ~/nightcast-secrets/oracle-wallet.secret`. |
| A request shows `expired` | The oracle wasn't running before its deadline. Start the oracle and make a new request. |
| `No compiled contract with proving keys found` | Run `npm run compact` then `npm run build` in `~/nightcast`. |
