#!/usr/bin/env bash
# shielded-night-verify — the two assertions that need a bun runtime, run INSIDE the compose
# network from the same image the contract was deployed from.
#
#   entrypoint-verify.sh keys        the deployed contract's on-chain verifier keys are
#                                    byte-identical to the ones this image serves
#   entrypoint-verify.sh roundtrip   NIGHT -> sNight -> NIGHT, atomic and two-step, with exact
#                                    balance assertions, driven by a funded wallet
#
# It is invoked by scripts/verify-shielded-night.sh through `docker compose run --rm`; the
# service carries a compose `profiles:` key that `up.sh` never selects, so `up -d` never starts
# it (the same idiom compose/core.yml's toolkit `fund` service uses). With no argument this
# prints what it is and exits 0, so an accidental start is harmless rather than confusing.
#
# WHY THIS RUNS IN A CONTAINER AND NOT ON THE HOST: the checks need bun, the pinned tree, its
# node_modules and the compiled keys. Requiring those on an operator's laptop would make the
# strongest section of verify.sh the one most likely to be skipped.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=shielded-night-verify
# shellcheck source=images/shielded-night/entrypoint-common.sh
. /usr/local/lib/shielded-night/entrypoint-common.sh

MODE="${1:-}"

usage() {
  cat >&2 <<'EOF'
[shielded-night-verify] this service performs no work on its own.

    docker compose run --rm shielded-night-verify keys        on-chain verifier keys
    docker compose run --rm shielded-night-verify roundtrip   NIGHT <-> sNight round trips

./scripts/verify-shielded-night.sh runs both.
EOF
}

# The environment is required by the two WORKING modes, not by the usage text: an accidental
# start with no argument must print what this is and exit 0, not exit 78 on a variable it was
# never going to use.
prepare() {
  require_env MN_INDEXER_URL MN_INDEXER_WS_URL MN_NODE_URL MN_PROOF_SERVER_URL
  MN_ENV="${MN_ENV:-undeployed}"
  export MN_ENV
  cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"
}

# ── keys ─────────────────────────────────────────────────────────────────────
#
# Runs UPSTREAM's own scripts/verify-deployment.ts against OUR indexer. Two things make the
# output worth parsing rather than the exit status worth trusting:
#
#   * that script exits 0 only when the contract is ALSO permanently locked, and this stack
#     deliberately does not lock a throwaway devnet contract (spec FR-016). Reading its exit
#     status alone would report every correct local deployment as a failure;
#   * "it printed some ticks" is not the claim. The claim is that ALL ELEVEN circuits this
#     image serves keys for are on chain with byte-identical verifier keys, none missing and
#     none extra — so the circuit list is taken from the image's own keys directory and each
#     one is required by name.
verify_keys() {
  local address out rc=0 circuits n c committee threshold locked_expected
  address="$(published_address)" || die "no published contract address on ${CONTRACT_FILE}"
  log "contract ${address}"
  log "indexer  ${MN_INDEXER_URL}"

  out="$(mktemp)"
  # `|| rc=$?` and not `set +e`: the script's non-zero exit is EXPECTED on an unlocked
  # contract, and swallowing errexit wholesale would also hide a crash in the parsing below.
  CV_ADDRESS="${address}" bun run scripts/verify-deployment.ts >"${out}" 2>&1 || rc=$?
  sed 's/^/    /' "${out}" >&2

  # The circuits THIS IMAGE SERVES, which is what the browser will prove against. Derived, not
  # typed: a contract that gained a circuit must fail here rather than be silently half-checked.
  # A glob, not `ls`: the names come from a compiler and are plain identifiers, but a glob is
  # both correct for any name and one fewer external process.
  circuits="$(cd "${REPO_ROOT}/src/managed/keys" && for f in ./*.verifier; do
      b="${f##*/}"; printf '%s\n' "${b%.verifier}"
    done | sort)"
  # `|| true`: grep -c exits 1 when the count is zero, which under errexit would abort here
  # instead of reaching the assertion that is meant to report it.
  n="$(printf '%s\n' "${circuits}" | grep -c . || true)"
  if [ "${n}" -ne 11 ]; then
    die "this image serves ${n} verifier keys, expected 11 — the served artifacts are not this contract"
  fi

  local failures=0
  if grep -q 'circuits missing on chain' "${out}"; then
    log "FAIL: the deployed contract is missing circuits this build has"
    failures=$(( failures + 1 ))
  fi
  if grep -q 'circuits on chain but not in this build' "${out}"; then
    log "FAIL: the deployed contract has circuits this build does not"
    failures=$(( failures + 1 ))
  fi
  while IFS= read -r c; do
    [ -n "${c}" ] || continue
    # grep against a FILE, never `printf … | grep -q …`: under `pipefail` a grep that closes
    # the pipe early makes the producer die of SIGPIPE and the pipeline report failure.
    if grep -q "^✓ ${c}: on-chain .* == local " "${out}"; then
      continue
    fi
    log "FAIL: ${c} — on-chain verifier key does not match the served one (or is unreadable)"
    failures=$(( failures + 1 ))
  done <<EOF
${circuits}
EOF

  # The maintenance authority, asserted in the direction this stack configured. An UNLOCKED
  # local contract is correct and expected; a LOCKED one when nobody asked for it would mean a
  # one-way door was walked through by accident.
  local authority
  authority="$(grep -m1 '^maintenance authority:' "${out}" || true)"
  [ -n "${authority}" ] || die "verify-deployment.ts printed no maintenance-authority line (exit ${rc}) — it did not reach the chain"
  committee="$(printf '%s' "${authority}" | sed -n 's/.*committee=\([0-9][0-9]*\).*/\1/p')"
  threshold="$(printf '%s' "${authority}" | sed -n 's/.*threshold=\([0-9][0-9]*\).*/\1/p')"
  case "$(printf '%s' "${SHIELDED_NIGHT_LOCK:-false}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) locked_expected=1 ;;
    *)             locked_expected=0 ;;
  esac
  if [ "${locked_expected}" -eq 1 ]; then
    if [ "${committee}" = "0" ] && [ "${threshold:-0}" -ge 1 ]; then
      log "OK: contract is LOCKED as requested (committee=0 threshold=${threshold})"
    else
      log "FAIL: SHIELDED_NIGHT_LOCK was set but the authority is committee=${committee} threshold=${threshold}"
      failures=$(( failures + 1 ))
    fi
  else
    if [ "${committee:-0}" -ge 1 ]; then
      log "OK: contract is unlocked as configured (committee=${committee} threshold=${threshold})"
    else
      log "FAIL: the contract is LOCKED (committee=${committee}) but SHIELDED_NIGHT_LOCK is not set — a one-way door was taken by accident"
      failures=$(( failures + 1 ))
    fi
  fi

  rm -f "${out}"
  [ "${failures}" -eq 0 ] || die "${failures} on-chain key/authority assertion(s) failed"
  log "OK: 11/11 circuits' on-chain verifier keys are byte-identical to the served ones"
}

# ── roundtrip ────────────────────────────────────────────────────────────────
#
# THE UPSTREAM SUITE IS THE GATE, run against THIS stack (MN_EXTERNAL_STACK=1) rather than
# against a throwaway testcontainers devnet — that is the strongest e2e available and it needs
# no transcribed copy of the test logic here.
#
# TWO TESTS, SELECTED BY NAME, and the selection is load-bearing. `-t '[smoke]'` would be the
# obvious filter and it would be wrong: the same file also carries a multi-wallet smoke that
# runs on `describeContractWithWallets(['alice','bob'])`, i.e. genesis seeds 0x…01 and 0x…02 —
# in THIS stack the funding faucet / offer-files kernel wallet and the batcher's wallet.
# Driving those from here would put a second facade on a seed a long-lived service holds open,
# which takes it offline silently.
# Both selected tests assert EXACT balances (wrapped == N, final NIGHT == starting NIGHT).
verify_roundtrip() {
  require_env SHIELDED_NIGHT_DRIVER_SEED
  refuse_genesis_1 "${SHIELDED_NIGHT_DRIVER_SEED}" "shielded-night verify driver"
  if [ "${SHIELDED_NIGHT_DRIVER_SEED}" = "${SHIELDED_NIGHT_WALLET_SEED:-}" ]; then
    die "the driver seed must differ from the deployer's (spec FR-011)"
  fi

  export MN_EXTERNAL_STACK=1
  export MN_SEED="${SHIELDED_NIGHT_DRIVER_SEED}"

  log "driver wallet ${SHIELDED_NIGHT_DRIVER_SEED:0:8}…${SHIELDED_NIGHT_DRIVER_SEED: -6}"
  log "atomic: convertToShielded -> convertToUnshielded (one transaction each)"
  bun run test:integration test/integration/shielded-night.combined.test.ts \
      -t 'convertToShielded then convertToUnshielded, each in ONE transaction' \
    || die "the atomic round trip failed"

  log "two-step: depositUnshielded -> withdrawShielded -> depositShielded -> withdrawUnshielded"
  bun run test:integration test/integration/shielded-night.test.ts \
      -t 'full round trip: unshielded -> shielded -> unshielded' \
    || die "the two-step round trip failed"

  log "OK: both round trips completed with exact balance assertions"
}

case "${MODE}" in
  keys)      prepare; verify_keys ;;
  roundtrip) prepare; verify_roundtrip ;;
  ""|help|-h|--help) usage; exit 0 ;;
  *) usage; die "unknown mode '${MODE}'" ;;
esac

exit 0
