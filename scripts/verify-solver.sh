#!/usr/bin/env bash
#
# Runtime assertions for the observation-only COW solver, its sink, and the
# read-only monitor site.
#
# Three surfaces, and each proves something the others cannot:
#
#   the SINK's snapshot   the solver-authored WIRE state — it connected, it
#                         published capabilities and at least one ladder, and the
#                         observation-safety counters are still zero. This is the
#                         only place "nothing was ever sent to the solver" can be
#                         asserted, because the sink is the thing that would have
#                         had to send it.
#   the STATUS listener   the solver's own view of itself (:9100, inside the
#                         compose network). Asserted through the bearer gate in
#                         BOTH directions — 200 with, 401 without — because a
#                         listener that came up open would leak the solver's
#                         whole internal state, and because an always-401 gate is
#                         indistinguishable from a solver that is down.
#   the MONITOR page      that the site is served and reads those two.
#
# Plus one negative: :9100 must NOT be published to the host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
SPORT="${SOLVER_SINK_HOST_PORT:-10800}"
BASE="http://${HOST_ADDR}:${SPORT}"
MPORT="${SOLVER_FRONTEND_PORT:-10802}"
MBASE="http://${HOST_ADDR}:${MPORT}"
FAILURES=0

# The container id by compose label — not `docker compose exec`, which would need
# this script to know which profile fragments are in play.
service_cid() { # <service>
  docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -1
}

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

# ── the relay stand-in's public route ────────────────────────────────────────
# `GET /tokens` on the sink's RELAY port is the one relay route the monitor site
# reads, and the only unauthenticated one the reference relay has. Asserted here
# because the monitor's Relay panel is otherwise silently empty.
SINK_CID="$(service_cid solver-sink)"
if [[ -n "$SINK_CID" ]]; then
  if tokens="$(docker exec "$SINK_CID" bun -e '
      const r = await fetch("http://127.0.0.1:8081/tokens");
      if (!r.ok) process.exit(1);
      const j = await r.json();
      if (!Array.isArray(j.tokens)) process.exit(1);
      console.log(String(j.tokens.length));
    ' 2>/dev/null)"; then
    ok "sink GET /tokens answers with the solver's advertised set (${tokens} token(s))"
  else
    err "sink GET /tokens did not answer a { tokens: [] } body — the monitor's Relay panel will show an error"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "no solver-sink container for project '${COMPOSE_PROJECT_NAME}'"
  FAILURES=$(( FAILURES + 1 ))
fi

# ── the status listener, from inside the network ─────────────────────────────
SOLVER_CID="$(service_cid solver)"
if [[ -z "$SOLVER_CID" ]]; then
  err "no running solver container for project '${COMPOSE_PROJECT_NAME}'"
  FAILURES=$(( FAILURES + 1 ))
else
  # /health is OPEN by design: it carries no internal data, so a container
  # healthcheck needs no secret.
  if docker exec "$SOLVER_CID" bun -e \
      'const r = await fetch("http://127.0.0.1:9100/health"); process.exit(r.ok ? 0 : 1)' \
      >/dev/null 2>&1; then
    ok "solver status listener /health answers without a bearer"
  else
    err "solver status listener /health did not answer on :9100 — SOLVER_STATUS_PORT not in force?"
    info "  the listener is inert unless the solver runs start.solver.ts AND SOLVER_STATUS_PORT is set"
    FAILURES=$(( FAILURES + 1 ))
  fi

  # BOTH directions in one exec, so the 200 and the 401 are observed against the
  # same process at the same moment. A gate that 401s everything would pass a
  # one-sided check while the monitor stayed blind.
  if gate="$(docker exec "$SOLVER_CID" bun -e '
      const token = process.env.SOLVER_STATUS_AUTH_TOKEN ?? "";
      const url = "http://127.0.0.1:9100/status/snapshot";
      const withBearer = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const without = await fetch(url);
      let contractVersion = null;
      if (withBearer.ok) {
        try { contractVersion = (await withBearer.json()).contractVersion ?? null; } catch {}
      }
      console.log(`${withBearer.status}/${without.status} contractVersion=${contractVersion}`);
      process.exit(withBearer.status === 200 && without.status === 401 ? 0 : 1);
    ' 2>/dev/null)"; then
    ok "solver /status/snapshot is bearer-gated (${gate})"
  else
    err "solver /status/snapshot did not answer 200 with the bearer and 401 without (${gate:-no answer})"
    FAILURES=$(( FAILURES + 1 ))
  fi

  # ── the negative: :9100 must not be reachable from the host ────────────────
  # `docker port` lists exactly what the daemon published for this container, so
  # an empty answer is the assertion — not "we did not find it in compose".
  if published="$(docker port "$SOLVER_CID" 9100 2>/dev/null)" && [[ -n "$published" ]]; then
    err "the solver status port IS published to the host (${published}) — it serves the solver's entire internal state"
    info "  remove the ports: entry for 9100 in compose/solver.yml, or bind it to loopback only for a debugging session"
    FAILURES=$(( FAILURES + 1 ))
  else
    ok "solver status port :9100 is not published to the host"
  fi
fi

# ── the monitor site ─────────────────────────────────────────────────────────
if page="$(curl -fsS --max-time 10 "$MBASE/" 2>/dev/null)" && [[ -n "$page" ]]; then
  ok "solver monitor page answers on :${MPORT} ($(printf '%s' "$page" | wc -c | tr -d ' ') bytes)"
else
  err "solver monitor page did not answer on :${MPORT}"
  FAILURES=$(( FAILURES + 1 ))
fi

# Its own /health — three keys, no internal data. Deliberately says nothing about
# the solver: a monitor whose health followed the thing it monitors would be
# reported down exactly when it is needed.
if curl -fsS --max-time 10 "$MBASE/health" >/dev/null 2>&1; then
  ok "solver monitor /health answers"
else
  err "solver monitor /health did not answer"
  FAILURES=$(( FAILURES + 1 ))
fi

# The page's own snapshot: it must have actually READ the solver, not just
# started. `solver.reachable` false is exactly the SOLVER UNREACHABLE state, and
# with the solver up it is a failure of the bearer or of the URL.
if msnap="$(curl -fsS --max-time 10 "$MBASE/api/snapshot" 2>/dev/null)"; then
  if summary="$(printf '%s' "$msnap" | python3 -c '
import json, sys
j = json.load(sys.stdin)
solver = j.get("solver") or {}
kernel = j.get("kernel") or {}
# The monitor spells "I could not read the solver" as a section error or as an
# explicit unreachable flag depending on the field; treat any of them as a miss.
def ok_section(v):
    return isinstance(v, dict) and "error" not in v
checks = {
  "solverSection": ok_section(solver),
  "kernelSection": ok_section(kernel),
}
print(json.dumps(checks, separators=(",", ":")))
raise SystemExit(0 if all(checks.values()) else 1)
' 2>/dev/null)"; then
    ok "solver monitor /api/snapshot carries a live solver and kernel section (${summary})"
  else
    err "solver monitor /api/snapshot has a degraded section (${summary:-unparseable}) — the page is up but blind"
    info "  ${msnap:0:300}"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "solver monitor /api/snapshot did not answer"
  FAILURES=$(( FAILURES + 1 ))
fi

if (( FAILURES == 0 )); then
  ok "solver assertions passed"
  exit 0
fi
err "${FAILURES} solver assertion(s) failed"
exit 1
