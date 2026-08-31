# shellcheck shell=bash
#
# Running midnight-node-toolkit against the demo stack.
#
# The toolkit ships as a container, so every call is a `docker run` joined to the compose
# project's network — that way it addresses the node as ws://node:9944 and nothing depends
# on which host port this stack happens to be using.
#
# Requires common.sh to have been sourced first (load_env, log/ok/err).

# The toolkit is the good official multiarch image, pinned by its complete index digest —
# never composed from a tag. load_env() sets and validates this; the default here only
# covers a caller that sourced this file without it. Readable version: TOOLKIT_VERSION.
: "${TOOLKIT_IMAGE:=docker.io/midnightntwrk/midnight-node-toolkit@sha256:c3efb50d483b1216e9582669038dc6d2fac509b33d11ebc0b4e0d0d0b86b4d0f}"
: "${TOOLKIT_VERSION:=2.0.0-rc.4}"
: "${NODE_VERSION:=2.0.0-rc.4}"

# The node's URL as seen from inside the compose network. Container ports are fixed, so
# this is independent of NODE_HOST_PORT.
: "${TOOLKIT_NODE_URL:=ws://node:9944}"

# ── network discovery ────────────────────────────────────────────────────────
# Read the network off the running node container rather than assuming
# "${COMPOSE_PROJECT_NAME}_default": compose normalizes project names (lowercasing,
# stripping characters) and a fragment could rename the network later.
toolkit_network() {
  if [[ -n "${TOOLKIT_NETWORK:-}" ]]; then printf '%s' "$TOOLKIT_NETWORK"; return 0; fi
  local cid net
  cid=$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=node" 2>/dev/null | head -1)
  [[ -z "$cid" ]] && return 1
  net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$cid" 2>/dev/null | head -1)
  [[ -z "$net" ]] && return 1
  TOOLKIT_NETWORK="$net"
  printf '%s' "$net"
}

# require_stack — assert the stack is up and ready for toolkit work, in the only order that
# works: the network must exist, the chain must be transactable, and only then can the fetch
# cache be primed (priming issues a chain query, so it is useless before finality moves).
require_stack() {
  local net
  net=$(toolkit_network) || die "no running 'node' container for project '${COMPOSE_PROJECT_NAME}' — run ./up.sh first"
  dim "toolkit network: $net"
  # The toolkit refuses to build transactions while only genesis is finalized
  # (`OnlyGenesisFinalized`). up.sh already waits for this, but these scripts also run
  # standalone; on a chain that has been up a while this returns immediately.
  wait_finalized_height "$NODE_RPC_URL" 1 "${CHAIN_READY_TIMEOUT:-180}" \
    || die "chain is not transactable yet (finality still on genesis)"
  toolkit_warmup
}

# toolkit_warmup — burn the toolkit's guaranteed-failing first chain call.
#
# TOOLKIT BUG (midnight-node-toolkit 2.0.0-rc.4): the first chain command run against an
# EMPTY fetch-cache directory always panics —
#
#   panicked at util/toolkit/src/fetcher/fetch_storage/redb_backend.rs:96:61:
#   failed to create database: Storage(Io(Os { code: 2, kind: NotFound, … }))
#
# ...but it leaves a working `toolkit_fetch_cache.db` behind, so the very next call
# succeeds. Reproduced deterministically: an empty cache dir fails, the same dir on the
# second call succeeds. Pre-creating the directory does not help, and neither does
# pre-creating the MN_LEDGER_CACHE_DB directory — the file has to exist.
#
# So the cache is initialized once, up front, with a throwaway query whose failure is
# ignored. Without this the failure lands on whatever real command happens to run first:
# a `generate-txs` funding call (which then simply fails) or a `show-wallet` in
# verify-wallets.sh (which then looks like an empty wallet). Remove this when the toolkit
# stops panicking on a cold cache.
toolkit_warmup() {
  local cache; cache="$(toolkit_cache_dir)"
  mkdir -p "$cache"
  [[ -f "$cache/toolkit_fetch_cache.db" ]] && return 0
  dim "priming the toolkit fetch cache (its first call on a cold cache always fails)"
  tkq show-address --network "${NETWORK_ID:-undeployed}" \
    --seed 0000000000000000000000000000000000000000000000000000000000000001 >/dev/null 2>&1 || true
  tkq show-wallet --src-url "$TOOLKIT_NODE_URL" \
    --seed 0000000000000000000000000000000000000000000000000000000000000001 >/dev/null 2>&1 || true
  if [[ -f "$cache/toolkit_fetch_cache.db" ]]; then
    dim "fetch cache initialized"
  else
    warn "could not initialize the toolkit fetch cache — the next toolkit call may fail once"
  fi
}

# The fetch cache, as a HOST directory (gitignored) rather than a docker named volume.
#
# `docker run -v name:/path` creates a volume with NO compose labels, so
# `docker compose down -v` will not remove it and the next run inherits a cache built
# against a genesis that no longer exists — a silent, confusing failure. A host directory
# has exactly one owner: down.sh -v deletes it alongside the chain volumes. The `fund`
# compose service binds the same path.
toolkit_cache_dir() {
  printf '%s/.cache/%s' "$REPO_ROOT" "${COMPOSE_PROJECT_NAME}"
}

# ── invocation ───────────────────────────────────────────────────────────────
# tk <toolkit args...>
#   Runs the toolkit. stdout is the command's own output (JSON for the query commands);
#   progress and logs go to stderr, so `tk … 2>/dev/null` yields parseable JSON.
#
# The cache lives at /.cache, matching the image's own defaults
# (MN_FETCH_CACHE=redb:/.cache/toolkit_fetch_cache.db, MN_LEDGER_CACHE_DB=/.cache/…).
# redb demands a single writer, so toolkit calls must stay sequential — every script here
# runs them one at a time on purpose.
tk() {
  local net cache
  net=$(toolkit_network) || return 1
  cache="$(toolkit_cache_dir)"
  mkdir -p "$cache"
  docker run --rm \
    --network "$net" \
    -v "$cache:/.cache" \
    -e "RESTORE_OWNER=$(id -u):$(id -g)" \
    ${TOOLKIT_EXTRA_ARGS:-} \
    "$TOOLKIT_IMAGE" "$@"
}

# tkq <toolkit args...> — same, with the toolkit's info logging suppressed.
tkq() { tk -q "$@"; }

# jqf <filter> — filter JSON from stdin. Uses the jq inside the toolkit image so the host
# needs no jq (or python) installed.
jqf() {
  docker run -i --rm --entrypoint jq "$TOOLKIT_IMAGE" -r "$1"
}

# ── queries ──────────────────────────────────────────────────────────────────

# tk_json_retry <attempts> <toolkit args...>
#
# Belt and braces behind toolkit_warmup: a toolkit query that returns nothing is retried
# rather than reported as an empty wallet. The known cause is the cold-cache panic that
# toolkit_warmup absorbs, and a retry recovers from it even if the priming was skipped or
# the cache was wiped mid-run. On the final attempt the toolkit's stderr is let through, so
# a genuine failure is diagnosable instead of masquerading as "this wallet has no funds" —
# which is exactly how the cold-cache bug first presented.
tk_json_retry() {
  local attempts="$1"; shift
  local i out
  for (( i = 1; i <= attempts; i++ )); do
    if (( i < attempts )); then
      out=$(tkq "$@" 2>/dev/null || true)
    else
      out=$(tkq "$@" 2>/tmp/tk-err.$$ || true)
    fi
    if [[ -n "$out" ]]; then
      rm -f /tmp/tk-err.$$
      printf '%s' "$out"
      return 0
    fi
    (( i < attempts )) && sleep 5
  done
  if [[ -s /tmp/tk-err.$$ ]]; then
    warn "toolkit failed after ${attempts} attempts; last stderr:"
    tail -5 /tmp/tk-err.$$ >&2
  fi
  rm -f /tmp/tk-err.$$
  return 1
}

# wallet_json <seed> — the full show-wallet JSON for a seed, read from the live chain.
wallet_json() {
  tk_json_retry "${TOOLKIT_RETRIES:-3}" show-wallet --src-url "$TOOLKIT_NODE_URL" --seed "$1"
}

# dust_json <seed> — the full dust-balance JSON for a seed.
dust_json() {
  tk_json_retry "${TOOLKIT_RETRIES:-3}" dust-balance --src-url "$TOOLKIT_NODE_URL" --seed "$1"
}

# address_json <seed> — every address form for a seed. Offline: no chain access needed.
address_json() {
  tkq show-address --network "${NETWORK_ID:-undeployed}" --seed "$1" 2>/dev/null
}

# address_of <seed> <kind>  where kind is unshielded | shielded | dust | userAddress
address_of() {
  address_json "$1" | jqf ".${2}"
}

# ── readiness ────────────────────────────────────────────────────────────────
# wait_spendable_dust <seed> [timeout_secs]
#
# Readiness is `dust_utxos` being NON-EMPTY, not `dust-balance.total > 0`. After
# register-dust-address the balance figure moves first and the spendable UTXO appears a
# moment later; waiting on the balance returns a wallet that still cannot pay a fee.
#
# NOTE: a non-empty dust_utxos means the wallet CAN pay fees, not that it can pay THIS
# fee — DUST accrues in proportion to the NIGHT backing it, so a thinly funded wallet needs
# to sit for a long time before a transfer balances. See fund-wallet.sh --amount.
wait_spendable_dust() {
  local seed="$1" secs="${2:-180}"
  local deadline=$(( SECONDS + secs ))
  info "waiting for spendable DUST (up to ${secs}s)"
  while (( SECONDS < deadline )); do
    local n
    n=$(wallet_json "$seed" | jqf '(.dust_utxos // []) | length' 2>/dev/null || echo 0)
    [[ -z "$n" || "$n" == "null" ]] && n=0
    if (( n >= 1 )); then
      ok "spendable DUST present (${n} dust UTXO(s))"
      return 0
    fi
    sleep 5
  done
  err "no spendable DUST UTXO within ${secs}s"
  return 1
}

# ── version guard ────────────────────────────────────────────────────────────
# check_toolkit_version — warns unless the toolkit's reported Node version is a prefix of
# NODE_VERSION (toolkit 2.0.0-rc.4 reports "Node: 2.0.0" for node version "2.0.0-rc.4").
#
# NODE_VERSION is the readable label, not the identity: the node and toolkit images are both
# pinned by digest and this guard only answers "do these two agree on the tx format?".
#
# Only the Node line is compared. The Ledger and Compactc lines in `toolkit version` are
# NOT usable as a compatibility signal on this tag: 2.0.0-rc.4 reports "Ledger: =7.0.3"
# and "Compactc: 0.31.0" while transacting happily against a ledger-v9 chain
# (protocolVersion 2000000). Gating on them would reject a working combination.
check_toolkit_version() {
  local out node_ver
  out=$(tkq version 2>/dev/null || true)
  node_ver=$(printf '%s' "$out" | sed -n 's/^Node:[[:space:]]*//p' | head -1)
  if [[ -z "$node_ver" ]]; then
    warn "could not read 'Node:' from \`toolkit version\` — skipping the version guard"
    return 0
  fi
  if [[ "${NODE_VERSION}" == "${node_ver}"* ]]; then
    ok "toolkit ${TOOLKIT_VERSION} matches node ${NODE_VERSION} (toolkit reports Node: ${node_ver})"
    return 0
  fi
  warn "toolkit reports Node: ${node_ver} but the stack runs node ${NODE_VERSION}"
  warn "point TOOLKIT_IMAGE at the digest of the toolkit built for that node version"
  return 1
}
