#!/usr/bin/env bash
# Verify that the RENDERED compose configuration really asks for the artifacts this
# repository froze, and that the proof-data cache topology is the one that was tested.
#
# config/artifact-decisions.json says what we promised to consume and
# images/proof-server-mirror/mirror-manifest.json says what the proof mirror is. Neither
# can tell whether Compose actually asks for those bytes — a default could be edited, a
# digest replaced by a tag, a read-only mount made writable, or a proof server's dependency
# on the cache initializer dropped, and every existing static check would still pass.
#
# So this renders each fragment combination with `docker compose config` — after every
# ${VAR:-default} resolves exactly the way the daemon will see it — and asserts the result.
#
#   ./scripts/verify-compose-pins.sh              # every documented fragment combination
#   ./scripts/verify-compose-pins.sh --self-test  # also prove the checks bite
#
# Offline: `docker compose config` is client-side, so no daemon, network or registry is
# touched. It deliberately renders with an EMPTY env file, so what it checks is the
# committed defaults rather than whatever happens to be in somebody's .env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

MATRIX="$REPO_ROOT/config/artifact-decisions.json"
MIRROR="$REPO_ROOT/images/proof-server-mirror/mirror-manifest.json"
CHECKER="$REPO_ROOT/scripts/lib/compose_pins.py"

SELF_TEST=0
[[ "${1:-}" == "--self-test" ]] && SELF_TEST=1

command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v docker  >/dev/null 2>&1 || die "docker is required to render the compose configuration"
[[ -f "$MATRIX"  ]] || die "missing artifact decision matrix: $MATRIX"
[[ -f "$MIRROR"  ]] || die "missing proof-server mirror record: $MIRROR"
[[ -f "$CHECKER" ]] || die "missing checker: $CHECKER"

# An empty env file, so committed defaults are what gets audited. /dev/null is not used
# because some compose versions reject a non-regular file here.
EMPTY_ENV="$(mktemp)"
trap 'rm -f "$EMPTY_ENV"' EXIT

# The combinations a user can actually ask for. `core` is unconditional; every other
# fragment is additive on top of it. `solver` is only rendered together with `offerfiles`
# because it takes the kernel image as an additional build context.
COMBOS=(
  "core"
  "core offerfiles"
  "core aa"
  "core evm"
  "core frontend"
  # `core shielded-night` ALONE is rendered on purpose. The shielded-night profile depends on
  # nothing but core (spec FR-002), and the cheapest way to keep that true is to make a
  # dependency on any other fragment fail to render here.
  "core shielded-night"
  "core offerfiles shielded-night"
  "core offerfiles solver"
  # `core offerfiles prices` is rendered with an EMPTY env file ON PURPOSE, and that is
  # the point of listing it: the price feed is the one service that needs a real secret,
  # and this proves the fragment still RENDERS without it. A `${COINGECKO_API_KEY:?…}`
  # would fail right here — which is exactly what it would do inside `./down.sh` for
  # every operator who has no key, since down.sh passes every fragment (00010 Q23).
  "core offerfiles prices"
  "core offerfiles aa evm frontend shielded-night solver"
)

FAILURES=0
FIRST_RENDER=""

for combo in "${COMBOS[@]}"; do
  files=()
  for frag in $combo; do files+=(-f "$REPO_ROOT/compose/${frag}.yml"); done

  render="$(mktemp)"
  # `--profile fund --profile shielded-night-verify` so the two profile-gated one-shots are
  # rendered too; they are otherwise filtered out and their image pins would never be checked.
  # A `profiles:` key is how this repository declares a service `up -d` must not start, so
  # without this the checks would silently skip exactly those services.
  # ${files[@]+…} guards the empty case: macOS bash 3.2 errors on "${files[@]}" under
  # `set -u` when the array has no elements. Same note as lib/common.sh's dc().
  if ! docker compose --env-file "$EMPTY_ENV" --profile fund --profile shielded-night-verify ${files[@]+"${files[@]}"} config --format json \
       >"$render" 2>"$render.err"; then
    err "compose could not render: ${combo}"
    sed 's/^/      /' "$render.err" >&2
    FAILURES=$(( FAILURES + 1 ))
    rm -f "$render" "$render.err"
    continue
  fi
  rm -f "$render.err"

  if python3 "$CHECKER" "$render" --matrix "$MATRIX" --mirror "$MIRROR" >/dev/null; then
    ok "compose pins verified: ${combo}"
  else
    err "compose pin violations: ${combo}"
    python3 "$CHECKER" "$render" --matrix "$MATRIX" --mirror "$MIRROR" 2>&1 | sed 's/^/      /' >&2 || true
    FAILURES=$(( FAILURES + 1 ))
  fi

  # The self-test mutates the WIDEST rendering — both proof servers, the indexer, the cache
  # initializer and both toolkit one-shots — so every fixture has something to break. A
  # fixture whose target service is absent would mutate nothing and be scored as "the checker
  # did not bite", which is a failure for the wrong reason.
  [[ -z "$FIRST_RENDER" && "$combo" == "core offerfiles aa evm frontend shielded-night solver" ]] \
    && FIRST_RENDER="$render" && continue
  rm -f "$render"
done

if (( SELF_TEST )); then
  echo
  log "negative fixtures (each mutates the real rendered document)"
  if [[ -z "$FIRST_RENDER" ]]; then
    err "no full-stack rendering was produced, so the self-test has nothing to mutate"
    FAILURES=$(( FAILURES + 1 ))
  elif python3 "$CHECKER" "$FIRST_RENDER" --matrix "$MATRIX" --mirror "$MIRROR" --self-test \
       | sed -n '/negative fixtures\|ACCEPT\|reject/p'; then
    ok "every negative fixture was rejected"
  else
    err "a known-bad compose rendering was ACCEPTED"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi
[[ -n "$FIRST_RENDER" ]] && rm -f "$FIRST_RENDER"

if (( FAILURES == 0 )); then
  ok "rendered compose agrees with the frozen artifact decisions and the mirror record"
  exit 0
fi
err "${FAILURES} compose pin check(s) failed"
exit 1
