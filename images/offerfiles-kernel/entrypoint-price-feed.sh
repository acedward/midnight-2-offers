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

# ── "" IS NOT UNSET, and here that distinction is load-bearing ───────────────
#
# Compose renders `FOO: ${FOO:-}` for an absent variable as the EMPTY STRING,
# and `ENV.getString(key, default)` in @effectstream/utils returns
# `value ?? defaultValue` — so an empty string is returned AS the value and the
# default never applies. Measured in @effectstream/utils/src/config.ts:
#
#   getString  value ?? defaultValue        → ""  wins over the default
#   getNumber  value == null || value === ""→ the default (blank is safe)
#   getBoolean same as getNumber            → the default (blank is safe)
#
# For COINGECKO_BASE_URL that is not cosmetic: `loadPriceFeedConfig()` would
# hand `baseUrl: ""` to `fetchAssetPrices`, whose own fallback is `??` as well,
# so the request URL becomes the RELATIVE "/simple/price?…" and every cycle
# fails with a network error that names no cause. Unsetting the blank restores
# the code's own https://api.coingecko.com/api/v3.
#
# The numeric knobs are already blank-safe, but they are normalised here too,
# for the same reason compose/poster.yml's entrypoint does it: `docker compose
# exec price-feed env` should show what the process actually used, and a
# metered third-party API is the wrong place to depend on one library's
# blank-handling staying as it is today.
#
# COINGECKO_API_KEY is deliberately NOT in the list: `config.ts` trims it and
# maps "" to null itself, and that "no key" path is a documented, supported
# state whose behaviour must not be changed by this wrapper.
for _pf_env in \
  COINGECKO_BASE_URL \
  PRICE_FEED_INTERVAL_MS PRICE_FEED_REQUEST_SPACING_MS \
  PRICE_FEED_BATCH_SIZE PRICE_FEED_REQUEST_TIMEOUT_MS PRICE_FEED_ASSETS
do
  if [ -z "${!_pf_env:-}" ]; then unset "${_pf_env}"; fi
done
unset _pf_env

echo "[price-feed] starting packages/price-feed/price-feed.dev.ts args: ${*:-<loop>}"
cd /app
exec bun run /app/packages/price-feed/price-feed.dev.ts "$@"
