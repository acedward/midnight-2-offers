# offerfiles-kernel — the zswap offer-files kernel running in EXTERNAL-STACK
# mode against this compose stack's node/indexer/proof-server and Celestia
# devnet.
#
# ONE IMAGE, SEVERAL CONTAINERS: the sync node (:9999), the balancing batcher
# (:3334), the offer poster, the solver monitor site and the price feed each run
# this image with their own entrypoint. See the entrypoint block near the bottom.
#
# Source: effectstream/zswap-offerfiles-kernel, pinned to the UNIFIED ledger-v9
# line — PR #65 (branch `ledger-v9`; the SHA is the identity, not the branch).
# KERNEL_REF defaults to exact commit
# 5d794f9a27f6d65529bf176650405f740531d430, the head after `main` was merged into
# `ledger-v9` (kernel PR #71). It carries the v9 migration, the offer-update WS
# route the solver consumes, the token price service (`asset_prices`,
# /v1/prices, /v1/quote, the batcher sponsorship gate), the solver status
# listener + monitor site, the offer poster — and, new at this pin, the REMOVAL
# of the offer-files contract (kernel PRs #69/#70). The resolved commit is baked
# at /app/.kernel-commit and asserted by the provenance gate.
#
# ── THERE IS NO COMPACT COMPILATION IN THIS IMAGE ANY MORE ──────────────────
# It used to have a dedicated `compact` stage: fetch compactc at the version the
# pinned kernel tree declared (`infra/compact-version.txt`), verify the release
# asset against `infra/compact-checksums.sha256`, compile
# `packages/contracts-midnight/contract-offer-files/src/offer-files.compact` and
# copy the generated `src/managed` into the runtime layer. Every input to that
# stage is GONE upstream: PR #70 deleted the whole compactc install stage from
# the kernel's OWN Dockerfile, deleted `packages/contracts-midnight`, deleted
# `scripts/check-compact-artifacts.ts` and the `check:compact-artifacts` script,
# and dropped the `compact-compile` CI job. `grep -rn mint_shielded` on the
# pinned tree hits only a historical-record banner in LEDGER-V9-MIGRATION.md, and
# the kernel's own CI asserts `test ! -e /app/packages/contracts-midnight` inside
# the built image.
#
# So a fresh clone now builds this image with ZERO Compact compilation, which is
# spec SC-001. `infra/compact-version.txt` and `infra/compact-checksums.sha256`
# are still IN the pinned tree but orphaned there; this repo still reads them —
# from images/aa-contracts, which does compile Compact — and that is a deliberate
# choice recorded in that Dockerfile, not an accident of them existing.
#
# What survives is the RUNTIME pin, and it is the tree's own gate rather than a
# number restated here: `bun run check:compact-runtime` asserts the resolved
# lockfile carries exactly one `@midnight-ntwrk/compact-runtime` locator and that
# every manifest plus the root override pins that exact version. It needs Bun
# >= 1.3.11 (`Bun.JSONC.parse`), which the build stage below is.
#
# Like images/umbra-evm, built from a REMOTE clone so
# `git clone <this repo> && ./up.sh --with offerfiles` works with nothing else
# checked out.
#
# WHY NO ORCHESTRATOR AT ALL. `bun run dev`'s launchMidnight() launches its own
# devnet unconditionally AND declares stopProcessAtPort [9944, 8088, 6300] —
# pointed at a live stack it would first kill the listeners it was meant to use
# (measured 2026-08-25, master-plan T4.3). `start.external.ts` fixed that by
# launching only the kernel's own processes, but kept the orchestrator shape:
# six processes in one container, and a contract re-deploy on every recreate.
# Phase 11 dropped the orchestrator entirely. The repo's real entrypoints —
# `packages/node/main.dev.ts` and `packages/batcher/batcher.dev.ts` — are each
# a single-process `bun run`, and preflight-external runs per container instead
# of once as a service.
#
# `*.dev.ts` and not `*.mainnet.ts`: the mainnet variants are hard-gated —
# config.mainnet.ts and batcher.mainnet.ts both throw unless
# CELESTIA_NETWORK=mainnet — and this stack is a devnet. "dev" in those names
# is the target network, not a multi-process launcher.

ARG KERNEL_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG KERNEL_REF=5d794f9a27f6d65529bf176650405f740531d430
# ── stage 1: fetch the kernel source ─────────────────────────────────────────
FROM debian:stable-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG KERNEL_REPO
ARG KERNEL_REF

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$KERNEL_REPO" \
 && git fetch -q --depth 1 origin "$KERNEL_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /kernel-commit \
 && rm -rf .git

# ── stage 2: the runtime image ───────────────────────────────────────────────
# Bun is PINNED to the version the whole migration was validated with. Newer
# is not safer here: bun 1.3.14 fails `midnight-contract:deploy` with
# `require() async module ".../graphql/index.mjs" is unsupported` (graphql-tag
# UMD require()ing the ESM graphql 17), which bun 1.3.11 handles. Bump only
# with a full stack bring-up as the gate.
FROM oven/bun:1.3.11

WORKDIR /app
COPY --from=source /src /app
COPY --from=source /kernel-commit /app/.kernel-commit

# Workspace install. Frozen: the lockfile in the branch IS the tested set.
RUN bun install --frozen-lockfile

# ONE compact-runtime. Nothing in THIS image compiles or loads a generated
# contract module any more, so this is no longer about `checkRuntimeVersion()`
# failing at contract-load time (issues/00011) — it is the pin invariant itself:
# the tree's own gate asserts the resolved lockfile carries exactly one
# `@midnight-ntwrk/compact-runtime` locator and that every manifest plus the root
# override pins that exact version. It is kept because it is the ONE compact fact
# still live upstream after PR #70, it costs a second, and it is the tree's own
# script — so it moves with the pin instead of restating a number here. It also
# records, in the build log, the runtime version images/aa-contracts must agree
# with. (It needs Bun >= 1.3.11 for `Bun.JSONC.parse`; this base is 1.3.11.)
RUN bun run check:compact-runtime \
 && bun -e 'const p = await Bun.file("/app/package.json").json(); const v = (p.overrides ?? p.resolutions ?? {})["@midnight-ntwrk/compact-runtime"]; if (!v) { console.error("the pinned kernel root manifest declares no @midnight-ntwrk/compact-runtime override"); process.exit(1); } await Bun.write("/app/.compact-runtime-version", v + "\n"); console.log("kernel compact-runtime pin: " + v);'

# ── one image, five entrypoints ──────────────────────────────────────────────
# This image does not run the orchestrator. `bunx orchestrator start
# start.external.ts` put six processes in one container AND re-deployed the
# offer-files contract on every recreate — three different contract addresses
# in one day, with the order book's identity resetting under it. Phase 11 split
# it; the contract itself is now gone from upstream as well.
#
#   kernel             the sync node (:9999). Its store is the shared
#                      `postgres` service, database `offerfiles` (T11.4).
#   batcher            the balancing batcher (:3334), alone.
#   offer-poster       LOOP (profile `poster`). Adopts one prefunded coin and
#                      posts one takeable offer per interval (00010 P3). It no
#                      longer mints: the coins come from the `faucet` profile.
#   solver-frontend    the COW solver's read-only monitor site (:8080), served
#                      by `compose/solver.yml` from this same image (00010 P2).
#   price-feed         LOOP (profile `prices`, compose/prices.yml). The daily
#                      CoinGecko refresh of `asset_prices`. Serves no port and
#                      talks to no Midnight service: it reads CoinGecko and
#                      writes the kernel's schema over the Postgres wire, and
#                      it is the ONLY process in this stack that holds a real
#                      secret (COINGECKO_API_KEY, .env only) (00010 P7).
#
# TWO ARE GONE with the contract: `entrypoint-deploy.sh` (deploy + mint) and
# `entrypoint-register-tokens.sh` (name WBTC/WETH/WUSD). The kernel has no
# contract to deploy and no mint circuit, and naming this stack's colours is
# `registry-bridge`'s job in compose/faucet.yml — from the registry the
# mint-test-tokens issuers publish, with the REAL per-token decimals.
#
# The last three run kernel-repo entrypoints that this image ALSO ships as its
# own scripts: the upstream copies under /app/deploy/images/kernel/ source an
# `entrypoint-common.sh` written for the kernel's own deployment (different
# volume paths), so this repo carries thin equivalents that use ITS conventions
# and exec the same upstream code.
#
# The two that need the external stack share entrypoint-common.sh: the Celestia
# token handoff, then preflight-external (T11.1 — a per-container fail-fast, not
# a service). `offer-poster`, `solver-frontend` and `price-feed` deliberately
# share none of it: the monitor must render an unreachable solver rather than
# refuse to start, the price feed touches neither Midnight nor Celestia, and the
# poster resolves its two token ids from the faucet registry instead.
#
# The Celestia auth-token handoff (offerfiles.yml note #1) is unchanged: the
# token does not exist until the celestia container initialises its bridge
# store, so it arrives on a read-only volume and anything compose already set
# wins over it.
COPY entrypoint-common.sh /usr/local/lib/offerfiles/entrypoint-common.sh
COPY entrypoint-kernel.sh entrypoint-batcher.sh \
     entrypoint-offer-poster.sh \
     entrypoint-solver-frontend.sh entrypoint-price-feed.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint-kernel.sh \
             /usr/local/bin/entrypoint-batcher.sh \
             /usr/local/bin/entrypoint-offer-poster.sh \
             /usr/local/bin/entrypoint-solver-frontend.sh \
             /usr/local/bin/entrypoint-price-feed.sh \
 # Kept as an alias so an older compose fragment (or a habit) still lands on
 # something that works — it is the sync node, which is what `kernel` meant.
 && ln -s /usr/local/bin/entrypoint-kernel.sh /usr/local/bin/kernel-entrypoint

# The contract era must not come back by accident. Upstream's own CI asserts the
# same absence inside its kernel image; this is the demo-side twin, and it is
# what makes "a fresh clone compiles no Compact for the kernel line" (spec
# SC-001) an assertion rather than a claim.
RUN set -eux; \
    test ! -e /app/packages/contracts-midnight; \
    test ! -x /usr/local/bin/compactc; \
    ! command -v compactc >/dev/null 2>&1

# :9999 sync-node API (GET /v1/health), :3334 batcher. Which one a container
# serves depends on the entrypoint compose selects.
EXPOSE 9999 3334

# No default: each service in compose/offerfiles.yml names its own entrypoint,
# and a container that starts the wrong process is worse than one that refuses.
ENTRYPOINT ["/usr/local/bin/entrypoint-kernel.sh"]
