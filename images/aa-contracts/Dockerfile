# aa-contracts — deploy the AA Manager + test Minter on the demo chain at bring-up,
# and mint a token (profile `aa`, one-shot service `aa-deploy`).
#
# Source: acedward/AA-midnight-evm-experiment-v3 — contracts/manager.compact (the
# account-abstraction custody contract, since 41de69d a PRESET plus nine modules
# under contracts/modules/) and contracts/test-support/minter.compact
# (per-deployment-tag token source). Fetched from the remote like the other images,
# so `git clone <this repo> && ./up.sh --with aa` works with nothing else checked out.
#
# TOOLCHAIN FIDELITY — ONE compactc, ONE compact-runtime, and issues/00011 is
# CLOSED. The compactc pin is READ FROM THE PINNED KERNEL TREE
# (`infra/compact-version.txt` — 0.34.0 at this KERNEL_REF), because one compactc
# and one compact-runtime compile BOTH contract sets in this image. Until the
# kernel moved (PR #67, this re-pin) the two sets disagreed: the AA repo was a
# 0.34.0 / runtime 0.19.0 build (AA PR #11) while the kernel line still declared
# 0.33.0-rc.2 / 0.18.0-rc.1, and this image papered over it by compiling the AA
# contracts with the kernel's older compactc — legitimate only because the ZKIR
# came out byte-identical (measured 2026-09-04, all nine circuits, e.g.
# execute.zkir 1ec9f501…). That was a coincidence to be verified per release,
# not a property. Both halves are now 0.34.0 by construction, and the guard in
# stage 2 no longer tolerates a version whose emitted `--runtime-version`
# disagrees with what the runner installs. `--build-arg COMPACT_VERSION=<x>`
# still overrides for a deliberate experiment.
#
# It compiles with `--feature-zkir-v3`, and that flag is load-bearing: the Manager
# is keccak/EIP-712-heavy and its compactc artifact is a v3-lane one. v3 zkir emits
# verifier-key[v7], which the PLAIN proof-server 9.0.0-rc.5 cannot prove calls
# against — which is why compose/aa.yml ships its own INTERNAL experimental
# 9.0.0-rc.5 proof server (AA_PROOF_IMAGE, digest-pinned) instead of repointing
# the whole stack's proving at one variant. The two builds are different
# programs, not two tags on one image.
#
# THE MANAGER'S `execute` COMES FROM THE MinoCrab PORT BY DEFAULT.
# acedward/AA-midnight-evm-experiment-minocrab is a Rust transcription of the same
# contract into MinoCrab, an UNAUDITED third-party alternative compiler for
# Midnight. Its `execute` lands at k = 18 / 211,047 rows where compactc lands at
# k = 19 / 382,780: half the proving key (544 MiB vs 1.14 GB) and roughly half the
# proving time, at an unchanged statement, proof size and public-input count.
# Equivalence is TESTED, NOT PROVEN (59 differential tests, 26 scenarios, 5,128
# tamper probes, 0 acceptance disagreements) — DEV CHAINS ONLY. See
# docs/KNOWN-LIMITATIONS.md.
#
# The artifacts are NOT built here and NOT copied from a handoff folder: they are
# the port's own PUBLISHED RELEASE ASSETS, downloaded and identified by SHA-256
# (config/artifact-decisions.json rule: an exact published binary is taken by hash,
# never recompiled). The chain of trust is one 3 KB file — `SHA256SUMS`, whose own
# SHA-256 is pinned here as MINOCRAB_SUMS_SHA256 — which covers `manifest.json`,
# which in turn states the release tag, the port commit, the MinoCrab rev, the
# contract pin, the compactc/zkir-v3 hashes, the SRS per k and every circuit's
# k/rows/sizes/hashes. The build asserts all three identities and fails closed.
#
# KEYS. `AA_PRUNE_MANAGER_PROVERS=1` (default) keeps the Manager's `.prover` files
# out of the image: bring-up DEPLOYS the Manager but never CALLS it, and a deploy
# needs only the verifier keys. The AA console and the E2E DO call `execute` and
# prove it locally (runner/aa-console.ts builds the provider with
# `withCompiledFileAssets`, so the proving key is read out of THIS image and sent
# to aa-proof-server — the proof server holds no circuit keys of its own), so both
# build with `AA_PRUNE_MANAGER_PROVERS=0`. The MinoCrab fetch below follows that
# same switch: the 544 MiB `execute.prover` is downloaded only when it will be
# used, and a default `aa-deploy` build takes ~180 KB of MinoCrab artifacts.
# Because the compactc artifact for a swapped circuit is deleted in stage 2 rather
# than shadowed in a later layer, the console image gets SMALLER, not larger.

ARG AA_REPO=https://github.com/acedward/AA-midnight-evm-experiment-v3.git
ARG AA_REF=41de69ded41ff933fe0db8697b264dc46fc6e0cb
ARG KERNEL_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG KERNEL_REF=80bace37bc2412542452e1c597761b2ebce5c677
# EMPTY ON PURPOSE — see the TOOLCHAIN FIDELITY note above.
ARG COMPACT_VERSION=

# ── the MinoCrab release pins ────────────────────────────────────────────────
# THREE DIFFERENT KINDS OF THING, deliberately separate:
#   MINOCRAB_RELEASE      a LOCATOR (a tag is mutable and is not an identity)
#   MINOCRAB_REF          the port commit the assets were built from, for the
#                         image label verify-source-pins.sh asserts
#   MINOCRAB_SUMS_SHA256  the IDENTITY: the SHA-256 of the release's SHA256SUMS,
#                         which is the only file in the release not covered by
#                         the release itself. Everything else is covered by it.
ARG MINOCRAB_REPO=https://github.com/acedward/AA-midnight-evm-experiment-minocrab
ARG MINOCRAB_RELEASE=v0.2.0
ARG MINOCRAB_REF=7cdfa5b0c994a70502ab2b564b509c8abe2f7efb
ARG MINOCRAB_SUMS_SHA256=4a8c0183cd887e3ca2d3446f196fab1102540e09d6e0e8ae9c1859532d8dd7ac
# Override the download base entirely (a mirror, a cache). Empty means
# "${MINOCRAB_REPO}/releases/download/${MINOCRAB_RELEASE}". Switching between the
# release and any other transport is THIS ONE build arg — the verification does
# not change with it.
ARG MINOCRAB_FETCH_BASE=
# minocrab (default): the port supplies `execute` only — the one circuit with
#                     end-to-end proving evidence, and the only one where k moves.
# minocrab-all      : the port supplies all nine provable circuits.
# compactc          : opt out; the stock compactc artifact end to end.
ARG AA_ZKIR_SOURCE=minocrab
# 1 (default): prune the Manager's .prover files — deploys need only verifier keys.
# 0: keep them — required by anything that CALLS execute (the console service and
# scripts/aa-e2e.sh's :e2e tag both build with 0).
ARG AA_PRUNE_MANAGER_PROVERS=1

# ── stage 1: fetch the AA sources ────────────────────────────────────────────
FROM debian:stable-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG AA_REPO
ARG AA_REF
ARG KERNEL_REPO
ARG KERNEL_REF

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$AA_REPO" \
 && git fetch -q --depth 1 origin "$AA_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /aa-commit \
 && rm -rf .git

# The AA console also exposes offer-file mint/offer actions. Fetch only the
# pinned kernel source needed to compile that matching contract; this keeps the
# documented core+aa profile standalone on a clean clone.
WORKDIR /kernel-src
RUN git init -q . \
 && git remote add origin "$KERNEL_REPO" \
 && git fetch -q --depth 1 origin "$KERNEL_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /kernel-commit \
 && rm -rf .git

# ── stage 2: compile + keygen with the pinned compactc ───────────────────────
FROM debian:stable-slim AS compact

ARG COMPACT_VERSION
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

# The compactc pin, its SHA-256 and the runtime the offer-files half expects all
# travel with the pinned kernel source — see the ARG note. The OTHER half of the
# same invariant (the runner's INSTALLED compact-runtime) is checked in stage 3,
# where `bun install` has actually resolved it; doing it here would mean copying
# runner/package.json into this stage and making every runner dependency edit
# invalidate ~20 minutes of keygen.
COPY --from=source /kernel-src/infra/compact-version.txt    /opt/compact-version.txt
COPY --from=source /kernel-src/infra/compact-checksums.sha256 /opt/compact-checksums.sha256
COPY --from=source /kernel-src/packages/contracts-midnight/contract-offer-files/package.json /opt/contract-package.json

RUN set -eux; \
    COMPACT_VERSION="${COMPACT_VERSION:-$(tr -d ' \t\n\r' < /opt/compact-version.txt)}"; \
    test -n "${COMPACT_VERSION}" || { echo "infra/compact-version.txt is empty at this KERNEL_REF" >&2; exit 1; }; \
    echo "compactc pin: ${COMPACT_VERSION} (from the pinned kernel tree)"; \
    case "${TARGETARCH:-arm64}" in \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o "/tmp/${asset}" "$url"; \
    expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' /opt/compact-checksums.sha256)"; \
    test -n "$expected" || { echo "the pinned kernel tree records no SHA-256 for ${asset}" >&2; exit 1; }; \
    printf '%s  %s\n' "$expected" "/tmp/${asset}" | sha256sum -c -; \
    mkdir -p /opt/compactc; \
    unzip -q "/tmp/${asset}" -d /opt/compactc; \
    rm "/tmp/${asset}"; \
    chmod +x /opt/compactc/*; \
    test -x /opt/compactc/zkir || { echo "asset lacks the zkir backend" >&2; exit 1; }; \
    test "$(/opt/compactc/compactc --version)" = "${COMPACT_VERSION}"; \
    got_runtime="$(/opt/compactc/compactc --runtime-version)"; \
    want_runtime="$(sed -n 's/.*"@midnight-ntwrk\/compact-runtime"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /opt/contract-package.json | head -n 1)"; \
    test -n "$want_runtime" || { echo "the pinned kernel's contract package declares no @midnight-ntwrk/compact-runtime" >&2; exit 1; }; \
    test "$got_runtime" = "$want_runtime" || { echo "FAIL: compactc ${COMPACT_VERSION} emits code for compact-runtime ${got_runtime}, but the pinned kernel's contract package depends on ${want_runtime}" >&2; exit 1; }; \
    echo "compactc ${COMPACT_VERSION} / language $(/opt/compactc/compactc --language-version) / runtime ${got_runtime}"; \
    printf '%s\n' "${COMPACT_VERSION}" > /opt/compactc-version; \
    printf '%s\n' "${got_runtime}"     > /opt/compact-runtime-version

COPY --from=source /src/contracts /contracts
COPY --from=source /kernel-src/packages/contracts-midnight/contract-offer-files/src/offer-files.compact /contracts/offer-files.compact

# Keys need the universal SRS from srs.midnight.network (a build-time network
# fetch, like the git clone). Layout matches what deployMidnightContract expects:
# <contract-name>/src/managed/.
#
# THE SWAPPED CIRCUITS' COMPACTC ARTIFACTS ARE DELETED HERE, not shadowed later.
# A later layer that writes over a file does not remove the earlier copy from the
# image, so overlaying the 544 MiB MinoCrab prover key on top of the 1.14 GB
# compactc one would make the image carry BOTH. Deleting in the layer that
# created them is what makes the MinoCrab default a size WIN. Flipping
# AA_ZKIR_SOURCE therefore invalidates this stage and recompiles — which is
# honest: the artifact tree really is different.
ARG AA_PRUNE_MANAGER_PROVERS
ARG AA_ZKIR_SOURCE
RUN set -eux; \
    case "${AA_ZKIR_SOURCE:-minocrab}" in \
      minocrab|minocrab-all|compactc) : ;; \
      *) echo "AA_ZKIR_SOURCE must be one of minocrab | minocrab-all | compactc, got '${AA_ZKIR_SOURCE}'" >&2; exit 1 ;; \
    esac; \
    export HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache; \
    mkdir -p /aa/contract-manager/src /aa/contract-minter/src /aa/contract-offer-files/src; \
    /opt/compactc/compactc --feature-zkir-v3 /contracts/manager.compact /aa/contract-manager/src/managed/; \
    /opt/compactc/compactc --feature-zkir-v3 /contracts/test-support/minter.compact /aa/contract-minter/src/managed/; \
    /opt/compactc/compactc /contracts/offer-files.compact /aa/contract-offer-files/src/managed/; \
    M=/aa/contract-manager/src/managed; \
    case "${AA_ZKIR_SOURCE:-minocrab}" in \
      minocrab)     swapped="execute" ;; \
      minocrab-all) swapped="accountRecord depositShielded depositUnshielded execute isRegistered poolHasColour poolValue shieldedAccountBalance unshieldedAccountBalance" ;; \
      compactc)     swapped="" ;; \
    esac; \
    for c in $swapped; do \
      rm -f "$M/zkir/$c.zkir" "$M/zkir/$c.bzkir" "$M/keys/$c.prover" "$M/keys/$c.verifier"; \
      echo "compactc artifact for '$c' removed — the MinoCrab release supplies it"; \
    done; \
    if [ "${AA_PRUNE_MANAGER_PROVERS:-1}" = "1" ]; then \
      find "$M/keys" -name '*.prover' -print -delete; \
    fi; \
    ls "$M/keys" /aa/contract-minter/src/managed/keys

# ── stage 2b: the MinoCrab release assets ────────────────────────────────────
# Downloads exactly the files this build will use and proves what they are,
# BEFORE anything is staged. Three assertions, all fail-closed:
#
#   1. sha256(SHA256SUMS) == MINOCRAB_SUMS_SHA256  — the pin in this repository
#   2. sha256sum -c --ignore-missing SHA256SUMS    — every file taken, and the
#      count of verified files must equal the count requested (so a file that
#      SHA256SUMS does not list cannot slip through unchecked)
#   3. manifest.json's `tag`, `gitCommit` and `contractPin.commit` equal
#      MINOCRAB_RELEASE, MINOCRAB_REF and AA_REF — i.e. these keys are for the
#      contract this image is about to compile, not for some other commit
#
# TRANSPORT. The `minocrab` named build context is copied in first: if it holds a
# SHA256SUMS the files come from there, otherwise they are downloaded from the
# release. Both paths run all three assertions, so the local path is a transport
# convenience and not a trust decision — which is what makes it usable while the
# release tag is unpublished (see minocrab-local/README.md). Set MINOCRAB_LOCAL_DIR
# (compose) or --build-context minocrab=<dir> to use it.
FROM debian:stable-slim AS minocrab-release

ARG AA_REF
ARG AA_ZKIR_SOURCE
ARG AA_PRUNE_MANAGER_PROVERS
ARG MINOCRAB_REPO
ARG MINOCRAB_RELEASE
ARG MINOCRAB_REF
ARG MINOCRAB_SUMS_SHA256
ARG MINOCRAB_FETCH_BASE

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The local fetch context — `minocrab-local/` (a README and nothing else) unless
# MINOCRAB_LOCAL_DIR points somewhere with the assets in it.
COPY --from=minocrab / /local/

RUN set -eux; \
    mkdir -p /delta/managed/keys /delta/managed/zkir /delta/meta /fetch; \
    printf '%s\n' "${AA_ZKIR_SOURCE:-minocrab}" > /delta/meta/.aa-zkir-source; \
    if [ "${AA_ZKIR_SOURCE:-minocrab}" = "compactc" ]; then \
      echo "AA_ZKIR_SOURCE=compactc — the MinoCrab release is not consulted"; \
      rm -rf /local /fetch; \
      exit 0; \
    fi; \
    case "${AA_ZKIR_SOURCE}" in \
      minocrab)     circuits="execute" ;; \
      minocrab-all) circuits="accountRecord depositShielded depositUnshielded execute isRegistered poolHasColour poolValue shieldedAccountBalance unshieldedAccountBalance" ;; \
      *) echo "AA_ZKIR_SOURCE must be one of minocrab | minocrab-all | compactc, got '${AA_ZKIR_SOURCE}'" >&2; exit 1 ;; \
    esac; \
    kinds="zkir bzkir verifier"; \
    if [ "${AA_PRUNE_MANAGER_PROVERS:-1}" = "0" ]; then kinds="$kinds prover"; fi; \
    files="SHA256SUMS manifest.json"; \
    for c in $circuits; do for k in $kinds; do files="$files $c.$k"; done; done; \
    if [ -f /local/SHA256SUMS ]; then \
      mode="local-context"; \
      echo "MinoCrab assets: LOCAL CONTEXT (the same three assertions still run)"; \
      for f in $files; do cp "/local/$f" "/fetch/$f"; done; \
    else \
      mode="release"; \
      base="${MINOCRAB_FETCH_BASE:-${MINOCRAB_REPO}/releases/download/${MINOCRAB_RELEASE}}"; \
      echo "MinoCrab assets: $base"; \
      for f in $files; do \
        curl --proto '=https' --tlsv1.2 -fLsS --retry 3 --retry-connrefused -o "/fetch/$f" "$base/$f"; \
      done; \
    fi; \
    cd /fetch; \
    got="$(sha256sum SHA256SUMS | cut -d ' ' -f 1)"; \
    if [ "$got" != "$MINOCRAB_SUMS_SHA256" ]; then \
      echo "FAIL: SHA256SUMS hashes $got, this repository pins $MINOCRAB_SUMS_SHA256." >&2; \
      echo "  The identity of a release is that hash, never the tag. Do not 'fix' the pin to" >&2; \
      echo "  make a build pass: find out which release you actually fetched first." >&2; \
      exit 1; \
    fi; \
    echo "SHA256SUMS identity OK: $got"; \
    want="$(( $(printf '%s\n' $files | wc -l) - 1 ))"; \
    ok="$(sha256sum -c --ignore-missing SHA256SUMS | grep -c ': OK$')"; \
    if [ "$ok" -ne "$want" ]; then \
      echo "FAIL: SHA256SUMS verified $ok file(s), $want were requested — a requested file is not covered by SHA256SUMS." >&2; \
      exit 1; \
    fi; \
    echo "content OK: $ok/$want file(s) verified against SHA256SUMS"; \
    grep -q "\"tag\": \"${MINOCRAB_RELEASE}\"" manifest.json \
      || { echo "FAIL: manifest.json does not record tag ${MINOCRAB_RELEASE}" >&2; exit 1; }; \
    grep -q "\"gitCommit\": \"${MINOCRAB_REF}\"" manifest.json \
      || { echo "FAIL: manifest.json does not record gitCommit ${MINOCRAB_REF}" >&2; exit 1; }; \
    grep -q "\"commit\": \"${AA_REF}\"" manifest.json \
      || { echo "FAIL: manifest.json's contract pin is not AA_REF ${AA_REF} — these keys are for a different contract" >&2; exit 1; }; \
    echo "manifest identities OK: tag=${MINOCRAB_RELEASE} port=${MINOCRAB_REF} contract=${AA_REF}"; \
    for c in $circuits; do \
      cp "$c.zkir" "$c.bzkir" /delta/managed/zkir/; \
      cp "$c.verifier" /delta/managed/keys/; \
      if [ "${AA_PRUNE_MANAGER_PROVERS:-1}" = "0" ]; then cp "$c.prover" /delta/managed/keys/; fi; \
    done; \
    cp manifest.json /delta/meta/.minocrab-manifest.json; \
    printf '%s\n' "$MINOCRAB_REF"          > /delta/meta/.minocrab-commit; \
    printf '%s\n' "$MINOCRAB_SUMS_SHA256"  > /delta/meta/.minocrab-sums-sha256; \
    printf '%s\n' "$MINOCRAB_RELEASE"      > /delta/meta/.minocrab-release; \
    printf '%s\n' "$circuits"              > /delta/meta/.minocrab-circuits; \
    printf '%s\n' "$mode"                  > /delta/meta/.minocrab-fetch-mode; \
    chmod -R u+rw,a+r /delta; \
    du -sh /delta/managed; \
    rm -rf /local /fetch

# The offer-files artifact was compiled in stage 2 with the AA contracts.
# The console mints the demo's UNIFIED token set (wBTC/wETH shielded, wUSD
# unshielded) through the offer-files contract's permissionless dev mint
# circuits — the same tokens the kernel's own dev mint creates — instead of a
# console-private minter. Its managed contract + [v6] keys are compiled from
# the pinned public kernel source and proven on the PLAIN proof server.

# ── stage 3: the deploy+mint runner ──────────────────────────────────────────
# Same bun pin as the kernel image, same reason (1.3.14 breaks on graphql-17 ESM).
# Inherit the Compact stage rather than COPYing its key tree into a second
# filesystem snapshot. Generated artifacts remain at /aa; Bun's pinned binary is
# glibc-only and runs on this Debian base. Keeping compactc (~64 MB) in the dev
# image is the small price for eliminating a duplicate key snapshot during clean
# builds on small/shared Docker hosts.
FROM oven/bun:1.3.11 AS bun-runtime
FROM compact

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /aa
COPY --from=source /aa-commit /aa/.aa-commit
COPY --from=source /kernel-commit /aa/.kernel-commit
# The AA repo's OWN test library — EIP-712 codec, MetaMask V4 signing, execute
# payload builders. Imported verbatim by the E2E so the digest scheme is never
# reimplemented (golden vectors and frozen hashes included).
COPY --from=source /src/tests/lib /aa/aalib/
COPY runner/ /aa/runner/
# The AA web console's static page (service `aa-console` serves it; see
# runner/aa-console.ts — the relay that lets a browser EVM wallet drive the AA path).
COPY console/ /aa/console/

# Install at /aa, not /aa/runner: the compactc-generated contract modules live at
# /aa/contract-*/src/managed/contract/ and import @midnight-ntwrk/compact-runtime —
# module resolution walks UP from the importing file, so the dependency tree must
# sit at /aa/node_modules to be visible to generated code and runner alike.
RUN cp /aa/runner/package.json /aa/package.json && cd /aa && bun install

# ── ONE compactc, ONE compact-runtime (issues/00011) ─────────────────────────
# This process imports BOTH generated contract modules — the AA Manager/Minter
# and the kernel's offer-files contract — and each one opens with
# `checkRuntimeVersion("<the runtime compactc emitted code for>")`. The compact
# stage already proved the compiler agrees with the KERNEL's contract package;
# this proves the same number against what `bun install` actually RESOLVED here,
# and that exactly one copy is installed. A mismatch used to surface as a
# contract that refuses to load the first time the console touched it.
RUN set -eux; \
    want="$(cat /opt/compact-runtime-version)"; \
    copies="$(find /aa/node_modules -path '*/@midnight-ntwrk/compact-runtime/package.json' | wc -l | tr -d ' ')"; \
    test "$copies" = "1" || { echo "FAIL: ${copies} copies of @midnight-ntwrk/compact-runtime are installed at /aa; exactly one must be" >&2; find /aa/node_modules -path '*/@midnight-ntwrk/compact-runtime/package.json' >&2; exit 1; }; \
    got="$(bun -e 'const p = (await import("/aa/node_modules/@midnight-ntwrk/compact-runtime/package.json", { with: { type: "json" } })).default; console.log(p.version)')"; \
    test "$got" = "$want" || { echo "FAIL: compactc $(cat /opt/compactc-version) emits code for compact-runtime ${want}, but the runner installed ${got}" >&2; exit 1; }; \
    echo "runner compact-runtime ${got} == compactc $(cat /opt/compactc-version) runtime target"; \
    cp /opt/compactc-version         /aa/.compactc-version; \
    cp /opt/compact-runtime-version  /aa/.compact-runtime-version

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

# ── the MinoCrab artifacts land LAST ─────────────────────────────────────────
# After `bun install`, so flipping AA_ZKIR_SOURCE cannot force a registry fetch.
# `/delta/managed` is empty and `/delta/meta` holds only `.aa-zkir-source` when
# the source is `compactc`, which makes both COPYs no-ops on the opt-out path.
COPY --from=minocrab-release /delta/managed/ /aa/contract-manager/src/managed/
COPY --from=minocrab-release /delta/meta/ /aa/
# Re-stamp the compiler's manifest from the ACTUAL files: NodeZkConfigProvider
# runs verify:"require", and compactc wrote sizes and hashes for the artifacts
# stage 2 deleted. Anything the MinoCrab release did not supply (a pruned
# `.prover`) has its stale entry REMOVED rather than left describing bytes that
# are neither present nor the ones this image would fetch. The manifest's own
# identity assertions run here too, against a real JSON parse rather than the
# grep the fetch stage could afford.
RUN bun -e 'const M = "/aa/contract-manager/src/managed"; \
  const src = (await Bun.file("/aa/.aa-zkir-source").text()).trim(); \
  if (src === "compactc") { console.log("zkir source: compactc — nothing to re-stamp"); process.exit(0); } \
  const man = await Bun.file("/aa/.minocrab-manifest.json").json(); \
  const tag = (await Bun.file("/aa/.minocrab-release").text()).trim(); \
  const ref = (await Bun.file("/aa/.minocrab-commit").text()).trim(); \
  const aaRef = (await Bun.file("/aa/.aa-commit").text()).trim(); \
  const eq = (what, got, want) => { if (got !== want) { console.error(`FAIL: manifest ${what} is ${got}, expected ${want}`); process.exit(1); } }; \
  eq("tag", man.tag, tag); \
  eq("gitCommit", man.gitCommit, ref); \
  eq("contractPin.commit", man.contractPin?.commit, aaRef); \
  const circuits = (await Bun.file("/aa/.minocrab-circuits").text()).trim().split(/\s+/); \
  const path = `${M}/compiler/contract-manifest.json`; \
  const m = await Bun.file(path).json(); \
  for (const c of circuits) { \
    for (const [section, name] of [["keys", `${c}.prover`], ["keys", `${c}.verifier`], ["zkir", `${c}.zkir`], ["zkir", `${c}.bzkir`]]) { \
      const f = Bun.file(`${M}/${section}/${name}`); \
      if (!m[section]) m[section] = { type: "directory" }; \
      if (!(await f.exists())) { delete m[section][name]; continue; } \
      const hasher = new Bun.CryptoHasher("sha256"); \
      hasher.update(await f.arrayBuffer()); \
      const want = man.circuits?.[c]?.[name.split(".").pop()]; \
      const hash = hasher.digest("hex"); \
      if (want && (want.bytes !== f.size || want.sha256 !== hash)) { \
        console.error(`FAIL: ${name} is ${f.size} B/${hash}, the release manifest says ${want.bytes} B/${want.sha256}`); \
        process.exit(1); \
      } \
      m[section][name] = { type: "file", size: f.size, hash }; \
    } \
    console.log(`re-stamped ${c} from the MinoCrab release (k=${man.circuits?.[c]?.k}, rows=${man.circuits?.[c]?.rows})`); \
  } \
  await Bun.write(path, JSON.stringify(m, null, 2)); \
  console.log(`zkir source: ${src} @ ${tag} (${ref.slice(0, 12)}…), ${circuits.length} circuit(s) swapped`);'

ENTRYPOINT ["/usr/local/bin/aa-entrypoint"]
