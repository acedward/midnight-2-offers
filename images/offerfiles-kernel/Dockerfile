# offerfiles-kernel — the zswap offer-files kernel running in EXTERNAL-STACK
# mode against this compose stack's node/indexer/proof-server and Celestia
# devnet.
#
# ONE IMAGE, THREE CONTAINERS (demo-infra Phase 11): the sync node (:9999), the
# balancing batcher (:3334) and a deploy one-shot each run this image with their
# own entrypoint. See the entrypoint block near the bottom.
#
# Source: effectstream/zswap-offerfiles-kernel, pinned to the UNIFIED ledger-v9
# line — PR #65 (branch `ledger-v9`, draft at the time of pinning; the SHA is
# the identity, not the branch). It carries the v9 migration, the offer-update
# WS route the solver consumes, the token price service (`asset_prices`,
# /v1/prices, /v1/quote, the batcher sponsorship gate), the solver status
# listener + monitor site, and the offer poster.
# Like images/umbra-evm, built from a REMOTE clone so
# `git clone <this repo> && ./up.sh --with offerfiles` works with nothing else
# checked out. KERNEL_REF defaults to exact commit
# 80bace37bc2412542452e1c597761b2ebce5c677; the resolved commit is baked at
# /app/.kernel-commit and asserted by the provenance gate.
#
# WHY NO ORCHESTRATOR AT ALL. `bun run dev`'s launchMidnight() launches its own
# devnet unconditionally AND declares stopProcessAtPort [9944, 8088, 6300] —
# pointed at a live stack it would first kill the listeners it was meant to use
# (measured 2026-08-25, master-plan T4.3). `start.external.ts` fixed that by
# launching only the kernel's own processes, but kept the orchestrator shape:
# six processes in one container, and a contract re-deploy on every recreate.
# Phase 11 drops the orchestrator entirely. The repo's real entrypoints —
# `packages/node/main.dev.ts` and `packages/batcher/batcher.dev.ts` — are each
# a single-process `bun run`, and
# preflight-external runs per container instead of once as a service.
#
# `*.dev.ts` and not `*.mainnet.ts`: the mainnet variants are hard-gated —
# config.mainnet.ts and batcher.mainnet.ts both throw unless
# CELESTIA_NETWORK=mainnet — and this stack is a devnet. "dev" in those names
# is the target network, not a multi-process launcher.
#
# THE CONTRACT IS COMPILED AT BUILD TIME, in a dedicated stage running the
# compactc version THE PINNED KERNEL TREE DECLARES — `infra/compact-version.txt`
# (0.33.0-rc.2 at this KERNEL_REF), read out of the fetched source rather than
# hard-coded here, so a kernel bump can never leave this image compiling with a
# toolchain the kernel no longer uses. The release asset comes from
# LFDT-Minokawa/compact (the `compact` version manager does not publish the 0.33
# line — see the kernel repo's infra/compact-toolchain.Dockerfile, which this
# stage mirrors). No --feature-zkir-v3: v2 zkir emits verifier-key[v6], which the
# PLAIN 9.0.0-rc.5 proof server (the core one) proves.

ARG KERNEL_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG KERNEL_REF=80bace37bc2412542452e1c597761b2ebce5c677
# EMPTY ON PURPOSE. The compactc pin has exactly ONE source of truth and it is
# not this file: `infra/compact-version.txt` inside the fetched kernel tree
# (0.33.0-rc.2 at the pin above). A hard-coded default here silently keeps
# compiling with an old toolchain after a kernel bump — the contract would
# still build and the deployed keys would simply not be the ones the pinned
# kernel expects. `--build-arg COMPACT_VERSION=<x>` still overrides, for a
# deliberate experiment.
ARG COMPACT_VERSION=

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

# ── stage 2: compile the Compact contract with the pinned compactc ───────────
FROM debian:stable-slim AS compact

ARG COMPACT_VERSION
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

# Musl-static release asset, one per platform triple (mirrors the kernel's
# infra/compact-toolchain.Dockerfile, including the no-symlink rule: the
# bundled wrapper resolves siblings from `dirname $0`).
# The pin travels with the source, not with this Dockerfile — see the ARG note.
#
# SO DOES THE CHECKSUM (new at 80bace3, kernel PR #67). `infra/compact-checksums.sha256`
# in the pinned tree records the SHA-256 of every release asset the pin names, and
# the download is verified against it before a single byte is unzipped. Before this
# the demo took whatever the release URL served — a tag is a locator, not an
# identity, and a compiler is the one input where "roughly the right bytes" is
# worthless. If the pin ever names a version the kernel has no checksum for, the
# build fails here rather than compiling with an unidentified binary.
#
# AND SO DOES THE RUNTIME EXPECTATION. `compactc --runtime-version` is the
# `checkRuntimeVersion()` string the generated module will demand at import
# time, so it must equal the `@midnight-ntwrk/compact-runtime` the contract
# package pins. Upstream hard-codes that number; here it is READ OUT OF THE
# FETCHED TREE, because a hard-coded copy in this file is exactly the kind of
# expectation that goes stale one kernel bump later and takes a live stack with
# it. (The runtime stage re-checks the whole workspace with the kernel's own
# `bun run check:compact-runtime`.)
COPY --from=source /src/infra/compact-version.txt   /opt/compact-version.txt
COPY --from=source /src/infra/compact-checksums.sha256 /opt/compact-checksums.sha256
COPY --from=source /src/packages/contracts-midnight/contract-offer-files/package.json /opt/contract-package.json

RUN set -eux; \
    COMPACT_VERSION="${COMPACT_VERSION:-$(tr -d ' \t\n\r' < /opt/compact-version.txt)}"; \
    test -n "${COMPACT_VERSION}" || { echo "infra/compact-version.txt is empty at this KERNEL_REF" >&2; exit 1; }; \
    echo "compactc pin: ${COMPACT_VERSION} (from the pinned kernel tree)"; \
    case "${TARGETARCH:-arm64}" in \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o "/tmp/${asset}" "$url"; \
    expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' /opt/compact-checksums.sha256)"; \
    test -n "$expected" || { echo "the pinned kernel tree records no SHA-256 for ${asset}" >&2; exit 1; }; \
    printf '%s  %s\n' "$expected" "/tmp/${asset}" | sha256sum -c -; \
    mkdir -p /opt/compactc; \
    unzip -q "/tmp/${asset}" -d /opt/compactc; \
    rm "/tmp/${asset}"; \
    chmod +x /opt/compactc/*; \
    test -x /opt/compactc/zkir || { echo "asset lacks the default zkir backend" >&2; exit 1; }; \
    printf '#!/bin/sh\nexec /opt/compactc/compactc "$@"\n' > /usr/local/bin/compactc; \
    chmod +x /usr/local/bin/compactc; \
    test "$(compactc --version)" = "${COMPACT_VERSION}"; \
    want_runtime="$(sed -n 's/.*"@midnight-ntwrk\/compact-runtime"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /opt/contract-package.json | head -n 1)"; \
    test -n "$want_runtime" || { echo "the contract package declares no @midnight-ntwrk/compact-runtime" >&2; exit 1; }; \
    got_runtime="$(compactc --runtime-version)"; \
    test "$got_runtime" = "$want_runtime" || { echo "FAIL: compactc ${COMPACT_VERSION} emits code for compact-runtime ${got_runtime}, but the pinned kernel's contract package depends on ${want_runtime}" >&2; exit 1; }; \
    echo "compactc ${COMPACT_VERSION} / language $(compactc --language-version) / runtime ${got_runtime}"; \
    printf '%s\n' "${COMPACT_VERSION}" > /opt/compactc-version

COPY --from=source /src/packages/contracts-midnight/contract-offer-files /contract
# Key generation downloads the universal SRS from srs.midnight.network into
# $XDG_CACHE_HOME — a build-time network fetch, like the git clone above.
RUN cd /contract \
 && HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache /opt/compactc/compactc src/offer-files.compact src/managed/

# ── stage 3: the runtime image ───────────────────────────────────────────────
# Bun is PINNED to the version the whole migration was validated with. Newer
# is not safer here: bun 1.3.14 fails `midnight-contract:deploy` with
# `require() async module ".../graphql/index.mjs" is unsupported` (graphql-tag
# UMD require()ing the ESM graphql 17), which bun 1.3.11 handles. Bump only
# with a full stack bring-up as the gate.
FROM oven/bun:1.3.11

WORKDIR /app
COPY --from=source /src /app
COPY --from=source /kernel-commit /app/.kernel-commit
COPY --from=compact /opt/compactc-version /app/.compactc-version
COPY --from=compact /contract/src/managed /app/packages/contracts-midnight/contract-offer-files/src/managed

# Workspace install. Frozen: the lockfile in the branch IS the tested set.
RUN bun install --frozen-lockfile

# ONE compact-runtime, and it is the one compactc emitted code for. The kernel's
# own gate (scripts/check-compact-runtime.ts, PR #67) asserts that the resolved
# lockfile carries exactly one `@midnight-ntwrk/compact-runtime` locator and that
# all three manifests plus the root override pin that exact version. Running it
# here turns a silent `checkRuntimeVersion()` failure at contract-load time — the
# failure mode issues/00011 was opened about — into a build failure. It is the
# tree's own script, so it moves with the pin instead of restating a number.
RUN bun run check:compact-runtime

# ── one image, three entrypoints (demo-infra Phase 11) ───────────────────────
# This image no longer runs the orchestrator. `bunx orchestrator start
# start.external.ts` put six processes in one container AND re-deployed the
# offer-files contract on every recreate — three different contract addresses
# in one day, with the order book's identity resetting under it.
#
# compose/offerfiles.yml now runs the SAME image three times, one concern each:
#
#   offerfiles-deploy  one-shot. Deploys the contract ONCE per stack and
#                      persists the address on a volume; mints dev tokens
#                      (non-fatal) riding the same run. Skips when the artifact
#                      is already there, so recreates JOIN the contract.
#   kernel             the sync node (:9999). Its store is the shared
#                      `postgres` service, database `offerfiles` (T11.4).
#   batcher            the balancing batcher (:3334), alone.
#   register-tokens    one-shot, non-fatal. NAMES the three demo colours in the
#                      kernel's registry once the kernel is healthy — which is
#                      the only place that ordering is knowable (00010 P1.4).
#   offer-poster       LOOP (profile `poster`). Mints one exact coin and posts
#                      one takeable offer per interval (00010 P3).
#   solver-frontend    the COW solver's read-only monitor site (:8080), served
#                      by `compose/solver.yml` from this same image (00010 P2).
#   price-feed         LOOP (profile `prices`, compose/prices.yml). The daily
#                      CoinGecko refresh of `asset_prices`. Serves no port and
#                      talks to no Midnight service: it reads CoinGecko and
#                      writes the kernel's schema over the Postgres wire, and
#                      it is the ONLY process in this stack that holds a real
#                      secret (COINGECKO_API_KEY, .env only) (00010 P7).
#
# The last four run kernel-repo entrypoints that this image ALSO ships as its
# own scripts: the upstream copies under /app/deploy/images/kernel/ source an
# `entrypoint-common.sh` written for the kernel's own deployment (different
# volume paths, a different contract-share directory), so this repo carries
# thin equivalents that use ITS conventions and exec the same upstream code.
#
# The three that need the external stack share entrypoint-common.sh: the
# Celestia token handoff, then preflight-external (T11.1 — a per-container
# fail-fast, not a service), then the contract address for the two that need
# one. `solver-frontend` and `price-feed` deliberately share none of it: the
# monitor must render an unreachable solver rather than refuse to start, and
# the price feed touches neither Midnight nor Celestia.
#
# The Celestia auth-token handoff (offerfiles.yml note #1) is unchanged: the
# token does not exist until the celestia container initialises its bridge
# store, so it arrives on a read-only volume and anything compose already set
# wins over it.
COPY entrypoint-common.sh /usr/local/lib/offerfiles/entrypoint-common.sh
COPY entrypoint-kernel.sh entrypoint-batcher.sh entrypoint-deploy.sh \
     entrypoint-register-tokens.sh entrypoint-offer-poster.sh \
     entrypoint-solver-frontend.sh entrypoint-price-feed.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint-kernel.sh \
             /usr/local/bin/entrypoint-batcher.sh \
             /usr/local/bin/entrypoint-deploy.sh \
             /usr/local/bin/entrypoint-register-tokens.sh \
             /usr/local/bin/entrypoint-offer-poster.sh \
             /usr/local/bin/entrypoint-solver-frontend.sh \
             /usr/local/bin/entrypoint-price-feed.sh \
 # Kept as an alias so an older compose fragment (or a habit) still lands on
 # something that works — it is the sync node, which is what `kernel` meant.
 && ln -s /usr/local/bin/entrypoint-kernel.sh /usr/local/bin/kernel-entrypoint

# :9999 sync-node API (GET /v1/health), :3334 batcher. Which one a container
# serves depends on the entrypoint compose selects.
EXPOSE 9999 3334

# No default: each service in compose/offerfiles.yml names its own entrypoint,
# and a container that starts the wrong process is worse than one that refuses.
ENTRYPOINT ["/usr/local/bin/entrypoint-kernel.sh"]
