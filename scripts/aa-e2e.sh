#!/usr/bin/env bash
#
# aa-e2e.sh — end-to-end test of the EVM-signed AA path:
#
#   EVM wallet (MetaMask V4 signer) → relay → Manager.execute → Midnight
#   register two EVM accounts · mint · deposit · internal transfer · ledger asserts
#
#   ./scripts/aa-e2e.sh
#
# Needs the stack up WITH the aa profile (./up.sh --with aa) — the test runs
# against the contracts aa-deploy already put on this chain.
#
# Builds the :e2e image variant on first run (AA_PRUNE_MANAGER_PROVERS=0): calling
# `execute` proves the Manager's k=19 circuit, so the 1.1 GB prover key the normal
# image prunes must be present. Expect the first build to take a few minutes and
# ~1.2 GB of image; after that it is cached.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

E2E_IMAGE="${AA_E2E_IMAGE:-midnight-2-offers/aa-contracts:e2e}"
COMPOSE=(docker compose --env-file "${ENV_FILE:-$REPO_ROOT/.env}"
  -f "$REPO_ROOT/compose/core.yml" -f "$REPO_ROOT/compose/aa.yml")

# The deployed-contracts artifact must exist (aa profile brought up on THIS chain).
if ! "${COMPOSE[@]}" run --rm --no-deps --entrypoint test aa-deploy -f /aa/out/aa-contracts.json 2>/dev/null; then
  err "no aa-contracts.json — bring the stack up with: ./up.sh --with aa"
  exit 2
fi

log "building the :e2e image variant (manager prover keys kept)…"
"${COMPOSE[@]}" build --build-arg AA_PRUNE_MANAGER_PROVERS=0 aa-deploy
docker tag "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" "$E2E_IMAGE"
# Restore the pruned default image so later `up` invocations do not carry the keys.
"${COMPOSE[@]}" build aa-deploy

# A SHIELDED-FREE relay wallet (see aa-e2e.ts header): fresh dev seed, faucet-
# funded with unshielded NIGHT + DUST only. Idempotent — re-funding just tops up.
E2E_SEED="${AA_E2E_SEED:-e2ee2e0000000000000000000000000000000000000000000000000000e2ee2e}"
log "funding the e2e relay wallet (unshielded NIGHT + DUST, no shielded)…"
"$REPO_ROOT/scripts/fund-wallet.sh" "$E2E_SEED"

log "running the E2E (register ×2 → mint → deposit; k=19 proofs — takes a while)…"
log "(debit probes — withdraw/transfer — are blocked upstream; AA_E2E_PROBE_DEBITS=1 runs them anyway)"
# AA_E2E_PROBE_DEBITS must be forwarded explicitly — `docker compose run` does
# not inherit ambient host env (found by the 00015 investigation, P0-A).
AA_IMAGE="$E2E_IMAGE" "${COMPOSE[@]}" run --rm \
  -e AA_E2E_SEED="$E2E_SEED" \
  -e AA_E2E_PROBE_DEBITS="${AA_E2E_PROBE_DEBITS:-}" \
  --entrypoint bun aa-deploy /aa/runner/aa-e2e.ts
