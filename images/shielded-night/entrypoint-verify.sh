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
# Runs UPSTREAM's own scripts/verify-deployment.ts against OUR indexer, with --allow-unlocked
# (project 00007 phase F1, effectstream/shielded-night PR #12). That flag exists precisely for
# this stack's situation: a devnet contract is deliberately never locked (spec FR-016), so the
# script's DEFAULT behaviour — exit 0 only if the code matches AND the contract is permanently
# locked — would report every correct local deployment as a failure. `--allow-unlocked` still
# measures and PRINTS the lock state, but folds only the verifier-key/circuit-set check into the
# exit code, so this entrypoint can trust `rc` directly instead of parsing "✓ … == local" /
# "committee=…" lines out of stdout by hand. It never weakens the code check: a verifier-key
# mismatch, a missing circuit or an extra circuit still exits non-zero with the flag set — that
# is the negative control (see scripts/verify-deployment.ts's own `verifyOutcome()`), and
# scripts/verify-shielded-night.sh keeps its own negative control (a bogus circuit -> 404) for
# the served-artifact half of this claim, untouched by this change.
verify_keys() {
  local address rc=0 circuits n
  address="$(published_address)" || die "no published contract address on ${CONTRACT_FILE}"
  log "contract ${address}"
  log "indexer  ${MN_INDEXER_URL}"

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

  # `-- --allow-unlocked`: the `--` is what makes `bun run` forward the flag to the script
  # rather than swallowing it as a `bun run` option of its own. `|| rc=$?` and not `set +e`: a
  # non-zero exit here is a real failure now (unlike the old strict-by-default call), but it
  # must still be CAUGHT rather than let errexit kill this function before the die() below can
  # name it. Output streams straight to the container log — there is nothing left to parse.
  CV_ADDRESS="${address}" bun run scripts/verify-deployment.ts -- --allow-unlocked || rc=$?
  [ "${rc}" -eq 0 ] || die "verify-deployment.ts --allow-unlocked exited ${rc} — see the output above"
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
