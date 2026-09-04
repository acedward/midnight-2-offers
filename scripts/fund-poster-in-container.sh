#!/usr/bin/env bash
#
# The body of the `poster-fund` one-shot (compose/poster.yml, profile `poster`).
#
# It gives the OFFER POSTER's dedicated wallet unshielded NIGHT — and nothing
# else. It runs INSIDE the toolkit container, exactly like
# scripts/fund-in-container.sh, so it calls the toolkit binary directly and has
# to redo the two things the image's own entrypoint would have done (create the
# fetch-cache directory, and run the toolkit AS appuser so no root-owned files
# land in the host-mounted cache).
#
# ── why NIGHT only, and no DUST registration here ────────────────────────────
# The poster registers its OWN dust address at startup and then waits for a
# spendable DUST UTXO — that is part of its documented boot sequence, and its
# /health reports `degraded: insufficient_dust` until it lands. Registering the
# same address from here as well would be a second writer for a value the poster
# already owns, and would make "the poster could not register" indistinguishable
# from "the toolkit did it for it". So this one-shot does the one thing the
# poster cannot do for itself — receive NIGHT from genesis — and stops there.
#
# ── why several LARGE UTXOs rather than one ──────────────────────────────────
# DUST is generated per NIGHT UTXO, so a wallet holding one UTXO generates on one
# clock. The poster proves a mint AND an offer every interval, both paid from its
# own dust; four generating UTXOs is what keeps it from stalling between ticks on
# a cold chain. (Upstream's provision-solver-fees.ts funds its solver the same
# way and for the same reason.)
#
# ── idempotent ───────────────────────────────────────────────────────────────
# Compose re-runs completed one-shots on every `up` (measured, T4.7). A second
# run that funded again would keep adding NIGHT forever, so the wallet's current
# unshielded total is READ first and the transfer is skipped when it already
# meets the target. The check is a chain read, not a marker file: a marker would
# survive a `./down.sh -v` reset of the chain it describes.
set -euo pipefail

TOOLKIT_NODE_URL="${TOOLKIT_NODE_URL:-ws://node:9944}"
NETWORK_ID="${NETWORK_ID:-undeployed}"
FROM_SEED="${FUND_FROM_SEED:-0000000000000000000000000000000000000000000000000000000000000001}"
POSTER_SEED="${POSTER_SEED:-}"
# 5 NIGHT-equivalents per UTXO in stars (1 NIGHT = 10^6 stars), four of them.
UTXO_AMOUNT="${POSTER_FUND_UTXO_AMOUNT:-5000000000000}"
UTXO_COUNT="${POSTER_FUND_UTXO_COUNT:-4}"
# Genesis is a SHARED wallet. `poster-fund`, `shielded-night-fund` and (later)
# `fund-wallet.sh --all-demo` all spend from it, and compose starts the one-shots in
# PARALLEL — every one of them gates on `node: service_healthy` and nothing else, so they
# submit within milliseconds of each other. Two spends of one wallet built against the same
# UTXO view collide in the runtime ("Invalid transaction with custom error: 195/196",
# "Extrinsic marked as invalid"). That is a CONTENTION outcome, not a permanent one: the
# loser's view is merely stale, and the same transfer succeeds once the winner's tx lands.
# So retry, bounded — the same reasoning `run_preflight` uses for the proof-server race.
SEND_TRIES="${GENESIS_SEND_TRIES:-6}"
SEND_RETRY_S="${GENESIS_SEND_RETRY_S:-10}"

TOOLKIT_BIN="${TOOLKIT_BIN:-/midnight-node-toolkit}"
NIGHT_TOKEN=0000000000000000000000000000000000000000000000000000000000000000

say() { printf '==> [poster-fund] %s\n' "$*"; }
sub() { printf '    %s\n' "$*"; }

if [[ -z "$POSTER_SEED" ]]; then
  say "POSTER_SEED is empty — nothing to fund"
  say "set POSTER_SEED in .env (a DEDICATED 64-hex seed); the poster itself refuses to start without one"
  exit 78   # EX_CONFIG, the same code the poster uses
fi

# A seed this one-shot must never fund: doing so would mean the poster shares a
# wallet with a service that holds one open, which the SDK forbids and which the
# poster itself refuses (exit 78). Checked here too so the failure arrives before
# any chain work, and names the variable.
for forbidden in \
  "${KERNEL_WALLET_SEED:-0000000000000000000000000000000000000000000000000000000000000001}" \
  "${BATCHER_WALLET_SEED:-0000000000000000000000000000000000000000000000000000000000000002}" \
  "${SOLVER_SEED:-0000000000000000000000000000000000000000000000000000000000000021}" \
  "${AA_TAKER_SEED:-7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e}"
do
  if [[ "$POSTER_SEED" == "$forbidden" ]]; then
    say "REFUSING: POSTER_SEED equals another service's wallet seed (${forbidden:0:8}…)"
    say "Two wallet facades on one seed against one node force each other's connection down."
    exit 78
  fi
done

# ── mirror the image entrypoint's cache preparation ──────────────────────────
if [[ "${MN_FETCH_CACHE:-}" == redb:* ]]; then
  mkdir -p "$(dirname "${MN_FETCH_CACHE#redb:}")"
fi
mkdir -p /.cache /tmp
chown -R appuser:appuser /.cache /tmp 2>/dev/null || true

tk() { runuser -u appuser "$TOOLKIT_BIN" -- "$@"; }

# ── wait until the chain is transactable ─────────────────────────────────────
# `depends_on: service_healthy` only guarantees the node answers RPC, which happens
# several blocks before finality moves; the toolkit refuses to build anything while
# only genesis is finalized (`OnlyGenesisFinalized`).
NODE_HTTP="${NODE_HTTP:-$(printf '%s' "$TOOLKIT_NODE_URL" | sed -e 's|^ws://|http://|' -e 's|^wss://|https://|')}"
deadline=$(( SECONDS + ${CHAIN_READY_TIMEOUT:-240} ))
say "waiting for finality to move off genesis"
ready=0
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
      ready=1
      break
    fi
  fi
  sleep 3
done
(( ready )) || { sub "TIMEOUT waiting for finality to move off genesis"; exit 1; }

# ── prime the fetch cache ────────────────────────────────────────────────────
# TOOLKIT BUG (2.0.0-rc.4): the first chain command against an EMPTY fetch-cache
# directory always panics and yet leaves a working db behind, so the next call
# succeeds. Burn that call here rather than on the funding transaction.
CACHE_DB="${MN_FETCH_CACHE#redb:}"
if [[ -n "$CACHE_DB" && ! -f "$CACHE_DB" ]]; then
  say "priming the toolkit fetch cache (its first call on a cold cache always fails)"
  tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$FROM_SEED" >/dev/null 2>&1 || true
fi

AJ=$(tk show-address --network "$NETWORK_ID" --seed "$POSTER_SEED") \
  || { sub "FAILED to derive the poster's addresses"; exit 1; }
UNSHIELDED=$(printf '%s' "$AJ" | jq -r '.unshielded')
say "poster wallet ${POSTER_SEED:0:8}…${POSTER_SEED: -6}  unshielded ${UNSHIELDED}"

TARGET=$(( UTXO_AMOUNT * UTXO_COUNT ))
HAVE=$(tk -q show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$POSTER_SEED" 2>/dev/null \
        | jq -r "[(.utxos // [])[] | select(.token_type == \"${NIGHT_TOKEN}\") | .value] | add // 0" \
        2>/dev/null || echo 0)
[[ "$HAVE" =~ ^[0-9]+$ ]] || HAVE=0
sub "holds ${HAVE} stars, target ${TARGET}"

if (( HAVE >= TARGET )); then
  say "already funded — nothing to do (this one-shot re-runs on every \`up\`)"
  exit 0
fi

# send_utxo <label> — one genesis→poster transfer, retried while genesis is contended.
send_utxo() {
  local label="$1" try
  for (( try = 1; try <= SEND_TRIES; try++ )); do
    if tk -q generate-txs --src-url "$TOOLKIT_NODE_URL" --dest-url "$TOOLKIT_NODE_URL" \
         single-tx --source-seed "$FROM_SEED" \
         --output "addr=${UNSHIELDED},amount=${UTXO_AMOUNT}" >/dev/null; then
      return 0
    fi
    if (( try < SEND_TRIES )); then
      sub "${label}: send rejected (attempt ${try}/${SEND_TRIES}) — genesis contended, retrying in ${SEND_RETRY_S}s"
      sleep "$SEND_RETRY_S"
    fi
  done
  return 1
}

RC=0
for (( i = 1; i <= UTXO_COUNT; i++ )); do
  if send_utxo "UTXO ${i}/${UTXO_COUNT}"; then
    sub "UTXO ${i}/${UTXO_COUNT}: ${UTXO_AMOUNT} stars sent"
  else
    sub "UTXO ${i}/${UTXO_COUNT}: FAILED to send NIGHT after ${SEND_TRIES} attempts"
    RC=1
  fi
done

if (( RC == 0 )); then
  say "poster funded with ${UTXO_COUNT} x ${UTXO_AMOUNT} stars"
  say "DUST registration is the poster's own job — it does it at startup and waits for a spendable UTXO"
else
  say "one or more transfers failed — the poster will report degraded: insufficient_dust"
fi
exit $RC
