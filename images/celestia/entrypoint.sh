#!/usr/bin/env bash
#
# Bootstrap and supervise a single-node Celestia devnet: consensus node + bridge node, a funded
# bridge wallet, and an auth token handed to whoever needs to talk to the DA RPC.
#
# ─── WHAT THIS IS A PORT OF ──────────────────────────────────────────────────────────────────
# The offer-files kernel's `bun run dev` gets its Celestia from `@effectstream/orchestrator`'s
# launchCelestia(), which runs four processes against `@effectstream/celestia` (npm, 0.103.1):
#
#   celestia-clean        rm -rf the home dir                     → not ported: see PERSISTENCE
#   celestia-devnet       `celestia start-bridge` = index.js run() → steps 1-6 below
#   celestia-bridge-wait  wait-on tcp:26658                       → replaced, see HEALTH
#   celestia-fund-bridge  fund-bridge.ts                          → step 7 below
#
# Every command, flag and constant below is taken from that package's index.js: CHAIN_ID `test`,
# key `validator` on the `test` keyring backend, 1e15 utia to the validator, a 5e9 utia gentx at
# 500utia fees, the config.toml/genesis.json patches, `--delayed-precommit-timeout 1s`, the
# `CELESTIA_CUSTOM=<chain>:<genesis hash>` handshake between the two nodes, the 6-second pause
# before the bridge starts, and 1e8 utia from the validator to the bridge wallet at 2000utia
# fees. Divergences are marked DIVERGENCE and justified where they occur; there are four.
#
# ─── PERSISTENCE ─────────────────────────────────────────────────────────────────────────────
# The orchestrator wipes Celestia's home on every dev run. Here the state lives on a named
# volume and SURVIVES `./down.sh`, because that is what the rest of this stack does (the node and
# indexer volumes survive too) and because a bridge node that has to re-sync from height 1 on
# every restart is not what the kernel will meet in P4b. `./down.sh -v` wipes it — and it must be
# wiped together with the Midnight volumes, since offer state spans both chains.
#
# ─── HEALTH ──────────────────────────────────────────────────────────────────────────────────
# The orchestrator's readiness gate is `wait-on tcp:26658`. That is exactly the probe P3 proved
# worthless through a published port (docker's port proxy accepts before it dials the container,
# so a TCP probe reported a working WebSocket surface that refused every client). The healthcheck
# here makes an authenticated JSON-RPC call instead — see healthcheck.sh.
#
set -euo pipefail

# ── toolbox mode ─────────────────────────────────────────────────────────────
# `docker run <image> celestia-namespace --base64` must run that command, not silently start a
# devnet and ignore its arguments (which is what an ENTRYPOINT that drops "$@" does, and it
# presents as a hang). So: if the first argument names something runnable, exec it. This is how
# the image is used as a one-shot helper with no stack up at all — `celestia-namespace`,
# `celestia-appd keys`, `celestia version`, a shell.
if (( $# > 0 )) && [[ "$1" != "devnet" ]]; then
  if command -v "$1" >/dev/null 2>&1; then
    exec "$@"
  fi
  printf '[celestia] no such command: %s\n' "$1" >&2
  exit 127
fi

# ── configuration ────────────────────────────────────────────────────────────
# CHAIN_ID doubles as the celestia-node network name (via CELESTIA_CUSTOM), and the kernel's
# CELESTIA_NETWORK env is a separate label it uses only to pick poll intervals.
CHAIN_ID="${CELESTIA_CHAIN_ID:-test}"
KEY_NAME="${CELESTIA_KEY_NAME:-validator}"
KEYRING_BACKEND="${CELESTIA_KEYRING_BACKEND:-test}"

# NOT named CELESTIA_HOME: celestia-appd is a Cosmos SDK binary with env prefix `CELESTIA`, so
# that name would also be read as its --home and the two could silently disagree. Every
# invocation below passes --home/--node.store explicitly.
APP_HOME="${CELESTIA_APP_HOME:-/var/lib/celestia/app}"
BRIDGE_STORE="${CELESTIA_BRIDGE_STORE:-/var/lib/celestia/bridge}"
STATE_DIR="${CELESTIA_STATE_DIR:-/var/lib/celestia/state}"
AUTH_DIR="${CELESTIA_AUTH_DIR:-/celestia/auth}"

CORE_RPC_PORT="${CELESTIA_CORE_RPC_PORT:-26657}"
RPC_PORT="${CELESTIA_RPC_PORT:-26658}"
# DIVERGENCE 1 (required by containers): celestia-node's --rpc.addr defaults to localhost, so a
# bridge started the way the orchestrator starts it listens on container-loopback and refuses
# every client that arrives through a published port — the identical defect P3 found and patched
# in umbra-evm's WebSocket server. On a developer laptop the default is correct; in a container
# it is unusable, and the failure mode (connection refused through a port that probes as open)
# names nothing.
RPC_ADDR="${CELESTIA_RPC_ADDR:-0.0.0.0}"

VALIDATOR_BALANCE="${CELESTIA_VALIDATOR_BALANCE:-1000000000000000utia}"
GENTX_STAKE="${CELESTIA_GENTX_STAKE:-5000000000utia}"
GENTX_FEES="${CELESTIA_GENTX_FEES:-500utia}"
BRIDGE_FUND="${CELESTIA_BRIDGE_FUND:-100000000utia}"
FUND_FEES="${CELESTIA_FUND_FEES:-2000utia}"

SKIP_AUTH="${CELESTIA_SKIP_AUTH:-false}"
# DIVERGENCE 2 (required by containers): BBR congestion control is a host kernel setting the
# container cannot make true, and celestia-appd refuses to start without it unless told not to
# care. The orchestrator passes the same thing through CELESTIA_FORCE_NO_BBR=1.
FORCE_NO_BBR="${CELESTIA_FORCE_NO_BBR:-1}"
BRIDGE_START_DELAY="${CELESTIA_BRIDGE_START_DELAY:-6}"
GENESIS_WAIT_SECS="${CELESTIA_GENESIS_WAIT_SECS:-120}"
BRIDGE_WAIT_SECS="${CELESTIA_BRIDGE_WAIT_SECS:-180}"
FUND_WAIT_SECS="${CELESTIA_FUND_WAIT_SECS:-120}"

CORE_RPC="http://127.0.0.1:${CORE_RPC_PORT}"
DA_RPC="http://127.0.0.1:${RPC_PORT}"
TOKEN_FILE="${AUTH_DIR}/token"
ENV_FILE="${AUTH_DIR}/celestia.env"
READY_FILE="${STATE_DIR}/ready"

say() { printf '[celestia] %s\n' "$*"; }
die() { printf '[celestia] FATAL: %s\n' "$*" >&2; exit 1; }

# ── a JSON-RPC call against the local DA RPC ─────────────────────────────────
# Used for the bridge's own address/balance. The Authorization header is omitted when the token
# is not available yet (and when auth is skipped), which the server accepts in skip-auth mode and
# rejects otherwise — either way the caller sees the real answer rather than a masked error.
da_rpc() {
  local method="$1" params="${2:-[]}" auth=()
  [[ -s "$TOKEN_FILE" ]] && auth=(-H "Authorization: Bearer $(cat "$TOKEN_FILE")")
  curl -sS --max-time 10 -H 'Content-Type: application/json' "${auth[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "$DA_RPC" 2>/dev/null
}

# patch <file> <label> <sed-expression> <required|optional>
# Asserts the edit actually changed the file. A silently-skipped patch is the failure mode this
# repo has already been bitten by (see images/umbra-evm/patches/apply.mjs, which fails the build
# when an anchor is missing) — a devnet whose RPC never got unbound from loopback, or whose ABCI
# responses are still discarded, misbehaves much later and blames something else.
patch() {
  local file="$1" label="$2" expr="$3" req="${4:-required}" before after
  before="$(sha256sum "$file" | cut -d' ' -f1)"
  sed -i -E "$expr" "$file"
  after="$(sha256sum "$file" | cut -d' ' -f1)"
  if [[ "$before" == "$after" ]]; then
    if [[ "$req" == "required" ]]; then
      die "config patch '${label}' changed nothing in ${file} — the upstream default this
           devnet relies on has moved. Inspect the file and update entrypoint.sh."
    fi
    say "note: patch '${label}' was already applied or does not apply to this version"
  else
    say "patched ${label}"
  fi
}

# ── 1. genesis ───────────────────────────────────────────────────────────────
init_genesis() {
  say "initialising a fresh ${CHAIN_ID} genesis in ${APP_HOME}"
  celestia-appd init "$CHAIN_ID" --chain-id "$CHAIN_ID" --home "$APP_HOME" >/dev/null

  # The mnemonic this prints is a throwaway for a throwaway chain; it is discarded on purpose.
  celestia-appd keys add "$KEY_NAME" "--keyring-backend=${KEYRING_BACKEND}" \
    --home "$APP_HOME" >/dev/null 2>&1

  local validator_addr
  validator_addr="$(celestia-appd keys show "$KEY_NAME" -a \
    "--keyring-backend=${KEYRING_BACKEND}" --home "$APP_HOME")"
  say "validator address ${validator_addr}"

  celestia-appd genesis add-genesis-account "$validator_addr" "$VALIDATOR_BALANCE" \
    --home "$APP_HOME" >/dev/null
  celestia-appd genesis gentx "$KEY_NAME" "$GENTX_STAKE" \
    --fees "$GENTX_FEES" "--keyring-backend=${KEYRING_BACKEND}" \
    --chain-id "$CHAIN_ID" --home "$APP_HOME" \
    --commission-rate=0.05 --commission-max-rate=1.0 --commission-max-change-rate=1.0 >/dev/null 2>&1
  celestia-appd genesis collect-gentxs --home "$APP_HOME" >/dev/null 2>&1

  local cfg="${APP_HOME}/config/config.toml"
  # Bind the consensus RPC to all interfaces. Not published to the host (the bridge dials it over
  # container-loopback), but the bridge's own core connection and any `compose exec` debugging
  # both go through it, and leaving it on 127.0.0.1 makes a future `--core.ip <service>` split
  # into two containers fail for a reason nobody will guess.
  patch "$cfg" "consensus RPC bind" 's#"tcp://127\.0\.0\.1:26657"#"tcp://0.0.0.0:26657"#'
  # `indexer = "null"` discards the tx index, and `discard_abci_responses = true` discards the
  # events. The bridge's blob queries need both; without them blob.GetAll answers for a height
  # whose data the consensus node has thrown away.
  patch "$cfg" "tx indexer = kv"         's#^indexer *=.*#indexer = "kv"#'
  patch "$cfg" "keep ABCI responses"     's#^discard_abci_responses *=.*#discard_abci_responses = false#'
  patch "$cfg" "log level"               's#^log_level *= *"info"#log_level = "*:error,p2p:info,state:info"#' optional

  # 1 week of voting on a chain that lives for the length of a demo makes any governance test
  # impossible. Nothing here uses governance; carried over for parity with the kernel's devnet.
  patch "${APP_HOME}/config/genesis.json" "voting period 30s" 's#"604800s"#"30s"#' optional

  say "genesis initialised"
}

# ── 2. start the consensus node ──────────────────────────────────────────────
start_app() {
  local args=(
    start
    --home "$APP_HOME"
    --api.enable
    --grpc.enable
    --rpc.unsafe
    --grpc-web.enable
    --delayed-precommit-timeout 1s
  )
  [[ "$FORCE_NO_BBR" == "1" || "$FORCE_NO_BBR" == "true" ]] && args+=(--force-no-bbr)
  say "starting celestia-appd"
  celestia-appd "${args[@]}" &
  APP_PID=$!
}

# ── 3. the genesis block hash, which is the two nodes' shared secret ─────────
# celestia-node identifies a custom network by `<chain id>:<genesis block hash>`, so the bridge
# cannot even be initialised until the consensus node has produced block 1.
#
# Sets the global GENESIS_HASH rather than printing it: a `$(...)` capture would swallow every
# progress line into the variable, and a `die` inside the subshell would kill only the subshell
# and let the caller carry on with an empty value.
wait_genesis_hash() {
  local deadline=$(( SECONDS + GENESIS_WAIT_SECS )) hash=""
  say "waiting for the genesis block (up to ${GENESIS_WAIT_SECS}s)"
  while (( SECONDS < deadline )); do
    hash="$(curl -sS --max-time 5 "${CORE_RPC}/block?height=1" 2>/dev/null \
            | jq -r '.result.block_id.hash // empty' 2>/dev/null || true)"
    if [[ -n "$hash" && "$hash" != "null" ]]; then
      GENESIS_HASH="$hash"
      return 0
    fi
    kill -0 "$APP_PID" 2>/dev/null || die "celestia-appd exited before producing a block"
    sleep 1
  done
  return 1
}

# ── 4. the bridge node ───────────────────────────────────────────────────────
init_bridge() {
  say "initialising the bridge node store in ${BRIDGE_STORE}"
  celestia bridge init --core.ip 127.0.0.1 --node.store "$BRIDGE_STORE" >/dev/null
  local cfg="${BRIDGE_STORE}/config.toml"
  # celestia-node refuses to run a bridge with a pruning window set; the orchestrator patches the
  # same key. `optional` because the key's name has moved between node versions and its absence
  # is not fatal — an actually-refused start would be, and loudly.
  [[ -f "$cfg" ]] && patch "$cfg" "bridge PruningWindow = 0" 's#^([[:space:]]*)PruningWindow[[:space:]]*=.*#\1PruningWindow = "0"#' optional
}

# ── 5. the auth token ────────────────────────────────────────────────────────
# `celestia bridge auth admin` signs a JWT with the secret in the node store's keystore. The same
# store yields a valid token every time, so the file written here stays valid for the life of the
# volume — which is what lets a consumer read it once at startup.
mint_token() {
  local token
  token="$(celestia bridge auth admin --node.store "$BRIDGE_STORE" 2>/dev/null | tail -1 || true)"
  [[ "$token" =~ ^ey[A-Za-z0-9._-]+$ ]] || return 1
  printf '%s' "$token" > "$TOKEN_FILE"
  chmod 0644 "$TOKEN_FILE"
  return 0
}

write_handoff() {
  # The single file a consumer sources. It is not `env_file:` material — compose reads env_file
  # on the HOST at config time, long before this volume has any content — so the kernel/batcher
  # entrypoint must source it at startup:  set -a; . /celestia/auth/celestia.env; set +a
  cat > "$ENV_FILE" <<EOF
# Written by the celestia service's entrypoint. Source it, do not use it as compose env_file:
#   set -a; . ${ENV_FILE}; set +a
# Regenerated on every container start; the token stays valid for the life of the data volume.
CELESTIA_RPC_URL=http://celestia:${RPC_PORT}
CELESTIA_AUTH_TOKEN=$( [[ -s "$TOKEN_FILE" ]] && cat "$TOKEN_FILE" )
CELESTIA_NAMESPACE=${CELESTIA_NAMESPACE:-}
CELESTIA_NETWORK=${CELESTIA_NETWORK:-devnet}
CELESTIA_CHAIN_ID=${CHAIN_ID}
EOF
  chmod 0644 "$ENV_FILE"
}

start_bridge() {
  local args=(
    bridge start
    --core.ip 127.0.0.1
    --node.store "$BRIDGE_STORE"
    --rpc.addr "$RPC_ADDR"
    --rpc.port "$RPC_PORT"
  )
  # DIVERGENCE 3: the orchestrator's devnet runs `--rpc.skip-auth`, so the kernel's
  # CELESTIA_AUTH_TOKEN path is never exercised locally — it is only exercised against the hosted
  # preview endpoint, i.e. the first place a mistake in it costs money. Auth is ON here so the
  # token path is the one P4b wires up and verify.sh proves. CELESTIA_SKIP_AUTH=true restores the
  # upstream behaviour for debugging.
  if [[ "$SKIP_AUTH" == "true" || "$SKIP_AUTH" == "1" ]]; then
    say "WARNING: starting the bridge with --rpc.skip-auth — the DA RPC is unauthenticated"
    args+=(--rpc.skip-auth)
  fi
  say "starting the celestia bridge node (DA RPC on ${RPC_ADDR}:${RPC_PORT})"
  celestia "${args[@]}" &
  BRIDGE_PID=$!
}

# ── 6. wait for the DA RPC, and learn the bridge's own address ───────────────
# Sets the global BRIDGE_ADDR, for the same reason wait_genesis_hash does.
wait_bridge_address() {
  local deadline=$(( SECONDS + BRIDGE_WAIT_SECS )) addr=""
  say "waiting for the DA RPC to answer state.AccountAddress (up to ${BRIDGE_WAIT_SECS}s)"
  while (( SECONDS < deadline )); do
    addr="$(da_rpc state.AccountAddress | jq -r '.result // empty' 2>/dev/null || true)"
    if [[ -n "$addr" && "$addr" != "null" ]]; then
      BRIDGE_ADDR="$addr"
      return 0
    fi
    kill -0 "$BRIDGE_PID" 2>/dev/null || die "the bridge node exited before its RPC answered"
    sleep 2
  done
  return 1
}

bridge_balance() {
  da_rpc state.Balance | jq -r '.result.amount // empty' 2>/dev/null || true
}

# ── 7. fund the bridge wallet ────────────────────────────────────────────────
# A bridge node signs its own blob submissions, so with an empty wallet blob.Submit fails at the
# fee — which is the whole point of the kernel's `celestia-fund-bridge` step.
fund_bridge() {
  local addr="$1" bal
  bal="$(bridge_balance)"
  if [[ -n "$bal" && "$bal" != "0" ]]; then
    say "bridge wallet ${addr} already holds ${bal} utia — nothing to fund"
    return 0
  fi

  say "funding bridge wallet ${addr} with ${BRIDGE_FUND}"
  celestia-appd tx bank send "$KEY_NAME" "$addr" "$BRIDGE_FUND" \
    --fees "$FUND_FEES" --chain-id "$CHAIN_ID" \
    "--keyring-backend=${KEYRING_BACKEND}" --yes --home "$APP_HOME" >/dev/null \
    || die "the funding transaction was rejected"

  # A submitted tx is not an included tx. Wait for the balance the bridge itself reports, since
  # that is the number blob.Submit will price against.
  local deadline=$(( SECONDS + FUND_WAIT_SECS ))
  while (( SECONDS < deadline )); do
    bal="$(bridge_balance)"
    if [[ -n "$bal" && "$bal" != "0" ]]; then
      say "bridge wallet funded: ${bal} utia"
      return 0
    fi
    sleep 2
  done
  die "the funding transaction never showed up in the bridge's balance"
}

# ── main ─────────────────────────────────────────────────────────────────────
APP_PID=""
BRIDGE_PID=""
GENESIS_HASH=""
BRIDGE_ADDR=""

shutdown() {
  say "shutting down"
  [[ -n "$BRIDGE_PID" ]] && kill "$BRIDGE_PID" 2>/dev/null || true
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown INT TERM

mkdir -p "$APP_HOME" "$STATE_DIR" "$AUTH_DIR"
# Readiness is asserted, not assumed: the marker is removed here and only written once the whole
# bootstrap has succeeded, so a container that comes back up mid-bootstrap cannot report ready.
rm -f "$READY_FILE"

say "celestia-appd $(celestia-appd version 2>&1 | head -1) / celestia-node $(celestia version 2>&1 | sed -n 's/^Semantic version: //p')"
say "chain-id=${CHAIN_ID} namespace=${CELESTIA_NAMESPACE:-<unset>} auth=$( [[ "$SKIP_AUTH" == "true" || "$SKIP_AUTH" == "1" ]] && echo skipped || echo required )"

[[ -f "${APP_HOME}/config/genesis.json" ]] || init_genesis
start_app

wait_genesis_hash || die "no genesis block within ${GENESIS_WAIT_SECS}s"
say "genesis block hash ${GENESIS_HASH}"

# The handshake: both `bridge init` and `bridge start` must see the same value, and so must
# `bridge auth`, so it is exported once for every celestia-node invocation below.
export CELESTIA_CUSTOM="${CHAIN_ID}:${GENESIS_HASH}"

[[ -f "${BRIDGE_STORE}/config.toml" ]] || init_bridge

# Mint before start where possible: the token file is then already in place when the bridge's RPC
# comes up, which removes a window in which a consumer could read an empty file. The CLI's own
# help says to use it after the node has started, so a post-start retry follows.
TOKEN_STAGE="pre-start"
mint_token || TOKEN_STAGE="post-start"
write_handoff

say "pausing ${BRIDGE_START_DELAY}s before the bridge starts (upstream does the same: the
     consensus node's gRPC is not immediately ready after its first block)"
sleep "$BRIDGE_START_DELAY"
start_bridge

if [[ "$TOKEN_STAGE" == "post-start" ]]; then
  say "minting the auth token after start"
  for _ in $(seq 1 30); do
    mint_token && break
    kill -0 "$BRIDGE_PID" 2>/dev/null || die "the bridge node exited before a token could be minted"
    sleep 2
  done
  [[ -s "$TOKEN_FILE" ]] || die "could not mint an auth token"
  write_handoff
fi
say "auth token written to ${TOKEN_FILE} (${TOKEN_STAGE})"

wait_bridge_address || die "the DA RPC never answered within ${BRIDGE_WAIT_SECS}s"
say "bridge wallet ${BRIDGE_ADDR}"
fund_bridge "$BRIDGE_ADDR"

printf '%s\n' "$BRIDGE_ADDR" > "$READY_FILE"
say "READY — DA RPC on :${RPC_PORT}, namespace ${CELESTIA_NAMESPACE:-<unset>}"

# DIVERGENCE 4: the orchestrator supervises these as two of its own processes and restarts them
# individually. A container has one lifecycle, so if EITHER node dies the container must die too
# and let compose's restart policy deal with it — a container still "running" with half a devnet
# inside answers some calls and fails others, which is the worst thing to hand a debugger.
RC=0
wait -n "$APP_PID" "$BRIDGE_PID" || RC=$?
kill -0 "$APP_PID" 2>/dev/null    || say "celestia-appd exited (rc=${RC})"
kill -0 "$BRIDGE_PID" 2>/dev/null || say "the bridge node exited (rc=${RC})"
rm -f "$READY_FILE"
kill "$BRIDGE_PID" 2>/dev/null || true
kill "$APP_PID" 2>/dev/null || true
wait 2>/dev/null || true
# A node that stops on its own is a failure even when it exits 0: half a devnet must not look
# like a clean shutdown to compose's restart policy.
exit $(( RC == 0 ? 1 : RC ))
