#!/usr/bin/env bash
#
# aa-bridge-dryrun.sh — prove the MPC responder can answer this stack's vault, BEFORE any
# funds move on the EVM chain.
#
#   ./scripts/aa-bridge-dryrun.sh
#
# Needs a stack up with `--with aa --with signet`. It raises ONE deposit request for a RANDOM
# throwaway recipient, waits for the responder's signature, and writes
# /aa/out/aa-bridge-dryrun.json. Nothing is broadcast: no gas is spent and no token moves.
#
# ── WHY IT IS A GATE AND NOT A CURIOSITY (project 00035, question Q11) ───────
# The responder proves its own `respond` write against the Signet singleton this stack
# compiled with `--feature-zkir-v3`, whose verifier keys are therefore `[v7]`. compose/aa.yml's
# rule says that needs the EXPERIMENTAL proof server; project 00034's stagenet run had the same
# responder image succeed against a PLAIN one. Until a request is actually answered, the
# configured lane is a guess — and a wrong guess fails at proving, minutes into a run that has
# already put real tokens at a deposit address. The owner's decision (Q11 option C) was to
# settle it here, first.
#
# ── WHICH WALLET PAYS ───────────────────────────────────────────────────────
# The run happens INSIDE the aa-console container, because that is where the EVM endpoint
# already is: passing a keyed RPC URL on a `docker compose run` command line would put an
# operator secret into `ps`. It uses the FUNDER seed (genesis-3, prefunded and DUST-registered)
# rather than the console's own relay seed, so no two wallet facades ever drive one seed at the
# same time (the rule in wallets/wallets.json). Do not run it while a console job is minting.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

OUT_DIR="${1:-}"

CID="$(dc ps -q aa-console 2>/dev/null | head -1 || true)"
[[ -n "$CID" ]] || die "no running aa-console container for project '${COMPOSE_PROJECT_NAME}' — ./up.sh --with aa --with signet"

SIGNET_CID="$(dc ps -q signet-fakenet 2>/dev/null | head -1 || true)"
[[ -n "$SIGNET_CID" ]] || die "no running signet-fakenet container — the responder is what this script measures"

# What the responder was actually pointed at, read off the running process rather than off the
# compose file: the entrypoint exports values compose never saw (verify-signet.sh's own finding).
PROOF_SERVER="$(docker exec "$SIGNET_CID" sh -c "tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^MIDNIGHT_PROOF_SERVER_URL=//p'" 2>/dev/null || true)"
PROOF_SERVER="${PROOF_SERVER:-(unreadable)}"
log "the responder's proof server: ${PROOF_SERVER}"

log "raising ONE signing request for a throwaway recipient (no broadcast, no gas, no token)…"
docker exec \
  -e "AA_BRIDGE_DRYRUN_PROOF_SERVER=${PROOF_SERVER}" \
  -e "AA_CONSOLE_SEED=${AA_WALLET_SEED:-0000000000000000000000000000000000000000000000000000000000000003}" \
  -e "AA_BRIDGE_DRYRUN_TOKEN=${AA_BRIDGE_DRYRUN_TOKEN:-USDC}" \
  -e "AA_BRIDGE_DRYRUN_TIMEOUT_MS=${AA_BRIDGE_DRYRUN_TIMEOUT_MS:-600000}" \
  "$CID" bun /aa/runner/aa-bridge-dryrun.ts

if [[ -n "$OUT_DIR" ]]; then
  mkdir -p "$OUT_DIR"
  docker exec "$CID" cat /aa/out/aa-bridge-dryrun.json > "$OUT_DIR/aa-bridge-dryrun.json"
  ok "report copied to ${OUT_DIR}/aa-bridge-dryrun.json"
fi
ok "the responder answered — the configured proof server proves its \`respond\` (question Q11)"
