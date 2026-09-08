#!/bin/bash
# offer-poster — adopt one prefunded coin, post one takeable ZSwap offer, repeat.
#
# A LOOP, not a one-shot: every POST_INTERVAL_MS it either re-offers a coin its
# journal says came back, or adopts one already-spendable GIVE_TOKEN coin from
# its own wallet and posts a single offer whose only input is that exact coin.
# Health/metrics on :9977, journal on its own volume.
#
# ── IT NO LONGER MINTS (KERNEL_REF 5d794f9) ─────────────────────────────────
# Until this pin the poster minted a fresh coin per tick from the offer-files
# contract's faucet circuit. Kernel PRs #69/#70 deleted that contract: the
# poster now SELECTS an existing coin of the exact GIVE_AMOUNT (or one inside
# GIVE_MIN..GIVE_MAX) and never creates one. Inventory is therefore FINITE and
# externally supplied — this stack supplies it with the `faucet` profile's
# `faucet-mint` one-shot — and `degraded: insufficient_inventory` is the honest
# report when it runs out, not a fault to retry away. Size the pair
# FAUCET_MINT_POSTER_COINS / OFFER_POSTER_INTERVAL_MS / OFFER_POSTER_TTL_MINUTES
# so coins come back faster than ticks consume them (docs/OPERATIONS.md).
#
# ── Why there is no marker file ──────────────────────────────────────────────
# A marker would make a restart a permanent no-op. Idempotence lives in the
# JOURNAL instead (POSTER_JOURNAL_FILE, on its own volume): it is written before
# an adopted coin is offered and after every state change, so a restart
# re-adopts the coins this poster already owns and re-offers the ones that came
# back. Deleting that volume is what "start over" means here.
#
# ── One facade per seed, ever ────────────────────────────────────────────────
# Two wallet facades on one seed against one Midnight node force each other's
# connection down. POSTER_SEED must be DEDICATED — distinct from
# MIDNIGHT_WALLET_SEED / MIDNIGHT_GENESIS_SEED, BATCHER_WALLET_SEED, SOLVER_SEED,
# MAKER_SEED / MAKER_OFFER_SEED and TAKER_SEED — and this service must never be
# scaled past one replica. `deploy/scripts/lib/poster-config.ts` refuses to start
# (exit 78, EX_CONFIG) on a collision with any of those seven, which is why
# compose/poster.yml spells the Midnight endpoints out instead of reusing the
# offerfiles anchor: that anchor carries MIDNIGHT_WALLET_SEED. It is also why
# `faucet-mint` — which opens a facade on this very seed to learn its keys —
# must COMPLETE before this container starts, and compose says so.
#
# `exec` matters: the poster installs SIGTERM/SIGINT handlers that flush the
# journal and stop the wallet within SHUTDOWN_GRACE_MS, and only PID 1 gets
# Compose's signal.
#
# NOTE: this is the kernel's `deploy/images/kernel/entrypoint-offer-poster.sh`
# rewritten for THIS repo's conventions (its shared registry volume and
# entrypoint-common.sh). The process it execs is the upstream one, unmodified.
set -euo pipefail

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=offer-poster

: "${ZSWAP_API:?ZSWAP_API is required (the kernel API base, e.g. http://kernel:9999)}"
: "${MIDNIGHT_NETWORK_ID:?MIDNIGHT_NETWORK_ID is required}"

# The wallet is checked here rather than by the config parser alone because the
# two sides have DIFFERENT NAMES: the process reads POSTER_SEED/POSTER_MNEMONIC,
# the operator sets OFFER_POSTER_SEED/OFFER_POSTER_MNEMONIC in .env. Failing
# here also happens BEFORE the token resolution and the kernel wait below.
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

# ── the two token IDs, from THIS stack's registry ────────────────────────────
#
# Since the contract removal both legs are REQUIRED, EXPLICIT 64-hex token IDs
# (`poster-config.ts` rule 3: "TOKEN IDS ARE EXPLICIT"). There is no contract
# left to derive a colour from, and the IDs are a property of the chain this
# stack just created — so they cannot be written down in `.env.example` either.
#
# `registry-env` renders them into ${STACK_TOKENS_ENV} on the shared
# `faucet-registry` volume, one `<SYMBOL>_TOKEN_ID=<64hex>` line per token. This
# entrypoint resolves the pair by SYMBOL, so the choice of market lives in
# compose (OFFER_POSTER_GIVE_SYMBOL / OFFER_POSTER_WANT_SYMBOL) rather than in
# the renderer, and an operator who sets OFFER_POSTER_GIVE_TOKEN in `.env`
# overrides the lookup entirely — an explicit ID always wins over a symbol.
STACK_TOKENS_ENV="${STACK_TOKENS_ENV:-/registry/stack-tokens.env}"

# It assigns to RESOLVED_LEG rather than echoing, because a `$(...)` would run
# it in a SUBSHELL and its `exit 78` would then end that subshell and leave the
# caller running with an empty token — the exact silent misconfiguration this
# check exists to prevent.
RESOLVED_LEG=""
resolve_leg() { # <what: GIVE|WANT> <symbol>
  local what="$1" symbol="$2" key value
  key="$(printf '%s' "${symbol}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')_TOKEN_ID"
  value="${!key:-}"
  if [ -z "${value}" ]; then
    log "$ROLE" "FATAL: ${STACK_TOKENS_ENV} carries no ${key} for ${what}_SYMBOL='${symbol}'"
    log "$ROLE" "the file lists: $(grep -o '^[A-Z0-9_]*_TOKEN_ID' "${STACK_TOKENS_ENV}" 2>/dev/null | tr '\n' ' ')"
    exit 78
  fi
  RESOLVED_LEG="${value}"
}

if [ -z "${GIVE_TOKEN:-}" ] || [ -z "${WANT_TOKEN:-}" ]; then
  if [ ! -f "${STACK_TOKENS_ENV}" ]; then
    log "$ROLE" "FATAL: no ${STACK_TOKENS_ENV}."
    log "$ROLE" "Both token IDs are required and explicit since the contract removal, and this"
    log "$ROLE" "stack's IDs exist only after the faucet issuers are deployed. Bring the profile"
    log "$ROLE" "up: ./up.sh --with faucet --with offerfiles --with poster — or set"
    log "$ROLE" "OFFER_POSTER_GIVE_TOKEN and OFFER_POSTER_WANT_TOKEN in .env explicitly."
    exit 78
  fi
  # Sourced, not exported wholesale: only the two names below reach the process.
  # shellcheck disable=SC1090  # a runtime path, by design
  . "${STACK_TOKENS_ENV}"
  if [ -z "${GIVE_TOKEN:-}" ]; then
    resolve_leg GIVE "${OFFER_POSTER_GIVE_SYMBOL:-twBTC}"; GIVE_TOKEN="${RESOLVED_LEG}"
  fi
  if [ -z "${WANT_TOKEN:-}" ]; then
    resolve_leg WANT "${OFFER_POSTER_WANT_SYMBOL:-twUSDC}"; WANT_TOKEN="${RESOLVED_LEG}"
  fi
  export GIVE_TOKEN WANT_TOKEN
  log "$ROLE" "tokens from ${STACK_TOKENS_ENV}:"
  log "$ROLE" "  give ${OFFER_POSTER_GIVE_SYMBOL:-twBTC} = ${GIVE_TOKEN}"
  log "$ROLE" "  want ${OFFER_POSTER_WANT_SYMBOL:-twUSDC} = ${WANT_TOKEN}"
else
  log "$ROLE" "both token IDs came from the environment — ${STACK_TOKENS_ENV} not consulted"
fi

# "" IS NOT UNSET. Compose renders `FOO: ${OFFER_POSTER_FOO:-}` for an absent
# variable as the EMPTY STRING, and a present-but-empty knob is not the same as
# an absent one to every reader. `readEnv` in poster-config.ts already treats
# blank as absent, so this is belt-and-braces — but it keeps the container's
# environment honest, so `docker compose exec offer-poster env` shows what the
# process actually used.
#
# GIVE_TOKEN / WANT_TOKEN are resolved ABOVE and are never blank by this point.
# POSTER_SEED / POSTER_MNEMONIC are NOT in the list: a blank one must reach the
# config parser and be reported as the missing wallet it is.
#
# Four names the pre-#69 poster read are GONE from this list because they are
# gone from `poster-config.ts` with the mint: GIVE_SIZE_SEED,
# COIN_VISIBLE_TIMEOUT_MS, POSTER_MIN_DUST and POSTER_DUST_WAIT_TIMEOUT_MS. A
# poster that neither mints nor waits for its own dust has no use for them.
for _poster_env in \
  GIVE_AMOUNT GIVE_MIN GIVE_MAX \
  WANT_AMOUNT \
  POST_INTERVAL_MS OFFER_TTL_MINUTES \
  RECONCILE_INTERVAL_MS POSTER_MAX_REOFFERS_PER_TICK SHUTDOWN_GRACE_MS \
  HEALTH_STALE_TICKS DRY_RUN POSTER_JOURNAL_RESET \
  POSTER_SYNC_TIMEOUT_MS \
  POSTER_POST_RETRIES POSTER_POST_RETRY_MS POSTER_LIVE_TRIES POSTER_LIVE_INTERVAL_MS
do
  if [ -z "${!_poster_env:-}" ]; then unset "${_poster_env}"; fi
done
unset _poster_env

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
  log "$ROLE" "  give=${GIVE_TOKEN}/${GIVE_MIN:-<unset>}..${GIVE_MAX:-<unset>} base units (select a matching prefunded coin)"
else
  log "$ROLE" "  give=${GIVE_TOKEN}/${GIVE_AMOUNT:-1} base units (select a matching prefunded coin)"
fi
log "$ROLE" "  want=${WANT_TOKEN}/${WANT_AMOUNT:-<quoted>} interval=${POST_INTERVAL_MS:-60000}ms"
exec bun run /app/deploy/scripts/offer-poster.ts
