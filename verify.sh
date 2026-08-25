#!/usr/bin/env bash
#
# Assert the demo stack is not merely running but usable. Exit 0 = everything checked passed.
#
# Sections, in dependency order:
#   core     node RPC + finality advancing, indexer GraphQL v4 tracking the chain,
#            proof-server accepting connections
#   wallets  every wallets.json entry marked funding=genesis holds NIGHT and spendable DUST
#   evm      the umbra-evm read-only JSON-RPC surface (skipped unless the profile is up)
#   celestia the offerfiles profile's DA devnet: producing blocks, and a blob round trip
#            through the shared namespace (skipped unless the profile is up)
#
# Later phases append their own sections (kernel config endpoint, frontend HTTP).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

SKIP_WALLETS=0
EVM_MODE=auto
CELESTIA_MODE=auto
KERNEL_MODE=auto
FRONTEND_MODE=auto

usage() {
  cat <<'EOF'
Usage: ./verify.sh [options]

Options:
  --core-only    only the node/indexer/proof-server checks; skip the wallet assertions
                 (they each spawn a toolkit container and take ~10s per wallet) and the
                 optional-profile sections
  --evm          require the umbra-evm section (fail if the profile is not up)
  --no-evm       skip the umbra-evm section even if the profile is up
  --celestia     require the celestia section (fail if the profile is not up)
  --no-celestia  skip the celestia section even if the profile is up
  --kernel       require the kernel section (fail if the service is not up)
  --no-kernel    skip the kernel section even if the service is up
  --frontend     require the frontend section (fail if the profile is not up)
  --no-frontend  skip the frontend section even if the profile is up
  -h, --help     this text

By default each optional section runs if and only if that profile's containers exist for this
compose project, so ./verify.sh works unchanged whether or not `./up.sh --with evm
--with offerfiles` was used.

Environment:
  ENV_FILE=<path>  verify a different stack instance (see .env.example)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only) SKIP_WALLETS=1; EVM_MODE=off; CELESTIA_MODE=off; shift ;;
    --evm)       EVM_MODE=on; shift ;;
    --no-evm)    EVM_MODE=off; shift ;;
    --celestia)    CELESTIA_MODE=on; shift ;;
    --no-celestia) CELESTIA_MODE=off; shift ;;
    --kernel)      KERNEL_MODE=on; shift ;;
    --no-kernel)   KERNEL_MODE=off; shift ;;
    --frontend)    FRONTEND_MODE=on; shift ;;
    --no-frontend) FRONTEND_MODE=off; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
done

require_docker
load_env

FAILURES=0
check() {  # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    err "$label"
    FAILURES=$(( FAILURES + 1 ))
  fi
}

echo
log "core: node"
info "rpc ${NODE_RPC_URL}"
if wait_node_rpc "$NODE_RPC_URL" 30; then :; else FAILURES=$(( FAILURES + 1 )); fi
# Finality advancing is the real liveness signal: chain_getFinalizedHead keeps answering
# with the same hash forever when GRANDPA has stalled.
if wait_finalized_advances "$NODE_RPC_URL" 120; then :; else FAILURES=$(( FAILURES + 1 )); fi

BEST=$(node_best_height "$NODE_RPC_URL" || true)
FINAL=$(node_finalized_height "$NODE_RPC_URL" || true)
info "best=${BEST:-?}  finalized=${FINAL:-?}"

echo
log "core: proof-server"
if wait_tcp "$HOST_ADDR" "$PROOF_HOST_PORT" "proof-server" 30; then :; else FAILURES=$(( FAILURES + 1 )); fi

echo
log "core: indexer"
info "graphql ${INDEXER_GQL_URL}"
if wait_indexer_graphql "$INDEXER_GQL_URL" 60; then
  IH=$(indexer_height "$INDEXER_GQL_URL" || true)
  info "indexer height=${IH:-?}  (node best=${BEST:-?})"
  if [[ -n "${IH:-}" ]] && (( IH > 0 )); then
    ok "indexer has indexed at least one block"
  else
    err "indexer height is 0 or unreadable"
    FAILURES=$(( FAILURES + 1 ))
  fi
  # The indexer trails the node by a few blocks under normal operation; only a large,
  # persistent gap is a problem, so this is reported rather than asserted.
  if [[ -n "${IH:-}" && -n "${BEST:-}" ]]; then
    GAP=$(( BEST - IH ))
    (( GAP > 20 )) && warn "indexer is ${GAP} blocks behind the node"
  fi
else
  FAILURES=$(( FAILURES + 1 ))
fi

if (( ! SKIP_WALLETS )); then
  echo
  log "wallets"
  if "$REPO_ROOT/scripts/verify-wallets.sh"; then
    ok "wallet assertions passed"
  else
    err "wallet assertions failed"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

# ── evm (umbra-evm read-only JSON-RPC) ───────────────────────────────────────
# Presence is detected from the containers rather than from a flag, so `./verify.sh` needs no
# argument to do the right thing after `./up.sh` or after `./up.sh --with evm`.
EVM_PRESENT=0
if [[ -n "$(docker ps -aq \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=evm-rpc" 2>/dev/null)" ]]; then
  EVM_PRESENT=1
fi

case "$EVM_MODE" in
  off) ;;
  on|auto)
    if (( EVM_PRESENT )); then
      echo
      log "evm"
      if "$REPO_ROOT/scripts/verify-evm.sh"; then
        ok "umbra-evm assertions passed"
      else
        err "umbra-evm assertions failed"
        FAILURES=$(( FAILURES + 1 ))
      fi
    elif [[ "$EVM_MODE" == "on" ]]; then
      echo
      err "--evm was requested but no evm-rpc container exists for project '${COMPOSE_PROJECT_NAME}'"
      dim "bring it up with: ./up.sh --with evm"
      FAILURES=$(( FAILURES + 1 ))
    else
      echo
      dim "evm profile not up — skipping (./up.sh --with evm to include it)"
    fi
    ;;
esac

# ── celestia (the offerfiles profile's DA devnet) ────────────────────────────
# Same presence-detection rule as the evm section: read it off the containers, so no argument is
# needed to do the right thing.
CELESTIA_PRESENT=0
if [[ -n "$(docker ps -aq \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=celestia" 2>/dev/null)" ]]; then
  CELESTIA_PRESENT=1
fi

case "$CELESTIA_MODE" in
  off) ;;
  on|auto)
    if (( CELESTIA_PRESENT )); then
      echo
      log "celestia"
      if "$REPO_ROOT/scripts/verify-celestia.sh"; then
        ok "celestia assertions passed"
      else
        err "celestia assertions failed"
        FAILURES=$(( FAILURES + 1 ))
      fi
    elif [[ "$CELESTIA_MODE" == "on" ]]; then
      echo
      err "--celestia was requested but no celestia container exists for project '${COMPOSE_PROJECT_NAME}'"
      dim "bring it up with: ./up.sh --with offerfiles"
      FAILURES=$(( FAILURES + 1 ))
    else
      echo
      dim "offerfiles profile not up — skipping celestia (./up.sh --with offerfiles to include it)"
    fi
    ;;
esac

# ── kernel (the offerfiles profile's sync node + batcher) ────────────────────
# Same presence-detection rule as the sections above.
KERNEL_PRESENT=0
if [[ -n "$(docker ps -aq \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=kernel" 2>/dev/null)" ]]; then
  KERNEL_PRESENT=1
fi

case "$KERNEL_MODE" in
  off) ;;
  on|auto)
    if (( KERNEL_PRESENT )); then
      echo
      log "kernel"
      if "$REPO_ROOT/scripts/verify-kernel.sh"; then
        ok "kernel assertions passed"
      else
        err "kernel assertions failed"
        FAILURES=$(( FAILURES + 1 ))
      fi
    elif [[ "$KERNEL_MODE" == "on" ]]; then
      echo
      err "--kernel was requested but no kernel container exists for project '${COMPOSE_PROJECT_NAME}'"
      dim "bring it up with: ./up.sh --with offerfiles"
      FAILURES=$(( FAILURES + 1 ))
    else
      echo
      dim "kernel not up — skipping (./up.sh --with offerfiles to include it)"
    fi
    ;;
esac

# ── frontend (the zswap-da trading UI) ───────────────────────────────────────
FRONTEND_PRESENT=0
if [[ -n "$(docker ps -aq \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=frontend" 2>/dev/null)" ]]; then
  FRONTEND_PRESENT=1
fi

case "$FRONTEND_MODE" in
  off) ;;
  on|auto)
    if (( FRONTEND_PRESENT )); then
      echo
      log "frontend"
      if "$REPO_ROOT/scripts/verify-frontend.sh"; then
        ok "frontend assertions passed"
      else
        err "frontend assertions failed"
        FAILURES=$(( FAILURES + 1 ))
      fi
    elif [[ "$FRONTEND_MODE" == "on" ]]; then
      echo
      err "--frontend was requested but no frontend container exists for project '${COMPOSE_PROJECT_NAME}'"
      dim "bring it up with: ./up.sh --with frontend"
      FAILURES=$(( FAILURES + 1 ))
    else
      echo
      dim "frontend profile not up — skipping (./up.sh --with frontend to include it)"
    fi
    ;;
esac

echo
if (( FAILURES == 0 )); then
  ok "verify.sh: all checks passed"
  exit 0
fi
err "verify.sh: ${FAILURES} check(s) failed"
exit 1
