#!/bin/sh
#
# zswap-da frontend — runtime configuration, rewritten on every container start.
#
# The image is built ONCE and run on ANY port layout, so nothing that depends on
# the stack's published ports may be baked into the bundle. This script writes
# /usr/share/nginx/html/config.js, which index.html loads BEFORE the bundle, so
# src/config.ts and src/services/api.ts see the values when they evaluate.
#
#   window.API_BASE             kernel API base   (absent -> the template's own
#                                                  http://<page host>:9999)
#   window.BATCHER_URL          batcher base      (absent -> http://<page host>:3334)
#   window.MIDNIGHT_HOST_PORTS  compose hostname -> PUBLISHED host port
#
# MIDNIGHT_HOST_PORTS is the one fact only Docker knows. GET /v1/midnight/config
# hands the page the URIs the KERNEL dials — compose hostnames on CONTAINER
# ports (indexer:8088, proof-server:6300) — and browser-network-urls.patch
# rewrites the host to the page's own host. Without a port map it must also keep
# the port, which is correct ONLY when the stack published each service on its
# container port; scripts/pick-ports.sh deliberately does not, and the in-page
# wallet then never syncs. The map is emitted with the CONTAINER ports as
# defaults, so a default-layout stack gets an identity map and behaves exactly
# as it always has.
#
# The node is in the map even though the kernel never reports a node URI: the
# template falls back to http://<page host>:9944, and the map is the only way
# that port can follow the stack.
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

{
  [ -n "${API_BASE:-}" ]    && printf 'window.API_BASE = "%s";\n' "${API_BASE}"
  [ -n "${BATCHER_URL:-}" ] && printf 'window.BATCHER_URL = "%s";\n' "${BATCHER_URL}"
  printf 'window.MIDNIGHT_HOST_PORTS = {"node":"%s","indexer":"%s","proof-server":"%s"};\n' \
    "$NODE_PORT" "$INDEXER_PORT" "$PROOF_PORT"
  :
} > "$CONFIG_JS"

exec nginx -g "daemon off;"
