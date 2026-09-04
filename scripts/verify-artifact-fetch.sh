#!/usr/bin/env bash
# Prove that the warehouse-backed image builds (indexer, Celestia) actually reject a wrong
# artifact — and that their pinned build arguments still agree with the frozen decision
# matrix.
#
# Two halves:
#
#   STATIC  (no Docker, no network) — every SHA-256, asset name and provenance value baked
#           into images/*/Dockerfile and images/celestia/official-equality.tsv is compared
#           against config/artifact-decisions.json. A Dockerfile default that drifts from
#           the matrix is the exact "second source of truth" the matrix exists to prevent.
#
#   NEGATIVE (real `docker build` runs) — the guards are exercised with deliberately wrong
#           build arguments. Each fixture MUST fail the build. A fixture that passes means
#           a guard is decorative, which is worse than having no guard at all: it reads as
#           protection in review.
#
# The name/architecture/version fixtures are designed to fail BEFORE the download step, so
# they cost no bandwidth; only the two hash fixtures per image need bytes, and BuildKit
# reuses the already-downloaded layer for those because only the verifying step's arguments
# changed.
#
#   ./scripts/verify-artifact-fetch.sh            # static + negative
#   ./scripts/verify-artifact-fetch.sh --static   # static only (offline, no Docker)
#   ./scripts/verify-artifact-fetch.sh --arch arm64
#
# Native version probes are NOT run here — they need a runnable image for the host's own
# architecture and belong to the component smoke in verify.sh / ci-check.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

MATRIX="$REPO_ROOT/config/artifact-decisions.json"
PINS="$REPO_ROOT/scripts/lib/artifact_pins.py"
INDEXER_DIR="$REPO_ROOT/images/indexer"
CELESTIA_DIR="$REPO_ROOT/images/celestia"
AA_DIR="$REPO_ROOT/images/aa-contracts"
EQUALITY="$CELESTIA_DIR/official-equality.tsv"

STATIC_ONLY=0
ARCH="amd64"
while (( $# )); do
  case "$1" in
    --static)  STATIC_ONLY=1 ;;
    --arch)    ARCH="${2:?--arch needs amd64 or arm64}"; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ "$ARCH" == "amd64" || "$ARCH" == "arm64" ]] || die "--arch must be amd64 or arm64"
PLATFORM="linux/${ARCH}"

command -v python3 >/dev/null 2>&1 || die "python3 is required"
[[ -f "$MATRIX" ]] || die "missing decision matrix: $MATRIX"

FAILURES=0
fail() { err "$*"; FAILURES=$(( FAILURES + 1 )); }

pin() { python3 "$PINS" "$MATRIX" "$1"; }

# ── static: Dockerfile defaults must equal the matrix ────────────────────────
#
# `dockerarg <file> <NAME>` reads the DEFAULT of an `ARG NAME=value` line. That default is
# what a clean clone builds with, so it — not a comment — is the value that has to match.
dockerarg() {
  sed -n "s/^ARG ${2}=\(.*\)$/\1/p" "$1" | head -1
}

expect() { # label expected actual
  if [[ "$2" == "$3" ]]; then
    dim "ok   $1 = $2"
  else
    fail "$1: Dockerfile has '${3:-<unset>}', matrix has '$2'"
  fi
}

log "static: image build arguments vs config/artifact-decisions.json"

expect "indexer WAREHOUSE_REPO"    "$(pin 'warehouse.repository')"  "$(dockerarg "$INDEXER_DIR/Dockerfile" WAREHOUSE_REPO)"
expect "indexer WAREHOUSE_RELEASE" "$(pin 'warehouse.releaseTag')"  "$(dockerarg "$INDEXER_DIR/Dockerfile" WAREHOUSE_RELEASE)"
expect "indexer catalog commit"    "$(pin 'warehouse.catalogCommit')" "$(dockerarg "$INDEXER_DIR/Dockerfile" WAREHOUSE_CATALOG_COMMIT)"
expect "indexer version"           "$(pin 'components[indexer-standalone].version')" "$(dockerarg "$INDEXER_DIR/Dockerfile" INDEXER_VERSION)"
expect "indexer source repo"       "$(pin 'components[indexer-standalone].sourceProvenance.repository')" "$(dockerarg "$INDEXER_DIR/Dockerfile" INDEXER_SOURCE_REPO)"
expect "indexer source commit"     "$(pin 'components[indexer-standalone].sourceProvenance.commit')" "$(dockerarg "$INDEXER_DIR/Dockerfile" INDEXER_SOURCE_COMMIT)"

for a in amd64 arm64; do
  A="$(printf '%s' "$a" | tr '[:lower:]' '[:upper:]')"
  asset="$(pin "components[indexer-standalone].assets[linux/${a}].name")"
  expect "indexer asset ${a}"   "$asset" "$(dockerarg "$INDEXER_DIR/Dockerfile" "INDEXER_ASSET_${A}")"
  expect "indexer archive ${a}" "$(pin "components[indexer-standalone].assets[linux/${a}].outerSha256")" \
                                "$(dockerarg "$INDEXER_DIR/Dockerfile" "INDEXER_ARCHIVE_SHA256_${A}")"
  expect "indexer exe ${a}"     "$(pin "components[indexer-standalone].assets[linux/${a}].memberSha256")" \
                                "$(dockerarg "$INDEXER_DIR/Dockerfile" "INDEXER_EXE_SHA256_${A}")"
  # The build derives the zip member from the asset name; the matrix records it explicitly.
  # If those two ever disagree the build would install a file the catalog never described.
  expect "indexer member ${a}"  "$(pin "components[indexer-standalone].assets[linux/${a}].memberPath")" "${asset%.zip}"
done

# The two vendored upstream runtime-support files are hash-checked during the build, so the
# expected hashes in the Dockerfile must match the files actually checked in.
for f in entrypoint.sh config.yaml; do
  case "$f" in
    entrypoint.sh) argname=INDEXER_ENTRYPOINT_SHA256 ;;
    *)             argname=INDEXER_CONFIG_SHA256 ;;
  esac
  expect "indexer vendored ${f}" \
    "$(sha256sum "$INDEXER_DIR/$f" | awk '{print $1}')" \
    "$(dockerarg "$INDEXER_DIR/Dockerfile" "$argname")"
done

expect "celestia WAREHOUSE_REPO"    "$(pin 'warehouse.repository')"    "$(dockerarg "$CELESTIA_DIR/Dockerfile" WAREHOUSE_REPO)"
expect "celestia WAREHOUSE_RELEASE" "$(pin 'warehouse.releaseTag')"    "$(dockerarg "$CELESTIA_DIR/Dockerfile" WAREHOUSE_RELEASE)"
expect "celestia catalog commit"    "$(pin 'warehouse.catalogCommit')" "$(dockerarg "$CELESTIA_DIR/Dockerfile" WAREHOUSE_CATALOG_COMMIT)"
expect "celestia app version"       "$(pin 'components[celestia-appd].version')" "$(dockerarg "$CELESTIA_DIR/Dockerfile" CELESTIA_APP_VERSION)"
expect "celestia node version"      "$(pin 'components[celestia-node].version')" "$(dockerarg "$CELESTIA_DIR/Dockerfile" CELESTIA_NODE_VERSION)"

for c in celestia-appd celestia-node; do
  case "$c" in celestia-appd) P=APP ;; *) P=NODE ;; esac
  for a in amd64 arm64; do
    A="$(printf '%s' "$a" | tr '[:lower:]' '[:upper:]')"
    expect "${c} asset ${a}"  "$(pin "components[${c}].assets[linux/${a}].name")" \
                              "$(dockerarg "$CELESTIA_DIR/Dockerfile" "CELESTIA_${P}_ASSET_${A}")"
    expect "${c} sha ${a}"    "$(pin "components[${c}].assets[linux/${a}].outerSha256")" \
                              "$(dockerarg "$CELESTIA_DIR/Dockerfile" "CELESTIA_${P}_SHA256_${A}")"
    expect "${c} msize ${a}"  "$(pin "components[${c}].assets[linux/${a}].memberSize")" \
                              "$(dockerarg "$CELESTIA_DIR/Dockerfile" "CELESTIA_${P}_MEMBER_SIZE_${A}")"
    # A `legacy-unverified` row has no cataloged member hash. `-` is how the build says
    # "the catalog does not know this", and it must never quietly become a real-looking
    # value that nothing independent corroborates.
    msha="$(python3 "$PINS" "$MATRIX" "components[${c}].assets[linux/${a}].memberSha256" --optional)"
    expect "${c} msha ${a}"   "${msha:--}" \
                              "$(dockerarg "$CELESTIA_DIR/Dockerfile" "CELESTIA_${P}_MEMBER_SHA256_${A}")"
  done
done

# The AA image's MinoCrab release pins. Same rule as the warehouse images: the ARG
# default is what a clean clone builds with, so it — not the matrix alone, and not a
# comment — is what has to agree. `MINOCRAB_SUMS_SHA256` is the load-bearing one: it is
# the SHA-256 of the release's SHA256SUMS, and therefore the identity of all 38 files.
MINOCRAB_URL_TEMPLATE="$(pin 'sources[minocrab-release].downloadUrlTemplate')"
expect "aa MINOCRAB_RELEASE"     "$(pin 'sources[minocrab-release].releaseTag')" \
                                 "$(dockerarg "$AA_DIR/Dockerfile" MINOCRAB_RELEASE)"
expect "aa MINOCRAB_REF"         "$(pin 'sources[minocrab-release].commit')" \
                                 "$(dockerarg "$AA_DIR/Dockerfile" MINOCRAB_REF)"
expect "aa MINOCRAB_SUMS_SHA256" "$(pin 'sources[minocrab-release].checksums.assetSha256')" \
                                 "$(dockerarg "$AA_DIR/Dockerfile" MINOCRAB_SUMS_SHA256)"
expect "aa MINOCRAB_REPO"        "${MINOCRAB_URL_TEMPLATE%%/releases/download/*}" \
                                 "$(dockerarg "$AA_DIR/Dockerfile" MINOCRAB_REPO)"
# The release's manifest states which CONTRACT its keys are for, and the build asserts it
# equals AA_REF. If the matrix and the Dockerfile disagreed about AA_REF, that assertion
# would be checking one repository's claim against the other's typo.
expect "aa AA_REF vs the release's contract pin" \
                                 "$(pin 'sources[minocrab-release].contractCommit')" \
                                 "$(dockerarg "$AA_DIR/Dockerfile" AA_REF)"

# ── static: the Celestia official-equality record ────────────────────────────
log "static: images/celestia/official-equality.tsv vs the matrix"

[[ -f "$EQUALITY" ]] || die "missing equality record: $EQUALITY"

equality_field() { # asset column
  awk -v a="$1" -v c="$2" '$1 == a { print $c }' "$EQUALITY"
}

for c in celestia-appd celestia-node; do
  for a in amd64 arm64; do
    asset="$(pin "components[${c}].assets[linux/${a}].name")"
    prov="$(pin "components[${c}].assets[linux/${a}].catalogProvenance")"
    rows="$(equality_field "$asset" 1 | grep -c . || true)"
    if [[ "$rows" != "1" ]]; then
      fail "equality record holds ${rows} rows for ${asset}, expected exactly 1"
      continue
    fi
    expect "${asset} provenance" "$prov"  "$(equality_field "$asset" 2)"
    expect "${asset} sha256"     "$(pin "components[${c}].assets[linux/${a}].outerSha256")" \
                                 "$(equality_field "$asset" 7)"
    if [[ "$prov" == "legacy-unverified" ]]; then
      # FR-003: the catalog's null source fields must not be back-filled. The equality is
      # proven against the official release instead, so those fields are asserted here.
      expect "${asset} source commit withheld" "-" "$(equality_field "$asset" 9)"
      expect "${asset} official repo" \
        "$(pin "components[${c}].assets[linux/${a}].officialEquality.repository")" "$(equality_field "$asset" 3)"
      expect "${asset} official tag" \
        "$(pin "components[${c}].assets[linux/${a}].officialEquality.releaseTag")" "$(equality_field "$asset" 4)"
      expect "${asset} official asset" \
        "$(pin "components[${c}].assets[linux/${a}].officialEquality.assetName")" "$(equality_field "$asset" 5)"
      expect "${asset} official asset id" \
        "$(pin "components[${c}].assets[linux/${a}].officialEquality.assetId")" "$(equality_field "$asset" 6)"
      expect "${asset} official checksums sha" \
        "$(pin "components[${c}].assets[linux/${a}].officialEquality.checksumsSha256")" "$(equality_field "$asset" 8)"
    else
      expect "${asset} source commit" \
        "$(pin "components[${c}].assets[linux/${a}].sourceProvenance.commit")" "$(equality_field "$asset" 9)"
      expect "${asset} upstream asset" \
        "$(pin "components[${c}].assets[linux/${a}].sourceProvenance.upstreamAssetName")" "$(equality_field "$asset" 5)"
    fi
    case "$(equality_field "$asset" 5)" in
      *-standalone_*) fail "${asset} equality row points at the standalone look-alike" ;;
    esac
  done
done

# ── static: what must NOT be in the tree any more ────────────────────────────
log "static: retired source-build and forced-platform inputs"

# These look for ACTIVE USE — an assignment, a `${VAR}` expansion, a compose `VAR:` key, a
# real build command — not for any mention of the name. Documentation is allowed, and
# indeed wanted, to tell a maintainer that `INDEXER_PLATFORM` no longer exists; what must
# not survive is anything that still reads it. This file names all of them by definition,
# so it excludes itself.
retired() { # label extended-regex
  local hits
  hits="$(grep -rInE --exclude-dir=.git --exclude="$(basename "$0")" -e "$2" \
            "$REPO_ROOT/images" "$REPO_ROOT/compose" "$REPO_ROOT/.env.example" \
            "$REPO_ROOT/scripts" "$REPO_ROOT/up.sh" 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    fail "retired input still in use — ${1}:"
    printf '%s\n' "$hits" | sed 's/^/           /' >&2
  else
    dim "ok   no active use of ${1}"
  fi
}

retired "INDEXER_PLATFORM"     '(\$\{?INDEXER_PLATFORM\b|^[[:space:]]*INDEXER_PLATFORM[=:])'
retired "INDEXER_RUST_VERSION" '(\$\{?INDEXER_RUST_VERSION\b|^[[:space:]]*INDEXER_RUST_VERSION[=:])'
retired "INDEXER_REPO"         '(\$\{?INDEXER_REPO\b|^[[:space:]]*INDEXER_REPO[=:])'
retired "INDEXER_REF"          '(\$\{?INDEXER_REF\b|^[[:space:]]*INDEXER_REF[=:])'
retired "a Rust builder stage" '^[[:space:]]*FROM[[:space:]]+rust:'
retired "a cargo build step"   '^[[:space:]]*[^#[:space:]].*cargo[[:space:]]+build'

if (( STATIC_ONLY )); then
  if (( FAILURES == 0 )); then
    ok "artifact fetch pins verified (static only; negative build fixtures not run)"
    exit 0
  fi
  err "${FAILURES} static artifact-fetch violation(s)"
  exit 1
fi

# ── negative: the build must reject a wrong artifact ─────────────────────────
require_docker

TAG_PREFIX="${IMAGE_TAG_SUFFIX:-artifact-fetch-check}"

# EXTRA_BUILD_FLAGS — anything that is not a --build-arg (a named build context, say).
# Reset by `reject` after every call, so a fixture cannot leak flags into the next one.
EXTRA_BUILD_FLAGS=()

reject() { # label dir target [build-arg ...]
  local label="$1" dir="$2" target="$3"; shift 3
  local args=() a out rc
  for a in "$@"; do args+=(--build-arg "$a"); done
  set +e
  # The build args are optional, so `args` can be empty; ${args[@]+"${args[@]}"} rather than
  # "${args[@]}" because macOS bash 3.2 calls the latter an unbound variable under `set -u`.
  out="$(docker build --platform "$PLATFORM" --target "$target" \
          ${EXTRA_BUILD_FLAGS[@]+"${EXTRA_BUILD_FLAGS[@]}"} \
          ${args[@]+"${args[@]}"} -t "midnight-2-offers/artifact-fetch-negative:${TAG_PREFIX}" \
          "$dir" 2>&1)"
  rc=$?
  set -e
  EXTRA_BUILD_FLAGS=()
  if (( rc == 0 )); then
    fail "NEGATIVE NOT REJECTED: ${label} — the build succeeded"
    printf '%s\n' "$out" | tail -5
  else
    ok "rejected  ${label}"
    printf '%s\n' "$out" | grep -m1 -E '^(#[0-9]+ [0-9.]+ )?FAIL:|sha256sum: WARNING|FAILED' \
      | sed 's/^/           /' || true
  fi
}

log "negative fixtures (platform ${PLATFORM})"

A="$(printf '%s' "$ARCH" | tr '[:lower:]' '[:upper:]')"
OTHER_ARCH=$([[ "$ARCH" == amd64 ]] && echo arm64 || echo amd64)
OTHER_A="$(printf '%s' "$OTHER_ARCH" | tr '[:lower:]' '[:upper:]')"

# 1-4: indexer, all rejected before any byte is downloaded.
reject "indexer / unsupported architecture" "$INDEXER_DIR" fetch \
  "TARGETARCH=riscv64"
reject "indexer / macOS asset selected for a Linux container" "$INDEXER_DIR" fetch \
  "INDEXER_ASSET_${A}=indexer-standalone-macos-arm64-v4.4.0-rc.3.zip"
reject "indexer / swapped architecture asset" "$INDEXER_DIR" fetch \
  "INDEXER_ASSET_${A}=$(pin "components[indexer-standalone].assets[linux/${OTHER_ARCH}].name")"
reject "indexer / asset does not match declared version" "$INDEXER_DIR" fetch \
  "INDEXER_VERSION=4.4.0-rc.1"

# 5-6: indexer, after the download — the archive is fetched once and reused.
reject "indexer / altered archive SHA-256" "$INDEXER_DIR" fetch \
  "INDEXER_ARCHIVE_SHA256_${A}=0000000000000000000000000000000000000000000000000000000000000000"
reject "indexer / altered executable SHA-256" "$INDEXER_DIR" fetch \
  "INDEXER_EXE_SHA256_${A}=0000000000000000000000000000000000000000000000000000000000000000"

# 7-11: Celestia.
reject "celestia / unsupported architecture" "$CELESTIA_DIR" fetch \
  "TARGETARCH=riscv64"
reject "celestia / macOS asset selected for a Linux container" "$CELESTIA_DIR" fetch \
  "CELESTIA_APP_ASSET_${A}=celestia-appd-macos-arm64-v6.4.10.tar.gz"
reject "celestia / swapped architecture asset" "$CELESTIA_DIR" fetch \
  "CELESTIA_NODE_ASSET_${A}=$(pin "components[celestia-node].assets[linux/${OTHER_ARCH}].name")"
# Deliberately shaped to satisfy every OTHER guard — Linux, right architecture, right
# version, right extension — so that the only thing left to reject it is the missing
# equality evidence.
reject "celestia / no official byte-equality record for the asset" "$CELESTIA_DIR" fetch \
  "CELESTIA_APP_ASSET_${A}=celestia-appd-unrecorded-linux-${ARCH}-v$(pin 'components[celestia-appd].version').tar.gz"
reject "celestia / equality evidence disagrees with the pinned archive SHA-256" "$CELESTIA_DIR" fetch \
  "CELESTIA_APP_SHA256_${A}=0000000000000000000000000000000000000000000000000000000000000000"
# A real warehouse archive with a real equality record and a correct hash — just the wrong
# component. Worth keeping even though the equality record's upstream-repository binding
# catches it before the archive is opened: that ordering is the point. The later
# "does the archive actually contain this executable" check is defence in depth behind it,
# and no published archive can reach it, because every asset that passes the name,
# version and repository bindings does contain its member.
reject "celestia / asset from the wrong upstream project" "$CELESTIA_DIR" fetch \
  "CELESTIA_APP_ASSET_${A}=$(pin "components[celestia-node].assets[${PLATFORM}].name")" \
  "CELESTIA_APP_VERSION=$(pin 'components[celestia-node].version')" \
  "CELESTIA_APP_SHA256_${A}=$(pin "components[celestia-node].assets[${PLATFORM}].outerSha256")"

# ── negative: the AA image's MinoCrab release gate ───────────────────────────
#
# The AA image takes the Manager's `execute` artifact from a PUBLISHED RELEASE and
# identifies it by one hash — the SHA-256 of the release's own SHA256SUMS. Three
# assertions stand between that pin and the image, and each of them is exercised here
# against a SYNTHETIC release built in a temp directory. Synthetic on purpose: these
# fixtures must run on a clean clone with no 663 MiB of key material anywhere, and a
# gate that can only be tested when you already hold the real assets is a gate nobody
# tests. The `minocrab-release` stage depends on no other stage, so `--target` builds
# it alone — no compactc, no keygen, no AA checkout.
minocrab_fixture_dir=""
make_minocrab_fixture() { # <corrupt-a-file: 0|1> <contract-commit>
  local corrupt="$1" contract="$2" d
  d="$(mktemp -d)"
  minocrab_fixture_dir="$d"
  # Content is irrelevant — nothing here is ever proved with. What is being tested is
  # whether the build believes a file it has not verified.
  printf 'not-a-real-zkir\n'     > "$d/execute.zkir"
  printf 'not-a-real-bzkir\n'    > "$d/execute.bzkir"
  printf 'not-a-real-verifier\n' > "$d/execute.verifier"
  cat > "$d/manifest.json" <<JSON
{
  "tag": "$(pin 'sources[minocrab-release].releaseTag')",
  "gitCommit": "$(pin 'sources[minocrab-release].commit')",
  "contractPin": {
    "commit": "${contract}"
  }
}
JSON
  ( cd "$d" && sha256sum execute.zkir execute.bzkir execute.verifier manifest.json > SHA256SUMS )
  if [[ "$corrupt" == "1" ]]; then
    # SHA256SUMS still says what the file used to be. This is the tamper the content
    # gate exists for, and it is invisible to the identity gate.
    printf 'tampered\n' > "$d/execute.verifier"
  fi
  MINOCRAB_FIXTURE_SUMS="$(sha256sum "$d/SHA256SUMS" | cut -d ' ' -f 1)"
}

# 12: the real pin against a release that is not the pinned one — the identity gate.
make_minocrab_fixture 0 "$(pin 'sources[minocrab-release].contractCommit')"
EXTRA_BUILD_FLAGS=(--build-context "minocrab=${minocrab_fixture_dir}")
reject "aa / MinoCrab release whose SHA256SUMS is not the pinned one" "$AA_DIR" minocrab-release
rm -rf "$minocrab_fixture_dir"

# 13: identity gate satisfied by construction, one file tampered with — the content gate.
make_minocrab_fixture 1 "$(pin 'sources[minocrab-release].contractCommit')"
EXTRA_BUILD_FLAGS=(--build-context "minocrab=${minocrab_fixture_dir}")
reject "aa / MinoCrab asset that SHA256SUMS does not vouch for" "$AA_DIR" minocrab-release \
  "MINOCRAB_SUMS_SHA256=${MINOCRAB_FIXTURE_SUMS}"
rm -rf "$minocrab_fixture_dir"

# 14: both hash gates satisfied, but these keys are for a DIFFERENT contract. This is the
# one a re-pin of AA_REF alone would walk into: bytes that verify perfectly and prove the
# wrong statement.
make_minocrab_fixture 0 "0123456789abcdef0123456789abcdef01234567"
EXTRA_BUILD_FLAGS=(--build-context "minocrab=${minocrab_fixture_dir}")
reject "aa / MinoCrab keys whose manifest names another contract" "$AA_DIR" minocrab-release \
  "MINOCRAB_SUMS_SHA256=${MINOCRAB_FIXTURE_SUMS}"
rm -rf "$minocrab_fixture_dir"

# 15: an unknown artifact source must not silently fall through to "compactc".
EXTRA_BUILD_FLAGS=(--build-context "minocrab=${AA_DIR}/minocrab-local")
reject "aa / unknown AA_ZKIR_SOURCE" "$AA_DIR" minocrab-release \
  "AA_ZKIR_SOURCE=whatever"

docker rmi "midnight-2-offers/artifact-fetch-negative:${TAG_PREFIX}" >/dev/null 2>&1 || true

if (( FAILURES == 0 )); then
  ok "artifact fetch pins and negative fixtures verified"
  exit 0
fi
err "${FAILURES} artifact-fetch violation(s)"
exit 1
