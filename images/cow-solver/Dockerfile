# cow-solver — the ported COW posted-price solver, in OBSERVATION mode.
#
# Source: effectstream/zswap-offerfiles-kernel, branch `00001-solver-v9` — the
# ledger-v9 port of PR #48 `feat/cow-solver`, stacked on `00001-ledger-v9`.
#
# ─── WHY THIS BUILDS FROM A LOCAL CONTEXT, UNLIKE images/offerfiles-kernel ───
# That image clones `00001-ledger-v9` from GitHub at build time. This one
# cannot: `00001-solver-v9` is deliberately UNPUSHED (the upstream branch it
# merges, `feat/cow-solver`, belongs to another owner and this integration
# branch is not to be published without a decision). So there is no ref to
# fetch, and the source has to come from the checkout on this machine.
#
# It arrives as a BuildKit NAMED CONTEXT called `kernel`, wired in
# compose/solver.yml via `additional_contexts`. That keeps this Dockerfile's
# own context small (this directory) while the source comes from wherever
# SOLVER_KERNEL_SRC points. BuildKit honours the named context's own
# `.dockerignore` — without it the context is 1.7 GB of node_modules instead of
# ~14 MB.
#
# THAT FILE IS NOT IN THE KERNEL REPO, and cannot be: the kernel repo gitignores
# `.dockerignore` by convention (alongside `docker/` and `docker-compose.yml`).
# Ship it into the checkout once, from the canonical copy beside this file:
#
#     cp images/cow-solver/kernel.dockerignore "$SOLVER_KERNEL_SRC/.dockerignore"
#
# The build still succeeds without it — just slowly, copying 1.7 GB it does not
# need.
#
# CONSEQUENCE, and it is the reason this file is not just a copy of the kernel
# one: `docker build` of this image is NOT reproducible from a git clone of the
# demo repo alone. It needs the kernel checkout on that branch. When
# 00001-solver-v9 is eventually pushed, this should switch to the same
# fetch-from-git stage the kernel image uses, and SOLVER_KERNEL_SRC can go.
#
# ─── THE COMPILED CONTRACT COMES FROM THE CLONE ─────────────────────────────
# The kernel image runs a whole compactc 0.33.0-rc.2 stage (release-asset
# download + SRS fetch + key generation) to produce
# contract-offer-files/src/managed/. This image does NOT, on purpose: the
# observation-mode solver never proves or executes a circuit — it mirrors the
# book and publishes ladders — and the artifacts already exist in any clone
# that has been built. They are gitignored, so a never-built clone will not
# have them; the assertion below turns that into a clear build-time failure
# rather than a module-resolve error at runtime.

FROM oven/bun:1.3.11

WORKDIR /app

# The whole (dockerignore-filtered) branch checkout: workspace manifests,
# lockfile, packages/, and the pre-compiled contract artifacts.
COPY --from=kernel . /app

# Fail the BUILD, not the first import, when the clone was never built. The
# solver's offer-files module value-imports this package at load time even in
# observation mode, so a missing artifact is fatal however little it is used.
RUN set -eux; \
    test -f /app/packages/contracts-midnight/contract-offer-files/src/managed/contract/index.js \
      || { echo "ERROR: the kernel clone has no compiled Compact output." >&2; \
           echo "Run 'bun run build:midnight' in the kernel checkout, then rebuild." >&2; \
           exit 1; }

# Frozen: the lockfile on the branch IS the tested set (the S1 pin
# reconciliation + S2 migration). A drifting install here would silently
# un-pin the single-WASM ledger-v9 override.
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
