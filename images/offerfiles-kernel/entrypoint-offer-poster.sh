#!/bin/bash
# offer-poster — mint one exact coin, post one takeable ZSwap offer, repeat.
#
# A LOOP, not a one-shot: every POST_INTERVAL_MS it either re-offers a coin its
# journal says came back, or mints one fresh GIVE_TOKEN coin from the faucet
# circuit (fees from its OWN dust) and posts a single offer whose only input is
# that exact coin. Health/metrics on :9977, journal on its own volume.
#
# ── Why there is no marker file ──────────────────────────────────────────────
# `offerfiles-deploy` writes a marker and exits early on a restart because it is
# a ONE-SHOT. This service is the opposite — a marker would make a restart a
# permanent no-op. Idempotence lives in the JOURNAL instead
# (POSTER_JOURNAL_FILE, on its own volume): it is written before the mint is
# submitted and after every state change, so a restart re-adopts the coins this
# poster already owns and re-offers the ones that came back. Deleting that
# volume is what "start over" means here.
#
# ── One facade per seed, ever ────────────────────────────────────────────────
# Two wallet facades on one seed against one Midnight node force each other's
# connection down. POSTER_SEED must be DEDICATED — distinct from
# MIDNIGHT_WALLET_SEED / MIDNIGHT_GENESIS_SEED, BATCHER_WALLET_SEED, SOLVER_SEED,
# MAKER_SEED / MAKER_OFFER_SEED and TAKER_SEED — and this service must never be
# scaled past one replica. `deploy/scripts/lib/poster-config.ts` refuses to start
# (exit 78, EX_CONFIG) on a collision with any of those seven, which is why
# compose/poster.yml spells the Midnight endpoints out instead of reusing the
# offerfiles anchor: that anchor carries MIDNIGHT_WALLET_SEED.
#
# `exec` matters: the poster installs SIGTERM/SIGINT handlers that flush the
# journal and stop the wallet within SHUTDOWN_GRACE_MS, and only PID 1 gets
# Compose's signal.
#
# NOTE: this is the kernel's `deploy/images/kernel/entrypoint-offer-poster.sh`
# rewritten for THIS repo's conventions (its /deploy-out volume and
# entrypoint-common.sh). The process it execs is the upstream one, unmodified.
set -euo pipefail

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=offer-poster

: "${ZSWAP_API:?ZSWAP_API is required (the kernel API base, e.g. http://kernel:9999)}"
: "${MIDNIGHT_NETWORK_ID:?MIDNIGHT_NETWORK_ID is required}"

# The wallet is checked here rather than by the config parser alone because the
# two sides have DIFFERENT NAMES: the process reads POSTER_SEED/POSTER_MNEMONIC,
# the operator sets OFFER_POSTER_SEED/OFFER_POSTER_MNEMONIC in .env. Failing
# here also happens BEFORE the contract read and the kernel wait below.
#
# Compose's own `${VAR:?message}` guard is deliberately not used for it: Compose
# interpolates EVERY service before it filters by profile, so a `:?` on an
# opt-in service breaks plain `docker compose up` for everyone else.
if [ -z "${POSTER_SEED:-}" ] && [ -z "${POSTER_MNEMONIC:-}" ]; then
  log "$ROLE" "missing required environment: POSTER_SEED or POSTER_MNEMONIC"
  log "$ROLE" "set POSTER_SEED in .env — a DEDICATED seed, not the genesis/batcher/solver/taker one."
  log "$ROLE" "generate one with: openssl rand -hex 32"
  exit 78 # EX_CONFIG, the same code poster-config.ts uses
fi

# "" IS NOT UNSET. Compose renders `FOO: ${OFFER_POSTER_FOO:-}` for an absent
# variable as the EMPTY STRING, and a present-but-empty knob is not the same as
# an absent one to every reader. `readEnv` in poster-config.ts already treats
# blank as absent, so this is belt-and-braces — but it keeps the container's
# environment honest, so `docker compose exec offer-poster env` shows what the
# process actually used.
#
# POSTER_SEED / POSTER_MNEMONIC are NOT in the list: a blank one must reach the
# config parser and be reported as the missing wallet it is.
for _poster_env in \
  GIVE_TOKEN GIVE_AMOUNT GIVE_MIN GIVE_MAX GIVE_SIZE_SEED \
  WANT_TOKEN WANT_AMOUNT \
  POST_INTERVAL_MS OFFER_TTL_MINUTES COIN_VISIBLE_TIMEOUT_MS \
  RECONCILE_INTERVAL_MS POSTER_MAX_REOFFERS_PER_TICK SHUTDOWN_GRACE_MS \
  HEALTH_STALE_TICKS DRY_RUN POSTER_JOURNAL_RESET POSTER_MIN_DUST \
  POSTER_SYNC_TIMEOUT_MS POSTER_DUST_WAIT_TIMEOUT_MS \
  POSTER_POST_RETRIES POSTER_POST_RETRY_MS POSTER_LIVE_TRIES POSTER_LIVE_INTERVAL_MS
do
  if [ -z "${!_poster_env:-}" ]; then unset "${_poster_env}"; fi
done
unset _poster_env

# The contract address from the shared volume. The poster resolves it in the
# same priority order (MIDNIGHT_CONTRACT_ADDRESS -> CONTRACT_SHARE_DIR file ->
# the in-package copy), so this is what makes the first branch true. The journal
# is KEYED by that address: a mismatch refuses to start rather than mixing coins
# from two deployments.
load_contract_address "$ROLE"

log "$ROLE" "waiting for the kernel API at ${ZSWAP_API}"
for _try in $(seq 1 300); do
  if bun -e 'const r = await fetch(process.env.ZSWAP_API + "/v1/health"); process.exit(r.ok ? 0 : 1)' 2>/dev/null; then
    break
  fi
  sleep 2
done

# openJournal() mkdir -p's this too; doing it here means a wrong
# POSTER_JOURNAL_FILE (a path outside the mount, a typo) fails as a plain mkdir
# error before the wallet spends minutes syncing.
mkdir -p "$(dirname "${POSTER_JOURNAL_FILE:-/var/lib/offer-poster/journal.json}")"

cd /app
log "$ROLE" "starting the offer poster (deploy/scripts/offer-poster.ts)"
log "$ROLE" "  kernel=${ZSWAP_API} network=${MIDNIGHT_NETWORK_ID} journal=${POSTER_JOURNAL_FILE:-/var/lib/offer-poster/journal.json}"
if [ -n "${GIVE_MIN:-}" ] || [ -n "${GIVE_MAX:-}" ]; then
  log "$ROLE" "  give=${GIVE_TOKEN:-WBTC}/${GIVE_MIN:-<unset>}..${GIVE_MAX:-<unset>} coins (log-uniform per mint, seed=${GIVE_SIZE_SEED:-<random>})"
else
  log "$ROLE" "  give=${GIVE_TOKEN:-WBTC}/${GIVE_AMOUNT:-1000000}"
fi
log "$ROLE" "  want=${WANT_TOKEN:-WETH}/${WANT_AMOUNT:-<quoted>} interval=${POST_INTERVAL_MS:-60000}ms"
exec bun run /app/deploy/scripts/offer-poster.ts
