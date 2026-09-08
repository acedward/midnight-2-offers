#!/usr/bin/env bash
# faucet-verify — the READ-ONLY verification of the six deployed issuers.
#
# NO SEED, and that is the point rather than an omission: upstream's `verify` command needs the
# node and the indexer and nothing else. It compares every local verifier key with chain state,
# rejects missing or extra circuits, checks the immutable name/symbol/decimals/domain metadata,
# re-derives each token ID from the final contract address, hashes the managed artifact tree,
# validates the embedded compiler/runtime metadata, proves the recorded source paths match the
# recorded Git commit, requires the current maintenance authority to match, and re-queries the
# original ContractDeploy action at the recorded height to match its canonical transaction
# hash, block height and block hash.
#
# It runs TWICE in the life of a stack, on purpose:
#   * at bring-up, as a one-shot compose gates the faucet site on — so a deploy that succeeded
#     and a chain that then disagreed with it cannot be reported as a working profile;
#   * from ./verify.sh --faucet, freshly, so `./verify.sh` is a real check at verify time
#     rather than a replay of a container that exited an hour ago.
#
# A container that carries a seed variable it does not need is a container that can leak one.
# This entrypoint therefore does not read FAUCET_DEPLOYER_SEED at all, and compose does not
# hand it one.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=faucet-verify
# shellcheck source=images/mint-test-tokens/entrypoint-common.sh
. /usr/local/lib/mint-test-tokens/entrypoint-common.sh

require_env MN_NODE_URL MN_INDEXER_URL MN_INDEXER_WS_URL

MN_NETWORK="${MN_NETWORK:-undeployed}"
[ "${MN_NETWORK}" = "undeployed" ] \
  || die "MN_NETWORK must be 'undeployed' in this stack (got '${MN_NETWORK}')"
export MN_NETWORK
export MN_METADATA_OUTPUT_DIR="${REGISTRY_DIR}"

[ -f "${REGISTRY_FILE}" ] \
  || die "no ${REGISTRY_FILE} — faucet-deploy must complete first"

summary="$(registry_summary)" || die "could not read ${REGISTRY_FILE}"
log "registry status=${summary% *} active=${summary#* }"

# The node and the indexer only: this command proves nothing and needs no prover. Naming the
# proof server here would make a verify fail on a service it does not use.
wait_node_block "${MN_NODE_URL}" 1 "${NODE_BLOCK_TIMEOUT_S:-600}" \
  || die "midnight-node produced no block"
wait_http "${MN_INDEXER_URL}" "indexer" "${INDEXER_WAIT_TIMEOUT_S:-300}" \
  || die "indexer never answered"

cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"

log "verifying the six issuers against the chain (read-only, no wallet)"
npm --prefix contracts/v2 run verify || die "contracts/v2 verify failed"

log "OK: six issuers verified — on-chain verifier keys, immutable metadata, derived token IDs,"
log "    artifact digests, pinned source revision, deploy action and block evidence all match"
exit 0
