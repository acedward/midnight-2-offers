#!/usr/bin/env bash
#
# verify-oneshots.sh — every one-shot in this stack exited 0 AND SAID IT DID THE WORK.
#
#   ./scripts/verify-oneshots.sh                one-shots present in this stack
#   ./scripts/verify-oneshots.sh --require-all  …and every one the matrix declares must be here
#
# WHY `exited 0` IS NOT COVERAGE. Every one-shot in this repository is idempotent, and every one
# of them has a path where it correctly does nothing: `faucet-deploy` verifies an existing
# registry instead of deploying, `faucet-mint` skips a grant whose balance is already met,
# `shielded-night-deploy` joins the contract on the volume, `poster-fund` finds the wallet
# already funded, `registry-bridge` exits 0 by design when there is no kernel to teach. Those are
# the RIGHT behaviours — and they are indistinguishable, by exit code, from a one-shot that
# started, hit its no-op branch for the wrong reason, and left the stack unconfigured. That is
# not hypothetical: the whole reason `up.sh` re-reads the registry and the contract address
# through the SERVICE rather than trusting `service_completed_successfully` is that compose's
# gate is equally satisfied by a resume against a volume from a previous chain.
#
# So the assertion is what the one-shot WROTE. The expected output lives beside the coverage
# claim it supports, in config/e2e-coverage.json as each one-shot's `logPattern` — this script is
# the "output assertion from config/e2e-coverage.json" every one-shot row names.
#
# It reads containers by compose LABEL, so it needs no profile list and no fragment set, and it
# works for one-shots from any profile that happens to be up.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

REQUIRE_ALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-all) REQUIRE_ALL=1; shift ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

require_docker
load_env

COVERAGE="$REPO_ROOT/config/e2e-coverage.json"
[[ -f "$COVERAGE" ]] || die "config/e2e-coverage.json is missing — it is where the output assertions live"

FAILURES=0
CHECKED=0
SKIPPED=0

echo
log "one-shot output assertions (config/e2e-coverage.json)"

# service<TAB>profile<TAB>logPattern, one per one-shot row.
ONESHOTS="$(python3 -c '
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
for row in doc.get("services", []):
    if row.get("kind") != "one-shot":
        continue
    print("\t".join([row["service"], row.get("profile", "?"), row.get("logPattern", "")]))
' "$COVERAGE")"

if [[ -z "$ONESHOTS" ]]; then
  err "the coverage matrix declares no one-shots — that cannot be right"
  exit 1
fi

while IFS=$'\t' read -r SVC PROFILE PATTERN; do
  [[ -n "$SVC" ]] || continue
  if [[ -z "$PATTERN" ]]; then
    err "${SVC}: the matrix declares no logPattern (verify-e2e-coverage.sh should have caught this)"
    FAILURES=$(( FAILURES + 1 ))
    continue
  fi

  CID="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=${SVC}" 2>/dev/null | head -1)"

  if [[ -z "$CID" ]]; then
    if (( REQUIRE_ALL )); then
      err "no ${SVC} container for project '${COMPOSE_PROJECT_NAME}' — the '${PROFILE}' profile did not run"
      info "  --require-all was passed, so a profile that silently did not come up is a failure"
      FAILURES=$(( FAILURES + 1 ))
    else
      dim "${SVC}: not in this stack (profile '${PROFILE}' not up) — skipped"
      SKIPPED=$(( SKIPPED + 1 ))
    fi
    continue
  fi

  CHECKED=$(( CHECKED + 1 ))

  RC="$(docker inspect -f '{{.State.ExitCode}}' "$CID" 2>/dev/null || echo '?')"
  STATE="$(docker inspect -f '{{.State.Status}}' "$CID" 2>/dev/null || echo '?')"
  if [[ "$STATE" == "running" ]]; then
    err "${SVC} is still RUNNING — it is declared a one-shot and one-shots exit"
    FAILURES=$(( FAILURES + 1 ))
    continue
  fi
  if [[ "$RC" != "0" ]]; then
    err "${SVC} exited ${RC}"
    info "  logs: docker logs ${CID}"
    FAILURES=$(( FAILURES + 1 ))
    continue
  fi

  # Both streams: several of these entrypoints write their progress to stderr on purpose.
  # `grep -c` with a `|| true` guard, never `grep -q` — grep -q closes the pipe on its first
  # match, docker logs can then die on SIGPIPE, and the pipeline reports the opposite of the
  # truth (the same trap verify.sh's indexer section documents).
  HITS="$(docker logs "$CID" 2>&1 | grep -cE -- "$PATTERN" || true)"
  if [[ "${HITS:-0}" =~ ^[0-9]+$ ]] && (( HITS >= 1 )); then
    ok "${SVC} exited 0 and said so: /${PATTERN}/ matched ${HITS}x"
  else
    err "${SVC} exited 0 but never printed /${PATTERN}/ — it did not do the work it exists for"
    info "  last 20 lines:"
    docker logs --tail 20 "$CID" 2>&1 | sed 's/^/      /' || true
    FAILURES=$(( FAILURES + 1 ))
  fi
done <<< "$ONESHOTS"

echo
if (( FAILURES == 0 )); then
  ok "one-shots: ${CHECKED} checked, ${SKIPPED} not in this stack, 0 failures"
  exit 0
fi
err "one-shots: ${FAILURES} of ${CHECKED} failed"
exit 1
