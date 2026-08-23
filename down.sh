#!/usr/bin/env bash
#
# Tear down the demo stack.
#
#   ./down.sh       stop and remove containers/networks, KEEP the chain + indexer volumes
#   ./down.sh -v    also wipe every volume of this compose project (full reset)
#
# The -v form wipes the node volume and the indexer volume TOGETHER, and that is not a
# convenience — it is a correctness requirement. A ledger v8→v9 chain cannot be upgraded
# in place, so a fresh node genesis paired with a surviving indexer db gives you an indexer
# serving data for a chain that no longer exists (and, on a genuine version change, one
# that refuses to sync at all). Same reasoning extends to the umbra-evm Postgres volume
# and the kernel/Celestia volumes once those profiles land.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

WIPE=0
PROFILES=""

usage() {
  cat <<'EOF'
Usage: ./down.sh [-v] [options]

Stops the demo stack. Without -v the chain and indexer data survive, so the next ./up.sh
resumes the same chain. With -v everything is wiped and the next ./up.sh starts a brand
new genesis.

Options:
  -v, --volumes   also remove all volumes of this compose project (FULL RESET)
  --all           accepted for symmetry with up.sh, but it changes nothing: down.sh ALWAYS
                  passes every fragment in compose/, so a profile brought up earlier can
                  never be orphaned by forgetting to name it here
  -h, --help      this text

Environment:
  ENV_FILE=<path> tear down the stack described by a different env file (i.e. a different
                  COMPOSE_PROJECT_NAME) — this is how one of two side-by-side stacks is
                  removed without touching the other.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--volumes) WIPE=1; shift ;;
    --all) shift ;;   # no-op: the loop below already includes every fragment
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
done

# Always tear down every profile whose fragment exists: `docker compose down` only removes
# what the given -f files declare, so a narrower file list would orphan the containers of a
# profile that was brought up earlier. This is why `--all` is redundant here — and why it is
# still accepted, rather than being an error someone has to discover mid-teardown.
while IFS= read -r p; do
  [[ " $PROFILES " == *" $p "* ]] || PROFILES="$PROFILES $p"
done < <(available_profiles)
export PROFILES

require_docker
load_env

if (( WIPE )); then
  log "tearing down project '${COMPOSE_PROJECT_NAME}' AND WIPING ALL VOLUMES"
else
  log "tearing down project '${COMPOSE_PROJECT_NAME}' (volumes kept)"
fi

if (( WIPE )); then
  dc down -v --remove-orphans
  # The toolkit's fetch cache is a host directory, not a compose volume (see
  # scripts/lib/toolkit.sh), so compose cannot remove it. It must go with the chain: a
  # cache keyed to a genesis that no longer exists makes the next toolkit run fail in a
  # way that looks nothing like "stale cache".
  CACHE_DIR="$REPO_ROOT/.cache/${COMPOSE_PROJECT_NAME}"
  if [[ -d "$CACHE_DIR" ]]; then
    rm -rf "$CACHE_DIR"
    info "removed toolkit cache $CACHE_DIR"
  fi
else
  dc down --remove-orphans
fi

echo
log "remaining resources for project '${COMPOSE_PROJECT_NAME}'"
CONTAINERS=$(docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" | wc -l | tr -d ' ')
VOLUMES=$(docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" | wc -l | tr -d ' ')
NETWORKS=$(docker network ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" | wc -l | tr -d ' ')
info "containers=${CONTAINERS}  volumes=${VOLUMES}  networks=${NETWORKS}"

if (( WIPE )); then
  if (( CONTAINERS == 0 && VOLUMES == 0 && NETWORKS == 0 )); then
    ok "nothing left behind"
  else
    warn "some resources survived the teardown — inspect with:"
    dim "docker ps -a --filter label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}"
    dim "docker volume ls --filter label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}"
    exit 1
  fi
else
  info "volumes kept — ./up.sh resumes the same chain; ./down.sh -v for a full reset"
fi
