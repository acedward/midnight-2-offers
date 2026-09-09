#!/usr/bin/env bash
# shielded-night-verify — the two assertions that need the pinned runner tree, run INSIDE the
# compose network from the same image the contract was deployed from.
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
# WHY THIS RUNS IN A CONTAINER AND NOT ON THE HOST: the checks need node, the pinned
# `contracts/v2` tree, its node_modules and the compiled keys. Requiring those on an operator's
# laptop would make the strongest section of verify.sh the one most likely to be skipped.
#
# BOTH MODES ARE ON THE 2.x LANE (`MN_ENV=undeployed` against `contracts/v2`), which is what
# effectstream/shielded-night `main` gained in upstream PR #16. On the previous pin the same
# two checks were the ROOT tree's 1.x scripts; the assertions are unchanged, the tree they run
# out of is not.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=shielded-night-verify
# shellcheck source=images/shielded-night/entrypoint-common.sh
. /usr/local/lib/shielded-night/entrypoint-common.sh

MODE="${1:-}"

# The v2 contract's compiled artifacts inside this image — the ones the page serves and the
# ones upstream's verifier compares the chain against.
V2_DIR="${REPO_ROOT}/contracts/v2"

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
#
# MN_NODE_WS_URL joined the list on the 2.x lane: contracts/v2/scripts/profile.ts resolves it
# independently of MN_NODE_URL and defaults it to loopback.
prepare() {
  require_env MN_INDEXER_URL MN_INDEXER_WS_URL MN_NODE_URL MN_NODE_WS_URL MN_PROOF_SERVER_URL
  MN_ENV="${MN_ENV:-undeployed}"
  [ "${MN_ENV}" = "undeployed" ] \
    || die "MN_ENV must be 'undeployed' in this stack (got '${MN_ENV}')"
  export MN_ENV
  # The record commit the v2 scripts stamp into the verification record; this image ships no
  # .git, so upstream's `git rev-parse` fallback would throw before doing any work.
  SHIELDED_NIGHT_COMMIT="$(cat /.shielded-night-commit 2>/dev/null || true)"
  export SHIELDED_NIGHT_COMMIT
  cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"
}

# ── keys ─────────────────────────────────────────────────────────────────────
#
# Runs UPSTREAM's own contracts/v2/scripts/verify-deployment.ts against OUR indexer. It reads
# the on-chain contract state, requires the circuit SET to equal the compiled one exactly (no
# missing circuit, no extra), compares every verifier key byte for byte, and checks the sealed
# wrapper metadata; it then REPORTS the maintenance-authority state without folding it into the
# exit code. That last part is why this lane needs no `--allow-unlocked` flag (the 1.x script
# had one, added in project 00007 phase F1): a devnet contract is deliberately never locked
# here (spec FR-016), and the v2 verifier already treats an unlocked authority as information
# rather than as a failure. A verifier-key mismatch still exits non-zero — that is the negative
# control — and scripts/verify-shielded-night.sh keeps its own (a bogus circuit -> 404) for the
# served-artifact half of the claim.
verify_keys() {
  local address rc=0 circuits n
  address="$(published_address)" || die "no published contract address on ${CONTRACT_FILE}"
  log "contract ${address}"
  log "indexer  ${MN_INDEXER_URL}"

  # The circuits THIS IMAGE SERVES, which is what the browser will prove against. Derived, not
  # typed: a contract that gained a circuit must fail here rather than be silently half-checked.
  # A glob, not `ls`: the names come from a compiler and are plain identifiers, but a glob is
  # both correct for any name and one fewer external process.
  circuits="$(cd "${V2_DIR}/managed/keys" && for f in ./*.verifier; do
      b="${f##*/}"; printf '%s\n' "${b%.verifier}"
    done | sort)"
  # `|| true`: grep -c exits 1 when the count is zero, which under errexit would abort here
  # instead of reaching the assertion that is meant to report it.
  n="$(printf '%s\n' "${circuits}" | grep -c . || true)"
  if [ "${n}" -ne 11 ]; then
    die "this image serves ${n} verifier keys, expected 11 — the served artifacts are not this contract"
  fi

  # `|| rc=$?` and not `set +e`: a non-zero exit here is a real failure, but it must still be
  # CAUGHT rather than let errexit kill this function before the die() below can name it.
  # Output streams straight to the container log — there is nothing left to parse.
  CV_ADDRESS="${address}" npm --prefix contracts/v2 run verify:deployment || rc=$?
  [ "${rc}" -eq 0 ] || die "contracts/v2 verify:deployment exited ${rc} — see the output above"
  log "OK: 11/11 circuits' on-chain verifier keys are byte-identical to the served ones"
}

# ── roundtrip ────────────────────────────────────────────────────────────────
#
# THE UPSTREAM SUITE IS THE GATE, run against THIS stack (MN_EXTERNAL_STACK=1) rather than
# against a throwaway devnet — that is the strongest e2e available and it needs no transcribed
# copy of the test logic here. On the 2.x lane the suite is `contracts/v2/test/external/`,
# added by upstream PR #16; its global setup REFUSES to run without MN_EXTERNAL_STACK and never
# starts or stops a stack of its own.
#
# THE WHOLE FILE RUNS, not a name filter, and that is a simplification the 2.x lane earns. The
# 1.x suite needed `-t '<name>'` because the same files carried a multi-wallet smoke driven by
# genesis seeds 0x…01 and 0x…02 — in THIS stack the funding faucet / kernel wallet and the
# batcher's — and a second facade on either takes it offline silently. The v2 external suite has
# no such case: every one of its four tests uses the ONE driver wallet it is given.
#
# CV_ADDRESS IS THE LOAD-BEARING PART. Without it the suite deploys a contract of its own and
# round-trips against that, which would prove a contract nobody on this stack serves. With it,
# the suite JOINS the address this stack deployed, so what is exercised is what the page shows.
verify_roundtrip() {
  local address
  require_env SHIELDED_NIGHT_DRIVER_SEED
  refuse_genesis_1 "${SHIELDED_NIGHT_DRIVER_SEED}" "shielded-night verify driver"
  if [ "${SHIELDED_NIGHT_DRIVER_SEED}" = "${SHIELDED_NIGHT_WALLET_SEED:-}" ]; then
    die "the driver seed must differ from the deployer's (spec FR-011)"
  fi
  address="$(published_address)" || die "no published contract address on ${CONTRACT_FILE}"

  export MN_EXTERNAL_STACK=1
  export MN_SEED="${SHIELDED_NIGHT_DRIVER_SEED}"
  export CV_ADDRESS="${address}"

  log "driver wallet ${SHIELDED_NIGHT_DRIVER_SEED:0:8}…${SHIELDED_NIGHT_DRIVER_SEED: -6}"
  log "joining THIS stack's contract ${address} (CV_ADDRESS) rather than deploying another"
  log "four cases: served circuit set + metadata, two-step round trip, atomic round trip,"
  log "wrong-secret refusal — all with exact balance assertions"
  npm --prefix contracts/v2 run test:external \
    || die "the 2.x external-stack round-trip suite failed"

  log "OK: both round trips completed with exact balance assertions"
}

case "${MODE}" in
  keys)      prepare; verify_keys ;;
  roundtrip) prepare; verify_roundtrip ;;
  ""|help|-h|--help) usage; exit 0 ;;
  *) usage; die "unknown mode '${MODE}'" ;;
esac

exit 0
