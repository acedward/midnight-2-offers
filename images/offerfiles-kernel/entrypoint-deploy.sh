#!/bin/bash
# offerfiles-deploy — deploy the offer-files contract ONCE per stack.
#
# THE BUG THIS EXISTS TO FIX. The old single container ran
# `midnight-contract:deploy` on every start, and that npm script is
# `midnight-contract:clean && deploy.ts`, where clean is
# `rm -f contract-offer-files.<network>.json`. So every `docker compose up -d
# --force-recreate kernel` DELETED the address and minted a brand-new contract:
# three different addresses in one day, and an order book whose identity reset
# under it. Persisting the artifact on a volume and skipping when it is present
# fixes it at the source.
#
# Idempotent by construction: the artifact's presence on ${DEPLOY_OUT} IS the
# "already deployed" flag, and that volume is compose-declared so `down.sh -v`
# takes it with the chain it belongs to. A stack whose chain was wiped but whose
# volume survived would point at a contract that no longer exists — which is why
# the volume must die with the Midnight volumes, and does.

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=deploy

load_celestia_env
run_preflight "$ROLE"

mkdir -p "$DEPLOY_OUT"

if [ -f "${DEPLOY_OUT}/${CONTRACT_FILE}" ]; then
  # Env, not argv — see the note in entrypoint-common.sh's load_contract_address.
  ADDR="$(OFFERFILES_CONTRACT_JSON="${DEPLOY_OUT}/${CONTRACT_FILE}" bun -e \
            'console.log(JSON.parse(await Bun.file(process.env.OFFERFILES_CONTRACT_JSON).text()).contractAddress)')"
  log "$ROLE" "contract already deployed for this stack — JOINING ${ADDR}"
  log "$ROLE" "(delete the offerfiles-deploy volume, or ./down.sh -v, to force a redeploy)"
else
  log "$ROLE" "no persisted contract for network ${NETWORK_ID} — deploying"
  cd "$CONTRACT_DIR"
  # MIDNIGHT_STORAGE_PASSWORD is what start.external.ts passed this process;
  # the deploy's LevelDB private-state store is encrypted with it. It is
  # transient (container-local) — only the address outlives this container.
  MIDNIGHT_STORAGE_PASSWORD="${MIDNIGHT_STORAGE_PASSWORD:-YourPasswordMy1!}" \
    bun run midnight-contract:deploy

  if [ ! -f "${CONTRACT_DIR}/${CONTRACT_FILE}" ]; then
    log "$ROLE" "FATAL: deploy reported success but wrote no ${CONTRACT_FILE}"
    exit 1
  fi

  # Publish ATOMICALLY, and publish the ADDRESS BEFORE minting. If the mint
  # fails, the contract still exists on chain and must be joined, not
  # re-deployed — writing the artifact only after a successful mint would turn
  # a non-fatal mint hiccup into a new contract on the next start.
  cp "${CONTRACT_DIR}/${CONTRACT_FILE}" "${DEPLOY_OUT}/.${CONTRACT_FILE}.tmp"
  mv "${DEPLOY_OUT}/.${CONTRACT_FILE}.tmp" "${DEPLOY_OUT}/${CONTRACT_FILE}"
  log "$ROLE" "persisted $(cat "${DEPLOY_OUT}/${CONTRACT_FILE}" | tr -d '\n ')"
fi

# Make sure the local copy is present even on the skip path — mint-test-tokens
# reads it from the package directory, not from the volume.
cp "${DEPLOY_OUT}/${CONTRACT_FILE}" "${CONTRACT_DIR}/${CONTRACT_FILE}"

# ── mint, riding this one-shot and NON-FATAL ─────────────────────────────────
# Same rule the orchestrator had: a mint hiccup must not tear the stack down.
# Tracked by its own marker rather than by the contract artifact, so a failed
# mint retries on the next start WITHOUT re-deploying the contract.
if [ -f "$MINTED_MARKER" ]; then
  log "$ROLE" "dev test tokens already minted for this stack — skipping"
else
  log "$ROLE" "minting dev test tokens (non-fatal)"
  cd "$CONTRACT_DIR"
  if MIDNIGHT_STORAGE_PASSWORD="${MIDNIGHT_STORAGE_PASSWORD:-YourPasswordMy1!}" \
       bun run mint-test-tokens.ts; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$MINTED_MARKER"
    log "$ROLE" "mint complete"
  else
    log "$ROLE" "WARNING: mint failed — continuing (non-fatal). It retries on the next start."
  fi
fi

log "$ROLE" "done"
