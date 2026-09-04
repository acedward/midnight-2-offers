# shielded-night — the Shielded NIGHT dApp on the Midnight 2.x line: a Compact contract that
# wraps native unshielded NIGHT into a contract-minted shielded token (sNight) 1:1 and back,
# plus the Vite/React page that drives it.
#
# ONE BUILD, TWO RUNTIME TARGETS, and they are deliberately different base images:
#
#   --target web      nginx serving the built SPA on container :10900, together with the
#                     compiled contract artifacts under /contract/compiled/shielded-night/
#                     that the browser's prover fetches. Its entrypoint writes /config.js
#                     with THIS stack's contract address at container start.
#   --target deploy   the bun runtime carrying the pinned tree and its root node_modules, for
#                     the deploy one-shot (entrypoint-deploy.sh) and the verify driver
#                     (entrypoint-verify.sh). No SPA, no frontend node_modules.
#
# SOURCE IS FETCHED DIRECTLY from effectstream/shielded-night at an immutable full commit. No
# dApp source and no generated `managed/` output is committed to this repository, so a cold
# build needs GitHub + npm network access. See PROVENANCE.md.
#
# ─── THE LINE THIS IMAGE IS ON, and why the pin is a BRANCH head ─────────────
# This stack is Midnight 2.x: node 2.0.0-rc.4, indexer 4.4.0-rc.3, proof-server 9.0.0-rc.5,
# ledger 9. shielded-night's `main` is the 1.x / ledger-v8 line (it is what the live preview
# deployment runs), so this image pins the repository's long-lived `ledger-v9` branch — the
# port whose own CI is green on exactly this triple. The sibling repository midnight-1-offers
# pins `main` for the same profile. NOTHING but the pin distinguishes the two images, which is
# precisely why stage `source` below CHECKS the line in both directions rather than trusting
# the SHA to be the one somebody meant.
#
# NO PATCH OF ANY KIND, of the source OR of the built output. The things a compose-hosted
# deployment needs from this dApp — a RUNTIME contract-address override, env-overridable
# `undeployed` endpoint URLs, and an external-stack mode for its integration suite — live
# UPSTREAM (project 00007 question Q2, owner decision A). This build ASSERTS each of them is
# present in the pinned tree, so a re-pin to a tree without them fails HERE rather than
# producing a page that can never learn its address and a one-shot that dials 127.0.0.1
# inside a container.
#
# THE CONTRACT IS RECOMPILED HERE and the output must be BYTE-IDENTICAL to the `src/managed/`
# the pinned tree commits (project 00007 question Q3, owner decision A). That byte-exactness
# is the dApp's whole verifiability claim — "the on-chain verifier keys are the ones compiled
# from this source" — and its own CI proves it on every push. This image reproduces the proof
# locally instead of trusting it, with the compiler the tree itself names.

# ── base images: index digests, not tags ─────────────────────────────────────
# DEBIAN_BASE is the same digest images/indexer and images/celestia already pin here. The bun
# and nginx bases are digest-pinned for the same reason, and are the ones the sibling
# repository's copy of this image uses. All three are good official multiarch indexes
# (linux/amd64 + linux/arm64), so nothing here needs a `platform:` pin — which is just as
# well, because scripts/lib/compose_pins.py rejects one outright — and both architectures
# build native.
ARG DEBIAN_BASE=debian:trixie-slim@sha256:f6e2cfac5cf956ea044b4bd75e6397b4372ad88fe00908045e9a0d21712ae3ba
ARG BUN_BASE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
ARG NGINX_BASE=nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

ARG SHIELDED_NIGHT_REPO=https://github.com/effectstream/shielded-night.git
# effectstream/shielded-night branch `ledger-v9` — the ledger-v9 port, full CI green on this
# stack's triple (unit, frontend, byte-exact rebuild, 17/17 integration).
ARG SHIELDED_NIGHT_REF=30af63f3865d0bc5d5331ae32a7891ad48818303
# NOT a free choice: the pinned tree's package.json runs `compact compile +0.34.0` and its CI
# pins COMPACT_VERSION 0.34.0. Stage `source` asserts the tree still says so, so this ARG and
# the source can never drift apart silently.
ARG COMPACT_VERSION=0.34.0

# ── stage 0: the exact upstream tree, and what it must contain ───────────────
FROM ${DEBIAN_BASE} AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG SHIELDED_NIGHT_REPO
ARG SHIELDED_NIGHT_REF

WORKDIR /upstream
RUN set -eux; \
    # A full 40-hex commit, always. `git fetch --depth 1 origin <sha>` refuses an abbreviated
    # sha and cannot see a branch move, which is the cheapest possible enforcement of this
    # repository's pinning rule — and it matters more here than anywhere else in this stack,
    # because `ledger-v9` is a LIVE branch that will keep moving.
    case "${SHIELDED_NIGHT_REF}" in \
      ????????????????????????????????????????) : ;; \
      *) echo "FAIL: SHIELDED_NIGHT_REF must be a full 40-character commit SHA, got '${SHIELDED_NIGHT_REF}'" >&2; exit 1 ;; \
    esac; \
    case "${SHIELDED_NIGHT_REF}" in *[!0-9a-f]*) echo "FAIL: SHIELDED_NIGHT_REF must be lowercase hex" >&2; exit 1 ;; esac; \
    git init -q .; \
    git remote add origin "${SHIELDED_NIGHT_REPO}"; \
    git fetch -q --depth 1 origin "${SHIELDED_NIGHT_REF}"; \
    actual="$(git rev-parse FETCH_HEAD)"; \
    test "${actual}" = "${SHIELDED_NIGHT_REF}"; \
    git checkout -q FETCH_HEAD -- .; \
    mkdir /src; \
    cp -a /upstream/. /src/; \
    rm -rf /src/.git; \
    printf '%s' "${actual}" > /.shielded-night-commit

# THE 2.x / ledger-v9 ASSERTION, in both directions and in both packages.
#
# This repository's core is node 2.0.0-rc.4 / indexer 4.4.0-rc.3 / proof-server 9.0.0-rc.5,
# i.e. the ledger-9 line. The 1.x sibling's copy of this profile pins the SAME repository's
# `main`. Nothing but a pin distinguishes them, so the pin is checked rather than trusted: the
# exact v9 dependency must be present, compact-runtime must be 0.19.0, and NO ledger-v8 may be
# a dependency anywhere.
#
# THE LOCKFILES ARE THE HALF THAT MATTERS. A package.json grep sees only what was asked for;
# `bun.lock` records what was RESOLVED, which is where a stray transitive ledger-v8 would
# appear. Two ledger wasm instances in one tree fail `instanceof` during proving — hours later
# and nowhere near the cause — so the lockfile check is exact: ZERO occurrences of the string.
#
# The package.json check is deliberately narrower than the lockfile one: it matches the
# dependency KEY (`"…/ledger-v8":`), because the pinned tree's `//overrides` prose legitimately
# MENTIONS ledger-v8 while explaining what changed on this line. A blanket grep would fail on
# a comment, which is exactly the sort of false gate that gets weakened later.
RUN set -eux; \
    cd /src; \
    grep -q '"@midnightntwrk/ledger-v9": "1.0.0-rc.3"' package.json; \
    grep -q '"@midnightntwrk/ledger-v9": "1.0.0-rc.3"' frontend/package.json; \
    grep -q '"@midnight-ntwrk/compact-runtime": "0.19.0"' package.json; \
    grep -q '"@midnight-ntwrk/compact-runtime": "0.19.0"' frontend/package.json; \
    for f in package.json frontend/package.json; do \
      if grep -qE '"@midnight-ntwrk/ledger-v8"[[:space:]]*:' "$f"; then \
        echo "FAIL: ${f} DEPENDS on ledger-v8; this repository targets the 2.x/v9 line" >&2; exit 1; \
      fi; \
    done; \
    for f in bun.lock frontend/bun.lock; do \
      if grep -q 'ledger-v8' "$f"; then \
        echo "FAIL: ${f} resolves ledger-v8; two ledger instances fail instanceof at proving time" >&2; exit 1; \
      fi; \
      grep -q 'ledger-v9' "$f" \
        || { echo "FAIL: ${f} does not resolve ledger-v9 at all" >&2; exit 1; }; \
    done

# THE COMPILER THE TREE ITSELF NAMES must be the one this image fetches. `compact compile
# +<version>` in package.json is the dApp's own statement of which toolchain produced the
# committed src/managed/, and stage `compact` below asserts byte-equality against it — so a
# COMPACT_VERSION that disagreed with this line would fail later as an inscrutable diff of
# binary keys rather than as the version mismatch it is.
ARG COMPACT_VERSION
RUN set -eux; \
    cd /src; \
    grep -q "compact compile +${COMPACT_VERSION} " package.json \
      || { echo "FAIL: package.json does not compile with +${COMPACT_VERSION}" >&2; \
           grep -n 'compact compile' package.json >&2; exit 1; }

# ── the integration knobs this profile is built on ───────────────────────────
#
# Each is asserted at its source of truth, by the name the demo stack actually uses, so the
# failure names the missing knob instead of appearing as a page with an empty dropdown or a
# one-shot that times out against 127.0.0.1.
RUN set -eux; \
    cd /src; \
    # 1. RUNTIME contract address: window.SHIELDED_NIGHT.<NETWORK>_ADDRESS wins over the
    #    build-time env var. Without it a stack-independent image is impossible — the address
    #    only exists after this stack's own deploy.
    test -f frontend/src/lib/runtime-config.ts \
      || { echo "FAIL: the pinned tree has no frontend/src/lib/runtime-config.ts — the runtime address override is missing" >&2; exit 1; }; \
    grep -q 'UNDEPLOYED_ADDRESS' frontend/src/lib/runtime-config.ts; \
    grep -q 'runtime-config' frontend/src/lib/networks.ts \
      || { echo "FAIL: networks.ts does not consult the runtime config; the override lane is dead" >&2; exit 1; }; \
    # 1b. …AND the file that carries it must be part of the BUILD, not something a deployment
    #     bolts on afterwards. Upstream ships frontend/public/config.js (a no-op that only
    #     ensures the global exists) and references it from index.html as a CLASSIC script, so
    #     it runs before the deferred module bundle. That is what lets this image patch nothing
    #     at all: it overwrites one already-served file at container start.
    test -f frontend/public/config.js \
      || { echo "FAIL: the pinned tree ships no frontend/public/config.js placeholder" >&2; exit 1; }; \
    grep -q '<script src="/config.js">' frontend/index.html \
      || { echo "FAIL: index.html does not load /config.js" >&2; exit 1; }; \
    # 2. Endpoint overrides: a deploy running INSIDE compose must dial service hostnames.
    for v in MN_INDEXER_URL MN_INDEXER_WS_URL MN_NODE_URL MN_PROOF_SERVER_URL; do \
      grep -q "$v" test/support/network.ts \
        || { echo "FAIL: test/support/network.ts does not honour ${v}" >&2; exit 1; }; \
    done; \
    # 3. External-stack mode: the round-trip gate is the UPSTREAM suite run against OUR stack,
    #    not a transcribed copy of it and not a throwaway testcontainers devnet.
    grep -q 'MN_EXTERNAL_STACK' test/integration/global-setup.ts \
      || { echo "FAIL: the integration suite has no external-stack mode (MN_EXTERNAL_STACK)" >&2; exit 1; }; \
    # …and the machine-readable deploy record, so the one-shot never scrapes stdout.
    grep -q 'DEPLOY_OUT' scripts/deploy-record.ts \
      || { echo "FAIL: scripts/deploy-record.ts does not implement DEPLOY_OUT" >&2; exit 1; }

# ── stage 1: recompile the contract, and prove it is the committed one ───────
# Fetched as a release asset and SHA-256 verified, rather than run through the `compact`
# version manager whose resolution is an unpinnable network lookup. `compactc <in> <out>` is
# exactly what `compact compile +V <in> <out>` dispatches to.
FROM ${DEBIAN_BASE} AS compact

ARG COMPACT_VERSION
ARG TARGETARCH
ARG COMPACT_REPO=midnightntwrk/compact
# SHA-256 of each release asset, from the GitHub release API's own `digest` field
# (release `compactc-v0.34.0`, id 376637042, published 2026-08-25; read 2026-09-03). These,
# not the URL, are the compiler's identity: a release asset can be re-uploaded under the same
# name. midnightntwrk/compact and LFDT-Minokawa/compact publish BYTE-IDENTICAL assets for this
# tag — verified 2026-09-03, same sha256 and same sizes (32,947,390 / 32,033,767 bytes), asset
# ids 529639440 / 529639439 and 529639505 / 529639502 respectively. The former is used because
# it is where the toolchain manager itself is published.
ARG COMPACT_SHA256_AMD64=775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584
ARG COMPACT_SHA256_ARM64=d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) triple="x86_64-unknown-linux-musl";  want_sha="${COMPACT_SHA256_AMD64}" ;; \
      arm64) triple="aarch64-unknown-linux-musl"; want_sha="${COMPACT_SHA256_ARM64}" ;; \
      *) echo "FAIL: unsupported TARGETARCH='${TARGETARCH}' (need amd64 or arm64)" >&2; exit 1 ;; \
    esac; \
    asset="compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    # The same release ships aarch64-darwin and x86_64-darwin zips. A darwin asset in a Linux
    # build stage is exactly what the matrix's forbiddenAssetSubstrings list exists to
    # prevent; assert it cannot happen here either.
    case "${asset}" in \
      *darwin*|*macos*|*windows*) echo "FAIL: '${asset}' is not a Linux asset" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/${COMPACT_REPO}/releases/download/compactc-v${COMPACT_VERSION}/${asset}"; \
    echo "fetching ${url}"; \
    curl --proto '=https' --tlsv1.2 -fLsS --retry 3 --retry-delay 2 -o /tmp/compactc.zip "${url}"; \
    echo "${want_sha}  /tmp/compactc.zip" | sha256sum -c -; \
    mkdir -p /opt/compactc; \
    unzip -q /tmp/compactc.zip -d /opt/compactc; \
    rm -f /tmp/compactc.zip; \
    chmod +x /opt/compactc/*; \
    # The zkir backend ships beside compactc and is invoked as a sibling from `dirname $0`.
    # An asset without it compiles nothing and fails much later, as a missing executable.
    test -x /opt/compactc/zkir || { echo "FAIL: the asset lacks the default zkir backend" >&2; exit 1; }; \
    # The pin says 0.34.0; make the BINARY say so too. A renamed or re-uploaded asset would
    # otherwise be caught by nothing until a verifier key was rejected at runtime.
    ver="$(/opt/compactc/compactc --version 2>&1 || true)"; \
    echo "compactc reports: ${ver}"; \
    case "${ver}" in \
      *"${COMPACT_VERSION}"*) : ;; \
      *) echo "FAIL: compactc does not report version ${COMPACT_VERSION}: ${ver}" >&2; exit 1 ;; \
    esac

# The contract source AND the committed artifacts: one is compiled, the other is what the
# result must equal. Both come from the pinned tree; nothing else in it invalidates this layer.
#
# THE SOURCE PATH IS PART OF THE OUTPUT, which is not obvious and cost the sibling repository
# a build to discover. compactc records the input path it was given, verbatim, in the emitted
# source map (`contract/index.js.map`: `sourceRoot` and `sources`). Compiling the same bytes as
# `/contract/shielded-night.compact` instead of `src/shielded-night.compact` therefore produces
# artifacts that are byte-identical in every ZK key, every zkir and the contract module itself —
# and differ in exactly two lines of the map. So the layout and the invocation mirror upstream's
# `compact compile +0.34.0 src/shielded-night.compact src/managed/`, run from the repository
# root, and the byte-exactness assertion below stays exact instead of being loosened to
# "everything except the source map".
COPY --from=source /src/src/shielded-night.compact /src/src/shielded-night.compact
COPY --from=source /src/src/managed /committed/managed
WORKDIR /src

# THE BYTE-EXACT REBUILD. Compiled into an EMPTY directory, exactly as upstream's own
# reproducible-build job does (it `rm -rf src/managed` first): a compiler that skipped work
# because its output was already present would leave the committed files untouched and the
# diff below would pass while having verified nothing.
#
# HOME and XDG_CACHE_HOME are redirected because the default HOME is /root, and an SRS cache
# written there would be baked into a layer nothing reads.
RUN set -eux; \
    HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache \
      /opt/compactc/compactc src/shielded-night.compact src/managed/; \
    test -d /src/src/managed/contract; \
    test -d /src/src/managed/keys; \
    test -d /src/src/managed/zkir; \
    # compactc 0.33+ emits compiler/contract-manifest.json, and on this line it is
    # LOAD-BEARING rather than decorative: midnight-js 5's FetchZkConfigProvider verifies
    # every fetched artifact against it and defaults to fail-closed. A build that produced no
    # manifest would serve a page whose prover refuses its own keys.
    test -s /src/src/managed/compiler/contract-manifest.json \
      || { echo "FAIL: compactc ${COMPACT_VERSION} emitted no compiler/contract-manifest.json" >&2; exit 1; }; \
    # 11 circuits, each with a prover key, a verifier key and a bzkir. The count is asserted
    # because "the compile produced SOMETHING" and "the compile produced this contract" are
    # different claims, and only the second one is worth anything.
    n="$(ls -1 /src/src/managed/keys/*.verifier | wc -l)"; \
    test "${n}" -eq 11 || { echo "FAIL: expected 11 circuits, compiled ${n}" >&2; ls -1 /src/src/managed/keys >&2; exit 1; }; \
    # THE ASSERTION THIS WHOLE STAGE EXISTS FOR. `compact compile` is deterministic, so this
    # is exact, not heuristic: a difference means the source was edited, the compiler version
    # differs, or the committed artifacts are not what this source produces — and in every one
    # of those cases the page would serve proving keys that do not match the deployed
    # contract's on-chain verifier keys.
    if ! diff -r /src/src/managed /committed/managed; then \
      echo "FAIL: recompiling src/shielded-night.compact with compactc ${COMPACT_VERSION} did not reproduce the committed src/managed/." >&2; \
      echo "      That byte-exactness IS this dApp's verifiability claim; do not weaken this check." >&2; \
      exit 1; \
    fi; \
    echo "OK: 11 circuits reproduced byte-for-byte from the pinned tree"

# ── stage 2: install both dependency sets, typecheck, build the SPA ──────────
FROM ${BUN_BASE} AS build

WORKDIR /src
COPY --from=source /src /src
# The freshly compiled artifacts, not the committed copy — byte-identical by the assertion
# above, but this makes "what the page serves" and "what this build compiled" the same bytes
# by construction rather than by argument.
COPY --from=compact /src/src/managed /src/src/managed

# BOTH INSTALLS MATTER, and installing only the frontend's would make this build pass
# trivially while testing nothing. The frontend imports the compiled contract from
# ../src/managed — OUTSIDE its package root — so Rollup resolves the WASM-bearing midnight
# packages for those files from the ROOT node_modules: a second physical copy whose classes
# fail the app's `instanceof` checks. `vite.config.ts`'s `resolve.dedupe` is the fix, and it
# is only EXERCISED when both installs are present. This is upstream's own CI reasoning, and
# on this line it covers three wasm-bearing packages (ledger-v9, onchain-runtime-v4,
# compact-runtime) instead of two.
#
# Frozen: the lockfiles at the pinned commit ARE the tested dependency set, so a transitive
# dependency publishing a new version is a build failure rather than a silent difference.
RUN bun install --frozen-lockfile
RUN cd frontend && bun install --frozen-lockfile

RUN bun run typecheck
RUN cd frontend && bun run typecheck
RUN cd frontend && bun run build

# THE OVERRIDE LANE MUST SURVIVE INTO THE BUNDLE, not merely into the source tree. A
# build-stage grep of the source proves the code was written; only this proves it was shipped.
# `SHIELDED_NIGHT` is a property name on `window`, so minification cannot rename it and
# esbuild emits it verbatim — upstream documents it as exactly this grep marker. Without the
# lane in the bundle, /config.js would be written, served, ignored, and the page would show no
# "Local (undeployed)" network at all.
RUN set -eux; \
    grep -rqF 'SHIELDED_NIGHT' /src/frontend/dist/assets \
      || { echo "FAIL: the runtime address-override lane is not in the built bundle" >&2; exit 1; }; \
    # vite.config.ts copies src/managed into dist/contract/compiled/shielded-night; that is
    # where FetchZkConfigProvider looks. If the copy plugin ever stops running, the page loads
    # and then cannot prove anything.
    test -d /src/frontend/dist/contract/compiled/shielded-night/keys; \
    test -d /src/frontend/dist/contract/compiled/shielded-night/zkir; \
    # THE MANIFEST IS PART OF THE SERVED SET ON THIS LINE. midnight-js 5's
    # FetchZkConfigProvider verifies integrity against compiler/contract-manifest.json and
    # defaults to 'require' — fail-closed. Copying only keys/ and zkir/ would give a page that
    # loads, connects a wallet, and then refuses to prove anything, with the error naming
    # nothing that appears in this file.
    test -s /src/frontend/dist/contract/compiled/shielded-night/compiler/contract-manifest.json \
      || { echo "FAIL: dist/ does not serve compiler/contract-manifest.json; midnight-js 5 verifies every artifact against it, fail-closed" >&2; exit 1; }; \
    n="$(ls -1 /src/frontend/dist/contract/compiled/shielded-night/keys/*.verifier | wc -l)"; \
    test "${n}" -eq 11 || { echo "FAIL: dist serves ${n} verifier keys, expected 11" >&2; exit 1; }

# ── runtime target 1: the deploy one-shot and the verify driver ──────────────
# The bun runtime with the pinned tree and its ROOT node_modules only. No frontend, no
# frontend node_modules: this target never serves a page.
FROM ${BUN_BASE} AS deploy

WORKDIR /app
COPY --from=build /src/package.json /src/bun.lock /src/tsconfig.json \
                  /src/vitest.unit.config.ts /src/vitest.integration.config.ts /app/
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/src     /app/src
COPY --from=build /src/scripts /app/scripts
COPY --from=build /src/test    /app/test
COPY --from=build /src/envs    /app/envs
COPY --from=source /.shielded-night-commit /.shielded-night-commit

COPY entrypoint-common.sh /usr/local/lib/shielded-night/entrypoint-common.sh
# entrypoint-register-token.sh teaches the offer-files kernel THIS stack's sNight colour. It
# lives on this target because the colour derivation needs @midnightntwrk/ledger-v9, which is
# in the root node_modules copied above, and because this is the target that already mounts
# the volume the contract address is published on.
COPY entrypoint-deploy.sh entrypoint-verify.sh entrypoint-register-token.sh /usr/local/bin/
RUN set -eux; \
    chmod 0755 /usr/local/bin/entrypoint-deploy.sh /usr/local/bin/entrypoint-verify.sh \
               /usr/local/bin/entrypoint-register-token.sh; \
    chmod 0644 /usr/local/lib/shielded-night/entrypoint-common.sh; \
    # The one-shot publishes here; compose mounts a named volume over it. Creating it in the
    # image means a `docker run` without the volume fails on the deploy rather than on a
    # missing directory three steps later.
    mkdir -p /srv/shielded-night

# No CMD: compose names the entrypoint per service, exactly as images/offerfiles-kernel does
# for its three roles.
ENTRYPOINT ["/usr/local/bin/entrypoint-deploy.sh"]

# ── runtime target 2: nginx serving the SPA and the ZK artifacts ─────────────
FROM ${NGINX_BASE} AS web

COPY --from=build  /src/frontend/dist /usr/share/nginx/html
COPY --from=source /.shielded-night-commit /.shielded-night-commit
COPY PROVENANCE.md /usr/share/licenses/shielded-night/PROVENANCE.md

# /config.js is OVERWRITTEN at container start (entrypoint-web.sh) with this stack's contract
# address. NOTHING IS PATCHED HERE: the pinned tree ships the placeholder and the tag, so the
# built output is used exactly as `vite build` emitted it. What is asserted is that both
# survived the build, and IN THE RIGHT ORDER — the tag is a classic script and the bundle a
# deferred module, so a config.js referenced after the module tag would still execute first,
# but a config.js that is not referenced at all is an override lane that silently does nothing.
RUN set -eux; \
    test -f /usr/share/nginx/html/config.js \
      || { echo "FAIL: dist/ carries no config.js — the entrypoint would create a file nothing loads" >&2; exit 1; }; \
    grep -q '<script src="/config.js">' /usr/share/nginx/html/index.html \
      || { echo "FAIL: the built index.html does not load /config.js" >&2; exit 1; }

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY entrypoint-web.sh /docker-entrypoint-shielded-night.sh
RUN set -eux; \
    chmod 0755 /docker-entrypoint-shielded-night.sh; \
    rm -f /etc/nginx/conf.d/default.conf.default; \
    # wasm must be served as application/wasm or streaming instantiation refuses the module.
    # The stock mime.types has carried it since nginx 1.21.5, so this asserts rather than
    # patches: a second `types` block in the same context is a config error, and silently
    # serving wasm as octet-stream is a page that loads and then cannot prove anything.
    grep -qE '^[[:space:]]*application/wasm[[:space:]]+wasm;' /etc/nginx/mime.types \
      || { echo "FAIL: this nginx image's mime.types has no application/wasm mapping" >&2; exit 1; }; \
    # The prover/verifier/bzkir artifacts have no mime mapping at all, which is CORRECT — they
    # must fall through to the http block's `default_type application/octet-stream`. If a base
    # image ever dropped that directive the default would become text/plain, and the SPA's own
    # fetch guard treats a text body as a miss.
    grep -qE '^[[:space:]]*default_type[[:space:]]+application/octet-stream;' /etc/nginx/nginx.conf \
      || { echo "FAIL: this nginx image has no application/octet-stream default_type" >&2; exit 1; }; \
    nginx -t

EXPOSE 10900
ENTRYPOINT ["/docker-entrypoint-shielded-night.sh"]
