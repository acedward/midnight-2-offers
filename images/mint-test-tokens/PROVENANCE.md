# `mint-test-tokens` image provenance

Everything this image runs comes from **one commit of one public first-party repository**,
plus **two digest-pinned base images**. Nothing else is fetched, no source from that repository
is copied into this one, and — uniquely among this stack's from-source images — **no compiler
runs here at all**.

## What is pinned, and where the pin lives

| Thing | Identity | Where |
|---|---|---|
| Issuer + site source | `effectstream/mint-test-tokens` @ `a51cf3ad46520d1ded938fb86db8b7b99373ce56` (branch **`main`**, the merge of PR #4) | `MINT_TEST_TOKENS_REF` — Dockerfile ARG default, `.env.example`, `compose/faucet.yml`, `scripts/verify-source-pins.sh`, baked into both runtime images as `/.mint-test-tokens-commit` |
| Client-artifact history | `418cce599bc1f712ba1a0d277765f96e2f693e27` (v1), `fdf0739cf2d342b283187ef8304a1784c7ec6bc2` (v2) | `MINT_TEST_TOKENS_CLIENT_V1_REV` / `_V2_REV` — Dockerfile ARG defaults, asserted against `frontend/client-artifacts.json` at the pin |
| Base images | `debian:trixie-slim`, `node:24.15.0-trixie-slim` — both by index digest | `DEBIAN_BASE`, `NODE_BASE` |
| npm dependencies | `package-lock.json` at the pinned commit for each of the five install contexts, installed with `npm ci` | the pinned tree |

`git fetch --depth 1 origin <sha> <sha> <sha>` is used and `git rev-parse HEAD` is compared to
the requested SHA after checkout. An abbreviated ref is refused before the fetch, because
`main` is a live branch: an image that could resolve a *branch name* would silently change what
it builds the next time somebody pushed.

## Why the fetch names THREE commits

`frontend/scripts/verify-client-artifacts.mjs` runs on every `frontend` build, test and
typecheck. It hashes the tracked issuer artifacts on disk, hashes the same directories **out of
Git at the two revisions recorded in `frontend/client-artifacts.json`**, and requires all three
digests to agree — so the bundled browser artifacts can be traced to an immutable commit rather
than to whatever happened to be in the working tree. Those two revisions are *history*: a plain
`git fetch --depth 1 origin <pin>` does not contain them, and the build fails inside `git
ls-tree` with a message naming neither the pin nor the manifest.

They are therefore fetched explicitly, as build args, and stage `source` asserts that
`frontend/client-artifacts.json` at the pin still names exactly those two revisions. Measured:
one fetch, three shallow commits, **33 MB in about 3 s**.

## Why NO compiler runs in this image

Every other from-source image in this stack (`images/shielded-night`, `images/zswap-da`,
`images/offerfiles-kernel`, `images/aa-contracts`) downloads a SHA-256-pinned `compactc`
release asset, recompiles the contract and asserts the output is byte-identical to what the
pinned tree committed. **This image must not**, and that is a stronger position rather than a
weaker one.

`contracts/v2/managed/` is **tracked upstream** — 91 files, 62 MB, stamped compiler 0.34.0 /
language 0.26.0 / runtime 0.19.0 — and the deploy runner's own provenance gate
(`resolveReproducibleSourceRevision`) requires the bytes on disk under

```
contracts/v2/shielded-token.compact
contracts/v2/unshielded-token.compact
contracts/v2/managed/shielded
contracts/v2/managed/unshielded
```

to equal the bytes at the resolved commit, with **no modified, untracked or ignored file**
under any of them. A recompile into that tree would not merely be redundant: even a
byte-identical rebuild that touched an mtime is fine, but any difference at all — a stray
`.DS_Store`, a compiler that emits its input path into a source map, a version drift — makes
the tool this image exists to run refuse to deploy.

So the upstream check is *stricter* than a rebuild-and-diff: it proves the artifacts are the
ones a third party can fetch from a named commit, not merely that they can be reproduced.
Stage `source` asserts the artifacts ARE tracked and DO carry the declared toolchain, and stage
`build` then **runs that provenance gate itself**, at build time, so a tree that would fail at
bring-up fails in seconds instead of after a chain, an indexer and a prover have come up.

Consequence worth stating plainly: `docs/ARTIFACT-DECISIONS.md`'s "build from source only when
no reusable artifact exists" rule is satisfied here by the *upstream commit* being the
reusable, verifiable artifact — the same reasoning `sources[minocrab-release]` records for the
AA image's published ZK keys.

## Why the PLAIN proof server

`contracts/v2/managed/*/zkir/*.zkir` declare `"version": {"major": 2}` — zkir-v2, the default
compiler lane, the same one the offer-files kernel's `[v6]` verifier keys use. The stack's
`aa-proof-server` is the **experimental** build, and it exists solely for the AA contracts'
`--feature-zkir-v3` `[v7]` keys. `compose/faucet.yml` therefore dials core's plain
`proof-server:6300`, and the Dockerfile asserts the zkir major version so a re-pin whose
artifacts moved lanes fails at build time rather than as an unprovable mint.

## What each runtime target carries

| Target | Carries | Does not carry |
|---|---|---|
| `runner` | the tree **and its `.git`**, root + `contracts/v2` `node_modules`, `git`, `postgresql-client` | the frontend, any built page, any seed |
| `site` | `frontend/dist` and upstream's `frontend/scripts/serve-static.mjs` | `.git`, `node_modules`, any seed, any chain endpoint |

`.git` in the runner target is **load-bearing**, not an oversight: the provenance gate above
shells out to `git rev-parse`, `git diff`, `git ls-files`, `git ls-tree` and `git show` on
every deploy and every verify. `git config --system --add safe.directory /app` is set in both
the build and runner stages so a future non-root runtime does not fail with "dubious ownership"
— a message about permissions, for a check about bytes.

## The six tokens

| Symbol | Name | Decimals | Privacy |
|---|---|---|---|
| `twBTC` | Test-wrapped BTC | 8 | shielded |
| `twETH` | Test-wrapped ETH | 18 | shielded |
| `twUSDC` | Test-wrapped USDC | 6 | shielded |
| `twUSDM` | Test-wrapped USDM | 6 | shielded |
| `utwUSDC` | Unshielded-test-wrapped USDC | 6 | unshielded |
| `utwBTC` | Unshielded-test-wrapped BTC | 8 | unshielded |

**These are NOT 6 decimals across the board**, which every earlier faucet in this repository
was. `twBTC`/`utwBTC` are 8 and `twETH` is 18 — the canonical scales of the assets they stand
in for. The kernel's `known_tokens.decimals` column takes 0–38 and the registry bridge sends
each token's real value explicitly, so nothing downstream inherits the old `DEFAULT 6`.

The token *colour* is the contract-address-derived `tokenId` the registry records, so it
changes on every fresh chain — which is exactly why the six rows are bridged into the kernel at
bring-up instead of seeded into its schema.

## What is NOT fetched

No compiler. No proving-key download. No `metadata.undeployed.json`: that file is per-stack
state, published by the deploy one-shot onto a named volume, and the build asserts it did not
end up inside `frontend/dist`.
