#!/usr/bin/env bash
#
# verify-spa-roundtrip.sh — the swap SPA takes an offer and makes one, headlessly.
#
#   ./scripts/verify-spa-roundtrip.sh
#
# Needs: core + offerfiles + faucet + poster + frontend (i.e. what `./up.sh --all` brings up).
# scripts/ci-check.sh runs it as step 4e; `--no-spa-roundtrip` opts out.
#
# WHAT IT ADDS THAT NOTHING ELSE HAS. The batcher has two adapters and only one of them was
# ever exercised by this gate:
#
#   celestia          publish a maker's offer file      <- the offer poster does this, and
#                                                          verify-poster.sh asserts the result
#   midnight-balancer balance and SPONSOR a taker's      <- NOTHING did this. It is the SPA's
#                     settlement, then submit               take, and it was proved once by a
#                                                           human in a browser (PR-C P8).
#
# So this drives the taker path the SPA drives — same `/config.js`, same wallet seed, same
# `POST /send-input` body, same sequence out of src/services/localTradeOffers.ts — and then the
# maker path, and asserts three things a receipt cannot tell you:
#
#   the wallet delta   the shielded balances moved by EXACTLY the two legs. A batcher receipt
#                      says "accepted and submitted"; only the wallet says the swap happened.
#   the batcher's own log  it built a batch and reported success for the balancer target.
#   the new offer      the SPA's own maker offer reached `live` in the kernel's book, which
#                      means it went out through the batcher's OTHER adapter and came back
#                      through Celestia and the index.
#
# The work runs inside the KERNEL image (images/offerfiles-kernel/runner/spa-roundtrip.ts):
# that is where the pinned wallet SDK, the ledger-v9 wasm and the MIP-0005 codec already live.
# See that file's header for why this is not a headless browser.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

require_docker
load_env
# Every fragment, so `dc run` does not report the other profiles' containers as orphans.
use_all_profiles

FAILURES=0
fail() { err "$*"; FAILURES=$(( FAILURES + 1 )); }

echo
log "spa round trip: take an offer through the batcher, then make one"

# ── preconditions, named individually ────────────────────────────────────────
present() {  # present <service>
  [[ -n "$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" 2>/dev/null)" ]]
}
MISSING=""
for svc in frontend kernel batcher offer-poster faucet-mint; do
  present "$svc" || MISSING="${MISSING} ${svc}"
done
if [[ -n "$MISSING" ]]; then
  err "this check needs services that are not in this stack:${MISSING}"
  info "  bring them up with: ./up.sh --with faucet --with offerfiles --with poster --with frontend"
  info "  (or ./up.sh --all, which is what scripts/ci-check.sh does)"
  exit 1
fi

# ── the token ids, from where the rest of the stack gets them ────────────────
# `registry-env` renders /registry/stack-tokens.env; the poster reads it; so does this. Read
# out of the VOLUME through a throwaway container, exactly as verify-faucet.sh does — it is a
# named volume and reading it any other way would be reading something else. The runner falls
# back to the kernel's own registry by NAME when this is unavailable, and says which it used.
GIVE_ID=""; WANT_ID=""
STACK_ENV="$(dc run --rm --no-deps --entrypoint sh registry-env \
  -c 'cat /registry/stack-tokens.env 2>/dev/null' 2>/dev/null || true)"
GIVE_SYMBOL="${OFFER_POSTER_GIVE_SYMBOL:-twBTC}"
WANT_SYMBOL="${OFFER_POSTER_WANT_SYMBOL:-twUSDC}"
if [[ -n "$STACK_ENV" ]]; then
  GIVE_ID="$(printf '%s' "$STACK_ENV" | sed -nE 's/^OFFER_POSTER_GIVE_TOKEN=([0-9a-f]{64})$/\1/p' | head -1)"
  WANT_ID="$(printf '%s' "$STACK_ENV" | sed -nE 's/^OFFER_POSTER_WANT_TOKEN=([0-9a-f]{64})$/\1/p' | head -1)"
fi
if [[ -n "$GIVE_ID" && -n "$WANT_ID" ]]; then
  info "pair from /registry/stack-tokens.env: ${GIVE_SYMBOL} ${GIVE_ID:0:16}… <- ${WANT_SYMBOL} ${WANT_ID:0:16}…"
else
  warn "could not read the ids from /registry/stack-tokens.env — the runner will resolve them from the kernel registry by name"
fi

# ── the batcher's log position, before ───────────────────────────────────────
# Counted, not tailed: the poster settles nothing, but it DOES publish through the same
# batcher, so a "succeeded" line that was already there proves nothing about this take.
BATCHER_CID="$(docker ps -aq \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=batcher" | head -1)"
BATCHER_SUCCESS_BEFORE="$(docker logs "$BATCHER_CID" 2>&1 | grep -cE '[0-9]+ succeeded' || true)"
info "batcher has reported '<n> succeeded' ${BATCHER_SUCCESS_BEFORE}x before this take"

# ── the round trip ───────────────────────────────────────────────────────────
info "expect several minutes: two proving rounds on a cold devnet, plus a Celestia round trip"
RUN_OUT=""
if RUN_OUT="$(dc run --rm --no-deps -T \
      -e "SPA_GIVE_TOKEN=${GIVE_ID}" -e "SPA_WANT_TOKEN=${WANT_ID}" \
      -e "SPA_GIVE_SYMBOL=${GIVE_SYMBOL}" -e "SPA_WANT_SYMBOL=${WANT_SYMBOL}" \
      -e "SPA_CONFIG_URL=${SPA_CONFIG_URL:-http://frontend:10600/config.js}" \
      -e "SPA_GRANT_MIN=${SPA_GRANT_MIN:-1}" \
      --entrypoint bun kernel /app/demo-runner/spa-roundtrip.ts 2>&1)"; then
  RUN_RC=0
else
  RUN_RC=$?
fi
printf '%s\n' "$RUN_OUT" | sed 's/^/      /'

# ── the assertions, each named so a failure says which half broke ────────────
said() { printf '%s' "$RUN_OUT" | grep -Fq -- "$1"; }

if said "driving the SPA's own runtime configuration"; then
  ok "driving the SPA's own runtime configuration (the page's /config.js: seed, network, endpoints)"
else
  fail "the runner never read the frontend's /config.js — it did not drive the SPA's configuration"
fi

if said "the spa grant is in the SPA wallet:" && ! said "the spa grant is in the SPA wallet: NO"; then
  ok "the spa grant is in the SPA wallet (faucet-mint's grant, read from the recipient wallet)"
else
  fail "the spa grant is in the SPA wallet — NOT: faucet-mint did not fund the page's wallet"
fi

if said "the batcher settled the take"; then
  ok "the batcher settled the take (midnight-balancer target, sponsored — the SPA's own wire contract)"
else
  fail "the batcher settled the take — NOT: the sponsored settlement path did not complete"
fi

if said "the SPA wallet's balances moved by exactly the taken legs"; then
  ok "the SPA wallet's balances moved by exactly the taken legs"
else
  fail "the SPA wallet's balances did not move by the taken legs — a receipt is not a swap"
fi

if said "the SPA's maker offer is live in the kernel book"; then
  ok "the SPA's maker offer is live in the kernel book (batcher -> Celestia -> index)"
else
  fail "the SPA's maker offer never reached the kernel's book"
fi

if (( RUN_RC != 0 )); then
  fail "the round-trip runner exited ${RUN_RC}"
fi

# The batcher's OWN account of it. `<n> succeeded` is what the batcher-sdk prints when a batch
# completes; the count must have gone UP, because a line that was already there belongs to the
# poster's publish.
BATCHER_SUCCESS_AFTER="$(docker logs "$BATCHER_CID" 2>&1 | grep -cE '[0-9]+ succeeded' || true)"
if (( BATCHER_SUCCESS_AFTER > BATCHER_SUCCESS_BEFORE )); then
  ok "the batcher's own log gained $(( BATCHER_SUCCESS_AFTER - BATCHER_SUCCESS_BEFORE )) '<n> succeeded' line(s) during this round trip"
else
  fail "the batcher's log reported no new success during the round trip (${BATCHER_SUCCESS_BEFORE} -> ${BATCHER_SUCCESS_AFTER})"
  info "  last 30 batcher lines:"
  docker logs --tail 30 "$BATCHER_CID" 2>&1 | sed 's/^/      /' || true
fi

echo
if (( FAILURES == 0 )); then
  ok "spa round trip: all assertions passed"
  exit 0
fi
err "spa round trip: ${FAILURES} assertion(s) failed"
exit 1
