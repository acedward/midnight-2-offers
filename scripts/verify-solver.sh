#!/usr/bin/env bash
#
# Runtime assertions for the observation-only COW solver and its sink.
# This checks the solver-authored wire state, not merely the sink's HTTP health.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
SPORT="${SOLVER_SINK_HOST_PORT:-10800}"
BASE="http://${HOST_ADDR}:${SPORT}"
FAILURES=0

health="$(curl -fsS --max-time 10 "$BASE/health" 2>/dev/null || true)"
if [[ "$health" == *'"status":"ok"'* && "$health" == *'"solverConnected":true'* ]]; then
  ok "solver sink healthy and solver connected on :${SPORT}"
else
  err "solver sink health does not report a connected solver on :${SPORT}"
  FAILURES=$(( FAILURES + 1 ))
fi

snapshot="$(curl -fsS --max-time 10 "$BASE/api/snapshot" 2>/dev/null || true)"
if [[ -n "$snapshot" ]]; then
  if summary="$(printf '%s' "$snapshot" | python3 -c '
import json, sys
j = json.load(sys.stdin)
s = j.get("solver") or {}
safe = j.get("safety") or {}
frames = j.get("frames") or {}
checks = {
  "observation": j.get("mode") == "observation",
  "connected": s.get("connected") is True,
  "connections": int(s.get("connections") or 0) >= 1,
  "wireFrame": s.get("lastFrameAt") is not None,
  "capabilities": isinstance(j.get("capabilities"), dict),
  "ladder": isinstance(j.get("ladders"), dict),
  "accepted": int(frames.get("accepted") or 0) >= 2,
  "noRejected": int(frames.get("rejected") or 0) == 0,
  "sentZero": safe.get("framesSentToSolver") == 0,
  "jobsZero": safe.get("swapJobsDispatched") == 0,
  "jobRepliesZero": safe.get("jobFramesReceived") == 0,
}
print(json.dumps(checks, separators=(",", ":")))
raise SystemExit(0 if all(checks.values()) else 1)
' 2>/dev/null)"; then
    ok "solver published capabilities + ladder; observation safety holds (${summary})"
  else
    err "solver snapshot failed readiness/safety assertions (${summary:-unparseable})"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "solver /api/snapshot did not answer"
  FAILURES=$(( FAILURES + 1 ))
fi

if (( FAILURES == 0 )); then
  ok "solver assertions passed"
  exit 0
fi
err "${FAILURES} solver assertion(s) failed"
exit 1
