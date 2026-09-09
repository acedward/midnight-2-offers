#!/usr/bin/env bash
#
# Runtime assertions for the `poster` profile — the service that keeps the demo
# book non-empty by minting one coin and posting one takeable offer per interval.
#
# The gate is deliberately END TO END and not "the container is healthy": the
# poster answers /health 200 while it is `starting` and while it is `degraded`
# (no DUST yet), because 503-ing there would make Compose restart a container
# that is correctly waiting for NIGHT. So a healthy container proves almost
# nothing, and these are the assertions that do:
#
#   state          not `unhealthy`, not `failed`, and NOT `degraded`. Since the
#                  contract removal the degraded reason to expect is
#                  `insufficient_inventory` — the poster's honest "I have no
#                  spendable GIVE_TOKEN coin left" — and on a stack whose
#                  `faucet-mint` one-shot completed it is a FAILURE of this gate,
#                  not a transient. A restart cannot create inventory; the
#                  remedy is `FAUCET_MINT_POSTER_COINS`, or a longer
#                  `OFFER_POSTER_INTERVAL_MS`, or a shorter
#                  `OFFER_POSTER_TTL_MINUTES`. The reason is printed either way.
#   adoption       `inventoryAdoptions + reoffers >= 1`: it actually took a
#                  prefunded coin (or got one back) and used it. THIS REPLACES
#                  `mints >= 1`, which no longer exists — the poster does not
#                  mint at this pin and `poster-health.ts` reports no `mints`
#                  field or `offer_poster_mints_total` metric at all.
#   freeCoins      reported, and printed. It is the number this gate's failure
#                  mode is really about, and it is the number to look at before
#                  changing the three knobs above.
#   lastOfferId    it posted, and the id is present in the KERNEL's open book —
#                  which is the only claim that matters, because an offer the
#                  kernel has not indexed is invisible to every taker and to the
#                  solver.
#   give amount    EXACTLY `OFFER_POSTER_GIVE_AMOUNT` (or inside
#                  GIVE_MIN..GIVE_MAX when a range is configured). Not "a
#                  multiple of 10^6" any more: that assumed every token had 6
#                  decimals, which the six local ones do not (8/18/6/6/6/8), and
#                  the poster now SELECTS a coin of an exact size rather than
#                  minting a whole-coin one.
#   /metrics       answers, so the counters are scrapeable.
#
#   --static       OFFLINE: the shipped POSTER_SEED differs from every other
#                  wallet seed in the repository. Needs no stack.
#
# The wait is bounded and generous (POSTER_VERIFY_TIMEOUT, default 300 s): the
# first tick follows wallet sync on a cold devnet, and posting an offer is a real
# proving round.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

# ── --static: the seed distinctness check (offline) ──────────────────────────
#
# WHY THIS IS A CHECK AND NOT A COMMENT. Two wallet facades on one seed against
# one Midnight node force each other's connection down — silently, and in a way
# that looks like an indexer problem. `poster-config.ts` refuses to start (exit
# 78) if POSTER_SEED equals one of seven named variables, but it can only see the
# environment it was given: a seed that collides with a value spelled in a
# DIFFERENT compose fragment, or in .env.example, never reaches it. This finds
# that offline, before anything is built.
static_check() {
  local failures=0 poster_seed seeds dupes
  log "poster seed distinctness (offline)"

  poster_seed="$(grep -hoE "POSTER_SEED:-[0-9a-f]{64}" "$REPO_ROOT/compose/poster.yml" \
    | head -1 | sed -E 's/.*:-//')"
  if [[ ! "$poster_seed" =~ ^[0-9a-f]{64}$ ]]; then
    err "compose/poster.yml carries no 64-hex POSTER_SEED default"
    return 1
  fi
  info "POSTER_SEED default ${poster_seed:0:8}…${poster_seed: -6}"

  # Every OTHER seed-shaped default anywhere in the stack's configuration:
  # `${SOMETHING_SEED:-<hex>}` in a compose fragment, `SOMETHING_SEED=<hex>` in
  # .env.example (commented or not), and every `seed` in wallets/wallets.json.
  seeds="$(
    {
      grep -hoE "[A-Z_]*SEED:-[0-9a-f]{64,128}" "$REPO_ROOT"/compose/*.yml 2>/dev/null \
        | sed -E 's/^([A-Z_]*SEED):-/\1\t/'
      grep -hoE "^[[:space:]]*#?[[:space:]]*[A-Z_]*SEED=[0-9a-f]{64,128}" "$REPO_ROOT/.env.example" 2>/dev/null \
        | sed -E 's/^[[:space:]]*#?[[:space:]]*([A-Z_]*SEED)=/\1\t/'
      python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
for wallet in doc.get("wallets", []):
    name = wallet.get("name", "?")
    seed = wallet.get("seed", "")
    print("wallets.json:" + name + "\t" + seed)
' "$REPO_ROOT/wallets/wallets.json"
    } | sort -u
  )"

  # A seed EQUAL to the poster's, declared under any other name, is the defect.
  # The poster's OWN declarations are not collisions: compose/poster.yml states
  # the default twice (offer-poster and poster-fund, which must agree), and
  # wallets/wallets.json documents the same wallet. Everything else is.
  dupes="$(printf '%s\n' "$seeds" \
    | awk -F'\t' -v s="$poster_seed" '$2 == s && $1 !~ /POSTER_SEED/ && $1 != "wallets.json:offer-poster" { print $1 }')"
  if [[ -n "$dupes" ]]; then
    err "POSTER_SEED collides with another wallet in this repository:"
    while IFS= read -r where; do [[ -n "$where" ]] && info "  also declared as ${where}"; done <<< "$dupes"
    info "  two facades on one seed against one node force each other's connection down"
    failures=$(( failures + 1 ))
  else
    ok "POSTER_SEED differs from every other seed in compose/, .env.example and wallets/wallets.json"
    info "  compared against $(printf '%s\n' "$seeds" | grep -c . ) declared seed(s)"
  fi

  # The seven the poster itself refuses, named here so a future edit to one of
  # them is caught by this script rather than by an exit 78 in production.
  local forbidden
  for forbidden in \
    0000000000000000000000000000000000000000000000000000000000000001 \
    0000000000000000000000000000000000000000000000000000000000000002 \
    0000000000000000000000000000000000000000000000000000000000000003 \
    0000000000000000000000000000000000000000000000000000000000000021
  do
    if [[ "$poster_seed" == "$forbidden" ]]; then
      err "POSTER_SEED is one of the well-known stack seeds (${forbidden:0:8}…) — the poster exits 78 on it"
      failures=$(( failures + 1 ))
    fi
  done

  return "$failures"
}

if [[ "${1:-}" == "--static" ]]; then
  if static_check; then
    ok "poster static assertions passed"
    exit 0
  fi
  err "poster static assertions failed"
  exit 1
fi

load_env
PPORT="${POSTER_HEALTH_PORT:-10803}"
PBASE="http://${HOST_ADDR}:${PPORT}"
KPORT="${KERNEL_HOST_PORT:-9999}"
KBASE="http://${HOST_ADDR}:${KPORT}"
TIMEOUT="${POSTER_VERIFY_TIMEOUT:-300}"
FAILURES=0

# The static half runs here too: it is free, it needs nothing, and a collision is
# the one poster defect that a passing runtime check can still hide (the poster
# and its twin would simply take turns).
static_check || FAILURES=$(( FAILURES + 1 ))

echo
log "poster runtime (waiting up to ${TIMEOUT}s for the first mint)"

HEALTH=""
DEADLINE=$(( SECONDS + TIMEOUT ))
while (( SECONDS < DEADLINE )); do
  HEALTH="$(curl -fsS --max-time 10 "$PBASE/health" 2>/dev/null || true)"
  if [[ -n "$HEALTH" ]]; then
    # Stop as soon as the poster has both minted and posted; keep waiting while
    # it is `starting` (wallet sync, dust registration, contract join) or has not
    # completed a tick yet.
    if printf '%s' "$HEALTH" | python3 -c '
import json, sys
d = json.load(sys.stdin)
use = (d.get("inventoryAdoptions") or 0) + (d.get("reoffers") or 0)
raise SystemExit(0 if use >= 1 and d.get("lastOfferId") else 1)
' 2>/dev/null; then
      break
    fi
  fi
  sleep 5
done

if [[ -z "$HEALTH" ]]; then
  err "poster /health did not answer on :${PPORT}"
  info "  is the profile up?  ./up.sh --with offerfiles --with poster"
  err "1 poster assertion(s) failed"
  exit 1
fi

# One parse, several assertions — and the whole health body is printed on any
# failure, because the poster's own report is the fastest route to the cause.
# The separator is US (0x1f), NOT a tab. Tab is an IFS *whitespace* character, so bash
# collapses runs of it and an EMPTY field simply vanishes, shifting every field after it
# one place left. `lastOfferId` is null exactly when the poster is degraded — i.e. only on
# the failure path — so a tab here produced a correct verdict with a nonsense diagnosis
# ("lastOfferId insufficient_dus... is NOT in the kernel's open book"). US is not IFS
# whitespace, so empty fields are preserved.
POSTER_FIELDS="$(printf '%s' "$HEALTH" | python3 -c '
import json, sys
d = json.load(sys.stdin)
give = d.get("giveRange") or {}
print("\x1f".join(str(x) for x in [
    d.get("state", ""),
    (d.get("inventoryAdoptions") or 0) + (d.get("reoffers") or 0),
    d.get("lastOfferId") or "",
    d.get("lastFailure") or "",
    d.get("lastError") or "",
    d.get("freeCoins") if d.get("freeCoins") is not None else "",
    d.get("liveOffers", 0),
    d.get("lastGiveAmount") or "",
    give.get("minBase") or "",
    give.get("maxBase") or "",
]))
' 2>/dev/null || true)"
IFS=$'\x1f' read -r P_STATE P_USES P_OFFER P_FAILURE P_ERROR P_FREE P_LIVE P_GIVE P_MIN P_MAX <<< "$POSTER_FIELDS"

info "state=${P_STATE:-?} adoptions+reoffers=${P_USES:-?} liveOffers=${P_LIVE:-?} freeCoins=${P_FREE:-?}"
# Only present when a give RANGE is configured (poster-health.ts adds giveRange +
# lastGiveAmount together), so it is printed rather than asserted.
[[ -n "$P_GIVE" ]] && info "lastGiveAmount=${P_GIVE} base units"
[[ -n "$P_OFFER" ]] && info "lastOfferId=${P_OFFER}"

health_dump() { info "  /health: $(printf '%s' "$HEALTH" | head -c 600)"; }

case "$P_STATE" in
  ok)
    ok "poster state=ok" ;;
  degraded)
    err "poster is DEGRADED — it is up but could neither adopt inventory nor re-offer (${P_FAILURE:-no reason given})"
    case "$P_FAILURE" in
      *inventory*)
        info "  THIS IS THE FAILURE THE CONTRACT REMOVAL INTRODUCED. The poster no longer mints:"
        info "  it selects an existing coin of exactly OFFER_POSTER_GIVE_AMOUNT and never creates"
        info "  one, so its inventory is finite and externally supplied. freeCoins=${P_FREE:-?}."
        info "  Fix one of three numbers, not the poster:"
        info "    FAUCET_MINT_POSTER_COINS   more coins at bring-up (default 4)"
        info "    OFFER_POSTER_INTERVAL_MS   slower ticks (default 300000)"
        info "    OFFER_POSTER_TTL_MINUTES   coins come back sooner (default 10)"
        info "  Steady state needs about TTL_MINUTES*60000/INTERVAL_MS coins."
        info "  Check the mint ran: docker compose … logs faucet-mint" ;;
      *dust*)
        info "  no spendable DUST. The poster-fund one-shot sends NIGHT; the poster registers its own"
        info "  dust address and waits for a UTXO. Check: docker compose … logs poster-fund" ;;
    esac
    health_dump
    FAILURES=$(( FAILURES + 1 )) ;;
  unhealthy|failed)
    err "poster state=${P_STATE} (${P_ERROR:-no error given})"
    health_dump
    FAILURES=$(( FAILURES + 1 )) ;;
  starting)
    err "poster is still 'starting' after ${TIMEOUT}s — wallet sync or dust registration is stuck"
    health_dump
    FAILURES=$(( FAILURES + 1 )) ;;
  *)
    err "poster state is ${P_STATE:-unreadable}"
    health_dump
    FAILURES=$(( FAILURES + 1 )) ;;
esac

if [[ "${P_USES:-0}" =~ ^[0-9]+$ ]] && (( P_USES >= 1 )); then
  ok "poster has used ${P_USES} prefunded/returned coin(s) (inventoryAdoptions + reoffers)"
else
  err "poster has neither adopted nor re-offered a coin within ${TIMEOUT}s (${P_USES:-?})"
  info "  freeCoins=${P_FREE:-?}. If it is 0, faucet-mint did not put coins in this wallet:"
  info "  docker compose … logs faucet-mint"
  health_dump
  FAILURES=$(( FAILURES + 1 ))
fi

# ── the offer is in the KERNEL's book ────────────────────────────────────────
# Not the poster's journal: the journal is what the poster BELIEVES. An offer the
# kernel has not indexed is invisible to every taker and to the solver, which is
# the whole point of the service.
if [[ -z "$P_OFFER" ]]; then
  err "poster reports no lastOfferId — it minted but never posted"
  health_dump
  FAILURES=$(( FAILURES + 1 ))
else
  BOOK="$(curl -fsS --max-time 15 "$KBASE/v1/offers?limit=100" 2>/dev/null || true)"
  if [[ -z "$BOOK" ]]; then
    err "kernel GET /v1/offers did not answer on :${KPORT}"
    FAILURES=$(( FAILURES + 1 ))
  elif MATCH="$(printf '%s' "$BOOK" | POSTER_OFFER_ID="$P_OFFER" python3 -c '
import json, os, sys
wanted = os.environ["POSTER_OFFER_ID"].lower()
doc = json.load(sys.stdin)
for offer in doc.get("offers", []):
    if str(offer.get("offerId", "")).lower() != wanted:
        continue
    computed = offer.get("computed") or {}
    gives = computed.get("gives") or []
    wants = computed.get("wants") or []
    give = gives[0] if gives else {}
    want = wants[0] if wants else {}
    print("\t".join([
        str(give.get("amount", "")),
        str(give.get("token", ""))[:16],
        str(want.get("amount", "")),
        str(want.get("token", ""))[:16],
        str(computed.get("status", "")),
    ]))
    raise SystemExit(0)
raise SystemExit(1)
' 2>/dev/null)"; then
    IFS=$'\t' read -r B_GIVE_AMT B_GIVE_TOK B_WANT_AMT B_WANT_TOK B_STATUS <<< "$MATCH"
    ok "lastOfferId is in the kernel's open book (status=${B_STATUS:-?})"
    info "  gives ${B_GIVE_AMT} of ${B_GIVE_TOK}…  wants ${B_WANT_AMT} of ${B_WANT_TOK}…"

    # THE EXACT-COIN GUARANTEE. The old assertion here was "a multiple of 10^6",
    # which encoded the pre-#63 belief that every token in this stack had 6
    # decimals. The six local ones are 8/18/6/6/6/8, so that test is now both
    # wrong and weaker than what is actually promised: the poster SELECTS a coin
    # whose value equals OFFER_POSTER_GIVE_AMOUNT exactly, and `faucet-mint`
    # mints coins of exactly that size from the SAME variable. An offer whose
    # give leg is any other number means the two drifted apart — which is
    # otherwise silent, because the poster would simply report
    # `insufficient_inventory` forever while the wallet held coins of the wrong
    # size.
    EXPECT_GIVE="${OFFER_POSTER_GIVE_AMOUNT:-100000000}"
    if [[ -n "$P_MIN" && -n "$P_MAX" ]]; then
      : # a range is configured; the range assertion below is the one that applies
    elif [[ "$B_GIVE_AMT" == "$EXPECT_GIVE" ]]; then
      ok "give leg is exactly OFFER_POSTER_GIVE_AMOUNT (${B_GIVE_AMT} base units)"
    else
      err "give leg ${B_GIVE_AMT} != OFFER_POSTER_GIVE_AMOUNT ${EXPECT_GIVE}"
      info "  the poster matches on an EXACT coin value and faucet-mint mints that value;"
      info "  if these disagree the wallet fills with coins the poster can never select."
      FAILURES=$(( FAILURES + 1 ))
    fi

    # …and inside the configured range, when one is configured.
    if [[ -n "$P_MIN" && -n "$P_MAX" && "$B_GIVE_AMT" =~ ^[0-9]+$ ]]; then
      if (( B_GIVE_AMT >= P_MIN && B_GIVE_AMT <= P_MAX )); then
        ok "give leg is inside GIVE_MIN..GIVE_MAX (${P_MIN}..${P_MAX})"
      else
        err "give leg ${B_GIVE_AMT} is outside the configured GIVE_MIN..GIVE_MAX (${P_MIN}..${P_MAX})"
        FAILURES=$(( FAILURES + 1 ))
      fi
    fi

    if [[ -n "$B_WANT_AMT" && "$B_WANT_AMT" != "0" ]]; then
      ok "want leg is priced (${B_WANT_AMT} base units) — the quote path answered"
    else
      err "want leg is empty or zero — GET /v1/quote could not size it (unpriced legs? stale schema?)"
      FAILURES=$(( FAILURES + 1 ))
    fi
  else
    err "lastOfferId ${P_OFFER:0:16}… is NOT in the kernel's open book"
    info "  the poster posted it, so it was either consumed, expired, or never indexed"
    info "  check: curl ${KBASE}/v1/offers | head -c 400"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

# `offer_poster_mints_total` is GONE with the mint; `inventory_adoptions_total`
# is its successor and `free_coins` is the gauge that explains a degraded poster.
if curl -fsS --max-time 10 "$PBASE/metrics" | grep -q '^offer_poster_inventory_adoptions_total'; then
  ok "poster /metrics answers with offer_poster_* counters"
else
  err "poster /metrics did not answer with offer_poster_* counters"
  FAILURES=$(( FAILURES + 1 ))
fi

echo
if (( FAILURES == 0 )); then
  ok "poster assertions passed"
  exit 0
fi
err "${FAILURES} poster assertion(s) failed"
exit 1
