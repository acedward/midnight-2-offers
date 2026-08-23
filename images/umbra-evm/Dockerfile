# umbra-evm — the read-only Ethereum JSON-RPC façade over the Midnight demo stack.
#
# Source: acedward/UmbraDB, branch `feat/00006-json-rpc-review` (PR #7, base `evm-compat`).
# That repo ships NO Docker packaging, so this file IS the packaging. It is deliberately built
# from a REMOTE clone rather than a vendored copy so `git clone <this repo> && ./up.sh --with evm`
# works with nothing else checked out.
#
#   docker compose ... build evm-rpc          # honours the cache
#   docker compose ... build --no-cache evm-rpc
#
# NOTE ON THE CACHE: UMBRA_REF defaults to a BRANCH, and Docker cannot know when a branch has
# moved — the `git fetch` layer stays cached until something above it changes. Use `--no-cache`
# (or pin UMBRA_REF to a commit sha) when you need to pick up new upstream commits. The resolved
# commit is baked into the image at /app/.umbra-commit, so what you are actually running is
# always recoverable:
#
#   docker run --rm <image> cat /app/.umbra-commit
#
# Three entrypoints share this one image (see compose/evm.yml):
#   npm run evm-rpc:all      HTTP JSON-RPC :8545 + WS eth_subscribe :10021  (evm-rpc service)
#   npm run monitor:wallet   indexer → Postgres unshielded balance/tx folder (wallet-monitor)
#   npx tsx tools/migrate.ts the evm_rpc migration lineage                  (evm-migrate, one-shot)

# Declared before the first FROM so the defaults reach BOTH stages (a stage-scoped ARG default
# does not propagate; a bare re-declaration inside a stage picks the global default up).
ARG UMBRA_REPO=https://github.com/acedward/UmbraDB.git
# A branch name, a tag, or a commit sha — `git fetch <ref>` accepts all three (GitHub allows
# fetching any commit reachable from a ref).
ARG UMBRA_REF=feat/00006-json-rpc-review

# ── stage 1: fetch the source and apply the demo-stack patches ───────────────────────────────
FROM node:24-bookworm-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG UMBRA_REPO
ARG UMBRA_REF

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$UMBRA_REPO" \
 && git fetch -q --depth 1 origin "$UMBRA_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /umbra-commit \
 && rm -rf .git

# The patches are exact-anchor rewrites that FAIL THE BUILD if the upstream text moved, rather
# than silently producing a half-patched tree. See patches/apply.mjs for what each one does and
# why it is needed.
COPY patches/ /patches/
RUN node /patches/apply.mjs /src

# Demo-stack tooling that is ours, not upstream's: the migration runner, the address mapper and
# the newHeads probe. Kept in a directory upstream does not use, so it can never collide.
COPY tools/ /src/tools/

# ── stage 2: install and run ─────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# `npm run evm-rpc:all` is `tsx evm-rpc/serve-all.ts`: this image RUNS TypeScript directly, it
# does not build it. tsx — and the three @midnightntwrk/wallet-sdk-* packages that
# wallet-monitor/address.ts imports to derive an unshielded address — are all devDependencies of
# UmbraDB, so NODE_ENV must not be `production` and `npm ci` must not omit dev. The image is
# large as a result (the dev tree carries vitest/stryker/typedoc); that is the price of running
# the upstream sources unmodified, and it buys the ability to run the repo's own offline test
# suites inside the image.
ENV NODE_ENV=development

WORKDIR /app
COPY --from=source /src /app
COPY --from=source /umbra-commit /app/.umbra-commit

# UmbraDB's .npmrc sets ignore-scripts=true (its own supply-chain hardening), so no dependency
# lifecycle script runs here. Nothing in this image needs a build step.
RUN npm ci --no-audit --no-fund \
 && npm cache clean --force

# node:24 already provides an unprivileged `node` user (uid 1000). Everything is read-only at
# runtime except stdout, so no writable paths need chowning.
USER node

ENV EVM_RPC_HOST=0.0.0.0 \
    EVM_RPC_PORT=8545 \
    EVM_RPC_WS_PORT=10021 \
    CHAIN_ID=2400

EXPOSE 8545 10021

ARG UMBRA_REPO
ARG UMBRA_REF
LABEL org.opencontainers.image.title="umbra-evm" \
      org.opencontainers.image.description="Read-only Ethereum JSON-RPC over a Midnight 2.x devnet (UmbraDB evm-rpc + wallet-monitor)" \
      org.opencontainers.image.source="${UMBRA_REPO}" \
      org.opencontainers.image.ref.name="${UMBRA_REF}"

CMD ["npm", "run", "evm-rpc:all"]
