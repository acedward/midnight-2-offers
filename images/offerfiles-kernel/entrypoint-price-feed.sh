#!/bin/bash
# price-feed — the CoinGecko refresh of `asset_prices` (profile `prices`).
#
# `exec bun run packages/price-feed/price-feed.dev.ts "$@"` and nothing else.
#
# IT MUST NOT VALIDATE THE SERVICE'S OWN CONFIGURATION — upstream's copy of this
# script says the same thing in capitals, and the reason is worth repeating:
# `packages/price-feed/src/run.ts` decides what a missing key means, and the two
# modes differ deliberately.
#
#   --once      prints the warning and exits 64.
#   loop mode   prints the warning at start and on every tick, and IDLES.
#
# That second behaviour is a considered choice, not an oversight: a compose
# service that exited non-zero on a missing key would crash-loop forever under
# `restart: unless-stopped`, printing the same line, while the stack is
# perfectly usable on the seeded prices. A pre-check here would turn that choice
# into a restart loop. The loud refusal for THIS repository lives in `up.sh`,
# which declines to bring the `prices` profile up at all without a key — before
# any container is created.
#
# IT ALSO DOES NOT WAIT FOR ANYTHING. Upstream's copy waits on the database's
# TCP port because its compose gates this service on `pglite` alone; here
# `compose/prices.yml` gates on `postgres: service_healthy` AND
# `kernel: service_healthy`, which is strictly stronger — the kernel is what
# applies `000-init.sql`, so a healthy kernel means the schema this process
# needs already exists. A wait here would only re-prove what compose proved.
#
# ARGUMENTS ARE FORWARDED, which is what makes a single cycle possible:
#
#   docker compose … run --rm price-feed --once
#
# exiting 0 when every asset landed, 2 when the cycle ran but something did not,
# and 64 on a misconfiguration (no key, or a database without the schema).
#
# THE KEY IS NEVER TOUCHED HERE. It arrives as COINGECKO_API_KEY, is read by
# loadPriceFeedConfig(), and leaves as the `x-cg-demo-api-key` request header.
# Nothing in this script reads it, echoes it or passes it on a command line —
# and nothing added later should, because a command line is world-readable
# inside the container and lands in `docker inspect`.
#
# NOTE: this is the kernel's `deploy/images/kernel/entrypoint-price-feed.sh`
# rewritten for THIS repo's conventions — the upstream copy sources an
# entrypoint-common.sh built around the kernel deployment's own paths and waits.
set -euo pipefail

# ── BLANK ENV IS THE SERVICE'S OWN PROBLEM AGAIN (kernel PR #68) ─────────────
#
# This script used to unset every optional knob compose rendered blank, because
# `ENV.getString(key, default)` returns `value ?? default` and an empty string
# therefore WON over the default (00010 Q24). For COINGECKO_BASE_URL that turned
# every request into the relative "/simple/price?…" and every cycle failed with a
# network error naming no cause — and compose renders `FOO: ${FOO:-}` as "" for
# any variable the operator did not set, so it was the DEFAULT state, not an
# edge case.
#
# The pinned kernel fixes it at the source: `packages/price-feed/src/env.ts`
# (new at KERNEL_REF 80bace3) adds `optionalString`/`optionalNumber`, which treat
# blank — and whitespace-only — as unset, and `loadPriceFeedConfig()` reads every
# optional knob through them. Upstream removed the same workaround from its own
# `entrypoint-common.sh` in the same commit, stating that the config loader owns
# those semantics so a direct `bun run` behaves like a Compose launch.
#
# So the workaround is GONE rather than kept "just in case": a wrapper that
# silently rewrites the environment is a second, invisible configuration layer,
# and keeping it would hide a regression in the fix instead of surfacing it.
# `scripts/verify-prices.sh` is the gate — a stack whose .env leaves
# COINGECKO_BASE_URL blank must still complete a cycle, and it does so through
# the library's own default now.
#
# COINGECKO_API_KEY was never in that list and still is not: `config.ts` trims it
# and maps "" to null itself, and that "no key" path is a supported state.

echo "[price-feed] starting packages/price-feed/price-feed.dev.ts args: ${*:-<loop>}"
cd /app
exec bun run /app/packages/price-feed/price-feed.dev.ts "$@"
