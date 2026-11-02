# Publishing to npm

`@nightcast/contract` and `@nightcast/sdk` are published from GitHub Actions ([publish.yml](../.github/workflows/publish.yml)), never from a laptop. The workflow compiles the contract with its proving keys, builds, tests, checks exactly which files would go out (`scripts/check-pack.mjs`: no secrets, tests or sources; the keys present), then publishes the contract and then the SDK **with npm provenance**: each version on npmjs.com shows the commit and workflow run that built it.

`@nightcast/deploy` (the `./nightcast` operator tool) stays in the repository for now: it relies on dependency overrides and a patch to Midnight's wallet that npm can't carry to someone installing it.

## One-time setup

1. On npmjs.com, as an owner of the `nightcast` organisation: **Access Tokens → Generate New Token → Granular Access Token**.
   - Name: `nightcast-github-publish`. Expiry: 30–90 days.
   - Packages and scopes: **Read and write**, only the `@nightcast` scope.
   - Organisations: no access.
2. On GitHub: **LearnMidnight/Nightcast → Settings → Secrets and variables → Actions → New repository secret**. Name `NPM_TOKEN`, value the token. Don't paste it anywhere else.

Later, once the packages exist, npm's *trusted publishing* can replace the token (each package's settings → Trusted publisher → GitHub Actions, this repository, `publish.yml`); then delete the secret.

## Each release

1. Raise the version in `contract/package.json` and `sdk/package.json`, and the SDK's dependency on the contract to match (and `package-lock.json`'s entries), in a pull request. Merge it.
2. **Actions → Publish to npm → Run workflow** (branch `main`), with **Dry run** ticked. Read the log: the files of each package, their sizes, the verifier-key fingerprints, "will publish x.y.z".
3. Run it again with **Dry run** unticked.
4. Check: `npm view @nightcast/sdk` and the package pages on npmjs.com (the provenance badge links to the run).

npm only lets a version be withdrawn within 72 hours (`npm unpublish @nightcast/sdk@x.y.z`), and a version number can never be reused. Use `npm deprecate` with a message for anything later.
