# A single-node Celestia devnet: consensus node (celestia-appd) + bridge node (celestia),
# bootstrapped from an empty data directory, with a funded bridge wallet and a DA RPC on :26658.
#
# This replicates what the offer-files kernel's `bun run dev` does via
# `@effectstream/orchestrator`'s launchCelestia + the `@effectstream/celestia` npm package: that
# package vendors two binaries with @xhmikosr/bin-wrapper and runs `init` → `keys add` →
# `gentx` → `start`, then `bridge init` → `bridge start`, then funds the bridge from the
# validator. See images/celestia/entrypoint.sh for the step-by-step mapping.
#
# WHERE THE BINARIES COME FROM.
# Both archives come from the `effectstream/binaries@0.3.120` warehouse, selected by
# TARGETARCH, for Linux amd64 AND Linux arm64. An earlier version of this file went straight
# to celestiaorg's own releases because the npm package's mirror had no linux-arm64 asset —
# that claim is STALE: the warehouse now publishes `celestia-appd-linux-arm64-v6.4.10.tar.gz`
# and `celestia-node-linux-arm64-v0.28.4.tar.gz`, both cataloged with their upstream source
# commit. So both architectures build and run NATIVE, with no `platform:` pin and no QEMU.
#
# HOW "SAME BYTES AS UPSTREAM" IS PROVEN, OFFLINE.
# Two of the four rows this image uses (the amd64 ones) are cataloged `legacy-unverified`
# with null source and null member hashes, which the catalog is right to say and which this
# repository must not paper over. `official-equality.tsv` therefore pins, per asset, the
# exact official celestiaorg release/tag/asset/checksum that the warehouse archive is
# byte-equal to — checked into the build context, read offline, never fetched. The previous
# build downloaded each release's `checksums.txt` live, which made a mutable network
# resource part of the trust decision.
#
# WAREHOUSE IS DEVELOPMENT-ONLY AND MUTABLE: release 0.3.120 can be re-uploaded under the
# same asset name, so the pinned SHA-256 values below are the identity, not the URL.

ARG DEBIAN_BASE=debian:trixie-slim@sha256:f6e2cfac5cf956ea044b4bd75e6397b4372ad88fe00908045e9a0d21712ae3ba

# ── fetch ────────────────────────────────────────────────────────────────────
# Pinned to $BUILDPLATFORM: downloading and hashing archives is architecture-independent,
# so an arm64 image can be produced from an amd64 host without emulating a single
# instruction. Nothing here EXECUTES a fetched binary — the ELF header proves its
# architecture instead, which is what makes that cross-build safe.
FROM --platform=$BUILDPLATFORM ${DEBIAN_BASE} AS fetch
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ARG WAREHOUSE_REPO=effectstream/binaries
ARG WAREHOUSE_RELEASE=0.3.120
# Pinned to exactly what @effectstream/celestia 0.103.1 vendors (its index.js: appVersion
# '6.4.10', nodeVersion '0.28.4'), so the devnet this image runs is the devnet the kernel's dev
# mode was developed against. Bumping either version here is a behaviour change, not a patch.
ARG CELESTIA_APP_VERSION=6.4.10
ARG CELESTIA_NODE_VERSION=0.28.4
# The exact cataloged asset names. Arguments only so scripts/verify-artifact-fetch.sh can
# prove the guards below bite; the defaults are the frozen pins from
# config/artifact-decisions.json.
ARG CELESTIA_APP_ASSET_AMD64=celestia-appd-linux-amd64-v6.4.10.tar.gz
ARG CELESTIA_APP_ASSET_ARM64=celestia-appd-linux-arm64-v6.4.10.tar.gz
ARG CELESTIA_NODE_ASSET_AMD64=celestia-node-linux-amd64-v0.28.4.tar.gz
ARG CELESTIA_NODE_ASSET_ARM64=celestia-node-linux-arm64-v0.28.4.tar.gz

COPY official-equality.tsv /vendor/official-equality.tsv

# Resolve, prove the assets are the right kind of asset, prove each one has an official
# byte-equality record — and only then spend ~280 MB of bandwidth. Every rejection in this
# step happens before a single byte is downloaded.
RUN set -euo pipefail; \
    case "${TARGETARCH}" in \
      amd64) app_asset="${CELESTIA_APP_ASSET_AMD64}"; node_asset="${CELESTIA_NODE_ASSET_AMD64}"; elf_machine='3e00' ;; \
      arm64) app_asset="${CELESTIA_APP_ASSET_ARM64}"; node_asset="${CELESTIA_NODE_ASSET_ARM64}"; elf_machine='b700' ;; \
      *) echo "FAIL: unsupported TARGETARCH='${TARGETARCH}' (need amd64 or arm64)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /pin /dl; \
    for spec in "celestia-appd:${app_asset}:celestiaorg/celestia-app" "celestia-node:${node_asset}:celestiaorg/celestia-node"; do \
      role="${spec%%:*}"; rest="${spec#*:}"; asset="${rest%%:*}"; want_repo="${rest#*:}"; \
      # FR-016: never install a macOS/Windows warehouse asset into a Linux container.
      for bad in macos darwin windows; do \
        case "${asset}" in *"${bad}"*) echo "FAIL: refusing non-Linux warehouse asset '${asset}'" >&2; exit 1 ;; esac; \
      done; \
      # The asset must name the architecture it claims, so an arm64 archive cannot be
      # installed into an amd64 image by swapping one build argument.
      case "${asset}" in \
        *"-linux-${TARGETARCH}-"*) : ;; \
        *) echo "FAIL: asset '${asset}' does not name platform linux/${TARGETARCH}" >&2; exit 1 ;; \
      esac; \
      case "${asset}" in *.tar.gz) : ;; *) echo "FAIL: asset '${asset}' is not the cataloged .tar.gz form" >&2; exit 1 ;; esac; \
      # The asset must carry the version this image claims to install, so bumping a
      # CELESTIA_*_VERSION alone can never yield an image whose provenance record lies.
      case "${role}" in \
        celestia-appd) want_version="${CELESTIA_APP_VERSION}" ;; \
        *)             want_version="${CELESTIA_NODE_VERSION}" ;; \
      esac; \
      case "${asset}" in \
        *"-v${want_version}."*) : ;; \
        *) echo "FAIL: asset '${asset}' is not version ${want_version}" >&2; exit 1 ;; \
      esac; \
      # Independent official byte-equality evidence is MANDATORY, for every row.
      rows="$(awk -v a="${asset}" '$1 == a { print }' /vendor/official-equality.tsv)"; \
      n="$(printf '%s' "${rows}" | grep -c . || true)"; \
      if [[ "${n}" != "1" ]]; then \
        echo "FAIL: official-equality.tsv holds ${n} rows for '${asset}' — exactly 1 is required" >&2; exit 1; \
      fi; \
      set -- ${rows}; \
      prov="$2"; orepo="$3"; otag="$4"; oasset="$5"; osha="$7"; csha="$8"; scommit="$9"; \
      test "${orepo}" = "${want_repo}" \
        || { echo "FAIL: '${asset}' equality row names ${orepo}, expected ${want_repo}" >&2; exit 1; }; \
      # The look-alike trap: celestia-app v6.4.10 also publishes
      # `celestia-app-standalone_Linux_*.tar.gz`, a DIFFERENT artifact with a different
      # checksum. Bind the exact official asset name, not only its hash.
      case "${oasset}" in \
        *-standalone_*) echo "FAIL: '${oasset}' is the standalone look-alike, not the release archive" >&2; exit 1 ;; \
        *Linux_*) : ;; \
        *) echo "FAIL: official asset '${oasset}' is not a Linux release archive" >&2; exit 1 ;; \
      esac; \
      [[ "${osha}" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: '${asset}' equality sha256 is malformed" >&2; exit 1; }; \
      [[ "${csha}" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL: '${asset}' checksums.txt sha256 is malformed" >&2; exit 1; }; \
      case "${prov}" in \
        legacy-unverified) \
          # The catalog has no source identity for this row. Neither may we invent one.
          test "${scommit}" = "-" \
            || { echo "FAIL: legacy-unverified row '${asset}' must not claim source commit ${scommit}" >&2; exit 1; } ;; \
        known) \
          [[ "${scommit}" =~ ^[0-9a-f]{40}$ ]] \
            || { echo "FAIL: known row '${asset}' has no cataloged source commit" >&2; exit 1; } ;; \
        *) echo "FAIL: '${asset}' has unknown provenance state '${prov}'" >&2; exit 1 ;; \
      esac; \
      echo "equality  ${asset}  ==  ${orepo}@${otag}:${oasset}  (${prov})"; \
    done; \
    printf '%s' "${app_asset}"   > /pin/app-asset; \
    printf '%s' "${node_asset}"  > /pin/node-asset; \
    printf '%s' "${elf_machine}" > /pin/elf-machine; \
    for asset in "${app_asset}" "${node_asset}"; do \
      echo "fetching ${asset} from ${WAREHOUSE_REPO}@${WAREHOUSE_RELEASE}"; \
      curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 \
        -o "/dl/${asset}" \
        "https://github.com/${WAREHOUSE_REPO}/releases/download/${WAREHOUSE_RELEASE}/${asset}"; \
    done

ARG WAREHOUSE_CATALOG_COMMIT=42c1b610ea1cbafd3eaf4c95901610d79541091b
# Outer archive SHA-256 (catalog `outerSha256`), asserted against the equality record AND
# against the bytes actually downloaded.
ARG CELESTIA_APP_SHA256_AMD64=fa1826187a91514c6d506e22f1fcce25afbd551b98458caf899801b662a0c8da
ARG CELESTIA_APP_SHA256_ARM64=52cc9d59f9db5e3d2b7de91008c808f46ba319922db4a39404735b0a5dd6a76b
ARG CELESTIA_NODE_SHA256_AMD64=bb8b9fd2ac859945fdf2f8c84ba038f75e01be54e56d1a946cbbd4b540f120d9
ARG CELESTIA_NODE_SHA256_ARM64=09eb0505c5265bb08dfd09f14aa397516efd89d7b8f120e06f133d9e387ad50c
# Member sizes are cataloged for all four rows; member SHA-256 only for the two arm64
# rows. `-` means "the catalog does not know it" and is NOT a licence to invent one: for
# those rows the member's integrity follows from the verified outer archive it came out of.
ARG CELESTIA_APP_MEMBER_SIZE_AMD64=285614960
ARG CELESTIA_APP_MEMBER_SIZE_ARM64=262644248
ARG CELESTIA_NODE_MEMBER_SIZE_AMD64=190846060
ARG CELESTIA_NODE_MEMBER_SIZE_ARM64=176946394
ARG CELESTIA_APP_MEMBER_SHA256_AMD64=-
ARG CELESTIA_APP_MEMBER_SHA256_ARM64=bdeec5aefadecd3b517545347110ea1f9e95dfabb5a287979c1a3fb6626db91b
ARG CELESTIA_NODE_MEMBER_SHA256_AMD64=-
ARG CELESTIA_NODE_MEMBER_SHA256_ARM64=b38154ba4ec52ba784c4fd1e52af41fb9fb78e1a928f20cf9264d837a7ad6d2e

RUN set -euo pipefail; \
    app_asset="$(cat /pin/app-asset)"; node_asset="$(cat /pin/node-asset)"; \
    elf_machine="$(cat /pin/elf-machine)"; \
    case "${TARGETARCH}" in \
      amd64) app_sha="${CELESTIA_APP_SHA256_AMD64}";  node_sha="${CELESTIA_NODE_SHA256_AMD64}"; \
             app_msize="${CELESTIA_APP_MEMBER_SIZE_AMD64}"; node_msize="${CELESTIA_NODE_MEMBER_SIZE_AMD64}"; \
             app_msha="${CELESTIA_APP_MEMBER_SHA256_AMD64}"; node_msha="${CELESTIA_NODE_MEMBER_SHA256_AMD64}" ;; \
      arm64) app_sha="${CELESTIA_APP_SHA256_ARM64}";  node_sha="${CELESTIA_NODE_SHA256_ARM64}"; \
             app_msize="${CELESTIA_APP_MEMBER_SIZE_ARM64}"; node_msize="${CELESTIA_NODE_MEMBER_SIZE_ARM64}"; \
             app_msha="${CELESTIA_APP_MEMBER_SHA256_ARM64}"; node_msha="${CELESTIA_NODE_MEMBER_SHA256_ARM64}" ;; \
      *) echo "FAIL: unsupported TARGETARCH='${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out; \
    for spec in "${app_asset}:celestia-appd:${app_sha}:${app_msize}:${app_msha}" \
                "${node_asset}:celestia:${node_sha}:${node_msize}:${node_msha}"; do \
      asset="${spec%%:*}";  r1="${spec#*:}"; \
      member="${r1%%:*}";   r2="${r1#*:}"; \
      sha="${r2%%:*}";      r3="${r2#*:}"; \
      msize="${r3%%:*}";    msha="${r3#*:}"; \
      # 1/3 — the pinned build argument must equal the official checksum in the record.
      recorded="$(awk -v a="${asset}" '$1 == a { print $7 }' /vendor/official-equality.tsv)"; \
      test "${recorded}" = "${sha}" \
        || { echo "FAIL: '${asset}' pinned ${sha} but its official-equality record says ${recorded:-<missing>}" >&2; exit 1; }; \
      # 2/3 — the bytes actually downloaded must equal both.
      echo "${sha}  /dl/${asset}" | sha256sum -c -; \
      # 3/3 — archive layout: no absolute path, no traversal, and the member we want must
      # be a plain file rather than a link pointing somewhere else in the image.
      listing="$(tar -tzf "/dl/${asset}")"; \
      printf '%s\n' "${listing}" | while IFS= read -r entry; do \
        case "${entry}" in \
          /*|*..*) echo "FAIL: unsafe path '${entry}' in ${asset}" >&2; exit 1 ;; \
        esac; \
      done; \
      printf '%s\n' "${listing}" | grep -Fxq "${member}" \
        || { echo "FAIL: ${asset} does not contain expected member '${member}'" >&2; exit 1; }; \
      rm -rf "/extract/${member}"; mkdir -p /extract; \
      tar -xzf "/dl/${asset}" -C /extract --no-same-owner "${member}"; \
      test -f "/extract/${member}" && test ! -L "/extract/${member}" \
        || { echo "FAIL: extracted '${member}' is not a regular file" >&2; exit 1; }; \
      actual_size="$(stat -c %s "/extract/${member}")"; \
      test "${actual_size}" = "${msize}" \
        || { echo "FAIL: ${member} is ${actual_size} bytes, catalog says ${msize}" >&2; exit 1; }; \
      if [[ "${msha}" == "-" ]]; then \
        echo "note: ${member} has no cataloged member SHA-256 (legacy-unverified row); integrity follows from the verified outer archive ${sha}"; \
      else \
        echo "${msha}  /extract/${member}" | sha256sum -c -; \
      fi; \
      # Architecture proof without executing the binary: ELF magic, 64-bit, little-endian,
      # e_machine (0x3e = x86-64, 0xb7 = AArch64). This survives a cross-build.
      hdr="$(od -An -v -t x1 -N 20 "/extract/${member}" | tr -d ' \n')"; \
      test "${hdr:0:8}"  = "7f454c46" || { echo "FAIL: ${member} is not an ELF file" >&2; exit 1; }; \
      test "${hdr:8:2}"  = "02"       || { echo "FAIL: ${member} is not a 64-bit ELF" >&2; exit 1; }; \
      test "${hdr:10:2}" = "01"       || { echo "FAIL: ${member} is not little-endian" >&2; exit 1; }; \
      test "${hdr:36:4}" = "${elf_machine}" \
        || { echo "FAIL: ${member} ELF e_machine ${hdr:36:4} is not linux/${TARGETARCH} (${elf_machine})" >&2; exit 1; }; \
      install -m 0755 "/extract/${member}" "/out/${member}"; \
      rm -f "/extract/${member}"; \
    done; \
    mkdir -p /out-meta; \
    cp /vendor/official-equality.tsv /out-meta/official-equality.tsv; \
    { \
      printf '{\n'; \
      printf '  "component": "celestia-devnet",\n'; \
      printf '  "platform": "linux/%s",\n' "${TARGETARCH}"; \
      printf '  "distributionTier": "development-only",\n'; \
      printf '  "warehouseRepository": "%s",\n'    "${WAREHOUSE_REPO}"; \
      printf '  "warehouseRelease": "%s",\n'       "${WAREHOUSE_RELEASE}"; \
      printf '  "warehouseCatalogCommit": "%s",\n' "${WAREHOUSE_CATALOG_COMMIT}"; \
      printf '  "celestiaApp": {\n'; \
      printf '    "version": "%s",\n'    "${CELESTIA_APP_VERSION}"; \
      printf '    "semanticId": "celestia-appd/%s/linux/%s",\n' "${CELESTIA_APP_VERSION}" "${TARGETARCH}"; \
      printf '    "assetName": "%s",\n'  "${app_asset}"; \
      printf '    "archiveSha256": "%s",\n' "${app_sha}"; \
      printf '    "memberPath": "celestia-appd"\n'; \
      printf '  },\n'; \
      printf '  "celestiaNode": {\n'; \
      printf '    "version": "%s",\n'    "${CELESTIA_NODE_VERSION}"; \
      printf '    "semanticId": "celestia-node/%s/linux/%s",\n' "${CELESTIA_NODE_VERSION}" "${TARGETARCH}"; \
      printf '    "assetName": "%s",\n'  "${node_asset}"; \
      printf '    "archiveSha256": "%s",\n' "${node_sha}"; \
      printf '    "memberPath": "celestia"\n'; \
      printf '  }\n'; \
      printf '}\n'; \
    } > /out-meta/.celestia-artifact; \
    chmod 0644 /out-meta/.celestia-artifact /out-meta/official-equality.tsv

# ── runtime ──────────────────────────────────────────────────────────────────
# debian:trixie, NOT bookworm-slim (which images/umbra-evm uses): celestia-appd 6.4.10 is
# dynamically linked against GLIBC_2.38, and bookworm ships 2.36 — so on bookworm every
# invocation dies with
#   /usr/local/bin/celestia-appd: /lib/*/libc.so.6: version `GLIBC_2.38' not found
# before main() runs, which reads like a corrupt download rather than a base-image mismatch.
# trixie has 2.41. (celestia-node is statically linked and would have run anywhere.)
FROM ${DEBIAN_BASE}

# curl: the entrypoint and the healthcheck talk JSON-RPC and poll /block?height=1.
# jq:   parsing those answers with grep would be guesswork, and this image is not size-critical.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin celestia

COPY --from=fetch /out/celestia-appd /usr/local/bin/celestia-appd
COPY --from=fetch /out/celestia      /usr/local/bin/celestia
# Which warehouse artifacts this image actually installed, and the official-equality record
# they were admitted under — readable from a running container, so provenance does not
# depend on remembering which tag it was built as.
COPY --from=fetch /out-meta/         /opt/celestia/
COPY entrypoint.sh   /usr/local/bin/celestia-devnet
COPY healthcheck.sh  /usr/local/bin/celestia-health
COPY namespace.sh    /usr/local/bin/celestia-namespace
COPY token.sh        /usr/local/bin/celestia-token
RUN chmod 0755 /usr/local/bin/celestia-devnet /usr/local/bin/celestia-health \
               /usr/local/bin/celestia-namespace /usr/local/bin/celestia-token

# Created (and owned) in the image so that a fresh named volume mounted over either path
# inherits this ownership — docker seeds an empty volume from the image's directory, including
# its uid/gid. Without this the container would run as uid 10001 against a root-owned volume.
RUN mkdir -p /var/lib/celestia /celestia/auth \
 && chown -R celestia:celestia /var/lib/celestia /celestia

USER celestia
WORKDIR /var/lib/celestia

# The DA RPC the kernel, the batcher and verify.sh all talk to. 26657 (consensus RPC) and 9090
# (consensus gRPC) are deliberately NOT exposed: the bridge dials them over container-localhost,
# and every unnecessary published port is one more collision on a shared machine.
EXPOSE 26658

ENTRYPOINT ["/usr/local/bin/celestia-devnet"]
