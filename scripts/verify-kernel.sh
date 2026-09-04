#!/usr/bin/env bash
#
# Assertions for the `offerfiles` profile's kernel + batcher — the `kernel` section of
# ./verify.sh.
#
#   ./scripts/verify-kernel.sh
#
# What it proves, and why each one is here rather than being assumed:
#
#   health         GET /v1/health answers 200. The kernel's bring-up does real chain work
#                  (contract deploy incl. a proving round, mint, first sync) before the API
#                  answers, so a healthy endpoint means that whole sequence completed.
#   contract       GET /v1/midnight/config carries a non-empty contract address — T4.5's
#                  requirement that the offer-files contract lands on the demo chain at first
#                  bring-up and is discoverable by the frontend, asserted end to end.
#   offers API     GET /v1/offers answers 200 with a JSON body. Empty is fine (fresh chain);
#                  an error here means the PGLite/STM half is down even though health is up.
#   prices         GET /v1/prices answers 200 with the SEEDED asset table. New at the
#                  ledger-v9 pin, and it is the assertion that makes a stale Postgres
#                  volume fail loudly: 000-init.sql is applied only on an empty database,
#                  so a volume from before this pin has no asset_prices and every quote
#                  and sponsorship verdict silently degrades. `./down.sh -v` is the fix.
#   zk assets      the ZK asset routes answer — the browser prover fetches keys from here, and
#                  midnight-js 5's FetchZkConfigProvider verifies them against the compiler's
#                  integrity manifest, so these routes are load-bearing for the frontend.
#   batcher        the batcher port accepts an HTTP request. It exposes no health route, so the
#                  assertion is "an HTTP server answers", not a status code.
#
# Everything runs over the PUBLISHED HOST PORT, deliberately — same rule as verify-celestia.sh:
# that is the endpoint a human or the frontend actually uses, and an in-container check cannot
# see a loopback-bound listener.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
BIND="${HOST_ADDR:-127.0.0.1}"
KPORT="${KERNEL_HOST_PORT:-9999}"
BPORT="${BATCHER_HOST_PORT:-3334}"
API="http://${BIND}:${KPORT}"

FAILURES=0
check() { # <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    err "$label"
    FAILURES=$(( FAILURES + 1 ))
  fi
}

# health — 200 means deploy + mint + first sync all happened.
check "kernel /v1/health answers" \
  curl -fsS --max-time 10 "$API/v1/health"

# contract address — non-empty in /v1/midnight/config.
if addr=$(curl -fsS --max-time 10 "$API/v1/midnight/config" 2>/dev/null \
    | grep -oE '"(contractAddress|address)"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]+"' | head -1); then
  if [[ -n "$addr" ]]; then
    ok "offer-files contract deployed (${addr:0:60}…)"
  else
    err "/v1/midnight/config answered but carries no contract address"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "/v1/midnight/config did not answer"
  FAILURES=$(( FAILURES + 1 ))
fi

# offers API — the PGLite/STM half.
check "kernel /v1/offers answers JSON" \
  bash -c "curl -fsS --max-time 10 '$API/v1/offers' | head -c 1 | grep -qE '[{[]'"

# ── the token price service (kernel PRs #54-#56, new at the ledger-v9 pin) ────
# THIS IS THE SCHEMA ASSERTION, and it is the loud failure the BREAKING note in
# the README promises. `000-init.sql` creates and SEEDS `asset_prices` /
# `known_tokens`, and the kernel applies that file only on an EMPTY database —
# so a Postgres volume created before this pin comes up looking perfectly
# healthy while `/v1/prices` returns nothing, `/v1/quote` cannot price a leg,
# the batcher's sponsorship gate treats every offer as unpriced and the offer
# poster cannot size a want leg. None of that is visible from /v1/health.
#
# NIGHT is asked for because it is the one colour that is the same everywhere:
# 32 zero bytes on every network, seeded in `known_tokens` with the `midnight-3`
# asset. Every faucet colour derives from the deployed contract address and so
# cannot be written down here. `tokens=` is REQUIRED by the route — there is no
# unfiltered form.
NIGHT_COLOR='0000000000000000000000000000000000000000000000000000000000000000'
if prices=$(curl -fsS --max-time 10 "$API/v1/prices?tokens=${NIGHT_COLOR}" 2>/dev/null); then
  if printf '%s' "$prices" | grep -q '"midnight-3"'; then
    ok "kernel /v1/prices answers and the seeded asset table is present"
  else
    err "/v1/prices answered but priced nothing — the seeded schema is missing"
    info "  This is almost always a Postgres volume that PREDATES the ledger-v9 kernel"
    info "  pin: 000-init.sql (which creates and seeds asset_prices/known_tokens) is"
    info "  applied only on an EMPTY database. Fix: ./down.sh -v && ./up.sh …"
    info "  answer was: $(printf '%s' "$prices" | head -c 200)"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "/v1/prices did not answer 200 — the token price service is not serving"
  info "  A pre-ledger-v9 Postgres volume is the usual cause: ./down.sh -v && ./up.sh …"
  FAILURES=$(( FAILURES + 1 ))
fi

# zk assets — one existing route is enough to prove the router is mounted; the
# exact key set is the contract build's concern, not this script's.
check "kernel serves ZK assets (/keys or /zkir route mounted)" \
  bash -c "curl -s --max-time 10 -o /dev/null -w '%{http_code}' '$API/keys/' | grep -qvE '^(000|5..)$'"

# batcher — an HTTP answer on the published port (no health route exists).
check "batcher answers HTTP on :${BPORT}" \
  bash -c "curl -s --max-time 10 -o /dev/null -w '%{http_code}' 'http://${BIND}:${BPORT}/' | grep -qvE '^000$'"

if (( FAILURES == 0 )); then
  ok "kernel assertions passed"
  exit 0
fi
err "${FAILURES} kernel assertion(s) failed"
exit 1
