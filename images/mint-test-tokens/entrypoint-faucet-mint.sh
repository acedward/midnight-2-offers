#!/usr/bin/env bash
# faucet-mint — put spendable LOCAL test-token coins into this stack's demo wallets.
#
# WHY BRING-UP NEEDS IT (spec US3). The offer poster stopped minting when kernel
# PRs #69/#70 deleted the offer-files contract: it now SELECTS an existing coin of
# exactly OFFER_POSTER_GIVE_AMOUNT base units and never creates one. So `./up.sh
# --with faucet --with offerfiles --with poster` posts nothing at all unless
# something has put coins in the poster's wallet first. This is that something,
# and it runs BEFORE the poster (compose says
# `faucet-mint: service_completed_successfully`) for two reasons at once: the
# coins have to be there, and `runner/faucet-mint.ts` opens a wallet facade on
# POSTER_SEED to read its balance — two facades on one seed against one Midnight
# node force each other's connection down, silently.
#
# IT IS NOT `faucet-mint-test`. That one is `profiles:`-gated evidence, mints
# unconditionally, and proves discovery to a throwaway recipient. This one is
# provisioning: it is in the normal bring-up path, it is IDEMPOTENT BY BALANCE
# (compose re-runs completed one-shots on every `up`), and its recipients are the
# stack's real wallets.
#
# ── THE PLAN ────────────────────────────────────────────────────────────────
# One built-in grant plus an open list.
#
#   THE POSTER GRANT is not optional and not a free choice: its symbol and its
#   per-coin amount are the SAME two variables compose/poster.yml gives the
#   poster (OFFER_POSTER_GIVE_SYMBOL / OFFER_POSTER_GIVE_AMOUNT), so the coin
#   this mints and the coin the poster looks for cannot drift apart. Set
#   FAUCET_MINT_POSTER_COINS to 0 to turn it off.
#
#   FAUCET_MINT_GRANTS is a semicolon-separated list of
#   `label:seedhex:symbol:amount:coins` for anything else — the AA taker, a demo
#   wallet, the SPA's wallets in a later phase. EMPTY BY DEFAULT, and that is a
#   measured decision rather than an omission (recorded as Q10): the AA console
#   MINTS ITS OWN tokens through these same issuers, and upstream states plainly
#   that the solver "needs NO SWAP-TOKEN INVENTORY to quote or settle
#   whole-maker rungs. It needs NIGHT/DUST, and that is all". Every entry here
#   costs a full proof cycle on a cold devnet, so nothing is minted on the
#   chance it might be wanted.
#
# ── SEEDS ───────────────────────────────────────────────────────────────────
# Every seed arrives as an environment variable and is written into the tmpfs at
# /run/faucet with umask 077, exactly as the deploy one-shot does — no image
# layer, no volume, gone when the container exits. The three genesis seeds are
# refused outright: a second facade on one of them takes the offer-files kernel,
# the batcher or the AA deploy wallet offline with no error naming the cause.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=faucet-mint
# shellcheck source=images/mint-test-tokens/entrypoint-common.sh
. /usr/local/lib/mint-test-tokens/entrypoint-common.sh

require_env MN_NODE_URL MN_NODE_WS_URL MN_INDEXER_URL MN_INDEXER_WS_URL MN_PROOF_SERVER_URL \
            FAUCET_DEPLOYER_SEED

MN_NETWORK="${MN_NETWORK:-undeployed}"
[ "${MN_NETWORK}" = "undeployed" ] \
  || die "MN_NETWORK must be 'undeployed' in this stack (got '${MN_NETWORK}')"
export MN_NETWORK

[ -f "${REGISTRY_FILE}" ] \
  || die "no ${REGISTRY_FILE} — faucet-deploy must complete first"

SEED_DIR="${FAUCET_MINT_SEED_DIR:-/run/faucet}"
PLAN_FILE="${SEED_DIR}/mint-plan.json"
mkdir -p "${SEED_DIR}"
# shellcheck disable=SC2329  # invoked by the EXIT trap installed on the next line
cleanup() { rm -rf "${SEED_DIR:?}"/*.hex "${PLAN_FILE}"; }
trap cleanup EXIT

MN_SEED_FILE="$(write_seed_file FAUCET_DEPLOYER_SEED "${SEED_DIR}/deployer-seed.hex")"
export MN_SEED_FILE

# ── build the plan ──────────────────────────────────────────────────────────
# `label:seedhex:symbol:amount:coins` per entry, assembled here rather than in
# the TypeScript so the seed never reaches a JSON file that lives anywhere but
# the tmpfs, and so a malformed entry is reported by name before a wallet is
# opened.
SPEC=""
POSTER_COINS="${FAUCET_MINT_POSTER_COINS:-4}"
if [ "${POSTER_COINS}" != "0" ]; then
  [ -n "${POSTER_SEED:-}" ] || die "FAUCET_MINT_POSTER_COINS=${POSTER_COINS} but POSTER_SEED is not set"
  SPEC="poster:${POSTER_SEED}:${OFFER_POSTER_GIVE_SYMBOL:-twBTC}:${OFFER_POSTER_GIVE_AMOUNT:-100000000}:${POSTER_COINS}"
fi
if [ -n "${FAUCET_MINT_GRANTS:-}" ]; then
  SPEC="${SPEC:+${SPEC};}${FAUCET_MINT_GRANTS}"
fi

if [ -z "${SPEC}" ]; then
  log "no grants configured (FAUCET_MINT_POSTER_COINS=0 and FAUCET_MINT_GRANTS empty) — nothing to do"
  exit 0
fi

: > "${PLAN_FILE}"
chmod 0600 "${PLAN_FILE}"
GRANTS_JSON=""
SAVED_IFS="${IFS}"
IFS=';'
for _entry in ${SPEC}; do
  IFS="${SAVED_IFS}"
  [ -n "${_entry}" ] || continue
  # label:seed:symbol:amount:coins
  _label="${_entry%%:*}"; _rest="${_entry#*:}"
  _seed="${_rest%%:*}";  _rest="${_rest#*:}"
  _symbol="${_rest%%:*}"; _rest="${_rest#*:}"
  _amount="${_rest%%:*}"; _coins="${_rest#*:}"
  case "${_label}" in ''|*[!A-Za-z0-9._-]*) die "grant '${_entry}': label must be [A-Za-z0-9._-]+" ;; esac
  case "${_symbol}" in ''|*[!A-Za-z0-9._-]*) die "grant '${_entry}': symbol must be [A-Za-z0-9._-]+" ;; esac
  case "${_amount}" in ''|*[!0-9]*) die "grant '${_entry}': amount must be a positive integer of BASE UNITS" ;; esac
  case "${_coins}" in ''|*[!0-9]*) die "grant '${_entry}': coins must be a non-negative integer" ;; esac
  [ "${_coins}" != "0" ] || { log "grant '${_label}' asks for 0 coins — skipped"; continue; }
  # write_seed_file validates the hex, refuses the genesis seeds and chmods 0600.
  _seed_var="FAUCET_MINT_SEED_${_label//[^A-Za-z0-9]/_}"
  printf -v "${_seed_var}" '%s' "${_seed}"
  export "${_seed_var?}"
  # `$( )` IS A SUBSHELL, so write_seed_file's `exit 78` on a bad seed would end
  # only that subshell and leave this loop running with an EMPTY path — the seed
  # file would then be missing and the failure would surface inside the wallet
  # SDK, naming nothing. The empty result is checked here instead.
  _seed_file="$(write_seed_file "${_seed_var}" "${SEED_DIR}/${_label}.hex")"
  unset "${_seed_var}"
  [ -n "${_seed_file}" ] && [ -s "${_seed_file}" ] \
    || die "grant '${_label}': its seed was refused (see the line above) — nothing was minted"
  GRANTS_JSON="${GRANTS_JSON}${GRANTS_JSON:+,}{\"label\":\"${_label}\",\"seedFile\":\"${_seed_file}\",\"symbol\":\"${_symbol}\",\"amount\":\"${_amount}\",\"coins\":${_coins}}"
  log "grant ${_label}: ${_coins} x ${_amount} base units of ${_symbol}"
  IFS=';'
done
IFS="${SAVED_IFS}"

if [ -z "${GRANTS_JSON}" ]; then
  log "every grant asked for 0 coins — nothing to do"
  exit 0
fi
printf '{"grants":[%s]}\n' "${GRANTS_JSON}" > "${PLAN_FILE}"
export FAUCET_MINT_PLAN_FILE="${PLAN_FILE}"

wait_for_stack

cd "${REPO_ROOT}/contracts/v2" || die "no ${REPO_ROOT}/contracts/v2"
# Run it the way upstream runs its own v2 runners: node + tsx, resolved out of
# contracts/v2/node_modules, with this directory as the cwd.
node --import tsx ./faucet-mint.ts || die "faucet-mint failed"

log "OK: the demo wallets hold their local test-token inventory"
exit 0
