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
  : "${NODE_TAG:=2.0.0-rc.4}"
  : "${INDEXER_TAG:=4.4.0-rc.1}"
  : "${PROOF_TAG:=9.0.0-rc.5}"
  : "${TOOLKIT_TAG:=$NODE_TAG}"
  : "${INDEXER_PLATFORM:=linux/amd64}"
  : "${BIND_ADDR:=127.0.0.1}"
  : "${NODE_HOST_PORT:=9944}"
  : "${INDEXER_HOST_PORT:=8088}"
  : "${PROOF_HOST_PORT:=6300}"
  : "${NODE_WAIT_TIMEOUT:=180}"
  : "${INDEXER_WAIT_TIMEOUT:=420}"
  : "${PROOF_WAIT_TIMEOUT:=120}"
  export COMPOSE_PROJECT_NAME NODE_TAG INDEXER_TAG PROOF_TAG TOOLKIT_TAG \
         INDEXER_PLATFORM BIND_ADDR NODE_HOST_PORT INDEXER_HOST_PORT PROOF_HOST_PORT \
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
# has not built yet. Listing them is not cosmetic: without it `--with offerfiles` reads as
# a typo, and `--all` looks like it brought up the whole four-component demo when it
# brought up half of it.
KNOWN_FUTURE_PROFILES="offerfiles frontend"
FUTURE_PROFILES_BLOCKER="the Effectstream ledger-v9 migration (project 00016)"

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

dc() {
  local files=()
  while IFS= read -r f; do files+=("$f"); done < <(compose_files)
  local env_args=()
  [[ -f "${ENV_FILE:-}" ]] && env_args=(--env-file "$ENV_FILE")
  docker compose "${env_args[@]}" "${files[@]}" -p "$COMPOSE_PROJECT_NAME" "$@"
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
