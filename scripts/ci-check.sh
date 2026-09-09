#!/usr/bin/env bash
#
# One command that proves this stack works end to end, on ports that cannot collide with
# anything else on the machine, and leaves nothing behind afterwards.
#
#   ./scripts/ci-check.sh              # every profile that exists, funded and verified
#   ./scripts/ci-check.sh --core-only  # core stack only: no image build, ~2 min
#   ./scripts/ci-check.sh --no-fund    # skip funding; verify then covers genesis wallets only
#
# The steps, in order:
#   1.  static      the offline artifact gates AND the e2e coverage matrix (every compose
#                   service has a row naming the assertion that exercises it)
#   2.  up          the requested profiles, blocking until each is genuinely usable — and, in
#                   --all mode, an assertion that the `prices` profile really started
#   3.  fund        fund-wallet.sh --all-demo (the demo-* and mnemonic-* wallets)
#   3b. fund svc    the `fund` COMPOSE one-shot, narrowed to one probe wallet
#   4a. verify      verify.sh --aa-mint --faucet-mint (every profile's section)
#   4b. pins        the running images carry the pinned commits
#   4c. wallets     verify-wallets.sh --include-script-funded
#   4d. one-shots   every one-shot's OUTPUT assertion, from config/e2e-coverage.json
#   4e. spa         the SPA's headless take (through the batcher) and make
#   4f. aa-e2e      register x2 -> mint -> deposit -> transfer -> withdraw, four execute proofs
#   5.  down -v     full teardown, then ASSERT that nothing survived
#
# Every step's output is also written to .ci-logs/<project>/<step>.log, and the run ends with a
# table of step timings.
#
# Three properties this has that a hand-run sequence does not:
#
#   * It never touches ./.env or the default ports. Everything runs against a generated env
#     file, so a CI run cannot disturb (or be disturbed by) a stack somebody left up.
#   * It tears down on every exit path — failure, Ctrl-C, or SIGTERM — because up.sh
#     deliberately leaves a failed stack running for inspection, which is right for a human
#     and wrong for CI.
#   * The teardown is ASSERTED, not assumed. Containers, networks and volumes are counted by
#     compose-project label AND by name prefix: a volume created outside compose carries no
#     project label at all, so a label-only count once reported a clean teardown while the
#     toolkit cache survived (see the plan's volume-labels finding).
#
set -uo pipefail   # deliberately NOT -e: every step's failure is handled and reported

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

PROFILE_MODE=all      # all | core | list
WITH_LIST=()
DO_FUND=1
DO_FUND_SERVICE=1
DO_PRICES=1
DO_AA_MINT=1
DO_FAUCET_MINT=1
DO_SPA_ROUNDTRIP=1
DO_AA_E2E=1
KEEP=0
CI_ENV_FILE=""

usage() {
  cat <<'EOF'
Usage: ./scripts/ci-check.sh [options]

Runs pick-ports -> up -> fund -> verify -> down -v on a random free port block above
10100, and fails if anything is left behind. Exit 0 means the whole chain passed and the
machine is clean.

Options:
  --core-only        core profile only (skips the umbra-evm image build)
  --with <profile>   bring up specific profiles instead of --all; repeatable
  --no-fund          skip the funding step
  --no-fund-service  skip step 3b (the `fund` compose one-shot on one probe wallet)
  --no-prices        do NOT require the `prices` profile. WITHOUT this flag, an --all run with
                     no COINGECKO_API_KEY in the ENVIRONMENT fails immediately and says so,
                     instead of quietly leaving one profile and one service untested
  --no-aa-mint       skip the console mint through the local issuers (verify.sh --aa-mint)
  --no-faucet-mint   skip the real faucet mint (verify.sh --faucet-mint)
  --no-spa-roundtrip skip step 4e (the SPA's headless take + make)
  --no-aa-e2e        skip step 4f (the EVM-signed execute path)
  --keep             on failure, leave the stack up for inspection (still cleaned on success)
  --env-file <path>  write the generated env file here and keep it (default: a temp file in
                     the repo, removed on exit)
  -h, --help         this text

Exit codes: 0 pass, 1 a step failed or something survived teardown, 2 bad usage.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only) PROFILE_MODE=core; shift ;;
    --with)      PROFILE_MODE=list; WITH_LIST+=(--with "${2:?--with needs a profile name}"); shift 2 ;;
    --no-fund)   DO_FUND=0; shift ;;
    --no-fund-service) DO_FUND_SERVICE=0; shift ;;
    --no-prices) DO_PRICES=0; shift ;;
    --no-aa-mint) DO_AA_MINT=0; shift ;;
    --no-faucet-mint) DO_FAUCET_MINT=0; shift ;;
    --no-spa-roundtrip) DO_SPA_ROUNDTRIP=0; shift ;;
    --no-aa-e2e) DO_AA_E2E=0; shift ;;
    --keep)      KEEP=1; shift ;;
    --env-file)  CI_ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
done

PROFILE_ARGS=()
case "$PROFILE_MODE" in
  all)  PROFILE_ARGS=(--all) ;;
  core) PROFILE_ARGS=() ;;
  # `list` implies at least one --with, so WITH_LIST is non-empty here, but it is expanded
  # with the ${arr[@]+…} guard anyway: macOS bash 3.2 turns "${arr[@]}" on an empty array
  # into an `unbound variable` error under `set -u`, and this file already relies on that
  # guard for PROFILE_ARGS in step 2 below.
  list) PROFILE_ARGS=(${WITH_LIST[@]+"${WITH_LIST[@]}"}) ;;
esac

# ── the `prices` precondition (checked BEFORE anything is built) ────────────
#
# `up.sh --all` deliberately DROPS the `prices` profile when COINGECKO_API_KEY is unset (Q23 —
# it is the one value in this repository that is a real secret and has no default), and
# `verify.sh` then auto-skips the prices section because there is no container. Both are
# correct on their own, and together they mean a full `ci-check.sh` can pass with one profile
# and one service never started. That is not hypothetical: infra issue 00013 is a run whose
# `--all` announced eight profiles and no `prices`, because `--env-file` had overwritten the
# file the key was in.
#
# So an --all run REQUIRES the key, in the PROCESS ENVIRONMENT (never --env-file, for exactly
# the reason above), and fails here — before a single image is built — rather than reporting a
# green gate over a gap. `--no-prices` is the explicit opt-out for a host that has no key.
if [[ "$PROFILE_MODE" == "all" && $DO_PRICES -eq 1 && -z "${COINGECKO_API_KEY:-}" ]]; then
  err "this gate requires the 'prices' profile, and COINGECKO_API_KEY is not in the environment"
  info "  Without it, up.sh --all drops the profile and verify.sh skips the section: the run"
  info "  would pass having never started price-feed at all (infra issue 00013)."
  info ""
  info "  Put the key in the PROCESS ENVIRONMENT, not in the env file — ci-check regenerates"
  info "  the env file it is given, so a key written there is destroyed before anything starts:"
  info "      set -a; . \$HOME/.midnight-2-offers.coingecko.env; set +a; ./scripts/ci-check.sh"
  info "  or opt out explicitly, accepting the coverage gap:"
  info "      ./scripts/ci-check.sh --no-prices"
  exit 1
fi

require_docker

# This gate builds every shipped local image. Serialise Compose builds by default so the
# disposable clean-machine proof also works on small/shared Docker hosts without concurrent
# compiler/download layers multiplying the peak disk requirement. Callers with ample headroom
# can still opt in to more concurrency explicitly.
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"
info "compose build parallelism ${COMPOSE_PARALLEL_LIMIT}"

# ── the disposable stack ─────────────────────────────────────────────────────
KEEP_ENV_FILE=1
if [[ -z "$CI_ENV_FILE" ]]; then
  # Inside the repo, not /tmp: ENV_FILE is also read by the compose --env-file flag, and a
  # repo-relative path keeps the whole run reproducible from the log. `.env.*` is gitignored.
  CI_ENV_FILE="$REPO_ROOT/.env.ci.$$"
  KEEP_ENV_FILE=0
fi

log "generating a collision-free stack definition"
if ! PROJECT_PREFIX=demo-infra-ci "$REPO_ROOT/scripts/pick-ports.sh" > "$CI_ENV_FILE"; then
  err "pick-ports.sh could not find a free port block"
  rm -f "$CI_ENV_FILE"
  exit 1
fi
export ENV_FILE="$CI_ENV_FILE"
load_env
info "project ${COMPOSE_PROJECT_NAME}"
info "ports   node=${NODE_HOST_PORT} indexer=${INDEXER_HOST_PORT} proof=${PROOF_HOST_PORT} evm=${EVM_RPC_HOST_PORT:-?}/${EVM_WS_HOST_PORT:-?}"
info "env     ${CI_ENV_FILE}"
info "proof   plain ${PROOF_IMAGE#*@}"
info "        experimental ${AA_PROOF_IMAGE#*@}"
info "        shared proof-data generation ${PROOF_DATA_GENERATION:0:16}…"

# Generated by pick-ports.sh: unique to this run, so concurrent checkouts cannot
# overwrite or reuse our image tags. Teardown removes the tags after containers.
CI_IMAGE_TAGS=(
  "${AA_E2E_IMAGE:-}" "${AA_CONSOLE_IMAGE:-}" "${AA_IMAGE:-}"
  "${SOLVER_IMAGE:-}" "${SOLVER_SINK_IMAGE:-}" "${FRONTEND_IMAGE:-}"
  "${EVM_IMAGE:-}" "${KERNEL_IMAGE:-}" "${CELESTIA_IMAGE:-}" "${INDEXER_IMAGE:-}" "${POSTGRES_IMAGE:-}"
  "${PROOF_PARAMS_IMAGE:-}"
  # BOTH shielded-night tags: one build context, two runtime targets, two image names. Listing
  # only one would leave the other behind and the teardown assertion would still say "clean".
  "${SHIELDED_NIGHT_IMAGE:-}" "${SHIELDED_NIGHT_DEPLOY_IMAGE:-}"
  # And BOTH mint-test-tokens tags, for exactly the same reason: one build context, a runner
  # target and a site target.
  "${FAUCET_RUNNER_IMAGE:-}" "${FAUCET_SITE_IMAGE:-}"
)

# ── teardown, asserted ───────────────────────────────────────────────────────
TORE_DOWN=0
FAILED=0
FAILED_STEP=""
# Declared HERE, not beside step(), because the EXIT trap prints them and a failure between
# the trap and step()'s definitions would otherwise die on an unbound variable under `set -u`.
STEP_IDS=()
STEP_LABELS=()
STEP_SECS=()
STEP_STATES=()

# leak_count — prints "<containers> <volumes> <networks> <unlabelled-volumes>" for this project.
# The fourth number is the one that matters most: `docker volume create` (or a `docker run -v`)
# makes a volume with NO compose labels, so it is invisible to the first three counts.
leak_count() {
  local c v n u
  c=$(docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" | wc -l | tr -d ' ')
  v=$(docker volume ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" | wc -l | tr -d ' ')
  n=$(docker network ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" | wc -l | tr -d ' ')
  u=$(docker volume ls -q | grep -cE "^${COMPOSE_PROJECT_NAME}[-_]" || true)
  printf '%s %s %s %s\n' "$c" "$v" "$n" "$u"
}

teardown() {
  local rc=$?
  (( TORE_DOWN )) && return 0
  TORE_DOWN=1

  if (( KEEP && FAILED )); then
    echo
    warn "--keep: leaving project '${COMPOSE_PROJECT_NAME}' up for inspection"
    warn "clean it with: ENV_FILE=${CI_ENV_FILE} ./down.sh -v"
    return 0
  fi

  echo
  log "step 5/5: down -v (always runs, on every exit path)"
  if ! "$REPO_ROOT/down.sh" -v; then
    err "down.sh -v reported a problem"
    FAILED=1; FAILED_STEP="${FAILED_STEP:-down}"
  fi

  # Assert, rather than trust the exit code above.
  read -r C V N U <<<"$(leak_count)"
  local cache="$REPO_ROOT/.cache/${COMPOSE_PROJECT_NAME}"
  local cachestate="none"
  [[ -d "$cache" ]] && cachestate="PRESENT"
  info "after teardown: containers=${C} volumes=${V} networks=${N} unlabelled-volumes=${U} toolkit-cache=${cachestate}"
  if (( C != 0 || V != 0 || N != 0 || U != 0 )) || [[ "$cachestate" != "none" ]]; then
    err "something survived the teardown — this stack is not disposable"
    (( C )) && docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}"
    (( V + U )) && docker volume ls | grep -E "${COMPOSE_PROJECT_NAME}" || true
    FAILED=1; FAILED_STEP="${FAILED_STEP:-teardown-leak}"
  else
    ok "nothing left behind"
  fi

  local image image_leaks=0
  for image in "${CI_IMAGE_TAGS[@]}"; do
    [[ -n "$image" ]] || continue
    docker image rm "$image" >/dev/null 2>&1 || true
    if docker image inspect "$image" >/dev/null 2>&1; then
      err "CI-specific image tag survived teardown: ${image}"
      image_leaks=$(( image_leaks + 1 ))
    fi
  done
  if (( image_leaks )); then
    FAILED=1; FAILED_STEP="${FAILED_STEP:-image-leak}"
  else
    ok "CI-specific image tags removed"
  fi

  if (( ! KEEP_ENV_FILE )); then
    rm -f "$CI_ENV_FILE"
    info "removed ${CI_ENV_FILE}"
  fi

  # Report the real outcome even when the trap fired from a signal.
  print_step_table
  info "step logs kept under ${LOG_DIR}"
  echo
  if (( FAILED )); then
    err "ci-check: FAILED at '${FAILED_STEP:-unknown}'"
    exit 1
  fi
  ok "ci-check: PASSED"
  exit "$rc"
}
trap teardown EXIT
trap 'echo; warn "interrupted"; FAILED=1; FAILED_STEP="interrupted"; exit 130' INT TERM

# ── evidence: one log file per step, and a timing table ─────────────────────
#
# A gate that only says PASSED is not much use the morning a step takes 20 minutes or fails on
# someone else's machine. Each step's console output is ALSO written to a file, and the run
# ends with the step table — which is what goes into the PR body and the plan.
LOG_DIR="${CI_LOG_DIR:-$REPO_ROOT/.ci-logs/${COMPOSE_PROJECT_NAME}}"
mkdir -p "$LOG_DIR"
info "logs    ${LOG_DIR}"

record_step() {  # record_step <id> <label> <seconds> <state>
  STEP_IDS+=("$1"); STEP_LABELS+=("$2"); STEP_SECS+=("$3"); STEP_STATES+=("$4")
}

step() {  # step <id> <label> <command...>
  local n="$1" label="$2"; shift 2
  local t0=$SECONDS rc
  local logfile="${LOG_DIR}/$(printf '%s' "$n" | tr -c 'A-Za-z0-9._-' '-')".log
  echo
  log "step ${n}: ${label}"
  # `pipefail` is set at the top of this file, so the pipeline's status is the COMMAND's.
  # Without it every step would report success because `tee` succeeded.
  "$@" 2>&1 | tee "$logfile"
  rc=$?
  if (( rc == 0 )); then
    ok "step ${n} passed in $(( SECONDS - t0 ))s"
    record_step "$n" "$label" "$(( SECONDS - t0 ))" "pass"
    return 0
  fi
  err "step ${n} FAILED after $(( SECONDS - t0 ))s: ${label}"
  info "  full output: ${logfile}"
  record_step "$n" "$label" "$(( SECONDS - t0 ))" "FAIL"
  FAILED=1
  FAILED_STEP="${FAILED_STEP:-$label}"
  return 1
}

skip_step() {  # skip_step <id> <label> <why>
  echo
  dim "step ${1}: ${2} — SKIPPED (${3})"
  record_step "$1" "$2" "0" "skip"
}

print_step_table() {
  local i
  echo
  log "step table"
  printf '    %-4s %-8s %7s  %s\n' "step" "result" "seconds" "what ran"
  printf '    %-4s %-8s %7s  %s\n' "----" "--------" "-------" "--------"
  for (( i = 0; i < ${#STEP_IDS[@]}; i++ )); do
    printf '    %-4s %-8s %7s  %s\n' \
      "${STEP_IDS[$i]}" "${STEP_STATES[$i]}" "${STEP_SECS[$i]}" "${STEP_LABELS[$i]}"
  done
  printf '    %-4s %-8s %7s  %s\n' "" "" "$SECONDS" "TOTAL (wall clock, this process)"
}

# ── the run ──────────────────────────────────────────────────────────────────
# Steps are chained so a failure short-circuits to the teardown rather than piling up
# secondary errors that hide the first one.

# ── step 1: the offline artifact gates ───────────────────────────────────────
#
# Static and offline, so they run before anything is built or pulled, and they fail fast on
# a wrong digest, a dropped platform, a macOS asset, a silently repacked official image, a
# tag-only override, or a proof server that could start against an unverified cache. None
# of them needs the Docker daemon, a network, a registry or a credential.
#
# Four records have to agree with each other and with what Compose actually renders. They
# are separate files on purpose — a matrix, a mirror record, image build pins, and the
# compose fragments — so each check is the one that catches a drift the others cannot see:
#
#   decisions   config/artifact-decisions.json is internally consistent and still makes the
#               choices it froze (`pinsDigest` makes an edited digest visible)
#   fetch       the SHA-256s and asset names baked into images/*/Dockerfile and
#               images/celestia/official-equality.tsv still equal the matrix
#   mirror      images/proof-server-mirror/mirror-manifest.json still equals the matrix
#               (--level offline; `--level manifest` re-reads the live registries and
#               belongs to the networked gate, not here)
#   compose     the RENDERED compose configuration really asks for those bytes, with the
#               proof-cache topology that was tested
#   pin defaults every default of one SOURCE pin (KERNEL_REF, SOLVER_REF, …) agrees across
#               compose/, images/, scripts/ and .env.example. `verify-source-pins.sh` in
#               step 4b compares the RUNNING image against ONE of those copies, so a split
#               pin (which is exactly what this repo shipped before 00010) reads there as a
#               stale image instead of as the configuration defect it is.
#
# Each runs `--self-test` where it has one, so a check that stopped biting is reported as a
# failure rather than passing vacuously.
static_gates() {
  local rc=0
  "$REPO_ROOT/scripts/verify-artifact-decisions.sh" --self-test          || rc=1
  "$REPO_ROOT/scripts/verify-artifact-fetch.sh" --static                 || rc=1
  python3 "$REPO_ROOT/images/proof-server-mirror/verify-mirror.py" \
    --level offline >/dev/null && ok "proof-server mirror record verified (offline)" || rc=1
  "$REPO_ROOT/scripts/verify-compose-pins.sh" --self-test                || rc=1
  "$REPO_ROOT/scripts/verify-pin-defaults.sh"                            || rc=1
  "$REPO_ROOT/scripts/verify-pin-defaults.sh" --self-test >/dev/null \
    && ok "pin-defaults check self-test passed" || rc=1
  # The README's pin table is GENERATED from the same defaults; a stale block or a
  # pin with two values fails here, not in a reader's browser.
  python3 "$REPO_ROOT/scripts/render-readme-pins.py" --check                || rc=1
  python3 "$REPO_ROOT/scripts/render-readme-pins.py" --self-test >/dev/null \
    && ok "README pin-table renderer self-test passed" || rc=1
  # THE COVERAGE MATRIX. Every service compose renders has a row naming the assertion that
  # exercises it, every named assertion is still present in the script that makes it, and every
  # one-shot has an OUTPUT assertion. Its --self-test mutates the matrix six ways and requires
  # each to be caught, so a coverage checker that stopped biting fails here too.
  "$REPO_ROOT/scripts/verify-e2e-coverage.sh"                              || rc=1
  "$REPO_ROOT/scripts/verify-e2e-coverage.sh" --self-test >/dev/null \
    && ok "e2e coverage self-test passed" || rc=1
  return $rc
}

step 1 "offline artifact gates + e2e coverage matrix" \
  static_gates || true

if step 2 "up --build ${PROFILE_ARGS[*]:-(core only)}" \
     "$REPO_ROOT/up.sh" --build "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}"; then

  # ── the prices profile REALLY started ─────────────────────────────────────
  # The key was required before the build; this is the other half — that it reached compose and
  # the container is UP. A price-feed that exited (64 = misconfiguration) or was never created
  # is the silent gap this pair of checks exists to close, and neither `up.sh` (which warns)
  # nor `verify.sh` (which auto-skips an absent profile) turns it into a failure.
  if (( ! FAILED )) && [[ "$PROFILE_MODE" == "all" ]] && (( DO_PRICES )); then
    if [[ -n "$(docker ps -q \
          --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
          --filter "label=com.docker.compose.service=price-feed" 2>/dev/null)" ]]; then
      ok "the prices profile is up: price-feed is running"
    else
      err "the prices profile is up: price-feed is running — NO, it is not"
      info "  --all was requested and COINGECKO_API_KEY was in the environment, so up.sh should"
      info "  have started it. An EXITED container means exit 64 (no key reached the container,"
      info "  or the database has no ledger-v9 schema): docker compose … logs price-feed"
      FAILED=1; FAILED_STEP="${FAILED_STEP:-prices-profile-missing}"
    fi
  fi

  RUN_FUND=1
  (( DO_FUND )) || RUN_FUND=0
  if (( ! FAILED && RUN_FUND )); then
    step 3 "fund the demo and mnemonic wallets" \
      "$REPO_ROOT/scripts/fund-wallet.sh" --all-demo || true
  elif (( ! RUN_FUND )); then
    skip_step 3 "fund the demo and mnemonic wallets" "--no-fund"
  fi

  # ── step 3b: the `fund` COMPOSE service ───────────────────────────────────
  # scripts/fund-wallet.sh reaches the toolkit through `docker run`, so compose's own `fund`
  # service (compose/core.yml, profile `fund`) had NO caller in this gate — the one compose
  # service nothing exercised. FUND_ONLY_SEED narrows it to a single probe wallet: running it
  # unnarrowed here would re-register the dust address of wallets whose facades are live
  # (aa-console, the shielded-night driver, the poster), which is contention for no gain.
  #
  # demo-carol is the probe: a mnemonic wallet, already funded by step 3, held by no
  # long-lived facade anywhere in the stack. The seed is read from wallets/wallets.json rather
  # than written here, so it cannot drift from the file the service itself mounts.
  if (( ! FAILED && DO_FUND_SERVICE )); then
    PROBE_SEED="$(python3 -c '
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
for w in doc.get("wallets", []):
    if w.get("name") == sys.argv[2]:
        print(w.get("seed", "")); break
' "$REPO_ROOT/wallets/wallets.json" "${CI_FUND_PROBE_WALLET:-demo-carol}" 2>/dev/null || true)"
    if [[ -z "$PROBE_SEED" ]]; then
      skip_step 3b "the 'fund' compose one-shot" "no ${CI_FUND_PROBE_WALLET:-demo-carol} in wallets.json"
    else
      # A SUBSHELL function: use_all_profiles exports PROFILES, and `dc` needs every fragment
      # named or compose calls the other profiles' containers orphans on every `run`. Doing it
      # in a subshell keeps that export out of the rest of this script.
      fund_service() (
        use_all_profiles
        dc --profile fund run --rm --no-deps -T -e FUND_ONLY_SEED="$PROBE_SEED" fund
      )
      if step 3b "the 'fund' compose one-shot (one probe wallet)" fund_service; then
        ok "fund compose one-shot funded the probe wallet (${CI_FUND_PROBE_WALLET:-demo-carol})"
      fi
    fi
  elif (( ! DO_FUND_SERVICE )); then
    skip_step 3b "the 'fund' compose one-shot" "--no-fund-service"
  fi

  # ── step 4a: verify.sh, with the two opt-in extras ON ─────────────────────
  # `--aa-mint` and `--faucet-mint` are off for a human (each is minutes of proving) and ON
  # here, because they are the only assertions that exercise the AA console's mint through the
  # LOCAL issuers, upstream's own mint runner, and — through it — the plain proof-server.
  if (( ! FAILED )); then
    VERIFY_ARGS=()
    (( DO_AA_MINT ))     && VERIFY_ARGS+=(--aa-mint)
    (( DO_FAUCET_MINT )) && VERIFY_ARGS+=(--faucet-mint)
    VERIFY_LABEL=""
    (( DO_AA_MINT ))     && VERIFY_LABEL="${VERIFY_LABEL} --aa-mint"
    (( DO_FAUCET_MINT )) && VERIFY_LABEL="${VERIFY_LABEL} --faucet-mint"
    step 4a "verify.sh${VERIFY_LABEL} (every profile section)" \
      "$REPO_ROOT/verify.sh" ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"} || true
  fi
  if (( ! FAILED )); then
    step 4b "verify exact baked source pins" "$REPO_ROOT/scripts/verify-source-pins.sh" || true
  fi
  # The script-funded wallets are only asserted by an explicit flag, so verify.sh alone
  # would never prove that funding worked — it checks the genesis wallets, which are funded
  # whether or not step 3 ran at all.
  if (( ! FAILED && RUN_FUND )); then
    step 4c "verify-wallets.sh --include-script-funded" \
      "$REPO_ROOT/scripts/verify-wallets.sh" --include-script-funded || true
  fi

  # ── step 4d: every one-shot SAID it did the work ──────────────────────────
  # Exit 0 is not coverage: every one-shot here is idempotent and every one has a correct
  # do-nothing path. --require-all in --all mode, so a profile that silently failed to come up
  # is a failure rather than a skipped line.
  if (( ! FAILED )); then
    ONESHOT_ARGS=()
    [[ "$PROFILE_MODE" == "all" ]] && ONESHOT_ARGS=(--require-all)
    step 4d "one-shot output assertions (config/e2e-coverage.json)" \
      "$REPO_ROOT/scripts/verify-oneshots.sh" ${ONESHOT_ARGS[@]+"${ONESHOT_ARGS[@]}"} || true
  fi

  # ── step 4e: the SPA's take (through the batcher) and make ────────────────
  if (( ! FAILED && DO_SPA_ROUNDTRIP )) && [[ "$PROFILE_MODE" == "all" ]]; then
    step 4e "spa round trip: take through the batcher, then make" \
      "$REPO_ROOT/scripts/verify-spa-roundtrip.sh" || true
  elif (( ! DO_SPA_ROUNDTRIP )); then
    skip_step 4e "spa round trip" "--no-spa-roundtrip"
  elif [[ "$PROFILE_MODE" != "all" ]]; then
    skip_step 4e "spa round trip" "needs offerfiles + faucet + poster + frontend (--all)"
  fi

  # ── step 4f: the EVM-signed execute path ──────────────────────────────────
  # register x2 -> mint -> deposit -> transfer -> withdraw, four `execute` proofs against the
  # MinoCrab artifact. It builds the :e2e image variant on first run (the unpruned Manager
  # prover key), which is why it is last: everything cheaper has already reported by then.
  if (( ! FAILED && DO_AA_E2E )) && [[ "$PROFILE_MODE" == "all" ]]; then
    step 4f "aa-e2e.sh (register x2 -> mint -> deposit -> transfer -> withdraw)" \
      "$REPO_ROOT/scripts/aa-e2e.sh" || true
  elif (( ! DO_AA_E2E )); then
    skip_step 4f "aa-e2e.sh" "--no-aa-e2e"
  elif [[ "$PROFILE_MODE" != "all" ]]; then
    skip_step 4f "aa-e2e.sh" "needs the aa profile (--all)"
  fi
fi

# The EXIT trap performs step 5 and decides the exit code.
exit 0
