#!/bin/bash
# batcher — the balancing batcher, on its own, on :3334.
#
# It genuinely stands alone, which is why it gets its own container rather than
# sharing the kernel's: checked against the branch, `packages/batcher` reads
# NO contract address (no `midnightContract` / `contractAddress` reference
# anywhere in it) and touches NO database (no `getConnection`,
# `@effectstream/db`, `DB_PORT` or `PGLITE`). Its state is a FileStorage
# directory, which compose gives it as its own volume.
#
# Its `dependsOn: [CONTRACT_DEPLOY, MINT]` in the old orchestrator config was
# never an address dependency — it is the wallet-serialization rule: two wallet
# facades bootstrapping against one Midnight node force each other's connection
# down. compose keeps exactly that ordering with
# `offerfiles-deploy: service_completed_successfully`, since the mint runs
# inside that one-shot.
#
# batcher.dev.ts, not batcher.mainnet.ts: the mainnet variant throws unless
# CELESTIA_NETWORK=mainnet, and this stack is a devnet. Both are plain
# single-process bun entrypoints — "dev" here names the target network, not a
# multi-process launcher.

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=batcher

load_celestia_env
run_preflight "$ROLE"

log "$ROLE" "starting the balancing batcher (:3334)"
exec bun run /app/packages/batcher/batcher.dev.ts
