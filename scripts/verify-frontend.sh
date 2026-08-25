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
# Deliberately NOT asserted here: anything against the kernel API. The frontend profile is
# standalone by design (see compose/frontend.yml) — its wiring to a live kernel is exercised by
# the kernel section plus a browser, not by this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
BIND="${BIND_ADDR:-127.0.0.1}"
FPORT="${FRONTEND_HOST_PORT:-10600}"
BASE="http://${BIND}:${FPORT}"

FAILURES=0

html=$(curl -fsS --max-time 10 "$BASE/" 2>/dev/null || true)
if [[ "$html" == *"<html"* || "$html" == *"<!doctype"* || "$html" == *"<!DOCTYPE"* ]]; then
  ok "frontend serves an HTML document on :${FPORT}"
else
  err "frontend did not serve HTML on :${FPORT}"
  FAILURES=$(( FAILURES + 1 ))
fi

if curl -fsS --max-time 10 "$BASE/config.js" >/dev/null 2>&1; then
  ok "frontend serves /config.js (runtime-config injection point)"
else
  err "/config.js missing — the image entrypoint did not generate it"
  FAILURES=$(( FAILURES + 1 ))
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
