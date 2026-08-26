#!/bin/bash
# kernel — the offer-files SYNC NODE, and nothing else.
#
# Two processes, and only two: PGLite and main.dev.ts. PGLite is a real
# Postgres-wire server the node dials over TCP, not an in-process library, so
# it cannot be folded into the node — T11.1's verdict is that it therefore
# stays in THIS container as the node's embedded store rather than becoming a
# service of its own. (Running a real Postgres instead is a supported path
# upstream — PGLITE=false + DB_PORT — and is recorded as Q-P11, not done here.)
#
# NOT the orchestrator: `bunx orchestrator start start.external.ts` launched six
# processes here, re-deployed the contract on every recreate, and made a
# container restart mean "restart everything". main.dev.ts and
# packages/node/pglite.dev.ts are both plain single-process bun entrypoints.
#
# The supervisor below is deliberate. A shell that backgrounds PGLite and
# `exec`s the node would leave a dead database invisible to Docker: the node
# would keep running against nothing and the container would stay "up". Here,
# whichever process exits first takes the container down with its status, so
# compose's restart policy and the healthcheck both see the truth.

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=kernel
DB_PORT="${DB_PORT:-5432}"

load_celestia_env
run_preflight "$ROLE"
load_contract_address "$ROLE"

log "$ROLE" "starting PGLite on :${DB_PORT}"
bun run /app/packages/node/pglite.dev.ts --port "$DB_PORT" &
PGLITE_PID=$!

# Wait for the store to accept connections before the node tries to migrate
# against it. Bounded: a PGLite that never listens is a failure, not a reason
# to hang a bring-up until compose's start_period runs out with no explanation.
for _ in $(seq 1 60); do
  if bun -e 'const s=await Bun.connect({hostname:"127.0.0.1",port:Number(process.argv[2]),socket:{data(){}}}).catch(()=>null); if(!s) process.exit(1); s.end();' \
       -- "$DB_PORT" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$PGLITE_PID" 2>/dev/null; then
    log "$ROLE" "FATAL: PGLite exited before it listened on :${DB_PORT}"
    wait "$PGLITE_PID"; exit 1
  fi
  sleep 1
done
log "$ROLE" "PGLite is accepting connections"

log "$ROLE" "starting the sync node (API :9999)"
PGLITE=true bun run /app/packages/node/main.dev.ts &
NODE_PID=$!

# Forward a container stop to both children so PGLite gets the SIGTERM its
# graceful close is written for, instead of being SIGKILLed with the container.
shutdown() {
  log "$ROLE" "stopping"
  kill -TERM "$NODE_PID" "$PGLITE_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  wait "$PGLITE_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Whichever exits first decides the container's fate.
wait -n "$PGLITE_PID" "$NODE_PID"
STATUS=$?

if kill -0 "$NODE_PID" 2>/dev/null; then
  log "$ROLE" "PGLite exited (${STATUS}) — taking the sync node down with it"
else
  log "$ROLE" "the sync node exited (${STATUS}) — taking PGLite down with it"
fi
kill -TERM "$NODE_PID" "$PGLITE_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$STATUS"
