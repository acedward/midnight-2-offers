# A single-node Celestia devnet: consensus node (celestia-appd) + bridge node (celestia),
# bootstrapped from an empty data directory, with a funded bridge wallet and a DA RPC on :26658.
#
# This replicates what the offer-files kernel's `bun run dev` does via
# `@effectstream/orchestrator`'s launchCelestia + the `@effectstream/celestia` npm package: that
# package vendors two binaries with @xhmikosr/bin-wrapper and runs `init` → `keys add` →
# `gentx` → `start`, then `bridge init` → `bridge start`, then funds the bridge from the
# validator. See images/celestia/entrypoint.sh for the step-by-step mapping.
#
# WHERE THE BINARIES COME FROM, AND WHY NOT THE PACKAGE'S OWN URLS.
# @effectstream/celestia downloads from github.com/effectstream/binaries, which publishes
# linux-amd64, macos-amd64 and macos-arm64 — there is NO linux-arm64 asset, so an image built
# that way would need `platform: linux/amd64` and QEMU on Apple Silicon (a consensus node
# producing a block a second is the worst possible workload to emulate). Those mirrored tarballs
# are BYTE-IDENTICAL to the upstream celestiaorg release assets — verified by sha256, see the
# plan's findings log — and upstream additionally publishes Linux_arm64 at the very same
# versions. So pointing at upstream is not a different binary: it is the same binary, plus the
# arch the mirror is missing. Both arches therefore run NATIVE, with no platform pin.
FROM debian:trixie-slim AS fetch

# Pinned to exactly what @effectstream/celestia 0.103.1 vendors (its index.js: appVersion
# '6.4.10', nodeVersion '0.28.4'), so the devnet this image runs is the devnet the kernel's dev
# mode was developed against. Bumping either version here is a behaviour change, not a patch.
ARG CELESTIA_APP_VERSION=6.4.10
ARG CELESTIA_NODE_VERSION=0.28.4
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Both releases ship a checksums.txt covering every asset. Verifying against it is version-
# agnostic (bumping the ARGs above needs no edit here) and catches the realistic failure — a
# truncated or proxy-mangled download — which would otherwise surface as a SIGSEGV at runtime.
# It is an integrity check, not an authenticity one: the checksums come from the same release.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) goarch='x86_64' ;; \
      arm64) goarch='arm64'  ;; \
      *) echo "unsupported TARGETARCH='${TARGETARCH}' (need amd64 or arm64)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out /tmp/dl; cd /tmp/dl; \
    app_tgz="celestia-app_Linux_${goarch}.tar.gz"; \
    node_tgz="celestia-node_Linux_${goarch}.tar.gz"; \
    app_base="https://github.com/celestiaorg/celestia-app/releases/download/v${CELESTIA_APP_VERSION}"; \
    node_base="https://github.com/celestiaorg/celestia-node/releases/download/v${CELESTIA_NODE_VERSION}"; \
    curl -fsSL -o "${app_tgz}"  "${app_base}/${app_tgz}"; \
    curl -fsSL -o app-checksums.txt "${app_base}/checksums.txt"; \
    grep " ${app_tgz}\$" app-checksums.txt > app.sha256; \
    test -s app.sha256; \
    sha256sum -c app.sha256; \
    curl -fsSL -o "${node_tgz}" "${node_base}/${node_tgz}"; \
    curl -fsSL -o node-checksums.txt "${node_base}/checksums.txt"; \
    grep " ${node_tgz}\$" node-checksums.txt > node.sha256; \
    test -s node.sha256; \
    sha256sum -c node.sha256; \
    tar xzf "${app_tgz}"  -C /out celestia-appd; \
    tar xzf "${node_tgz}" -C /out celestia; \
    chmod 0755 /out/celestia-appd /out/celestia; \
    /out/celestia-appd version; \
    /out/celestia version | head -3

# ── runtime ──────────────────────────────────────────────────────────────────
# debian:trixie, NOT bookworm-slim (which images/umbra-evm uses): celestia-appd 6.4.10 is
# dynamically linked against GLIBC_2.38, and bookworm ships 2.36 — so on bookworm every
# invocation dies with
#   /usr/local/bin/celestia-appd: /lib/*/libc.so.6: version `GLIBC_2.38' not found
# before main() runs, which reads like a corrupt download rather than a base-image mismatch.
# trixie has 2.41. (celestia-node is statically linked and would have run anywhere.)
FROM debian:trixie-slim

# curl: the entrypoint and the healthcheck talk JSON-RPC and poll /block?height=1.
# jq:   parsing those answers with grep would be guesswork, and this image is not size-critical.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin celestia

COPY --from=fetch /out/celestia-appd /usr/local/bin/celestia-appd
COPY --from=fetch /out/celestia      /usr/local/bin/celestia
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
