# Nightcast for AI agents: the MCP server

`./nightcast mcp` makes Nightcast an [MCP](https://modelcontextprotocol.io) server. Any AI app or agent that speaks MCP can then get verifiable random values, and anyone can check them.

| Tool | What it does | Needs a wallet |
|---|---|---|
| `nightcast_about` | What Nightcast is, how to make a draw fair, and its limits | No |
| `nightcast_list_fingerprint` | The fingerprint of a list, to fix it before the draw | No |
| `nightcast_request_random` | Ask the oracle for a value, bound to a purpose and a seed | **Yes** (the server's) |
| `nightcast_check_request` | A request's status and answer, with the public checks | No |
| `nightcast_derive` | Turn an answer into an integer, a winner, several winners, an order, dice, a weighted pick or raw words | No |

A fair draw takes four calls:
1. `nightcast_list_fingerprint` with the entries;
2. `nightcast_request_random` with a purpose and the fingerprint as seed (publish the id now);
3. `nightcast_check_request` until it's fulfilled (1–3 minutes);
4. `nightcast_derive` with the output and the same list.

Anyone can repeat steps 3 and 4 and get the same winner. The id check (with purpose and seed) shows the list was fixed before the answer existed.

**Test network only.** It runs against the Preprod deployment (`deployments/preprod.json`). The values are real randomness, but tNIGHT has no value, and Nightcast is unaudited.

## On your own computer (stdio)

This works for Claude desktop, Claude Code, Cursor and other apps that start an MCP server themselves. From your clone of the repo, with a Blockfrost project id saved (`./nightcast blockfrost save --network preprod`):

```json
{
  "mcpServers": {
    "nightcast": {
      "command": "/path/to/Nightcast/nightcast",
      "args": ["mcp", "--network", "preprod"]
    }
  }
}
```

That's read-only: check and derive work, and requests don't.

To make requests too, add a wallet with tNIGHT and a requester secret:

```json
"args": ["mcp", "--network", "preprod",
         "--wallet", "/home/you/nightcast-secrets/mcp-wallet.secret",
         "--requester", "/home/you/nightcast-secrets/mcp-requester.secret",
         "--proof-server-port", "6300"]
```

- The requests are made from that wallet and need a proof server; `./nightcast doctor` checks it.
- The server answers at once, and the wallet opens in the background (minutes the first time). Until then, `nightcast_request_random` says it isn't ready.
- stdout carries only the protocol; the log goes to stderr.

## Hosting it for agents anywhere (HTTP)

```bash
./nightcast mcp --network preprod --http 127.0.0.1:6350 --trust-proxy \
  --wallet ~/nightcast-secrets/mcp-wallet.secret --requester ~/nightcast-secrets/mcp-requester.secret \
  --proof-server-port 6300
```

- **The address:** `POST /mcp` takes one JSON-RPC message and answers with JSON (MCP's Streamable HTTP transport, without sessions or event streams). `GET /health` reports `{ ok, network, contract, canRequest }`.
- **Limits:**
  - requests: 6 an hour per client (`--per-hour`) and 200 a day in all (`--per-day`), because each one is a transaction paid from the server's wallet;
  - 60 calls a minute per client;
  - 20 calls being answered at once;
  - 64 kB per message.
- **Origins:** browser pages on other sites are refused. `--origins https://a.example,https://b.example` allows some. Agents and AI apps send no Origin header and are always allowed.
- **Behind a proxy:** bind to `127.0.0.1` and put a TLS proxy in front. `--trust-proxy` makes the limits apply per real client (`X-Forwarded-For`). Only use it behind your own proxy. For Caddy:

  ```
  handle /nightcast/* {
      uri strip_prefix /nightcast
      reverse_proxy 127.0.0.1:6350
  }
  ```

- **Restarts:** a long-running wallet can stop following the chain after a dropped connection, and its fees are then refused (node error 170). The HTTP server exits with code 75 when the wallet's sync hasn't moved for 20 minutes, or after three requests in a row are refused for a stale fee. Run it under systemd with `Restart=always`:

  ```ini
  [Unit]
  Description=Nightcast MCP server
  After=network-online.target docker.service

  [Service]
  WorkingDirectory=/root/Nightcast
  ExecStart=/root/Nightcast/nightcast mcp --network preprod --http 127.0.0.1:6350 --trust-proxy --wallet /root/nightcast-secrets/mcp-wallet.secret --requester /root/nightcast-secrets/mcp-requester.secret --proof-server-port 6300
  Restart=always
  RestartSec=10

  [Install]
  WantedBy=multi-user.target
  ```

**Someone has to answer.** Requests are answered by the Nightcast oracle (`./nightcast oracle`) for the deployment's published key. A hosted MCP server is only useful while that oracle is running too.

**Use separate wallets.** The MCP server's wallet must not be used by any other program at the same time (the oracle, a keeper), or they spend the same coins and one gets stuck.

## What a hosted server can and can't do

- **It can't choose the answer.** The answer is fixed by the purpose, the seed and the oracle's key, and the network checks the oracle's proof. With your own seed (a list fingerprint), the server can't steer anything; without one, it picks a random seed for you. Either way it doesn't know the answer in advance, unless it also holds the oracle's secret.
- **It can refuse to submit, or run out of requests.** You'll see it at once: `nightcast_request_random` returns an error, or `nightcast_check_request` finds no request.
- **Everything is public:** purpose, seed, id and output. Never put secrets in them.
- **All requests come from one requester.** If two agents ask with the same purpose and seed, they get the same request id, and so the same answer. Use a purpose that names your draw.

## Payment (later)

Issue #39 suggests charging per request (x402). That waits for request fees in the contract (#13), and for a way to pay on Midnight. For now a hosted server is free and limited by the counts above.
