# cow-solver — the ported COW posted-price solver, in OBSERVATION mode.
#
# Source: https://github.com/effectstream/zswap-offerfiles-kernel/pull/65,
# branch `ledger-v9` (draft at the time of pinning — the SHA is the identity),
# exact SHA 5d794f9a27f6d65529bf176650405f740531d430. Clean-clone builds fetch
# that upstream commit directly; Cow solver source is not copied into this repo.
# The separate browser SPA is fetched through FRONTEND_REPO/FRONTEND_REF and
# contains no solver implementation.
#
# SOLVER_REF and KERNEL_REF are the same commit since the ledger-v9 re-pin (the
# kernel and the solver live on one branch now), and they stay two knobs on
# purpose: the overlay below is what proves the running solver bytes came from
# the SHA `verify-source-pins.sh` expects, and a future divergence must not need
# a Dockerfile change to be expressible.
#
# ── THE CONTRACT OVERLAY IS GONE (KERNEL_REF 5d794f9) ───────────────────────
# This image used to restore the kernel image's compiled offer-files artifacts
# over the solver source, because they are gitignored upstream and `bun install`
# would otherwise leave a workspace that could not resolve them. Kernel PRs
# #69/#70 deleted the contract and the whole `packages/contracts-midnight`
# workspace, so there is nothing to overlay and nothing that imports it — the
# COPY now fails the build outright with "not found", which is how this was
# caught.
#
# The `kernel-image` named build context STAYS, and still earns its keep: it is
# the base layer (so the two images share one bun runtime and one node_modules
# cache) and, because compose wires it to `service:kernel`, it also ORDERS the
# builds. What it no longer carries across is a contract.

ARG SOLVER_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG SOLVER_REF=5d794f9a27f6d65529bf176650405f740531d430

FROM debian:stable-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG SOLVER_REPO
ARG SOLVER_REF

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$SOLVER_REPO" \
 && git fetch -q --depth 1 origin "$SOLVER_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /solver-commit \
 && rm -rf .git

FROM kernel-image

WORKDIR /app

# Overlay the pinned solver branch onto the service-built kernel runtime.
# Existing node_modules are retained as an install cache; the solver branch's
# frozen lockfile determines the final dependency graph.
COPY --from=source /src /app
COPY --from=source /solver-commit /app/.solver-commit

# The contract workspace must be ABSENT, not merely unused. Upstream's own CI
# asserts the same thing inside the kernel image; asserting it here as well is
# what stops a stale `kernel-image` base — one built before the re-pin, which
# would still carry `packages/contracts-midnight` — from silently producing a
# solver image with a contract in it.
RUN test ! -e /app/packages/contracts-midnight
RUN bun install --frozen-lockfile

# Assert the single-WASM property the whole v9 migration rests on: two ledger
# copies in one process make every cross-copy value fail `instanceof`.
RUN set -eux; \
    count="$(find /app/node_modules -type d -name 'ledger-v9' | wc -l)"; \
    test "$count" -ge 1 || { echo "ERROR: ledger-v9 did not install" >&2; exit 1; }; \
    test ! -d /app/node_modules/@midnight-ntwrk/ledger-v8 \
      || { echo "ERROR: ledger-v8 is present — the v9 pin set did not hold" >&2; exit 1; }

# The entrypoint is `start.solver.ts` behind this repo's own `undeployed` gate.
# It USED to be packages/solver/solver.dev.ts, which carries that gate itself —
# but solver.dev.ts calls runSolver() without a `status` option, and the 00007
# read-only status listener is inert unless that option is present. The monitor
# site (`solver-frontend`) has nothing to read on solver.dev.ts. The shim keeps
# the gate and gains the listener; see its header for the full reasoning.
COPY entrypoint-solver.sh /usr/local/bin/entrypoint-solver.sh
RUN chmod +x /usr/local/bin/entrypoint-solver.sh \
 && test -f /app/start.solver.ts \
 && test -f /app/start.solver-frontend.ts
ENTRYPOINT ["/usr/local/bin/entrypoint-solver.sh"]
