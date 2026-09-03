# `shielded-night` image provenance

Everything this image runs comes from **one commit of one public first-party repository**,
plus **one SHA-256-pinned compiler release asset**, plus **three digest-pinned base images**.
Nothing else is fetched, and no source from that repository is copied into this one.

## What is pinned, and where the pin lives

| Thing | Identity | Where |
|---|---|---|
| dApp source | `effectstream/shielded-night` @ `30af63f3865d0bc5d5331ae32a7891ad48818303` (branch **`ledger-v9`**) | `SHIELDED_NIGHT_REF` — Dockerfile ARG default, `.env.example`, `compose/shielded-night.yml`, baked into both runtime images as `/.shielded-night-commit` |
| Compact compiler | `compactc` **0.34.0** (language 0.26.0, runtime 0.19.0, ledger 9), Linux musl release asset, SHA-256 per architecture | `COMPACT_VERSION`, `COMPACT_SHA256_AMD64`, `COMPACT_SHA256_ARM64` — Dockerfile ARG defaults |
| Base images | `debian:trixie-slim`, `oven/bun:1.4.0`, `nginx:1.27-alpine` — all by index digest | `DEBIAN_BASE`, `BUN_BASE`, `NGINX_BASE` |
| npm dependencies | `bun.lock` + `frontend/bun.lock` at the pinned commit, installed `--frozen-lockfile` | the pinned tree |

`git fetch --depth 1 origin <sha>` is used, and the fetched `FETCH_HEAD` is compared to the
requested SHA. An abbreviated ref is refused by the Dockerfile before the fetch, because
`ledger-v9` is a live branch: an image that could resolve a *branch name* would silently change
what it builds the next time somebody pushed.

**Why `BUN_BASE` moved from 1.3.11 to 1.4.0 (project 00007, question Q13):** the pinned
`ledger-v9` head at `30af63f3…` merged in shielded-night `main`'s own PR #12, which regenerated
`bun.lock` and `frontend/bun.lock` with bun 1.4.0. Bun 1.4 writes `"lockfileVersion": 2`, and bun
1.3.x cannot parse that format at all — `bun install --frozen-lockfile` on 1.3.11 against either
lockfile now exits 1 with `error: Unknown lockfile version` before it reads a single package.
`BUN_BASE` and the pinned source tree must therefore move together: this image's two
`bun install --frozen-lockfile` calls (stage `build`, root and `frontend/`) would otherwise fail
outright the moment `SHIELDED_NIGHT_REF` pointed at any bun-1.4-generated lockfile. The kernel
and zswap-da images are unaffected and keep their own bun pins — this is scoped to
`images/shielded-night` alone, the only image that installs from this dependency tree.

## Why this repository pins a branch and not `main`

`effectstream/shielded-night`'s `main` is the Midnight **1.x / ledger-v8** line — that is what
its live preview deployment runs, and it is what the sibling repository `midnight-1-offers`
pins for the same profile. This stack is **2.x**: node 2.0.0-rc.4, indexer 4.4.0-rc.3,
proof-server 9.0.0-rc.5, ledger 9. The `ledger-v9` branch is the port; its own CI runs the unit
tier, the frontend build, the byte-exact contract rebuild and the full integration suite
against exactly this triple.

Because *only the pin* distinguishes the two images, the pin is not trusted. Stage `source`
asserts the line in both directions, in both packages **and in both resolved lockfiles**:

* `@midnightntwrk/ledger-v9` is `1.0.0-rc.3` in `package.json` and `frontend/package.json`;
* `@midnight-ntwrk/compact-runtime` is `0.19.0` in both;
* neither `package.json` **depends on** `@midnight-ntwrk/ledger-v8`;
* neither `bun.lock` **resolves** `ledger-v8` at all, and both resolve `ledger-v9`.

The lockfile half is the one that matters: a `package.json` grep only sees what was asked for,
while a stray transitive ledger-v8 would appear in the resolved tree — and two ledger wasm
instances in one process fail each other's `instanceof` checks during proving, hours later and
nowhere near the cause.

## No patch of any kind

The three things a compose-hosted deployment needs from this dApp live **upstream**, not as
patches here (project 00007, question Q2 → owner decision A):

1. a **runtime contract-address override** — `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS` wins
   over the build-time `<NETWORK>_ADDRESS`, resolved per call by
   `frontend/src/lib/runtime-config.ts`;
2. **env-overridable `undeployed` endpoints** — `MN_INDEXER_URL`, `MN_INDEXER_WS_URL`,
   `MN_NODE_URL`, `MN_PROOF_SERVER_URL` in `test/support/network.ts`, which is what lets a
   container dial `http://node:9944` instead of `127.0.0.1`;
3. an **external-stack mode** for the integration suite — `MN_EXTERNAL_STACK=1` in
   `test/integration/global-setup.ts`, which is what makes the repository's *own* round-trip
   tests this profile's verification gate rather than a transcription of them.

Plus the deploy record (`DEPLOY_OUT`, `scripts/deploy-record.ts`) and the no-op
`frontend/public/config.js` placeholder that `index.html` already loads as a classic script.
The build **asserts every one of them is present in the pinned tree**, so a re-pin to a tree
without them fails the build rather than shipping a page that can never learn its address.

## The contract is recompiled, not trusted

`src/managed/` is committed upstream and its CI proves the artifacts are byte-exact for
compactc 0.34.0. This image reproduces that proof instead of relying on it: stage `compact`
fetches the pinned compiler by SHA-256, compiles `src/shielded-night.compact` into an **empty**
directory with the same invocation and the same working directory upstream uses, and then
`diff -r`s the result against the committed tree. Any difference fails the build.

Two details are load-bearing and were learned the expensive way:

* **the source path is part of the output** — compactc records the input path verbatim in
  `contract/index.js.map` (`sourceRoot`, `sources`), so the compile must be run from the
  repository root as `src/shielded-night.compact`, exactly as upstream does. Anything else
  produces artifacts identical in every ZK key and different in two lines of the map;
* **`compiler/contract-manifest.json` is not decorative on this line.** compactc emits it from
  0.33 onwards, and midnight-js 5's `FetchZkConfigProvider` verifies every fetched artifact
  against it with integrity checking defaulting to *require* — fail-closed. The build asserts
  the manifest is produced and that it reaches `dist/`, and `scripts/verify-shielded-night.sh`
  asserts the running page serves it.

`./verify.sh` then closes the loop from the other end: the **on-chain** verifier keys of the
contract this stack deployed are compared byte-for-byte with the keys this image serves, 11 of
11, none missing and none extra.

## What is NOT pinned

npm's transitive graph beyond the lockfiles, and the GitHub/npm endpoints themselves. Both
installs are `--frozen-lockfile`, so a dependency publishing a new version is a **build
failure**, not a silent difference.
