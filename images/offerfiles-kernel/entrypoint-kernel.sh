#!/bin/bash
# kernel — the offer-files SYNC NODE. ONE process.
#
# It was two until T11.4: an embedded PGLite plus the node, supervised together.
# The stack now has a single shared PostgreSQL (compose/core.yml `postgres`,
# database `offerfiles`), so the store is somebody else's container and this one
# is a plain `exec`.
#
# THE CONSEQUENCE IS THE POINT: the offer book now survives a kernel restart.
# PGLite lived in the container's filesystem, so recreating the kernel threw the
# book away and it re-indexed from Celestia height 1. The book is a projection
# either way — but it is now a projection that persists.
#
# `PGLITE=false` is what selects the real server in @effectstream/db, and it is
# NOT the default (ENV.PGLITE defaults to true), so it has to be passed
# explicitly — compose does that, along with DB_HOST/DB_PORT/DB_USER/DB_PW/
# DB_NAME. This entrypoint asserts they arrived rather than letting the node
# fall back to localhost:5432 and fail with a confusing connection error.
#
# NO orchestrator: `bunx orchestrator start start.external.ts` launched six
# processes here and re-deployed the contract on every recreate. main.dev.ts is
# a plain single-process bun entrypoint.

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=kernel

load_celestia_env
run_preflight "$ROLE"
load_contract_address "$ROLE"

# Fail fast and legibly on a half-configured database. Without PGLITE=false the
# node would silently use the embedded path this phase removed; without DB_HOST
# it would dial localhost and time out against nothing.
if [ "${PGLITE:-}" != "false" ]; then
  log "$ROLE" "FATAL: PGLITE must be exactly 'false' (got '${PGLITE:-unset}')."
  log "$ROLE" "The kernel uses the shared postgres service; the embedded store is gone."
  exit 1
fi
for v in DB_HOST DB_PORT DB_USER DB_PW DB_NAME; do
  if [ -z "${!v:-}" ]; then
    log "$ROLE" "FATAL: ${v} is not set — the shared postgres connection is incomplete"
    exit 1
  fi
done

# Wait for the shared server to accept a connection. compose already gates on
# its healthcheck, but a kernel that starts a moment early should retry rather
# than crash into a restart loop that looks like a kernel fault.
log "$ROLE" "waiting for postgres at ${DB_HOST}:${DB_PORT} (database ${DB_NAME})"
for attempt in $(seq 1 60); do
  if DB_PROBE_HOST="$DB_HOST" DB_PROBE_PORT="$DB_PORT" bun -e '
       const s = await Bun.connect({
         hostname: process.env.DB_PROBE_HOST,
         port: Number(process.env.DB_PROBE_PORT),
         socket: { data() {} },
       }).catch(() => null);
       if (!s) process.exit(1);
       s.end();' 2>/dev/null; then
    log "$ROLE" "postgres is accepting connections"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    log "$ROLE" "FATAL: postgres at ${DB_HOST}:${DB_PORT} did not accept a connection in 60s"
    exit 1
  fi
  sleep 1
done

log "$ROLE" "starting the sync node (API :9999)"
exec bun run /app/packages/node/main.dev.ts
