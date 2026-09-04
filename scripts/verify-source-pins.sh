#!/usr/bin/env bash
# Verify that running profiles were built from the exact configured external artifacts,
# rather than from a stale shared :local image.
#
# Two kinds of assertion live here:
#
#   * SOURCE PINS — for the components this repository still builds from source (kernel,
#     solver, AA, Umbra, frontend), the commit baked into the image must equal the
#     configured full SHA.
#   * ARTIFACT IDENTITY — the indexer is no longer compiled. It installs a published
#     warehouse executable, so proving "the right commit" is not enough: the running image
#     must also name the exact warehouse release, catalog commit, asset, archive hash and
#     platform it came from, and the executable on disk must still hash to the cataloged
#     value. All of those expectations are read from config/artifact-decisions.json, so
#     this script holds no second copy of an identity that could drift from the matrix.
#   * IMMUTABLE IMAGE REFERENCES — the containers that are actually running must have been
#     created from the digest-pinned references the matrix froze. `verify-compose-pins.sh`
#     proves the rendered configuration asks for them; this proves the daemon was given
#     them, which is the claim a reviewer of a live stack cares about.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

MATRIX="$REPO_ROOT/config/artifact-decisions.json"
PINS="$REPO_ROOT/scripts/lib/artifact_pins.py"

FAILURES=0

# pin <matrix path> — one pinned value from the frozen artifact-decision matrix.
pin() {
  python3 "$PINS" "$MATRIX" "$1"
}

present() {
  [[ -n "$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" 2>/dev/null)" ]]
}

assert_pin() { # label image path expected
  local label="$1" image="$2" path="$3" expected="$4" actual
  if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
    err "${label}: configured ref is not a full commit SHA (${expected})"
    FAILURES=$(( FAILURES + 1 ))
    return
  fi
  actual=$(docker run --rm --entrypoint cat "$image" "$path" 2>/dev/null | tr -d '\r\n') || actual=""
  if [[ "$actual" == "$expected" ]]; then
    ok "${label} source pin ${actual:0:12}…"
  else
    err "${label}: image ${image} baked ${actual:-unreadable}, expected ${expected}"
    FAILURES=$(( FAILURES + 1 ))
  fi
}

# assert_label <label> <image> <path> <expected>
#
# assert_pin's sibling for the identities that are NOT commits — a release tag, the
# SHA-256 of a SHA256SUMS, the name of a zkir source. Same read-it-back-off-the-image
# shape; only the "is it a commit" precondition is dropped, because insisting a
# 64-hex hash look like a 40-hex commit is how a real check gets deleted.
assert_label() {
  local label="$1" image="$2" path="$3" expected="$4" actual
  actual=$(docker run --rm --entrypoint cat "$image" "$path" 2>/dev/null | tr -d '\r\n') || actual=""
  if [[ "$actual" == "$expected" ]]; then
    ok "${label} ${actual}"
  else
    err "${label}: image ${image} carries '${actual:-unreadable}', expected '${expected}'"
    FAILURES=$(( FAILURES + 1 ))
  fi
}

# assert_artifact <image>
#
# The indexer's full artifact identity, as recorded inside the image at build time and as
# re-derived from the image right now. `.indexer-artifact` alone would only prove the build
# wrote a nice-looking record, so the installed executable is re-hashed too: an image whose
# binary was swapped after the fact fails here even though its provenance file still reads
# correctly.
assert_artifact() {
  local image="$1" arch platform artifact exe_sha field expected actual bad=0
  arch="$(docker image inspect "$image" --format '{{.Architecture}}' 2>/dev/null)" || arch=""
  if [[ -z "$arch" ]]; then
    err "indexer artifact: cannot inspect image ${image}"
    FAILURES=$(( FAILURES + 1 ))
    return
  fi
  platform="linux/${arch}"

  artifact="$(docker run --rm --entrypoint cat "$image" \
    /opt/indexer-standalone/.indexer-artifact 2>/dev/null)" || artifact=""
  if [[ -z "$artifact" ]]; then
    err "indexer artifact: ${image} carries no /opt/indexer-standalone/.indexer-artifact"
    FAILURES=$(( FAILURES + 1 ))
    return
  fi

  field() {
    printf '%s' "$artifact" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"
  }

  check() { # label expected actual
    if [[ "$2" != "$3" ]]; then
      err "indexer artifact ${1}: image says '${3}', matrix says '${2}'"
      bad=$(( bad + 1 ))
    fi
  }

  check platform "$platform" "$(field platform)"
  check version \
    "$(pin 'components[indexer-standalone].version')" "$(field version)"
  check semanticId \
    "indexer-standalone/$(pin 'components[indexer-standalone].version')/${platform}" \
    "$(field semanticId)"
  check warehouseRepository "$(pin 'warehouse.repository')"   "$(field warehouseRepository)"
  check warehouseRelease    "$(pin 'warehouse.releaseTag')"   "$(field warehouseRelease)"
  check catalogCommit       "$(pin 'warehouse.catalogCommit')" "$(field warehouseCatalogCommit)"
  check assetName \
    "$(pin "components[indexer-standalone].assets[${platform}].name")" "$(field assetName)"
  check archiveSha256 \
    "$(pin "components[indexer-standalone].assets[${platform}].outerSha256")" "$(field archiveSha256)"
  check memberPath \
    "$(pin "components[indexer-standalone].assets[${platform}].memberPath")" "$(field memberPath)"
  check sourceRepository \
    "$(pin 'components[indexer-standalone].sourceProvenance.repository')" "$(field sourceRepository)"
  check sourceCommit \
    "$(pin 'components[indexer-standalone].sourceProvenance.commit')" "$(field sourceCommit)"

  expected="$(pin "components[indexer-standalone].assets[${platform}].memberSha256")"
  check executableSha256 "$expected" "$(field executableSha256)"

  actual="$(docker run --rm --entrypoint sha256sum "$image" \
    /usr/local/bin/indexer-standalone 2>/dev/null | awk '{print $1}')" || actual=""
  if [[ "$actual" != "$expected" ]]; then
    err "indexer artifact: installed executable hashes ${actual:-unreadable}, cataloged ${expected}"
    bad=$(( bad + 1 ))
  fi

  if (( bad == 0 )); then
    ok "indexer artifact ${platform} $(field assetName) exe ${expected:0:12}…"
  else
    FAILURES=$(( FAILURES + bad ))
  fi
}

# assert_image_ref <label> <service> <expected full ref>
#
# The reference the RUNNING container was created from, read back off the daemon. A digest
# reference is content-addressed, so equality here means the bytes are the ones the matrix
# pinned — no tag lookup, no registry trust, and no "it was right when we rendered it".
assert_image_ref() {
  local label="$1" service="$2" expected="$3" cid actual
  cid=$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=${service}" 2>/dev/null | head -1)
  [[ -n "$cid" ]] || return 0   # service not part of the profiles that are up
  actual=$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null) || actual=""
  if [[ "$actual" == "$expected" ]]; then
    ok "${label} image ${expected#*@}"
    return 0
  fi
  err "${label}: container runs ${actual:-unreadable}, matrix pins ${expected}"
  FAILURES=$(( FAILURES + 1 ))
}

# Node, toolkit and both proof variants — every external runtime image in this stack.
assert_image_ref node       node \
  "$(pin 'components[midnight-node].oci.repository')@$(pin 'components[midnight-node].oci.indexDigest')"
assert_image_ref proof-plain proof-server \
  "$(pin 'components[proof-server-plain].destination.repository')@$(pin 'components[proof-server-plain].destination.indexDigest')"
assert_image_ref proof-experimental aa-proof-server \
  "$(pin 'components[proof-server-experimental].destination.repository')@$(pin 'components[proof-server-experimental].destination.indexDigest')"

# The two proof variants are different programs; a stack that ran the same image twice
# would satisfy every per-service check above and still be wrong.
if present proof-server && present aa-proof-server; then
  if [[ "$(pin 'components[proof-server-plain].destination.indexDigest')" \
     == "$(pin 'components[proof-server-experimental].destination.indexDigest')" ]]; then
    err "plain and experimental proof servers are pinned to the same digest"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

KERNEL_EXPECTED="${KERNEL_REF:-4af102536f02f137b696a4734bd8c936eddf3672}"
# Provenance now, not a build input — and read from the matrix rather than duplicated here.
INDEXER_EXPECTED="$(pin 'components[indexer-standalone].sourceProvenance.commit')"
SOLVER_EXPECTED="${SOLVER_REF:-4af102536f02f137b696a4734bd8c936eddf3672}"
AA_EXPECTED="${AA_REF:-41de69ded41ff933fe0db8697b264dc46fc6e0cb}"
# The MinoCrab port's release: three DIFFERENT kinds of identity, and only the
# first is a commit. `MINOCRAB_SUMS_SHA256` is the one that decides which bytes
# the image took — the tag is a locator and the commit says which tree produced
# them, but a release could in principle be re-cut from the same commit.
MINOCRAB_EXPECTED="${MINOCRAB_REF:-7cdfa5b0c994a70502ab2b564b509c8abe2f7efb}"
MINOCRAB_SUMS_EXPECTED="${MINOCRAB_SUMS_SHA256:-4a8c0183cd887e3ca2d3446f196fab1102540e09d6e0e8ae9c1859532d8dd7ac}"
MINOCRAB_RELEASE_EXPECTED="${MINOCRAB_RELEASE:-v0.2.0}"
AA_ZKIR_SOURCE_EXPECTED="${AA_ZKIR_SOURCE:-minocrab}"
UMBRA_EXPECTED="${UMBRA_REF:-5a46348585ae23994cc408a06f6ef18a78b06273}"
FRONTEND_EXPECTED="${FRONTEND_REF:-ea04ff7c16dab5118d4bdfeec6e7455c89981827}"
# effectstream/shielded-night branch `ledger-v9` — the ledger-v9 port. The default here and
# the Dockerfile ARG default and compose/shielded-night.yml all state the same SHA; this
# assertion is what proves the RUNNING images were actually built from it.
SHIELDED_NIGHT_EXPECTED="${SHIELDED_NIGHT_REF:-30af63f3865d0bc5d5331ae32a7891ad48818303}"

if present indexer; then
  assert_pin indexer "${INDEXER_IMAGE:-midnight-2-offers/indexer:local}" /opt/indexer-standalone/.indexer-commit "$INDEXER_EXPECTED"
  assert_artifact "${INDEXER_IMAGE:-midnight-2-offers/indexer:local}"
fi

if present kernel; then
  assert_pin kernel "${KERNEL_IMAGE:-midnight-2-offers/offerfiles-kernel:local}" /app/.kernel-commit "$KERNEL_EXPECTED"
fi
if present solver; then
  assert_pin solver "${SOLVER_IMAGE:-midnight-2-offers/cow-solver:local}" /app/.solver-commit "$SOLVER_EXPECTED"
  assert_pin solver-kernel-base "${SOLVER_IMAGE:-midnight-2-offers/cow-solver:local}" /app/.kernel-commit "$KERNEL_EXPECTED"
fi
# The Manager's zkir artifact provenance, asserted on BOTH aa images. `execute`
# (or all nine, with minocrab-all) comes from a published release identified by
# the SHA-256 of its SHA256SUMS; a stale image that predates the re-pin reads back
# the wrong hash here, which is precisely the class verify-source-pins exists for.
assert_zkir_source() { # <label> <image>
  local label="$1" image="$2"
  assert_label "${label} zkir source" "$image" /aa/.aa-zkir-source "$AA_ZKIR_SOURCE_EXPECTED"
  [[ "$AA_ZKIR_SOURCE_EXPECTED" == "compactc" ]] && return 0
  assert_pin   "${label} minocrab"        "$image" /aa/.minocrab-commit      "$MINOCRAB_EXPECTED"
  assert_label "${label} minocrab release" "$image" /aa/.minocrab-release     "$MINOCRAB_RELEASE_EXPECTED"
  assert_label "${label} minocrab SHA256SUMS" "$image" /aa/.minocrab-sums-sha256 "$MINOCRAB_SUMS_EXPECTED"
}

if present aa-deploy; then
  assert_pin aa "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" /aa/.aa-commit "$AA_EXPECTED"
  assert_pin aa-offerfiles-contract "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" /aa/.kernel-commit "$KERNEL_EXPECTED"
  assert_zkir_source aa "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}"
fi
if present aa-console; then
  assert_pin aa-console "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}" /aa/.aa-commit "$AA_EXPECTED"
  assert_zkir_source aa-console "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}"
fi
if present evm-rpc; then
  assert_pin umbra-evm "${EVM_IMAGE:-midnight-2-offers/umbra-evm:local}" /app/.umbra-commit "$UMBRA_EXPECTED"
fi
if present frontend; then
  assert_pin zswap-da "${FRONTEND_IMAGE:-midnight-2-offers/zswap-da:local}" /.zswap-da-commit "$FRONTEND_EXPECTED"
fi
# BOTH shielded-night runtime targets carry the commit, and both are asserted. They are two
# images from one build — the nginx page server and the bun deploy/verify one-shot — and only
# one of them is what a browser sees. An operator answering "which revision is this page?"
# from the deploy container's label would be answering about the wrong artifact.
if present shielded-night; then
  assert_pin shielded-night "${SHIELDED_NIGHT_IMAGE:-midnight-2-offers/shielded-night:local}" \
    /.shielded-night-commit "$SHIELDED_NIGHT_EXPECTED"
fi
if present shielded-night-deploy; then
  assert_pin shielded-night-deploy "${SHIELDED_NIGHT_DEPLOY_IMAGE:-midnight-2-offers/shielded-night-deploy:local}" \
    /.shielded-night-commit "$SHIELDED_NIGHT_EXPECTED"
fi

if (( FAILURES == 0 )); then
  ok "source provenance and artifact identity assertions passed"
  exit 0
fi
err "${FAILURES} source provenance / artifact identity assertion(s) failed"
exit 1
