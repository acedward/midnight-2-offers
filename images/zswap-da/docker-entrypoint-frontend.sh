#!/bin/sh
#
# zswap-da frontend — runtime configuration, rewritten on every container start.
#
# The image is built ONCE and run on ANY port layout and against ANY chain, so
# nothing that depends on the stack may be baked into the bundle. This script
# writes /usr/share/nginx/html/config.js, which index.html loads BEFORE the
# bundle, so src/config.ts and src/services/api.ts see the values when they
# evaluate.
#
#   window.API_BASE             kernel API base   (absent -> the template's own
#                                                  http://<page host>:9999)
#   window.BATCHER_URL          batcher base      (absent -> http://<page host>:3334)
#   window.MIDNIGHT_HOST_PORTS  compose hostname -> PUBLISHED host port
#   window.MIDNIGHT_NETWORK_ID  the chain this stack runs
#   window.FAUCET_HOST_PORT     the PUBLISHED port of the faucet site
#   window.FAUCET_URL           a complete faucet URL, when it is not on this host
#   window.DEMO_WALLET_SEED     the in-page JS wallet's seed, when the stack has one
#
# MIDNIGHT_HOST_PORTS is the one fact only Docker knows. GET /v1/midnight/config
# hands the page the URIs the KERNEL dials — compose hostnames on CONTAINER
# ports (indexer:8088, proof-server:6300). Upstream already re-points the HOST
# at the pinned template; browser-network-urls.patch maps the PORT through this
# table. Without it the port stays the container's, which is correct ONLY when
# the stack published each service on its container port; scripts/pick-ports.sh
# deliberately does not, and the in-page wallet then never syncs. The map is
# emitted with the CONTAINER ports as defaults, so a default-layout stack gets
# an identity map and behaves exactly as it always has.
#
# The node is in the map even though the kernel never reports a node URI: the
# template falls back to http://<page host>:9944, and the map is the only way
# that port can follow the stack.
#
# MIDNIGHT_NETWORK_ID matters twice. It is the wallet's network id, and it is
# what the Faucet link carries as `?network=` — the mint-test-tokens site serves
# a DIFFERENT registry per network and 404s the one it has no file for, so a
# stack that says `preprod` (upstream's build-time default at this pin) would
# send the operator to a page that knows nothing about these six issuers.
#
# FAUCET_HOST_PORT is the same shape as the port map and for the same reason:
# the container knows which host port compose published for `faucet-site`, and
# only the page knows the host, so the origin is composed in src/config.ts.
# FAUCET_URL wins over it, for a faucet reached through a proxy or a shared one
# on another host.
#
# DEMO_WALLET_SEED exists because the SPA can no longer mint. `connectLocal()`
# generates a RANDOM seed when it is not given one, so the in-page wallet used to
# be a brand-new empty wallet on every page load — which was survivable while the
# template had a faucet contract to mint with, and is not now that #922 removed
# it: an empty wallet has no way to acquire anything, and the external faucet
# site needs an injected extension wallet the demo does not have. With a fixed
# seed the wallet is the STACK's demo wallet, `faucet-mint` can prefund it, and
# it survives a reload. Unset, the bundle keeps upstream's random behaviour,
# which is what anyone serving this dist/ outside the demo wants.
#
# An empty variable is treated as ABSENT — compose renders every unset
# pass-through as "" — so a blank never becomes a literal empty URL or port.
set -eu

CONFIG_JS=/usr/share/nginx/html/config.js

# A non-numeric port would emit JavaScript that silently mis-points the wallet,
# so it fails here instead, naming the variable.
port_or_die() {
  name="$1"; value="$2"; fallback="$3"
  [ -n "$value" ] || value="$fallback"
  case "$value" in
    ''|*[!0-9]*) echo "frontend entrypoint: ${name}='${value}' is not a port number" >&2; exit 78 ;;
  esac
  printf '%s' "$value"
}

NODE_PORT="$(port_or_die NODE_HOST_PORT "${NODE_HOST_PORT:-}" 9944)"
INDEXER_PORT="$(port_or_die INDEXER_HOST_PORT "${INDEXER_HOST_PORT:-}" 8088)"
PROOF_PORT="$(port_or_die PROOF_HOST_PORT "${PROOF_HOST_PORT:-}" 6300)"

# The faucet port has NO fallback on purpose: an unset value means "this stack
# has no local faucet", and the page then keeps the template's own default
# (the public mint-test-tokens site). Guessing 10950 here would render a link
# to a port nothing on this host is listening on and call it configuration.
FAUCET_PORT_VALUE=""
if [ -n "${FAUCET_HOST_PORT:-}" ]; then
  FAUCET_PORT_VALUE="$(port_or_die FAUCET_HOST_PORT "${FAUCET_HOST_PORT}" '')"
fi

# `undeployed` is this demo's chain. It is a default and not a constant so the
# same image can be pointed at preview/preprod by one environment variable.
NETWORK_ID="${MIDNIGHT_NETWORK_ID:-undeployed}"
case "$NETWORK_ID" in
  ''|*[!a-z0-9-]*) echo "frontend entrypoint: MIDNIGHT_NETWORK_ID='${NETWORK_ID}' is not a network name" >&2; exit 78 ;;
esac

# A malformed seed would reach the wallet SDK and fail there, naming nothing —
# and a TRUNCATED one would silently be a different wallet than the one
# faucet-mint funded, which looks exactly like "the mint did not work".
if [ -n "${DEMO_WALLET_SEED:-}" ]; then
  case "${DEMO_WALLET_SEED}" in
    *[!0-9a-f]*|"") echo "frontend entrypoint: DEMO_WALLET_SEED is not lowercase hex" >&2; exit 78 ;;
  esac
  [ "${#DEMO_WALLET_SEED}" -eq 64 ] \
    || { echo "frontend entrypoint: DEMO_WALLET_SEED must be 64 hex characters (32 bytes), got ${#DEMO_WALLET_SEED}" >&2; exit 78; }
fi

{
  [ -n "${API_BASE:-}" ]    && printf 'window.API_BASE = "%s";\n' "${API_BASE}"
  [ -n "${BATCHER_URL:-}" ] && printf 'window.BATCHER_URL = "%s";\n' "${BATCHER_URL}"
  printf 'window.MIDNIGHT_HOST_PORTS = {"node":"%s","indexer":"%s","proof-server":"%s"};\n' \
    "$NODE_PORT" "$INDEXER_PORT" "$PROOF_PORT"
  printf 'window.MIDNIGHT_NETWORK_ID = "%s";\n' "$NETWORK_ID"
  [ -n "$FAUCET_PORT_VALUE" ] && printf 'window.FAUCET_HOST_PORT = "%s";\n' "$FAUCET_PORT_VALUE"
  [ -n "${FAUCET_URL:-}" ]    && printf 'window.FAUCET_URL = "%s";\n' "${FAUCET_URL}"
  [ -n "${DEMO_WALLET_SEED:-}" ] && printf 'window.DEMO_WALLET_SEED = "%s";\n' "${DEMO_WALLET_SEED}"
  :
} > "$CONFIG_JS"

exec nginx -g "daemon off;"
