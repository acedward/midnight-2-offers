#!/usr/bin/env bash
#
# Assertions for the `frontend` profile — the `frontend` section of ./verify.sh.
#
#   ./scripts/verify-frontend.sh
#
# What it proves:
#
#   serves      GET / answers 200 with an HTML document (nginx up, dist present).
#   config.js   GET /config.js answers 200 — the runtime-config injection point the image
#               generates at container start; a 404 means the entrypoint did not run.
#   wired       index.html references config.js BEFORE the bundle, so window.API_BASE /
#               window.BATCHER_URL are set when src/config.ts evaluates.
#
# The frontend profile remains standalone by design. When runtime endpoint overrides are present
# (as they are in every pick-ports/CI env), this script asserts their exact injected values;
# kernel reachability itself is covered by verify-kernel.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
FPORT="${FRONTEND_HOST_PORT:-10600}"
BASE="http://${HOST_ADDR}:${FPORT}"

FAILURES=0

html=$(curl -fsS --max-time 10 "$BASE/" 2>/dev/null || true)
if [[ "$html" == *"<html"* || "$html" == *"<!doctype"* || "$html" == *"<!DOCTYPE"* ]]; then
  ok "frontend serves an HTML document on :${FPORT}"
else
  err "frontend did not serve HTML on :${FPORT}"
  FAILURES=$(( FAILURES + 1 ))
fi

if config_js=$(curl -fsS --max-time 10 "$BASE/config.js" 2>/dev/null); then
  ok "frontend serves /config.js (runtime-config injection point)"
else
  config_js=""
  err "/config.js missing — the image entrypoint did not generate it"
  FAILURES=$(( FAILURES + 1 ))
fi

if [[ -n "${FRONTEND_API_BASE:-}" ]]; then
  if printf '%s' "$config_js" | grep -Fq "window.API_BASE = \"${FRONTEND_API_BASE}\";"; then
    ok "config.js injects API_BASE=${FRONTEND_API_BASE}"
  else
    err "config.js does not inject expected FRONTEND_API_BASE=${FRONTEND_API_BASE}"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

if [[ -n "${FRONTEND_BATCHER_URL:-}" ]]; then
  if printf '%s' "$config_js" | grep -Fq "window.BATCHER_URL = \"${FRONTEND_BATCHER_URL}\";"; then
    ok "config.js injects BATCHER_URL=${FRONTEND_BATCHER_URL}"
  else
    err "config.js does not inject expected FRONTEND_BATCHER_URL=${FRONTEND_BATCHER_URL}"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

if [[ "$html" == *"config.js"* ]]; then
  ok "index.html loads config.js before the bundle"
else
  err "index.html does not reference config.js — runtime API_BASE/BATCHER_URL overrides are dead"
  FAILURES=$(( FAILURES + 1 ))
fi

if (( FAILURES == 0 )); then
  ok "frontend assertions passed"
  exit 0
fi
err "${FAILURES} frontend assertion(s) failed"
exit 1
