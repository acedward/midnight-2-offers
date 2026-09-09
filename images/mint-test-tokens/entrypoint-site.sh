#!/usr/bin/env bash
# faucet-site — the static mint-test-tokens directory, served by upstream's own static server.
#
# SELF-CONTAINED on purpose: the `site` target carries no chain, no seed and no `.git`, so it
# does not source images/mint-test-tokens/entrypoint-common.sh. Everything that prelude offers
# — endpoint waits, seed rendering, registry summaries — belongs to the runner target, and a
# page server that could read a seed variable is a page server that can leak one.
#
# WHY NOT NGINX, when images/shielded-night uses it: the registry is NOT a file in the document
# root. `frontend/scripts/serve-static.mjs` answers `/metadata.{network}.json` out of a
# SEPARATE directory (MINT_METADATA_DIR), re-opened by path on every request, with
# `Access-Control-Allow-Origin: *` and `no-cache`. That is exactly what makes the deploy's
# atomic rename visible to a browser without restarting anything — and it is why compose mounts
# the DIRECTORY read-only rather than the JSON file (docs/registry.md: a single-file bind mount
# stays attached to the previous inode).
#
# IT BLOCKS ON THE REGISTRY rather than serving the page immediately. Compose already gates
# this service on `faucet-verify`, but a restart policy, a `docker compose up` against a stack
# whose core is already running, or a manual restart can all start this container while the
# volume is still empty — and upstream renders a missing local registry as "unavailable" with
# every mint control disabled, which reads as a broken deployment rather than as the race it is.
set -euo pipefail

log() { printf '[faucet-site] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

MN_NETWORK="${MN_NETWORK:-undeployed}"
MINT_SITE_DIR="${MINT_SITE_DIR:-dist}"
MINT_METADATA_DIR="${MINT_METADATA_DIR:-/registry}"
MINT_SITE_PORT="${MINT_SITE_PORT:-14119}"
export MINT_SITE_DIR MINT_METADATA_DIR MINT_SITE_PORT

REGISTRY_FILE="${MINT_METADATA_DIR}/metadata.${MN_NETWORK}.json"
WAIT_S="${FAUCET_SITE_WAIT_TIMEOUT:-900}"

waited=0
while [ ! -s "${REGISTRY_FILE}" ]; do
  if [ "${waited}" -eq 0 ]; then
    log "waiting for ${REGISTRY_FILE} (up to ${WAIT_S}s) — faucet-deploy publishes it"
  fi
  if [ "${waited}" -ge "${WAIT_S}" ]; then
    die "no ${REGISTRY_FILE} after ${WAIT_S}s; the site would serve an 'unavailable' page"
  fi
  sleep 3
  waited=$(( waited + 3 ))
done
if [ "${waited}" -gt 0 ]; then log "registry appeared after ${waited}s"; fi

log "serving ${MINT_SITE_DIR} on :${MINT_SITE_PORT}, registry directory ${MINT_METADATA_DIR}"
log "open /?network=${MN_NETWORK}"

cd /app || die "no /app"
# Upstream's documented command, unchanged: `serve:local` is `node scripts/serve-static.mjs`
# and needs no node_modules. `exec` so the server is PID 1 and compose's SIGTERM reaches it —
# the script installs its own SIGINT/SIGTERM handlers and closes the listener cleanly.
exec npm --prefix frontend run --silent serve:local
