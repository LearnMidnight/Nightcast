# Running a Nightcast operator

This guide is for someone who has never used Midnight. By the end you will have an operator of the Nightcast threshold network running on your own machine, on Midnight's Preprod test network.

**What an operator is.** Nightcast gives Midnight apps random numbers that nobody can predict or bend. Each number is made by a committee of operators: a request goes to the committee, each operator answers with its part, and any *t* of the *n* parts together make the number (for example any 3 of 5). Fewer than *t* learn nothing and can't stop it. Operators put down a bond, are paid a share of each request's fee for answering in time, and lose some bond for staying silent. How it works in full: [THRESHOLD.md](THRESHOLD.md).

**What your operator does by itself**, once it is running:

- answers every request for its seat, within the answering time (100 minutes on Preprod);
- takes part in the ceremony that sets up each new committee (it is chosen in turn, nobody picks);
- collects what it has earned;
- and keeps the network moving: opening the next epoch, seating committees, finishing ceremonies, combining answers, settling requests. Anyone may send these, and every operator does, after a short random wait so they seldom send the same one.

You set it up once; after that it needs a machine that stays on.

## What you need

| | |
|---|---|
| A machine | Linux (or Windows with WSL 2, or a Mac) that stays on, with **4 CPU cores, 16 GB of memory** (one proof takes up to 5 GB) and 10 GB of free disk. A small cloud server is fine. |
| Docker | [Docker Engine](https://docs.docker.com/engine/install/) with Compose (`docker compose version` should answer). |
| A Blockfrost project | Free at [blockfrost.io](https://blockfrost.io): sign up, add a project, choose **Midnight Preprod**. You get a *project id*. It is how your operator reads the chain; keep it private. |
| tNIGHT | Test NIGHT from the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/): the bond (12 tNIGHT on the test contract) and about 100 more, which the wallet uses to make DUST, Midnight's fee resource. It's free. |
| A stake pool | Operators are Cardano stake pools: each one is backed by a pool on the contract's list. On Preprod the list holds **test pools**: [open an issue](https://github.com/LearnMidnight/Nightcast/issues) to ask for a test pool's key file. |

## 1. Get Nightcast and set it up

```bash
git clone https://github.com/LearnMidnight/Nightcast.git
cd Nightcast/network/threshold/docker
cp env.example .env
```

Open `.env` in a text editor and put your Blockfrost project id after `NIGHTCAST_BLOCKFROST_PROJECT_ID=`. Then build the operator (it takes some minutes the first time):

```bash
docker compose build
```

Every command below is run from this `docker` folder. Everything your operator keeps is in its `data` folder.

## 2. Download the proving keys

```bash
docker compose run --rm operator keys
```

This downloads the compiled contract and its proving keys (about 560 MB). It is refused unless it is exactly the file this repository names (its SHA-256 is in `network/threshold/releases/preprod.json`), and refused again unless every one of the contract's 18 circuits has the verifier key that is on chain. So a wrong or altered download can't be used.

## 3. Make your operator

```bash
docker compose run --rm operator init
```

This makes two secrets, in `data/operator`:

- `operator.secret`, your operator's key: it proves on chain that answers are yours;
- `wallet.secret`, your operator's own wallet: it pays the fees and receives what you earn.

It prints your **operator id** and your **wallet address** (`mn_addr_preprod1...`). Both are public.

> **Back up `data/operator` now**, somewhere off this machine, and keep it private. Anyone with those two files can act as your operator and take what it has earned. Lose them and your bond can't be taken back.

Send tNIGHT to the wallet address from the [faucet](https://midnight-tmnight-preprod.nethermind.dev/). Check it arrived:

```bash
docker compose run --rm operator wallet
```

New NIGHT starts making DUST as soon as the wallet sees it, but DUST builds up over time: the first fees can take an hour or so to be covered. The commands wait for it.

## 4. Register

```bash
docker compose run --rm operator register
```

This puts down the bond (the contract's minimum and 2 slots more: 12 tNIGHT on Preprod) and records your operator on chain. The first time, the wallet also splits its NIGHT so that each fee can be paid with three DUST coins, which Midnight's current ledger needs for the larger calls. Allow 10 to 30 minutes.

## 5. Link your stake pool

Your operator takes its turn in committees once a stake pool on the contract's list vouches for it.

**On Preprod, with a test pool's key file** (put it in the `data` folder first, say as `data/pool.secret`):

```bash
docker compose run --rm operator link --pool-key /data/pool.secret
```

**With a real pool's key**, in two steps, so the pool's key never comes near the operator:

```bash
docker compose run --rm operator link --pool <the pool's public key, or its .vkey file>
```

This prints 32 bytes (as hex) for the pool's key to sign: they name this contract, your operator, and how long the signature is good for (24 hours). Sign them as raw bytes with the pool's Ed25519 key, wherever that key is kept, then:

```bash
docker compose run --rm operator link --signature <the 64-byte signature, as hex>
```

The signature is checked before anything is sent. Linking makes the largest proof (about 2 minutes, 5 GB of memory).

## 6. Start it

```bash
docker compose up -d
docker compose logs -f operator
```

(`Ctrl-C` leaves the log; the operator keeps running.) It starts on its own when the machine restarts, and when it loses the network it stops itself and is started again, carrying on from what the chain shows.

What you'll see in the log: `nothing to do: watching the chain` most of the time, then lines starting `ok` for each call it sends, with how long its proof took.

## Day to day

| To | Run |
|---|---|
| See your operator as the chain shows it: bond, earnings, seats, misses | `docker compose run --rm operator status` |
| See the wallet's NIGHT and DUST | `docker compose run --rm operator wallet` |
| Add bond (if you were fined below the minimum) | `docker compose run --rm operator topup --slots 2` |
| Collect earnings now (it does this by itself from 1 tNIGHT) | `docker compose run --rm operator claim` |
| Stop being chosen for new committees | `docker compose run --rm operator leave` |
| Take bond back (all of it: one epoch length after leaving) | `docker compose run --rm operator withdraw --slots 2` or `--all` |
| Send tNIGHT out of the operator's wallet | `docker compose run --rm operator send --to <address> --amount <tNIGHT>` |
| Stop the operator / start it again | `docker compose stop` / `docker compose up -d` |
| Update to a new version | `git pull`, then `docker compose build` and `docker compose up -d` |

`status` can be run while the operator runs. The others use the wallet, so they wait for the running operator, or ask you to stop it first (`docker compose stop operator`, then `up -d` afterwards). Earnings and withdrawn bond go to the operator's own wallet.

After `leave`, keep the operator running until its last committee has finished: a seat already held keeps its duties, and missing them still costs bond.

## Fines and pay, on Preprod

- A request's fee (0.5 tNIGHT) is shared by the seats that answered before its deadline.
- A seat that doesn't answer in time when too few did loses 1 slot of bond; one that misses more than 3 answering times in an epoch is stood down.
- A seat that doesn't finish its part of a ceremony loses 2 slots.
- An operator whose bond falls below the minimum (10 slots) is stood down; `topup`, then `register` again.

## If something goes wrong

- **`stalled: ... Stopping, to be started again`** in the log: the wallet lost the network. Docker starts it again; nothing to do.
- **`waiting for DUST`**: the wallet needs more DUST for the next fee. It builds up from the wallet's NIGHT; more NIGHT makes it faster.
- **`402` or `Project Over Limit`**: your Blockfrost project has used its daily allowance (it resets at midnight UTC). Each operator should have its own project.
- **`the compiled contract here isn't the one on chain`**: run `keys` again.
- **`another process is using ...`**: the operator (or another command) is running; stop it first.
- Anything else: `docker compose logs --tail 100 operator`, and open an issue with what it says. Never paste the contents of `.env` or of a `.secret` file.

## Without Docker

With Node.js 22, in the repository's top folder: `npm ci`, `npm run compact:fast -w @nightcast/contract` (needs the Compact compiler: see [Midnight's docs](https://docs.midnight.network)), `npm run build`, `cd network && npm install`. Run a proof server yourself (`docker run -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2 midnight-proof-server`), put your Blockfrost project id in `NIGHTCAST_BLOCKFROST_PROJECT_ID`, and use `node network/threshold/ops/nightcast-operator.mjs` in place of `docker compose run --rm operator` (the folder is `~/.nightcast-operator`; `run` should then be kept going by systemd or similar, started again when it ends with code 75).
