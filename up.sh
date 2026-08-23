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
# shellcheck source=scripts/lib/evm.sh
source "$REPO_ROOT/scripts/lib/evm.sh"
# shellcheck source=scripts/lib/celestia.sh
source "$REPO_ROOT/scripts/lib/celestia.sh"

PROFILES=""
DO_PULL=0
DO_BUILD=0
WANT_ALL=0

usage() {
  cat <<'EOF'
Usage: ./up.sh [options]

Brings up the core Midnight stack (node + indexer + proof-server) and waits until all
three are serving. Reads .env for image tags and host ports (see .env.example).

Options:
  --with <profile>   also bring up an optional profile; repeatable. A profile is a compose
                     fragment in compose/, named after the profile. An unknown name is an
                     error, not a no-op — see below.
                     Available now: evm        (read-only Ethereum JSON-RPC)
                                    offerfiles (Celestia DA devnet; kernel + batcher pending)
  --all              bring up every profile that has a fragment in compose/. Profiles that
                     are documented but not built yet are named and skipped, not an error.
  --pull             docker compose pull before starting.
  --build            docker compose build before starting (for the locally-built images).
  -h, --help         this text.

`--with` names the COMPLETE set of optional profiles for this bring-up, not an addition to
whatever is already running: compose is given only core + the named fragments and passes
--remove-orphans, so a profile that is up but not named this time is STOPPED. To add a second
profile to a running stack, name both (`--with evm --with offerfiles`) or use `--all`.

`offerfiles` is PARTIAL: it brings up the local Celestia devnet (a DA layer the kernel will
publish offers to), but not yet the offer-files kernel (:9999) or the batcher (:3334) — those
need the Effectstream ledger-v9 migration (project 00016). up.sh says so on every bring-up.

Profile not built yet: frontend (the zswap-da SPA), which follows the kernel. Its host port is
reserved in .env.example. `--all` reports it; `--with` rejects it, because a silently-ignored
`--with` is worse than a failed one.

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

# A `--with` name that has no fragment must FAIL. It used to be accepted and then quietly
# dropped by compose_files(), so `./up.sh --with umbra-evm` (the fragment is evm.yml) came
# up as a bare core stack and only failed later, as `no such service: evm-rpc`.
add_profile() {
  local p="$1" pend
  if [[ ! -f "$REPO_ROOT/compose/$p.yml" ]]; then
    err "unknown profile: $p"
    info "available now: $(available_profiles | tr '\n' ' ')"
    pend="$(pending_profiles | tr '\n' ' ')"
    [[ -n "${pend// /}" ]] && info "not built yet, coming with ${FUTURE_PROFILES_BLOCKER}: ${pend}"
    exit 2
  fi
  PROFILES="$PROFILES $p"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with)   add_profile "${2:?--with needs a profile name}"; shift 2 ;;
    --with=*) add_profile "${1#*=}"; shift ;;
    --all)
      while IFS= read -r p; do PROFILES="$PROFILES $p"; done < <(available_profiles)
      WANT_ALL=1
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
# Name what a partial profile does and does not include, every time. Left unsaid, `--with
# offerfiles` coming up with no kernel on :9999 reads as a broken build rather than as the
# half that was deliberately built first.
for p in ${PROFILES:-}; do
  if note="$(partial_profile_note "$p" 2>/dev/null)"; then
    info "note     ${p} is PARTIAL: ${note}"
  fi
done
if (( WANT_ALL )); then
  # `--all` means "every fragment there is", which today is not the whole demo. Say so, so
  # nobody concludes the offer-files half is broken when it was simply never started.
  PENDING="$(pending_profiles | tr '\n' ' ')"
  if [[ -n "${PENDING// /}" ]]; then
    info "not built yet, so --all skipped them (coming with ${FUTURE_PROFILES_BLOCKER}): ${PENDING}"
  fi
fi

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

# Optional profiles, after the core stack they depend on. Each one waits on the thing that
# proves the profile is usable, not merely started — same rule as the core services.
if (( ! FAILED )) && [[ " $PROFILES " == *" evm "* ]]; then
  evm_defaults
  # The one-shot migration service must have run to completion (compose enforces the ordering,
  # but a FAILED migration leaves evm-rpc never started, which is worth naming explicitly).
  wait_compose_healthy evm-rpc "$EVM_WAIT_TIMEOUT" || FAILED=1
  if (( ! FAILED )); then
    wait_evm_rpc "$EVM_WAIT_TIMEOUT" || FAILED=1
  fi
  if (( ! FAILED )); then
    # A handshake, not a TCP probe: docker's port proxy accepts connections even when nothing in
    # the container is listening, so `nc -z` here would report a working WS surface that refuses
    # every client (see images/umbra-evm/patches/apply.mjs).
    evm_ws_handshake 60 || FAILED=1
  fi
fi

if (( ! FAILED )) && [[ " $PROFILES " == *" offerfiles "* ]]; then
  celestia_defaults
  # The container healthcheck is already a real authenticated JSON-RPC call plus a wallet-balance
  # assertion (images/celestia/healthcheck.sh), so `healthy` here genuinely means "a blob can be
  # submitted". It is still not enough on its own: it proves the RPC works on container-localhost,
  # and says nothing about the PUBLISHED port — which is where P3's loopback-bind defect lived.
  wait_compose_healthy celestia "$CELESTIA_WAIT_TIMEOUT" || FAILED=1
  if (( ! FAILED )); then
    wait_celestia_rpc 120 || FAILED=1
  fi
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
if [[ " $PROFILES " == *" evm "* ]]; then
  info "evm JSON-RPC      ${EVM_RPC_URL}   (chainId ${EVM_CHAIN_ID}, READ-ONLY)"
  info "evm WS            ws://${HOST_ADDR}:${EVM_WS_HOST_PORT}"
fi
if [[ " $PROFILES " == *" offerfiles "* ]]; then
  info "celestia DA RPC   ${CELESTIA_DA_URL}   (namespace ${CELESTIA_NAMESPACE})"
  if [[ "$CELESTIA_SKIP_AUTH" != "true" && "$CELESTIA_SKIP_AUTH" != "1" ]]; then
    info "celestia token    ./scripts/celestia-token.sh    (or: exec celestia celestia-token)"
  fi
fi
echo
info "next: ./verify.sh    (health + prefunded wallet assertions)"
info "      ./down.sh -v   (stop and wipe all chain/indexer state)"
