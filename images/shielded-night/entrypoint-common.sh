#!/usr/bin/env bash
# entrypoint-common.sh — the shared prelude for the shielded-night deploy one-shot and the
# verify driver. SOURCED, never executed.
#
# WHAT THIS FILE DELIBERATELY DOES NOT DO: supply endpoint defaults. shielded-night's
# `undeployed` network config defaults to 127.0.0.1, and inside a container 127.0.0.1 means
# "nothing is there". A second layer of defaults here would turn "compose forgot to state an
# endpoint" into a connection timeout against localhost instead of the configuration error it
# is. Every endpoint is stated explicitly in compose/shielded-night.yml, and `require_env`
# makes a missing one fatal and named.
#
# Everything is probed with `bun -e`: the oven/bun base image ships neither curl nor wget, and
# installing one purely for a readiness probe would grow the image for nothing.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/app}"
CONTRACT_SHARE_DIR="${CONTRACT_SHARE_DIR:-/srv/shielded-night}"
# Read by the entrypoints that SOURCE this file, which shellcheck cannot see from inside the
# library.
# shellcheck disable=SC2034
CONTRACT_FILE="${CONTRACT_SHARE_DIR}/contract.json"

# The seed shielded-night's own scripts fall back to on `undeployed`, and the one seed this
# stack must never hand them: here it is the faucet every `fund-wallet.sh` run pays out of AND
# the offer-files kernel's MIDNIGHT_WALLET_SEED. Two wallet facades on one seed force each
# other's connection down, silently (wallets/wallets.json).
#
# This profile does not merely avoid it — it has its OWN dedicated seed, funded at bring-up by
# the `shielded-night-fund` one-shot, so nothing here competes with genesis-1, genesis-2 (the
# batcher) or genesis-3 (the AA deploy wallet) for a wallet facade.
GENESIS_1_SEED='0000000000000000000000000000000000000000000000000000000000000001'

log() { printf '[%s] %s\n' "${ROLE:-shielded-night}" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ── fail loudly on a variable a container cannot sensibly default ────────────
require_env() {
  local missing=() name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("${name}"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "missing required environment: ${missing[*]}"
    exit 78   # EX_CONFIG
  fi
}

# refuse_genesis_1 <seed> <what it is for>
#
# Enforced here rather than left to compose, because the DEFAULT this refuses is upstream's,
# not ours: `deploy.ts` resolves `MN_SEED ?? GENESIS_MINT_SEED` on `undeployed`, so an
# operator who merely unsets the variable gets the forbidden wallet without a word.
refuse_genesis_1() {
  local seed="$1" what="$2"
  if [ "${seed}" = "${GENESIS_1_SEED}" ]; then
    log "REFUSING to use the genesis-1 seed as the ${what}."
    log "In this stack that seed is the funding faucet (FUND_FROM_SEED) and the offer-files"
    log "kernel's MIDNIGHT_WALLET_SEED. A second facade on it takes one of them offline with"
    log "no error naming the cause. This profile has its own funded seed; see"
    log "wallets/wallets.json and spec FR-009."
    exit 78
  fi
}

# ── readiness ────────────────────────────────────────────────────────────────
#
# EVERY wait FAILS the caller rather than warning. A deploy that starts against a half-ready
# stack does not fail here — it fails later, somewhere unrelated, with an error that names the
# wrong component.

# wait_http <url> <label> [timeout_s]
#
# ANY HTTP response counts as "listening", including a 404 or a 405: what is being waited on is
# a socket that answers, not a particular status.
wait_http() {
  local url="$1" label="$2" timeout="${3:-300}" waited=0
  log "waiting for ${label} at ${url} (timeout ${timeout}s)"
  until bun -e '
    const r = await fetch(process.argv[1], { signal: AbortSignal.timeout(4000) }).catch(() => null);
    process.exit(r ? 0 : 1);
  ' "${url}" >/dev/null 2>&1; do
    waited=$(( waited + 2 ))
    if [ "${waited}" -ge "${timeout}" ]; then
      log "TIMEOUT after ${timeout}s waiting for ${label} at ${url}"
      return 1
    fi
    sleep 2
  done
  log "${label} is up"
}

# wait_node_block <http-rpc-url> [min-block] [timeout_s]
#
# Compose health is not readiness for a Substrate chain: the node answers RPC long before it
# has produced anything, and a deploy proves and submits a real transaction. Until finality has
# moved off genesis the wallet refuses to build one at all.
wait_node_block() {
  local url="$1" min_block="${2:-1}" timeout="${3:-600}" waited=0
  log "waiting for midnight-node block #${min_block} at ${url} (timeout ${timeout}s)"
  until bun -e '
    const [url, minBlock] = [process.argv[1], Number(process.argv[2])];
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_getBlockHash", params: [minBlock] }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) process.exit(1);
    const json = await res.json().catch(() => null);
    process.exit(json && json.result ? 0 : 1);
  ' "${url}" "${min_block}" >/dev/null 2>&1; do
    waited=$(( waited + 2 ))
    if [ "${waited}" -ge "${timeout}" ]; then
      log "TIMEOUT after ${timeout}s waiting for block #${min_block} at ${url}"
      return 1
    fi
    sleep 2
  done
  log "midnight-node has block #${min_block}"
}

# wait_for_stack — the three core services this profile depends on, and nothing else. Re-proved
# per container rather than inherited from bring-up: a container that comes back after its
# dependencies moved must not inherit a stale all-clear.
wait_for_stack() {
  wait_node_block "${MN_NODE_URL}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}" \
    || die "midnight-node produced no block"
  wait_http "${MN_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}" \
    || die "proof-server never answered"
  wait_http "${MN_INDEXER_URL}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}" \
    || die "indexer never answered"
}

# published_address — the address the deploy one-shot published, from the shared volume.
published_address() {
  local address
  address="$(CONTRACT_JSON="${CONTRACT_FILE}" bun -e '
    const json = await Bun.file(process.env.CONTRACT_JSON).json();
    const value = json.address;
    if (typeof value !== "string" || !/^[0-9a-fA-F]{16,128}$/.test(value)) {
      console.error("contract.json carries no usable string address");
      process.exit(1);
    }
    process.stdout.write(value);
  ')" || return 1
  printf '%s' "${address}"
}
