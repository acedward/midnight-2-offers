#!/usr/bin/env bash
#
# aa-story-e2e.sh — the owner's seven-step story, headless, on a real EVM chain
# (spec FR-016, SC-001/004/005; project 00035 sub-plan C).
#
#   ./scripts/aa-story-e2e.sh [--evidence <dir>] [--take batcher|node]
#                             [--give-amount 1] [--want-amount 10] [--bridge-want 10]
#                             [--no-withdraw-back]
#
#   register an account → bridge WEENUS to the OWNER'S OWN Midnight wallet (the offer-files
#   frontend's in-page wallet) → bridge USDC into the account → publish an OPEN offer giving
#   1 USDC for 10 WEENUS → let the owner's wallet TAKE it through the SPA's own code path →
#   watch the console notice, reconcile and show USDC −1 / WEENUS +10 with the settling
#   transaction → withdraw the received WEENUS back to the funder.
#
# The claim the e2e-coverage matrix hangs on this script is step 7:
#   the console reconciles the account by itself
# — no page action, no operator, within 60 seconds of a settlement it never saw, from the
# account contract's own action history and the inbox entries the offer sealed. Spec FR-011
# and SC-005.
#
# Needs a stack up with `--with aa --with signet --with offerfiles --with frontend`:
#   aa         the console, the account contracts, the vault
#   signet     the MPC responder that makes the bridge real on a live EVM chain
#   offerfiles the kernel (the book and the token registry) and the batcher (the SPA's
#              sponsored settlement path — the take goes through it)
#   frontend   the SPA, whose served /config.js is where the owner's wallet seed comes from
#
# ── NO ANVIL LANE ───────────────────────────────────────────────────────────
# Project question Q16: this repository has no anvil, and building that lane is a compose
# fragment, a solc-built test ERC20, up.sh wiring and a second full bring-up. It is issue
# 00036, and spec SC-006 is amended to Sepolia. There is no --anvil flag here on purpose.
#
# ── THE TWO SECRETS, AND WHY NEITHER IS AN ARGUMENT ─────────────────────────
# Same posture as scripts/aa-bridge-e2e.sh: the funder key and the RPC URL are read from the
# operator's own file at RUN TIME and handed to the container through a mode-600 file mounted
# at /run/aa-story-e2e.env — never `-e KEY=value`, because this is a shared machine and a
# `docker compose run` command line is visible in `ps` to everyone on it. The CONSOLE never
# receives either (spec FR-015).
#
#   SEPOLIA_FUNDER_KEY, SEPOLIA_RPC_URL   from ${AA_SEPOLIA_ENV:-$HOME/.config/aa-00034/sepolia.env}
#
# ── SPEND ───────────────────────────────────────────────────────────────────
# One deposit of the want token to the owner's wallet, one of the give token to the account,
# one withdrawal back out — three gas fundings at the console's own figure (0.002 ETH each by
# default). With the defaults that is 1 USDC, 10 WEENUS and ≈0.006 ETH leaving the funder, and
# the 10 WEENUS come back in the closing leg. The console's caps (AA_BRIDGE_CAP_*) are enforced
# on top of that, in the relay.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

# `dc` renders core.yml plus one fragment per name in $PROFILES, and a standalone script starts
# with that empty — so `dc run … aa-deploy` would answer "no such service" against a stack that
# is plainly running. The aa profile defines the service AND is what this needs anyway.
PROFILES="${PROFILES:-} aa"

EVIDENCE_DIR=""
TAKE_VIA="${AA_STORY_TAKE_VIA:-batcher}"
GIVE_AMOUNT="${AA_STORY_GIVE_AMOUNT:-1}"
WANT_AMOUNT="${AA_STORY_WANT_AMOUNT:-10}"
BRIDGE_WANT=""
WITHDRAW_BACK="${AA_STORY_WITHDRAW_BACK:-1}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence) EVIDENCE_DIR="${2:?--evidence needs a directory}"; shift 2 ;;
    --take) TAKE_VIA="${2:?--take needs batcher|node}"; shift 2 ;;
    --give-amount) GIVE_AMOUNT="${2:?--give-amount needs a decimal amount}"; shift 2 ;;
    --want-amount) WANT_AMOUNT="${2:?--want-amount needs a decimal amount}"; shift 2 ;;
    --bridge-want) BRIDGE_WANT="${2:?--bridge-want needs a decimal amount}"; shift 2 ;;
    --no-withdraw-back) WITHDRAW_BACK=0; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) err "unknown argument: $1"; exit 2 ;;
  esac
done
[[ "$TAKE_VIA" == "batcher" || "$TAKE_VIA" == "node" ]] || die "--take must be batcher or node"
BRIDGE_WANT="${BRIDGE_WANT:-${AA_STORY_BRIDGE_WANT:-$WANT_AMOUNT}}"

# ── the operator's secrets, read at run time ────────────────────────────────
SEPOLIA_ENV_FILE="${AA_SEPOLIA_ENV:-$HOME/.config/aa-00034/sepolia.env}"
if [[ -z "${SEPOLIA_FUNDER_KEY:-}" || -z "${SEPOLIA_RPC_URL:-}" ]] && [[ -f "$SEPOLIA_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$SEPOLIA_ENV_FILE"; set +a
fi
E2E_RPC_URL="${AA_STORY_RPC_URL:-${SIGNET_EVM_RPC_URL:-${SEPOLIA_RPC_URL:-}}}"
E2E_FUNDER_KEY="${AA_STORY_FUNDER_KEY:-${SEPOLIA_FUNDER_KEY:-}}"
[[ -n "$E2E_RPC_URL" ]] || die "no EVM endpoint: set SEPOLIA_RPC_URL in ${SEPOLIA_ENV_FILE}, or SIGNET_EVM_RPC_URL in ${ENV_FILE}"
[[ -n "$E2E_FUNDER_KEY" ]] || die "no funder key: set SEPOLIA_FUNDER_KEY in ${SEPOLIA_ENV_FILE} (mode 600, never in this repo)"

# ── the four services this story needs, named individually when one is missing ──
CID="$(dc ps -q aa-console 2>/dev/null | head -1 || true)"
[[ -n "$CID" ]] || die "no running aa-console for project '${COMPOSE_PROJECT_NAME}' — ./up.sh --with aa --with signet"
present() {
  [[ -n "$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" 2>/dev/null)" ]]
}
MISSING=""
NEEDED=(kernel frontend)
[[ "$TAKE_VIA" == "batcher" ]] && NEEDED+=(batcher)
for svc in "${NEEDED[@]}"; do present "$svc" || MISSING="${MISSING} ${svc}"; done
if [[ -n "$MISSING" ]]; then
  err "this story needs services that are not running:${MISSING}"
  info "  ./up.sh --with aa --with signet --with offerfiles --with frontend"
  info "  (or run the take through the node instead of the batcher: --take node)"
  exit 1
fi

if ! docker exec "$CID" bun -e '
  const r = await fetch("http://127.0.0.1:8090/api/info");
  const j = await r.json();
  if (!j.bridge?.available) { console.error((j.bridge?.reasons ?? ["unknown"]).join("; ")); process.exit(1); }
  console.log(`bridge available on EVM chain ${j.bridge.chainId} (${j.bridge.attestation})`);
'; then
  die "the console reports the bridge as unavailable (see the reason above)"
fi

# ── hand the secrets over in a file, not on a command line ──────────────────
SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aa-story-e2e.XXXXXX")"
chmod 700 "$SECRET_DIR"
cleanup() { rm -rf "$SECRET_DIR"; }
trap cleanup EXIT INT TERM
SECRET_FILE="$SECRET_DIR/e2e.env"
umask 077
{
  printf 'export AA_STORY_RPC_URL=%q\n' "$E2E_RPC_URL"
  printf 'export AA_STORY_FUNDER_KEY=%q\n' "$E2E_FUNDER_KEY"
} > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

log "running the seven-step story (two device-gated bridge starts and one offer are k=18 — expect 20+ minutes)"
log "  step 3: ${BRIDGE_WANT} ${AA_STORY_WANT:-WEENUS} → the owner's own Midnight wallet"
log "  step 4: ${GIVE_AMOUNT} ${AA_STORY_GIVE:-USDC} → the account"
log "  step 5: an OPEN offer giving ${GIVE_AMOUNT} ${AA_STORY_GIVE:-USDC} for ${WANT_AMOUNT} ${AA_STORY_WANT:-WEENUS}"
log "  step 6: taken by the owner's wallet, via the ${TAKE_VIA}"

set +e
dc run --rm --no-deps \
  -v "$SECRET_FILE:/run/aa-story-e2e.env:ro" \
  -e "AA_STORY_CONSOLE_URL=${AA_STORY_CONSOLE_URL:-http://aa-console:8090}" \
  -e "AA_STORY_KERNEL_URL=${AA_STORY_KERNEL_URL:-http://kernel:9999}" \
  -e "AA_STORY_BATCHER_URL=${AA_STORY_BATCHER_URL:-http://batcher:3334}" \
  -e "AA_STORY_CONFIG_URL=${AA_STORY_CONFIG_URL:-http://frontend:10600/config.js}" \
  -e "AA_STORY_TAKE_VIA=${TAKE_VIA}" \
  -e "AA_STORY_GIVE=${AA_STORY_GIVE:-USDC}" \
  -e "AA_STORY_WANT=${AA_STORY_WANT:-WEENUS}" \
  -e "AA_STORY_GIVE_AMOUNT=${GIVE_AMOUNT}" \
  -e "AA_STORY_WANT_AMOUNT=${WANT_AMOUNT}" \
  -e "AA_STORY_BRIDGE_WANT=${BRIDGE_WANT}" \
  -e "AA_STORY_WITHDRAW_BACK=${WITHDRAW_BACK}" \
  -e "AA_STORY_OUT=${AA_STORY_OUT:-/aa/out/aa-story-e2e.json}" \
  -e "AA_STORY_RECONCILE_MS=${AA_STORY_RECONCILE_MS:-60000}" \
  ${AA_STORY_OWNER_KEY:+-e "AA_STORY_OWNER_KEY=${AA_STORY_OWNER_KEY}"} \
  --entrypoint sh aa-deploy -c '. /run/aa-story-e2e.env && exec bun /aa/runner/aa-story-e2e.ts'
RC=$?
set -e

if [[ -n "$EVIDENCE_DIR" ]]; then
  mkdir -p "$EVIDENCE_DIR"
  if docker exec "$CID" cat "${AA_STORY_OUT:-/aa/out/aa-story-e2e.json}" > "$EVIDENCE_DIR/aa-story-e2e.json" 2>/dev/null; then
    ok "report copied to ${EVIDENCE_DIR}/aa-story-e2e.json"
  else
    warn "no story report to copy (the run may have failed before writing it)"
  fi
fi

if (( RC != 0 )); then
  err "the story e2e FAILED (exit ${RC})"
  info "  every bridge request it started is PERSISTED: GET /api/bridge/requests, resume with"
  info "  POST /api/bridge/relay/<requestId>. An offer that was built but not settled is cleared"
  info "  with POST /api/offer/forget, and the account's coin store is re-read with POST /api/refresh."
  exit "$RC"
fi
ok "the seven-step story PASSED"
