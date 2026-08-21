#!/usr/bin/env bash
#
# Bring up the demo stack and block until every service is actually usable.
#
# "Actually usable" is stricter than "docker says healthy":
#   node          RPC answers chain_getBlockHash[1]  → the chain is producing blocks
#   indexer       GraphQL v4 answers a block query   → the API is serving, not just booting
#   proof-server  the port accepts a TCP connection  → nothing inside the image can probe it
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

PROFILES=""
DO_PULL=0
DO_BUILD=0

usage() {
  cat <<'EOF'
Usage: ./up.sh [options]

Brings up the core Midnight stack (node + indexer + proof-server) and waits until all
three are serving. Reads .env for image tags and host ports (see .env.example).

Options:
  --with <profile>   also bring up an optional profile; repeatable.
                     Profiles: evm (Phase 3), offerfiles (Phase 4), frontend (Phase 5).
  --all              bring up every profile that exists in compose/.
  --pull             docker compose pull before starting.
  --build            docker compose build before starting (for the locally-built images).
  -h, --help         this text.

Environment:
  ENV_FILE=<path>    use a different env file than ./.env — this is how two stacks run
                     side by side on one machine:
                        ENV_FILE=.env.test ./up.sh

Examples:
  ./up.sh                       # core stack only
  ./up.sh --with evm            # core + umbra-evm
  ENV_FILE=.env.ci ./up.sh      # a second, port-shifted instance
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with)   PROFILES="$PROFILES ${2:?--with needs a profile name}"; shift 2 ;;
    --with=*) PROFILES="$PROFILES ${1#*=}"; shift ;;
    --all)
      for f in "$REPO_ROOT"/compose/*.yml; do
        b="$(basename "$f" .yml)"
        [[ "$b" == "core" ]] && continue
        PROFILES="$PROFILES $b"
      done
      shift ;;
    --pull)  DO_PULL=1; shift ;;
    --build) DO_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
done

export PROFILES
require_docker
load_env

log "demo stack: project '${COMPOSE_PROJECT_NAME}'"
info "images   node=${NODE_TAG}  indexer=${INDEXER_TAG} (${INDEXER_PLATFORM})  proof=${PROOF_TAG}"
info "ports    node=${HOST_ADDR}:${NODE_HOST_PORT}  indexer=${HOST_ADDR}:${INDEXER_HOST_PORT}  proof=${HOST_ADDR}:${PROOF_HOST_PORT}"
[[ -n "${PROFILES// /}" ]] && info "profiles core${PROFILES// /, }"

# Pre-create the toolkit cache directory that compose bind-mounts into the `fund` service.
# Letting docker create a missing bind-mount source races with the first container that
# writes there: the toolkit's redb cache creation then fails with
# `failed to create database: Storage(Io(… NotFound …))`.
mkdir -p "$REPO_ROOT/.cache/${COMPOSE_PROJECT_NAME}"

if (( DO_PULL )); then
  log "pulling images"
  dc pull
fi
if (( DO_BUILD )); then
  log "building local images"
  dc build
fi

log "starting containers"
dc up -d --remove-orphans

FAILED=0

log "waiting for services"
# Node first: the indexer cannot make progress before the chain produces blocks, and a
# node failure is the cheapest one to diagnose.
wait_compose_healthy node "$NODE_WAIT_TIMEOUT" || FAILED=1
if (( ! FAILED )); then
  wait_node_rpc "$NODE_RPC_URL" "$NODE_WAIT_TIMEOUT" || FAILED=1
fi
if (( ! FAILED )); then
  # Answering RPC is not the same as being transactable. Until finality moves off genesis
  # the toolkit refuses to build anything —
  # `GetTransactions(NodeClientError(OnlyGenesisFinalized))` — so a funding run started
  # right after up.sh would fail. Gate on it here, once, instead of making every consumer
  # rediscover it.
  wait_finalized_height "$NODE_RPC_URL" 1 "$NODE_WAIT_TIMEOUT" || FAILED=1
fi

if (( ! FAILED )); then
  # The proof-server is independent of the chain, so probe it while the indexer catches up.
  wait_tcp "$HOST_ADDR" "$PROOF_HOST_PORT" "proof-server" "$PROOF_WAIT_TIMEOUT" || FAILED=1
fi

if (( ! FAILED )); then
  wait_compose_healthy indexer "$INDEXER_WAIT_TIMEOUT" || FAILED=1
fi
if (( ! FAILED )); then
  wait_indexer_graphql "$INDEXER_GQL_URL" "$INDEXER_WAIT_TIMEOUT" || FAILED=1
fi

if (( FAILED )); then
  echo
  err "stack did not come up. Last 40 log lines per service:"
  dc logs --tail=40 || true
  echo
  info "the stack is left running for inspection — './down.sh' to stop it"
  exit 1
fi

echo
log "stack is up"
info "node RPC          ${NODE_RPC_URL}"
info "indexer GraphQL   ${INDEXER_GQL_URL}"
info "indexer GraphQL WS ws://${HOST_ADDR}:${INDEXER_HOST_PORT}/api/v4/graphql/ws"
info "proof server      http://${HOST_ADDR}:${PROOF_HOST_PORT}"
echo
info "next: ./verify.sh    (health + prefunded wallet assertions)"
info "      ./down.sh -v   (stop and wipe all chain/indexer state)"
