#!/usr/bin/env bash
# shielded-night-deploy — the ONE-SHOT that gives this stack its ShieldedNight contract.
#
# THE BUG THIS SERVICE EXISTS TO PREVENT is the same one images/offerfiles-kernel's deploy
# one-shot exists to prevent, and it is worth stating again because this contract's identity
# reaches further: the sNight token COLOUR is derived from the contract address. A stack that
# quietly redeployed on every `--force-recreate` would not merely change an address — every
# sNight coin anyone had already minted would become a different, unspendable token, and the
# page would show a zero balance with nothing logged anywhere.
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

require_env MN_INDEXER_URL MN_INDEXER_WS_URL MN_NODE_URL MN_PROOF_SERVER_URL \
            SHIELDED_NIGHT_WALLET_SEED

# `MN_ENV=undeployed` is the only network this profile deploys to, and it is asserted rather
# than defaulted: pointing this one-shot at preview or preprod would deploy a real contract
# with a dev seed on a network where shielded-night's own contract is already live and locked.
MN_ENV="${MN_ENV:-undeployed}"
[ "${MN_ENV}" = "undeployed" ] \
  || die "MN_ENV must be 'undeployed' in this stack (got '${MN_ENV}') — see spec 'undeployed only'"
export MN_ENV

refuse_genesis_1 "${SHIELDED_NIGHT_WALLET_SEED}" "shielded-night deployer"

mkdir -p "${CONTRACT_SHARE_DIR}"

if [ -f "${CONTRACT_FILE}" ]; then
  log "JOIN: ${CONTRACT_FILE} already exists — NOT deploying a second contract"
  log "contract $(published_address || echo '<unreadable>')"
  log "(./down.sh -v, or dropping the shielded-night-deploy volume, forces a redeploy)"
  exit 0
fi

wait_for_stack

# `deploy-and-lock.ts` is the SAME deploy plus a maintenance-committee dissolution, which is a
# ONE-WAY door. It is off by default because a throwaway devnet contract gains nothing from
# being permanently non-upgradeable, and because the verify section's on-chain-keys check reads
# the authority state either way (spec FR-016).
SCRIPT=scripts/deploy.ts
case "$(printf '%s' "${SHIELDED_NIGHT_LOCK:-false}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on)
    SCRIPT=scripts/deploy-and-lock.ts
    log "SHIELDED_NIGHT_LOCK is set: deploying AND LOCKING (irreversible)"
    ;;
esac

# The deploy record goes to a temp path ON THE SHARED VOLUME, not straight to contract.json:
# this entrypoint adds the deployer's ROLE (which upstream has no reason to know about) and
# publishes the merged record itself, atomically. Same filesystem throughout, so the final
# `mv` is a rename and never a partial copy.
RECORD_TMP="${CONTRACT_SHARE_DIR}/.deploy-record.$$.json"
PUBLISH_TMP="${CONTRACT_SHARE_DIR}/.contract.json.$$"
# shellcheck disable=SC2329  # invoked by the EXIT trap installed on the next line
cleanup() { rm -f "${RECORD_TMP}" "${PUBLISH_TMP}"; }
trap cleanup EXIT

log "no persisted contract for network ${MN_ENV} — deploying with the ${SHIELDED_NIGHT_ROLE:-shielded-night-deployer} wallet"
cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"

# SHIELDED_NIGHT_COMMIT is how the deploy record learns which revision produced it: this image
# is built from a pinned SHA and ships no .git, so upstream's `git rev-parse` fallback would
# yield null. The value is baked in by the build.
SHIELDED_NIGHT_COMMIT="$(cat /.shielded-night-commit 2>/dev/null || true)"
export SHIELDED_NIGHT_COMMIT

# `--preload /app/preload-graphql.ts` is not a nicety: without it this deploy dies at IMPORT
# time, intermittently, with `require() async module ".../graphql/index.mjs" is unsupported`
# from inside graphql-tag's UMD bundle. Importing graphql through Bun's ESM path first caches
# the resolution the later CJS require() reuses. Upstream applies the same remedy to
# scripts/verify-deployment.ts at this very pin; measured here on 2026-09-04 (questions Q30).
MN_SEED="${SHIELDED_NIGHT_WALLET_SEED}" \
DEPLOY_OUT="${RECORD_TMP}" \
CV_NAME="${SHIELDED_NIGHT_NAME:-Shielded Night}" \
CV_SYMBOL="${SHIELDED_NIGHT_SYMBOL:-sNight}" \
CV_DECIMALS="${SHIELDED_NIGHT_DECIMALS:-6}" \
  bun run --preload /app/preload-graphql.ts "${SCRIPT}" || die "${SCRIPT} failed"

[ -f "${RECORD_TMP}" ] \
  || die "the deploy reported success but wrote no record to DEPLOY_OUT (${RECORD_TMP})"

# The single quotes around the bun program are REQUIRED: process.env.* must be read by bun
# inside the container process, not expanded by this shell before it ever runs.
# shellcheck disable=SC2016
DEPLOY_RECORD="${RECORD_TMP}" \
DEPLOYER_SEED_ROLE="${SHIELDED_NIGHT_ROLE:-shielded-night-deployer}" \
PUBLISH_TO="${PUBLISH_TMP}" \
  bun -e '
    const rec = await Bun.file(process.env.DEPLOY_RECORD).json();
    if (typeof rec.address !== "string" || !/^[0-9a-fA-F]{16,128}$/.test(rec.address)) {
      console.error("deploy record carries no usable address");
      process.exit(1);
    }
    const merged = { ...rec, deployerSeedRole: process.env.DEPLOYER_SEED_ROLE };
    await Bun.write(process.env.PUBLISH_TO, `${JSON.stringify(merged, null, 2)}\n`);
  ' || die "could not build the published contract record"

mv -f "${PUBLISH_TMP}" "${CONTRACT_FILE}"
rm -f "${RECORD_TMP}"
log "published ${CONTRACT_FILE}"
log "contract $(published_address || echo '<unreadable>')"

exit 0
