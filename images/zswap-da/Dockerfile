# zswap-da — the offer-files trading frontend (React/vite), served by nginx on
# container :10600, talking to the kernel API (:9999) and batcher (:3334).
#
# SOURCE IS AN ADDITIONAL BUILD CONTEXT, NOT A REMOTE CLONE — deliberately
# unlike images/umbra-evm and images/offerfiles-kernel. The upstream template
# (`effectstream/effectstream@templates/zswap-da`) is still on the ledger-v8
# line and is frozen by that repo's rules; the ledger-v9 migration of it exists
# only as a LOCAL working copy that is not published anywhere. Compose passes
# that copy in as the `template` context:
#
#   frontend:
#     build:
#       context: ../images/zswap-da
#       additional_contexts:
#         template: ${ZSWAP_DA_TEMPLATE_DIR:-…}
#
# so this build needs the migrated template checked out next to the demo repo
# (see compose/offerfiles.yml for the default path and the error you get
# without it). When the migrated template gets a public home, this file should
# switch to the fetch-from-remote pattern of the other two images.
#
# THE CONTRACT IS NOT COMPILED HERE. The template ships src/contract/managed/
# plus a sha256 manifest, and `bun run build` verifies output-against-manifest
# (scripts/build-contract.ts) — compiling only when managed/ is absent. The
# template copy this image consumes carries managed/ compiled with the pinned
# compactc 0.33.0-rc.2, so the build VERIFIES rather than compiles, and no
# compactc is needed in this image. If managed/ were missing, the build would
# fail loudly asking for the toolchain — that is the manifest doing its job.
#
# RUNTIME CONFIG: src/config.ts resolves the API/batcher endpoints as
# window.API_BASE ?? VITE_API_BASE ?? http://<hostname>:9999 (and :3334).
# The entrypoint writes /config.js from $API_BASE/$BATCHER_URL when set —
# empty otherwise, which leaves the template's hostname-relative defaults in
# charge (correct for this stack: the kernel publishes 9999/3334 on the same
# host the frontend is served from).

# ── stage 1: verify the contract manifest + vite build ───────────────────────
FROM oven/bun:1-debian AS build

WORKDIR /src
COPY --from=template / /src

RUN bun install --frozen-lockfile
# prebuild runs scripts/build-contract.ts: managed/ is present, so this
# VERIFIES the 17-file sha256 manifest and then runs tsc -b + vite build.
RUN bun run build

# ── stage 2: nginx serving dist/ on :10600 ───────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /src/dist /usr/share/nginx/html

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
