#!/usr/bin/env bash
# Compile the fixture contract twice, into a TEST-SCOPED artifact volume.
#
#   /artifacts/v2  default `zkir` backend   -> IR header midnight:ir-source[v2]:
#   /artifacts/v3  --feature-zkir-v3        -> IR header midnight:ir-source[v3-generic]:
#
# Key generation needs the universal SRS. It is taken READ-ONLY from the already-activated
# proof-data generation mounted at /proof-params: the compiler's parameter cache is a farm of
# symlinks into the generation, so nothing is copied, nothing is written back, and no byte is
# fetched from srs.midnight.network. The gate runs this container on the INTERNAL network, so
# a silent origin fetch cannot happen — it would fail DNS resolution instead.
#
# Environment:
#   PROOF_DATA_GENERATION  activated generation directory name (required)
#   PROOF_PARAMS_DIR       cache root, read-only          (default /proof-params)
#   ARTIFACT_DIR           output root, read-write        (default /artifacts)

set -euo pipefail

generation="${PROOF_DATA_GENERATION:?PROOF_DATA_GENERATION is required}"
params_dir="${PROOF_PARAMS_DIR:-/proof-params}"
artifact_dir="${ARTIFACT_DIR:-/artifacts}"
source_file="${ZKIR_FIXTURE_SOURCE:-/fixture/zkir-fixture.compact}"
active="${params_dir}/generations/${generation}"

test -d "$active" || { printf 'no activated generation at %s\n' "$active" >&2; exit 2; }

export HOME=/tmp
export XDG_CACHE_HOME=/tmp/zk-cache
params_cache="${XDG_CACHE_HOME}/midnight/zk-params"
mkdir -p "$params_cache"
for k in $(seq 0 19); do
  test -f "${active}/bls_midnight_2p${k}" \
    || { printf 'generation is missing bls_midnight_2p%s\n' "$k" >&2; exit 2; }
  ln -sfn "${active}/bls_midnight_2p${k}" "${params_cache}/bls_midnight_2p${k}"
done

rm -rf "${artifact_dir}/v2" "${artifact_dir}/v3"
mkdir -p "${artifact_dir}/v2" "${artifact_dir}/v3"

/opt/compactc/compactc                   "$source_file" "${artifact_dir}/v2/"
/opt/compactc/compactc --feature-zkir-v3 "$source_file" "${artifact_dir}/v3/"

# The compiler must not have touched the read-only generation, and no fixture artifact may
# have been written into it.
if find "$params_dir" -name 'bump.*' -print -quit | grep -q .; then
  printf 'fixture artifact leaked into the shared cache\n' >&2
  exit 1
fi

for backend in v2:'midnight:ir-source[v2]:' v3:'midnight:ir-source[v3-generic]:'; do
  dir="${backend%%:*}"
  want="${backend#*:}"
  got="$(head -c "${#want}" "${artifact_dir}/${dir}/zkir/bump.bzkir")"
  test "$got" = "$want" \
    || { printf '%s IR header is %s, expected %s\n' "$dir" "$got" "$want" >&2; exit 1; }
  printf 'zkir-fixture %s: header=%s prover=%s B verifier=%s B bzkir=%s B\n' \
    "$dir" "$want" \
    "$(stat -c %s "${artifact_dir}/${dir}/keys/bump.prover")" \
    "$(stat -c %s "${artifact_dir}/${dir}/keys/bump.verifier")" \
    "$(stat -c %s "${artifact_dir}/${dir}/zkir/bump.bzkir")"
done

printf 'zkir-fixture compiled both backends offline from generation %s\n' "$generation"
