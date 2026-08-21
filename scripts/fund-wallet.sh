#!/usr/bin/env bash
#
# Fund a wallet on the running demo chain with NIGHT, register it for DUST, and wait until
# it can actually pay a fee.
#
#   ./scripts/fund-wallet.sh <seed|address> [options]
#   ./scripts/fund-wallet.sh --all-demo
#
# Why a wallet needs both: NIGHT is the value, DUST is the fee token, and DUST only exists
# for NIGHT UTXOs whose owner has registered a DUST address. A wallet holding NIGHT with no
# DUST registration cannot send anything at all.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/toolkit.sh
source "$REPO_ROOT/scripts/lib/toolkit.sh"

# 10,000,000 NIGHT. 1 NIGHT = 1,000,000 stars, so 1e13 stars.
#
# This default is deliberately large, and it is NOT about the demo needing that much value.
# DUST accrues in proportion to the NIGHT backing it, so the funded amount sets how quickly
# the wallet becomes able to pay a fee:
#   100 NIGHT     → a transfer still fails with "Insufficient DUST" ~45 minutes later
#   10,000,000    → the wallet can pay a fee as soon as its DUST UTXO appears (seconds)
# Lower it only if you are prepared to wait.
DEFAULT_AMOUNT=10000000000000

AMOUNT="$DEFAULT_AMOUNT"
SHIELDED_AMOUNT=0
FROM_SEED="0000000000000000000000000000000000000000000000000000000000000001"
DO_DUST=1
DUST_WAIT=240
ALL_DEMO=0
TARGETS=()

usage() {
  cat <<EOF
Usage: ./scripts/fund-wallet.sh <target> [options]
       ./scripts/fund-wallet.sh --all-demo [options]

<target> is either
  a SEED     (64 or 128 hex chars) — the full flow: send NIGHT, register the DUST address,
             wait for a spendable DUST UTXO. This is what you want for a wallet you control.
  an ADDRESS (mn_addr_… or mn_shield-addr_…) — sends NIGHT only. DUST cannot be registered
             for an address, because registration is a transaction signed by the wallet's
             own key, so an address-funded wallet cannot pay fees until its owner registers.

Options:
  --amount <stars>            unshielded NIGHT to send. Default ${DEFAULT_AMOUNT}
                              (= 10,000,000 NIGHT; 1 NIGHT = 1,000,000 stars).
  --shielded-amount <stars>   also send this much SHIELDED NIGHT. Default 0.
                              Shielded NIGHT cannot pay fees and cannot be registered for
                              DUST — it is only useful as contract-spendable value.
  --from-seed <seed>          funding wallet. Default is genesis seed 0x…01.
  --no-dust                   skip DUST registration (and the readiness wait).
  --dust-wait <secs>          how long to wait for a spendable DUST UTXO. Default ${DUST_WAIT}.
  --all-demo                  fund every wallet in wallets/wallets.json whose funding field
                              is "fund-script".
  -h, --help                  this text.

Environment:
  ENV_FILE=<path>             target a different stack instance (see .env.example).

Examples:
  ./scripts/fund-wallet.sh de110000000000000000000000000000000000000000000000000000000a11ce
  ./scripts/fund-wallet.sh --all-demo
  ./scripts/fund-wallet.sh mn_addr_undeployed1… --amount 5000000 --no-dust
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --amount)          AMOUNT="${2:?}"; shift 2 ;;
    --shielded-amount) SHIELDED_AMOUNT="${2:?}"; shift 2 ;;
    --from-seed)       FROM_SEED="${2:?}"; shift 2 ;;
    --no-dust)         DO_DUST=0; shift ;;
    --dust-wait)       DUST_WAIT="${2:?}"; shift 2 ;;
    --all-demo)        ALL_DEMO=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    -*)                err "unknown option: $1"; echo; usage; exit 2 ;;
    *)                 TARGETS+=("$1"); shift ;;
  esac
done

require_docker
load_env
# Network discovery + the finality gate + fetch-cache priming, in that order.
require_stack

is_seed()    { [[ "$1" =~ ^[0-9a-fA-F]{64}$ || "$1" =~ ^[0-9a-fA-F]{128}$ ]]; }
is_address() { [[ "$1" == mn_addr_* || "$1" == mn_shield-addr_* ]]; }

if (( ALL_DEMO )); then
  [[ -f "$REPO_ROOT/wallets/wallets.json" ]] || die "wallets/wallets.json not found"
  while IFS= read -r s; do
    [[ -n "$s" ]] && TARGETS+=("$s")
  done < <(jqf '.wallets[] | select(.funding == "fund-script") | .seed' < "$REPO_ROOT/wallets/wallets.json")
  info "wallets.json: ${#TARGETS[@]} wallet(s) marked funding=fund-script"
fi

(( ${#TARGETS[@]} )) || { err "no target given"; echo; usage; exit 2; }

# ── one wallet ───────────────────────────────────────────────────────────────
fund_one() {
  local target="$1"
  local seed="" unshielded_addr="" shielded_addr="" dust_addr=""

  if is_seed "$target"; then
    seed="$target"
    log "funding seed ${seed:0:8}…${seed: -6}"
    local aj
    aj=$(address_json "$seed") || die "show-address failed for the target seed"
    unshielded_addr=$(printf '%s' "$aj" | jqf '.unshielded')
    shielded_addr=$(printf '%s' "$aj" | jqf '.shielded')
    dust_addr=$(printf '%s' "$aj" | jqf '.dust')
    info "unshielded ${unshielded_addr}"
    info "dust       ${dust_addr}"
  elif is_address "$target"; then
    log "funding address ${target}"
    if [[ "$target" == mn_shield-addr_* ]]; then
      shielded_addr="$target"
      # A shielded-only target: the unshielded amount has nowhere to go.
      if [[ "$SHIELDED_AMOUNT" == "0" ]]; then
        SHIELDED_AMOUNT="$AMOUNT"
        AMOUNT=0
        warn "target is a shielded address — sending ${SHIELDED_AMOUNT} as SHIELDED NIGHT"
        warn "shielded NIGHT cannot pay fees and cannot be registered for DUST"
      fi
    else
      unshielded_addr="$target"
    fi
    if (( DO_DUST )); then
      DO_DUST=0
      warn "target is an address, not a seed — skipping DUST registration"
      warn "the owner must run register-dust-address themselves before they can pay fees"
    fi
  else
    die "target is neither a 64/128-hex seed nor an mn_addr_/mn_shield-addr_ address: $target"
  fi

  # ── 1. send NIGHT ──────────────────────────────────────────────────────────
  local outputs=()
  [[ -n "$unshielded_addr" && "$AMOUNT" != "0" ]] && outputs+=(--output "addr=${unshielded_addr},amount=${AMOUNT}")
  [[ -n "$shielded_addr"   && "$SHIELDED_AMOUNT" != "0" ]] && outputs+=(--output "addr=${shielded_addr},amount=${SHIELDED_AMOUNT}")

  if (( ${#outputs[@]} )); then
    log "sending NIGHT from ${FROM_SEED:0:8}…${FROM_SEED: -6}"
    [[ "$AMOUNT" != "0" && -n "$unshielded_addr" ]] && info "unshielded ${AMOUNT} stars"
    [[ "$SHIELDED_AMOUNT" != "0" && -n "$shielded_addr" ]] && info "shielded   ${SHIELDED_AMOUNT} stars"
    # The toolkit fetches and replays the chain to build the tx, so this takes ~20-30s on a
    # young devnet and its progress output belongs on stderr, where the user can see it.
    if tkq generate-txs \
         --src-url "$TOOLKIT_NODE_URL" --dest-url "$TOOLKIT_NODE_URL" \
         single-tx --source-seed "$FROM_SEED" "${outputs[@]}" >/dev/null; then
      ok "NIGHT transfer finalized"
    else
      err "NIGHT transfer failed"
      return 1
    fi
  else
    warn "nothing to send (amount and shielded-amount are both 0)"
  fi

  # ── 2. register the DUST address ───────────────────────────────────────────
  # This also respends the wallet's NIGHT UTXOs so they start generating DUST, which is why
  # it must run AFTER the transfer above, not before.
  if (( DO_DUST )); then
    log "registering DUST address"
    if tkq generate-txs \
         --src-url "$TOOLKIT_NODE_URL" --dest-url "$TOOLKIT_NODE_URL" \
         register-dust-address --wallet-seed "$seed" \
         --funding-seed "$FROM_SEED" --destination-dust "$dust_addr" >/dev/null; then
      ok "DUST address registered"
    else
      err "DUST registration failed"
      return 1
    fi

    # ── 3. wait until fees are actually payable ─────────────────────────────
    wait_spendable_dust "$seed" "$DUST_WAIT" || return 1
  fi

  # ── 4. report ─────────────────────────────────────────────────────────────
  if [[ -n "$seed" ]]; then
    local wj night dust_n dust_total
    wj=$(wallet_json "$seed")
    night=$(printf '%s' "$wj" | jqf '[(.utxos // [])[] | select(.token_type == "0000000000000000000000000000000000000000000000000000000000000000") | .value] | add // 0')
    dust_n=$(printf '%s' "$wj" | jqf '(.dust_utxos // []) | length')
    dust_total=$(dust_json "$seed" | jqf '.total // 0')
    log "result"
    info "unshielded NIGHT  ${night} stars"
    info "dust UTXOs        ${dust_n}"
    info "dust balance      ${dust_total} specks"
  fi
  return 0
}

RC=0
for t in "${TARGETS[@]}"; do
  echo
  fund_one "$t" || RC=1
done

echo
if (( RC == 0 )); then
  ok "funded ${#TARGETS[@]} target(s)"
else
  err "one or more targets failed"
fi
exit $RC
