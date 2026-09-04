#!/usr/bin/env bash
# entrypoint-solver.sh — run the pinned COW solver as `start.solver.ts`, behind
# this demo's `undeployed`-only gate.
#
# WHY THIS SHIM EXISTS AT ALL. Until the ledger-v9 re-pin this image's
# ENTRYPOINT was `bun run packages/solver/solver.dev.ts`, chosen because that
# file REFUSES to start on anything but MIDNIGHT_NETWORK_ID=undeployed — the
# inherited NO-GO-for-real-funds posture, enforced by the binary rather than by
# a compose value. But `solver.dev.ts` calls `runSolver({ signal })` and passes
# no `status`, and `runSolver` starts the read-only status listener ONLY when
# that option is present (packages/solver/src/run.ts: "Everything below is inert
# when `opts.status` is absent"). So on solver.dev.ts the 00007 status listener
# can never come up, no matter what SOLVER_STATUS_* say, and the monitor site
# would render SOLVER UNREACHABLE forever.
#
# `start.solver.ts` is upstream's ONE documented way to run the solver as its
# own component: it resolves every boundary in a single pass, prints one message
# listing EVERY problem at once, and wires `status: config.status`. It is what
# the kernel's own deployment runs (deploy/images/kernel/entrypoint-solver.sh).
# What it does NOT have is the network gate — it is written to run on preview
# and mainnet too.
#
# So the gate moves here, ahead of the exec, and stays a hard refusal rather
# than a warning: this stack has one chain, its genesis is thrown away by
# `./down.sh -v`, and a solver pointed at a real network by an edited .env must
# fail closed. The check is on the RESOLVED value the SDK will use, which is why
# it also refuses an unset MIDNIGHT_NETWORK_ID (the SDK silently defaults).
set -euo pipefail

log() { echo "[solver-entrypoint] $*" >&2; }

if [ "${MIDNIGHT_NETWORK_ID:-}" != "undeployed" ]; then
  log "REFUSING TO START: MIDNIGHT_NETWORK_ID=${MIDNIGHT_NETWORK_ID:-<unset>}, expected 'undeployed'."
  log "This image is the midnight-2-offers demo solver. It is observation-only"
  log "against a throwaway devnet and must never attach to a real network."
  exit 1
fi

# "" is not "unset". `start.solver.ts`'s resolver treats an empty string as a
# PRESENT value for several optional knobs (an empty SOLVER_LADDER_CONFIG would
# be used as a path), so a blank one from `.env` has to be removed before the
# process sees it. Mirrors the kernel deployment's entrypoint-common.sh.
for _solver_env in \
  SOLVER_SUPPORTED_PAIRS \
  SOLVER_MIN_JOB_OUTPUT \
  SOLVER_LADDER_CONFIG \
  SOLVER_FEE_SIZING_TAKER_INPUTS \
  SOLVER_DUST_MAX_PER_JOB \
  SOLVER_DUST_MAX_PER_WINDOW \
  SOLVER_DUST_WINDOW_MS
do
  if [ -z "${!_solver_env:-}" ]; then unset "${_solver_env}"; fi
done
unset _solver_env

log "MIDNIGHT_NETWORK_ID=undeployed — starting start.solver.ts (banner follows)"
cd /app
exec bun run /app/start.solver.ts
