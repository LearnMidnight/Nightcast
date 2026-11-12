# Publishing to npm

`@nightcast/contract` and `@nightcast/sdk` are published from GitHub Actions ([publish.yml](../.github/workflows/publish.yml)), never from a laptop. The workflow compiles the contract with its proving keys, builds, tests, checks exactly which files would go out (`scripts/check-pack.mjs`: no secrets, tests or sources; the keys present), then publishes the contract and then the SDK **with npm provenance**: each version on npmjs.com shows the commit and workflow run that built it.

`@nightcast/deploy` (the `./nightcast` operator tool) stays in the repository for now: it relies on dependency overrides and a patch to Midnight's wallet that npm can't carry to someone installing it.

## How npm trusts the workflow

**Trusted publishing, stage only**, no token. On npmjs.com, each package's **Settings → Trusted publisher** is GitHub Actions, organisation `LearnMidnight`, repository `Nightcast`, workflow `publish.yml`, with *Allow npm publish* and *Allow npm dist-tag* **off**. So that workflow (which proves who it is with GitHub's OIDC token) can only **stage** a version, and it goes live when an owner approves it with 2FA. **Publishing access** is "Require two-factor authentication and disallow bypass 2fa tokens". Nothing secret exists to leak, and a compromised GitHub account alone can't release. Needs npm 11.15.0 or later, which the workflow installs.

History: 0.1.0 (2 Nov 2026) was the first release, so it couldn't use trusted publishing or a stage-only token (both need the package to exist already). It went out once with a granular token limited to `@nightcast`, deleted straight after. npm removes direct publishing with such tokens in January 2027 anyway. 0.2.0 (13 Nov 2026, the v1 contract) was the first release through trusted publishing.

If trusted publishing is ever unavailable, a **stage-only** granular token (as the NPM_TOKEN secret) works with the same workflow.

## Each release

1. Raise the version in `contract/package.json` and `sdk/package.json`, and the SDK's dependency on the contract to match (and `package-lock.json`'s entries), in a pull request. Merge it.
2. **Actions → Publish to npm → Run workflow** (branch `main`), with **Dry run** ticked. Read the log: the files of each package, their sizes, the verifier-key fingerprints, "will publish x.y.z".
3. Run it again with **Dry run** unticked. It stages both versions.
4. Approve them with 2FA: npmjs.com → your avatar → **Staged Packages** (or `npm stage approve <id>`). **The contract first, then the SDK**, which depends on it.
5. Check: `npm view @nightcast/sdk` and the package pages on npmjs.com (the provenance badge links to the run).

If a run stops part way (one package staged or public, the other not), run it again: it leaves out a version that's already public and stages the rest. A refusal that says `ENEEDAUTH` means that package has no trusted publisher on npmjs.com yet; each package needs its own.

npm only lets a version be withdrawn within 72 hours (`npm unpublish @nightcast/sdk@x.y.z`), and a version number can never be reused. Use `npm deprecate` with a message for anything later.
