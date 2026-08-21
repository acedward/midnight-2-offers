# midnight-2-offers — one-command Midnight 2.x demo stack

A single Docker Compose project that brings up a complete local Midnight 2.x demo environment:

| Component | Profile | What it is |
|---|---|---|
| Midnight node + indexer + proof-server | `core` (always) | `midnight-node:2.0.0-rc.4` / `indexer-standalone:4.4.0-rc.1` / `proof-server:9.0.0-rc.5` on `CFG_PRESET=dev` (network id `undeployed`) |
| Wallet funding tooling | `core` | Genesis-prefunded NIGHT+DUST dev wallets + a CLI to fund arbitrary extra wallets |
| umbra-evm | `evm` | Ethereum JSON-RPC **read** façade over Midnight (chainId 2400) — *Phase 3, not yet implemented* |
| offer-files kernel + Celestia | `offerfiles` | zswap offer-files sync node + batcher + local Celestia devnet — *Phase 4, not yet implemented* |
| zswap-da frontend | `frontend` | React/Vite swap demo SPA — *Phase 5, not yet implemented* |

**Everything here is dev-only.** The seeds and mnemonics in this repo are the well-known Midnight
`CFG_PRESET=dev` genesis seeds. They hold value only on a throwaway local `undeployed` chain.
Never reuse them anywhere else.

## Status

This repo is being built in phases (see the plan in the organizer workspace). Implemented so far:

- [x] Phase 0 — repo scaffold
- [ ] Phase 1 — Midnight core stack
- [ ] Phase 2 — wallet funding tooling
- [ ] Phase 3 — umbra-evm (read-only JSON-RPC)
- [ ] Phase 4 — offer-files kernel + Celestia
- [ ] Phase 5 — zswap-da frontend
- [ ] Phase 6 — integration, e2e, docs

## Quickstart

```bash
cp .env.example .env     # then edit ports/tags if needed
./up.sh                  # bring up the core stack and wait for health
./verify.sh              # assert health + prefunded wallets
./down.sh -v             # tear down, wiping all volumes
```

## Layout

```
compose/    docker compose fragments, one per profile
images/     Dockerfiles for the components that ship no Docker packaging upstream
scripts/    funding + verification + wait helpers
wallets/    wallets.json — the dev wallets this stack knows about
config/     files mounted into containers (e.g. umbra-evm watch.json)
.env.example  every host port and image tag, with the Midnight-standard defaults
```

## Reference material

The research basis for this stack lives in the `midnight-ref-ai` reference checkout
(`$HOME/midnight-ref-ai/` on the machine where this was built). The load-bearing files:

### Version pinning and compose bases

| File | Why it matters |
|---|---|
| `versions/v2.0.0-rc.4.json` | The pinned triple: node `2.0.0-rc.4` / indexer `4.4.0-rc.1` / proof-server `9.0.0-rc.5`, plus the matching SDK line (midnight-js 5.0.0-beta.6, compact-runtime 0.18.0-rc.1, `@midnightntwrk/ledger-v9` 1.0.0-rc.3, compactc 0.33.0-rc.2, wallet-sdk 2.0.0-beta.2) |
| `midnight-canary/envs/docker-compose-dynamic.yml` | The compose base this stack's `compose/core.yml` derives from (healthcheck shapes, indexer env, capability drops) |
| `matrix/compose/v2.0.0-rc.4.yml` | The port-override pattern for running several stacks side by side |
| `matrix/run-slot.sh` | The model for the health-wait helpers in `scripts/lib/wait.sh` (`wait_node_rpc`, `wait_tcp`, `wait_docker_healthy`) |
| `passport/demo/mn-passport-foundations/infra/docker-compose.{yml,macos.yml}` | macOS bridge-networking override pattern; documents the indexer SPO-node gotcha |
| `v2.0.0-rc.4/midnight-node/scripts/tests/lib/wait-for-node.sh` | `chain_getFinalizedHead` / `chain_getHeader` polling used by `verify.sh` to assert finality advances |

### Wallets, funding and the token model

| File | Why it matters |
|---|---|
| `v2.0.0-rc.4/midnight-node/util/toolkit/README.md` | The `midnight-node-toolkit` CLI surface used by `scripts/fund-wallet.sh`: `generate-txs … single-tx`, `generate-txs … register-dust-address`, `show-wallet`, `dust-balance`, `show-address`, and the `MN_FETCH_CACHE` backends |
| `v2.0.0-rc.4/midnight-node/util/toolkit/src/genesis_generator.rs` | Proof that `CFG_PRESET=dev` genesis mints 50,000,000 NIGHT per output to the dev seeds and registers their DUST addresses |
| `v2.0.0-rc.4/midnight-node/scripts/genesis_wallets_test.sh` | The model for `scripts/verify-wallets.sh` (per-seed `show-wallet`, assert non-empty unshielded UTXOs) |
| `NIGHT-shielded-vs-unshielded-FINDINGS.md` | The token-model gotchas reproduced in [Token model](#token-model-gotchas): `nativeToken()` is *unshielded*, fees are DUST-only, shielded NIGHT cannot pay fees or be registered |
| `midnight-local-dev/src/{funding,wallet}.ts` | The TypeScript equivalent of the funding flow, if a JS tool is ever preferred over the toolkit container |

### Application components (Phases 3–5)

| Source | Why it matters |
|---|---|
| `acedward/UmbraDB` @ `feat/00006-json-rpc-review` (PR #7, base `evm-compat`), files `evm-rpc/METHODS.md` and `evm-rpc/logs/RUNBOOK.md` | The umbra-evm JSON-RPC surface and its env contract |
| `effectstream/zswap-offerfiles-kernel@main` — `README.md`, `.env.preview.example`, `@effectstream/midnight-contracts/midnight-env` | The kernel's `MIDNIGHT_*` env resolution and its Celestia requirement |
| `effectstream/effectstream@v-next` — `templates/zswap-da/src/config.ts` | The frontend's runtime endpoint resolution (`window.API_BASE` / `window.BATCHER_URL`) |

## Token model gotchas

*(filled in in Phase 2)*

## Known limitations

- **EVM write path is out of scope.** umbra-evm is exposed read-only: no relayer, no `RELAY_URL`,
  no `eth_sendRawTransaction`. The read surface (ports, chainId 2400, method shapes) is treated as
  a stable contract for a follow-up project that will connect an EVM wallet and sign messages
  consumed by a Compact contract.
- **Ledger v8 → v9 chains cannot be upgraded in place.** Wiping the node volume means wiping the
  indexer (and kernel / umbra-evm) state in the same breath — `./down.sh -v` does exactly that.
- **The proof-server tag `9.0.0-rc.5` is the zkir-v2 build.** Circuits compiled to zkir-v3
  (per-primitive native crypto gates) need the `9.0.0-rc.5_experimental` variant instead; set
  `PROOF_TAG` in `.env` if you hit that.
- **The indexer image is published for `linux/amd64` only** at `4.4.0-rc.1`. On Apple Silicon it
  runs under emulation (compose pins `platform: linux/amd64`); expect it to be the slowest service
  to become healthy.
