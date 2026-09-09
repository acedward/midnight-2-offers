# shielded-night — the Shielded NIGHT dApp on the Midnight 2.x line: a Compact contract that
# wraps native unshielded NIGHT into a contract-minted shielded token (sNight) 1:1 and back,
# plus the Vite/React page that drives it.
#
# ONE BUILD, TWO RUNTIME TARGETS, and they are deliberately different base images:
#
#   --target web      nginx serving the built SPA on container :10900, together with the
#                     compiled contract artifacts under /contract/v2/shielded-night/ that the
#                     browser's prover fetches. Its entrypoint writes /config.js with THIS
#                     stack's contract address AND the protocol switch at container start.
#   --target deploy   the node+bun runtime carrying the pinned tree's `contracts/v2` package
#                     and its node_modules, for the deploy one-shot (entrypoint-deploy.sh),
#                     the verify driver (entrypoint-verify.sh) and the kernel registration
#                     one-shot (entrypoint-register-token.sh). No SPA, no frontend modules.
#
# SOURCE IS FETCHED DIRECTLY from effectstream/shielded-night at an immutable full commit. No
# dApp source and no generated `managed/` output is committed to this repository, so a cold
# build needs GitHub + npm network access. See PROVENANCE.md.
#
# ─── THE LINE THIS IMAGE IS ON: `main`, on its 2.x `undeployed` lane ─────────
# This stack is Midnight 2.x: node 2.0.0-rc.4, indexer 4.4.0-rc.3, proof-server 9.0.0-rc.5,
# ledger 9, and the ONE network it runs is `undeployed`. Since upstream PR #16 (`main` @
# 1337afc35ac1e6089dcc5957feafdb2bdc3bf1a3, merged 2026-09-09) that combination is a supported
# upstream lane, so this image pins **`main`** and the long-lived `ledger-v9` branch is retired
# here. What PR #16 added is exactly the three things this deployment needs and nothing else:
#
#   * contracts/v2/scripts/profile.ts   an `undeployed()` profile — networkId/walletNetworkId
#                                       `undeployed`, every endpoint overridable, and the
#                                       maintenance signing key OPTIONAL and ephemeral (it is
#                                       mandatory and durable on stagenet, unchanged)
#   * contracts/v2/scripts/{deploy,verify-deployment}.ts   accept MN_ENV=undeployed
#                                       (`stagenet` stays the default, so nothing moved for
#                                       upstream's own hosted deployment)
#   * frontend/src/lib/runtime-config.ts  UNDEPLOYED_PROTOCOL — build-time env OR
#                                       window.SHIELDED_NIGHT.UNDEPLOYED_PROTOCOL — which
#                                       networks.ts turns into the v2 adapter and the label
#                                       "Local (undeployed · 2.x)". Default `midnight-1.x`,
#                                       i.e. upstream's own local flow is unchanged.
#   * contracts/v2/test/external/       a 2.x counterpart of the MN_EXTERNAL_STACK round-trip
#                                       suite, which is what ./verify.sh runs as its gate
#
# ─── `main` IS TWO TREES, AND ONLY ONE OF THEM IS OURS ───────────────────────
# Since upstream PR #13 the repository carries BOTH generations in protocol-isolated trees, and
# this is the single most important fact about building it:
#
#   1.x   root `package.json` + `src/` (compactc 0.31.1 -> `src/managed/`), `frontend/` itself,
#         `frontend/protocols/v1` — @midnight-ntwrk/ledger-v8, compact-runtime 0.16.0, bun
#   2.x   `contracts/v2/` (compactc 0.34.0 -> `contracts/v2/managed/`) and
#         `frontend/protocols/v2` — @midnightntwrk/ledger-v9, compact-runtime 0.19.0, **npm**
#
# So: the ledger-v8 packages ARE in this tree and must be, and the old blanket "zero
# occurrences of ledger-v8 anywhere" assertion this file used to carry is FALSE at this pin.
# What is asserted instead is the SEPARATION — each v2 tree resolves ledger-v9 and no
# ledger-v8 — which is the property that actually matters: two ledger wasm instances inside one
# package tree fail `instanceof` during proving, hours later and nowhere near the cause.
#
# It also means the build needs **node + npm as well as bun**: `contracts/v2` and both
# `frontend/protocols/*` packages are npm packages with their own lockfiles, and the root and
# `frontend/` packages are bun ones. Upstream's CI installs exactly that way, and so does the
# build stage below. The base is therefore node (the same digest images/mint-test-tokens pins)
# with the bun binary copied in from the digest-pinned oven/bun index — bun is one static
# executable, so this is a copy rather than an install.
#
# NO PATCH OF ANY KIND, of the source OR of the built output. The things a compose-hosted
# deployment needs from this dApp — a RUNTIME contract-address override, a RUNTIME protocol
# switch for `undeployed`, env-overridable endpoint URLs, an external-stack mode for the
# round-trip suite, and a machine-readable deploy record — live UPSTREAM (project 00007
# question Q2, owner decision A; infra 00017 Q15 -> upstream project 00008). This build ASSERTS
# each of them is present in the pinned tree, so a re-pin to a tree without them fails HERE
# rather than producing a page that loads a ledger-v8 adapter against a ledger-9 chain.
#
# THE v2 CONTRACT IS RECOMPILED HERE and the output must be BYTE-IDENTICAL to the
# `contracts/v2/managed/` the pinned tree commits (project 00007 question Q3, owner decision
# A). That byte-exactness is the dApp's whole verifiability claim — "the on-chain verifier keys
# are the ones compiled from this source" — and upstream's own `reproducible-build-v2` job
# proves it on every push. This image reproduces the proof locally instead of trusting it, with
# the compiler the tree itself names.
#
# THE v1 CONTRACT IS NOT RECOMPILED, deliberately. `src/managed/` is compactc 0.31.1 output,
# it is committed, and `frontend/vite.config.ts` copies it into the built site as
# `contract/v1/shielded-night` and `contract/compiled/shielded-night`. This stack never selects
# a 1.x network, so recompiling it would add a SECOND compiler to this image — and the
# repository's one-toolchain rule (scripts/verify-source-pins.sh) exists precisely to stop
# that — in exchange for verifying a lane nothing here uses. It is shipped as committed, and
# PROVENANCE.md says so.

# ── base images: index digests, not tags ─────────────────────────────────────
# DEBIAN_BASE is the same digest images/indexer and images/celestia already pin here, and
# NODE_BASE is the one images/mint-test-tokens pins — same host, same verified digests, one
# fewer base image in this repository's surface. The bun and nginx bases are digest-pinned for
# the same reason. All are good official multiarch indexes (linux/amd64 + linux/arm64), so
# nothing here needs a `platform:` pin — which is just as well, because scripts/lib/
# compose_pins.py rejects one outright — and both architectures build native.
#
# node 24.15.0 satisfies every `engines` field in the pinned tree (`contracts/v2` and
# `frontend/protocols/v2` both ask for >= 22.12); bun 1.4.0 is required rather than merely
# convenient, because the v2-era `bun.lock` files are lockfile format v2 and bun < 1.4 cannot
# install them at all.
ARG DEBIAN_BASE=debian:trixie-slim@sha256:f6e2cfac5cf956ea044b4bd75e6397b4372ad88fe00908045e9a0d21712ae3ba
ARG NODE_BASE=node:24.15.0-trixie-slim@sha256:291be77873bc04731968cacf82f0fcef17cee8cf200c6b6951e2bcab41560eb7
ARG BUN_BASE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
ARG NGINX_BASE=nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

ARG SHIELDED_NIGHT_REPO=https://github.com/effectstream/shielded-night.git
# effectstream/shielded-night branch `main` @ the merge of upstream PR #16 ("a Midnight 2.x
# lane for `undeployed`"), which is what makes `main` able to serve this stack at all. The
# sibling repository midnight-1-offers pins the same branch for its own 1.x lane — the two
# images are now distinguished by their MN_ENV/UNDEPLOYED_PROTOCOL wiring rather than by their
# pin, which is the point of an env switch.
ARG SHIELDED_NIGHT_REF=1337afc35ac1e6089dcc5957feafdb2bdc3bf1a3
# NOT a free choice: the pinned tree's package.json runs `compact compile +0.34.0` for the v2
# contract and its CI pins COMPACT_V2_VERSION 0.34.0. Stage `source` asserts the tree still
# says so, so this ARG and the source can never drift apart silently.
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
    # because `main` is a LIVE branch that will keep moving.
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

# THE 2.x / ledger-v9 ASSERTION — PER TREE, in both directions, package and lockfile.
#
# This repository's core is node 2.0.0-rc.4 / indexer 4.4.0-rc.3 / proof-server 9.0.0-rc.5,
# i.e. the ledger-9 line, and the two trees this image actually uses are `contracts/v2` (the
# deploy/verify/round-trip runner) and `frontend/protocols/v2` (the browser adapter). Each must
# be PURE v9: the exact ledger-v9 pin present, compact-runtime 0.19.0, and NO ledger-v8
# dependency — because two ledger wasm identities inside one package tree fail `instanceof`
# during proving, hours later and nowhere near the cause.
#
# THE LOCKFILES ARE THE HALF THAT MATTERS. A package.json grep sees only what was asked for;
# the lockfile records what was RESOLVED, which is where a stray transitive ledger-v8 would
# appear. Both v2 trees are npm packages, so the lockfile is `package-lock.json`.
#
# The package.json check matches the dependency KEY (`"…/ledger-v8":`) rather than the bare
# string, because prose in these files legitimately MENTIONS the other generation while
# explaining the split. A blanket grep would fail on a comment, which is exactly the sort of
# false gate that gets weakened later.
#
# NOTHING here asserts the absence of ledger-v8 from the ROOT or `frontend/` trees, and that is
# not an oversight: on `main` those ARE the 1.x trees. What is asserted is that they stay
# SEPARATE from the v2 ones — each v2 tree has its own lockfile and therefore its own physical
# node_modules — which is the invariant `frontend/vite.config.ts`'s per-profile runtime
# resolution depends on.
RUN set -eux; \
    cd /src; \
    for d in contracts/v2 frontend/protocols/v2; do \
      test -f "$d/package.json"      || { echo "FAIL: ${d}/package.json is missing — this is not the two-tree layout this image builds" >&2; exit 1; }; \
      test -f "$d/package-lock.json" || { echo "FAIL: ${d}/package-lock.json is missing; the v2 trees must carry their own resolved dependency set" >&2; exit 1; }; \
      grep -q '"@midnightntwrk/ledger-v9": "1.0.0-rc.3"' "$d/package.json" \
        || { echo "FAIL: ${d}/package.json does not pin @midnightntwrk/ledger-v9 1.0.0-rc.3" >&2; exit 1; }; \
      grep -q '"@midnight-ntwrk/compact-runtime": "0.19.0"' "$d/package.json" \
        || { echo "FAIL: ${d}/package.json does not pin @midnight-ntwrk/compact-runtime 0.19.0" >&2; exit 1; }; \
      if grep -qE '"@midnight-ntwrk/ledger-v8"[[:space:]]*:' "$d/package.json"; then \
        echo "FAIL: ${d}/package.json DEPENDS on ledger-v8; the v2 trees target the 2.x/v9 line" >&2; exit 1; \
      fi; \
      if grep -q 'ledger-v8' "$d/package-lock.json"; then \
        echo "FAIL: ${d}/package-lock.json resolves ledger-v8; two ledger instances fail instanceof at proving time" >&2; exit 1; \
      fi; \
      grep -q 'ledger-v9' "$d/package-lock.json" \
        || { echo "FAIL: ${d}/package-lock.json does not resolve ledger-v9 at all" >&2; exit 1; }; \
    done

# THE COMPILER THE TREE ITSELF NAMES must be the one this image fetches, and it must name it
# for the **v2** contract. `compact compile +<version> contracts/v2/…` in package.json is the
# dApp's own statement of which toolchain produced the committed contracts/v2/managed/, and
# stage `compact` below asserts byte-equality against it — so a COMPACT_VERSION that disagreed
# with this line would fail later as an inscrutable diff of binary keys rather than as the
# version mismatch it is.
ARG COMPACT_VERSION
RUN set -eux; \
    cd /src; \
    grep -q "compact compile +${COMPACT_VERSION} contracts/v2/shielded-night.compact" package.json \
      || { echo "FAIL: package.json does not compile the v2 contract with +${COMPACT_VERSION}" >&2; \
           grep -n 'compact compile' package.json >&2; exit 1; }

# ── the integration knobs this profile is built on ───────────────────────────
#
# Each is asserted at its source of truth, by the name the demo stack actually uses, so the
# failure names the missing knob instead of appearing as a page with an empty dropdown, a page
# that loads the WRONG ledger adapter, or a one-shot that dials 127.0.0.1 inside a container.
RUN set -eux; \
    cd /src; \
    # 1. RUNTIME contract address: window.SHIELDED_NIGHT.<NETWORK>_ADDRESS wins over the
    #    build-time env var. Without it a stack-independent image is impossible — the address
    #    only exists after this stack's own deploy.
    test -f frontend/src/lib/runtime-config.ts \
      || { echo "FAIL: the pinned tree has no frontend/src/lib/runtime-config.ts — the runtime override lane is missing" >&2; exit 1; }; \
    grep -q 'UNDEPLOYED_ADDRESS' frontend/src/lib/runtime-config.ts; \
    grep -q 'runtime-config' frontend/src/lib/networks.ts \
      || { echo "FAIL: networks.ts does not consult the runtime config; the override lane is dead" >&2; exit 1; }; \
    # 1a. THE PROTOCOL SWITCH — the knob this whole re-pin exists for. Without it `undeployed`
    #     is hard-wired to midnight-1.x and the page loads a ledger-v8 adapter against this
    #     ledger-9 chain: it connects, and then every call fails with an error naming none of
    #     this. Asserted at BOTH ends — the resolver, and the label networks.ts derives from it,
    #     which is what scripts/verify-shielded-night.sh looks for in the built bundle.
    grep -q 'UNDEPLOYED_PROTOCOL' frontend/src/lib/runtime-config.ts \
      || { echo "FAIL: runtime-config.ts has no UNDEPLOYED_PROTOCOL switch — this tree predates upstream PR #16 and cannot serve a 2.x undeployed chain" >&2; exit 1; }; \
    grep -q "midnight-2.x" frontend/src/lib/runtime-config.ts \
      || { echo "FAIL: runtime-config.ts does not know the value 'midnight-2.x'" >&2; exit 1; }; \
    grep -qF 'Local (undeployed · 2.x)' frontend/src/lib/networks.ts \
      || { echo "FAIL: networks.ts does not label the 2.x local lane; the protocol switch is not wired into the network row" >&2; exit 1; }; \
    # 1b. …AND the file that carries it must be part of the BUILD, not something a deployment
    #     bolts on afterwards. Upstream ships frontend/public/config.js (a no-op that only
    #     ensures the global exists) and references it from index.html as a CLASSIC script, so
    #     it runs before the deferred module bundle. That is what lets this image patch nothing
    #     at all: it overwrites one already-served file at container start.
    test -f frontend/public/config.js \
      || { echo "FAIL: the pinned tree ships no frontend/public/config.js placeholder" >&2; exit 1; }; \
    grep -q '<script src="/config.js">' frontend/index.html \
      || { echo "FAIL: index.html does not load /config.js" >&2; exit 1; }; \
    # 2. `undeployed` IS a v2 environment, and every endpoint is overridable: a deploy running
    #    INSIDE compose must dial service hostnames, because upstream's defaults are loopback
    #    and inside a container loopback is this container.
    grep -qE "V2_ENV_NAMES = \[.*'undeployed'" contracts/v2/scripts/profile.ts \
      || { echo "FAIL: contracts/v2 does not accept MN_ENV=undeployed (upstream PR #16 is not in this tree)" >&2; exit 1; }; \
    for v in MN_INDEXER_URL MN_INDEXER_WS_URL MN_NODE_URL MN_NODE_WS_URL MN_PROOF_SERVER_URL; do \
      grep -q "$v" contracts/v2/scripts/profile.ts \
        || { echo "FAIL: contracts/v2/scripts/profile.ts does not honour ${v}" >&2; exit 1; }; \
    done; \
    # 2a. The maintenance signing key must be OPTIONAL on undeployed. It is mandatory, absolute
    #     and durable on stagenet — correct there, impossible here: a throwaway devnet redeploys
    #     on every `./down.sh -v` and this container has no durable private storage.
    grep -q 'UNDEPLOYED_MAINTENANCE_KEY_PATH' contracts/v2/scripts/profile.ts \
      || { echo "FAIL: the v2 deployer has no ephemeral maintenance-key path for undeployed" >&2; exit 1; }; \
    # 3. External-stack mode: the round-trip gate is the UPSTREAM suite run against OUR stack,
    #    not a transcribed copy of it and not a throwaway testcontainers devnet.
    grep -q 'MN_EXTERNAL_STACK' contracts/v2/test/external/global-setup.ts \
      || { echo "FAIL: the v2 tree has no external-stack round-trip suite (MN_EXTERNAL_STACK)" >&2; exit 1; }; \
    grep -q '"test:external"' contracts/v2/package.json \
      || { echo "FAIL: contracts/v2 exposes no test:external script" >&2; exit 1; }; \
    # 3a. …and it must be able to JOIN the contract this stack already deployed rather than
    #     deploying a second one, or the round trip would prove a contract nobody serves.
    grep -q 'CV_ADDRESS' contracts/v2/test/external/shielded-night.external.test.ts \
      || { echo "FAIL: the external suite cannot join an existing deployment (CV_ADDRESS)" >&2; exit 1; }; \
    # 4. …and the machine-readable deploy record, so the one-shot never scrapes stdout.
    grep -q 'DEPLOY_OUT' contracts/v2/scripts/profile.ts \
      || { echo "FAIL: contracts/v2/scripts/profile.ts does not implement DEPLOY_OUT" >&2; exit 1; }; \
    # 5. The SEALED metadata. `deploy.ts` hard-codes the constructor arguments and
    #    `verifyAddress()` refuses any other on-chain metadata, so the demo's
    #    SHIELDED_NIGHT_NAME/SYMBOL/DECIMALS knobs have no v2 counterpart — the deploy
    #    entrypoint refuses a non-default value rather than passing one that would be ignored.
    #    Asserted here so the refusal cannot outlive the reason for it.
    grep -qF "args: ['Shielded Night', 'sNight', 6n]" contracts/v2/scripts/deploy.ts \
      || { echo "FAIL: contracts/v2/scripts/deploy.ts no longer seals ['Shielded Night','sNight',6n]; entrypoint-deploy.sh's metadata refusal is now wrong" >&2; exit 1; }

# ── stage 1: recompile the v2 contract, and prove it is the committed one ────
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

# The v2 contract source AND the committed v2 artifacts: one is compiled, the other is what the
# result must equal. Both come from the pinned tree; nothing else in it invalidates this layer.
#
# THE SOURCE PATH IS PART OF THE OUTPUT, which is not obvious and cost the sibling repository
# a build to discover. compactc records the input path it was given, verbatim, in the emitted
# source map (`contract/index.js.map`: `sourceRoot` and `sources`). Compiling the same bytes as
# `/contract/shielded-night.compact` instead of `contracts/v2/shielded-night.compact` therefore
# produces artifacts that are byte-identical in every ZK key, every zkir and the contract module
# itself — and differ in exactly two lines of the map. So the layout and the invocation mirror
# upstream's `compact compile +0.34.0 contracts/v2/shielded-night.compact contracts/v2/managed/`
# run from the repository root, and the byte-exactness assertion below stays exact instead of
# being loosened to "everything except the source map".
COPY --from=source /src/contracts/v2/shielded-night.compact /src/contracts/v2/shielded-night.compact
COPY --from=source /src/contracts/v2/managed /committed/managed
WORKDIR /src

# THE BYTE-EXACT REBUILD. Compiled into an EMPTY directory, exactly as upstream's own
# reproducible-build-v2 job does (it `rm -rf contracts/v2/managed` first): a compiler that
# skipped work because its output was already present would leave the committed files untouched
# and the diff below would pass while having verified nothing.
#
# HOME and XDG_CACHE_HOME are redirected because the default HOME is /root, and an SRS cache
# written there would be baked into a layer nothing reads.
RUN set -eux; \
    HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache \
      /opt/compactc/compactc contracts/v2/shielded-night.compact contracts/v2/managed/; \
    test -d /src/contracts/v2/managed/contract; \
    test -d /src/contracts/v2/managed/keys; \
    test -d /src/contracts/v2/managed/zkir; \
    # compactc 0.33+ emits compiler/contract-manifest.json, and on this line it is
    # LOAD-BEARING rather than decorative: midnight-js 5's FetchZkConfigProvider verifies
    # every fetched artifact against it and defaults to fail-closed. A build that produced no
    # manifest would serve a page whose prover refuses its own keys. (The v1 tree's 0.31.1
    # output has none, which is exactly why the served path moved to /contract/v2/.)
    test -s /src/contracts/v2/managed/compiler/contract-manifest.json \
      || { echo "FAIL: compactc ${COMPACT_VERSION} emitted no compiler/contract-manifest.json" >&2; exit 1; }; \
    # 11 circuits, each with a prover key, a verifier key and a bzkir. The count is asserted
    # because "the compile produced SOMETHING" and "the compile produced this contract" are
    # different claims, and only the second one is worth anything.
    n="$(ls -1 /src/contracts/v2/managed/keys/*.verifier | wc -l)"; \
    test "${n}" -eq 11 || { echo "FAIL: expected 11 circuits, compiled ${n}" >&2; ls -1 /src/contracts/v2/managed/keys >&2; exit 1; }; \
    # THE ASSERTION THIS WHOLE STAGE EXISTS FOR. `compact compile` is deterministic, so this
    # is exact, not heuristic: a difference means the source was edited, the compiler version
    # differs, or the committed artifacts are not what this source produces — and in every one
    # of those cases the page would serve proving keys that do not match the deployed
    # contract's on-chain verifier keys.
    if ! diff -r /src/contracts/v2/managed /committed/managed; then \
      echo "FAIL: recompiling contracts/v2/shielded-night.compact with compactc ${COMPACT_VERSION} did not reproduce the committed contracts/v2/managed/." >&2; \
      echo "      That byte-exactness IS this dApp's verifiability claim; do not weaken this check." >&2; \
      exit 1; \
    fi; \
    echo "OK: 11 circuits reproduced byte-for-byte from the pinned tree"

# ── stage 2: install every dependency tree, typecheck, build the SPA ─────────
# node for the three npm packages (contracts/v2, frontend/protocols/v1, frontend/protocols/v2),
# bun for the two bun ones (root, frontend). Copied rather than installed: bun ships as one
# static executable, and both bases are Debian trixie.
FROM ${BUN_BASE} AS bunbin

FROM ${NODE_BASE} AS build
COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
RUN set -eux; bun --version; node --version; npm --version

WORKDIR /src
COPY --from=source /src /src
# The freshly compiled v2 artifacts, not the committed copy — byte-identical by the assertion
# above, but this makes "what the page serves" and "what this build compiled" the same bytes
# by construction rather than by argument.
COPY --from=compact /src/contracts/v2/managed /src/contracts/v2/managed

# FIVE INSTALLS, and this is upstream's own CI layout rather than an optimisation to trim.
# The v1 and v2 package trees intentionally carry SEPARATE WASM class identities, and
# `frontend/vite.config.ts`'s `profileRuntimeResolution` plugin routes each generated
# contract's `@midnight-ntwrk/compact-runtime` import to `protocols/<v>/node_modules`. That
# plugin is only EXERCISED when both protocol trees are physically present, so installing
# fewer of them would make this build pass while testing nothing.
#
# Frozen everywhere: the lockfiles at the pinned commit ARE the tested dependency set, so a
# transitive dependency publishing a new version is a build failure rather than a silent
# difference. `bun install --frozen-lockfile` and `npm ci` are the same promise per tool.
RUN bun install --frozen-lockfile
RUN cd frontend && bun install --frozen-lockfile
RUN cd frontend/protocols/v1 && npm ci
RUN cd frontend/protocols/v2 && npm ci

# THE PAGE IS BUILT BEFORE `contracts/v2` IS INSTALLED, and the order is deliberate. Upstream's
# frontend CI job installs exactly the four trees above and no more, so that is the physical
# node_modules layout the built bundle has been tested against. `contracts/v2/managed/`'s
# generated module is imported by the page from OUTSIDE any package root; adding a
# `contracts/v2/node_modules` first would silently change which physical copy of
# @midnightntwrk/onchain-runtime-v4 (and friends) Rollup resolves for it — a different tree from
# the one upstream builds, for no gain. Installing the runner tree afterwards cannot affect a
# bundle that already exists.
RUN cd frontend && bun run typecheck
RUN cd frontend && bun run build

# The runner tree: what the deploy one-shot, the verifier and the round-trip suite all run out
# of, and the only tree the `deploy` target below carries. Typechecked here because it is the
# lane this stack actually uses; the 1.x root tree deliberately is not (see the header — this
# image never selects a 1.x network, and upstream's own CI covers it).
RUN cd contracts/v2 && npm ci
RUN cd contracts/v2 && npm run typecheck

# THE OVERRIDE LANE MUST SURVIVE INTO THE BUNDLE, not merely into the source tree. A
# build-stage grep of the source proves the code was written; only this proves it was shipped.
# `SHIELDED_NIGHT` and `UNDEPLOYED_PROTOCOL` are property names on objects the page reads at
# runtime, so minification cannot rename them and esbuild emits them verbatim — upstream
# documents the first as exactly this grep marker. Without the lane in the bundle, /config.js
# would be written, served, ignored, and the page would show "Local (undeployed)" on a
# ledger-v8 adapter against this ledger-9 chain.
RUN set -eux; \
    grep -rqF 'SHIELDED_NIGHT' /src/frontend/dist/assets \
      || { echo "FAIL: the runtime address-override lane is not in the built bundle" >&2; exit 1; }; \
    grep -rqF 'UNDEPLOYED_PROTOCOL' /src/frontend/dist/assets \
      || { echo "FAIL: the runtime PROTOCOL switch is not in the built bundle; /config.js could not select the 2.x adapter" >&2; exit 1; }; \
    # The label the switch produces, which is what scripts/verify-shielded-night.sh asserts the
    # served bundle carries. Checked here too so a bundler charset change fails at build time
    # with this message rather than as a mysterious verify failure ten minutes into a stack.
    grep -rqF 'Local (undeployed · 2.x)' /src/frontend/dist/assets \
      || { echo "FAIL: the bundle does not carry the 'Local (undeployed · 2.x)' label" >&2; exit 1; }; \
    # vite.config.ts copies contracts/v2/managed into dist/contract/v2/shielded-night; that is
    # where FetchZkConfigProvider looks on the 2.x adapter. dist/contract/compiled/… is the
    # LEGACY path and on `main` it is the v1 (compactc 0.31.1) copy — checking that one would
    # verify the lane this stack never uses.
    test -d /src/frontend/dist/contract/v2/shielded-night/keys; \
    test -d /src/frontend/dist/contract/v2/shielded-night/zkir; \
    # THE MANIFEST IS PART OF THE SERVED SET ON THIS LINE. midnight-js 5's
    # FetchZkConfigProvider verifies integrity against compiler/contract-manifest.json and
    # defaults to 'require' — fail-closed. Copying only keys/ and zkir/ would give a page that
    # loads, connects a wallet, and then refuses to prove anything, with the error naming
    # nothing that appears in this file.
    test -s /src/frontend/dist/contract/v2/shielded-night/compiler/contract-manifest.json \
      || { echo "FAIL: dist/ does not serve the v2 compiler/contract-manifest.json; midnight-js 5 verifies every artifact against it, fail-closed" >&2; exit 1; }; \
    n="$(ls -1 /src/frontend/dist/contract/v2/shielded-night/keys/*.verifier | wc -l)"; \
    test "${n}" -eq 11 || { echo "FAIL: dist serves ${n} v2 verifier keys, expected 11" >&2; exit 1; }

# ── runtime target 1: the deploy one-shot, verify driver and registrar ───────
# node + bun with the pinned tree's `contracts/v2` package and its node_modules ONLY. No
# frontend, no frontend node_modules, and no ROOT node_modules: on `main` the root tree is the
# 1.x/ledger-v8 one and nothing this target runs comes out of it.
#
# WHAT IS STILL COPIED FROM THE ROOT, and why each is load-bearing:
#   package.json    `contracts/v2/scripts/deploy.ts` imports `../../../scripts/load-env.js`,
#                   and the nearest package.json is what marks that file ESM.
#   tsconfig.json   the base config `contracts/v2/tsconfig.json` extends.
#   scripts/        `load-env.ts` itself (node builtins only; the 1.x deploy scripts beside it
#                   are never run here and could not be — their node_modules is not present).
FROM ${NODE_BASE} AS deploy
COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY --from=build /src/package.json /src/tsconfig.json /app/
COPY --from=build /src/scripts      /app/scripts
COPY --from=build /src/contracts/v2 /app/contracts/v2
COPY --from=source /.shielded-night-commit /.shielded-night-commit

COPY entrypoint-common.sh /usr/local/lib/shielded-night/entrypoint-common.sh
# entrypoint-register-token.sh teaches the offer-files kernel THIS stack's sNight colour. It
# lives on this target because the colour derivation needs @midnightntwrk/ledger-v9 — which on
# `main` is in `contracts/v2/node_modules`, NOT in the root one — and because this is the
# target that already mounts the volume the contract address is published on.
COPY entrypoint-deploy.sh entrypoint-verify.sh entrypoint-register-token.sh /usr/local/bin/
RUN set -eux; \
    chmod 0755 /usr/local/bin/entrypoint-deploy.sh /usr/local/bin/entrypoint-verify.sh \
               /usr/local/bin/entrypoint-register-token.sh; \
    chmod 0644 /usr/local/lib/shielded-night/entrypoint-common.sh; \
    # The one-shot publishes here; compose mounts a named volume over it. Creating it in the
    # image means a `docker run` without the volume fails on the deploy rather than on a
    # missing directory three steps later.
    mkdir -p /srv/shielded-night; \
    # The runner tree must be self-sufficient: these are the exact resolutions the three
    # entrypoints depend on, and a missing one would surface as a MODULE_NOT_FOUND deep inside
    # a deploy that has already spent a fee.
    test -x /usr/local/bin/bun; \
    test -d /app/contracts/v2/node_modules/@midnightntwrk/ledger-v9 \
      || { echo "FAIL: the runner tree has no @midnightntwrk/ledger-v9; the sNight colour cannot be derived" >&2; exit 1; }; \
    test -d /app/contracts/v2/managed/keys; \
    test -f /app/scripts/load-env.ts \
      || { echo "FAIL: scripts/load-env.ts is missing; contracts/v2/scripts/deploy.ts imports it" >&2; exit 1; }; \
    # …and it must NOT have inherited the 1.x tree. If a future edit copies the root
    # node_modules in, `@midnight-ntwrk/ledger-v8` would sit beside ledger-v9 in one resolution
    # scope, which is the failure mode this whole two-tree layout exists to prevent.
    test ! -e /app/node_modules \
      || { echo "FAIL: the root (1.x/ledger-v8) node_modules is in the runner image" >&2; exit 1; }

# No CMD: compose names the entrypoint per service, exactly as images/offerfiles-kernel does
# for its three roles.
ENTRYPOINT ["/usr/local/bin/entrypoint-deploy.sh"]

# ── runtime target 2: nginx serving the SPA and the ZK artifacts ─────────────
FROM ${NGINX_BASE} AS web

COPY --from=build  /src/frontend/dist /usr/share/nginx/html
COPY --from=source /.shielded-night-commit /.shielded-night-commit
COPY PROVENANCE.md /usr/share/licenses/shielded-night/PROVENANCE.md

# /config.js is OVERWRITTEN at container start (entrypoint-web.sh) with this stack's contract
# address AND its protocol switch. NOTHING IS PATCHED HERE: the pinned tree ships the
# placeholder and the tag, so the built output is used exactly as `vite build` emitted it. What
# is asserted is that both survived the build, and IN THE RIGHT ORDER — the tag is a classic
# script and the bundle a deferred module, so a config.js referenced after the module tag would
# still execute first, but a config.js that is not referenced at all is an override lane that
# silently does nothing.
RUN set -eux; \
    test -f /usr/share/nginx/html/config.js \
      || { echo "FAIL: dist/ carries no config.js — the entrypoint would create a file nothing loads" >&2; exit 1; }; \
    grep -q '<script src="/config.js">' /usr/share/nginx/html/index.html \
      || { echo "FAIL: the built index.html does not load /config.js" >&2; exit 1; }; \
    # The 2.x artifact tree is what this deployment serves; the legacy /contract/compiled/ path
    # is the v1 copy and is left exactly as vite emitted it.
    test -s /usr/share/nginx/html/contract/v2/shielded-night/compiler/contract-manifest.json \
      || { echo "FAIL: the site does not serve the v2 ZK integrity manifest" >&2; exit 1; }

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
