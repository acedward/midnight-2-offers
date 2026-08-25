# aa-contracts — deploy the AA Manager + test Minter on the demo chain at bring-up,
# and mint a token (profile `aa`, one-shot service `aa-deploy`).
#
# Source: acedward/AA-midnight-evm-experiment-v3 — contracts/manager.compact (the
# account-abstraction custody contract) and contracts/test-support/minter.compact
# (per-deployment-tag token source). Fetched from the remote like the other images,
# so `git clone <this repo> && ./up.sh --with aa` works with nothing else checked out.
#
# TOOLCHAIN FIDELITY. The AA repo pins the SAME compactc release asset this repo
# already uses (`compactc-v0.33.0-rc.2` — upstream records it as "0.33.0"; the
# archive is byte-identical, only its hosting moved). It compiles with
# `--feature-zkir-v3`, and that flag is load-bearing: the Manager is
# keccak/EIP-712-heavy and its measured k=19 is a v3-lane artifact. v3 zkir emits
# verifier-key[v7], which the PLAIN proof-server 9.0.0-rc.5 cannot prove calls
# against — which is why compose/aa.yml ships its own INTERNAL
# `proof-server:9.0.0-rc.5_experimental` instead of flipping the core PROOF_TAG.
#
# KEYS. Key generation is the expensive step (~155 s, ~1.2 GB; `execute.prover`
# alone is 1.1 GB). Bring-up DEPLOYS the Manager but never CALLS it, and a deploy
# needs only the verifier keys (the contract ops) — so the Manager's `.prover`
# files are PRUNED from the image. The Minter's full key set stays: the mint call
# proves. Regenerate manager prover keys with the AA repo's scripts/keygen.sh when
# `execute` is actually exercised.

ARG AA_REPO=https://github.com/acedward/AA-midnight-evm-experiment-v3.git
ARG AA_REF=main
ARG COMPACT_VERSION=0.33.0-rc.2

# ── stage 1: fetch the AA sources ────────────────────────────────────────────
FROM debian:stable-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG AA_REPO
ARG AA_REF

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$AA_REPO" \
 && git fetch -q --depth 1 origin "$AA_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /aa-commit \
 && rm -rf .git

# ── stage 2: compile + keygen with the pinned compactc ───────────────────────
FROM debian:stable-slim AS compact

ARG COMPACT_VERSION
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

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
    test -x /opt/compactc/zkir || { echo "asset lacks the zkir backend" >&2; exit 1; }

COPY --from=source /src/contracts /contracts

# Keys need the universal SRS from srs.midnight.network (a build-time network
# fetch, like the git clone). Layout matches what deployMidnightContract expects:
# <contract-name>/src/managed/. Manager prover keys pruned — see header.
RUN set -eux; \
    export HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache; \
    mkdir -p /aa/contract-manager/src /aa/contract-minter/src; \
    /opt/compactc/compactc --feature-zkir-v3 /contracts/manager.compact /aa/contract-manager/src/managed/; \
    /opt/compactc/compactc --feature-zkir-v3 /contracts/test-support/minter.compact /aa/contract-minter/src/managed/; \
    find /aa/contract-manager/src/managed/keys -name '*.prover' -print -delete; \
    ls /aa/contract-manager/src/managed/keys /aa/contract-minter/src/managed/keys

# ── stage 3: the deploy+mint runner ──────────────────────────────────────────
# Same bun pin as the kernel image, same reason (1.3.14 breaks on graphql-17 ESM).
FROM oven/bun:1.3.11

WORKDIR /aa
COPY --from=compact /aa /aa
COPY --from=source /aa-commit /aa/.aa-commit
COPY runner/ /aa/runner/

# Install at /aa, not /aa/runner: the compactc-generated contract modules live at
# /aa/contract-*/src/managed/contract/ and import @midnight-ntwrk/compact-runtime —
# module resolution walks UP from the importing file, so the dependency tree must
# sit at /aa/node_modules to be visible to generated code and runner alike.
RUN cp /aa/runner/package.json /aa/package.json && cd /aa && bun install

RUN printf '%s\n' \
      '#!/bin/bash' \
      'set -euo pipefail' \
      '# Idempotent: compose re-runs completed one-shots on EVERY `up` (measured,' \
      '# T4.7 finding) — a second run must not deploy duplicate contracts.' \
      'if [ -f /aa/out/aa-contracts.json ]; then' \
      '  echo "[aa-deploy] already deployed — /aa/out/aa-contracts.json:"' \
      '  cat /aa/out/aa-contracts.json' \
      '  exit 0' \
      'fi' \
      'exec bun run /aa/runner/deploy-aa.ts' \
      > /usr/local/bin/aa-entrypoint \
 && chmod +x /usr/local/bin/aa-entrypoint

ENTRYPOINT ["/usr/local/bin/aa-entrypoint"]
