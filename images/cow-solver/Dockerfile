# cow-solver — the ported COW posted-price solver, in OBSERVATION mode.
#
# Source: https://github.com/effectstream/zswap-offerfiles-kernel/pull/50,
# branch `00001-solver-v9`, exact SHA
# b1420c4af6ed8b2510140418e5138d282365f9c6. Clean-clone builds fetch that
# upstream commit directly; Cow solver source is not copied into this repo.
# The separate browser SPA is fetched through FRONTEND_REPO/FRONTEND_REF and
# contains no solver implementation.
#
# The compiled offer-files contract comes from the `kernel-image` named build
# context. Compose wires that context to `service:kernel`, which both orders the
# builds and shares the kernel image's already-compiled compactc 0.33.0-rc.2
# artifacts. The solver is observation-only and never proves a circuit, so
# compiling an identical second artifact set would add time and disk for no
# functional coverage.

ARG SOLVER_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG SOLVER_REF=b1420c4af6ed8b2510140418e5138d282365f9c6

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

FROM kernel-image AS kernel-src
FROM kernel-image

WORKDIR /app

# Overlay the pinned solver branch onto the service-built kernel runtime, then
# restore the generated managed artifacts (gitignored in the public source).
# Existing node_modules are retained as an install cache; the solver branch's
# frozen lockfile determines the final dependency graph.
COPY --from=source /src /app
COPY --from=kernel-src /app/packages/contracts-midnight/contract-offer-files/src/managed /app/packages/contracts-midnight/contract-offer-files/src/managed
COPY --from=source /solver-commit /app/.solver-commit

RUN test -f /app/packages/contracts-midnight/contract-offer-files/src/managed/contract/index.js
RUN bun install --frozen-lockfile

# Assert the single-WASM property the whole v9 migration rests on: two ledger
# copies in one process make every cross-copy value fail `instanceof`.
RUN set -eux; \
    count="$(find /app/node_modules -type d -name 'ledger-v9' | wc -l)"; \
    test "$count" -ge 1 || { echo "ERROR: ledger-v9 did not install" >&2; exit 1; }; \
    test ! -d /app/node_modules/@midnight-ntwrk/ledger-v8 \
      || { echo "ERROR: ledger-v8 is present — the v9 pin set did not hold" >&2; exit 1; }

# solver.dev.ts is the `undeployed`-only entrypoint: it refuses to start unless
# MIDNIGHT_NETWORK_ID=undeployed, which is exactly the NO-GO-for-real-funds
# posture this demo inherits. It also honours SOLVER_ENABLED=false by exiting 0.
ENTRYPOINT ["bun", "run", "/app/packages/solver/solver.dev.ts"]
