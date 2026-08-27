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
ARG AA_REF=713a20215f33e02904ea5bd699b7de7f76562e1b
ARG KERNEL_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG KERNEL_REF=b1420c4af6ed8b2510140418e5138d282365f9c6
ARG COMPACT_VERSION=0.33.0-rc.2
# 1 (default): prune the Manager's .prover files — deploys need only verifier keys.
# 0: keep them — required by the E2E, which CALLS execute (scripts/aa-e2e.sh builds
# that variant as the :e2e tag; expect ~1.2 GB extra in the image).
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
COPY --from=source /kernel-src/packages/contracts-midnight/contract-offer-files/src/offer-files.compact /contracts/offer-files.compact

# Keys need the universal SRS from srs.midnight.network (a build-time network
# fetch, like the git clone). Layout matches what deployMidnightContract expects:
# <contract-name>/src/managed/. Manager prover keys pruned — see header.
ARG AA_PRUNE_MANAGER_PROVERS
RUN set -eux; \
    export HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache; \
    mkdir -p /aa/contract-manager/src /aa/contract-minter/src /aa/contract-offer-files/src; \
    /opt/compactc/compactc --feature-zkir-v3 /contracts/manager.compact /aa/contract-manager/src/managed/; \
    /opt/compactc/compactc --feature-zkir-v3 /contracts/test-support/minter.compact /aa/contract-minter/src/managed/; \
    /opt/compactc/compactc /contracts/offer-files.compact /aa/contract-offer-files/src/managed/; \
    if [ "${AA_PRUNE_MANAGER_PROVERS:-1}" = "1" ]; then \
      find /aa/contract-manager/src/managed/keys -name '*.prover' -print -delete; \
    fi; \
    ls /aa/contract-manager/src/managed/keys /aa/contract-minter/src/managed/keys

# ── stage 2b: OPTIONAL k=18 `execute` overlay ────────────────────────────────
# Swaps the Manager's `execute` artifact for the MinoCrab-compiled k=18 build
# (the 00020-manager-k18-main handoff): 211,056 rows instead of 382,781, a
# 544 MiB prover key instead of 1.14 GB, ~2× faster proofs — the cure for the
# proof server's OOM class on memory-tight hosts. TWO CAVEATS TRAVEL WITH IT
# (from the handoff MANIFEST): the artifact comes from an UNAUDITED third-party
# compiler (equivalence tested 56/56 + 4,888 tamper probes against compactc,
# not formally proven) — dev chains only; and the keys carry no compiler
# manifest of their own, so the manifest compactc wrote is PATCHED below with
# the k=18 sizes/hashes (NodeZkConfigProvider runs verify:"require").
# KEY-BREAKING like any execute change: redeploy the contracts after enabling.
FROM debian:stable-slim AS k18-overlay

ARG AA_EXECUTE_K18=0
ARG AA_PRUNE_MANAGER_PROVERS=1
# The `k18` named context: the handoff folder when enabled, k18-stub/ otherwise.
COPY --from=k18 / /k18/
# Stage only the DELTA under /delta — empty when the overlay is off, so the
# runtime's merge-COPY of /delta is a no-op layer.
RUN set -eux; \
    mkdir -p /delta/keys /delta/zkir; \
    if [ "${AA_EXECUTE_K18:-0}" = "1" ]; then \
      test -f /k18/execute.verifier || { echo "AA_EXECUTE_K18=1 but the k18 context has no execute.verifier — set AA_K18_DIR to the handoff folder" >&2; exit 1; }; \
      cp /k18/execute.zkir /delta/zkir/execute.zkir; \
      cp /k18/execute.bzkir /delta/zkir/execute.bzkir; \
      cp /k18/execute.verifier /delta/keys/execute.verifier; \
      if [ "${AA_PRUNE_MANAGER_PROVERS:-1}" = "0" ]; then cp /k18/execute.prover /delta/keys/execute.prover; fi; \
      chmod -R u+rw,a+r /delta; \
      echo "k18 overlay staged (manifest is re-stamped in the runtime stage)"; \
    else \
      echo "k18 overlay disabled (AA_EXECUTE_K18=0)"; \
    fi; \
    rm -rf /k18

# The offer-files artifact was compiled in stage 2 with the AA contracts.
# The console mints the demo's UNIFIED token set (wBTC/wETH shielded, wUSD
# unshielded) through the offer-files contract's permissionless dev mint
# circuits — the same tokens the kernel's own dev mint creates — instead of a
# console-private minter. Its managed contract + [v6] keys are compiled from
# the pinned public kernel source and proven on the PLAIN proof server.

# ── stage 3: the deploy+mint runner ──────────────────────────────────────────
# Same bun pin as the kernel image, same reason (1.3.14 breaks on graphql-17 ESM).
# Inherit the Compact stage rather than COPYing its ~1.2 GB key tree into a
# second filesystem snapshot. Generated artifacts remain at /aa; Bun's pinned
# binary is glibc-only and runs on this Debian base. Keeping compactc (~64 MB)
# in the dev image is the small price for eliminating a duplicate key snapshot
# during clean builds on small/shared Docker hosts.
FROM oven/bun:1.3.11 AS bun-runtime
FROM compact

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /aa
# The runtime inherits `compact`, NOT the overlay stage. Everything below the
# final overlay remains byte-identical to a non-k18 build, so flipping
# AA_EXECUTE_K18 cannot force a registry fetch. The overlay lands as FINAL
# layers after the install (and costs the image its delta on top of k=19).
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

# ── k=18 overlay merge (FINAL layers — see the stage-2b comment) ─────────────
# /delta is empty when AA_EXECUTE_K18=0, making both steps no-ops; when
# enabled, the four execute artifacts land here and the compiler manifest is
# re-stamped from the ACTUAL files (NodeZkConfigProvider runs verify:"require").
COPY --from=k18-overlay /delta/ /aa/contract-manager/src/managed/
RUN bun -e 'const M = "/aa/contract-manager/src/managed"; \
  const path = `${M}/compiler/contract-manifest.json`; \
  const m = await Bun.file(path).json(); \
  for (const [section, name] of [["keys","execute.prover"],["keys","execute.verifier"],["zkir","execute.zkir"],["zkir","execute.bzkir"]]) { \
    const f = Bun.file(`${M}/${section}/${name}`); \
    if (!(await f.exists())) continue; \
    const hasher = new Bun.CryptoHasher("sha256"); \
    hasher.update(await f.arrayBuffer()); \
    m[section][name] = { type: "file", size: f.size, hash: hasher.digest("hex") }; \
  } \
  await Bun.write(path, JSON.stringify(m, null, 2)); \
  console.log("manifest re-stamped for execute artifacts");'

ENTRYPOINT ["/usr/local/bin/aa-entrypoint"]
