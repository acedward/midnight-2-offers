# cow-solver-sink — the demo-side WS sink the ported COW solver pushes to.
#
# Tiny by design: one Bun file, no dependencies, no package.json. It stands in
# for the RECEIVE half of the Midnight Intents relay, which this demo dropped
# (user decision Q14 → option D). It never sends the solver anything, which is
# what keeps the solver in observation mode — see sink/server.ts's header.
#
# Bun is pinned to the same 1.3.11 the kernel image pins, for one reason: the
# whole ledger-v9 migration was validated on it and a split runtime version
# across two services in one stack is a variable nobody wants to debug later.

FROM oven/bun:1.3.11

WORKDIR /app

# Source only — nothing is installed, so there is no lockfile to honour and no
# network step in this build.
COPY wire.ts server.ts ./

# :8080 observation (GET /api/snapshot + /health), :8081 solver ingress (bearer
# WS + GET /jobs/:jobId + GET /tokens). Two listeners so the authenticated
# ingress and the read-only observation surface stay separable. NEITHER is
# published to the host: the sink's own feed page was retired in favour of the
# upstream solver-frontend monitor, so there is no browser on either port.
EXPOSE 8080 8081

# Bun runs the TypeScript directly; no build step.
CMD ["bun", "run", "/app/server.ts"]
