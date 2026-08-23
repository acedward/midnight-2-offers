#!/usr/bin/env bash
#
# Assertions for the umbra-evm profile — the `evm` section of ./verify.sh.
#
#   ./scripts/verify-evm.sh          # all checks
#   ./scripts/verify-evm.sh --quick  # skip the WebSocket check (which waits for a block)
#
# What it proves, and why each one is here rather than being assumed:
#
#   chain identity   eth_chainId / net_version match EVM_CHAIN_ID. Every EVM tool caches the
#                    chain id, so a silent change is a user-visible break, not a detail.
#   head tracking    eth_blockNumber equals the indexer head. eth_blockNumber IS a passthrough to
#                    the indexer, so a gap means the RPC and the indexer disagree about reality.
#   block shape      eth_getBlockByNumber returns an execution-apis-shaped block, so ethers/viem
#                    can decode it. A missing field breaks clients, not this script.
#   balances         eth_getBalance is non-zero for a monitored wallet. This is the one check that
#                    exercises the whole chain: node → indexer → wallet-monitor → Postgres → RPC.
#   WS newHeads      a header actually ARRIVES. Subscribing always succeeds; only delivery proves
#                    a block source is wired (see images/umbra-evm/patches/).
#   error policy     an unimplemented-but-real method is -32004, an unknown name is -32601. A
#                    client uses that difference to decide whether to fall back or to give up.
#   read-only        eth_sendRawTransaction is NOT registered (plan Q2). If it ever answers
#                    anything but -32601, a relayer got wired in and the promise is broken.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/lib/evm.sh
source "$REPO_ROOT/scripts/lib/evm.sh"

QUICK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) QUICK=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown option: $1"; exit 2 ;;
  esac
done

require_docker
load_env
# The evm fragment must be in the compose file list for `dc run` to know these services.
PROFILES="${PROFILES:-} evm"
export PROFILES
evm_defaults

FAILURES=0
fail() { err "$*"; FAILURES=$(( FAILURES + 1 )); }

log "evm: endpoint"
info "json-rpc  ${EVM_RPC_URL}"
info "websocket ws://${HOST_ADDR}:${EVM_WS_HOST_PORT}"

if ! wait_evm_rpc 60; then
  fail "evm-rpc is not answering — nothing else can be checked"
  exit 1
fi

# ── chain identity ───────────────────────────────────────────────────────────
echo
log "evm: chain identity"
EXPECT_CHAIN_HEX="0x$(printf '%x' "$EVM_CHAIN_ID")"
CHAIN_HEX=$(rpc_result eth_chainId || true)
if [[ "$CHAIN_HEX" == "$EXPECT_CHAIN_HEX" ]]; then
  ok "eth_chainId = ${CHAIN_HEX} (${EVM_CHAIN_ID})"
else
  fail "eth_chainId = ${CHAIN_HEX:-<none>}, expected ${EXPECT_CHAIN_HEX}"
fi

NET_VERSION=$(rpc_result net_version || true)
if [[ "$NET_VERSION" == "$EVM_CHAIN_ID" ]]; then
  ok "net_version = ${NET_VERSION}"
else
  fail "net_version = ${NET_VERSION:-<none>}, expected ${EVM_CHAIN_ID}"
fi

CLIENT=$(rpc_result web3_clientVersion || true)
if [[ "$CLIENT" == umbradb-evm-rpc/* ]]; then
  ok "web3_clientVersion = ${CLIENT}"
else
  fail "web3_clientVersion = ${CLIENT:-<none>}, expected umbradb-evm-rpc/<version>"
fi

# ── head tracking ────────────────────────────────────────────────────────────
echo
log "evm: head tracking"
BLOCK_HEX=$(rpc_result eth_blockNumber || true)
IDX_HEIGHT=$(indexer_height "$INDEXER_GQL_URL" || true)
if [[ -z "$BLOCK_HEX" ]]; then
  fail "eth_blockNumber returned nothing"
else
  BLOCK_DEC=$(hex_to_dec "$BLOCK_HEX" || echo "")
  info "eth_blockNumber=${BLOCK_HEX} (${BLOCK_DEC:-?})  indexer height=${IDX_HEIGHT:-?}"
  if [[ -z "${BLOCK_DEC:-}" ]] || (( BLOCK_DEC < 1 )); then
    fail "eth_blockNumber is not past genesis"
  elif [[ -n "${IDX_HEIGHT:-}" ]]; then
    # eth_blockNumber is a passthrough to the indexer's own head, so the only legitimate
    # difference is a block produced between the two queries.
    DIFF=$(( BLOCK_DEC > IDX_HEIGHT ? BLOCK_DEC - IDX_HEIGHT : IDX_HEIGHT - BLOCK_DEC ))
    if (( DIFF <= 3 )); then
      ok "eth_blockNumber tracks the indexer head (delta ${DIFF})"
    else
      fail "eth_blockNumber is ${DIFF} blocks from the indexer head"
    fi
  else
    ok "eth_blockNumber = ${BLOCK_DEC} (indexer height unreadable, delta not checked)"
  fi
fi

# ── block shape ──────────────────────────────────────────────────────────────
echo
log "evm: block shape"
BLOCK_BODY=$(rpc eth_getBlockByNumber '["latest",false]' || true)
MISSING=""
for field in number hash parentHash timestamp transactions logsBloom gasLimit gasUsed miner \
             sha3Uncles transactionsRoot stateRoot receiptsRoot extraData difficulty uncles; do
  [[ "$BLOCK_BODY" == *"\"${field}\""* ]] || MISSING="$MISSING $field"
done
if [[ -z "$MISSING" ]]; then
  ok "eth_getBlockByNumber(latest,false) is execution-apis shaped"
else
  fail "eth_getBlockByNumber is missing:${MISSING}"
fi

# A block fetched by its own height must be the same block — this is what a client does when it
# walks back from the head, and it exercises the indexer's height-offset query rather than the
# latest-block shortcut.
if [[ -n "${BLOCK_DEC:-}" ]]; then
  BY_HEIGHT=$(rpc eth_getBlockByNumber "[\"$(printf '0x%x' "$BLOCK_DEC")\",false]" || true)
  if [[ "$BY_HEIGHT" == *'"number"'* ]]; then
    ok "eth_getBlockByNumber by explicit height answers"
  else
    fail "eth_getBlockByNumber by explicit height returned no block"
  fi
fi

# eth_getLogs reads Postgres and never the indexer — an empty array is the correct answer with an
# empty watch.json, but an ERROR means the evm_rpc schema is missing (i.e. evm-migrate failed).
LOGS_BODY=$(rpc eth_getLogs '[{"fromBlock":"0x0","toBlock":"latest"}]' || true)
if [[ "$LOGS_BODY" == *'"result"'* ]]; then
  ok "eth_getLogs answers from Postgres (evm_rpc schema present)"
else
  fail "eth_getLogs failed — evm_rpc schema likely missing: ${LOGS_BODY:0:200}"
fi

# ── balances ─────────────────────────────────────────────────────────────────
echo
log "evm: monitored wallet balances"
MONITOR_STATE=$(docker ps -a \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=wallet-monitor" \
  --format '{{.State}}' | head -1)
if [[ "$MONITOR_STATE" == "running" ]]; then
  ok "wallet-monitor container is running"
else
  fail "wallet-monitor container state is '${MONITOR_STATE:-absent}', expected running"
fi

# Not `mapfile`: macOS ships bash 3.2, which does not have it. (fund-in-container.sh may use it
# because that one runs inside the toolkit image's bash 5.)
WATCHED=()
while IFS= read -r line; do
  if [[ -n "$line" ]]; then WATCHED+=("$line"); fi
done < <(watched_wallet_inputs)
info "${#WATCHED[@]} wallet(s) configured for monitoring"

NONZERO=0
CHECKED=0
# ONE container invocation for ALL wallets: each `compose run` costs a few seconds, which is the
# only reason tools/evm-address.ts takes a list rather than a single argument.
ADDR_TSV=""
if (( ${#WATCHED[@]} > 0 )); then
  ADDR_TSV=$(evm_addresses "${WATCHED[@]}" || true)
fi
while IFS=$'\t' read -r input mn evm; do
  if [[ -z "${evm:-}" ]]; then continue; fi
  CHECKED=$(( CHECKED + 1 ))
  BAL=$(rpc_result eth_getBalance "[\"${evm}\",\"latest\"]" || true)
  NONCE=$(rpc_result eth_getTransactionCount "[\"${evm}\",\"latest\"]" || true)
  if [[ -z "$BAL" ]]; then
    fail "eth_getBalance(${evm}) returned nothing"
  elif hex_is_zero "$BAL"; then
    dim "0 wei   ${evm}  ${mn:0:24}…  (${input:0:16}…)"
  else
    NONZERO=$(( NONZERO + 1 ))
    ok "${BAL}  ${evm}  ${mn:0:24}…"
  fi
  if [[ -z "$NONCE" ]]; then fail "eth_getTransactionCount(${evm}) returned nothing"; fi
done <<< "$ADDR_TSV"

if (( CHECKED == 0 )); then
  fail "could not map any watched wallet to an EVM address (tools/evm-address.ts failed?)"
elif (( NONZERO > 0 )); then
  ok "${NONZERO}/${CHECKED} monitored wallet(s) report a non-zero eth_getBalance"
else
  fail "every monitored wallet reports 0 — eth_getBalance is populated by wallet-monitor from
        INDEXED unshielded transactions, and a chain that has never moved value has none.
        Run './scripts/fund-wallet.sh --all-demo' (or the 'fund' compose service) and re-check."
fi

# ── WebSocket ────────────────────────────────────────────────────────────────
echo
log "evm: websocket"
# NOT a TCP probe: docker's published-port proxy accepts a connection whether or not anything
# inside the container is listening, so `nc -z` on this port is meaningless. A completed 101
# handshake is the weakest claim that is actually worth making about the host port.
if evm_ws_handshake 30; then :; else
  fail "the websocket host port does not complete a handshake"
fi
if (( QUICK )); then
  warn "skipping the newHeads delivery check (--quick)"
else
  # Runs INSIDE the compose network: the host ports are bound to 127.0.0.1, so a container
  # cannot reach them, and the host has no WebSocket client to rely on.
  if evm_tool tools/ws-newheads.ts "ws://evm-rpc:10021" 60; then
    ok "eth_subscribe(newHeads) delivered a header"
  else
    fail "eth_subscribe(newHeads) delivered no header within 60s"
  fi
fi

# ── error policy ─────────────────────────────────────────────────────────────
echo
log "evm: error policy"
# A real spec method this surface deliberately does not serve.
CODE=$(rpc_error_code eth_getStorageAt '["0x0000000000000000000000000000000000000000","0x0","latest"]' || true)
if [[ "$CODE" == "-32004" ]]; then
  ok "eth_getStorageAt → -32004 (method not supported)"
else
  fail "eth_getStorageAt → ${CODE:-<no error>}, expected -32004"
fi
CODE=$(rpc_error_code eth_newFilter '[{}]' || true)
if [[ "$CODE" == "-32004" ]]; then
  ok "eth_newFilter → -32004 (method not supported)"
else
  fail "eth_newFilter → ${CODE:-<no error>}, expected -32004"
fi
# A name the server has never heard of.
CODE=$(rpc_error_code eth_thisMethodDoesNotExist '[]' || true)
if [[ "$CODE" == "-32601" ]]; then
  ok "unknown method → -32601 (method not found)"
else
  fail "unknown method → ${CODE:-<no error>}, expected -32601"
fi
# READ-ONLY GUARD (plan Q2). Unregistered ⇒ -32601. Anything else means a write path exists.
CODE=$(rpc_error_code eth_sendRawTransaction '["0x00"]' || true)
if [[ "$CODE" == "-32601" ]]; then
  ok "eth_sendRawTransaction → -32601: the surface is read-only, as designed"
else
  fail "eth_sendRawTransaction → ${CODE:-<no error>}: expected -32601. A RELAY_URL is set
        somewhere and this stack is no longer read-only (plan Q2 says it must be)."
fi

echo
if (( FAILURES == 0 )); then
  ok "verify-evm.sh: all checks passed"
  exit 0
fi
err "verify-evm.sh: ${FAILURES} check(s) failed"
exit 1
