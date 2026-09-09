#!/usr/bin/env bash
#
# verify-e2e-coverage.sh — OFFLINE. Every compose service is exercised by the gate, and every
# claim in config/e2e-coverage.json still points at an assertion that exists.
#
#   ./scripts/verify-e2e-coverage.sh              the check
#   ./scripts/verify-e2e-coverage.sh --self-test  prove the check still bites
#
# WHY THIS EXISTS. "The e2e gate covers everything" is the kind of claim that is true on the day
# it is written and quietly false a month later: a new compose service lands with no assertion, an
# assertion is renamed, a one-shot's only check is `exited 0`. None of those fails anything today
# — the gate goes green while a service nobody tests runs in production-shaped configuration.
#
# So the matrix is DATA, not prose, and this reads it:
#
#   completeness  every service `docker compose config --services` renders (with EVERY compose
#                 `profiles:` value enabled, or the three profile-gated one-shots would be
#                 invisible) has exactly one row, and every row names a service that exists.
#   liveness      every check names a script that is present, and that script still CONTAINS the
#                 assertion's literal text. Renaming an ok/err line without updating the matrix
#                 fails here rather than silently un-covering a service.
#   one-shots     a one-shot must carry `logPattern` — an OUTPUT assertion. `exited 0` is not
#                 coverage: a one-shot that takes its resume path and does nothing exits 0 too.
#                 scripts/verify-oneshots.sh applies these patterns on a live stack.
#   services      a long-running service must have at least one check marked `behavioural`. An
#                 HTTP 200 from an SPA-fallback server, or a healthcheck the service itself
#                 defines, is not evidence that it does its job.
#   on-demand     a `profiles:`-gated service is never started by `up`, so some gate step has to
#                 RUN it; the row must name the script that does.
#   doc parity    docs/E2E-COVERAGE.md names the same services. The doc is what a human reads.
#
# Needs: docker compose (for `config`, which is offline — no daemon, no network) and python3.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

SELF_TEST=0
CONFIG_OVERRIDE=""
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test) SELF_TEST=1; shift ;;
    --config)    CONFIG_OVERRIDE="${2:?--config needs a path}"; shift 2 ;;
    --quiet)     QUIET=1; shift ;;
    -h|--help)   sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── the authoritative service list ───────────────────────────────────────────
# EVERY fragment together, and EVERY compose `profiles:` value enabled. Two reasons:
#   * a fragment cannot be rendered alone (compose/poster.yml references `kernel`, which lives in
#     compose/offerfiles.yml) — infra issue 00018 is the same fact biting profile_services();
#   * `config --services` HONOURS profiles, so without --profile the three gated one-shots
#     (`fund`, `faucet-mint-test`, `shielded-night-verify`) are simply not listed, and a matrix
#     that never had to mention them would look complete.
compose_service_list() {
  local args=() f p
  for f in "$REPO_ROOT"/compose/*.yml; do
    [[ -e "$f" ]] || continue
    args+=(-f "$f")
  done
  # Discovered, not hardcoded: a new gated service brings its profile with it.
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    args+=(--profile "$p")
  done < <(grep -hoE "profiles: *\['[a-z0-9-]+'\]" "$REPO_ROOT"/compose/*.yml \
             | sed -E "s/.*\['(.*)'\]/\1/" | sort -u)
  docker compose "${args[@]}" config --services 2>/dev/null | sort -u
}

SERVICES_FILE="$(mktemp -t e2e-coverage-services.XXXXXX)"
trap 'rm -f "$SERVICES_FILE"' EXIT
compose_service_list > "$SERVICES_FILE"
if [[ ! -s "$SERVICES_FILE" ]]; then
  err "docker compose config --services rendered nothing — the fragments do not parse"
  exit 1
fi

# ── the checker ──────────────────────────────────────────────────────────────
run_check() {  # run_check <config-path> ; prints its own report, returns non-zero on failure
  E2E_CONFIG="$1" E2E_SERVICES="$SERVICES_FILE" E2E_ROOT="$REPO_ROOT" E2E_QUIET="${2:-0}" \
  python3 - <<'PY'
import json, os, sys

root     = os.environ["E2E_ROOT"]
cfg_path = os.environ["E2E_CONFIG"]
quiet    = os.environ.get("E2E_QUIET") == "1"

failures = []
def bad(msg):
    failures.append(msg)

try:
    with open(cfg_path, encoding="utf-8") as fh:
        doc = json.load(fh)
except Exception as exc:                     # noqa: BLE001 - the message IS the diagnosis
    print("    FAIL config/e2e-coverage.json does not parse: %s" % exc, file=sys.stderr)
    raise SystemExit(1)

rows = doc.get("services")
if not isinstance(rows, list) or not rows:
    print("    FAIL the matrix has no `services` array", file=sys.stderr)
    raise SystemExit(1)

with open(os.environ["E2E_SERVICES"], encoding="utf-8") as fh:
    rendered = sorted({line.strip() for line in fh if line.strip()})

# ── completeness ────────────────────────────────────────────────────────────
named = [r.get("service", "") for r in rows]
dupes = sorted({s for s in named if named.count(s) > 1})
for s in dupes:
    bad("%s has more than one row in the matrix" % s)

missing = [s for s in rendered if s not in named]
for s in missing:
    bad("compose renders service '%s' and the matrix has NO row for it "
        "— it is not exercised by any gate step" % s)

extra = [s for s in named if s not in rendered]
for s in extra:
    bad("the matrix has a row for '%s', which compose does not render "
        "(deleted service, or a typo)" % s)

# ── per-row liveness ────────────────────────────────────────────────────────
KINDS = {"service", "one-shot", "on-demand"}
script_cache = {}
def script_text(rel):
    if rel not in script_cache:
        path = os.path.join(root, rel)
        try:
            with open(path, encoding="utf-8") as fh:
                script_cache[rel] = fh.read()
        except OSError:
            script_cache[rel] = None
    return script_cache[rel]

for row in rows:
    svc  = row.get("service", "<unnamed>")
    kind = row.get("kind")
    if kind not in KINDS:
        bad("%s: kind is %r, expected one of %s" % (svc, kind, sorted(KINDS)))
    for field in ("fragment", "profile", "why"):
        if not str(row.get(field, "")).strip():
            bad("%s: `%s` is empty" % (svc, field))
    frag = row.get("fragment", "")
    if frag and not os.path.exists(os.path.join(root, frag)):
        bad("%s: fragment %s does not exist" % (svc, frag))

    checks = row.get("checks")
    if not isinstance(checks, list) or not checks:
        bad("%s: no checks — every service must name at least one assertion" % svc)
        checks = []

    for chk in checks:
        rel = str(chk.get("script", ""))
        assertion = str(chk.get("assertion", ""))
        if not str(chk.get("step", "")).strip():
            bad("%s: a check does not name the gate step that runs it" % svc)
        if not rel:
            bad("%s: a check names no script" % svc)
            continue
        body = script_text(rel)
        if body is None:
            bad("%s: check names script %s, which does not exist" % (svc, rel))
            continue
        if not assertion:
            bad("%s: the check in %s names no assertion" % (svc, rel))
        elif assertion not in body:
            bad("%s: %s no longer contains the assertion %r "
                "— it was renamed or removed, so this service is now uncovered" % (svc, rel, assertion))

    if kind == "one-shot":
        pattern = str(row.get("logPattern", ""))
        if not pattern.strip():
            bad("%s is a one-shot with no `logPattern` — a one-shot needs an OUTPUT assertion, "
                "because a resume path exits 0 having done nothing" % svc)
        runner = doc.get("oneShotRunner", "scripts/verify-oneshots.sh")
        if not any(str(c.get("script", "")) == runner for c in checks):
            bad("%s is a one-shot but no check names %s, which is what applies its logPattern"
                % (svc, runner))
    else:
        if str(row.get("logPattern", "")).strip():
            bad("%s is %s, not a one-shot, but carries a logPattern" % (svc, kind))

    if kind == "service" and not any(c.get("behavioural") is True for c in checks):
        bad("%s is a long-running service with no BEHAVIOURAL check — a healthcheck or an HTTP "
            "200 is not evidence that it does its job" % svc)

    if kind == "on-demand" and not checks:
        bad("%s is profiles:-gated, so a gate step has to RUN it; no check names one" % svc)

# ── the one-shot runner must exist and be executable ────────────────────────
runner = doc.get("oneShotRunner", "scripts/verify-oneshots.sh")
runner_path = os.path.join(root, runner)
if not os.path.isfile(runner_path):
    bad("oneShotRunner %s does not exist" % runner)
elif not os.access(runner_path, os.X_OK):
    bad("oneShotRunner %s is not executable" % runner)

# ── doc parity ──────────────────────────────────────────────────────────────
doc_path = os.path.join(root, "docs", "E2E-COVERAGE.md")
try:
    with open(doc_path, encoding="utf-8") as fh:
        doc_text = fh.read()
except OSError:
    bad("docs/E2E-COVERAGE.md is missing — the matrix has no human-readable half")
    doc_text = ""
if doc_text:
    for svc in sorted(set(named)):
        if ("`%s`" % svc) not in doc_text:
            bad("docs/E2E-COVERAGE.md does not name `%s`" % svc)

# ── report ──────────────────────────────────────────────────────────────────
if failures:
    for f in failures:
        print("    FAIL %s" % f, file=sys.stderr)
    print("    FAIL e2e coverage: %d problem(s)" % len(failures), file=sys.stderr)
    raise SystemExit(1)

if not quiet:
    kinds = {}
    for r in rows:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    checks_total = sum(len(r.get("checks") or []) for r in rows)
    print("    OK   e2e coverage: %d compose services, all with a row (%s)"
          % (len(rendered),
             ", ".join("%d %s" % (n, k) for k, n in sorted(kinds.items()))))
    print("    OK   %d assertion(s) named, every one still present in its script" % checks_total)
    print("    OK   every one-shot carries an OUTPUT assertion (logPattern)")
raise SystemExit(0)
PY
}

# ── --self-test: prove the check still bites ────────────────────────────────
#
# A coverage checker that has stopped failing is worse than no checker: it reports the
# reassuring line every run. Each mutation below is a real regression this is meant to catch.
self_test() {
  local tmp rc pass=0 total=0
  tmp="$(mktemp -t e2e-coverage-selftest.XXXXXX)"

  probe() {  # probe <label> <python-mutation>
    total=$(( total + 1 ))
    E2E_SRC="$REPO_ROOT/config/e2e-coverage.json" E2E_DST="$tmp" python3 - "$2" <<'PY'
import json, os, sys
doc = json.load(open(os.environ["E2E_SRC"], encoding="utf-8"))
exec(sys.argv[1], {"doc": doc})
json.dump(doc, open(os.environ["E2E_DST"], "w", encoding="utf-8"))
PY
    if run_check "$tmp" 1 >/dev/null 2>&1; then
      err "self-test: '${1}' was NOT caught — this check has stopped biting"
    else
      ok "self-test: '${1}' is caught"
      pass=$(( pass + 1 ))
    fi
  }

  probe "a compose service with no row" \
    'doc["services"] = [r for r in doc["services"] if r["service"] != "kernel"]'
  probe "a row naming a service compose does not render" \
    'doc["services"][0]["service"] = "a-service-that-does-not-exist"'
  probe "an assertion that no longer exists in its script" \
    'doc["services"][0]["checks"][0]["assertion"] = "this text is in no script anywhere"'
  probe "a check naming a script that is not there" \
    'doc["services"][0]["checks"][0]["script"] = "scripts/verify-nothing.sh"'
  probe "a one-shot with no OUTPUT assertion" \
    '[r.update(logPattern="") for r in doc["services"] if r["kind"] == "one-shot"][:1]'
  probe "a long-running service with no behavioural check" \
    '[[c.pop("behavioural", None) for c in r["checks"]] for r in doc["services"] if r["kind"] == "service"]'

  rm -f "$tmp"
  echo
  if (( pass == total )); then
    ok "e2e-coverage self-test passed (${pass}/${total})"
    return 0
  fi
  err "e2e-coverage self-test: ${pass}/${total} mutations caught"
  return 1
}

if (( SELF_TEST )); then
  log "e2e coverage matrix — self-test"
  self_test
  exit $?
fi

log "e2e coverage matrix (config/e2e-coverage.json)"
run_check "${CONFIG_OVERRIDE:-$REPO_ROOT/config/e2e-coverage.json}" "$QUIET"
