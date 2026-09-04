#!/bin/bash
# solver-frontend — the COW solver's read-only monitor site (:8080).
#
# `exec bun run start.solver-frontend.ts` and nothing else. That root script is
# upstream's ONE documented way to run the site; it resolves every boundary in a
# side-effect-free pass and exits 1 listing EVERY problem at once before the
# listener binds, so a pre-check here would shadow the real fail-fast and prove
# only that this shell script works.
#
# IT DOES NOT WAIT FOR THE SOLVER, and that is the point of the service. Every
# other entrypoint in this image waits for what it needs, because a kernel that
# starts into a missing node is a bug. This one is the opposite: the moment
# anyone opens the monitor is the moment the solver is down, so an unreachable
# solver is a RENDERED STATE ("SOLVER UNREACHABLE", with the time it was last
# seen), never a reason to refuse to start.
#
# It also does NOT read the contract address, and its compose service does not
# mount the deploy volume: the page labels colours from the kernel's own
# `GET /v1/known-tokens` and falls back to short hex, so it has no use for the
# deployed identity.
#
# NOTE: this is the kernel's `deploy/images/kernel/entrypoint-solver-frontend.sh`
# rewritten for THIS repo's conventions — the upstream copy sources an
# entrypoint-common.sh built around the kernel deployment's own paths.
set -euo pipefail

echo "[solver-frontend] starting start.solver-frontend.ts — the banner follows"
cd /app
exec bun run /app/start.solver-frontend.ts
