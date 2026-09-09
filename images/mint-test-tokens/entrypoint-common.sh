#!/usr/bin/env bash
# entrypoint-common.sh — the shared prelude for the mint-test-tokens deploy one-shot, the
# read-only verifier, the registry bridge and the wallet mint test. SOURCED, never executed.
#
# WHAT THIS FILE DELIBERATELY DOES NOT DO: supply endpoint defaults. Upstream's `undeployed`
# network config already defaults to 127.0.0.1, and inside a container 127.0.0.1 means
# "nothing is there". A second layer of defaults here would turn "compose forgot to state an
# endpoint" into a connection timeout against localhost instead of the configuration error it
# is. Every endpoint is stated explicitly in compose/faucet.yml, and `require_env` makes a
# missing one fatal and named. This is the same reasoning — and the same shape — as
# images/shielded-night/entrypoint-common.sh.
#
# Probes are `node -e`, because this image's base is node and it ships neither curl nor wget.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/app}"
# Where the deploy publishes and every other role reads. A DIRECTORY, never a file: the
# registry is replaced by atomic rename, so a single-file bind mount would stay attached to the
# previous inode (docs/registry.md is explicit about this).
REGISTRY_DIR="${MN_METADATA_OUTPUT_DIR:-/registry}"
# Read by the entrypoints that SOURCE this file, which shellcheck cannot see from in here.
# shellcheck disable=SC2034
REGISTRY_FILE="${REGISTRY_DIR}/metadata.${MN_NETWORK:-undeployed}.json"

# The three CFG_PRESET=dev genesis seeds. genesis-1 is this stack's funding faucet AND the
# offer-files kernel's MIDNIGHT_WALLET_SEED, genesis-2 is the batcher's, genesis-3 is the AA
# deploy wallet's. Two long-lived wallet facades on one seed against one node force each
# other's connection down, silently — so this profile refuses all three outright rather than
# trusting compose to have set something else (wallets/wallets.json, spec FR-009).
GENESIS_SEEDS=(
  '0000000000000000000000000000000000000000000000000000000000000001'
  '0000000000000000000000000000000000000000000000000000000000000002'
  '0000000000000000000000000000000000000000000000000000000000000003'
)

log() { printf '[%s] %s\n' "${ROLE:-mint-test-tokens}" "$*" >&2; }
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

# refuse_genesis <seed> <what it is for>
refuse_genesis() {
  local seed="$1" what="$2" g
  for g in "${GENESIS_SEEDS[@]}"; do
    if [ "${seed}" = "${g}" ]; then
      log "REFUSING to use a genesis seed as the ${what}."
      log "In this stack the three genesis seeds are held by the funding faucet + offer-files"
      log "kernel, the batcher, and the AA deploy wallet. A second facade on one of them takes"
      log "the other offline with no error naming the cause. This profile has its own funded"
      log "seed; see wallets/wallets.json and docs/WALLETS.md."
      exit 78
    fi
  done
}

# ── the private seed file ────────────────────────────────────────────────────
#
# The runner accepts a master seed ONLY through a file, and docs/registry.md requires that file
# to live outside the repository with owner-only permissions. NOTHING is baked into the image:
# the seed arrives as an environment variable from compose and is written, here, into a tmpfs
# mount that never touches a layer or a volume.
#
# write_seed_file <VAR-NAME> <path> — writes and echoes the path.
write_seed_file() {
  local var="$1" path="$2" value="${!1:-}"
  [ -n "${value}" ] || { log "missing required environment: ${var}"; exit 78; }
  # 64 or 128 lowercase hex characters — exactly what upstream's validateMasterSeedHex accepts
  # (32 or 64 BYTES). Checked here so a typo is a configuration error naming the variable,
  # rather than a stack trace out of the wallet SDK.
  case "${value}" in
    *[!0-9a-fA-F]*) log "${var} must be hexadecimal"; exit 78 ;;
  esac
  case "${#value}" in
    64|128) : ;;
    *) log "${var} must be 64 or 128 hex characters (32 or 64 bytes), got ${#value}"; exit 78 ;;
  esac
  refuse_genesis "${value}" "${var}"
  mkdir -p "$(dirname "${path}")"
  ( umask 077; printf '%s' "${value}" > "${path}" )
  chmod 0600 "${path}"
  printf '%s' "${path}"
}

# ── readiness ────────────────────────────────────────────────────────────────
#
# EVERY wait FAILS the caller rather than warning. A deploy that starts against a half-ready
# stack does not fail here — it fails later, somewhere unrelated, with an error naming the
# wrong component.

# wait_http <url> <label> [timeout_s]
# ANY HTTP response counts as "listening", including a 404 or a 405: what is waited on is a
# socket that answers, not a particular status.
wait_http() {
  local url="$1" label="$2" timeout="${3:-300}" waited=0
  log "waiting for ${label} at ${url} (timeout ${timeout}s)"
  until node -e '
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
# has produced anything, and a deploy proves and submits six real transactions. Until finality
# has moved off genesis the wallet refuses to build one at all.
wait_node_block() {
  local url="$1" min_block="${2:-1}" timeout="${3:-600}" waited=0
  log "waiting for midnight-node block #${min_block} at ${url} (timeout ${timeout}s)"
  until node -e '
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
  wait_http "${MN_INDEXER_URL}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}" \
    || die "indexer never answered"
  if [ -n "${MN_PROOF_SERVER_URL:-}" ]; then
    wait_http "${MN_PROOF_SERVER_URL}" "proof-server" "${PROOF_WAIT_TIMEOUT_S:-300}" \
      || die "proof-server never answered"
  fi
}

# ── the published registry ───────────────────────────────────────────────────
#
# Re-opened BY PATH on every call, never cached and never bind-mounted as a file: publication
# is an atomic rename, so a stale handle is a stale registry.
#
# registry_summary — "<status> <ready-active-deployments>" for the published file, or a
# non-zero exit when it cannot be read at all.
registry_summary() {
  REG_FILE="${REGISTRY_FILE}" node -e '
    const fs = await import("node:fs/promises");
    let doc;
    try { doc = JSON.parse(await fs.readFile(process.env.REG_FILE, "utf8")); }
    catch (e) { console.error(String(e)); process.exit(1); }
    const active = (doc.tokens ?? []).filter((t) =>
      (t.deployments ?? []).some((d) => d.deploymentId === t.activeDeploymentId && d.status === "active"));
    process.stdout.write(`${doc.status ?? "?"} ${active.length}`);
  '
}
