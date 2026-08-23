#!/usr/bin/env bash
#
# Is this devnet actually able to accept a blob?
#
# THREE THINGS ARE ASSERTED, and each one has a failure mode the others cannot see:
#
#   1. the bootstrap finished        — the ready marker, written only after the bridge wallet is
#                                      funded. Between "the RPC answers" and "the wallet has
#                                      money" every blob.Submit fails at the fee.
#   2. the DA RPC answers, WITH AUTH — an authenticated `header.NetworkHead` returning a height
#                                      >= 1. This is the call the kernel's own readiness test
#                                      makes (packages/tests/infra/celestia-ready.test.ts) and it
#                                      exercises the token, the JSON-RPC layer, and the bridge's
#                                      view of the chain in one round trip.
#   3. the wallet can pay            — `state.Balance` > 0, read from the bridge itself, which is
#                                      the number a blob submission is priced against.
#
# WHAT IS DELIBERATELY NOT DONE: probing the port. `wait-on tcp:26658` is how the kernel's dev
# orchestrator gates on Celestia, and P3 proved that a TCP probe of a *published* port is
# worthless — docker's proxy accepts the connection before it dials the container, so the probe
# passes while every client is refused. Here the probe is in-container so the proxy is not in the
# path, but the deeper point stands: "the socket accepts" is not "the service serves".
#
# Also not done: submitting a blob. That costs a fee and writes to the chain every few seconds
# for the life of the container. verify.sh does the real round trip, once, from the host.
#
set -uo pipefail

RPC_PORT="${CELESTIA_RPC_PORT:-26658}"
AUTH_DIR="${CELESTIA_AUTH_DIR:-/celestia/auth}"
STATE_DIR="${CELESTIA_STATE_DIR:-/var/lib/celestia/state}"
TOKEN_FILE="${AUTH_DIR}/token"
READY_FILE="${STATE_DIR}/ready"
SKIP_AUTH="${CELESTIA_SKIP_AUTH:-false}"

fail() { printf 'unhealthy: %s\n' "$*" >&2; exit 1; }

[[ -f "$READY_FILE" ]] || fail "the bootstrap has not completed (no ${READY_FILE})"

AUTH=()
if [[ "$SKIP_AUTH" != "true" && "$SKIP_AUTH" != "1" ]]; then
  [[ -s "$TOKEN_FILE" ]] || fail "no auth token at ${TOKEN_FILE}"
  AUTH=(-H "Authorization: Bearer $(cat "$TOKEN_FILE")")
fi

rpc() {
  curl -sS --max-time 8 -H 'Content-Type: application/json' "${AUTH[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" \
    "http://127.0.0.1:${RPC_PORT}"
}

HEAD="$(rpc header.NetworkHead)" || fail "header.NetworkHead: no answer from the DA RPC"
HEIGHT="$(printf '%s' "$HEAD" | jq -r '.result.header.height // empty' 2>/dev/null)"
case "$HEIGHT" in
  ''|*[!0-9]*) fail "header.NetworkHead returned no height: ${HEAD:0:200}" ;;
esac
(( HEIGHT >= 1 )) || fail "network head is at height ${HEIGHT}"

BAL="$(rpc state.Balance)" || fail "state.Balance: no answer from the DA RPC"
AMOUNT="$(printf '%s' "$BAL" | jq -r '.result.amount // empty' 2>/dev/null)"
case "$AMOUNT" in
  ''|*[!0-9]*) fail "state.Balance returned no amount: ${BAL:0:200}" ;;
esac
(( AMOUNT > 0 )) || fail "the bridge wallet holds 0 utia — it cannot pay for a blob"

printf 'healthy: head=%s bridge-balance=%s utia\n' "$HEIGHT" "$AMOUNT"
