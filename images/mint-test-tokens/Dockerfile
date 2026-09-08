# mint-test-tokens — the six native Midnight test-token issuers, their canonical registry,
# and the static faucet site that mints from them, on the Midnight 2.x line.
#
# ONE BUILD, TWO RUNTIME TARGETS, and they are deliberately different sizes:
#
#   --target runner   node + the pinned tree + ITS `.git` + the root and contracts/v2
#                     node_modules. This is the deploy one-shot, the read-only verifier,
#                     the registry bridge that teaches the offer-files kernel the six
#                     local colours, and the wallet mint test. It serves no page.
#   --target site     node + `frontend/dist` + upstream's own static server. It holds no
#                     seed, no node_modules and no `.git`, and it reads the registry from a
#                     mounted DIRECTORY on every request.
#
# SOURCE IS FETCHED DIRECTLY from effectstream/mint-test-tokens at an immutable full commit.
# Nothing of it is committed to this repository, so a cold build needs GitHub + npm network
# access. See PROVENANCE.md.
#
# ─── NO COMPILER, ON PURPOSE — and that is not a shortcut ────────────────────
# Every other from-source image in this stack compiles its Compact contract and asserts the
# result equals the committed artifacts. This one MUST NOT. `contracts/v2/managed/` is
# TRACKED upstream (91 files, 62 MB, compactc 0.34.0 / language 0.26.0 / runtime 0.19.0), and
# the deploy runner's own provenance check requires the artifact bytes on disk to equal the
# bytes at the pinned commit, byte-for-byte, with no dirty, untracked or ignored file under
# `contracts/v2/{shielded-token.compact,unshielded-token.compact,managed/shielded,managed/unshielded}`.
# A recompile into that tree would therefore FAIL the deploy — the tool this image exists to
# run is stricter than a rebuild-and-diff would be, because it also proves the bytes are the
# ones a third party can fetch from the commit. So the assertion here is that the artifacts
# ARE tracked and DO carry the declared toolchain, and stage `build` then runs the upstream
# verifier itself so a tree that would fail at bring-up fails at build time instead.
#
# ─── THE PLAIN PROOF SERVER, not the experimental one ────────────────────────
# `managed/*/zkir/*.zkir` declare `"version": {"major": 2}` — zkir-v2, the default lane, the
# same one the kernel's [v6] keys use. The `aa-proof-server` (experimental) exists for the AA
# contracts' `--feature-zkir-v3` [v7] keys and is NOT what this profile dials. compose/faucet.yml
# points MN_PROOF_SERVER_URL at core's plain `proof-server`, and the assertion below keeps that
# choice honest: a re-pin whose artifacts moved to zkir-v3 fails HERE, not as an unprovable mint.
#
# ─── WHY THE FETCH NAMES THREE COMMITS ───────────────────────────────────────
# `frontend/scripts/verify-client-artifacts.mjs` runs on every `frontend` build/test and does
# `git ls-tree` / `git show` at the two revisions recorded in `frontend/client-artifacts.json`
# — historical commits that a plain `git fetch --depth 1 origin <pin>` does not contain. They
# are fetched explicitly, as ARGs, and stage `source` asserts the ARGs still equal what the
# pinned tree's own manifest names, so the two can never drift apart silently.

# ── base images: index digests, not tags ─────────────────────────────────────
# DEBIAN_BASE is the digest images/indexer, images/celestia and images/shielded-night already
# pin here. NODE_BASE is the official multiarch node index (linux/amd64 + linux/arm64) for the
# version upstream's own verified release export builds with; `-slim` because git and
# postgresql-client are installed explicitly below and nothing else in the fat variant is used.
# Neither needs a `platform:` pin — which is just as well, since scripts/lib/compose_pins.py
# rejects one outright.
ARG DEBIAN_BASE=debian:trixie-slim@sha256:f6e2cfac5cf956ea044b4bd75e6397b4372ad88fe00908045e9a0d21712ae3ba
ARG NODE_BASE=node:24.15.0-trixie-slim@sha256:291be77873bc04731968cacf82f0fcef17cee8cf200c6b6951e2bcab41560eb7

ARG MINT_TEST_TOKENS_REPO=https://github.com/effectstream/mint-test-tokens.git
# effectstream/mint-test-tokens `main` — the merge of PR #4, the commit that publishes the
# verified Preprod registry and the v2 (Midnight 2.x) issuer set this stack deploys locally.
ARG MINT_TEST_TOKENS_REF=7ecad008b07acb2a491d8291e05455cbd638910f
# NOT free choices: these are the two revisions `frontend/client-artifacts.json` pins at
# MINT_TEST_TOKENS_REF, and stage `source` asserts the file still says so.
ARG MINT_TEST_TOKENS_CLIENT_V1_REV=418cce599bc1f712ba1a0d277765f96e2f693e27
ARG MINT_TEST_TOKENS_CLIENT_V2_REV=fdf0739cf2d342b283187ef8304a1784c7ec6bc2

# ── stage 0: the exact upstream tree, and what it must contain ───────────────
FROM ${DEBIAN_BASE} AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG MINT_TEST_TOKENS_REPO
ARG MINT_TEST_TOKENS_REF
ARG MINT_TEST_TOKENS_CLIENT_V1_REV
ARG MINT_TEST_TOKENS_CLIENT_V2_REV

WORKDIR /src
RUN set -eux; \
    for ref in "${MINT_TEST_TOKENS_REF}" "${MINT_TEST_TOKENS_CLIENT_V1_REV}" "${MINT_TEST_TOKENS_CLIENT_V2_REV}"; do \
      # A full 40-hex commit, always. `git fetch --depth 1 origin <sha>` refuses an abbreviated
      # sha and cannot see a branch move — the cheapest possible enforcement of this
      # repository's pinning rule, and `main` here is a LIVE branch that will keep moving.
      case "${ref}" in \
        ????????????????????????????????????????) : ;; \
        *) echo "FAIL: '${ref}' must be a full 40-character commit SHA" >&2; exit 1 ;; \
      esac; \
      case "${ref}" in *[!0-9a-f]*) echo "FAIL: '${ref}' must be lowercase hex" >&2; exit 1 ;; esac; \
    done; \
    git init -q .; \
    git remote add origin "${MINT_TEST_TOKENS_REPO}"; \
    # ONE fetch, THREE commits: the pin, plus the two client-artifact revisions the frontend
    # build reads history at. Shallow at each, ~33 MB in ~3 s.
    git fetch -q --depth 1 origin \
      "${MINT_TEST_TOKENS_REF}" \
      "${MINT_TEST_TOKENS_CLIENT_V1_REV}" \
      "${MINT_TEST_TOKENS_CLIENT_V2_REV}"; \
    git checkout -q "${MINT_TEST_TOKENS_REF}"; \
    actual="$(git rev-parse HEAD)"; \
    test "${actual}" = "${MINT_TEST_TOKENS_REF}"; \
    git rev-parse --verify -q "${MINT_TEST_TOKENS_CLIENT_V1_REV}^{commit}" >/dev/null; \
    git rev-parse --verify -q "${MINT_TEST_TOKENS_CLIENT_V2_REV}^{commit}" >/dev/null; \
    printf '%s' "${actual}" > /.mint-test-tokens-commit

# THE ARTIFACTS MUST BE TRACKED, and the tree must be clean at the pin.
#
# This is the single precondition of everything this image does: `deploy` and `verify` both
# call resolveReproducibleSourceRevision(), which refuses to run when ANY file under the four
# declared source/artifact paths is modified, untracked or ignored. Proving it here means a
# re-pin to a tree that generates its artifacts at install time (or gitignores them) fails as
# THIS message rather than as "Source/artifact bytes do not match SOURCE_REVISION" three
# minutes into a bring-up.
RUN set -eux; \
    cd /src; \
    for d in contracts/v2/managed/shielded contracts/v2/managed/unshielded; do \
      n="$(git ls-files "$d" | wc -l)"; \
      test "$n" -gt 0 \
        || { echo "FAIL: ${d} is NOT tracked at ${MINT_TEST_TOKENS_REF}; this image compiles nothing" >&2; exit 1; }; \
    done; \
    test -z "$(git status --porcelain -- \
        contracts/v2/shielded-token.compact contracts/v2/unshielded-token.compact \
        contracts/v2/managed/shielded contracts/v2/managed/unshielded)" \
      || { echo "FAIL: the v2 source/artifact paths are dirty at the pin" >&2; exit 1; }; \
    # Five circuits per issuer (name, symbol, decimals, tokenColor, mint), each with a prover
    # and a verifier key. "the tree has SOMETHING" and "the tree has THIS contract" are
    # different claims and only the second one is worth anything.
    for d in contracts/v2/managed/shielded contracts/v2/managed/unshielded; do \
      n="$(ls -1 "$d"/keys/*.verifier | wc -l)"; \
      test "$n" -eq 5 || { echo "FAIL: ${d} has ${n} verifier keys, expected 5" >&2; ls -1 "$d/keys" >&2; exit 1; }; \
      test -s "$d/compiler/contract-manifest.json" \
        || { echo "FAIL: ${d} ships no compiler/contract-manifest.json" >&2; exit 1; }; \
    done

# THE TOOLCHAIN THE TREE ITSELF DECLARES, asserted at both places it is written down. The
# compatibility snapshot is what the registry publishes and what `verify` compares against;
# contract-info.json is what the compiler actually stamped into the artifacts. They must agree,
# and they must be the 2.x tuple this stack runs.
RUN set -eux; \
    cd /src; \
    grep -q '"compiler": "0.34.0"'          compatibility.json; \
    grep -q '"compactRuntime": "0.19.0"'    compatibility.json; \
    grep -q '"ledger": "1.0.0-rc.3"'        compatibility.json; \
    grep -q '"midnightJs": "5.0.0-beta.7"'  compatibility.json; \
    grep -q '"walletSdk": "2.0.0-beta.2"'   compatibility.json; \
    grep -q '"proofServer": "9.0.0-rc.5"'   compatibility.json; \
    for d in contracts/v2/managed/shielded contracts/v2/managed/unshielded; do \
      grep -q '"compiler-version": "0.34.0"' "$d/compiler/contract-info.json"; \
      grep -q '"runtime-version": "0.19.0"'  "$d/compiler/contract-info.json"; \
    done; \
    # zkir-v2, i.e. the PLAIN proof server. compose/faucet.yml dials core's `proof-server`; a
    # re-pin whose artifacts moved to the experimental zkir-v3 lane must fail here.
    for f in contracts/v2/managed/shielded/zkir/mint.zkir contracts/v2/managed/unshielded/zkir/mint.zkir; do \
      head -c 200 "$f" | grep -q '"major": 2' \
        || { echo "FAIL: ${f} is not zkir-v2; this profile proves on the PLAIN proof-server" >&2; exit 1; }; \
    done; \
    # ledger-v9, and NO ledger-v8 anywhere in the resolved v2 lockfile: two ledger wasm
    # instances in one process fail `instanceof` during proving, hours later and nowhere near
    # the cause. Same check images/shielded-night makes, for the same reason.
    grep -q '"@midnightntwrk/ledger-v9": "1.0.0-rc.3"' contracts/v2/package.json; \
    if grep -q 'ledger-v8' contracts/v2/package-lock.json; then \
      echo "FAIL: contracts/v2/package-lock.json resolves ledger-v8" >&2; exit 1; \
    fi; \
    grep -q 'ledger-v9' contracts/v2/package-lock.json

# THE SIX TOKENS, by symbol. The registry bridge, verify-faucet.sh and the docs all name these
# six; a re-pin that renamed or added one must fail here rather than leave a bridge that
# silently registers five rows.
RUN set -eux; \
    cd /src; \
    for s in twBTC twETH twUSDC twUSDM utwUSDC utwBTC; do \
      grep -q "symbol: \"${s}\"" packages/registry/src/tokens.ts \
        || { echo "FAIL: packages/registry/src/tokens.ts no longer declares ${s}" >&2; exit 1; }; \
    done; \
    n="$(grep -c 'domainSeparator: "mint-test-tokens:' packages/registry/src/tokens.ts)"; \
    test "$n" -eq 6 || { echo "FAIL: expected 6 token definitions, found ${n}" >&2; exit 1; }

# ── the integration knobs this profile is built on ───────────────────────────
# Each asserted at its source of truth, by the name compose/faucet.yml actually sets, so a
# re-pin that dropped one fails HERE instead of as a one-shot dialling 127.0.0.1 inside a
# container or a site that serves the wrong registry.
RUN set -eux; \
    cd /src; \
    # 1. Endpoint overrides: a deploy running INSIDE compose must dial service hostnames.
    #    Upstream's `undeployed` defaults are loopback, and inside a container loopback is
    #    this container.
    for v in MN_NODE_URL MN_NODE_WS_URL MN_INDEXER_URL MN_INDEXER_WS_URL MN_PROOF_SERVER_URL; do \
      grep -q "$v" scripts/lib/network-config.ts \
        || { echo "FAIL: scripts/lib/network-config.ts does not honour ${v}" >&2; exit 1; }; \
    done; \
    # 2. A shared OUTPUT DIRECTORY, not a hard-coded path. `metadata.undeployed.json` is
    #    replaced by atomic rename, so consumers mount the directory and re-open by path.
    grep -q 'MN_METADATA_OUTPUT_DIR' contracts/v2/deploy.ts; \
    grep -q 'MN_SEED_FILE' contracts/v2/deploy.ts; \
    # 3. The static server's three knobs and its registry route.
    for v in MINT_SITE_DIR MINT_METADATA_DIR MINT_SITE_PORT; do \
      grep -q "$v" frontend/scripts/serve-static.mjs \
        || { echo "FAIL: frontend/scripts/serve-static.mjs does not honour ${v}" >&2; exit 1; }; \
    done; \
    grep -q 'undeployed' frontend/scripts/serve-static.mjs \
      || { echo "FAIL: the static server does not serve /metadata.undeployed.json" >&2; exit 1; }; \
    grep -q '"serve:local"' frontend/package.json; \
    # 4. The runner scripts compose/faucet.yml invokes, by the exact npm script name.
    for s in '"deploy"' '"verify"' '"test:wallet"'; do \
      grep -q "$s" contracts/v2/package.json \
        || { echo "FAIL: contracts/v2/package.json has no ${s} script" >&2; exit 1; }; \
    done

# THE TWO CLIENT-ARTIFACT REVISIONS ARE THE ONES THIS BUILD FETCHED. Without this the build
# args and the tree's own manifest could drift, and the frontend build would fail deep inside
# `git ls-tree` with a message naming neither.
RUN set -eux; \
    cd /src; \
    grep -q "\"sourceRevision\": \"${MINT_TEST_TOKENS_CLIENT_V1_REV}\"" frontend/client-artifacts.json \
      || { echo "FAIL: frontend/client-artifacts.json does not pin v1 at ${MINT_TEST_TOKENS_CLIENT_V1_REV}" >&2; exit 1; }; \
    grep -q "\"sourceRevision\": \"${MINT_TEST_TOKENS_CLIENT_V2_REV}\"" frontend/client-artifacts.json \
      || { echo "FAIL: frontend/client-artifacts.json does not pin v2 at ${MINT_TEST_TOKENS_CLIENT_V2_REV}" >&2; exit 1; }

# ── stage 1: install, prove the provenance gate, build the site ──────────────
FROM ${NODE_BASE} AS build

# git is a RUNTIME dependency of the deploy/verify runners, not only a build one: they shell
# out to it for the artifact provenance check. It is installed here so the check below runs,
# and again in the runner target for the same reason.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=source /src /app
COPY --from=source /.mint-test-tokens-commit /.mint-test-tokens-commit

# The tree is owned by root and this stage runs as root, but a future non-root runtime would
# make git refuse the repository outright ("dubious ownership") and the provenance check would
# fail with a message about permissions rather than about bytes.
RUN git config --system --add safe.directory /app

# FOUR INSTALLS, and none of them is optional.
#   root                  tsc + ajv for `npm run check`, which `frontend build` invokes, and
#                         tsx for the artifact-provenance check below
#   contracts/v2          the 2.x deploy/verify/mint runtime (isolated lockfile, on purpose)
#   frontend              vite/react and the two `file:` workspace packages
#   frontend/protocols/*  the v1 and v2 browser adapters — SEPARATE lockfiles, deliberately:
#                         upstream keeps the WASM-backed 1.x and 2.x graphs apart so they
#                         cannot be deduplicated into an incompatible runtime.
# `--ignore-scripts` on the runtime context is upstream's own documented install line.
RUN npm ci --ignore-scripts
RUN npm --prefix contracts/v2 ci --ignore-scripts
RUN npm --prefix frontend ci
RUN npm --prefix frontend/protocols/v1 ci
RUN npm --prefix frontend/protocols/v2 ci

# THE PROVENANCE GATE THIS IMAGE LIVES OR DIES BY, run at BUILD time.
#
# `deploy` and `verify` both call resolveReproducibleSourceRevision(root, SOURCE_REVISION,
# sourcePathsForProfile("v2")) before they touch the chain. It resolves HEAD, proves every
# declared path exists at that commit, and refuses if `git diff` / `git ls-files --others`
# report anything. Running it here means an image whose install step dirtied the artifact tree,
# whose `.git` did not survive the copy, or whose git refuses the directory, fails in seconds
# at build time instead of after a chain, an indexer and a prover have been brought up.
#
# It is written into the repository ROOT rather than into contracts/v2: the four paths the
# checker looks at are all under contracts/v2/{…}, and a stray file there — even one git
# ignores — is exactly what it is built to reject.
RUN set -eux; \
    printf '%s\n' \
      'import { resolveReproducibleSourceRevision, sourcePathsForProfile } from "./scripts/lib/deployment-provenance.js";' \
      'const paths = sourcePathsForProfile("v2");' \
      'const rev = resolveReproducibleSourceRevision(process.cwd(), process.env.SOURCE_REVISION, paths);' \
      'if (rev !== process.env.EXPECTED_REV) {' \
      '  console.error(`artifact provenance resolved ${rev}, expected ${process.env.EXPECTED_REV}`);' \
      '  process.exit(1);' \
      '}' \
      'console.log(`OK: v2 source/artifact bytes match ${rev} for ${paths.length} declared paths`);' \
      > /app/.faucet-artifact-check.ts; \
    EXPECTED_REV="$(cat /.mint-test-tokens-commit)" \
      node --import tsx /app/.faucet-artifact-check.ts; \
    rm -f /app/.faucet-artifact-check.ts

# THE SITE. `frontend build` chains `npm --prefix .. run check` (root tsc + the registry
# schema validator), `verify:client-artifacts` (the git-history check the three-commit fetch
# above exists for), `tsc --noEmit` and `vite build`.
RUN npm --prefix frontend run build

# WHAT THE SITE MUST HAVE SHIPPED. A build that produced "something" is not the claim; the
# claim is that this page can select `undeployed`, read a registry from a mounted directory,
# and prove a mint with the v2 adapter's own artifacts.
RUN set -eux; \
    test -s /app/frontend/dist/index.html; \
    # The local registry must NOT be baked in — it is per-stack state, served from a volume.
    test ! -e /app/frontend/dist/metadata.undeployed.json \
      || { echo "FAIL: dist/ carries a metadata.undeployed.json; that file is per-stack state" >&2; exit 1; }; \
    # The v2 browser adapter's receiver artifacts, as bytes. Upstream's own release gate
    # checks exactly these two.
    test -s /app/frontend/dist/contract/v2/receiver/zkir/receiveShieldedTokenFromIssuer.bzkir; \
    test -s /app/frontend/dist/contract/v2/receiver/zkir/receiveUnshieldedTokenFromIssuer.zkir; \
    # The network selector must know `undeployed`, or `/?network=undeployed` is a dead link.
    grep -rqF 'undeployed' /app/frontend/dist/assets \
      || { echo "FAIL: the built bundle never mentions the undeployed network" >&2; exit 1; }

# ── runtime target 1: deploy / verify / bridge / mint ────────────────────────
FROM ${NODE_BASE} AS runner

# git — the artifact provenance check shells out to it on EVERY deploy and verify.
# postgresql-client — the registry bridge's ONE `UPDATE known_tokens … WHERE name`: the
#   kernel serves only GET and POST for that table and answers 409 when a name is taken with a
#   different colour, which is the single case its API cannot express. See
#   entrypoint-registry-bridge.sh, and images/shielded-night/entrypoint-register-token.sh,
#   which solves the identical problem for sNight.
# ca-certificates — the wallet SDK and midnight-js dial the indexer over https on any network
#   other than this one, and a runner that could not is a runner that fails only off-devnet.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /app

WORKDIR /app
# The tree AND its `.git`: the provenance check is not optional, and `.git` is what makes it
# possible. The frontend is deliberately left out of this target — it never serves a page.
COPY --from=build /app/.git            /app/.git
COPY --from=build /app/contracts       /app/contracts
COPY --from=build /app/packages        /app/packages
COPY --from=build /app/schema          /app/schema
COPY --from=build /app/scripts         /app/scripts
COPY --from=build /app/metadata        /app/metadata
COPY --from=build /app/node_modules    /app/node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.json /app/compatibility.json /app/
COPY --from=source /.mint-test-tokens-commit /.mint-test-tokens-commit

COPY entrypoint-common.sh /usr/local/lib/mint-test-tokens/entrypoint-common.sh
COPY entrypoint-deploy.sh entrypoint-verify.sh entrypoint-registry-bridge.sh entrypoint-mint-test.sh \
     /usr/local/bin/
RUN set -eux; \
    chmod 0755 /usr/local/bin/entrypoint-deploy.sh /usr/local/bin/entrypoint-verify.sh \
               /usr/local/bin/entrypoint-registry-bridge.sh /usr/local/bin/entrypoint-mint-test.sh; \
    chmod 0644 /usr/local/lib/mint-test-tokens/entrypoint-common.sh; \
    # compose mounts named volumes over both. Creating them here means a `docker run` without
    # the volumes fails on the deploy itself rather than on a missing directory.
    mkdir -p /registry /app/.local; \
    # The tree must still be clean AFTER the copy — a COPY that lost a file, or an apt layer
    # that wrote into the work tree, would otherwise surface as a failed deploy.
    cd /app && test -z "$(git status --porcelain -- \
        contracts/v2/shielded-token.compact contracts/v2/unshielded-token.compact \
        contracts/v2/managed/shielded contracts/v2/managed/unshielded)"

# No CMD: compose names the entrypoint per service, exactly as images/shielded-night and
# images/offerfiles-kernel do for their several roles.
ENTRYPOINT ["/usr/local/bin/entrypoint-deploy.sh"]

# ── runtime target 2: the static faucet site ─────────────────────────────────
# node, `frontend/dist`, and upstream's OWN static server — no nginx, because the registry is
# not a file in the document root: `serve-static.mjs` answers /metadata.{network}.json out of a
# separate directory, re-opened by path on every request, which is what makes the deploy's
# atomic rename visible without restarting anything.
#
# It carries no `.git`, no node_modules and no seed. `npm run serve:local` needs neither: the
# script is dependency-free node, and invoking it through npm keeps this image on upstream's
# documented command instead of a transcription of it.
FROM ${NODE_BASE} AS site

WORKDIR /app
COPY --from=build /app/frontend/dist            /app/frontend/dist
COPY --from=build /app/frontend/scripts         /app/frontend/scripts
COPY --from=build /app/frontend/package.json    /app/frontend/package.json
COPY --from=source /.mint-test-tokens-commit    /.mint-test-tokens-commit
COPY PROVENANCE.md /usr/share/licenses/mint-test-tokens/PROVENANCE.md
COPY entrypoint-site.sh healthcheck-site.sh /usr/local/bin/
RUN set -eux; \
    chmod 0755 /usr/local/bin/entrypoint-site.sh /usr/local/bin/healthcheck-site.sh; \
    mkdir -p /registry; \
    # The npm script this image is built around, and the file it runs. Asserted rather than
    # trusted: a re-pin that renamed either would give a container that exits 1 at start with
    # a message about npm, not about this image.
    grep -q '"serve:local"' /app/frontend/package.json; \
    test -s /app/frontend/scripts/serve-static.mjs

# Container port 14119 — upstream's own default, kept so the published host port is the only
# thing this stack chooses. compose/faucet.yml publishes it as ${FAUCET_PORT:-10950}.
EXPOSE 14119
ENTRYPOINT ["/usr/local/bin/entrypoint-site.sh"]
