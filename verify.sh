#!/usr/bin/env bash
#
# Assert the demo stack is not merely running but usable. Exit 0 = everything checked passed.
#
# Sections, in dependency order:
#   core     node RPC + finality advancing, indexer GraphQL v4 tracking the chain,
#            proof-server accepting connections
#   wallets  every wallets.json entry marked funding=genesis holds NIGHT and spendable DUST
#
# Later phases append their own sections (evm reads, kernel config endpoint, frontend HTTP).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

SKIP_WALLETS=0

usage() {
  cat <<'EOF'
Usage: ./verify.sh [options]

Options:
  --core-only    only the node/indexer/proof-server checks; skip the wallet assertions
                 (they each spawn a toolkit container and take ~10s per wallet)
  -h, --help     this text

Environment:
  ENV_FILE=<path>  verify a different stack instance (see .env.example)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only) SKIP_WALLETS=1; shift ;;
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

echo
if (( FAILURES == 0 )); then
  ok "verify.sh: all checks passed"
  exit 0
fi
err "verify.sh: ${FAILURES} check(s) failed"
exit 1
