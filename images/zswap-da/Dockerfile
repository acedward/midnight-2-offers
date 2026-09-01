# zswap-da — the offer-files trading frontend (React/vite), served by nginx on
# container :10600, talking to the kernel API (:9999) and batcher (:3334).
#
# SOURCE IS FETCHED DIRECTLY from effectstream/effectstream at an immutable
# full commit, then templates/zswap-da is adapted with ledger-v9.patch. The
# patch contains only the required dependency/lockfile, compiler manifest, and
# six TypeScript/API migrations; the third-party source tree is not committed
# here. Network access to GitHub and npm is therefore required for a cold build.
#
# THE CONTRACT IS COMPILED HERE from the template's tracked Compact source.
# The historical local template carried untracked managed/ output, which made
# a fresh clone fail before Docker could build anything. This stage mirrors the
# kernel's pinned compactc 0.33.0-rc.2 compiler lane, then verifies the pinned
# sha256 manifest before Vite builds. The generated artifacts are
# build-only; the runtime still receives only dist/.
#
# RUNTIME CONFIG: src/config.ts resolves the API/batcher endpoints as
# window.API_BASE ?? VITE_API_BASE ?? http://<hostname>:9999 (and :3334).
# The entrypoint writes /config.js from $API_BASE/$BATCHER_URL when set —
# empty otherwise, which leaves the template's hostname-relative defaults in
# charge (correct for this stack: the kernel publishes 9999/3334 on the same
# host the frontend is served from).

# ── stage 0: exact upstream source + fail-closed ledger-v9 adaptation ───────
ARG FRONTEND_REPO=https://github.com/effectstream/effectstream.git
ARG FRONTEND_REF=332503c8f9216143a8c805f2a0acbcfd39e5a21d
ARG COMPACT_VERSION=0.33.0-rc.2

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
    test "$tree" = "1f63d7eedc9a8aff729b7fe026486cb89cb618de"; \
    git checkout -q FETCH_HEAD -- templates/zswap-da; \
    mkdir /src; \
    cp -a templates/zswap-da/. /src/; \
    printf '%s' "$actual" > /.zswap-da-commit

COPY ledger-v9.patch /tmp/ledger-v9.patch
RUN set -eux; \
    cd /src; \
    git apply --check /tmp/ledger-v9.patch; \
    git apply /tmp/ledger-v9.patch; \
    grep -q '"@midnightntwrk/ledger-v9": "1.0.0-rc.3"' package.json; \
    ! grep -q '"@midnight-ntwrk/ledger-v8"' package.json; \
    test -f LICENSE-APACHE; \
    test -f LICENSE-MIT

# The kernel's GET /v1/midnight/config reports the URIs the kernel itself
# dials — inside compose those are service hostnames (indexer, proof-server)
# that no browser can resolve, so the in-page JS wallet, contract client, and
# take-offer flow all died with ERR_NAME_NOT_RESOLVED. The patch re-points a
# bare (dot-less, non-localhost) hostname at the page's own host once, in
# api.getMidnightConfig — the single chokepoint every consumer goes through —
# keeping scheme, port and path; every affected service is published on that
# same host port.
COPY browser-network-urls.patch /tmp/browser-network-urls.patch
RUN set -eux; \
    cd /src; \
    git apply --check /tmp/browser-network-urls.patch; \
    git apply /tmp/browser-network-urls.patch; \
    grep -q 'pageHost' src/services/api.ts

# ── stage 1: compile the matching Compact bindings/keys ─────────────────────
FROM debian:stable-slim AS compact

ARG COMPACT_VERSION
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
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
    test -x /opt/compactc/zkir

COPY --from=source /src/src/contract/offer-files.compact /contract/offer-files.compact
RUN HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache \
    /opt/compactc/compactc /contract/offer-files.compact /contract/managed/

# ── stage 2: verify the pinned manifest + vite build ─────────────────────
FROM oven/bun:1-debian AS build

WORKDIR /src
COPY --from=source /src /src
COPY --from=compact /contract/managed /src/src/contract/managed

RUN bun install --frozen-lockfile
# The source template does not track generated managed/ output. Verify Docker's
# freshly compiled artifacts against the trusted, checked-in manifest before
# the normal prebuild repeats that verification and tsc + Vite run. Routine
# builds must never self-bless compiler output via --update-manifest.
RUN bun run scripts/build-contract.ts --verify-only
RUN bun run build

# ── stage 3: nginx serving dist/ on :10600 ───────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /src/dist /usr/share/nginx/html
COPY --from=source /.zswap-da-commit /.zswap-da-commit
COPY --from=source /src/LICENSE-APACHE /usr/share/licenses/zswap-da/LICENSE-APACHE
COPY --from=source /src/LICENSE-MIT /usr/share/licenses/zswap-da/LICENSE-MIT
COPY PROVENANCE.md /usr/share/licenses/zswap-da/PROVENANCE.md

# /config.js is generated at container start (see entrypoint); reference it
# before the bundle so window.API_BASE/BATCHER_URL are set when config.ts runs.
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

RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      '{' \
      '  [ -n "${API_BASE:-}" ]    && echo "window.API_BASE = \"${API_BASE}\";"' \
      '  [ -n "${BATCHER_URL:-}" ] && echo "window.BATCHER_URL = \"${BATCHER_URL}\";"' \
      '  :' \
      '} > /usr/share/nginx/html/config.js' \
      'exec nginx -g "daemon off;"' \
      > /docker-entrypoint-frontend.sh \
 && chmod +x /docker-entrypoint-frontend.sh

EXPOSE 10600
ENTRYPOINT ["/docker-entrypoint-frontend.sh"]
