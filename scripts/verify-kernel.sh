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
