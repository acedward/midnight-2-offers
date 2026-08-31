#!/usr/bin/env bash
# Targeted proof-data cache gate.
#
# Runs the whole Phase-3 cache story in one isolated Docker project:
#
#   1. build the initializer image;
#   2. bring up initializer + both proof-server variants on an internal (no-egress)
#      network and prove they resolve every K0-K19 object from the shared read-only
#      generation with the origin unreachable;
#   3. force-recreate every service and prove the generation is reused with zero
#      warehouse bytes downloaded;
#   4. compile the minimal Compact fixture with BOTH ZKIR backends and prove one real
#      contract circuit per proof-server variant, with the plain server's refusal of the
#      v3 artifact as the variant-distinction control;
#   5. run the corruption / interruption / concurrency / resolver negatives;
#   6. tear down only this project's own containers, network, volume and image tag.
#
# It never prunes, never uses a name glob, and never removes an object it did not create.
#
# Usage:
#   ./run-gate.sh [--project NAME] [--keep] [--output FILE]
#
# Environment:
#   P3_PROJECT           Compose project name (default proof-params-gate-$$)
#   PROOF_PARAMS_IMAGE   Image tag to build and test (default derived from the project)
#   PROOF_IMAGE          Plain rc.5 proof-server reference (default: pinned upstream digest)
#   AA_PROOF_IMAGE       Experimental rc.5 proof-server reference (default: pinned digest)

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
component="$(dirname -- "$here")"

project="${P3_PROJECT:-proof-params-gate-$$}"
keep=0
output=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) project="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

image="${PROOF_PARAMS_IMAGE:-midnight-2-offers/proof-params:${project}}"
# Test-only compactc toolchain for the ZKIR fixture stage. Ships the compiler and nothing
# it generates: contract proving keys must never enter an OCI layer.
zkir_image="${ZKIR_FIXTURE_IMAGE:-midnight-2-offers/zkir-fixture:${project}}"
work="$(mktemp -d)"
compose_file="$here/compose.proof-params.yml"
generation='b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c'

export P3_PROJECT="$project"
export PROOF_PARAMS_IMAGE="$image"

log() { printf '\n== %s\n' "$*"; }

cleanup() {
  status=$?
  if [ "$keep" -eq 1 ]; then
    printf '\n[gate] --keep set: leaving project %s in place\n' "$project"
  else
    log "scoped teardown of project ${project}"
    docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
    # Label-scoped sweeps only. Never a name glob, never a prune.
    docker ps -aq --filter "label=com.docker.compose.project=${project}" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "label=com.docker.compose.project=${project}" | xargs -r docker network rm >/dev/null 2>&1 || true
    docker volume ls -q --filter "label=com.docker.compose.project=${project}" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
    # Only the exact tags this run built.
    docker image inspect "$image" >/dev/null 2>&1 && docker rmi "$image" >/dev/null 2>&1 || true
    docker image inspect "$zkir_image" >/dev/null 2>&1 && docker rmi "$zkir_image" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "building ${image}"
docker build -t "$image" "$component"

log "bringing up initializer + both proof-server variants"
docker compose -f "$compose_file" up -d --wait-timeout 900 2>&1 | tail -5 || docker compose -f "$compose_file" up -d 2>&1 | tail -5

init_result="$(docker compose -f "$compose_file" logs --no-log-prefix proof-params-init 2>/dev/null | grep -F 'proof-params-initializer-result-v1' | tail -1)"
printf '[gate] first initializer result: %s\n' "$init_result"
printf '%s' "$init_result" | grep -q '"result":"ACTIVATED"' \
  || { printf '[gate] FAIL: empty volume did not activate a generation\n' >&2; exit 1; }
printf '%s' "$init_result" | grep -q "\"generation\":\"${generation}\"" \
  || { printf '[gate] FAIL: activated an unexpected generation\n' >&2; exit 1; }

client="${project}-proof-client-1"

log "offline readiness and K0-K19 resolution through both variants"
docker exec "$client" python3 -c '
import json, sys, time, urllib.request

fixed = "/proof-params/generations/" + sys.argv[1]
report = {}
for host in ("proof-server", "aa-proof-server"):
    base = f"http://{host}:6300"
    deadline = time.monotonic() + 300
    version = None
    while time.monotonic() < deadline:
        try:
            version = urllib.request.urlopen(base + "/version", timeout=5).read().decode()
            break
        except Exception:
            time.sleep(2)
    assert version == "9.0.0-rc.5", f"{host} version drift: {version!r}"
    health = json.loads(urllib.request.urlopen(base + "/health", timeout=10).read())
    ready = json.loads(urllib.request.urlopen(base + "/ready", timeout=10).read())
    assert health["status"] == "ok" and ready["status"] == "ok", f"{host} not healthy"
    results = {urllib.request.urlopen(f"{base}/fetch-params/{k}", timeout=60).read().decode() for k in range(20)}
    assert results == {"success"}, f"{host} could not resolve K0-K19 offline: {results}"
    report[host] = {"version": version, "k0_k19": "success", "midnightPp": fixed}

# The origin must be unreachable from this network at all.
try:
    urllib.request.urlopen("https://srs.midnight.network/bls_midnight_2p0", timeout=10)
    raise AssertionError("origin was reachable from the offline reader network")
except AssertionError:
    raise
except Exception as exc:
    report["originBlocked"] = type(exc).__name__
print(json.dumps(report, sort_keys=True))
' "$generation"

log "asserting reader mounts are read-only and pinned to the fixed generation"
for service in proof-server aa-proof-server; do
  docker inspect "${project}-${service}-1" --format \
    '{{$rw := true}}{{range .Mounts}}{{if eq .Destination "/proof-params"}}{{$rw = .RW}}{{end}}{{end}}{{.Name}} rw={{$rw}}' \
    | tee /dev/stderr | grep -q 'rw=false' \
    || { printf '[gate] FAIL: %s mounts the cache read-write\n' "$service" >&2; exit 1; }
  docker inspect "${project}-${service}-1" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -qx "MIDNIGHT_PP=/proof-params/generations/${generation}" \
    || { printf '[gate] FAIL: %s MIDNIGHT_PP is not the fixed generation\n' "$service" >&2; exit 1; }
done

log "no covered-data origin request in either reader log"
# Log assertions capture the stream first and grep the string: `docker logs | grep -q`
# dies of SIGPIPE under pipefail whenever the match precedes the end of a chunk —
# Docker Desktop on macOS delivers logs in multiple chunks, so grep's early exit kills
# the still-writing producer (141) and pipefail reports the MATCHED pipeline as failed.
for service in proof-server aa-proof-server; do
  reader_log="$(docker logs "${project}-${service}-1" 2>&1)"
  if grep -Eiq 'srs\.midnight\.network|Downloading|Fetching param' <<<"$reader_log"; then
    printf '[gate] FAIL: %s logged a covered-data origin attempt\n' "$service" >&2
    exit 1
  fi
done

log "force-recreate: the same generation must be reused with zero warehouse bytes"
docker compose -f "$compose_file" up -d --force-recreate 2>&1 | tail -3
recreate_result="$(docker compose -f "$compose_file" logs --no-log-prefix proof-params-init 2>/dev/null | grep -F 'proof-params-initializer-result-v1' | tail -1)"
printf '[gate] recreate initializer result: %s\n' "$recreate_result"
printf '%s' "$recreate_result" | grep -q '"result":"NOOP"' \
  || { printf '[gate] FAIL: recreate did not reuse the generation\n' >&2; exit 1; }
printf '%s' "$recreate_result" | grep -q '"downloadedBytes":0' \
  || { printf '[gate] FAIL: recreate downloaded warehouse payloads again\n' >&2; exit 1; }

docker run --rm --entrypoint python3 \
  --mount "type=volume,src=${project}_proof-params,dst=/proof-params,readonly" "$image" -c '
import os, sys
generations = sorted(os.listdir("/proof-params/generations"))
assert generations == [sys.argv[1]], f"unexpected generation set: {generations}"
assert os.readlink("/proof-params/current") == "generations/" + sys.argv[1]
assert sorted(os.listdir("/proof-params/quarantine")) == []
print("reuse confirmed: one generation, pointer intact, quarantine empty")
' "$generation"

log "one representative REAL proof through each variant, offline, from the cache alone"
# Two stages on purpose: dependencies are installed on the egress network, and the proof
# itself runs on the internal network. The proving request carries option(proving-data)
# = None, so the server must resolve zswap/9/output.prover from its own read-only
# MIDNIGHT_PP generation -- there is no prover key anywhere in the request.
node_image="${NODE_IMAGE:-docker.io/library/node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96}"
fixture="$here/proof-fixture"
deps_volume="${project}-proof-fixture-deps"
mkdir -p "$work/proofs"
chmod 0777 "$work/proofs"

docker volume create --label "com.docker.compose.project=${project}" "$deps_volume" >/dev/null
docker run --rm --network "${project}_warehouse" \
  --mount "type=bind,src=${fixture},dst=/fixture,readonly" \
  --mount "type=volume,src=${deps_volume},dst=/deps" \
  "$node_image" sh -c '
    set -e
    mkdir -p /build && cp /fixture/package.json /fixture/package-lock.json /build/
    cd /build && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
    cp -a /build/node_modules/. /deps/
  '

# The deps volume IS the node_modules tree and is mounted at / so ESM resolution finds it
# without needing a writable mountpoint inside the read-only fixture bind.
real_proof() {
  docker run --rm --network "${project}_offline" \
    --mount "type=volume,src=${deps_volume},dst=/node_modules,readonly" \
    --mount "type=bind,src=${fixture},dst=/fixture,readonly" \
    --mount "type=bind,src=${work}/proofs,dst=/out" \
    -w / "$node_image" \
    node /fixture/real-proof.mjs --base "http://$2:6300" --role "$1" --output "/out/real-proof-$1.json"
}
real_proof plain proof-server
real_proof experimental aa-proof-server

log "negative control: the same request against an EMPTY cache must fail"
# Without this control, a passing proof does not prove the key came from the cache.
empty_volume="${project}-empty-pp"
control="${project}-empty-cache-control"
docker volume create --label "com.docker.compose.project=${project}" "$empty_volume" >/dev/null
docker run -d --name "$control" --network "${project}_offline" \
  --label "com.docker.compose.project=${project}" \
  -e PORT=6300 -e MIDNIGHT_PP=/proof-params -e MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS=true \
  --mount "type=volume,src=${empty_volume},dst=/proof-params" \
  "${PROOF_IMAGE:-docker.io/midnightntwrk/proof-server@sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9}" >/dev/null
sleep 8
if real_proof empty-cache-control "$control" >/dev/null 2>&1; then
  printf '[gate] FAIL: a proof succeeded against an EMPTY cache — the key did not come from the generation\n' >&2
  docker rm -f "$control" >/dev/null 2>&1 || true
  exit 1
fi
control_log="$(docker logs "$control" 2>&1)"
grep -q 'Missing zero-knowledge proving key' <<<"$control_log" \
  || { printf '[gate] FAIL: empty-cache control did not report the missing key\n' >&2; exit 1; }
printf '[gate] control confirmed: empty cache -> "Missing zero-knowledge proving key ... Attempting to download"\n'
docker rm -f "$control" >/dev/null 2>&1 || true
docker volume rm -f "$empty_volume" >/dev/null 2>&1 || true

log "ZKIR fixture: one real CONTRACT-CIRCUIT proof per variant (v2 -> plain, v3 -> experimental)"
# The Zswap proof above cannot tell the two builds apart: it is the v1/v2 lane both share.
# A ZKIR-v3 proof needs a contract circuit, whose proving key can never be cache-resident
# (FR-013 scopes the generation to SRS + Ledger-static-9). So the circuit key travels in the
# request while the SRS half still comes from the read-only generation. See zkir-fixture/README.md.
zkir_fixture="$here/zkir-fixture"
zkir_artifacts="${project}-zkir-artifacts"
zkir_deps="${project}-zkir-fixture-deps"

docker build -t "$zkir_image" "$zkir_fixture" >/dev/null
# The load-bearing key-hygiene boundary: the shipped image holds the compiler, never a key.
if docker run --rm --entrypoint find "$zkir_image" / -xdev -name '*.prover' -print -quit | grep -q .; then
  printf '[gate] FAIL: the compactc toolchain image contains a proving key\n' >&2
  exit 1
fi

docker volume create --label "com.docker.compose.project=${project}" "$zkir_artifacts" >/dev/null
docker volume create --label "com.docker.compose.project=${project}" "$zkir_deps" >/dev/null

# Compiled ON THE INTERNAL NETWORK: key generation reads the universal SRS straight out of the
# read-only generation, so a silent srs.midnight.network fetch would fail DNS, not succeed.
docker run --rm --network "${project}_offline" \
  -e "PROOF_DATA_GENERATION=${generation}" \
  --mount "type=volume,src=${project}_proof-params,dst=/proof-params,readonly" \
  --mount "type=volume,src=${zkir_artifacts},dst=/artifacts" \
  "$zkir_image"

docker run --rm --network "${project}_warehouse" \
  --mount "type=bind,src=${zkir_fixture},dst=/fixture,readonly" \
  --mount "type=volume,src=${zkir_deps},dst=/deps" \
  "$node_image" sh -c '
    set -e
    mkdir -p /build && cp /fixture/package.json /fixture/package-lock.json /build/
    cd /build && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
    cp -a /build/node_modules/. /deps/
  '

# node_modules is mounted at / (not next to the script): the compactc-generated contract module
# lives on the artifacts volume and ESM resolution walks UP from there. Mounting the same tree
# twice would give the process two ledger wasm copies and break instanceof.
zkir_proof() {
  docker run --rm --network "${project}_offline" \
    --mount "type=volume,src=${zkir_deps},dst=/node_modules,readonly" \
    --mount "type=volume,src=${zkir_artifacts},dst=/artifacts,readonly" \
    --mount "type=bind,src=${zkir_fixture}/zkir-proof.mjs,dst=/zkir-proof.mjs,readonly" \
    --mount "type=bind,src=${work}/proofs,dst=/out" \
    -w / "$node_image" \
    node /zkir-proof.mjs --base "http://$4:6300" --artifact-root "/artifacts/$2" \
      --backend "$3" --role "$1" --expect "$5" --output "/out/zkir-proof-$1.json"
}
zkir_proof plain-zkir-v2        v2 zkir    proof-server    accept
zkir_proof experimental-zkir-v3 v3 zkir-v3 aa-proof-server accept

log "variant-distinction control: the PLAIN server must REFUSE the same ZKIR-v3 artifact"
# Same server, same harness, same contract source as the v2 case above -- only the compiler
# backend differs. Without this, "the experimental server proved a v3 circuit" would not
# establish that the v3 lane is what distinguishes the two builds.
zkir_proof plain-rejects-zkir-v3 v3 zkir-v3 proof-server reject

# rc.5 answers an unparseable IR with a generic `400 bad input`, so the CAUSE is asserted
# directly against the two executables instead of being inferred from the body.
proof_binary() {
  binary_path="$(docker image inspect "$1" --format '{{index .Config.Cmd 0}}' | awk '{print $1}')"
  container="$(docker create "$1")"
  docker cp "${container}:${binary_path}" "$2" >/dev/null
  docker rm -f "$container" >/dev/null
}
proof_binary "${PROOF_IMAGE:-docker.io/midnightntwrk/proof-server@sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9}" "$work/plain-bin"
proof_binary "${AA_PROOF_IMAGE:-docker.io/midnightntwrk/proof-server@sha256:4f02ca2734649eb238d13924df299b1c82bd5546ec928c5d67bdd0ce86dd0bd1}" "$work/experimental-bin"
count() { grep -c -F -a -- "$2" "$1" || true; }
# The IR tag is stored without the `midnight:` prefix, which the encoder adds separately.
for expectation in \
  "plain-bin:Unsupported ZKIR version:present" \
  "plain-bin:ir-source[v3-generic]:absent" \
  "plain-bin:zkir-v3/src:absent" \
  "plain-bin:ir-source[v2]:present" \
  "experimental-bin:Unsupported ZKIR version:absent" \
  "experimental-bin:ir-source[v3-generic]:present" \
  "experimental-bin:zkir-v3/src:present" \
  "experimental-bin:ir-source[v2]:present"
do
  binary="${expectation%%:*}"; rest="${expectation#*:}"
  needle="${rest%:*}"; want="${rest##*:}"
  found="$(count "$work/$binary" "$needle")"
  printf '[gate] %-16s %-34s %s occurrence(s), expected %s\n' "$binary" "$needle" "$found" "$want"
  case "$want" in
    present) [ "$found" -ge 1 ] || { printf '[gate] FAIL: %s lacks %s\n' "$binary" "$needle" >&2; exit 1; } ;;
    absent)  [ "$found" -eq 0 ] || { printf '[gate] FAIL: %s unexpectedly carries %s\n' "$binary" "$needle" >&2; exit 1; } ;;
  esac
done
printf '[gate] ZKIR lanes confirmed: only the experimental build parses ir-source[v3-generic]\n'

log "neither real proof triggered an origin request, and neither mutated the generation"
for service in proof-server aa-proof-server; do
  reader_log="$(docker logs "${project}-${service}-1" 2>&1)"
  if grep -Eq 'Missing zero-knowledge proving key|Attempting to download|srs\.midnight\.network' <<<"$reader_log"; then
    printf '[gate] FAIL: %s attempted a covered-data origin fetch while proving\n' "$service" >&2
    exit 1
  fi
  grep -q 'POST /prove' <<<"$reader_log" \
    || { printf '[gate] FAIL: %s never served a /prove request\n' "$service" >&2; exit 1; }
done

docker run --rm --entrypoint python3 \
  --mount "type=volume,src=${project}_proof-params,dst=/proof-params,readonly" \
  --mount "type=bind,src=${component}/manifests,dst=/m,readonly" "$image" -c '
import json, sys
from pathlib import Path
sys.path.insert(0, "/opt/proof-params/bootstrap")
from forge_io import canonical_bytes
import proof_cache_bootstrap as bootstrap
admission = json.load(open("/m/q8b-cache-admission-v1.json"))
Path("/tmp/content.json").write_bytes(canonical_bytes(admission["contentManifest"]))
print("generation still byte-exact after all five proof attempts (2 Zswap + 3 contract-circuit):",
      bootstrap.verify_active(Path("/tmp/content.json"), Path("/m/q8b-cache-admission-v1.json"),
                              admission["expectedCombinedManifestSha256"], Path("/proof-params")))
'

log "corruption / interruption / concurrency / resolver negatives"
gate_output="${output:-$work/cache-gate-result.json}"
python3 "$here/cache_gate.py" --project "$project" --image "$image" --work-dir "$work/gate" --output "$gate_output"

printf '\n[gate] PASS — results written to %s\n' "$gate_output"
