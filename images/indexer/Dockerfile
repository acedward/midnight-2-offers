# syntax=docker/dockerfile:1.7
# The upstream 4.4.0-rc.3 source contains the SQLite standalone-mode
# deadlock fix, but no public Docker Hub manifest was published for that tag.
# Build the official source at an immutable commit so a fresh clone does not
# silently fall back to the known-broken 4.4.0-rc.1 binary.
ARG RUST_VERSION=1.95.0
FROM rust:${RUST_VERSION}-trixie AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ARG INDEXER_REPO=https://github.com/midnightntwrk/midnight-indexer.git
ARG INDEXER_REF=56561b2f5cf5c6839f678257fc69bed1a8b9ba2c
ARG PROFILE=release
WORKDIR /build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN git init . \
 && git remote add origin "$INDEXER_REPO" \
 && git fetch --depth 1 origin "$INDEXER_REF" \
 && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$INDEXER_REF"

# Cache mounts keep the multi-gigabyte Rust target/registry state out of image
# layers. The runtime payload and immutable source marker are copied out in the
# same step before the target mount disappears.
RUN --mount=type=cache,id=demo-infra-indexer-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=demo-infra-indexer-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=demo-infra-indexer-target,target=/build/target \
    cargo build -p indexer-standalone --locked --features standalone --profile "$PROFILE" \
 && mkdir -p /runtime/usr/local/bin /runtime/opt/indexer-standalone \
 && cp "./target/${PROFILE/dev/debug}/indexer-standalone" /runtime/usr/local/bin/ \
 && cp indexer-standalone/bin/entrypoint.sh /runtime/usr/local/bin/ \
 && cp indexer-standalone/config.yaml /runtime/opt/indexer-standalone/ \
 && git rev-parse HEAD > /runtime/opt/indexer-standalone/.indexer-commit

FROM debian:trixie-slim@sha256:f6e2cfac5cf956ea044b4bd75e6397b4372ad88fe00908045e9a0d21712ae3ba AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates=20250419 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -u 10001 -d /nonexistent -s /usr/sbin/nologin -M -c "" appuser \
 && passwd -l appuser \
 && mkdir /var/run/indexer-standalone /data \
 && chown appuser:appuser /var/run/indexer-standalone /data
COPY --from=builder --chown=appuser:appuser /runtime /
USER appuser
WORKDIR /opt/indexer-standalone
ENTRYPOINT ["entrypoint.sh"]
EXPOSE 8088
