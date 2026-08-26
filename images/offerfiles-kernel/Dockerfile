# offerfiles-kernel — the zswap offer-files kernel running in EXTERNAL-STACK
# mode against this compose stack's node/indexer/proof-server and Celestia
# devnet.
#
# ONE IMAGE, THREE CONTAINERS (demo-infra Phase 11): the sync node (:9999), the
# balancing batcher (:3334) and a deploy one-shot each run this image with their
# own entrypoint. See the entrypoint block near the bottom.
#
# Source: effectstream/zswap-offerfiles-kernel, branch `00001-ledger-v9` (the
# ledger-v9 migration). Like images/umbra-evm, built from a REMOTE clone so
# `git clone <this repo> && ./up.sh --with offerfiles` works with nothing else
# checked out. Same cache caveat too: KERNEL_REF defaults to a branch, and the
# fetch layer stays cached until something above it changes — use --no-cache or
# pin KERNEL_REF to a sha to pick up new commits. The resolved commit is baked
# at /app/.kernel-commit.
#
# WHY NO ORCHESTRATOR AT ALL. `bun run dev`'s launchMidnight() launches its own
# devnet unconditionally AND declares stopProcessAtPort [9944, 8088, 6300] —
# pointed at a live stack it would first kill the listeners it was meant to use
# (measured 2026-08-25, master-plan T4.3). `start.external.ts` fixed that by
# launching only the kernel's own processes, but kept the orchestrator shape:
# six processes in one container, and a contract re-deploy on every recreate.
# Phase 11 drops the orchestrator entirely. The repo's real entrypoints —
# `packages/node/main.dev.ts`, `packages/batcher/batcher.dev.ts`,
# `packages/node/pglite.dev.ts` — are each a single-process `bun run`, and
# preflight-external runs per container instead of once as a service.
#
# `*.dev.ts` and not `*.mainnet.ts`: the mainnet variants are hard-gated —
# config.mainnet.ts and batcher.mainnet.ts both throw unless
# CELESTIA_NETWORK=mainnet — and this stack is a devnet. "dev" in those names
# is the target network, not a multi-process launcher.
#
# THE CONTRACT IS COMPILED AT BUILD TIME, in a dedicated stage running the
# pinned compactc 0.33.0-rc.2 fetched from LFDT-Minokawa/compact release
# assets (the `compact` version manager does not publish the 0.33 line — see
# the kernel repo's infra/compact-toolchain.Dockerfile, which this stage
# mirrors). No --feature-zkir-v3: v2 zkir emits verifier-key[v6], which the
# PLAIN proof-server:9.0.0-rc.5 proves.

ARG KERNEL_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG KERNEL_REF=00001-ledger-v9
ARG COMPACT_VERSION=0.33.0-rc.2

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
RUN set -eux; \
    case "${TARGETARCH:-arm64}" in \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o /tmp/compactc.zip "$url"; \
    mkdir -p /opt/compactc; \
    unzip -q /tmp/compactc.zip -d /opt/compactc; \
    rm /tmp/compactc.zip; \
    chmod +x /opt/compactc/*; \
    test -x /opt/compactc/zkir || { echo "asset lacks the default zkir backend" >&2; exit 1; }

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
COPY --from=compact /contract/src/managed /app/packages/contracts-midnight/contract-offer-files/src/managed

# Workspace install. Frozen: the lockfile in the branch IS the tested set.
RUN bun install --frozen-lockfile

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
#   kernel             the sync node (:9999) + its embedded PGLite store.
#   batcher            the balancing batcher (:3334), alone.
#
# All three share entrypoint-common.sh: the Celestia token handoff, then
# preflight-external (T11.1 — a per-container fail-fast, not a service), then
# the contract address for the two that need one.
#
# The Celestia auth-token handoff (offerfiles.yml note #1) is unchanged: the
# token does not exist until the celestia container initialises its bridge
# store, so it arrives on a read-only volume and anything compose already set
# wins over it.
COPY entrypoint-common.sh /usr/local/lib/offerfiles/entrypoint-common.sh
COPY entrypoint-kernel.sh entrypoint-batcher.sh entrypoint-deploy.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint-kernel.sh \
             /usr/local/bin/entrypoint-batcher.sh \
             /usr/local/bin/entrypoint-deploy.sh \
 # Kept as an alias so an older compose fragment (or a habit) still lands on
 # something that works — it is the sync node, which is what `kernel` meant.
 && ln -s /usr/local/bin/entrypoint-kernel.sh /usr/local/bin/kernel-entrypoint

# :9999 sync-node API (GET /v1/health), :3334 batcher. Which one a container
# serves depends on the entrypoint compose selects.
EXPOSE 9999 3334

# No default: each service in compose/offerfiles.yml names its own entrypoint,
# and a container that starts the wrong process is worse than one that refuses.
ENTRYPOINT ["/usr/local/bin/entrypoint-kernel.sh"]
