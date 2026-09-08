#!/usr/bin/env bash
# faucet-mint-test — prove a real mint from the deployed issuers, without a browser.
#
# WHY THIS EXISTS AND NOT A BROWSER CLICK. The faucet site discovers DApp Connector API 4.x
# wallets (`@midnight-ntwrk/dapp-connector-api@4.0.1`): it has NO in-page wallet, it delegates
# proving to the connected wallet and submits the exact bytes that wallet balanced. So a
# browser with no injected `window.midnight` extension — which is every browser this stack can
# drive automatically — can load the page, select `undeployed` and read the registry, but it
# cannot mint. That is a property of the upstream site, not a gap in this profile, and it is
# recorded in docs/KNOWN-LIMITATIONS.md.
#
# The mint is therefore proved by upstream's OWN runner, `contracts/v2/mint-wallet-test.ts`,
# which mints each selected token to a SECOND wallet and waits for that wallet to discover the
# balance through its regular chain scan — i.e. it proves the encrypted-output path a real
# wallet depends on, not merely that a transaction was accepted.
#
# NEVER STARTED BY up.sh. It carries a compose `profiles:` key, because six mints are six
# proofs and a `--all` bring-up must not spend minutes on evidence nobody asked for. Run it
# deliberately, or through `./scripts/verify-faucet.sh --mint`.
#
# MN_SKIP_RECIPIENT_SPEND=1 BY DEFAULT. Upstream's runner otherwise has the recipient send the
# coins back, which needs the recipient to hold DUST — a second funded wallet, a second fee,
# and a longer proof cycle for a claim (that a minted coin is spendable) the mint itself does
# not make. The one-shot funds nothing: the DEPLOYER pays every fee, exactly as it did for the
# deployment, and the recipient only receives.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=faucet-mint-test
# shellcheck source=images/mint-test-tokens/entrypoint-common.sh
. /usr/local/lib/mint-test-tokens/entrypoint-common.sh

require_env MN_NODE_URL MN_NODE_WS_URL MN_INDEXER_URL MN_INDEXER_WS_URL MN_PROOF_SERVER_URL \
            FAUCET_DEPLOYER_SEED FAUCET_MINT_RECIPIENT_SEED

MN_NETWORK="${MN_NETWORK:-undeployed}"
[ "${MN_NETWORK}" = "undeployed" ] \
  || die "MN_NETWORK must be 'undeployed' in this stack (got '${MN_NETWORK}')"
export MN_NETWORK

[ "${FAUCET_DEPLOYER_SEED}" != "${FAUCET_MINT_RECIPIENT_SEED}" ] \
  || die "the mint recipient seed must differ from the deployer's — a wallet cannot prove a mint to itself is discoverable"

[ -f "${REGISTRY_FILE}" ] \
  || die "no ${REGISTRY_FILE} — faucet-deploy must complete first"

# UPSTREAM READS THE REGISTRY FROM THE REPOSITORY PATH, not from MN_METADATA_OUTPUT_DIR:
# mint-wallet-test.ts does `resolve(root, "metadata", "metadata.<network>.json")`. So this
# stack's published registry is copied into place first. The destination is gitignored
# (`**/metadata.undeployed.json`) and is not one of the four declared source/artifact paths, so
# it cannot dirty the provenance the deploy and verify runners check.
mkdir -p "${REPO_ROOT}/metadata"
cp -f "${REGISTRY_FILE}" "${REPO_ROOT}/metadata/metadata.${MN_NETWORK}.json"
log "copied ${REGISTRY_FILE} -> ${REPO_ROOT}/metadata/metadata.${MN_NETWORK}.json (upstream reads it there)"

MN_SEED_FILE="$(write_seed_file FAUCET_DEPLOYER_SEED "${FAUCET_SEED_PATH:-/run/faucet/deployer-seed.hex}")"
MN_RECIPIENT_SEED_FILE="$(write_seed_file FAUCET_MINT_RECIPIENT_SEED "${FAUCET_RECIPIENT_SEED_PATH:-/run/faucet/recipient-seed.hex}")"
export MN_SEED_FILE MN_RECIPIENT_SEED_FILE
# shellcheck disable=SC2329  # invoked by the EXIT trap installed on the next line
cleanup() { rm -f "${MN_SEED_FILE}" "${MN_RECIPIENT_SEED_FILE}"; }
trap cleanup EXIT

export MN_SKIP_RECIPIENT_SPEND="${MN_SKIP_RECIPIENT_SPEND:-1}"

wait_for_stack

cd "${REPO_ROOT}" || die "no ${REPO_ROOT}"

if [ -n "${MN_TOKEN_SYMBOL:-}" ]; then
  log "minting ${MN_TOKEN_SYMBOL} to the recipient wallet (skip-spend=${MN_SKIP_RECIPIENT_SPEND})"
else
  log "minting ALL SIX tokens to the recipient wallet (skip-spend=${MN_SKIP_RECIPIENT_SPEND})"
  log "  set MN_TOKEN_SYMBOL to mint exactly one"
fi
npm --prefix contracts/v2 run test:wallet || die "contracts/v2 mint-wallet-test failed"

log "OK: mint proved — each selected token was minted and DISCOVERED by a second wallet"
exit 0
