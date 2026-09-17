#!/usr/bin/env bash
#
# aa-e2e.sh — end-to-end test of the EVM-signed PASSPORT ACCOUNT path:
#
#   an Ethereum key → register (DEPLOY an account contract) → fund → offer
#                   → a taker with no maker key settles → the account spends what it got
#
#   ./scripts/aa-e2e.sh
#
# Needs the stack up WITH the aa profile (./up.sh --with aa) — the run uses the vault and
# the test faucet `aa-deploy` already put on this chain.
#
# ── ⚠ WHAT CHANGED IN PROJECT 00034 ─────────────────────────────────────────
# This used to be: register ×2 → mint → deposit → INTERNAL TRANSFER → withdraw, four proofs
# of the AA-v3 Manager's one `execute` gateway. Two of those steps have no counterpart any
# more. There is no shared Manager to register INTO — `register` deploys a contract of the
# user's own (Q40) — and there are no internal transfers, because both accounts used to be
# rows in one contract's balance map and are now separate contracts (Q41). What replaced
# them is the thing this stack exists for: an OFFER that a stranger settles, and a spend of
# what came back.
#
# ── AND WHAT IT NO LONGER BUILDS ────────────────────────────────────────────
# It used to build a `:e2e` image variant on first run, because calling `execute` proved it
# locally and the normal image pruned that key. The prover keys an image keeps are NAMED now
# (`AA_PROVER_KEYS`), and the named set is exactly what the deploy, the console and this
# driver prove — so there is ONE aa-contracts image and nothing to rebuild here.
#
# ── THE TOKENS COME FROM THE FORK'S OWN TEST FAUCET ─────────────────────────
# `aa-deploy` deploys `contracts/faucet.compact` from the Passport fork and records the two
# shielded colours it can mint (`shielded-a`, `shielded-b`) plus one unshielded. The offer
# needs TWO distinct colours — same-colour legs net out and the kernel refuses the offer as
# NOT_A_SWAP — and taking them from the fork's own faucet is what keeps this driver
# independent of the `faucet` profile, its registry and its six issuers, exactly as the
# retired AA-v3 Minter's TOKA colours did.
#
# ── THE SETTLEMENT ──────────────────────────────────────────────────────────
# If the offerfiles kernel is reachable the offer is PUBLISHED and the driver waits for the
# solver to settle it (that is the `--all` path, and the one the demo is about). If nothing
# takes it within AA_E2E_SOLVER_WAIT seconds, or the kernel is not up at all, the driver's
# own taker wallet settles it — the same act by a different party, and what makes
# `./up.sh --with aa` alone a complete test. The report records which happened.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

# --env-file only when the file exists — compose hard-fails on a missing file, and the
# clean-clone path legitimately has none (defaults cover every value).
COMPOSE=(docker compose)
[[ -f "${ENV_FILE:-}" ]] && COMPOSE+=(--env-file "$ENV_FILE")
COMPOSE+=(-f "$REPO_ROOT/compose/core.yml" -f "$REPO_ROOT/compose/aa.yml")

# The deployed-contracts artifact must exist (aa profile brought up on THIS chain).
if ! "${COMPOSE[@]}" run --rm --no-deps --entrypoint test aa-deploy -f /aa/out/aa-contracts.json 2>/dev/null; then
  err "no aa-contracts.json — bring the stack up with: ./up.sh --with aa"
  exit 2
fi

# A SHIELDED-FREE fee-paying wallet (see aa-e2e.ts's header): fresh dev seed, faucet-funded
# with unshielded NIGHT + DUST only. Idempotent — re-funding just tops up.
E2E_SEED="${AA_E2E_SEED:-e2ee2e0000000000000000000000000000000000000000000000000000e2ee2e}"
log "funding the e2e wallet (unshielded NIGHT + DUST, no shielded)…"
"$REPO_ROOT/scripts/fund-wallet.sh" "$E2E_SEED"

# The TAKER settles the offer, so it needs DUST of its own. It funds the WANT leg from a
# coin the driver mints to it through the test faucet, not from this funding run.
TAKER_SEED="${AA_TAKER_SEED:-7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e}"
log "funding the taker wallet (it submits the settlement and pays its DUST)…"
"$REPO_ROOT/scripts/fund-wallet.sh" "$TAKER_SEED"

log "running the E2E (register → fund → offer → settle → spend; the offer circuit is k=18, expect minutes)…"
"${COMPOSE[@]}" run --rm \
  -e AA_E2E_SEED="$E2E_SEED" \
  -e AA_TAKER_SEED="$TAKER_SEED" \
  -e AA_E2E_SOLVER_WAIT="${AA_E2E_SOLVER_WAIT:-120}" \
  --entrypoint bun aa-deploy /aa/runner/aa-e2e.ts
