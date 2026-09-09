# `shielded-night` image provenance

Everything this image runs comes from **one commit of one public first-party repository**,
plus **one SHA-256-pinned compiler release asset**, plus **four digest-pinned base images**.
Nothing else is fetched, and no source from that repository is copied into this one.

## What is pinned, and where the pin lives

| Thing | Identity | Where |
|---|---|---|
| dApp source | `effectstream/shielded-night` @ `1337afc35ac1e6089dcc5957feafdb2bdc3bf1a3` (branch **`main`**) | `SHIELDED_NIGHT_REF` — Dockerfile ARG default, `.env.example`, `compose/shielded-night.yml`, baked into both runtime images as `/.shielded-night-commit` |
| Compact compiler | `compactc` **0.34.0** (language 0.26.0, runtime 0.19.0, ledger 9), Linux musl release asset, SHA-256 per architecture | `COMPACT_VERSION`, `COMPACT_SHA256_AMD64`, `COMPACT_SHA256_ARM64` — Dockerfile ARG defaults |
| Base images | `debian:trixie-slim`, `node:24.15.0-trixie-slim`, `oven/bun:1.4.0`, `nginx:1.27-alpine` — all by index digest | `DEBIAN_BASE`, `NODE_BASE`, `BUN_BASE`, `NGINX_BASE` |
| npm dependencies | `bun.lock` + `frontend/bun.lock` (bun, `--frozen-lockfile`) and `contracts/v2/package-lock.json` + `frontend/protocols/{v1,v2}/package-lock.json` (npm, `ci`) at the pinned commit | the pinned tree |

`git fetch --depth 1 origin <sha>` is used, and the fetched `FETCH_HEAD` is compared to the
requested SHA. An abbreviated ref is refused by the Dockerfile before the fetch, because
`main` is a live branch: an image that could resolve a *branch name* would silently change
what it builds the next time somebody pushed.

**Why `BUN_BASE` is 1.4.0 and not 1.3.x (project 00007, question Q13):** shielded-night's
`bun.lock` and `frontend/bun.lock` are written by bun 1.4.0, i.e. `"lockfileVersion": 2`, and
bun 1.3.x cannot parse that format at all — `bun install --frozen-lockfile` on 1.3.11 exits 1
with `error: Unknown lockfile version` before it reads a single package. `BUN_BASE` and the
pinned source tree therefore move together. The kernel and zswap-da images are unaffected and
keep their own bun pins — this is scoped to `images/shielded-night` alone.

**Why there is a `NODE_BASE` at all, new at this pin.** On `main` the 2.x tree is a **node/npm**
package: `contracts/v2` runs `node --import tsx scripts/deploy.ts` and `vitest`, and both
`frontend/protocols/{v1,v2}` are npm packages with their own lockfiles. `oven/bun` ships no
node, so the `build` and `deploy` stages are based on the same digest-pinned
`node:24.15.0-trixie-slim` that `images/mint-test-tokens` uses, with the **bun binary copied in**
from the digest-pinned `oven/bun` index (bun is one static executable, and both bases are Debian
trixie). Node 24.15.0 satisfies every `engines` field in the pinned tree (`>= 22.12`).

## Why this repository now pins `main`

This stack is **2.x** on the `undeployed` network: node 2.0.0-rc.4, indexer 4.4.0-rc.3,
proof-server 9.0.0-rc.5, ledger 9. Until 2026-09-09 no line of this dApp could serve that
combination on `main`, and this image tracked the long-lived `ledger-v9` branch instead.

Upstream [PR #16](https://github.com/effectstream/shielded-night/pull/16) (`main` @
`1337afc35ac1e6089dcc5957feafdb2bdc3bf1a3`, merged 2026-09-09) changed that. It made
`undeployed` protocol-selectable in the three places that decide it:

* `contracts/v2/scripts/profile.ts` gained an `undeployed()` profile — `networkId` and
  `walletNetworkId` `undeployed`, all five `MN_*_URL` endpoints overridable, and the
  maintenance signing key **ephemeral and optional** (on `stagenet` it stays mandatory,
  absolute and on durable storage);
* `contracts/v2/scripts/{deploy,verify-deployment}.ts` accept `MN_ENV=undeployed`, with
  `stagenet` still the default so nothing moved for upstream's own hosted deployment;
* `frontend/src/lib/runtime-config.ts` gained `UNDEPLOYED_PROTOCOL` (`midnight-1.x`, the
  default, or `midnight-2.x`) — build-time env **or** `window.SHIELDED_NIGHT`, with the runtime
  value winning — which `networks.ts` turns into the v2 adapter and the label
  `Local (undeployed · 2.x)`;
* `contracts/v2/test/external/` gained a 2.x counterpart of the `MN_EXTERNAL_STACK` round-trip
  suite, which is what `./verify.sh` runs as this profile's gate.

That is exactly what infra project 00017's question Q15 asked for (option A: do the missing work
upstream rather than patch a third-party tree here), so the `ledger-v9` branch pin is retired.

### `main` is TWO trees, and only one of them is ours

Since upstream PR #13 the repository carries both generations, protocol-isolated:

| | source | compiler | ledger | package manager |
|---|---|---|---|---|
| **1.x** | root `src/`, `frontend/`, `frontend/protocols/v1` | compactc 0.31.1 → `src/managed/` | `@midnight-ntwrk/ledger-v8`, compact-runtime 0.16.0 | bun |
| **2.x** | `contracts/v2/`, `frontend/protocols/v2` | compactc 0.34.0 → `contracts/v2/managed/` | `@midnightntwrk/ledger-v9` 1.0.0-rc.3, compact-runtime 0.19.0 | npm |

So the ledger-v8 packages **are** in this tree and must be. The image's old blanket assertion
("`ledger-v8` appears in neither lockfile") would be false at this pin, and it is replaced by
the property that actually matters — **separation**. Stage `source` asserts, for each of
`contracts/v2` and `frontend/protocols/v2`:

* it has its **own** `package.json` and `package-lock.json` (its own physical `node_modules`,
  which is what `frontend/vite.config.ts`'s per-profile runtime resolution depends on);
* `@midnightntwrk/ledger-v9` is pinned `1.0.0-rc.3` and `@midnight-ntwrk/compact-runtime`
  `0.19.0`;
* it does **not depend on** `@midnight-ntwrk/ledger-v8`;
* its `package-lock.json` **resolves** no `ledger-v8` at all, and does resolve `ledger-v9`.

The lockfile half is the one that matters: a `package.json` grep only sees what was asked for,
while a stray transitive ledger-v8 would appear in the resolved tree — and two ledger wasm
instances in one process fail each other's `instanceof` checks during proving, hours later and
nowhere near the cause.

## No patch of any kind

The things a compose-hosted deployment needs from this dApp live **upstream**, not as patches
here (project 00007, question Q2 → owner decision A; infra 00017 Q15 → upstream project 00008):

1. a **runtime contract-address override** — `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS` wins
   over the build-time `<NETWORK>_ADDRESS`, resolved per call by
   `frontend/src/lib/runtime-config.ts`;
2. a **runtime protocol switch** — `window.SHIELDED_NIGHT.UNDEPLOYED_PROTOCOL`, same lane, same
   precedence. Without it the page would load the ledger-v8 adapter against this ledger-9
   chain: it would connect, and then fail every call with an error naming none of this;
3. **env-overridable `undeployed` endpoints** — `MN_INDEXER_URL`, `MN_INDEXER_WS_URL`,
   `MN_NODE_URL`, `MN_NODE_WS_URL`, `MN_PROOF_SERVER_URL` in
   `contracts/v2/scripts/profile.ts`, which is what lets a container dial `http://node:9944`
   instead of `127.0.0.1`;
4. an **external-stack mode** for the round-trip suite — `MN_EXTERNAL_STACK` in
   `contracts/v2/test/external/global-setup.ts`, plus `CV_ADDRESS` so the suite **joins** the
   contract this stack deployed instead of deploying one of its own. That is what makes the
   repository's *own* round-trip tests this profile's verification gate rather than a
   transcription of them.

Plus the deploy record (`DEPLOY_OUT`, honoured by `recordPath()` in `contracts/v2/scripts/
profile.ts`) and the no-op `frontend/public/config.js` placeholder that `index.html` already
loads as a classic script. The build **asserts every one of them is present in the pinned
tree**, so a re-pin to a tree without them fails the build rather than shipping a page that can
never learn its address or, worse, one that learns it and speaks the wrong ledger.

### What the deploy one-shot adds on top, and why it is not a patch

Two things this deployment needs are, by upstream's own design, the caller's job:

* **resumability.** `deploy:v2` always deploys a NEW contract — upstream states this outright
  ("Resumability belongs to the caller: a compose entrypoint that reads its own `contract.json`
  and joins the address already there"). `entrypoint-deploy.sh` is that caller: the presence of
  `contract.json` on the shared volume is the "already deployed" flag;
* **the flat record shape.** The v2 record names things `contractAddress`, `network.networkId`,
  `sourceCommit` and `metadata.{name,symbol,decimals}`. The one-shot publishes the whole
  upstream record **plus** five flat aliases (`address`, `networkId`, `name`, `symbol`,
  `decimals`, `commit`) and the deployer's role, so this repository's own consumers are
  unchanged. Nothing upstream wrote is dropped or rewritten.

## The v2 contract is recompiled, not trusted — and the v1 one is not compiled at all

`contracts/v2/managed/` is committed upstream and its `reproducible-build-v2` CI job proves the
artifacts are byte-exact for compactc 0.34.0. This image reproduces that proof instead of
relying on it: stage `compact` fetches the pinned compiler by SHA-256, compiles
`contracts/v2/shielded-night.compact` into an **empty** directory with the same invocation and
the same working directory upstream uses, and then `diff -r`s the result against the committed
tree. Any difference fails the build.

Two details are load-bearing and were learned the expensive way:

* **the source path is part of the output** — compactc records the input path verbatim in
  `contract/index.js.map` (`sourceRoot`, `sources`), so the compile must be run from the
  repository root as `contracts/v2/shielded-night.compact`, exactly as upstream's `compact:v2`
  script does. Anything else produces artifacts identical in every ZK key and different in two
  lines of the map;
* **`compiler/contract-manifest.json` is not decorative on this line.** compactc emits it from
  0.33 onwards, and midnight-js 5's `FetchZkConfigProvider` verifies every fetched artifact
  against it with integrity checking defaulting to *require* — fail-closed. The build asserts
  the manifest is produced and that it reaches `dist/`, and `scripts/verify-shielded-night.sh`
  asserts the running page serves it.

**The 1.x contract (`src/managed/`, compactc 0.31.1) is shipped exactly as committed.** It is
copied into the built site by `frontend/vite.config.ts` as `contract/v1/shielded-night` and as
the legacy `contract/compiled/shielded-night`, and this stack never selects a 1.x network.
Recompiling it would put a SECOND compiler in this image — which is precisely what this
repository's one-toolchain rule exists to prevent — in order to verify a lane nothing here uses.
It is therefore trusted-as-committed and named as such, rather than silently reproduced.

**Which URL the browser fetches from matters because of that split.** The 2.x adapter reads
`/contract/v2/shielded-night/…`; `/contract/compiled/…` is the v1 copy on this line. The
compose healthcheck and `scripts/verify-shielded-night.sh` both moved to `/contract/v2/` at this
pin — probing the legacy path would have tested the wrong generation, and would have failed on
the manifest anyway, since 0.31.1 emits none.

`./verify.sh` then closes the loop from the other end: the **on-chain** verifier keys of the
contract this stack deployed are compared byte-for-byte with the keys this image serves, 11 of
11, none missing and none extra, and the upstream round-trip suite is run against that same
contract.

## What is NOT pinned

npm's transitive graph beyond the lockfiles, and the GitHub/npm endpoints themselves. All five
installs are frozen (`bun install --frozen-lockfile` × 2, `npm ci` × 3), so a dependency
publishing a new version is a **build failure**, not a silent difference.
