#!/usr/bin/env bash
#
# The body of the `shielded-night-fund` one-shot compose service
# (compose/shielded-night.yml). It gives the shielded-night profile's two dedicated wallets —
# the DEPLOYER and the verify DRIVER — unshielded NIGHT and a registered DUST address, so the
# deploy one-shot that runs after it can pay a fee.
#
#   docker compose ... run --rm shielded-night-fund      (or, normally, ./up.sh --with shielded-night)
#
# WHY THIS EXISTS AT ALL, rather than reusing the `fund` service in compose/core.yml: that one
# funds EVERY wallet marked funding=fund-script or funding=mnemonic (six of them, about a
# minute each) and is a manual, profile-gated tool. This profile needs exactly two wallets
# funded, before its own deploy container starts, on any bring-up including
# `./up.sh --with shielded-night` on its own. So it is a dependency of the deploy one-shot
# rather than something an operator has to remember.
#
# WHY IT IS NOT genesis-1/2/3. Those three are already held by other facades in this stack
# (the funding faucet + the offer-files kernel, the batcher, the AA deploy wallet), and two
# wallet facades on one seed force each other's connection down with nothing naming the cause.
# Spec FR-009: the deployer is a dedicated seed. The driver is a second dedicated seed, so the
# round trip is driven by a wallet the deployer is not also using (FR-011).
#
# IT IS IDEMPOTENT, and that is a requirement rather than a nicety: `up.sh` is run repeatedly
# against a live stack, and SC-002 asserts three consecutive runs. A wallet that already holds
# NIGHT and a spendable DUST UTXO is SKIPPED — funding it again would work, but it would add a
# minute of proving to every bring-up and move value around for no reason.
#
# It runs INSIDE the toolkit container, so it calls the toolkit binary directly rather than
# through `docker run`. Because the compose service overrides the image's entrypoint, the two
# things that entrypoint does have to be done here instead (create the fetch-cache directory,
# and run the toolkit AS appuser) — same as scripts/fund-in-container.sh, which this file
# follows deliberately closely.
#
set -euo pipefail

TOOLKIT_NODE_URL="${TOOLKIT_NODE_URL:-ws://node:9944}"
NETWORK_ID="${NETWORK_ID:-undeployed}"
FROM_SEED="${FUND_FROM_SEED:-0000000000000000000000000000000000000000000000000000000000000001}"
AMOUNT="${FUND_AMOUNT:-10000000000000}"
DUST_WAIT="${FUND_DUST_WAIT:-240}"
# Genesis is a SHARED wallet and the one-shots that spend it run in PARALLEL (each gates on
# `node: service_healthy` and nothing else). Since the `poster` profile landed there are two
# of them, so a transfer built against a stale UTXO view is rejected by the runtime
# ("Invalid transaction with custom error: 195/196", "Extrinsic marked as invalid"). That is
# contention, not a permanent failure — retry, bounded.
SEND_TRIES="${GENESIS_SEND_TRIES:-6}"
SEND_RETRY_S="${GENESIS_SEND_RETRY_S:-10}"

TOOLKIT_BIN="${TOOLKIT_BIN:-/midnight-node-toolkit}"
# NOTE: the binary lives at / and / is NOT on PATH in this image, so it must be called by
# absolute path. Calling it as plain `midnight-node-toolkit` fails with exit 127.

# NIGHT's unshielded token type is 32 zero bytes.
NIGHT_TOKEN=0000000000000000000000000000000000000000000000000000000000000000

say() { printf '==> [shielded-night-fund] %s\n' "$*"; }
sub() { printf '    %s\n' "$*"; }

# ── the two wallets, named ───────────────────────────────────────────────────
#
# Required, not defaulted. A default here would silently fund the wrong wallet while the
# deploy container used another one and failed on an empty balance, which is exactly the class
# of failure this service exists to remove.
: "${SHIELDED_NIGHT_WALLET_SEED:?SHIELDED_NIGHT_WALLET_SEED (the deployer) is required}"
: "${SHIELDED_NIGHT_DRIVER_SEED:?SHIELDED_NIGHT_DRIVER_SEED (the verify driver) is required}"

if [[ "$SHIELDED_NIGHT_WALLET_SEED" == "$SHIELDED_NIGHT_DRIVER_SEED" ]]; then
  echo "FATAL: the driver seed must differ from the deployer's (spec FR-011)" >&2
  exit 78
fi
for s in "$SHIELDED_NIGHT_WALLET_SEED" "$SHIELDED_NIGHT_DRIVER_SEED"; do
  if [[ "$s" == "$FROM_SEED" ]]; then
    echo "FATAL: a shielded-night wallet is set to the funding faucet's own seed" >&2
    exit 78
  fi
done

SEEDS=("$SHIELDED_NIGHT_WALLET_SEED" "$SHIELDED_NIGHT_DRIVER_SEED")
LABELS=("deployer" "verify driver")

# ── mirror the image entrypoint's cache preparation ──────────────────────────
if [[ "${MN_FETCH_CACHE:-}" == redb:* ]]; then
  CACHE_PATH="${MN_FETCH_CACHE#redb:}"
  mkdir -p "$(dirname "$CACHE_PATH")"
fi
mkdir -p /.cache /tmp
chown -R appuser:appuser /.cache /tmp 2>/dev/null || true

if [[ -n "${RESTORE_OWNER:-}" ]]; then
  trap 'chown -R "$RESTORE_OWNER" /.cache 2>/dev/null || true' EXIT
fi

# tk <args...> — the toolkit, as appuser, exactly as the image's entrypoint runs it.
tk() { runuser -u appuser "$TOOLKIT_BIN" -- "$@"; }

# ── wait until the chain is transactable ─────────────────────────────────────
# The toolkit refuses to build anything while only the genesis block is finalized:
#   GetTransactions(NodeClientError(OnlyGenesisFinalized))
# `depends_on: service_healthy` only guarantees the node answers RPC, which happens several
# blocks before finality moves.
NODE_HTTP="${NODE_HTTP:-$(printf '%s' "$TOOLKIT_NODE_URL" | sed -e 's|^ws://|http://|' -e 's|^wss://|https://|')}"
wait_chain_transactable() {
  local secs="${1:-180}"
  local deadline=$(( SECONDS + secs ))
  local hash height
  say "waiting for finality to move off genesis (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    hash=$(curl -sf --max-time 5 -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"chain_getFinalizedHead","params":[],"id":1}' \
      "$NODE_HTTP" 2>/dev/null | jq -r '.result // empty')
    if [[ -n "$hash" ]]; then
      height=$(curl -sf --max-time 5 -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"chain_getHeader\",\"params\":[\"$hash\"],\"id\":1}" \
        "$NODE_HTTP" 2>/dev/null | jq -r '.result.number // empty')
      if [[ -n "$height" ]] && (( height >= 1 )); then
        sub "finalized height $((height)) — chain is transactable"
        return 0
      fi
    fi
    sleep 3
  done
  sub "TIMEOUT waiting for finality to move off genesis"
  return 1
}
wait_chain_transactable "${FUND_FINALITY_WAIT:-180}" || exit 1

# ── prime the fetch cache ────────────────────────────────────────────────────
# TOOLKIT BUG (2.0.0-rc.4): the first chain command run against an EMPTY fetch-cache directory
# always panics with `failed to create database: Storage(Io(… NotFound …))` and yet leaves a
# working toolkit_fetch_cache.db behind, so the next call succeeds. Burn that call here with a
# throwaway query, otherwise it lands on the first wallet's balance probe and that wallet is
# reported empty when it is not. Same reasoning (and the same fix) as
# scripts/fund-in-container.sh.
CACHE_DB="${MN_FETCH_CACHE#redb:}"
if [[ -n "$CACHE_DB" && ! -f "$CACHE_DB" ]]; then
  say "priming the toolkit fetch cache (its first call on a cold cache always fails)"
  tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$FROM_SEED" >/dev/null 2>&1 || true
  if [[ -f "$CACHE_DB" ]]; then
    sub "fetch cache initialized"
  else
    sub "WARNING: cache not initialized"
  fi
fi

# already_funded <seed> — true when the wallet holds NIGHT AND has a spendable DUST UTXO.
#
# BOTH halves are required. NIGHT alone is not enough on the ledger-9 line: DUST is the fee
# token, it only accrues for NIGHT UTXOs whose owner registered a DUST address, and a wallet
# with NIGHT and no DUST UTXO cannot send anything at all — which would surface in the deploy
# container as a balancing failure that names none of this.
already_funded() {
  local seed="$1" wj night dust
  wj=$(tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$seed" 2>/dev/null) || return 1
  [[ -n "$wj" ]] || return 1
  night=$(printf '%s' "$wj" | jq -r "[(.utxos // [])[] | select(.token_type == \"${NIGHT_TOKEN}\")] | length" 2>/dev/null || echo 0)
  dust=$(printf '%s' "$wj" | jq -r '(.dust_utxos // []) | length' 2>/dev/null || echo 0)
  [[ "$night" =~ ^[0-9]+$ && "$dust" =~ ^[0-9]+$ ]] || return 1
  (( night >= 1 && dust >= 1 ))
}

RC=0
# genesis_tx <label> <tk args...> — one genesis-funded submission, retried while contended.
genesis_tx() {
  local label="$1"; shift
  local try
  for (( try = 1; try <= SEND_TRIES; try++ )); do
    if tk -q generate-txs --src-url "$TOOLKIT_NODE_URL" --dest-url "$TOOLKIT_NODE_URL" \
         "$@" >/dev/null; then
      return 0
    fi
    if (( try < SEND_TRIES )); then
      sub "${label}: rejected (attempt ${try}/${SEND_TRIES}) — genesis contended, retrying in ${SEND_RETRY_S}s"
      sleep "$SEND_RETRY_S"
    fi
  done
  return 1
}

for i in "${!SEEDS[@]}"; do
  SEED="${SEEDS[$i]}"
  LABEL="${LABELS[$i]}"
  echo
  say "${LABEL}: seed ${SEED:0:8}…${SEED: -6}"

  if already_funded "$SEED"; then
    sub "already holds NIGHT and a spendable DUST UTXO — nothing to do"
    continue
  fi

  AJ=$(tk show-address --network "$NETWORK_ID" --seed "$SEED" 2>/dev/null) || {
    sub "FAILED to derive addresses"; RC=1; continue
  }
  UNSHIELDED=$(printf '%s' "$AJ" | jq -r '.unshielded')
  DUST=$(printf '%s' "$AJ" | jq -r '.dust')
  sub "unshielded ${UNSHIELDED}"

  # 1. NIGHT
  if genesis_tx "NIGHT" single-tx --source-seed "$FROM_SEED" \
       --output "addr=${UNSHIELDED},amount=${AMOUNT}"; then
    sub "NIGHT sent (${AMOUNT} stars)"
  else
    sub "FAILED to send NIGHT after ${SEND_TRIES} attempts"; RC=1; continue
  fi

  # 2. DUST registration — AFTER the transfer, because it respends the wallet's NIGHT UTXOs so
  #    they begin generating DUST.
  if genesis_tx "DUST registration" \
       register-dust-address --wallet-seed "$SEED" --funding-seed "$FROM_SEED" \
       --destination-dust "$DUST"; then
    sub "DUST address registered"
  else
    sub "FAILED to register DUST after ${SEND_TRIES} attempts"; RC=1; continue
  fi

  # 3. Wait for a spendable DUST UTXO. The balance figure moves before the UTXO exists, and
  #    only the UTXO makes a fee payable.
  DEADLINE=$(( SECONDS + DUST_WAIT ))
  READY=0
  while (( SECONDS < DEADLINE )); do
    N=$(tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$SEED" 2>/dev/null \
        | jq -r '(.dust_utxos // []) | length' 2>/dev/null || echo 0)
    if [[ -n "$N" && "$N" != "null" ]] && (( N >= 1 )); then READY=1; break; fi
    sleep 5
  done
  if (( READY )); then
    sub "spendable DUST present — this wallet can pay a fee"
  else
    sub "TIMEOUT waiting for spendable DUST"; RC=1
  fi
done

echo
if (( RC == 0 )); then
  say "both shielded-night wallets are funded and fee-capable"
else
  say "one or more shielded-night wallets could not be funded"
fi
exit $RC
