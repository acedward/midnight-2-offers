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
#
# IT RETRIES, and that is not a softening of the fail-fast rule. `preflight-external`
# probes FOUR endpoints, and compose can only gate this container on three of
# them: node, indexer and celestia have healthchecks, while the PROOF SERVER has
# none that compose can wait on — its own image ships no curl and its bash sits
# behind a per-build /nix/store path, which is why up.sh probes its TCP port from
# the host instead. So `depends_on` cannot express "the proof server is
# answering", and on a host where `proof-params-init` takes minutes to download
# and verify its 223 MB (the proof servers are gated on that one-shot) this
# container reached its first probe seconds before the proof server bound its
# port — and a ONE-SHOT probe turned a timing difference into a failed bring-up.
# Measured 2026-09-03: node/indexer/celestia all OK, proof server "Unable to
# connect", proof-params-init having reported ACTIVATED in the same second.
#
# The retry keeps every property that mattered: a genuinely missing endpoint
# still fails the container (bounded at PREFLIGHT_TRIES x PREFLIGHT_RETRY_S,
# 200 s by default), the failure still names the endpoint, and nothing starts
# against a half-present stack.
run_preflight() {
  local role="$1"
  local tries="${PREFLIGHT_TRIES:-40}"
  local wait_s="${PREFLIGHT_RETRY_S:-5}"
  local i

  log "$role" "probing the external Midnight + Celestia stack"
  for (( i = 1; i <= tries; i++ )); do
    if bun run /app/packages/node/preflight-external.ts; then
      return 0
    fi
    if (( i < tries )); then
      log "$role" "preflight attempt ${i}/${tries} did not pass — retrying in ${wait_s}s"
      sleep "$wait_s"
    fi
  done

  log "$role" "FATAL: the external stack never became ready after ${tries} attempts"
  log "$role" "the last attempt's output is above; each line names the endpoint it could not reach"
  return 1
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
