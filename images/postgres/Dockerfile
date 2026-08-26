# postgres — the ONE PostgreSQL for the whole stack.
#
# Every consumer gets its own database and its own role inside this single
# server (see initdb/10-databases.sh): `umbra` for umbra-evm, `offerfiles` for
# the offer-files kernel. One server rather than one per profile, because an
# idle Postgres is cheap and two of them are two sets of volumes, healthchecks
# and teardown rules to keep straight.
#
# ─── WHY THIS IS NOT JUST `postgres:17-alpine` ──────────────────────────────
# The offer-files kernel needs the `pg_ivm` extension — incrementally
# maintained materialized views. It is NOT optional by default:
# @effectstream/db's capabilities.ts THROWS at startup when pg_ivm is missing
# unless ALLOW_NO_PG_IVM=true, and that flag itself defaults to false. The
# fallback it unlocks is a plain-SQL view strategy that the package's own docs
# describe as degrading sharply on high-cardinality data.
#
# This matters because PGLite — what the kernel used before — DOES ship pg_ivm
# (probed on the live kernel: server_version 17.5, pg_ivm installed). Moving to
# a stock postgres:17-alpine, which does not have it, would have quietly
# demoted the kernel from the production read path to the degraded one. So the
# extension is compiled in here and the kernel keeps exactly the behaviour it
# had.
#
# Pinned to an upstream release tarball rather than a floating clone, for the
# same reason every other image in this repo pins.

ARG PG_TAG=17-alpine

# ── stage 1: compile pg_ivm against this exact server version ───────────────
FROM postgres:${PG_TAG} AS build

ARG PG_IVM_VERSION=1.11

# `with_llvm=no` below is not laziness: this Alpine has no clang19/llvm19
# package, and LLVM is only used to emit optional JIT bitcode. The extension
# itself builds and runs fine without it.
RUN apk add --no-cache build-base postgresql17-dev curl tar

RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -fLsS -o /tmp/pg_ivm.tar.gz \
      "https://github.com/sraoss/pg_ivm/archive/refs/tags/v${PG_IVM_VERSION}.tar.gz"; \
    mkdir -p /tmp/src; \
    tar -xzf /tmp/pg_ivm.tar.gz -C /tmp/src --strip-components=1; \
    cd /tmp/src; \
    make USE_PGXS=1 with_llvm=no; \
    make USE_PGXS=1 with_llvm=no install; \
    # Fail the BUILD if the artifacts are not where the server will look for
    # them — a missing .so would otherwise surface as a kernel startup abort.
    test -f /usr/local/lib/postgresql/pg_ivm.so; \
    test -f /usr/local/share/postgresql/extension/pg_ivm.control

# ── stage 2: the runtime image ──────────────────────────────────────────────
FROM postgres:${PG_TAG}

# Only the extension's own artifacts — none of the build toolchain.
COPY --from=build /usr/local/lib/postgresql/pg_ivm.so /usr/local/lib/postgresql/
COPY --from=build /usr/local/share/postgresql/extension/pg_ivm* /usr/local/share/postgresql/extension/

# Runs ONCE, on an empty data directory, in filename order. Creates one
# database + role per consumer and pre-installs pg_ivm in each as the
# superuser, so an app role never needs superuser to satisfy its own
# best-effort `CREATE EXTENSION IF NOT EXISTS pg_ivm`.
COPY initdb/ /docker-entrypoint-initdb.d/

# Deliberately no EXPOSE-to-host and no ports in compose: this server is
# reachable only on the compose network. Nothing outside the stack talks to it.
EXPOSE 5432
