#!/usr/bin/env bash
# faucet-deploy — the ONE-SHOT that gives this stack its six local test-token issuers.
#
# WHAT IT RUNS: upstream's own `npm --prefix contracts/v2 run deploy`, unpatched. Everything
# below is configuration, readiness and the ONE thing a container has to do that a laptop does
# not — turn an environment variable into the private seed FILE the runner insists on.
#
# ─── IT IS RESUMABLE, and that is upstream's property, not ours ──────────────
# The runner derives a stack identity from the node's chain name, runtime version and genesis
# hash, journals every deployment intent BEFORE submitting, and re-verifies a recorded contract
# (complete on-chain verifier-key set, immutable metadata, derived token ID) instead of
# deploying a replacement. So a second `./up.sh` on a live stack VERIFIES the six issuers and
# republishes nothing; a `./down.sh -v` wipes both the registry and the journal volumes, the
# chain identity changes with them, and the next bring-up deploys afresh.
#
# The one case it will NOT resolve on its own is a registry from a DIFFERENT chain identity
# left beside a new chain: it marks that registry stale and stops, because silently replacing a
# recorded deployment is how a token ID that somebody already holds becomes unspendable. The
# remedy is an explicit MN_REDEPLOY_STALE=1 rerun after the operator has confirmed the reset —
# and since `./down.sh -v` removes the volume, the normal reset path never needs it.
#
# ─── IT DOES NOT FUND ITSELF ────────────────────────────────────────────────
# compose gates this service on `faucet-fund`, a toolkit one-shot that gives the deployer
# wallet NIGHT and a registered DUST address first. That is not politeness: `deploy.ts` calls
# `wallet.start(true)` with `faucet: undefined`, and testkit 5's waitForFunds() only contacts a
# faucet when one is CONFIGURED — so on this stack it makes no funding request at all, it only
# registers DUST for NIGHT the wallet already holds. It then requires positive synchronized
# DUST before it will write a deployment intent. An unfunded deployer therefore fails here as a
# timeout deep inside wallet synchronization, naming none of this.
#
# ─── THE SEED NEVER TOUCHES A LAYER OR A VOLUME ─────────────────────────────
# docs/registry.md: the runner accepts a master seed ONLY through a private file, owner-only,
# outside the repository. compose mounts a tmpfs at /run/faucet and this entrypoint writes the
# file there with umask 077 — RAM only, gone when the container exits, in no image layer, in no
# named volume, and in nothing `docker commit` could capture.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=faucet-deploy
# shellcheck source=images/mint-test-tokens/entrypoint-common.sh
. /usr/local/lib/mint-test-tokens/entrypoint-common.sh

require_env MN_NODE_URL MN_NODE_WS_URL MN_INDEXER_URL MN_INDEXER_WS_URL MN_PROOF_SERVER_URL \
            FAUCET_DEPLOYER_SEED

# `undeployed` is the only network this profile deploys to, and it is ASSERTED rather than
# defaulted: pointing this one-shot at stagenet would deploy six issuer contracts with a public
# dev seed onto a network where mint-test-tokens' own registry is already published.
MN_NETWORK="${MN_NETWORK:-undeployed}"
[ "${MN_NETWORK}" = "undeployed" ] \
  || die "MN_NETWORK must be 'undeployed' in this stack (got '${MN_NETWORK}')"
export MN_NETWORK

export MN_METADATA_OUTPUT_DIR="${REGISTRY_DIR}"
mkdir -p "${MN_METADATA_OUTPUT_DIR}"

# The seed file: tmpfs, 0600, written from the environment, refused if it is a genesis seed.
MN_SEED_FILE="$(write_seed_file FAUCET_DEPLOYER_SEED "${FAUCET_SEED_PATH:-/run/faucet/deployer-seed.hex}")"
export MN_SEED_FILE
# shellcheck disable=SC2329  # invoked by the EXIT trap installed on the next line
cleanup() { rm -f "${MN_SEED_FILE}"; }
trap cleanup EXIT
log "deployer seed rendered to ${MN_SEED_FILE} (tmpfs, 0600) from FAUCET_DEPLOYER_SEED"

# A ready registry for THIS chain is the "already deployed" state, and it is reported before
# anything is waited on so the log says which of the two paths this run is taking.
if summary="$(registry_summary 2>/dev/null)"; then
  log "existing ${REGISTRY_FILE}: status=${summary% *} active=${summary#* }"
  log "  the runner will VERIFY these against the chain rather than deploy replacements"
else
  log "no registry at ${REGISTRY_FILE} yet — this is a first deployment for this volume"
fi

wait_for_stack

cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"

# SOURCE_REVISION is left UNSET on purpose. The runner then resolves `git rev-parse HEAD`,
# which in this image is the pinned commit by construction, and proves every declared
# source/artifact path matches it byte-for-byte. Passing a value here would only create a
# second place for the pin to be written down.
log "deploying the six issuers (MN_NETWORK=${MN_NETWORK}, output ${MN_METADATA_OUTPUT_DIR})"
log "  node ${MN_NODE_URL} · indexer ${MN_INDEXER_URL} · prover ${MN_PROOF_SERVER_URL}"
npm --prefix contracts/v2 run deploy || die "contracts/v2 deploy failed"

summary="$(registry_summary)" || die "the deploy reported success but published no readable registry"
status="${summary% *}"
active="${summary#* }"
[ "${status}" = "ready" ] || die "${REGISTRY_FILE} is '${status}', expected 'ready'"
[ "${active}" = "6" ] || die "${REGISTRY_FILE} has ${active} active deployments, expected 6"

log "OK: ${REGISTRY_FILE} is ready with 6 active deployments"
exit 0
