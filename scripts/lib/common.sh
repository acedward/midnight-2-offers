# shellcheck shell=bash
#
# Shared helpers for the demo-stack scripts: env loading, compose invocation, and the
# health waits. Sourced, never executed.
#
# The wait helpers follow $HOME/midnight-ref-ai/matrix/run-slot.sh (wait_node_rpc /
# wait_tcp / wait_docker_healthy) and
# $HOME/midnight-ref-ai/v2.0.0-rc.4/midnight-node/scripts/tests/lib/wait-for-node.sh
# (chain_getFinalizedHead → chain_getHeader polling).

# REPO_ROOT is set by the caller before sourcing; derive it if not.
: "${REPO_ROOT:="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"}"

# ── output ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_DIM=""
fi

log()  { printf '%s\n' "${C_BOLD}==>${C_RESET} $*"; }
info() { printf '%s\n' "    $*"; }
dim()  { printf '%s\n' "${C_DIM}    $*${C_RESET}"; }
ok()   { printf '%s\n' "    ${C_GREEN}OK${C_RESET}   $*"; }
warn() { printf '%s\n' "    ${C_YELLOW}WARN${C_RESET} $*"; }
err()  { printf '%s\n' "    ${C_RED}FAIL${C_RESET} $*" >&2; }
die()  { err "$*"; exit 1; }

# ── immutable image references ───────────────────────────────────────────────
#
# require_digest_ref VAR… — each named variable must hold a COMPLETE immutable image
# reference, `<repository>@sha256:<64 hex>`.
#
# A tag is not an identity. `midnightntwrk/proof-server:9.0.0-rc.5` can be repointed at
# different bytes at any moment without anything in this repository changing, which is
# exactly the failure the artifact-decision matrix exists to prevent. So an override that
# supplies a tag is REJECTED rather than quietly accepted as a weaker pin: there is no
# digest→tag fallback anywhere in this stack.
# It REPORTS rather than exits, and `assert_image_pins` below is what makes it fatal. The
# split is deliberate: a bad pin must never be able to strand a running stack, so `down.sh`
# and the read-only verify scripts still work while every path that STARTS something fails
# hard. Teardown does not depend on image identity; starting does.
require_digest_ref() {
  local var val bad=0
  for var in "$@"; do
    val="${!var-}"
    if [[ ! "$val" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
      err "${var} is not a complete immutable image reference"
      info "  got:      ${val:-<empty>}"
      info "  expected: <repository>@sha256:<64 hex>"
      bad=1
    fi
  done
  return "$bad"
}

# assert_image_pins — the fatal form, for anything that is about to start containers.
# load_env() only warns; up.sh calls this.
assert_image_pins() {
  require_digest_ref NODE_IMAGE TOOLKIT_IMAGE PROOF_IMAGE AA_PROOF_IMAGE \
    || die "external runtime images are pinned by digest only — see docs/ARTIFACT-DECISIONS.md"
  if [[ "${PROOF_IMAGE:-}" == "${AA_PROOF_IMAGE:-}" ]]; then
    die "PROOF_IMAGE and AA_PROOF_IMAGE resolve to the same image — plain and experimental are different programs and must stay separately pinned"
  fi
  if [[ ! "${PROOF_DATA_GENERATION:-}" =~ ^[0-9a-f]{64}$ ]]; then
    die "PROOF_DATA_GENERATION must be the 64-hex content digest of a proof-data generation (got: ${PROOF_DATA_GENERATION:-<empty>})"
  fi
  return 0
}

# ── env ──────────────────────────────────────────────────────────────────────
# Loads .env (or $ENV_FILE) into the environment, then applies the defaults so every
# variable the scripts read is always set. Values already exported win over the file,
# which lets a caller do `NODE_HOST_PORT=12345 ./up.sh` for a one-off.
load_env() {
  ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

  if [[ -f "$ENV_FILE" ]]; then
    # Parsed rather than sourced: the file is plain KEY=value (docker compose's own
    # dialect), and sourcing it would let a stray backtick or $(…) in a value execute.
    # A key already present in the environment wins over the file, so a one-off override
    # works: NODE_HOST_PORT=12345 ./up.sh
    local line key val
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[[:space:]]*$ ]] && continue
      [[ "$line" != *=* ]] && continue
      key="${line%%=*}"; key="${key//[[:space:]]/}"
      val="${line#*=}"
      # Strip one layer of matching quotes, as compose does.
      [[ "$val" == \"*\" ]] && val="${val:1:${#val}-2}"
      [[ "$val" == \'*\' ]] && val="${val:1:${#val}-2}"
      [[ -n "${!key+x}" ]] && continue
      export "$key=$val"
    done < "$ENV_FILE"
  else
    warn "no $ENV_FILE — using built-in defaults (cp .env.example .env to customize)"
  fi

  : "${COMPOSE_PROJECT_NAME:=demo-infra}"

  # ── RETIRED CONTROLS ───────────────────────────────────────────────────────
  # Say so out loud. A `.env` carried over from before this refactor still sets some of
  # these, and a control that is silently ignored is worse than one that is gone: the
  # operator believes they changed the image or the platform and they did not.
  local retired
  for retired in NODE_TAG PROOF_TAG TOOLKIT_TAG AA_PROOF_TAG; do
    if [[ -n "${!retired-}" ]]; then
      warn "${retired} is RETIRED and IGNORED — set ${retired%_TAG}_IMAGE to a full <repo>@sha256:… reference instead"
    fi
  done
  for retired in INDEXER_PLATFORM INDEXER_REPO INDEXER_REF INDEXER_RUST_VERSION; do
    if [[ -n "${!retired-}" ]]; then
      warn "${retired} is RETIRED and IGNORED — the indexer installs a published warehouse binary and is never compiled or platform-forced"
    fi
  done

  # ── external runtime images: repository + IMMUTABLE DIGEST, never a tag ─────
  # Node and toolkit are the good official multiarch images, kept as-is. Both proof-server
  # variants come from the Effectstream GHCR mirror, which Phase 1 proved byte-identical to
  # the upstream Docker Hub indexes. All four are complete linux/amd64 + linux/arm64
  # indexes, so the same reference resolves natively on Intel and Apple Silicon.
  : "${NODE_IMAGE:=docker.io/midnightntwrk/midnight-node@sha256:caf93d6f9fb3630c906ef3e714c151655377f3d28f907d17545de1870514da2e}"
  : "${TOOLKIT_IMAGE:=docker.io/midnightntwrk/midnight-node-toolkit@sha256:c3efb50d483b1216e9582669038dc6d2fac509b33d11ebc0b4e0d0d0b86b4d0f}"
  : "${PROOF_IMAGE:=ghcr.io/effectstream/midnight-proof-server@sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9}"
  : "${AA_PROOF_IMAGE:=ghcr.io/effectstream/midnight-proof-server@sha256:4f02ca2734649eb238d13924df299b1c82bd5546ec928c5d67bdd0ce86dd0bd1}"
  # Reported here, made fatal by assert_image_pins() in whatever is about to start
  # containers — so a bad override cannot stop `./down.sh` from cleaning up.
  require_digest_ref NODE_IMAGE TOOLKIT_IMAGE PROOF_IMAGE AA_PROOF_IMAGE \
    || warn "external runtime images must be digest-pinned; ./up.sh will refuse to start until this is fixed"
  if [[ "$PROOF_IMAGE" == "$AA_PROOF_IMAGE" ]]; then
    warn "PROOF_IMAGE and AA_PROOF_IMAGE are the same image — plain and experimental are different programs; ./up.sh will refuse to start"
  fi

  # READABLE VERSION LABELS, display only. Nothing resolves an image from these; they exist
  # so logs and the toolkit/node compatibility check can say "2.0.0-rc.4" instead of a
  # 64-character hash. Identity is the digest above, and only the digest.
  : "${NODE_VERSION:=2.0.0-rc.4}"
  : "${TOOLKIT_VERSION:=2.0.0-rc.4}"
  : "${PROOF_VERSION:=9.0.0-rc.5}"

  # ── shared proof-data cache ────────────────────────────────────────────────
  # One verified immutable generation, populated once by the proof-params-init one-shot and
  # mounted read-only by both proof-server variants. The digest names the generation and is
  # both a build arg and a runtime expectation, so there is one reviewable value.
  : "${PROOF_PARAMS_IMAGE:=midnight-2-offers/proof-params:local}"
  : "${PROOF_DATA_GENERATION:=b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c}"
  if [[ ! "$PROOF_DATA_GENERATION" =~ ^[0-9a-f]{64}$ ]]; then
    warn "PROOF_DATA_GENERATION is not a 64-hex content digest (${PROOF_DATA_GENERATION}); ./up.sh will refuse to start"
  fi

  # The indexer is no longer compiled from source, so there is no INDEXER_REF to fetch and
  # no INDEXER_PLATFORM to force: the exact 4.4.0-rc.3 executable is downloaded from the
  # warehouse for the building machine's own architecture. The upstream source commit
  # survives as provenance only, baked into the image and asserted by
  # scripts/verify-source-pins.sh against config/artifact-decisions.json.
  : "${WAREHOUSE_REPO:=effectstream/binaries}"
  : "${WAREHOUSE_RELEASE:=0.3.120}"
  : "${INDEXER_VERSION:=4.4.0-rc.3}"
  : "${BIND_ADDR:=127.0.0.1}"
  : "${NODE_HOST_PORT:=9944}"
  : "${INDEXER_HOST_PORT:=8088}"
  : "${PROOF_HOST_PORT:=6300}"
  : "${NODE_WAIT_TIMEOUT:=180}"
  : "${INDEXER_WAIT_TIMEOUT:=420}"
  : "${PROOF_WAIT_TIMEOUT:=120}"
  export COMPOSE_PROJECT_NAME \
         NODE_IMAGE TOOLKIT_IMAGE PROOF_IMAGE AA_PROOF_IMAGE \
         NODE_VERSION TOOLKIT_VERSION PROOF_VERSION \
         PROOF_PARAMS_IMAGE PROOF_DATA_GENERATION \
         WAREHOUSE_REPO WAREHOUSE_RELEASE INDEXER_VERSION \
         BIND_ADDR NODE_HOST_PORT INDEXER_HOST_PORT PROOF_HOST_PORT \
         NODE_WAIT_TIMEOUT INDEXER_WAIT_TIMEOUT PROOF_WAIT_TIMEOUT

  # A host address the scripts can actually connect to. BIND_ADDR may be 0.0.0.0, which
  # is a valid bind target but not a valid connect target.
  HOST_ADDR="$BIND_ADDR"
  [[ "$HOST_ADDR" == "0.0.0.0" || -z "$HOST_ADDR" ]] && HOST_ADDR="127.0.0.1"
  export HOST_ADDR

  NODE_RPC_URL="http://${HOST_ADDR}:${NODE_HOST_PORT}"
  INDEXER_GQL_URL="http://${HOST_ADDR}:${INDEXER_HOST_PORT}/api/v4/graphql"
  export NODE_RPC_URL INDEXER_GQL_URL
}

# ── profiles ─────────────────────────────────────────────────────────────────
#
# A profile IS the basename of a compose fragment: `--with evm` adds compose/evm.yml.
# No compose `profiles:` key is involved — `up.sh` never passes `--profile`, so a service
# carrying one would never start. (compose/core.yml's `fund` service has one on purpose:
# it must NOT start with `up -d`.)
#
# KNOWN_FUTURE_PROFILES are profiles this stack reserves ports and documentation for but
# has not built yet. Listing them is not cosmetic: without it `--with frontend` reads as
# a typo, and `--all` looks like it brought up the whole four-component demo when it
# brought up part of it.
#
# `offerfiles` left this list when compose/offerfiles.yml landed, and `frontend` left it when
# compose/frontend.yml landed (P5, 2026-08-25). The list is now empty; keep the variable (and
# the machinery reading it) for the next reserved-but-unbuilt profile.
KNOWN_FUTURE_PROFILES=""
FUTURE_PROFILES_BLOCKER=""

# PARTIAL_PROFILES have a fragment — so `--with` accepts them and `--all` includes them — but do
# not yet contain every service the finished profile will. Empty since P4b landed the kernel +
# batcher in `offerfiles` and P5 landed `frontend` (2026-08-25). Keep the machinery: the note is
# how a half-built profile says "half-built on purpose" instead of reading as broken.
PARTIAL_PROFILES=""
partial_profile_note() {
  case "$1" in
    *) return 1 ;;
  esac
}

# available_profiles — every profile that has a fragment today, one per line.
# `core` is excluded: it is unconditional, not opt-in.
available_profiles() {
  local f b
  for f in "$REPO_ROOT"/compose/*.yml; do
    [[ -e "$f" ]] || continue
    b="$(basename "$f" .yml)"
    [[ "$b" == "core" ]] && continue
    printf '%s\n' "$b"
  done
}

# pending_profiles — the known-but-unbuilt ones, i.e. KNOWN_FUTURE_PROFILES minus any
# that have since gained a fragment. Prints nothing once they all land, so the "coming
# later" messages disappear on their own rather than having to be hunted down.
pending_profiles() {
  local p
  for p in $KNOWN_FUTURE_PROFILES; do
    [[ -f "$REPO_ROOT/compose/$p.yml" ]] || printf '%s\n' "$p"
  done
}

# ── which profiles are ALREADY UP ────────────────────────────────────────────
#
# `up.sh --with <profile>` is ADDITIVE: it must not stop a profile that is already running
# (question Q12 — `--remove-orphans` used to do exactly that, and it stopped the whole evm
# stack during T4.4's testing). To be additive, up.sh has to answer "which profiles have
# containers in this compose project right now", and that means mapping a container's compose
# SERVICE label back to the fragment that declares it.
#
# The mapping is asked of compose itself rather than parsed out of the YAML, because a fragment
# cannot be validated on its own — `docker compose -f compose/evm.yml config` fails with
# `service "evm-rpc" depends on undefined service "indexer"`, since indexer lives in core.yml.
# So each fragment is read TOGETHER with core.yml and core's own services are subtracted.

_CORE_SERVICES_CACHE=""
core_services() {
  if [[ -z "$_CORE_SERVICES_CACHE" ]]; then
    _CORE_SERVICES_CACHE="$(docker compose -f "$REPO_ROOT/compose/core.yml" config --services 2>/dev/null | sort)"
  fi
  printf '%s\n' "$_CORE_SERVICES_CACHE"
}

# profile_services <profile> — the services a fragment adds on top of core.yml, one per line.
profile_services() {
  local p="$1" all
  [[ -f "$REPO_ROOT/compose/$p.yml" ]] || return 0
  all="$(docker compose -f "$REPO_ROOT/compose/core.yml" -f "$REPO_ROOT/compose/$p.yml" \
           config --services 2>/dev/null | sort)"
  [[ -n "$all" ]] || return 0
  comm -13 <(core_services) <(printf '%s\n' "$all")
}

# project_services — the compose service name of every container of this project, running or not.
# Stopped ones count: `up` would restart them, so a profile that is merely paused is still "up"
# as far as "do not silently remove it" is concerned.
project_services() {
  docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null | sort -u
}

# running_profiles — every profile that has at least one container in this compose project.
#
# A container whose service is declared by NO fragment (a service deleted from a fragment since
# it was started) deliberately maps to nothing, so it stays an orphan and `--remove-orphans`
# still cleans it up. That is the one job `--remove-orphans` was actually there for.
running_profiles() {
  local svcs p s
  svcs="$(project_services)"
  [[ -n "${svcs//[[:space:]]/}" ]] || return 0
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    while IFS= read -r s; do
      [[ -n "$s" ]] || continue
      if printf '%s\n' "$svcs" | grep -Fxq -- "$s"; then
        printf '%s\n' "$p"
        break
      fi
    done < <(profile_services "$p")
  done < <(available_profiles)
}

# use_all_profiles — set PROFILES to every profile that has a fragment.
#
# For a script that only needs to reach ONE service. `dc` passes exactly the fragments named in
# PROFILES, and compose calls any container it has no definition for an ORPHAN — so a script that
# names only its own profile prints "Found orphan containers (…)" on every `run`/`exec` as soon as
# a second profile exists. Naming every fragment (which is what down.sh already does, for the
# stronger reason that a narrower list would orphan them for real) removes the warning and keeps
# these scripts correct as more profiles land.
use_all_profiles() {
  local p
  PROFILES=""
  while IFS= read -r p; do PROFILES="$PROFILES $p"; done < <(available_profiles)
  export PROFILES
}

# ── compose ──────────────────────────────────────────────────────────────────
# The compose fragments for the requested profiles. `core` is unconditional.
# PROFILES is a space-separated list set by the caller (up.sh --with evm …).
compose_files() {
  local files=("-f" "$REPO_ROOT/compose/core.yml")
  local p
  for p in ${PROFILES:-}; do
    [[ -f "$REPO_ROOT/compose/$p.yml" ]] && files+=("-f" "$REPO_ROOT/compose/$p.yml")
  done
  printf '%s\n' "${files[@]}"
}

# ${arr[@]+"${arr[@]}"}, not "${arr[@]}", for any array that can be EMPTY here.
# macOS ships bash 3.2, where expanding an empty array as "${arr[@]}" under `set -u` is an
# "unbound variable" error; bash 4.4+ (every Linux host this repo is developed on) treats it
# as zero words, so no Linux gate can see the difference. `env_args` is empty on the ordinary
# clean-clone path — no .env file — which is exactly where this used to abort.
dc() {
  local files=()
  while IFS= read -r f; do files+=("$f"); done < <(compose_files)
  local env_args=()
  [[ -f "${ENV_FILE:-}" ]] && env_args=(--env-file "$ENV_FILE")
  docker compose ${env_args[@]+"${env_args[@]}"} ${files[@]+"${files[@]}"} \
    -p "$COMPOSE_PROJECT_NAME" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 not available"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable"
}

# ── waits ────────────────────────────────────────────────────────────────────

# wait_tcp <host> <port> <label> [timeout_secs]
# For services that cannot be probed from inside the container (proof-server has no
# curl/wget and its bash sits behind an unstable /nix/store path).
wait_tcp() {
  local host="$1" port="$2" label="$3" secs="${4:-120}"
  local deadline=$(( SECONDS + secs ))
  info "waiting for $label on $host:$port (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    if command -v nc >/dev/null 2>&1; then
      nc -z "$host" "$port" >/dev/null 2>&1 && { ok "$label listening"; return 0; }
    else
      # bash's /dev/tcp needs no external binary.
      (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 && { ok "$label listening"; return 0; }
    fi
    sleep 2
  done
  err "timeout waiting for $label on $host:$port"
  return 1
}

# wait_node_rpc <rpc_url> [timeout_secs]
# Block #1 exists only once the chain produces blocks, so this is readiness, not liveness.
wait_node_rpc() {
  local url="$1" secs="${2:-180}"
  local deadline=$(( SECONDS + secs ))
  info "waiting for node RPC at $url (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    if curl -sf --max-time 5 -H 'Content-Type: application/json' \
         -d '{"id":1,"jsonrpc":"2.0","method":"chain_getBlockHash","params":[1]}' \
         "$url" 2>/dev/null | grep -q '"result":"0x'; then
      ok "node RPC answering (block #1 exists)"
      return 0
    fi
    sleep 2
  done
  err "timeout waiting for node RPC at $url"
  return 1
}

# wait_compose_healthy <service> [timeout_secs]
# Fast-fails the moment docker reports the container unhealthy rather than burning the
# whole timeout.
wait_compose_healthy() {
  local service="$1" secs="${2:-300}"
  local deadline=$(( SECONDS + secs ))
  info "waiting for compose service '$service' to report healthy (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    local cid health state
    cid=$(docker ps -aq \
      --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      --filter "label=com.docker.compose.service=$service" 2>/dev/null | head -1)
    if [[ -n "$cid" ]]; then
      state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo "")
      health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "")
      [[ "$health" == "healthy" ]] && { ok "$service healthy"; return 0; }
      if [[ "$health" == "unhealthy" ]]; then
        err "$service reported UNHEALTHY"
        return 1
      fi
      if [[ "$state" == "exited" || "$state" == "dead" ]]; then
        err "$service container $state before becoming healthy"
        return 1
      fi
    fi
    sleep 3
  done
  err "timeout waiting for $service to become healthy"
  return 1
}

# ── chain / indexer queries ──────────────────────────────────────────────────

# node_best_height <rpc_url> — prints the best-chain height in decimal, or nothing.
node_best_height() {
  local hex
  hex=$(curl -sf --max-time 5 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"chain_getHeader","params":[],"id":1}' "$1" 2>/dev/null \
    | grep -oE '"number"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]+"' \
    | grep -oE '0x[0-9a-fA-F]+' | head -1 || true)
  [[ -n "$hex" ]] && echo "$((hex))"
}

# node_finalized_height <rpc_url> — prints the GRANDPA-finalized height in decimal.
node_finalized_height() {
  local url="$1" hash hex
  hash=$(curl -sf --max-time 5 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"chain_getFinalizedHead","params":[],"id":1}' "$url" 2>/dev/null \
    | grep -oE '"result"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]+"' \
    | grep -oE '0x[0-9a-fA-F]+' | head -1 || true)
  [[ -z "$hash" ]] && return 0
  hex=$(curl -sf --max-time 5 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"chain_getHeader\",\"params\":[\"${hash}\"],\"id\":1}" "$url" 2>/dev/null \
    | grep -oE '"number"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]+"' \
    | grep -oE '0x[0-9a-fA-F]+' | head -1 || true)
  [[ -n "$hex" ]] && echo "$((hex))"
}

# wait_finalized_height <rpc_url> <min_height> [timeout_secs]
#
# Waits until at least <min_height> blocks are FINALIZED, not merely produced.
#
# This is the gate anything that builds a transaction needs. The node answers RPC and has a
# best block long before finality moves off genesis, and in that window the toolkit refuses
# to work: `GetTransactions(NodeClientError(OnlyGenesisFinalized))`. `up.sh` therefore waits
# for finalized >= 1 before declaring the stack up, so a funding run started immediately
# afterwards does not hit it.
wait_finalized_height() {
  local url="$1" min="$2" secs="${3:-180}"
  local deadline=$(( SECONDS + secs ))
  local cur=""
  info "waiting for finalized height >= ${min} (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    cur=$(node_finalized_height "$url")
    if [[ -n "$cur" ]] && (( cur >= min )); then
      ok "finalized height ${cur} >= ${min}"
      return 0
    fi
    sleep 2
  done
  err "finalized height did not reach ${min} within ${secs}s (last seen: ${cur:-none})"
  return 1
}

# wait_finalized_advances <rpc_url> [timeout_secs]
# Asserts finality is actually moving, not merely that a finalized head exists — a stalled
# GRANDPA still answers chain_getFinalizedHead with the same hash forever.
wait_finalized_advances() {
  local url="$1" secs="${2:-180}"
  local deadline=$(( SECONDS + secs ))
  local first="" cur=""
  info "waiting for finality to advance at $url (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    cur=$(node_finalized_height "$url")
    if [[ -n "$cur" ]]; then
      if [[ -z "$first" ]]; then
        first="$cur"
        dim "finalized height starts at $first"
      elif (( cur > first )); then
        ok "finality advanced $first → $cur"
        return 0
      fi
    fi
    sleep 3
  done
  err "finality did not advance within ${secs}s (last seen: ${cur:-none})"
  return 1
}

# graphql <url> <query> — POSTs a GraphQL query, prints the raw response body.
graphql() {
  curl -sf --max-time 15 -H 'Content-Type: application/json' \
    -d "{\"query\":$(json_string "$2")}" "$1" 2>/dev/null
}

# json_string <text> — minimal JSON string encoder (no jq dependency).
json_string() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# wait_indexer_graphql <gql_url> [timeout_secs]
# Real indexer readiness: the container healthcheck only proves its supervisor is alive
# (entrypoint.sh touches the running-file BEFORE launching indexer-standalone), so the API
# must be queried from the host.
wait_indexer_graphql() {
  local url="$1" secs="${2:-420}"
  local deadline=$(( SECONDS + secs ))
  info "waiting for indexer GraphQL v4 at $url (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    local body
    body=$(graphql "$url" '{ block { height hash } }' || true)
    if [[ -n "$body" && "$body" == *'"height"'* ]]; then
      ok "indexer GraphQL answering"
      return 0
    fi
    sleep 3
  done
  err "timeout waiting for indexer GraphQL at $url"
  return 1
}

# indexer_height <gql_url> — prints the indexer's latest known block height.
indexer_height() {
  graphql "$1" '{ block { height } }' \
    | grep -oE '"height"[[:space:]]*:[[:space:]]*[0-9]+' \
    | grep -oE '[0-9]+' | head -1
}

# ── one-shot HTTP reads that can lose a startup race ─────────────────────────
#
# A single `curl … | grep -q` is a coin flip against a server that is UP but momentarily busy.
# Measured (00015 P5, infra issue 00016): `curl -fsS --max-time 10 "$CONSOLE_URL/" | grep -q
# "AA Console"` failed exactly once while every other assertion in the same verify run passed,
# including `/api/info` seconds earlier and a manual `curl` 26 s later that returned 200 and
# 30 352 bytes of the very page the check greps for. The aa-console is a single-threaded Bun
# process, so a wallet sync can hold its HTTP loop past a 10 s budget — which is a slow page,
# not a broken one, and a verify gate must be able to tell those apart.
#
# The jitter is the load-bearing half, for the same reason it is in the genesis-funding
# retries (00010 Q20): several clients hit the same starting process at once, so a fixed
# schedule just re-collides.
#
# curl_retry_match <url> <extended-regex> <label> [tries] [curl_max_time]
#   Prints the FIRST matching body on stdout and returns 0. On give-up returns 1, having
#   reported the last HTTP status, the last curl exit code and the head of the last body on
#   stderr. Diagnostics all go to stderr so the body can be captured with `$( )`.
curl_retry_match() {
  local url="$1" pattern="$2" label="$3"
  local tries="${4:-${HTTP_MATCH_TRIES:-4}}" max_time="${5:-${HTTP_MATCH_MAX_TIME:-10}}"
  local base="${HTTP_MATCH_RETRY_S:-2}" cap="${HTTP_MATCH_RETRY_MAX_S:-8}"
  local jitter="${HTTP_MATCH_JITTER_S:-3}"
  local try resp body status code delay
  for (( try = 1; try <= tries; try++ )); do
    # No `-f`: the BODY of a non-2xx answer is what says whether the server is starting or
    # broken, and `-f` throws it away. The status is appended on its own last line instead,
    # so the give-up message can name both.
    code=0
    resp="$(curl -sS -w $'\n%{http_code}' --max-time "$max_time" "$url" 2>/dev/null)" || code=$?
    status="${resp##*$'\n'}"
    body="${resp%$'\n'*}"
    if [[ "$status" == 2* ]] && printf '%s' "$body" | grep -qE "$pattern"; then
      if (( try > 1 )); then dim "$label: matched on attempt ${try}/${tries}" >&2; fi
      printf '%s' "$body"
      return 0
    fi
    if (( try < tries )); then
      delay=$(( base * (1 << (try - 1)) ))
      (( delay > cap )) && delay=$cap
      delay=$(( delay + RANDOM % (jitter + 1) ))
      dim "$label: no match yet (attempt ${try}/${tries}, HTTP ${status}, curl exit ${code}) — retrying in ${delay}s" >&2
      sleep "$delay"
    fi
  done
  err "$label: no match after ${tries} attempts (last HTTP ${status}, curl exit ${code}, last body: $(printf '%s' "${body}" | tr '\n' ' ' | cut -c1-120))" >&2
  return 1
}
