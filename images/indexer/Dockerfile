# syntax=docker/dockerfile:1.7
#
# indexer-standalone 4.4.0-rc.3 — a THIN RUNTIME around the exact published warehouse
# executable. There is no Rust toolchain, no git checkout, no `cargo build`, and no
# `platform:` pin anywhere in this image.
#
# WHY THIS CHANGED. The previous version of this file compiled the official
# `midnightntwrk/midnight-indexer` source at commit 56561b2f… because no public Docker Hub
# manifest exists for rc3. That is still true — but `effectstream/binaries@0.3.120` now
# publishes the rc3 `indexer-standalone` executable for BOTH Linux amd64 and Linux arm64,
# cataloged with `provenance=known`, the upstream source commit, and a SHA-256 for the
# archive AND for the executable inside it. Downloading ~30 MB and checking two hashes
# replaces a multi-gigabyte Rust build and — because arm64 is published — removes the
# `platform: linux/amd64` pin that made Apple Silicon emulate this service.
#
# The commit is retained as PROVENANCE (it is written into the image and asserted by
# scripts/verify-source-pins.sh), never as a build instruction.
#
# WAREHOUSE IS DEVELOPMENT-ONLY AND MUTABLE. Release 0.3.120 can be re-uploaded at the same
# asset name, so the SHA-256 checks below are the actual identity — not the URL, not the
# version string. A byte change fails the build before anything is installed.
#
# The two small runtime-support files (`entrypoint.sh`, `config.yaml`) are NOT in the
# warehouse ZIP — it holds exactly one member, the executable. They are vendored from the
# same upstream commit and hash-checked here; see PROVENANCE.md.

ARG DEBIAN_BASE=debian:trixie-slim@sha256:f6e2cfac5cf956ea044b4bd75e6397b4372ad88fe00908045e9a0d21712ae3ba

# ── fetch ────────────────────────────────────────────────────────────────────
# Pinned to $BUILDPLATFORM on purpose: downloading and hashing an archive is
# architecture-independent work, so an arm64 image can be produced from an amd64 host (and
# vice versa) without QEMU. Nothing here ever EXECUTES the fetched binary — its
# architecture is proven from the ELF header instead, which works cross-arch.
FROM --platform=$BUILDPLATFORM ${DEBIAN_BASE} AS fetch
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ARG WAREHOUSE_REPO=effectstream/binaries
ARG WAREHOUSE_RELEASE=0.3.120
ARG INDEXER_VERSION=4.4.0-rc.3
# The exact cataloged asset names. They are arguments so the negative fixtures in
# scripts/verify-artifact-fetch.sh can prove the guards below actually bite; the defaults
# are the frozen pins from config/artifact-decisions.json.
ARG INDEXER_ASSET_AMD64=indexer-standalone-linux-amd64-v4.4.0-rc.3.zip
ARG INDEXER_ASSET_ARM64=indexer-standalone-linux-arm64-v4.4.0-rc.3.zip

# Resolve the asset, prove it is the right kind of asset, and only THEN spend bandwidth.
# Every rejection here happens before a single byte is downloaded.
RUN set -euo pipefail; \
    case "${TARGETARCH}" in \
      amd64) asset="${INDEXER_ASSET_AMD64}"; elf_machine='3e00' ;; \
      arm64) asset="${INDEXER_ASSET_ARM64}"; elf_machine='b700' ;; \
      *) echo "FAIL: unsupported TARGETARCH='${TARGETARCH}' — this image builds only linux/amd64 and linux/arm64" >&2; exit 1 ;; \
    esac; \
    # FR-016: a macOS/Windows warehouse asset must never be selected for a Linux container.
    # The warehouse publishes macos-arm64 rows for other components at these same versions,
    # so this is a live trap, not a theoretical one.
    for bad in macos darwin windows; do \
      case "${asset}" in *"${bad}"*) echo "FAIL: refusing non-Linux warehouse asset '${asset}'" >&2; exit 1 ;; esac; \
    done; \
    # The asset name must itself carry the architecture it claims, so an arm64 archive can
    # never be installed into an amd64 image by swapping one build argument.
    case "${asset}" in \
      *"-linux-${TARGETARCH}-"*) : ;; \
      *) echo "FAIL: asset '${asset}' does not name platform linux/${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    case "${asset}" in *.zip) : ;; *) echo "FAIL: asset '${asset}' is not the cataloged .zip form" >&2; exit 1 ;; esac; \
    # The asset must also carry the version this image claims to be, so bumping
    # INDEXER_VERSION alone can never produce an image that records a version it did not
    # install.
    case "${asset}" in \
      *"-v${INDEXER_VERSION}."*) : ;; \
      *) echo "FAIL: asset '${asset}' is not version ${INDEXER_VERSION}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /pin /dl; \
    printf '%s' "${asset}"       > /pin/asset; \
    printf '%s' "${elf_machine}" > /pin/elf-machine; \
    echo "fetching ${asset} from ${WAREHOUSE_REPO}@${WAREHOUSE_RELEASE}"; \
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 \
      -o "/dl/${asset}" \
      "https://github.com/${WAREHOUSE_REPO}/releases/download/${WAREHOUSE_RELEASE}/${asset}"

ARG WAREHOUSE_CATALOG_COMMIT=42c1b610ea1cbafd3eaf4c95901610d79541091b
# Outer archive SHA-256 (catalog `outerSha256`).
ARG INDEXER_ARCHIVE_SHA256_AMD64=4b5df2ae3ed01f378adfb64d1c0d20d306470f8fba23a36638f937a4486a9434
ARG INDEXER_ARCHIVE_SHA256_ARM64=eb44e8493df141d552334399dc25277e76cd500e937bedd5c6ff42a068fb15d0
# Inner executable SHA-256 (catalog `memberSha256`) — the payload identity, checked after
# extraction so a well-formed archive with a swapped member is still rejected.
ARG INDEXER_EXE_SHA256_AMD64=84b429c3f2eb43372eba4b1fa5739acfdd8c8d472052b281ca6778b2bf4eb17b
ARG INDEXER_EXE_SHA256_ARM64=623539f18bfd9067ba2f70e43546af70277d113e9d1b486263df668c1d585c82
# Provenance only. Nothing in this repository clones or compiles it.
ARG INDEXER_SOURCE_REPO=midnightntwrk/midnight-indexer
ARG INDEXER_SOURCE_COMMIT=56561b2f5cf5c6839f678257fc69bed1a8b9ba2c
# The vendored upstream runtime-support files, hash-checked against the same commit.
ARG INDEXER_ENTRYPOINT_SHA256=63613bd5933546afa0715489ef759c82e10fa95f15f30a8ea6e5af403e09f178
ARG INDEXER_CONFIG_SHA256=dc5a5cb404addd176506f86247f08a00f3ac49d60ba76432fea0f639c883ba7f

COPY entrypoint.sh config.yaml /vendor/

RUN set -euo pipefail; \
    asset="$(cat /pin/asset)"; \
    elf_machine="$(cat /pin/elf-machine)"; \
    case "${TARGETARCH}" in \
      amd64) archive_sha="${INDEXER_ARCHIVE_SHA256_AMD64}"; exe_sha="${INDEXER_EXE_SHA256_AMD64}" ;; \
      arm64) archive_sha="${INDEXER_ARCHIVE_SHA256_ARM64}"; exe_sha="${INDEXER_EXE_SHA256_ARM64}" ;; \
      *) echo "FAIL: unsupported TARGETARCH='${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    echo "${archive_sha}  /dl/${asset}" | sha256sum -c -; \
    # The catalog records exactly ONE member, named after the asset. Asserting the whole
    # listing (not just "the file I want is in there") is what makes an archive with an
    # extra smuggled payload a build failure rather than an unnoticed extra file.
    member="${asset%.zip}"; \
    listing="$(unzip -Z1 "/dl/${asset}")"; \
    if [[ "${listing}" != "${member}" ]]; then \
      echo "FAIL: unexpected archive layout in ${asset}" >&2; \
      echo "  expected exactly: ${member}" >&2; \
      echo "  got:" >&2; printf '    %s\n' ${listing} >&2; \
      exit 1; \
    fi; \
    mkdir -p /extract; \
    unzip -q -j "/dl/${asset}" "${member}" -d /extract; \
    exe="/extract/${member}"; \
    test -f "${exe}" && test ! -L "${exe}" || { echo "FAIL: ${member} is not a regular file" >&2; exit 1; }; \
    echo "${exe_sha}  ${exe}" | sha256sum -c -; \
    # Architecture proof that does not require executing the binary: ELF magic, 64-bit
    # class, little-endian, and e_machine (0x3e = x86-64, 0xb7 = AArch64) read straight
    # out of the header. This is the check that survives a cross-build.
    hdr="$(od -An -v -t x1 -N 20 "${exe}" | tr -d ' \n')"; \
    test "${hdr:0:8}"  = "7f454c46" || { echo "FAIL: ${member} is not an ELF file" >&2; exit 1; }; \
    test "${hdr:8:2}"  = "02"       || { echo "FAIL: ${member} is not a 64-bit ELF" >&2; exit 1; }; \
    test "${hdr:10:2}" = "01"       || { echo "FAIL: ${member} is not little-endian" >&2; exit 1; }; \
    test "${hdr:36:4}" = "${elf_machine}" \
      || { echo "FAIL: ${member} ELF e_machine ${hdr:36:4} is not linux/${TARGETARCH} (${elf_machine})" >&2; exit 1; }; \
    printf '%s  %s\n' "${INDEXER_ENTRYPOINT_SHA256}" /vendor/entrypoint.sh | sha256sum -c -; \
    printf '%s  %s\n' "${INDEXER_CONFIG_SHA256}"     /vendor/config.yaml   | sha256sum -c -; \
    mkdir -p /runtime/usr/local/bin /runtime/opt/indexer-standalone; \
    install -m 0755 "${exe}"              /runtime/usr/local/bin/indexer-standalone; \
    install -m 0755 /vendor/entrypoint.sh /runtime/usr/local/bin/entrypoint.sh; \
    install -m 0644 /vendor/config.yaml   /runtime/opt/indexer-standalone/config.yaml; \
    printf '%s\n' "${INDEXER_SOURCE_COMMIT}" > /runtime/opt/indexer-standalone/.indexer-commit; \
    # One machine-readable record of WHICH artifact this image is, so a running container
    # can prove its identity without trusting the tag it was built under.
    { \
      printf '{\n'; \
      printf '  "component": "indexer-standalone",\n'; \
      printf '  "version": "%s",\n'            "${INDEXER_VERSION}"; \
      printf '  "platform": "linux/%s",\n'     "${TARGETARCH}"; \
      printf '  "semanticId": "indexer-standalone/%s/linux/%s",\n' "${INDEXER_VERSION}" "${TARGETARCH}"; \
      printf '  "distributionTier": "development-only",\n'; \
      printf '  "warehouseRepository": "%s",\n' "${WAREHOUSE_REPO}"; \
      printf '  "warehouseRelease": "%s",\n'    "${WAREHOUSE_RELEASE}"; \
      printf '  "warehouseCatalogCommit": "%s",\n' "${WAREHOUSE_CATALOG_COMMIT}"; \
      printf '  "assetName": "%s",\n'           "${asset}"; \
      printf '  "archiveSha256": "%s",\n'       "${archive_sha}"; \
      printf '  "memberPath": "%s",\n'          "${member}"; \
      printf '  "executableSha256": "%s",\n'    "${exe_sha}"; \
      printf '  "sourceRepository": "%s",\n'    "${INDEXER_SOURCE_REPO}"; \
      printf '  "sourceCommit": "%s",\n'        "${INDEXER_SOURCE_COMMIT}"; \
      printf '  "sourceRole": "provenance-only"\n'; \
      printf '}\n'; \
    } > /runtime/opt/indexer-standalone/.indexer-artifact; \
    chmod 0644 /runtime/opt/indexer-standalone/.indexer-commit \
               /runtime/opt/indexer-standalone/.indexer-artifact

# ── runtime ──────────────────────────────────────────────────────────────────
# Same pinned Debian as the fetch stage, but at the TARGET architecture: the executable is
# dynamically linked against glibc, so it needs a real distro base (trixie ships 2.41).
FROM ${DEBIAN_BASE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates=20250419 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -u 10001 -d /nonexistent -s /usr/sbin/nologin -M -c "" appuser \
 && passwd -l appuser \
 && mkdir /var/run/indexer-standalone /data \
 && chown appuser:appuser /var/run/indexer-standalone /data
COPY --from=fetch --chown=appuser:appuser /runtime /
USER appuser
WORKDIR /opt/indexer-standalone
ENTRYPOINT ["entrypoint.sh"]
EXPOSE 8088
