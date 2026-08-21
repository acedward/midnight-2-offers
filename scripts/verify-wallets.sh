#!/usr/bin/env bash
#
# Assert that the wallets this stack promises are actually funded and fee-capable.
#
# Modelled on $HOME/midnight-ref-ai/v2.0.0-rc.4/midnight-node/scripts/genesis_wallets_test.sh
# (per-seed show-wallet, fail on an empty UTXO list) and extended with the DUST side, which
# that script does not check: on a ledger-v9 chain an unshielded NIGHT UTXO is worthless
# without a registered, spendable DUST UTXO to pay the fee.
#
# Exit 0 = every wallet marked funding=genesis in wallets/wallets.json holds unshielded
# NIGHT and has spendable DUST.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/toolkit.sh
source "$REPO_ROOT/scripts/lib/toolkit.sh"

WALLETS_JSON="$REPO_ROOT/wallets/wallets.json"
CHECK_FUNDED_TOO=0

usage() {
  cat <<'EOF'
Usage: ./scripts/verify-wallets.sh [options]

Checks every wallet in wallets/wallets.json with funding="genesis":
  * show-wallet   → at least one unshielded NIGHT UTXO, and the total matches
                    expect.unshieldedTotalStars when that field is present
  * show-wallet   → at least one dust UTXO (spendable DUST, i.e. fees are payable)
  * dust-balance  → total > 0
Also runs the toolkit-vs-node version guard.

Options:
  --include-script-funded   also check wallets with funding="fund-script". They are empty
                            until ./scripts/fund-wallet.sh has been run, so this only makes
                            sense after funding them.
  -h, --help                this text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-script-funded) CHECK_FUNDED_TOO=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
done

require_docker
load_env
require_stack

[[ -f "$WALLETS_JSON" ]] || die "not found: $WALLETS_JSON"

# NIGHT's unshielded token type is 32 zero bytes. Shielded NIGHT shares the same colour and
# differs only by its enum tag, so filtering the unshielded UTXO list by this token type is
# what isolates fee-relevant NIGHT.
NIGHT_TOKEN=0000000000000000000000000000000000000000000000000000000000000000

FAILURES=0
CHECKED=0

log "toolkit version guard"
check_toolkit_version || true   # a mismatch is a warning, not a hard failure

SELECTOR='.funding == "genesis"'
(( CHECK_FUNDED_TOO )) && SELECTOR='(.funding == "genesis" or .funding == "fund-script")'

# name<TAB>seed<TAB>expected_total(or "")   — one line per wallet to check
WALLET_LINES=$(jqf "[.wallets[] | select(${SELECTOR})] | .[] | [.name, .seed, ((.expect.unshieldedTotalStars // \"\") | tostring)] | @tsv" < "$WALLETS_JSON")

[[ -n "$WALLET_LINES" ]] || die "no wallets selected from $WALLETS_JSON"

while IFS=$'\t' read -r NAME SEED EXPECTED_TOTAL; do
  [[ -z "$NAME" ]] && continue
  CHECKED=$(( CHECKED + 1 ))
  echo
  log "wallet '${NAME}'  (seed ${SEED:0:8}…${SEED: -6}, ${#SEED} hex chars)"

  WJ=$(wallet_json "$SEED" || true)
  if [[ -z "$WJ" ]]; then
    err "show-wallet returned nothing — is the node reachable?"
    FAILURES=$(( FAILURES + 1 ))
    continue
  fi

  N_UTXOS=$(printf '%s' "$WJ"   | jqf "[(.utxos // [])[] | select(.token_type == \"${NIGHT_TOKEN}\")] | length")
  NIGHT_TOTAL=$(printf '%s' "$WJ" | jqf "[(.utxos // [])[] | select(.token_type == \"${NIGHT_TOKEN}\") | .value] | add // 0")
  N_DUST=$(printf '%s' "$WJ"    | jqf '(.dust_utxos // []) | length')
  DUST_TOTAL=$(dust_json "$SEED" | jqf '.total // 0')

  info "unshielded NIGHT UTXOs : ${N_UTXOS}  (total ${NIGHT_TOTAL} stars)"
  info "dust UTXOs             : ${N_DUST}"
  info "dust balance           : ${DUST_TOTAL} specks"

  WALLET_FAIL=0

  if (( N_UTXOS < 1 )); then
    err "no unshielded NIGHT UTXOs"
    WALLET_FAIL=1
  fi

  if [[ -n "$EXPECTED_TOTAL" && "$EXPECTED_TOTAL" != "null" ]]; then
    if [[ "$NIGHT_TOTAL" == "$EXPECTED_TOTAL" ]]; then
      ok "unshielded total matches expect.unshieldedTotalStars"
    else
      # Not fatal: the wallet may legitimately have spent or received since genesis (the
      # funding source pays out of these UTXOs). Flag it so a surprise is visible.
      warn "unshielded total ${NIGHT_TOTAL} != expected ${EXPECTED_TOTAL} (spent or received since genesis?)"
    fi
  fi

  # The load-bearing assertion. `dust-balance.total > 0` alone is NOT sufficient: right
  # after a registration the balance moves before a spendable UTXO exists, and a wallet
  # with balance but no UTXO cannot pay a fee.
  if (( N_DUST < 1 )); then
    err "no spendable DUST UTXO — this wallet cannot pay a fee"
    WALLET_FAIL=1
  fi

  if [[ "$DUST_TOTAL" == "0" || -z "$DUST_TOTAL" ]]; then
    err "dust balance is 0"
    WALLET_FAIL=1
  fi

  if (( WALLET_FAIL )); then
    FAILURES=$(( FAILURES + 1 ))
  else
    ok "wallet '${NAME}' holds NIGHT and can pay fees"
  fi
done <<< "$WALLET_LINES"

echo
if (( FAILURES == 0 )); then
  ok "all ${CHECKED} wallet(s) verified"
  exit 0
fi
err "${FAILURES} of ${CHECKED} wallet(s) failed"
exit 1
