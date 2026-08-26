#!/bin/bash
# Shared prelude for all three offerfiles containers. SOURCED, never executed.
#
# The image ships one binary per concern — kernel (sync node), batcher, deploy
# one-shot — and each starts the same way: pick up the Celestia token, prove the
# external stack is reachable, and (for the two that need it) learn the
# offer-files contract address. That is this file.

set -euo pipefail

DEPLOY_OUT="${DEPLOY_OUT:-/deploy-out}"
NETWORK_ID="${MIDNIGHT_NETWORK_ID:-undeployed}"
CONTRACT_FILE="contract-offer-files.${NETWORK_ID}.json"
CONTRACT_DIR="/app/packages/contracts-midnight"
MINTED_MARKER="${DEPLOY_OUT}/.minted"

log() { echo "[$1] ${*:2}"; }

# ── the Celestia auth-token handoff ──────────────────────────────────────────
# The token does not exist until the celestia container initialises its bridge
# store, long after compose has evaluated `environment:` on the host — so it
# cannot be a compose value. It arrives on a read-only volume instead. Anything
# compose DID set wins over the file, which is how CELESTIA_NAMESPACE stays
# under the stack's control.
load_celestia_env() {
  if [ -f /celestia/auth/celestia.env ]; then
    local saved
    saved="$(export -p)"
    set -a; . /celestia/auth/celestia.env; set +a
    eval "$saved"
  fi
}

# ── fail fast on the external stack ──────────────────────────────────────────
# T11.1's verdict: preflight is not a service, it is each container's first act.
# Running it per-container (rather than once, as the orchestrator did) means a
# container that comes back after its dependencies moved re-proves them instead
# of inheriting a stale all-clear from bring-up.
run_preflight() {
  log "$1" "probing the external Midnight + Celestia stack"
  bun run /app/packages/node/preflight-external.ts
}

# ── the contract address ─────────────────────────────────────────────────────
# The deploy one-shot persists `contract-offer-files.<network>.json` on the
# shared volume. Readers get it two ways, deliberately:
#
#   1. copied into packages/contracts-midnight/, because that is where
#      `readMidnightContract()` looks and where mint-test-tokens and the test
#      helpers look. Nothing in the kernel repo had to change for this.
#   2. exported as MIDNIGHT_CONTRACT_ADDRESS, which config.dev.ts now prefers.
#      Redundant on purpose: it makes the address visible to `docker inspect`
#      and to the logs, so "which contract is this container on?" is answerable
#      without exec'ing into it.
load_contract_address() {
  local role="$1"
  local src="${DEPLOY_OUT}/${CONTRACT_FILE}"

  if [ ! -f "$src" ]; then
    log "$role" "FATAL: no ${CONTRACT_FILE} on ${DEPLOY_OUT}."
    log "$role" "The offerfiles-deploy one-shot must complete before this container starts."
    exit 1
  fi

  cp "$src" "${CONTRACT_DIR}/${CONTRACT_FILE}"

  # Path via ENV, not argv: `bun -e` builds process.argv as
  # ["<bun>", ...trailing args] with no script-path entry, so the usual
  # argv[2] is undefined. An env var sidesteps that quirk entirely.
  MIDNIGHT_CONTRACT_ADDRESS="$(
    OFFERFILES_CONTRACT_JSON="$src" bun -e \
      'console.log(JSON.parse(await Bun.file(process.env.OFFERFILES_CONTRACT_JSON).text()).contractAddress)'
  )"
  if [ -z "$MIDNIGHT_CONTRACT_ADDRESS" ] || [ "$MIDNIGHT_CONTRACT_ADDRESS" = "undefined" ]; then
    log "$role" "FATAL: ${CONTRACT_FILE} carries no contractAddress"
    exit 1
  fi
  export MIDNIGHT_CONTRACT_ADDRESS
  log "$role" "offer-files contract ${MIDNIGHT_CONTRACT_ADDRESS} (network ${NETWORK_ID})"
}
