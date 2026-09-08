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

KERNEL_EXPECTED="${KERNEL_REF:-5d794f9a27f6d65529bf176650405f740531d430}"
# Provenance now, not a build input — and read from the matrix rather than duplicated here.
INDEXER_EXPECTED="$(pin 'components[indexer-standalone].sourceProvenance.commit')"
SOLVER_EXPECTED="${SOLVER_REF:-5d794f9a27f6d65529bf176650405f740531d430}"
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
FRONTEND_EXPECTED="${FRONTEND_REF:-400880ceb6814738d1ae193dae18ad5128922edc}"
# effectstream/shielded-night branch `ledger-v9` — the ledger-v9 port, and the only line whose
# `undeployed` lane is 2.x (`main` gained a 2.x tree in upstream PR #13 but wires it to
# stagenet only — docs/KNOWN-LIMITATIONS.md). The default here and the Dockerfile ARG default
# and compose/shielded-night.yml all state the same SHA; this assertion is what proves the
# RUNNING images were actually built from it.
SHIELDED_NIGHT_EXPECTED="${SHIELDED_NIGHT_REF:-30af63f3865d0bc5d5331ae32a7891ad48818303}"
# effectstream/mint-test-tokens branch `main` — the six local test-token issuers and their mint
# site. ONE pin for both runtime targets, and it is the one identity in this profile that
# matters: the image runs no compiler, so "the right commit" is not a proxy for "the right
# artifacts" here — it IS them. Upstream's deploy/verify runners re-prove the artifact bytes
# against that commit on every run, and the image proves it once at build time.
MINT_TEST_TOKENS_EXPECTED="${MINT_TEST_TOKENS_REF:-7ecad008b07acb2a491d8291e05455cbd638910f}"

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
  # The kernel tree is still cloned into this image, but ONLY for the compactc pin
  # and its checksums — the offer-files contract it used to compile is gone. The
  # label is kept because a stale AA image built against a pre-#69 kernel is
  # exactly what this file exists to catch.
  assert_pin aa-kernel-toolchain "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" /aa/.kernel-commit "$KERNEL_EXPECTED"
  # THE NEW ONE, and the important one: the console mints through the LOCAL
  # issuers, whose COMMITTED artifacts this image copies. Their verifier keys are
  # what the `faucet` profile registered on chain, so an AA image built from a
  # different mint-test-tokens commit would prove against keys this stack never
  # deployed. Same pin as compose/faucet.yml, asserted on the running image.
  assert_pin aa-mint-test-tokens "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" /aa/.mint-test-tokens-commit "$MINT_TEST_TOKENS_EXPECTED"
  assert_zkir_source aa "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}"
fi
if present aa-console; then
  assert_pin aa-console "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}" /aa/.aa-commit "$AA_EXPECTED"
  assert_pin aa-console-kernel-toolchain "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}" /aa/.kernel-commit "$KERNEL_EXPECTED"
  assert_pin aa-console-mint-test-tokens "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}" /aa/.mint-test-tokens-commit "$MINT_TEST_TOKENS_EXPECTED"
  assert_zkir_source aa-console "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}"
fi
# ── ONE COMPACT TOOLCHAIN ACROSS THE IMAGES (infra issues/00011) ────────────
#
# THE COMPARISON MOVED WITH THE CONTRACT. It used to be kernel-image vs AA-image:
# both compiled the SAME offer-files contract, and the AA console loaded that
# contract's module and the AA Manager's in ONE process, so a compactc mismatch
# meant verifier keys that did not match the deployed contract — the failure
# issues/00011 was opened about. At KERNEL_REF 5d794f9 the kernel image compiles
# NOTHING and ships no compactc, so that comparison has no left-hand side.
#
# The invariant it protected is still real, and it now has three parties:
#   1. the two AA images must share one compactc (they compile the same Manager
#      and Minter, and `aa-console` loads what `aa-deploy` deployed);
#   2. each AA image's INSTALLED @midnight-ntwrk/compact-runtime must equal what
#      its compactc emits — asserted inside the image at build time;
#   3. …and must equal the runtime the COPIED mint-test-tokens artifacts were
#      built for, which is the cross-repo half and also an in-image assertion.
#
# (2) and (3) cannot be re-checked from here without shipping more receipts, and
# an image that failed them does not exist. (1) can, and it is the one a stale
# image reintroduces: two AA images from different builds. Each records the
# version it used, so this compares images rather than restating a constant.
read_toolchain() { # <image> <path>
  docker run --rm --entrypoint cat "$1" "$2" 2>/dev/null | tr -d '\r\n'
}
assert_one_toolchain() {
  local base="" ver image label entry bad=0 seen=0
  for entry in \
    "aa:${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" \
    "aa-console:${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}"
  do
    label="${entry%%:*}"; image="${entry#*:}"
    ver="$(read_toolchain "$image" /aa/.compactc-version)"
    [[ -n "$ver" ]] || continue      # image not built in this stack
    seen=$(( seen + 1 ))
    if [[ -z "$base" ]]; then
      base="$ver"
      continue
    fi
    if [[ "$ver" != "$base" ]]; then
      err "compact toolchain: ${label} image compiled with compactc ${ver}, the other AA image with ${base}"
      bad=$(( bad + 1 ))
    fi
  done
  if (( seen == 0 )); then
    err "compact toolchain: no AA image carries /aa/.compactc-version"
    FAILURES=$(( FAILURES + 1 ))
    return
  fi
  if (( bad == 0 )); then
    ok "one compact toolchain: compactc ${base} in every image that compiles a contract (${seen} image(s))"
  else
    FAILURES=$(( FAILURES + bad ))
  fi
  # The kernel image must ship NONE. This is the demo-side twin of upstream's own
  # CI assertion and of the in-image check in images/offerfiles-kernel/Dockerfile:
  # "a fresh clone has zero Compact compilation for the kernel line" (spec SC-001)
  # stated as something a running stack can fail.
  local kernel_image="${KERNEL_IMAGE:-midnight-2-offers/offerfiles-kernel:local}"
  if present kernel; then
    if [[ -n "$(read_toolchain "$kernel_image" /app/.compactc-version)" ]]; then
      err "compact toolchain: ${kernel_image} still carries /app/.compactc-version — it should compile nothing"
      FAILURES=$(( FAILURES + 1 ))
    else
      ok "the kernel image ships no compactc (contract-free kernel line)"
    fi
  fi
}
if present aa-deploy || present aa-console; then
  assert_one_toolchain
fi

if present evm-rpc; then
  assert_pin umbra-evm "${EVM_IMAGE:-midnight-2-offers/umbra-evm:local}" /app/.umbra-commit "$UMBRA_EXPECTED"
fi
if present frontend; then
  assert_pin zswap-da "${FRONTEND_IMAGE:-midnight-2-offers/zswap-da:local}" /.zswap-da-commit "$FRONTEND_EXPECTED"
  # The BRANCH, beside the commit. A commit alone cannot say which line of the
  # template an image came from, and the two lines are not interchangeable:
  # `midnight-1` is upstream's 1.x/preprod line (@effectstream/*@0.104.x, wallet
  # SDK 1.x) that ledger-v9.patch ports to the 2.x set, while `v-next` is
  # already on 0.200.x. An image silently built from the other branch would
  # still carry a valid-looking 40-hex label.
  assert_label zswap-da-branch "${FRONTEND_IMAGE:-midnight-2-offers/zswap-da:local}" \
    /.zswap-da-branch "${FRONTEND_BRANCH:-midnight-1}"
  # …and it must ship no compiler, for the same reason the kernel image must not:
  # since upstream PR #922 the template has no Compact source, so an image that
  # can compile one was built from a tree that still had the contract lane.
  if docker run --rm --entrypoint sh "${FRONTEND_IMAGE:-midnight-2-offers/zswap-da:local}" \
       -c 'command -v compactc >/dev/null 2>&1 || test -e /usr/share/nginx/html/keys' >/dev/null 2>&1; then
    err "the frontend image carries a Compact compiler or ZK artifacts — it compiles no contract since FRONTEND_REF ${FRONTEND_EXPECTED:0:8} (#922)"
    FAILURES=$(( FAILURES + 1 ))
  else
    ok "the frontend image ships no compactc and no ZK artifacts (contract-free SPA)"
  fi
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
# BOTH mint-test-tokens runtime targets carry the commit, for the same reason: the static site a
# browser mints from and the runner that deployed the issuers are two images from one build, and
# an operator answering "which revision are these tokens?" from the wrong one is answering about
# the wrong artifact. The SITE is the sentinel service of the profile, so it is checked whenever
# the profile is up at all; the runner's containers are one-shots that may already be gone,
# which is why `present` is asked about each separately.
if present faucet-site; then
  assert_pin mint-test-tokens-site "${FAUCET_SITE_IMAGE:-midnight-2-offers/mint-test-tokens-site:local}" \
    /.mint-test-tokens-commit "$MINT_TEST_TOKENS_EXPECTED"
fi
if present faucet-deploy; then
  assert_pin mint-test-tokens "${FAUCET_RUNNER_IMAGE:-midnight-2-offers/mint-test-tokens:local}" \
    /.mint-test-tokens-commit "$MINT_TEST_TOKENS_EXPECTED"
fi

if (( FAILURES == 0 )); then
  ok "source provenance and artifact identity assertions passed"
  exit 0
fi
err "${FAILURES} source provenance / artifact identity assertion(s) failed"
exit 1
