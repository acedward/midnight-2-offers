# zswap-da — the offer-files trading frontend (React/vite), served by nginx on
# container :10600, talking to the kernel API (:9999) and batcher (:3334).
#
# SOURCE IS FETCHED DIRECTLY from effectstream/effectstream at an immutable
# full commit on the **`midnight-1`** branch, then templates/zswap-da is adapted
# with ledger-v9.patch. The patch contains only the dependency/lockfile swap and
# the ledger-v9 source migration; the third-party source tree is not committed
# here. Network access to GitHub and npm is therefore required for a cold build.
#
# THERE IS NO CONTRACT IN THIS IMAGE, AND NO COMPILER.
# Until PR #922 the template shipped a local faucet contract (`src/contract/
# offer-files.compact`, a checked-in artifact manifest and `scripts/build-
# contract.ts`), and this Dockerfile carried a whole compactc stage to compile
# it and verify the artifacts against that manifest. Upstream deleted the
# contract lane on `midnight-1` (#922, mirroring #921 on `v-next`) and the
# pinned kernel deleted its own (#69/#70), so BOTH ends of that arrangement are
# gone: test tokens now come from the external mint-test-tokens faucet, which
# deploys its own issuers and owns their artifacts. Compiling anything here
# would be compiling a contract nothing deploys. The build asserts the absence
# rather than trusting it — see stage 0.
#
# RUNTIME CONFIG: nothing stack-dependent is baked into the bundle. src/config.ts
# resolves each value as window.<NAME> ?? VITE_<NAME> ?? a template default, and
# docker-entrypoint-frontend.sh writes /config.js at container start:
#
#   window.API_BASE / window.BATCHER_URL   kernel API + batcher, when overridden
#   window.MIDNIGHT_HOST_PORTS             compose hostname -> PUBLISHED host port
#   window.MIDNIGHT_NETWORK_ID             the chain this stack runs (`undeployed`)
#   window.FAUCET_HOST_PORT                the published port of the faucet site
#   window.DEMO_WALLET_SEED                the in-page JS wallet's seed
#
# The last two come with browser-network-urls.patch: upstream resolves the
# network id at BUILD time (defaulting to preprod) and the faucet base likewise,
# and one image has to serve any stack.

# ── stage 0: exact upstream source + fail-closed ledger-v9 adaptation ───────
ARG FRONTEND_REPO=https://github.com/effectstream/effectstream.git
# effectstream/effectstream `midnight-1` @ the merge commit of PR #922
# ("Remove local faucet contract from midnight-1 frontend", merged
# 2026-09-08). See PROVENANCE.md for why this branch and not `v-next`.
ARG FRONTEND_REF=400880ceb6814738d1ae193dae18ad5128922edc

FROM debian:stable-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG FRONTEND_REPO
ARG FRONTEND_REF

WORKDIR /upstream
RUN set -eux; \
    test "${#FRONTEND_REF}" -eq 40; \
    case "$FRONTEND_REF" in *[!0-9a-f]*) echo "FRONTEND_REF must be a lowercase full commit SHA" >&2; exit 1 ;; esac; \
    git init -q .; \
    git remote add origin "$FRONTEND_REPO"; \
    git fetch -q --depth 1 origin "$FRONTEND_REF"; \
    actual="$(git rev-parse FETCH_HEAD)"; \
    test "$actual" = "$FRONTEND_REF"; \
    tree="$(git rev-parse FETCH_HEAD:templates/zswap-da)"; \
    test "$tree" = "a750cccd653f33306d3ff7249fe8d5853fbfafa6"; \
    git checkout -q FETCH_HEAD -- templates/zswap-da; \
    mkdir /src; \
    cp -a templates/zswap-da/. /src/; \
    printf '%s' "$actual" > /.zswap-da-commit; \
    printf '%s' "midnight-1" > /.zswap-da-branch

# THE CONTRACT-FREE ASSERTION (spec SC-001 for the SPA half). The whole reason
# this image no longer has a compactc stage is that upstream deleted the
# contract lane. If a future FRONTEND_REF brings any of it back, this build
# fails HERE — naming the file — rather than producing an image that silently
# lost the compilation step it used to have.
RUN set -eux; \
    cd /src; \
    for gone in scripts/build-contract.ts src/contract src/hooks/useContract.ts \
                src/services/browserContract.ts src/services/contractWallet.ts \
                src/screens/Faucet.tsx; do \
      if [ -e "$gone" ]; then \
        echo "FAIL: the template at this FRONTEND_REF still carries ${gone}. This image compiles no Compact and deploys no contract (the kernel has none since #69/#70, the template since #922). Either re-pin, or restore a compiler stage deliberately." >&2; \
        exit 1; \
      fi; \
    done; \
    ! grep -rq 'mint_shielded\|mint_unshielded' src/

COPY ledger-v9.patch /tmp/ledger-v9.patch
RUN set -eux; \
    cd /src; \
    git apply --check /tmp/ledger-v9.patch; \
    git apply /tmp/ledger-v9.patch; \
    grep -q '"@midnightntwrk/ledger-v9": "1.0.0-rc.3"' package.json; \
    ! grep -q '"@midnight-ntwrk/ledger-v8"' package.json; \
    ! grep -q '"@midnight-ntwrk/compact-runtime"' package.json; \
    ! grep -rq "ledger-v8" src/; \
    test -f LICENSE-APACHE; \
    test -f LICENSE-MIT

# Two things the page cannot know and the bundle must not bake:
#
#  1. WHERE THE CHAIN IS. The kernel's GET /v1/midnight/config reports the URIs
#     the kernel itself dials — inside compose those are service hostnames
#     (indexer, proof-server) on CONTAINER ports, which no browser can resolve.
#     Upstream already re-points the HOST at this pin, but keeps the port, which
#     is only right on a default port block. The patch completes it: the port is
#     mapped through window.MIDNIGHT_HOST_PORTS (written by
#     docker-entrypoint-frontend.sh at container start), and `nodeUri` — which
#     the kernel never reports at all — is synthesized from the same map.
#     Scheme and path are always kept, so the kernel stays the authority on the
#     indexer's API version.
#
#  2. WHICH NETWORK, AND WHERE THE FAUCET IS. Upstream resolves both at BUILD
#     time (VITE_MIDNIGHT_NETWORK_ID, defaulting to preprod; VITE_FAUCET_URL,
#     defaulting to the public site). This stack is always `undeployed` and its
#     faucet is the mint-test-tokens site on a host port only Docker knows —
#     while the host itself is only known IN THE PAGE. So src/config.ts gains
#     window.MIDNIGHT_NETWORK_ID and window.FAUCET_HOST_PORT, and the faucet
#     origin is composed in the page from location.hostname. `?network=` is then
#     `undeployed` through the template's OWN buildFaucetUrl, unpatched.
#
#  3. WHICH WALLET. connectLocal() GENERATES a random 32-byte seed when it is not
#     given one, so the in-page demo wallet was a brand-new EMPTY wallet on every
#     page load. That was survivable while the template could mint; with the
#     contract gone it is a wallet that can never acquire anything, because the
#     faucet SITE drives an injected extension wallet and an in-page wallet is
#     not one. window.DEMO_WALLET_SEED makes it the STACK's demo wallet, which
#     the faucet profile's faucet-mint one-shot prefunds. Absent, the bundle
#     keeps upstream's random behaviour.
COPY browser-network-urls.patch /tmp/browser-network-urls.patch
RUN set -eux; \
    cd /src; \
    git apply --check /tmp/browser-network-urls.patch; \
    git apply /tmp/browser-network-urls.patch; \
    grep -q 'pageHost' src/services/api.ts; \
    grep -q 'MIDNIGHT_HOST_PORTS' src/services/api.ts; \
    grep -q 'FAUCET_HOST_PORT' src/config.ts; \
    grep -q 'MIDNIGHT_NETWORK_ID' src/config.ts; \
    grep -q 'DEMO_WALLET_SEED' src/config.ts; \
    grep -q 'connectLocal(DEMO_WALLET_SEED)' src/state/useZSwapApp.ts

# ── stage 1: bun install + tsc + vite build ─────────────────────────────────
FROM oven/bun:1-debian AS build

WORKDIR /src
COPY --from=source /src /src

# --frozen-lockfile is the point of regenerating bun.lock inside ledger-v9.patch:
# the 2.x dependency set is resolved ONCE, reviewed in the patch, and reproduced
# here byte for byte. A drift between manifest and lockfile fails the build.
RUN bun install --frozen-lockfile

# The whole suite, in the image, before anything is served: it is the only place
# the ledger-v9 port is exercised against the real wasm (offerBatch.test.ts
# builds and merges actual transactions), and a template bump that breaks
# decoding must not reach a browser.
RUN bun test

# `build` is `tsc -b && vite build`.
RUN bun run build

# Nothing compiled a contract, so nothing may have produced ZK artifacts. This
# is the assertion that the removal is real and not merely untested.
RUN set -eux; \
    test ! -e /src/src/contract; \
    test ! -e /src/scripts/build-contract.ts; \
    ! command -v compactc >/dev/null 2>&1; \
    test ! -d /src/dist/keys; \
    test ! -d /src/dist/zkir

# ── stage 2: nginx serving dist/ on :10600 ───────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /src/dist /usr/share/nginx/html
COPY --from=source /.zswap-da-commit /.zswap-da-commit
COPY --from=source /.zswap-da-branch /.zswap-da-branch
COPY --from=source /src/LICENSE-APACHE /usr/share/licenses/zswap-da/LICENSE-APACHE
COPY --from=source /src/LICENSE-MIT /usr/share/licenses/zswap-da/LICENSE-MIT
COPY PROVENANCE.md /usr/share/licenses/zswap-da/PROVENANCE.md

# /config.js is generated at container start (see entrypoint); reference it
# before the bundle so window.API_BASE/BATCHER_URL/MIDNIGHT_NETWORK_ID/
# FAUCET_HOST_PORT are set when config.ts runs.
RUN sed -i 's|<script type="module"|<script src="/config.js"></script><script type="module"|' \
      /usr/share/nginx/html/index.html \
 && grep -q 'config.js' /usr/share/nginx/html/index.html

RUN printf '%s\n' \
      'server {' \
      '  listen 10600;' \
      '  root /usr/share/nginx/html;' \
      '  index index.html;' \
      '  # SPA fallback: client-side routes resolve to the app shell.' \
      '  location / { try_files $uri $uri/ /index.html; }' \
      '  # wasm must be served with the right MIME for streaming instantiation.' \
      '  types { application/wasm wasm; }' \
      '  include /etc/nginx/mime.types;' \
      '}' \
      > /etc/nginx/conf.d/default.conf \
 && rm -f /etc/nginx/conf.d/default.conf.default 2>/dev/null || true

# A real, readable file rather than a printf-built one: it now carries the
# port-map logic and a long explanation of why that map has to exist.
COPY docker-entrypoint-frontend.sh /docker-entrypoint-frontend.sh
RUN chmod +x /docker-entrypoint-frontend.sh

EXPOSE 10600
ENTRYPOINT ["/docker-entrypoint-frontend.sh"]
