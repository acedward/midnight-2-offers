#!/usr/bin/env bash
#
# aa-bridge-e2e.sh — the headless end-to-end test of the ERC20 bridge (spec FR-016, SC-006).
#
#   ./scripts/aa-bridge-e2e.sh [--evidence <dir>]
#
#   register an account → be REFUSED for an unfunded deposit address → bridge an ERC20 into
#   the account → bridge another to a Midnight wallet nobody here holds a key of → withdraw
#   part of the first back to the funder → be refused past the cap → resume a finished
#   request and change nothing.
#
# Needs a stack up with `--with aa --with signet` (the bridge is not available otherwise, and
# the console says so in /api/info).
#
# ── THE TWO SECRETS, AND WHY NEITHER IS AN ARGUMENT ─────────────────────────
# The run moves real tokens on a real chain, so it needs the operator's funder key and RPC
# endpoint. Both are read from the operator's own file at RUN TIME and handed to the container
# through a mode-600 file mounted at /run/aa-bridge-e2e.env, never as `-e KEY=value`: this is a
# shared machine and a `docker compose run` command line is visible in `ps` to everyone on it.
# The file is created under a private temp directory and removed on exit, whatever happens.
#
# The CONSOLE never receives either of them (spec FR-015): it is given a read-only RPC URL by
# compose so it can quote balances, and it has no key of any kind. The funder key exists only
# in this process and in the e2e container.
#
#   SEPOLIA_FUNDER_KEY, SEPOLIA_RPC_URL   from ${AA_SEPOLIA_ENV:-$HOME/.config/aa-00034/sepolia.env}
#                                         or from the environment, if already exported.
#
# ── SPEND ───────────────────────────────────────────────────────────────────
# Three legs, each funded with the gas the console asks for (0.002 ETH by default) plus the
# token amount. The console's own caps (AA_BRIDGE_CAP_*) are enforced on top, in the relay, and
# this run asserts that they are.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

EVIDENCE_DIR=""
MODE="${AA_BRIDGE_E2E_MODE:-sepolia}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence) EVIDENCE_DIR="${2:?--evidence needs a directory}"; shift 2 ;;
    --anvil) MODE="anvil"; shift ;;
    --sepolia) MODE="sepolia"; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) err "unknown argument: $1"; exit 2 ;;
  esac
done

# ── the operator's secrets, read at run time ────────────────────────────────
SEPOLIA_ENV_FILE="${AA_SEPOLIA_ENV:-$HOME/.config/aa-00034/sepolia.env}"
if [[ -z "${SEPOLIA_FUNDER_KEY:-}" || -z "${SEPOLIA_RPC_URL:-}" ]] && [[ -f "$SEPOLIA_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$SEPOLIA_ENV_FILE"; set +a
fi
E2E_RPC_URL="${AA_BRIDGE_E2E_RPC_URL:-${SIGNET_EVM_RPC_URL:-${SEPOLIA_RPC_URL:-}}}"
E2E_FUNDER_KEY="${AA_BRIDGE_E2E_FUNDER_KEY:-${SEPOLIA_FUNDER_KEY:-}}"
[[ -n "$E2E_RPC_URL" ]] || die "no EVM endpoint: set SEPOLIA_RPC_URL in ${SEPOLIA_ENV_FILE}, or SIGNET_EVM_RPC_URL in ${ENV_FILE}"
[[ -n "$E2E_FUNDER_KEY" ]] || die "no funder key: set SEPOLIA_FUNDER_KEY in ${SEPOLIA_ENV_FILE} (mode 600, never in this repo)"

# ── the console must be up and must say the bridge is available ─────────────
CID="$(dc ps -q aa-console 2>/dev/null | head -1 || true)"
[[ -n "$CID" ]] || die "no running aa-console for project '${COMPOSE_PROJECT_NAME}' — ./up.sh --with aa --with signet"
if ! docker exec "$CID" bun -e '
  const r = await fetch("http://127.0.0.1:8090/api/info");
  const j = await r.json();
  if (!j.bridge?.available) { console.error((j.bridge?.reasons ?? ["unknown"]).join("; ")); process.exit(1); }
  console.log(`bridge available on EVM chain ${j.bridge.chainId} (${j.bridge.attestation})`);
'; then
  die "the console reports the bridge as unavailable (see the reason above)"
fi

# ── hand the secrets over in a file, not on a command line ──────────────────
SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aa-bridge-e2e.XXXXXX")"
chmod 700 "$SECRET_DIR"
cleanup() { rm -rf "$SECRET_DIR"; }
trap cleanup EXIT INT TERM
SECRET_FILE="$SECRET_DIR/e2e.env"
umask 077
{
  printf 'export AA_BRIDGE_E2E_RPC_URL=%q\n' "$E2E_RPC_URL"
  printf 'export AA_BRIDGE_E2E_FUNDER_KEY=%q\n' "$E2E_FUNDER_KEY"
} > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

log "running the bridge e2e (mode ${MODE}; the two device-gated starts are k=18 — expect minutes)"
log "  tokens ${AA_BRIDGE_E2E_TOKEN_A:-USDC} ${AA_BRIDGE_E2E_AMOUNT_A:-0.5} → the account; ${AA_BRIDGE_E2E_TOKEN_B:-WEENUS} ${AA_BRIDGE_E2E_AMOUNT_B:-10} → a fresh Midnight wallet"

# `run --rm --no-deps` on the aa-deploy service: the same image, the same compose network (so
# `aa-console:8090` resolves), the same aa-out volume for the report — and an environment that
# does NOT include the console's RPC URL, which is how the two stay separate.
set +e
dc run --rm --no-deps \
  -v "$SECRET_FILE:/run/aa-bridge-e2e.env:ro" \
  -e "AA_BRIDGE_E2E_MODE=${MODE}" \
  -e "AA_BRIDGE_E2E_URL=${AA_BRIDGE_E2E_URL:-http://aa-console:8090}" \
  -e "AA_BRIDGE_E2E_TOKEN_A=${AA_BRIDGE_E2E_TOKEN_A:-USDC}" \
  -e "AA_BRIDGE_E2E_TOKEN_B=${AA_BRIDGE_E2E_TOKEN_B:-WEENUS}" \
  -e "AA_BRIDGE_E2E_AMOUNT_A=${AA_BRIDGE_E2E_AMOUNT_A:-0.5}" \
  -e "AA_BRIDGE_E2E_AMOUNT_B=${AA_BRIDGE_E2E_AMOUNT_B:-10}" \
  -e "AA_BRIDGE_E2E_WITHDRAW=${AA_BRIDGE_E2E_WITHDRAW:-0.2}" \
  -e "AA_BRIDGE_E2E_OWNER_KEY=${AA_BRIDGE_E2E_OWNER_KEY:-}" \
  --entrypoint sh aa-deploy -c '. /run/aa-bridge-e2e.env && exec bun /aa/runner/aa-bridge-e2e.ts'
RC=$?
set -e

if [[ -n "$EVIDENCE_DIR" ]]; then
  mkdir -p "$EVIDENCE_DIR"
  if docker exec "$CID" cat /aa/out/aa-bridge-e2e.json > "$EVIDENCE_DIR/aa-bridge-e2e.json" 2>/dev/null; then
    ok "report copied to ${EVIDENCE_DIR}/aa-bridge-e2e.json"
  else
    warn "no /aa/out/aa-bridge-e2e.json to copy (the run may have failed before writing it)"
  fi
fi

if (( RC != 0 )); then
  err "the bridge e2e FAILED (exit ${RC})"
  info "  every request it started is PERSISTED: GET /api/bridge/requests, and resume one with"
  info "  POST /api/bridge/relay/<requestId>. Funds at a deposit address are swept by the next"
  info "  successful deposit for the SAME recipient, as long as the chain is not wiped."
  exit "$RC"
fi
ok "bridge e2e PASSED"
