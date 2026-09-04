#!/usr/bin/env bash
#
# Runtime assertions for the `prices` profile — the CoinGecko feed that keeps
# the kernel's reference prices fresh.
#
# WHAT IS ACTUALLY ASSERTED, and why it is read from the KERNEL and not from the
# feed's own logs: the price feed publishes no port and has no healthcheck. It
# is a WRITER. The only claim worth making about it is that the rows the rest of
# the stack reads — GET /v1/prices, GET /v1/quote, the batcher's fee-sponsorship
# gate — are the ones IT wrote, and that is visible exactly where they are
# consumed.
#
#   container      a `price-feed` container exists and is RUNNING (it is a loop,
#                  not a one-shot; an exited one is a failure).
#   feed status    GET /v1/prices `feed.last_ok_at` is non-null and `last_error`
#                  is null. `price_feed_status` is deliberately NOT seeded by
#                  000-init.sql — an absent row is how "the feed never ran here"
#                  is spelled — so a non-null last_ok_at means one thing only: a
#                  cycle completed against THIS database.
#   freshness      last_ok_at is within PRICES_MAX_AGE_S (default 3600 s) of now.
#   source flip    every asset the stack quotes with carries `source: "feed"`,
#                  not `"seed"`, and an `updated_at` in the same window. This is
#                  the assertion that cannot be faked by the seed data: the
#                  seeded rows are literally marked `seed` by a CHECK-constrained
#                  column.
#   the quote      GET /v1/quote still answers and still sponsors — a refreshed
#                  price must not break the path that reads it.
#
#   --once         ALSO run one extra cycle synchronously
#                  (`docker compose run --rm price-feed --once`) and require
#                  exit 0. That spends a CoinGecko credit on purpose, so it is
#                  opt-in; exit 2 means the cycle ran and some asset did not
#                  land, exit 64 a misconfiguration (no key / no schema).
#
# THE KEY IS NEVER READ, PRINTED OR PASSED HERE. This script asks the kernel for
# rows; whether a key exists is inferred from whether a cycle succeeded.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

RUN_ONCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) RUN_ONCE=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) err "unknown option: $1"; exit 2 ;;
  esac
done

load_env
KPORT="${KERNEL_HOST_PORT:-9999}"
KBASE="http://${HOST_ADDR}:${KPORT}"
MAX_AGE="${PRICES_MAX_AGE_S:-3600}"
FAILURES=0

# ── the container ────────────────────────────────────────────────────────────
# By compose label rather than `docker compose ps`, like verify-solver.sh: this
# script then needs no PROFILES and no fragment list to be correct.
FEED_CID="$(docker ps -q \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=price-feed" | head -n 1)"
if [[ -z "$FEED_CID" ]]; then
  # An EXITED container is a different failure from an absent one, and the
  # difference is the whole diagnosis, so name it.
  DEAD_CID="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=price-feed" | head -n 1)"
  if [[ -n "$DEAD_CID" ]]; then
    err "the price-feed container exists but is NOT running (exit $(docker inspect -f '{{.State.ExitCode}}' "$DEAD_CID" 2>/dev/null || echo '?'))"
    info "  64 = misconfiguration (no COINGECKO_API_KEY, or a database without the ledger-v9 schema)"
    info "  logs: docker logs ${DEAD_CID}"
  else
    err "no price-feed container for project '${COMPOSE_PROJECT_NAME}'"
    info "  bring it up with: ./up.sh --with offerfiles --with prices"
  fi
  err "1 prices assertion(s) failed"
  exit 1
fi
ok "price-feed container is running"

# ── optional: one extra cycle, synchronously ─────────────────────────────────
if (( RUN_ONCE )); then
  echo
  log "running one cycle (docker compose run --rm price-feed --once) — this spends a CoinGecko credit"
  use_all_profiles
  ONCE_OUT="$(dc run --rm price-feed --once 2>&1)" && ONCE_RC=0 || ONCE_RC=$?
  # The service's own line prints `key=present`/`key=ABSENT` and never the key
  # itself (packages/price-feed/src/config.ts describeConfig), so this is safe
  # to echo verbatim.
  printf '%s\n' "$ONCE_OUT" | sed 's/^/    /'
  case "$ONCE_RC" in
    0) ok "one cycle completed with every asset updated (exit 0)" ;;
    2) err "the cycle ran but at least one asset did not land (exit 2)"
       FAILURES=$(( FAILURES + 1 )) ;;
    64) err "the price feed is misconfigured (exit 64): no COINGECKO_API_KEY, or a database without asset_prices/price_feed_status"
       FAILURES=$(( FAILURES + 1 )) ;;
    *) err "the cycle exited ${ONCE_RC}"
       FAILURES=$(( FAILURES + 1 )) ;;
  esac
fi

# ── what the kernel now serves ───────────────────────────────────────────────
# `tokens` is REQUIRED by the route (there is no unfiltered form), and WHICH
# colours are asked for decides which assets come back — so the list is built
# rather than hard-coded:
#
#   NIGHT   32 zero bytes, the one colour identical on every network, seeded in
#           known_tokens against `midnight-3`. Always available, so it is what
#           makes the route answer at all.
#   WBTC    the two colours this stack actually quotes with. They derive from
#   WETH    the deployed contract address, so they cannot be written down here —
#           they are resolved from /v1/known-tokens, and simply left out when
#           `register-tokens` has not named them (verify-kernel.sh owns that).
#
# Without them the `assets` array would carry `midnight-3` alone and the
# "still seeded" warning below could not see the assets that matter.
echo
log "prices (kernel ${KBASE}/v1/prices)"
NIGHT_COLOR='0000000000000000000000000000000000000000000000000000000000000000'

KNOWN="$(curl -fsS --max-time 10 "$KBASE/v1/known-tokens" 2>/dev/null || true)"
resolve_color() {  # resolve_color <NAME> — prints the colour, or nothing
  printf '%s' "$KNOWN" | NAME="$1" python3 -c '
import json, os, sys
want = os.environ["NAME"].upper()
try:
    doc = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
rows = doc.get("tokens") if isinstance(doc, dict) else doc
for row in rows or []:
    if str(row.get("name", "")).upper() == want:
        print(row.get("token_color") or row.get("color") or row.get("tokenColor") or "")
        break
' 2>/dev/null || true
}
WBTC="$(resolve_color WBTC)"
WETH="$(resolve_color WETH)"

ASK="$NIGHT_COLOR"
[[ -n "$WBTC" ]] && ASK="${ASK},${WBTC}"
[[ -n "$WETH" ]] && ASK="${ASK},${WETH}"
PRICES="$(curl -fsS --max-time 15 "$KBASE/v1/prices?tokens=${ASK}" 2>/dev/null || true)"
if [[ -z "$PRICES" ]]; then
  err "kernel GET /v1/prices did not answer on :${KPORT}"
  info "  is the offerfiles profile up? ./up.sh --with offerfiles --with prices"
  err "$(( FAILURES + 1 )) prices assertion(s) failed"
  exit 1
fi

# One parse, several assertions. US (0x1f) as the separator, not a tab: tab is
# IFS *whitespace*, so bash collapses runs of it and an EMPTY field vanishes,
# shifting every later field one place left — and `last_error` is empty exactly
# on the happy path, i.e. in almost every run (the same defect P6.2b found in
# verify-poster.sh).
FIELDS="$(printf '%s' "$PRICES" | MAX_AGE="$MAX_AGE" python3 -c '
import json, os, sys
from datetime import datetime, timezone

def age(ts):
    """Seconds since an ISO-8601 timestamp, or None."""
    if not ts:
        return None
    try:
        return (datetime.now(timezone.utc)
                - datetime.fromisoformat(str(ts).replace("Z", "+00:00"))).total_seconds()
    except Exception:
        return None

doc = json.load(sys.stdin)
feed = doc.get("feed") or {}
assets = doc.get("assets") or []
fed = [a for a in assets if a.get("source") == "feed"]
seeded = [a for a in assets if a.get("source") == "seed"]
oldest = max((age(a.get("updated_at")) or 0) for a in fed) if fed else None
print("\x1f".join(str(x) for x in [
    feed.get("provider") or "",
    feed.get("last_ok_at") or "",
    feed.get("last_run_at") or "",
    feed.get("last_error") or "",
    "" if age(feed.get("last_ok_at")) is None else int(age(feed.get("last_ok_at"))),
    len(assets),
    ",".join(str(a.get("asset_id")) for a in fed),
    ",".join(str(a.get("asset_id")) for a in seeded),
    "" if oldest is None else int(oldest),
]))
' 2>/dev/null || true)"
IFS=$'\x1f' read -r F_PROVIDER F_OK_AT F_RUN_AT F_ERROR F_AGE F_ASSETS F_FED F_SEEDED F_ROW_AGE <<< "$FIELDS"

if [[ -z "${FIELDS:-}" ]]; then
  err "GET /v1/prices did not answer with the documented shape"
  info "  answer was: $(printf '%s' "$PRICES" | head -c 300)"
  err "$(( FAILURES + 1 )) prices assertion(s) failed"
  exit 1
fi

info "feed provider=${F_PROVIDER:-none} last_ok_at=${F_OK_AT:-never} (${F_AGE:-?}s ago) last_run_at=${F_RUN_AT:-never}"
info "assets ${F_ASSETS:-0} priced — from the feed: ${F_FED:-none}; still seeded: ${F_SEEDED:-none}"

# 1. a cycle completed here.
if [[ -n "$F_OK_AT" ]]; then
  ok "the feed has completed a cycle against this database (last_ok_at=${F_OK_AT})"
else
  err "price_feed_status has no last_ok_at — no cycle has EVER succeeded against this database"
  info "  000-init.sql does not seed that row, so this is not a stale value: the feed"
  info "  either never ran, never had a key, or never reached CoinGecko."
  info "  logs: docker logs ${FEED_CID}"
  FAILURES=$(( FAILURES + 1 ))
fi

# 2. the last cycle did not end in an error.
if [[ -z "$F_ERROR" ]]; then
  ok "the last cycle reported no error"
else
  err "the last cycle recorded an error: ${F_ERROR}"
  info "  a 429 stops a cycle where it stands and keeps what it already wrote;"
  info "  any other request failure is recorded against every id in that batch."
  FAILURES=$(( FAILURES + 1 ))
fi

# 3. it is recent.
if [[ "${F_AGE:-}" =~ ^[0-9]+$ ]] && (( F_AGE <= MAX_AGE )); then
  ok "the last successful cycle is ${F_AGE}s old (limit ${MAX_AGE}s)"
elif [[ "${F_AGE:-}" =~ ^[0-9]+$ ]]; then
  err "the last successful cycle is ${F_AGE}s old, older than PRICES_MAX_AGE_S=${MAX_AGE}"
  info "  the default interval is 24 h, so on a long-lived stack raise PRICES_MAX_AGE_S"
  info "  or lower PRICE_FEED_INTERVAL_MS; on a fresh stack this means the cycle at"
  info "  start never landed."
  FAILURES=$(( FAILURES + 1 ))
fi

# 4. THE assertion: the rows the stack quotes with came from the feed, not the
#    seed. `source` is a CHECK-constrained column with exactly two values, so
#    this cannot be satisfied by the shipped data.
if [[ -n "$F_FED" ]]; then
  ok "assets carrying live feed prices: ${F_FED}"
  if [[ "${F_ROW_AGE:-}" =~ ^[0-9]+$ ]] && (( F_ROW_AGE <= MAX_AGE )); then
    ok "every feed-sourced row was written ${F_ROW_AGE}s ago or less"
  else
    err "a feed-sourced row is ${F_ROW_AGE:-?}s old, older than PRICES_MAX_AGE_S=${MAX_AGE}"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "every priced asset is still 'seed'-sourced — the feed has written nothing"
  info "  answer was: $(printf '%s' "$PRICES" | head -c 300)"
  FAILURES=$(( FAILURES + 1 ))
fi
[[ -n "$F_SEEDED" ]] && warn "still on seeded prices: ${F_SEEDED} (this colour's asset was not in the last cycle)"

# 5. the consumer still works. A refreshed price that breaks /v1/quote would be
#    worse than a stale one, and the sponsorship decision is what the batcher
#    actually reads.
echo
log "the quote path still answers with the refreshed prices"
# WBTC/WETH were resolved above, with the price query.
if [[ -n "$WBTC" && -n "$WETH" ]]; then
  QUOTE="$(curl -fsS --max-time 15 \
    "$KBASE/v1/quote?from_token=${WBTC}&to_token=${WETH}&from_amount=1000000" 2>/dev/null || true)"
  if [[ -n "$QUOTE" ]] && printf '%s' "$QUOTE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
to = str(d.get("to_amount") or "")
print("    quote 1 WBTC -> {} base units WETH  market_rate={}  sponsored={}  from_source={}  to_source={}".format(
    to, d.get("market_rate"), d.get("sponsored"), d.get("from_source"), d.get("to_source")))
raise SystemExit(0 if to.isdigit() and int(to) > 0 else 1)
'; then
    ok "/v1/quote sizes a WBTC -> WETH leg from the refreshed prices"
    # `from_source`/`to_source` say per LEG where the number came from. On a
    # stack whose feed has run they must be `feed`, and that is the end-to-end
    # proof: the feed wrote a row, the kernel read it, the quote used it.
    if printf '%s' "$QUOTE" | grep -q '"from_source"[[:space:]]*:[[:space:]]*"feed"' \
    && printf '%s' "$QUOTE" | grep -q '"to_source"[[:space:]]*:[[:space:]]*"feed"'; then
      ok "both legs of the quote are priced from the FEED (not the seed)"
    else
      err "a quote leg is not feed-sourced — the feed wrote rows the quote path did not use"
      info "  answer was: $(printf '%s' "$QUOTE" | head -c 300)"
      FAILURES=$(( FAILURES + 1 ))
    fi
  else
    err "/v1/quote could not size a WBTC -> WETH leg"
    info "  answer was: $(printf '%s' "${QUOTE:-<none>}" | head -c 300)"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  # Not a failure of the FEED: naming the colours is register-tokens' job and
  # verify-kernel.sh's assertion. Say so rather than blaming this profile.
  warn "WBTC/WETH are not named in /v1/known-tokens, so the quote leg was not checked here"
  info "  that is the register-tokens one-shot's job — see ./verify.sh --kernel"
fi

echo
if (( FAILURES == 0 )); then
  ok "prices assertions passed"
  exit 0
fi
err "${FAILURES} prices assertion(s) failed"
exit 1
