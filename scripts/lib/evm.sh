# shellcheck shell=bash
#
# Helpers for the umbra-evm profile: JSON-RPC calls, the address mapping, and the waits.
# Sourced by up.sh and verify.sh, never executed. Requires scripts/lib/common.sh to be sourced
# first (load_env must already have run, or run it yourself).
#
# No jq: the host is not assumed to have it (same rule as scripts/lib/toolkit.sh, which borrows
# the jq inside the toolkit image). Extraction is done with grep on the raw body, which is safe
# here because every value read back is a hex string or an integer.

: "${REPO_ROOT:="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"}"

evm_defaults() {
  : "${EVM_RPC_HOST_PORT:=8545}"
  : "${EVM_WS_HOST_PORT:=10021}"
  : "${EVM_CHAIN_ID:=2400}"
  : "${EVM_IMAGE:=midnight-2-offers/umbra-evm:local}"
  : "${EVM_NETWORK_ID:=undeployed}"
  : "${EVM_WAIT_TIMEOUT:=300}"
  export EVM_RPC_HOST_PORT EVM_WS_HOST_PORT EVM_CHAIN_ID EVM_IMAGE EVM_NETWORK_ID EVM_WAIT_TIMEOUT
  EVM_RPC_URL="http://${HOST_ADDR}:${EVM_RPC_HOST_PORT}"
  export EVM_RPC_URL
}

# ── JSON-RPC ─────────────────────────────────────────────────────────────────

# rpc <method> [params-json] — prints the raw response body. Params default to [].
rpc() {
  local method="$1" params="${2:-[]}"
  curl -sf --max-time 20 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "$EVM_RPC_URL" 2>/dev/null
}

# rpc_result <method> [params-json] — prints the STRING value of "result", or nothing.
# Only for methods whose result is a scalar string (quantities, data, addresses).
rpc_result() {
  rpc "$@" | grep -oE '"result"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"result"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' | head -1
}

# rpc_error_code <method> [params-json] — prints the JSON-RPC error code, or nothing when the
# call succeeded. This is the -32004 / -32601 policy check.
rpc_error_code() {
  rpc "$@" | grep -oE '"code"[[:space:]]*:[[:space:]]*-?[0-9]+' | grep -oE -- '-?[0-9]+' | head -1
}

# hex_to_dec <0x…> — decimal value of a hex quantity, via bash arithmetic (63-bit safe).
# Balances in wei overflow this; use hex_is_zero for those instead.
hex_to_dec() {
  local h="${1#0x}"
  [[ -z "$h" ]] && return 1
  printf '%d\n' "$((16#$h))" 2>/dev/null
}

# hex_is_zero <0x…> — true when the quantity is zero, WITHOUT converting to a number. A NIGHT
# balance scaled to wei (×10^12) is far past 2^63, so any arithmetic on it silently overflows.
hex_is_zero() {
  local h="${1#0x}"
  [[ -z "$h" || "$h" =~ ^0+$ ]]
}

# ── waits ────────────────────────────────────────────────────────────────────

# wait_evm_rpc [timeout_secs] — waits until eth_chainId answers over the HOST port.
wait_evm_rpc() {
  local secs="${1:-$EVM_WAIT_TIMEOUT}"
  local deadline=$(( SECONDS + secs ))
  info "waiting for evm-rpc JSON-RPC at ${EVM_RPC_URL} (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    local chain
    chain=$(rpc_result eth_chainId || true)
    if [[ -n "$chain" ]]; then
      ok "evm-rpc answering (eth_chainId=${chain})"
      return 0
    fi
    sleep 3
  done
  err "timeout waiting for evm-rpc at ${EVM_RPC_URL}"
  return 1
}

# evm_ws_handshake [timeout_secs] — asserts the WS surface completes an RFC 6455 handshake over
# the HOST port, i.e. answers `101 Switching Protocols`.
#
# A TCP probe of that port PROVES NOTHING: docker's published-port proxy accepts the connection
# before it dials the container, so `nc -z` succeeds even when nothing inside is listening. That
# is exactly how the container-loopback bind bug hid (see images/umbra-evm/patches/apply.mjs) —
# the port looked open and clients got an unexplained close 1006. curl can do the upgrade request
# without a WebSocket library, which is all this needs.
evm_ws_handshake() {
  local secs="${1:-30}"
  local deadline=$(( SECONDS + secs ))
  local url="http://${HOST_ADDR}:${EVM_WS_HOST_PORT}/"
  info "waiting for a websocket handshake at ws://${HOST_ADDR}:${EVM_WS_HOST_PORT} (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    local head
    # curl holds the upgraded connection open, so --max-time is the exit path, not an error;
    # the status line is already in the output by then.
    head=$(curl -s -i --http1.1 --max-time 4 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      "$url" 2>/dev/null || true)
    if [[ "$head" == *"101"*"Switching Protocols"* ]]; then
      ok "websocket handshake accepted on the host port"
      return 0
    fi
    sleep 2
  done
  err "no websocket handshake at ws://${HOST_ADDR}:${EVM_WS_HOST_PORT} within ${secs}s"
  return 1
}

# ── the Midnight → EVM address mapping ───────────────────────────────────────

# evm_addresses <input...> — for each seed (bare hex) or mn_addr, prints
#   <input>\t<mn_addr>\t<0x evm address>
#
# There is no way to compute this on the host: the mapping is
# keccak256(bech32m payload)[12:32] over an address derived with the Midnight HD wallet SDK.
# tools/evm-address.ts in the umbra-evm image does it with the very code the wallet monitor uses,
# so what this prints is what the monitor watches. `--no-deps` keeps postgres/indexer out of it —
# the tool touches neither.
evm_addresses() {
  evm_tool tools/evm-address.ts --net "$EVM_NETWORK_ID" "$@" 2>/dev/null
}

# evm_tool <script-in-image> [args...] — runs one of images/umbra-evm/tools/* in a throwaway
# container on the compose network.
#
# It runs as the `wallet-monitor` service and NEVER as `evm-rpc`, deliberately: a `compose run`
# container inherits its service's network alias, so probing `ws://evm-rpc:10021` from a
# `run evm-rpc` container can resolve to the throwaway container itself instead of the live
# server — a check that would pass while the real service was down. Borrowing the other service's
# identity removes the ambiguity. `--no-deps` keeps postgres and the indexer out of it.
evm_tool() {
  dc run --rm --no-deps -T wallet-monitor npx tsx "$@"
}

# evm_address_of <seed-or-mn_addr> — just the 0x address.
evm_address_of() {
  evm_addresses "$1" | awk -F'\t' 'NF>=3 {print $3; exit}'
}

# ── wallets.json ─────────────────────────────────────────────────────────────

# watched_wallet_inputs — the identifiers wallet-monitor is configured to watch, one per line,
# read from the same env the compose fragment reads so the two can never disagree.
watched_wallet_inputs() {
  local seeds="${EVM_WATCH_SEEDS-}" addrs="${EVM_WATCH_ADDRESSES-}"
  # Mirror compose/evm.yml's defaults when .env does not set them.
  if [[ -z "$seeds" && -z "$addrs" ]]; then
    seeds="0000000000000000000000000000000000000000000000000000000000000001,0000000000000000000000000000000000000000000000000000000000000002,0000000000000000000000000000000000000000000000000000000000000003"
    addrs="mn_addr_undeployed1nqhdatus5d6tvye57q854kdrs6ur2ytsl8yaygzfsdy2e3tvtmesdcgp8m,mn_addr_undeployed14tjhxluvt773ry7hta5ysvhymjk6usyhlgauzt4al9t8lpe4gtzqvnj8gs,mn_addr_undeployed1va25tg7d43rcftqeafs6dn3mvycut9zffq989my7p6c8kr0djl5shn25qj,mn_addr_undeployed1ctfkn3nhju6f8p4t92ay0k30eswc4n9s60rjq2s3rkearf454tgqh6ckgy"
  fi
  local item
  for item in ${seeds//,/ } ${addrs//,/ }; do
    if [[ -n "$item" ]]; then printf '%s\n' "$item"; fi
  done
}
