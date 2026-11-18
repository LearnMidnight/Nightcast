# Nightcast on a VM

What runs Nightcast's oracle and the private MCP server (LunaSpin's requests) on a Linux VM, apart from
anything else on the machine. It lives in this repo, so an update to Nightcast brings its own service
files and proof-server version with it.

| Unit | What | Port |
|---|---|---|
| `nightcast-proof` | Midnight's proof server in Docker (`proof-server.sh`), image from `deploy/docker/proof-server.yml`, restarted when idle and over 3 GiB | 127.0.0.1:6303 |
| `nightcast-oracle` | `./nightcast oracle` for Preprod | (none) |
| `nightcast-mcp` | `./nightcast mcp`, private, for LunaSpin | 127.0.0.1:6350 |

Paths assume the checkout in `/root/Nightcast` and the secrets in `/root/lunardraw-secrets` and
`/root/nightcast-secrets`. Settings that differ per machine (bond, top-up, status files, stall limits,
`NIGHTCAST_PARALLEL` for the oracle, `NIGHTCAST_MCP_PARALLEL` for the MCP server, Blockfrost usage files) go in drop-ins under
`/etc/systemd/system/<unit>.service.d/`, which the update leaves alone.

## Updating

```
bash /root/Nightcast/deploy/vm/update.sh
```

It pulls `origin/main`, removes every `node_modules` (root and workspaces), runs `npm ci`, builds the
contract (when its compiled output is present), the sdk and deploy, checks Midnight's protocol modules
load, pulls the proof-server image, installs these unit files when they changed, and restarts the proof
server, the oracle and the MCP server. If the pull, install or build fails, it goes back to the commit it
started from, rebuilds that and restarts on it.

`bash /root/Nightcast/deploy/vm/update.sh --check` only reports whether the three services are up and the
proof server answers.

Two things it guards against, both from 18 Nov 2026: `npm ci` clears only the root `node_modules`, so old
packages left in `deploy/node_modules` were loaded first and broke the MCP server; and building only
`deploy` type-checks it against the sdk's old build.
