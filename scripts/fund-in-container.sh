#!/usr/bin/env bash
#
# The body of the `fund` one-shot compose service (compose/core.yml, profile `fund`).
#
# It runs INSIDE the toolkit container, so it calls the toolkit binary directly rather than
# through `docker run`. Functionally it is scripts/fund-wallet.sh --all-demo without the
# docker plumbing; the host script is the one to use interactively.
#
#   docker compose --profile fund -f compose/core.yml run --rm fund
#
# Because the compose service overrides the image's entrypoint to run this script, the two
# things that entrypoint does have to be done here instead:
#   1. create the fetch-cache directory and give it to appuser
#   2. run the toolkit AS appuser (the image never runs it as root)
# Skipping (2) would leave root-owned files in the host-mounted cache directory, which then
# breaks the host-side scripts and `down.sh -v` on Linux.
#
set -euo pipefail

TOOLKIT_NODE_URL="${TOOLKIT_NODE_URL:-ws://node:9944}"
NETWORK_ID="${NETWORK_ID:-undeployed}"
FROM_SEED="${FUND_FROM_SEED:-0000000000000000000000000000000000000000000000000000000000000001}"
AMOUNT="${FUND_AMOUNT:-10000000000000}"
DUST_WAIT="${FUND_DUST_WAIT:-240}"
WALLETS_JSON="${WALLETS_JSON:-/fund/wallets.json}"
# Genesis is a shared wallet: `shielded-night-fund` and `poster-fund` spend it too, and they
# start in parallel on `node: service_healthy`. A transfer built against a stale UTXO view is
# rejected by the runtime as invalid — contention, not a permanent failure. Retry, bounded.
SEND_TRIES="${GENESIS_SEND_TRIES:-6}"
SEND_RETRY_S="${GENESIS_SEND_RETRY_S:-10}"

TOOLKIT_BIN="${TOOLKIT_BIN:-/midnight-node-toolkit}"
# NOTE: the binary lives at / and / is NOT on PATH in this image, so it must be called by
# absolute path. Calling it as plain `midnight-node-toolkit` fails with exit 127.

say() { printf '==> %s\n' "$*"; }
sub() { printf '    %s\n' "$*"; }

# ── mirror the image entrypoint's cache preparation ──────────────────────────
if [[ "${MN_FETCH_CACHE:-}" == redb:* ]]; then
  CACHE_PATH="${MN_FETCH_CACHE#redb:}"
  mkdir -p "$(dirname "$CACHE_PATH")"
fi
mkdir -p /.cache /tmp
chown -R appuser:appuser /.cache /tmp 2>/dev/null || true

# Hand the cache directory back to the invoking host user on the way out, so a bind-mounted
# host directory does not end up owned by the container's appuser.
if [[ -n "${RESTORE_OWNER:-}" ]]; then
  trap 'chown -R "$RESTORE_OWNER" /.cache 2>/dev/null || true' EXIT
fi

# tk <args...> — the toolkit, as appuser, exactly as the image's entrypoint runs it.
tk() { runuser -u appuser "$TOOLKIT_BIN" -- "$@"; }

# ── wait until the chain is transactable ─────────────────────────────────────
# The toolkit refuses to build anything while only the genesis block is finalized:
#   GetTransactions(NodeClientError(OnlyGenesisFinalized))
# `depends_on: service_healthy` only guarantees the node answers RPC, which happens several
# blocks before finality moves. The node's HTTP RPC is the same port as the WS endpoint.
NODE_HTTP="${NODE_HTTP:-$(printf '%s' "$TOOLKIT_NODE_URL" | sed -e 's|^ws://|http://|' -e 's|^wss://|https://|')}"
wait_chain_transactable() {
  # NOTE: keep these on separate lines. `local a="$1" b=$((a))` fails under `set -u`,
  # because bash expands every word of the `local` command before the builtin binds any of
  # them, so `a` is still unset when `$((a))` is expanded.
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
wait_chain_transactable 180 || exit 1

# ── prime the fetch cache ────────────────────────────────────────────────────
# TOOLKIT BUG (2.0.0-rc.4): the first chain command run against an EMPTY fetch-cache
# directory always panics with
#   panicked at fetcher/fetch_storage/redb_backend.rs: failed to create database:
#   Storage(Io(Os { code: 2, kind: NotFound, … }))
# and yet leaves a working toolkit_fetch_cache.db behind, so the next call succeeds.
# Burn that call here with a throwaway query, otherwise it lands on the first wallet's
# funding transaction and that wallet is silently skipped. (Reproduced deterministically;
# pre-creating the directories does not help — the .db file has to exist.)
CACHE_DB="${MN_FETCH_CACHE#redb:}"
if [[ ! -f "$CACHE_DB" ]]; then
  say "priming the toolkit fetch cache (its first call on a cold cache always fails)"
  tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" \
    --seed 0000000000000000000000000000000000000000000000000000000000000001 >/dev/null 2>&1 || true
  [[ -f "$CACHE_DB" ]] && sub "fetch cache initialized" || sub "WARNING: cache not initialized"
fi

[[ -f "$WALLETS_JSON" ]] || { echo "not found: $WALLETS_JSON" >&2; exit 1; }

# funding=mnemonic wallets are funded exactly like funding=fund-script ones: their seed is the
# BIP-39 master seed of a mnemonic, which the toolkit accepts as an ordinary 128-hex seed.
mapfile -t SEEDS < <(jq -r '.wallets[] | select(.funding == "fund-script" or .funding == "mnemonic") | .seed' "$WALLETS_JSON")
(( ${#SEEDS[@]} )) || { say "no wallets with funding=fund-script or funding=mnemonic — nothing to do"; exit 0; }

say "funding ${#SEEDS[@]} wallet(s) with ${AMOUNT} stars each from ${FROM_SEED:0:8}…"

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

for SEED in "${SEEDS[@]}"; do
  echo
  say "seed ${SEED:0:8}…${SEED: -6}"

  AJ=$(tk show-address --network "$NETWORK_ID" --seed "$SEED" 2>/dev/null) || {
    sub "FAILED to derive addresses"; RC=1; continue
  }
  UNSHIELDED=$(printf '%s' "$AJ" | jq -r '.unshielded')
  DUST=$(printf '%s' "$AJ" | jq -r '.dust')
  sub "unshielded ${UNSHIELDED}"

  # 1. NIGHT
  if genesis_tx "NIGHT" single-tx --source-seed "$FROM_SEED" \
       --output "addr=${UNSHIELDED},amount=${AMOUNT}"; then
    sub "NIGHT sent"
  else
    sub "FAILED to send NIGHT after ${SEND_TRIES} attempts"; RC=1; continue
  fi

  # 2. DUST registration — must come after the transfer: it respends the wallet's NIGHT
  #    UTXOs so they begin generating DUST.
  if genesis_tx "DUST registration" \
       register-dust-address --wallet-seed "$SEED" --funding-seed "$FROM_SEED" \
       --destination-dust "$DUST"; then
    sub "DUST address registered"
  else
    sub "FAILED to register DUST after ${SEND_TRIES} attempts"; RC=1; continue
  fi

  # 3. Wait for a spendable DUST UTXO — the balance figure moves before the UTXO exists,
  #    and only the UTXO makes a fee payable.
  DEADLINE=$(( SECONDS + DUST_WAIT ))
  READY=0
  while (( SECONDS < DEADLINE )); do
    N=$(tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$SEED" 2>/dev/null \
        | jq -r '(.dust_utxos // []) | length' 2>/dev/null || echo 0)
    if [[ -n "$N" && "$N" != "null" ]] && (( N >= 1 )); then READY=1; break; fi
    sleep 5
  done
  if (( READY )); then
    sub "spendable DUST present"
  else
    sub "TIMEOUT waiting for spendable DUST"; RC=1
  fi
done

echo
if (( RC == 0 )); then say "all wallets funded"; else say "one or more wallets failed"; fi
exit $RC
