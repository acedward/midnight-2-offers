# syntax=docker/dockerfile:1
#
# Proof-data cache initializer.
#
# This image carries resolver/bootstrap tooling and reviewed metadata ONLY. It contains
# no proof-server executable and no proof-data payload: the ~223 MB of SRS + Ledger-static
# bytes are downloaded once at run time into container-local scratch and land exactly once,
# in the persistent named volume. Nothing proof-data-shaped is ever baked into a layer, so
# the image stays a few megabytes over its base and is identical for both proof variants.
#
# The base is the same interpreter pin the audited midnight-binary-forge proof-cache gate
# used, taken by immutable multiarch digest (linux/amd64 + linux/arm64 both present).
FROM docker.io/library/python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

# Reviewed proof-data generation. Overridable only for negative testing; the resolver,
# the admission contract, the Q8B proof set and the content manifest must all agree on it.
ARG PROOF_DATA_GENERATION=b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c

# Provenance of the imported bootstrap/admission files (see PROVENANCE.md).
ARG PROOF_CACHE_SOURCE_REPOSITORY=acedward/midnight-binary-forge
ARG PROOF_CACHE_SOURCE_COMMIT=546185faefcf91f9d1fe9169041b05394e8e4d29

LABEL org.opencontainers.image.title="midnight-2-offers proof-data cache initializer" \
      org.opencontainers.image.description="Populates one immutable warehouse-backed Ledger-9 proof-data generation for both rc.5 proof-server variants." \
      io.effectstream.proof-data.generation="${PROOF_DATA_GENERATION}" \
      io.effectstream.proof-data.selection="q8b-k0-k19-ledger-static-9" \
      io.effectstream.proof-data.cache-namespace="9" \
      io.effectstream.proof-data.warehouse="effectstream/binaries@0.3.120" \
      io.effectstream.proof-data.source-repository="${PROOF_CACHE_SOURCE_REPOSITORY}" \
      io.effectstream.proof-data.source-commit="${PROOF_CACHE_SOURCE_COMMIT}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/proof-params/bootstrap \
    PROOF_PARAMS_MANIFEST_DIR=/opt/proof-params/manifests \
    PROOF_PARAMS_DIR=/proof-params \
    PROOF_PARAMS_WORK=/work \
    PROOF_DATA_GENERATION=${PROOF_DATA_GENERATION}

COPY bootstrap/ /opt/proof-params/bootstrap/
COPY manifests/ /opt/proof-params/manifests/
COPY PROVENANCE.md /opt/proof-params/PROVENANCE.md

# Fail the build, not the stack, if the shipped metadata ever stops agreeing with itself.
# This is fully offline: it only cross-checks the four committed contracts.
RUN set -eu; \
    chmod 0644 /opt/proof-params/bootstrap/*.py /opt/proof-params/manifests/*.json /opt/proof-params/PROVENANCE.md; \
    mkdir -p /work; \
    python3 -m compileall -q /opt/proof-params/bootstrap >/dev/null; \
    find /opt/proof-params -name '__pycache__' -prune -exec rm -rf {} +; \
    python3 /opt/proof-params/bootstrap/warehouse_resolver.py validate \
      --manifest /opt/proof-params/manifests/warehouse-proof-data-v1.json \
      --expected-combined-manifest-sha256 "${PROOF_DATA_GENERATION}"

# The initializer is the only writer of the shared volume; both proof servers mount the
# activated generation read-only. It runs as root because a Docker named volume is created
# root-owned, and it publishes every file 0644 / every directory 0755 so any reader UID can
# read the tree without the volume ever being writable to a reader.
WORKDIR /opt/proof-params
ENTRYPOINT ["python3", "/opt/proof-params/bootstrap/entrypoint.py"]
