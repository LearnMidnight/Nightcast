# Running Nightcast on Preprod: a step-by-step guide

This walks you through putting Nightcast on Midnight's Preprod test network, running the oracle, and making a test request to see it answer. No previous Midnight experience needed. It's written for **Windows**; on macOS or Linux skip Part 1 steps 1–2 and run everything in a normal terminal.

Preprod uses test tokens with no real value, so nothing here costs money.

**Time:** about an hour the first time, mostly installing and waiting for test tokens.

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

### 2. Install Docker Desktop

Docker runs the Midnight proof server, which creates the zero-knowledge proofs.

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

### 8. Check the connection, then fund the wallets

First check your computer can reach Preprod:

```bash
./nightcast doctor --network preprod
```

It starts the proof server and checks the Preprod node and indexer. It should end with `Everything answered. You are ready to go.`

Now fund the oracle wallet:

```bash
./nightcast wallet show --network preprod --wallet ~/nightcast-secrets/oracle-wallet.secret
```

It prints the wallet address (starting `mn_addr_preprod1...`) and, because the wallet is empty, tells you what to do:

1. Open the Preprod faucet: <https://midnight-tmnight-preprod.nethermind.dev/>
2. Paste the address, complete the captcha and click **Request tokens**.
3. Leave the terminal running. Within a few minutes it shows the NIGHT arriving, registers it for DUST, and waits for the first DUST.

**NIGHT and DUST:** NIGHT is the token; DUST is what pays fees. Holding registered NIGHT slowly generates DUST, so after funding there's a short wait before the wallet can send transactions. The command finishes by printing both balances.

Do the same for the requester wallet:

```bash
./nightcast wallet show --network preprod --wallet ~/nightcast-secrets/requester-wallet.secret
```

If the faucet says you're rate-limited, wait a few hours and try again.

---

## Part 3: Deploy Nightcast

### 9. Deploy, lock and activate

```bash
./nightcast deploy --network preprod \
  --oracle ~/nightcast-secrets/oracle.secret \
  --operator ~/nightcast-secrets/operator.secret \
  --wallet ~/nightcast-secrets/oracle-wallet.secret \
  --accept
```

This takes a few minutes. It:

1. starts a proof server in Docker;
2. deploys the contract;
3. locks the admin key so nobody can ever change the contract's code;
4. activates the oracle key;
5. writes `deployments/preprod.json` and checks everything.

It ends with a checklist. Every line should say **PASS**:

```
PASS  contract exists: ...
PASS  maintenance authority locked: committee of 0, threshold 1, 1 update(s) since deploy
PASS  verifier keys match the published fingerprints: 7 circuits
PASS  this checkout compiles to the deployed code: identical
PASS  oracle key accepted: active and matches the record
PASS  request windows match: 60s to 86400s
```

---

## Part 4: Run the oracle

### 10. Start the oracle

```bash
cd ~/nightcast
./nightcast oracle --network preprod \
  --oracle ~/nightcast-secrets/oracle.secret \
  --wallet ~/nightcast-secrets/oracle-wallet.secret
```

When it says `Oracle running for ...` and `Press Ctrl+C to stop.`, it's watching for requests. **Leave this window open.**

---

## Part 5: Test it

### 11. Ask for randomness

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
lotto    4 11 19 23 37 42 (6 from 45, example)
```

That's live, verifiable randomness on Preprod.

You can look up any request later without a wallet:

```bash
./nightcast status --network preprod --id <request id>
```

### 12. Stop the oracle

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
| `doctor` reports a problem, or a command says `did not answer` | Check your internet connection and run `./nightcast doctor --network preprod` again; Preprod is sometimes briefly down. |
| `Cannot connect to the Docker daemon` | Open Docker Desktop and check WSL integration is on for Ubuntu (step 2). |
| `compact: command not found` or `nvm: command not found` | Run `source ~/.bashrc`, or close and reopen the Ubuntu terminal. |
| Stuck on "Waiting for the NIGHT to arrive" | Check you pasted the `mn_addr_preprod1...` address into the faucet, with no spaces. |
| Stuck on "Waiting for the first DUST" | Normal for a few minutes after funding; DUST builds up over time. |
| `the oracle key is not active yet` | Run `./nightcast accept-key --network preprod --oracle ~/nightcast-secrets/oracle.secret --wallet ~/nightcast-secrets/oracle-wallet.secret`. |
| A request shows `expired` | The oracle wasn't running before its deadline. Start the oracle and make a new request. |
| `No compiled contract with proving keys found` | Run `npm run compact` then `npm run build` in `~/nightcast`. |
