# Publishing to npm

`@nightcast/contract` and `@nightcast/sdk` are published from GitHub Actions ([publish.yml](../.github/workflows/publish.yml)), never from a laptop. The workflow compiles the contract with its proving keys, builds, tests, checks exactly which files would go out (`scripts/check-pack.mjs`: no secrets, tests or sources; the keys present), then publishes the contract and then the SDK **with npm provenance**: each version on npmjs.com shows the commit and workflow run that built it.

`@nightcast/deploy` (the `./nightcast` operator tool) stays in the repository for now: it relies on dependency overrides and a patch to Midnight's wallet that npm can't carry to someone installing it.

## How npm trusts the workflow

**Trusted publishing**, no token. On npmjs.com, each package's **Settings → Trusted publisher** is set to GitHub Actions, organisation `LearnMidnight`, repository `Nightcast`, workflow `publish.yml`. npm then accepts a publish only from a run of that workflow (it proves who it is with GitHub's OIDC token), and nothing secret exists to leak. Needs npm 11.5.1 or later, which the workflow installs.

History: 0.1.0 (2 Nov 2026) was the first release, so it couldn't use trusted publishing or a stage-only token (both need the package to exist already). It went out once with a granular token limited to `@nightcast`, deleted straight after. npm removes direct publishing with such tokens in January 2027 anyway.

If trusted publishing is ever unavailable, a **stage-only** granular token is npm's fallback: the workflow runs `npm stage publish`, and an owner approves each staged version with `npm stage approve <id>` (2FA).

## Each release

1. Raise the version in `contract/package.json` and `sdk/package.json`, and the SDK's dependency on the contract to match (and `package-lock.json`'s entries), in a pull request. Merge it.
2. **Actions → Publish to npm → Run workflow** (branch `main`), with **Dry run** ticked. Read the log: the files of each package, their sizes, the verifier-key fingerprints, "will publish x.y.z".
3. Run it again with **Dry run** unticked.
4. Check: `npm view @nightcast/sdk` and the package pages on npmjs.com (the provenance badge links to the run).

npm only lets a version be withdrawn within 72 hours (`npm unpublish @nightcast/sdk@x.y.z`), and a version number can never be reused. Use `npm deprecate` with a message for anything later.
