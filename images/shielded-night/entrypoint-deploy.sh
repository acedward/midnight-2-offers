#!/usr/bin/env bash
# shielded-night-deploy — the ONE-SHOT that gives this stack its ShieldedNight contract, on the
# 2.x (compactc 0.34.0 / ledger-v9) lane of effectstream/shielded-night `main`.
#
# THE BUG THIS SERVICE EXISTS TO PREVENT is the same one images/offerfiles-kernel's deploy
# one-shot exists to prevent, and it is worth stating again because this contract's identity
# reaches further: the sNight token COLOUR is derived from the contract address. A stack that
# quietly redeployed on every `--force-recreate` would not merely change an address — every
# sNight coin anyone had already minted would become a different, unspendable token, and the
# page would show a zero balance with nothing logged anywhere.
#
# AND ON THIS LANE THAT IS ENTIRELY THIS SCRIPT'S JOB. Upstream is explicit about it: "deploy:v2
# always deploys a NEW contract. There is no resume or join path in it … Resumability belongs to
# the caller: a compose entrypoint that reads its own contract.json and joins the address
# already there." This is that caller.
#
# IT DOES NOT FUND ITSELF. compose gates this service on `shielded-night-fund`, a toolkit
# one-shot that gives the deployer wallet NIGHT and a registered DUST address before this
# container ever starts — because on the ledger-9 line a wallet holding NIGHT with no
# spendable DUST cannot pay a fee at all, and the failure would surface here as an opaque
# balancing error rather than as the missing funding it is.
#
# So: THIS IS THE ONLY DEPLOYER IN THE PROFILE. `restart: "no"`, and the web container waits on
# `service_completed_successfully`.
#
# Two properties carry the whole design:
#
#   IDEMPOTENCE — the presence of contract.json on the shared volume IS the "already deployed"
#   flag. A container that finds one JOINS that deployment and exits 0 without deploying.
#   Forcing a redeploy is a deliberate act: drop the volume, or `./down.sh -v`.
#
#   ATOMIC PUBLICATION — the record is written to a temp file on the same volume and `mv`d into
#   place, so the web container (which polls for the file) can never read a half-written one.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=shielded-night-deploy
# shellcheck source=images/shielded-night/entrypoint-common.sh
. /usr/local/lib/shielded-night/entrypoint-common.sh

# MN_NODE_WS_URL is required on the 2.x lane and was not on the 1.x one: `undeployed()` in
# contracts/v2/scripts/profile.ts resolves it separately from MN_NODE_URL and defaults it to
# ws://127.0.0.1:9944, which inside a container means "this container".
require_env MN_INDEXER_URL MN_INDEXER_WS_URL MN_NODE_URL MN_NODE_WS_URL MN_PROOF_SERVER_URL \
            SHIELDED_NIGHT_WALLET_SEED

# `MN_ENV=undeployed` is the only network this profile deploys to, and it is asserted rather
# than defaulted: the v2 scripts DEFAULT to `stagenet`, where this stack's dev seed would be
# pointed at a network on which this dApp's own contract is already live.
MN_ENV="${MN_ENV:-undeployed}"
[ "${MN_ENV}" = "undeployed" ] \
  || die "MN_ENV must be 'undeployed' in this stack (got '${MN_ENV}') — see spec 'undeployed only'"
export MN_ENV

refuse_genesis_1 "${SHIELDED_NIGHT_WALLET_SEED}" "shielded-night deployer"

# ── knobs that have no counterpart on the v2 lane ────────────────────────────
#
# The v2 deployer SEALS the wrapper's metadata: `contracts/v2/scripts/deploy.ts` passes
# `args: ['Shielded Night', 'sNight', 6n]` literally, and `verifyAddress()` refuses any other
# on-chain metadata outright. Passing CV_NAME/CV_SYMBOL/CV_DECIMALS here would therefore change
# NOTHING while looking as though it had — the operator's value would be silently dropped and
# the registry row would then disagree with the chain. So a non-default value is refused, by
# name, with the reason. (The Dockerfile asserts those three constants are still what upstream
# seals, so this refusal cannot outlive its cause.)
SEALED_NAME='Shielded Night'
SEALED_SYMBOL='sNight'
SEALED_DECIMALS='6'
for pair in "SHIELDED_NIGHT_NAME=${SEALED_NAME}" "SHIELDED_NIGHT_SYMBOL=${SEALED_SYMBOL}" \
            "SHIELDED_NIGHT_DECIMALS=${SEALED_DECIMALS}"; do
  var="${pair%%=*}"; sealed="${pair#*=}"; got="${!var:-${sealed}}"
  if [ "${got}" != "${sealed}" ]; then
    log "REFUSING ${var}='${got}'."
    log "On the 2.x lane the wrapper's metadata is SEALED by upstream's own deployer"
    log "(contracts/v2/scripts/deploy.ts: args ['Shielded Night','sNight',6n]) and its verifier"
    log "rejects anything else. Setting this would be ignored on chain while the kernel's"
    log "SNIGHT row believed it. Only '${sealed}' is possible here."
    exit 78
  fi
done

# Likewise the lock: `scripts/deploy-and-lock.ts` and `scripts/lock.ts` are ROOT (1.x) scripts
# and have no v2 counterpart, so there is nothing to dispatch to. A throwaway devnet contract
# gains nothing from a one-way maintenance-committee dissolution anyway, and the verify
# section reads the authority state either way (spec FR-016).
case "$(printf '%s' "${SHIELDED_NIGHT_LOCK:-false}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on)
    log "REFUSING SHIELDED_NIGHT_LOCK: there is no v2 lock script upstream (deploy-and-lock.ts"
    log "and lock.ts are the 1.x tree's, and this profile is on the 2.x lane). Locking a"
    log "throwaway devnet contract is a one-way door with no benefit; unset the variable."
    exit 78
    ;;
esac

mkdir -p "${CONTRACT_SHARE_DIR}"

if [ -f "${CONTRACT_FILE}" ]; then
  log "JOIN: ${CONTRACT_FILE} already exists — NOT deploying a second contract"
  log "contract $(published_address || echo '<unreadable>')"
  log "(./down.sh -v, or dropping the shielded-night-deploy volume, forces a redeploy)"
  exit 0
fi

wait_for_stack

# The deploy record goes to a temp path ON THE SHARED VOLUME, not straight to contract.json:
# this entrypoint adds the deployer's ROLE and the flat field names this deployment's own
# consumers read, and publishes the merged record itself, atomically. Same filesystem
# throughout, so the final `mv` is a rename and never a partial copy.
RECORD_TMP="${CONTRACT_SHARE_DIR}/.deploy-record.$$.json"
PUBLISH_TMP="${CONTRACT_SHARE_DIR}/.contract.json.$$"
# shellcheck disable=SC2329  # invoked by the EXIT trap installed on the next line
cleanup() { rm -f "${RECORD_TMP}" "${PUBLISH_TMP}"; }
trap cleanup EXIT

log "no persisted contract for network ${MN_ENV} — deploying with the ${SHIELDED_NIGHT_ROLE:-shielded-night-deployer} wallet"
cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"

# SHIELDED_NIGHT_COMMIT is how the deploy record learns which revision produced it: this image
# is built from a pinned SHA and ships no .git, so upstream's `git rev-parse` fallback would
# throw. The value is baked in by the build.
SHIELDED_NIGHT_COMMIT="$(cat /.shielded-night-commit 2>/dev/null || true)"
export SHIELDED_NIGHT_COMMIT

# THE MAINTENANCE SIGNING KEY IS EPHEMERAL HERE, and deliberately left to upstream's default
# (`<repo>/.local/private-state/v2-undeployed/maintenance-key.json`, mode 0600, created on
# demand). On `stagenet` that file is mandatory, absolute and must be on DURABLE storage,
# because losing it locks a funded deployment out of every future maintenance transaction. This
# container has no durable private storage and does not want any: the contract it deploys lives
# exactly as long as the chain under it, and `./down.sh -v` destroys both together.
#
# `npm --prefix contracts/v2 run deploy` rather than the root `bun run deploy:v2`: the root
# script is only a forwarder to this one, and the 2.x runner is a NODE package (`node --import
# tsx`) whose node_modules is the only one this image carries. Calling it directly keeps the
# root 1.x tree — which this image deliberately does not install — out of the picture entirely.
MN_SEED="${SHIELDED_NIGHT_WALLET_SEED}" \
DEPLOY_OUT="${RECORD_TMP}" \
  npm --prefix contracts/v2 run deploy || die "contracts/v2 deploy failed"

[ -f "${RECORD_TMP}" ] \
  || die "the deploy reported success but wrote no record to DEPLOY_OUT (${RECORD_TMP})"

# ── publish ─────────────────────────────────────────────────────────────────
# The v2 record is a richer document than the 1.x one and it names things differently:
# `contractAddress` not `address`, `network.networkId` not `networkId`, `sourceCommit` not
# `commit`, and the wrapper metadata under `metadata`. Every consumer in this repository — the
# web entrypoint's /config.js writer, entrypoint-register-token.sh, verify-shielded-night.sh
# and docs/OPERATIONS.md — reads the FLAT names, so they are derived here once, beside the
# whole upstream record rather than instead of it. Nothing is dropped: the published file is
# the upstream record plus five flat aliases and the deployer's role.
#
# The single quotes around the bun program are REQUIRED: process.env.* must be read by bun
# inside the container process, not expanded by this shell before it ever runs.
# shellcheck disable=SC2016
DEPLOY_RECORD="${RECORD_TMP}" \
DEPLOYER_SEED_ROLE="${SHIELDED_NIGHT_ROLE:-shielded-night-deployer}" \
EXPECT_SYMBOL="${SEALED_SYMBOL}" \
EXPECT_DECIMALS="${SEALED_DECIMALS}" \
PUBLISH_TO="${PUBLISH_TMP}" \
  bun -e '
    const rec = await Bun.file(process.env.DEPLOY_RECORD).json();
    const address = rec.contractAddress ?? rec.address;
    if (typeof address !== "string" || !/^[0-9a-fA-F]{16,128}$/.test(address)) {
      console.error("deploy record carries no usable contractAddress");
      process.exit(1);
    }
    const networkId = rec.network?.networkId ?? rec.networkId;
    if (networkId !== "undeployed") {
      console.error(`deploy record says networkId=${networkId}, expected undeployed`);
      process.exit(1);
    }
    // The chain is the authority on the wrapper metadata; upstream verifyAddress() already
    // refused anything else, so a mismatch here would mean the record and the chain disagree.
    const symbol = rec.metadata?.symbol ?? rec.symbol;
    const decimals = rec.metadata?.decimals ?? rec.decimals;
    if (symbol !== process.env.EXPECT_SYMBOL || String(decimals) !== process.env.EXPECT_DECIMALS) {
      console.error(`deploy record metadata ${symbol}/${decimals} != sealed ${process.env.EXPECT_SYMBOL}/${process.env.EXPECT_DECIMALS}`);
      process.exit(1);
    }
    const merged = {
      ...rec,
      address,
      networkId,
      name: rec.metadata?.name ?? rec.name,
      symbol,
      decimals,
      commit: rec.sourceCommit ?? rec.commit,
      deployerSeedRole: process.env.DEPLOYER_SEED_ROLE,
    };
    await Bun.write(process.env.PUBLISH_TO, `${JSON.stringify(merged, null, 2)}\n`);
  ' || die "could not build the published contract record"

mv -f "${PUBLISH_TMP}" "${CONTRACT_FILE}"
rm -f "${RECORD_TMP}"
log "published ${CONTRACT_FILE}"
log "contract $(published_address || echo '<unreadable>')"

exit 0
