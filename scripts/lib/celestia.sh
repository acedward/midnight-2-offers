# shellcheck shell=bash
#
# Helpers for the `offerfiles` profile's Celestia devnet: the auth token, the namespace, the DA
# JSON-RPC, and the waits. Sourced by up.sh and verify.sh, never executed. Requires
# scripts/lib/common.sh to have been sourced and load_env to have run.
#
# TWO RULES THIS FILE FOLLOWS, both learned the hard way in earlier phases:
#
#   * Everything talks to the DA RPC over the PUBLISHED HOST PORT, with curl, from the host.
#     That is the only thing that proves the endpoint a human or a browser would use actually
#     works. It is also why nothing here uses `nc -z`: docker's port proxy accepts a connection
#     before it dials the container, so a TCP probe of a published port reports a working service
#     that refuses every client (P3's WebSocket defect).
#   * No jq on the host. The toolkit scripts borrow the jq inside a container for the same
#     reason; here the values read back are all integers or base64, so grep on the raw body is
#     safe. The one genuinely binary operation — expanding the 10-byte namespace suffix into the
#     29 wire bytes — is done by `celestia-namespace` INSIDE the image, so the host needs no
#     xxd/python.

: "${REPO_ROOT:="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"}"

celestia_defaults() {
  : "${CELESTIA_HOST_PORT:=26658}"
  # The MIP-0006 SHARED namespace (ASCII `mn-swap-v1`) — the kernel's own code default, and the
  # one value every compliant publisher and reader is supposed to use. `000000000000deadbeef` is
  # the kernel's hosted-preview override, kept as a documented example in .env.example. Q11.
  : "${CELESTIA_NAMESPACE:=6d6e2d737761702d7631}"
  : "${CELESTIA_CHAIN_ID:=test}"
  : "${CELESTIA_NETWORK:=devnet}"
  : "${CELESTIA_IMAGE:=midnight-2-offers/celestia:local}"
  : "${CELESTIA_SKIP_AUTH:=false}"
  : "${CELESTIA_WAIT_TIMEOUT:=300}"
  : "${CELESTIA_GAS_PRICE:=0.002}"
  export CELESTIA_HOST_PORT CELESTIA_NAMESPACE CELESTIA_CHAIN_ID CELESTIA_NETWORK \
         CELESTIA_IMAGE CELESTIA_SKIP_AUTH CELESTIA_WAIT_TIMEOUT CELESTIA_GAS_PRICE
  CELESTIA_DA_URL="http://${HOST_ADDR}:${CELESTIA_HOST_PORT}"
  export CELESTIA_DA_URL
}

# ── the auth token ───────────────────────────────────────────────────────────
# The token is minted inside the container (it is signed with a secret in the bridge node's
# store) and written to the shared `celestia-auth` volume. A host script cannot compute it, so it
# asks the container for it. Cached in CELESTIA_AUTH_TOKEN: `compose exec` costs about a second
# and this is called per RPC call.
#
# This is the same handoff a future kernel service uses, approached from the other side: the
# container reads the file off the volume, the host reads it through exec.
celestia_token() {
  if [[ "${CELESTIA_SKIP_AUTH:-false}" == "true" || "${CELESTIA_SKIP_AUTH:-false}" == "1" ]]; then
    printf ''
    return 0
  fi
  if [[ -z "${CELESTIA_AUTH_TOKEN:-}" ]]; then
    CELESTIA_AUTH_TOKEN="$(dc exec -T celestia celestia-token 2>/dev/null | tr -d '\r\n')" || return 1
    export CELESTIA_AUTH_TOKEN
  fi
  [[ -n "$CELESTIA_AUTH_TOKEN" ]] || return 1
  printf '%s' "$CELESTIA_AUTH_TOKEN"
}

# celestia_namespace_b64 — the configured namespace as the 29 wire bytes, base64.
# Computed by the image so the host and the kernel cannot disagree about the expansion.
celestia_namespace_b64() {
  if [[ -z "${CELESTIA_NS_B64:-}" ]]; then
    CELESTIA_NS_B64="$(dc exec -T celestia celestia-namespace --base64 2>/dev/null | tr -d '\r\n')" || return 1
    export CELESTIA_NS_B64
  fi
  [[ -n "$CELESTIA_NS_B64" ]] || return 1
  printf '%s' "$CELESTIA_NS_B64"
}

# ── JSON-RPC over the published host port ────────────────────────────────────

# cel_rpc <method> [params-json] — prints the raw response body.
# `auth` stays EMPTY when no token is available, so it is expanded as ${auth[@]+"${auth[@]}"}:
# macOS ships bash 3.2, where "${auth[@]}" on an empty array under `set -u` is an "unbound
# variable" error rather than zero words. See the same note in lib/common.sh's dc().
cel_rpc() {
  local method="$1" params="${2:-[]}" token auth=()
  token="$(celestia_token || true)"
  [[ -n "$token" ]] && auth=(-H "Authorization: Bearer ${token}")
  curl -sS --max-time 30 -H 'Content-Type: application/json' ${auth[@]+"${auth[@]}"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "$CELESTIA_DA_URL" 2>/dev/null
}

# cel_rpc_error <body> — prints the error message when the response carries one.
cel_rpc_error() {
  printf '%s' "$1" | grep -oE '"error"[[:space:]]*:[[:space:]]*\{[^}]*\}' | head -1
}

# celestia_head_height — the network head height, decimal.
#
# `header.NetworkHead` returns an ExtendedHeader whose FIRST "height" is the header's own (the
# later ones, in `commit`, carry the same value), so head -1 is correct. The field has been a
# string in some versions and a number in others; both shapes are accepted.
celestia_head_height() {
  cel_rpc header.NetworkHead \
    | grep -oE '"height"[[:space:]]*:[[:space:]]*"?[0-9]+"?' \
    | grep -oE '[0-9]+' | head -1
}

# celestia_bridge_balance — utia held by the bridge wallet (the account that pays for blobs).
celestia_bridge_balance() {
  cel_rpc state.Balance \
    | grep -oE '"amount"[[:space:]]*:[[:space:]]*"?[0-9]+"?' \
    | grep -oE '[0-9]+' | head -1
}

# ── waits ────────────────────────────────────────────────────────────────────

# wait_celestia_rpc [timeout_secs] — waits until the DA RPC answers header.NetworkHead over the
# HOST port with a height >= 1. This is readiness, not liveness: the bridge accepts connections
# before it has a chain view.
wait_celestia_rpc() {
  local secs="${1:-${CELESTIA_WAIT_TIMEOUT:-300}}"
  local deadline=$(( SECONDS + secs )) h=""
  info "waiting for the Celestia DA RPC at ${CELESTIA_DA_URL} (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    h="$(celestia_head_height || true)"
    if [[ -n "$h" ]] && (( h >= 1 )); then
      ok "DA RPC answering (network head ${h})"
      return 0
    fi
    sleep 3
  done
  err "the Celestia DA RPC did not answer at ${CELESTIA_DA_URL} within ${secs}s"
  return 1
}

# wait_celestia_head_advances [timeout_secs] — asserts the devnet is PRODUCING blocks, not merely
# answering with a height it reached once and stopped at.
wait_celestia_head_advances() {
  local secs="${1:-90}"
  local deadline=$(( SECONDS + secs )) first="" cur=""
  info "waiting for the Celestia head to advance (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    cur="$(celestia_head_height || true)"
    if [[ -n "$cur" ]]; then
      if [[ -z "$first" ]]; then
        first="$cur"
        dim "network head starts at ${first}"
      elif (( cur > first )); then
        ok "Celestia head advanced ${first} → ${cur}"
        return 0
      fi
    fi
    sleep 3
  done
  err "the Celestia head did not advance within ${secs}s (last seen: ${cur:-none})"
  return 1
}
