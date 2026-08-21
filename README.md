# midnight-2-offers — one-command Midnight 2.x demo stack

A single Docker Compose project that brings up a complete local Midnight 2.x demo environment:

| Component | Profile | What it is |
|---|---|---|
| Midnight node + indexer + proof-server | `core` (always) | `midnight-node:2.0.0-rc.4` / `indexer-standalone:4.4.0-rc.1` / `proof-server:9.0.0-rc.5` on `CFG_PRESET=dev` (network id `undeployed`) |
| Wallet funding tooling | `core` | Genesis-prefunded NIGHT+DUST dev wallets + a CLI to fund arbitrary extra wallets |
| umbra-evm | `evm` | Ethereum JSON-RPC **read** façade over Midnight (chainId 2400) — *Phase 3, not yet implemented* |
| offer-files kernel + Celestia | `offerfiles` | zswap offer-files sync node + batcher + local Celestia devnet — *Phase 4, not yet implemented* |
| zswap-da frontend | `frontend` | React/Vite swap demo SPA — *Phase 5, not yet implemented* |

**Everything here is dev-only.** Every seed in this repo is public: the genesis ones are the
well-known Midnight `CFG_PRESET=dev` seeds, and the `demo-*` ones are obvious placeholders
invented here. They control value only on a throwaway local `undeployed` chain. Never reuse any
of them anywhere else.

## Status

This repo is being built in phases (see the plan in the organizer workspace). Implemented so far:

- [x] Phase 0 — repo scaffold
- [x] Phase 1 — Midnight core stack (node + indexer + proof-server)
- [x] Phase 2 — wallet funding tooling (NIGHT + DUST)
- [ ] Phase 3 — umbra-evm (read-only JSON-RPC)
- [ ] Phase 4 — offer-files kernel + Celestia
- [ ] Phase 5 — zswap-da frontend
- [ ] Phase 6 — integration, e2e, docs

## Quickstart

```bash
cp .env.example .env                  # then edit ports/tags if needed
./up.sh                               # bring up the core stack; blocks until it is usable
./scripts/fund-wallet.sh --all-demo   # optional: fund the demo-* wallets
./verify.sh                           # assert health + prefunded wallets
./down.sh -v                          # tear down, wiping all state
```

`up.sh` returns only when the stack is genuinely usable, which is stricter than "docker says
healthy":

| Service | What is waited on | Why not the healthcheck |
|---|---|---|
| node | RPC answers `chain_getBlockHash[1]`, **and** finalized height ≥ 1 | The node answers RPC several blocks before finality moves off genesis, and in that window the toolkit refuses to build transactions (`OnlyGenesisFinalized`) |
| indexer | GraphQL v4 answers a block query | Its container healthcheck only proves the supervisor is alive — the entrypoint touches the running-file *before* launching the indexer |
| proof-server | the port accepts a TCP connection | The image has no curl/wget, and its bash sits behind a per-tag `/nix/store/<hash>…` path |

Default endpoints (all overridable in `.env`):

| Endpoint | URL |
|---|---|
| node RPC | `http://127.0.0.1:9944` |
| indexer GraphQL | `http://127.0.0.1:8088/api/v4/graphql` |
| indexer GraphQL WS | `ws://127.0.0.1:8088/api/v4/graphql/ws` |
| proof server | `http://127.0.0.1:6300` |

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

## Wallets

`wallets/wallets.json` is the manifest: every wallet this stack knows about, its seed, all
its address forms, and whether it is funded by genesis or by the funding script. The
addresses there are derived from `seed + networkId` only, so they stay valid across a
`./down.sh -v` reset.

### Prefunded at genesis — nothing to run

`CFG_PRESET=dev` genesis funds these four wallets **and registers their DUST addresses**, so
they can pay fees from the first block. Verified on node 2.0.0-rc.4: 5 unshielded NIGHT UTXOs
of 50,000,000 NIGHT each (250,000,000 NIGHT total, i.e. 250,000,000,000,000 stars), 5 DUST
UTXOs, DUST balance 1.25 × 10²⁴ specks.

| Name | Seed | Role |
|---|---|---|
| `genesis-1` | `0x…0001` (32 bytes) | faucet — the default funding source for `fund-wallet.sh` |
| `genesis-2` | `0x…0002` (32 bytes) | reserved as the offer-files batcher wallet (Phase 4) |
| `genesis-3` | `0x…0003` (32 bytes) | spare prefunded wallet / second demo actor |
| `lace-test` | `a51c86de…0593ec9` (64 bytes, 128 hex chars) | the wallet Lace uses for its own testing — import this one to drive the demo from Lace |

Two things that are easy to get wrong here:

- **`0x…0004` is NOT funded.** The seed list in midnight-node's
  `scripts/genesis_wallets_test.sh` includes a fourth `0x…0004` seed, but on the published
  `CFG_PRESET=dev` genesis that wallet is empty (0 UTXOs, 0 DUST). Only 01/02/03 and the
  Lace seed are funded.
- **The Lace seed is 128 hex characters**, not 64. It is a 64-byte seed and the toolkit
  accepts it as-is wherever a `--seed` is taken.

### Funding more wallets

```bash
# fund one wallet: NIGHT + DUST registration + wait until fees are payable
./scripts/fund-wallet.sh <seed-or-address>

# fund every wallets.json entry marked funding="fund-script" (demo-alice/bob/carol)
./scripts/fund-wallet.sh --all-demo

# same thing as a one-shot compose service instead of a host script
docker compose --profile fund -f compose/core.yml run --rm fund

# assert the genesis wallets are funded and fee-capable
./scripts/verify-wallets.sh
./scripts/verify-wallets.sh --include-script-funded   # after funding the demo wallets
```

Pass a **seed** whenever you can. Given a seed the script does the whole job: sends NIGHT,
registers the DUST address, and waits for a spendable DUST UTXO. Given only an **address** it
can only send NIGHT — DUST registration is a transaction signed by the wallet's own key, so
the owner has to register before that wallet can pay a fee.

**Why the default amount is 10,000,000 NIGHT.** DUST accrues in proportion to the NIGHT
backing it, so the funded amount decides how soon the wallet can pay a fee — it is not about
the demo needing that much value. Measured on this stack: a wallet funded with **100 NIGHT**
gets its DUST UTXO immediately but still fails a transfer with
`Insufficient DUST (trying to spend 260838254857211, need 102111854857211 more)`, and would
need roughly 45 minutes of accrual to clear a single fee. Funded with **10,000,000 NIGHT** the
same wallet pays its fees as soon as the DUST UTXO appears. Lower `--amount` only if you are
prepared to wait.

## Token model gotchas

Distilled from `NIGHT-shielded-vs-unshielded-FINDINGS.md` in the reference checkout, and
confirmed against this stack.

- **`nativeToken()` returns *unshielded* NIGHT**, despite the name. `unshieldedToken()` is the
  same thing; shielded NIGHT is `shieldedToken()`.
- **Shielded and unshielded NIGHT share the same 32-zero-byte colour** and differ only by an
  enum tag (`Unshielded=0`, `Shielded=1`, `Dust=2`). You cannot tell them apart by colour, so
  filter the UTXO list by token type when you mean unshielded NIGHT.
- **Fees are paid in DUST, never in NIGHT.** `feeToken()` is `TokenType::Dust`.
- **DUST is generated by registered *unshielded* NIGHT UTXOs.** Registration
  (`register-dust-address`) respends the wallet's NIGHT UTXOs so they begin generating — which
  is why the funding script registers *after* sending NIGHT, not before.
- **Shielded NIGHT can neither pay fees nor be registered for DUST.** It is contract-spendable
  value only. `fund-wallet.sh --shielded-amount` exists for that purpose and warns accordingly.
- **DUST readiness is a non-empty `dust_utxos` list, not `dust-balance.total > 0`.** After a
  registration the balance figure moves before a spendable UTXO exists; a wallet with balance
  and no UTXO cannot pay anything. Both the funding script and `verify-wallets.sh` assert the
  UTXO.
- Units: 1 NIGHT = 10⁶ stars; 1 DUST = 10¹⁵ specks.

## Verifying and tearing down

```bash
./verify.sh              # node finality + indexer GraphQL + proof-server + wallets
./verify.sh --core-only  # skip the wallet checks (each spawns a toolkit container)
./down.sh                # stop, keep the chain — ./up.sh resumes it
./down.sh -v             # FULL RESET: wipes node, indexer and toolkit-cache volumes
```

`down.sh -v` wipes the node volume and the indexer volume **together**, and that is a
correctness requirement rather than tidiness: a ledger v8→v9 chain cannot be upgraded in
place, so a fresh node genesis paired with a surviving indexer database gives you an indexer
serving a chain that no longer exists. The toolkit's fetch cache goes with them for the same
reason.

## Running two stacks at once

Every host port and the compose project name come from the env file, and no service addresses
another by a host port — they talk over the compose network on fixed container ports. So a
second, fully independent stack is just a second env file:

```bash
./scripts/pick-ports.sh > .env.test   # random project name + a free port block >= 10100
ENV_FILE=.env.test ./up.sh
ENV_FILE=.env.test ./verify.sh
ENV_FILE=.env.test ./down.sh -v       # leaves the other stack untouched
```

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
- **A healthy stack is not immediately transactable.** The node answers RPC and produces blocks
  several seconds before finality moves off genesis, and until it does the toolkit refuses to
  build transactions (`OnlyGenesisFinalized`). `up.sh` waits for finalized height ≥ 1 so this is
  handled, but anything else that transacts right after bring-up needs the same gate.
- **Upstream toolkit bug, worked around here:** `midnight-node-toolkit:2.0.0-rc.4` panics on its
  first chain command against an empty fetch cache
  (`redb_backend.rs … failed to create database: … NotFound`), while still leaving a usable cache
  file behind so the next call succeeds. The scripts prime the cache with a throwaway query
  (`toolkit_warmup`); without that the panic would land on the first funding transaction. Drop
  the workaround when a fixed toolkit ships.
- **`toolkit version` under-reports.** It prints `Ledger: =7.0.3` / `Compactc: 0.31.0` for a
  toolkit that transacts happily against a ledger-v9 chain, so only its `Node:` line is used as a
  compatibility signal.
