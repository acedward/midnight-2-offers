# zswap-da — the offer-files trading frontend (React/vite), served by nginx on
# container :10600, talking to the kernel API (:9999) and batcher (:3334).
#
# SOURCE IS FETCHED DIRECTLY from effectstream/effectstream at an immutable
# full commit, then templates/zswap-da is adapted with ledger-v9.patch. The
# patch contains only the required dependency/lockfile, compiler manifest, and
# seven TypeScript/API migrations; the third-party source tree is not committed
# here. Network access to GitHub and npm is therefore required for a cold build.
#
# THE CONTRACT IS COMPILED HERE from the template's tracked Compact source.
# The historical local template carried untracked managed/ output, which made
# a fresh clone fail before Docker could build anything. This stage mirrors the
# kernel's pinned compactc 0.34.0 compiler lane, then verifies the pinned
# sha256 manifest before Vite builds. The generated artifacts are
# build-only; the runtime still receives only dist/.
#
# THE CONTRACT SOURCE IS THE KERNEL'S, NOT THE TEMPLATE'S. `ledger-v9.patch`
# now carries `src/contract/offer-files.compact` verbatim from
# zswap-offerfiles-kernel at KERNEL_REF, because the SPA proves calls against
# the contract THAT kernel deployed: the 17 artifacts here must be the same
# bytes the kernel image compiled, so the source, the compiler and the runtime
# must all be the kernel's. At the previous pin the two files happened to be
# identical and the patch could stay silent about it; kernel PR #67 changed
# the mint signatures and made the coincidence visible.
#
# RUNTIME CONFIG: src/config.ts resolves the API/batcher endpoints as
# window.API_BASE ?? VITE_API_BASE ?? http://<hostname>:9999 (and :3334).
# docker-entrypoint-frontend.sh writes /config.js from $API_BASE/$BATCHER_URL
# when set — empty otherwise, which leaves the template's hostname-relative
# defaults in charge (correct on the default layout, where the kernel publishes
# 9999/3334 on the same host the frontend is served from). It also always
# writes window.MIDNIGHT_HOST_PORTS, the compose-hostname -> PUBLISHED-host-port
# map that browser-network-urls.patch needs to make the wallet reachable on a
# pick-ports.sh stack. Nothing port-dependent is baked into the bundle.

# ── stage 0: exact upstream source + fail-closed ledger-v9 adaptation ───────
ARG FRONTEND_REPO=https://github.com/effectstream/effectstream.git
ARG FRONTEND_REF=ea04ff7c16dab5118d4bdfeec6e7455c89981827
# The one image whose compactc pin is NOT read out of a fetched kernel tree —
# this image never clones the kernel. It is written down here instead, together
# with the SHA-256 of each release asset, copied from the pinned kernel's
# `infra/compact-checksums.sha256` at KERNEL_REF 80bace3. Stage 1 verifies the
# download against it and then asserts that the compiler's own
# `--runtime-version` equals the `@midnight-ntwrk/compact-runtime` the PATCHED
# template installs — so this ARG, the patch and the kernel cannot drift apart
# without a build failure that says which one moved.
ARG COMPACT_VERSION=0.34.0
ARG COMPACT_SHA256_ARM64=d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d
ARG COMPACT_SHA256_AMD64=775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584

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
    test "$tree" = "ea22913c345da3dae36e113fdbced2bb1897de63"; \
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
# dials — inside compose those are service hostnames (indexer, proof-server) on
# CONTAINER ports, which no browser can resolve, so the in-page JS wallet,
# contract client, and take-offer flow all died with ERR_NAME_NOT_RESOLVED. The
# patch fixes both halves once, in api.getMidnightConfig — the single chokepoint
# every consumer goes through: a bare (dot-less, non-localhost) hostname becomes
# the page's own host, and the port becomes the PUBLISHED host port read from
# window.MIDNIGHT_HOST_PORTS (written by docker-entrypoint-frontend.sh at
# container start). Scheme and path are always kept, so the kernel stays the
# authority on the indexer's API version. The kernel reports no node URI at all,
# so the patch completes the template's own http://<page host>:9944 fallback
# from the same map.
COPY browser-network-urls.patch /tmp/browser-network-urls.patch
RUN set -eux; \
    cd /src; \
    git apply --check /tmp/browser-network-urls.patch; \
    git apply /tmp/browser-network-urls.patch; \
    grep -q 'pageHost' src/services/api.ts; \
    grep -q 'MIDNIGHT_HOST_PORTS' src/services/api.ts

# ── stage 1: compile the matching Compact bindings/keys ─────────────────────
FROM debian:stable-slim AS compact

ARG COMPACT_VERSION
ARG COMPACT_SHA256_ARM64
ARG COMPACT_SHA256_AMD64
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

# The patched template's manifest — the source of the runtime expectation. It is
# copied BEFORE the download so the assertion below has something to compare
# against without a second stage.
COPY --from=source /src/package.json /opt/template-package.json

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) triple="aarch64-unknown-linux-musl"; expected="${COMPACT_SHA256_ARM64}" ;; \
      amd64) triple="x86_64-unknown-linux-musl";  expected="${COMPACT_SHA256_AMD64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    test -n "$expected" || { echo "no SHA-256 recorded for ${TARGETARCH}" >&2; exit 1; }; \
    asset="compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o "/tmp/${asset}" "$url"; \
    printf '%s  %s\n' "$expected" "/tmp/${asset}" | sha256sum -c -; \
    mkdir -p /opt/compactc; \
    unzip -q "/tmp/${asset}" -d /opt/compactc; \
    rm "/tmp/${asset}"; \
    chmod +x /opt/compactc/*; \
    test -x /opt/compactc/zkir; \
    test "$(/opt/compactc/compactc --version)" = "${COMPACT_VERSION}"; \
    got_runtime="$(/opt/compactc/compactc --runtime-version)"; \
    want_runtime="$(sed -n 's/.*"@midnight-ntwrk\/compact-runtime"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /opt/template-package.json | head -n 1)"; \
    test -n "$want_runtime" || { echo "the patched template declares no @midnight-ntwrk/compact-runtime" >&2; exit 1; }; \
    test "$got_runtime" = "$want_runtime" || { echo "FAIL: compactc ${COMPACT_VERSION} emits code for compact-runtime ${got_runtime}, but ledger-v9.patch installs ${want_runtime} — the generated module's checkRuntimeVersion() would refuse to load in the browser" >&2; exit 1; }; \
    echo "compactc ${COMPACT_VERSION} / language $(/opt/compactc/compactc --language-version) / runtime ${got_runtime}"

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

# A real, readable file rather than a printf-built one: it now carries the
# port-map logic and a long explanation of why that map has to exist.
COPY docker-entrypoint-frontend.sh /docker-entrypoint-frontend.sh
RUN chmod +x /docker-entrypoint-frontend.sh

EXPOSE 10600
ENTRYPOINT ["/docker-entrypoint-frontend.sh"]
