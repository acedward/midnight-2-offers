# midnight-2-offers — one-command Midnight 2.x demo stack

A single Docker Compose project that brings up a complete local Midnight 2.x demo environment:

| Component | Profile | What it is |
|---|---|---|
| Midnight node + indexer + proof-server | `core` (always) | `midnight-node:2.0.0-rc.4` / `indexer-standalone:4.4.0-rc.1` / `proof-server:9.0.0-rc.5` on `CFG_PRESET=dev` (network id `undeployed`) |
| Wallet funding tooling | `core` | Genesis-prefunded NIGHT+DUST dev wallets + a CLI to fund arbitrary extra wallets |
| umbra-evm | `evm` | Ethereum JSON-RPC **read-only** façade over Midnight (chainId 2400): HTTP `:8545` + WS `:10021`, backed by Postgres |
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
- [x] Phase 3 — umbra-evm (read-only JSON-RPC)
- [ ] Phase 4 — offer-files kernel + Celestia
- [ ] Phase 5 — zswap-da frontend
- [ ] Phase 6 — integration, e2e, docs

## Quickstart

```bash
cp .env.example .env                  # then edit ports/tags if needed
./up.sh                               # bring up the core stack; blocks until it is usable
./up.sh --with evm                    # …plus the read-only Ethereum JSON-RPC façade
./scripts/fund-wallet.sh --all-demo   # optional: fund the demo-* wallets
./verify.sh                           # assert health + prefunded wallets (+ evm, if it is up)
./down.sh -v                          # tear down, wiping all state
```

A **profile** is a compose fragment in `compose/`, named after the profile: `--with evm` adds
`compose/evm.yml`, `--all` adds every fragment there is. `down.sh` always tears down every
fragment that exists, so a profile brought up earlier can never be orphaned.

`up.sh` returns only when the stack is genuinely usable, which is stricter than "docker says
healthy":

| Service | What is waited on | Why not the healthcheck |
|---|---|---|
| node | RPC answers `chain_getBlockHash[1]`, **and** finalized height ≥ 1 | The node answers RPC several blocks before finality moves off genesis, and in that window the toolkit refuses to build transactions (`OnlyGenesisFinalized`) |
| indexer | GraphQL v4 answers a block query | Its container healthcheck only proves the supervisor is alive — the entrypoint touches the running-file *before* launching the indexer |
| proof-server | the port accepts a TCP connection | The image has no curl/wget, and its bash sits behind a per-tag `/nix/store/<hash>…` path |
| evm-rpc (`--with evm`) | `eth_chainId` answers over HTTP, **and** the WS port completes a `101 Switching Protocols` handshake | A TCP probe of a *published* port proves nothing: docker's port proxy accepts the connection before it dials the container, so `nc -z` reports a working endpoint that refuses every client |

Default endpoints (all overridable in `.env`):

| Endpoint | URL | Profile |
|---|---|---|
| node RPC | `http://127.0.0.1:9944` | `core` |
| indexer GraphQL | `http://127.0.0.1:8088/api/v4/graphql` | `core` |
| indexer GraphQL WS | `ws://127.0.0.1:8088/api/v4/graphql/ws` | `core` |
| proof server | `http://127.0.0.1:6300` | `core` |
| **eth JSON-RPC** | `http://127.0.0.1:8545` (chainId 2400 = `0x960`) | `evm` |
| **eth WS (`eth_subscribe`)** | `ws://127.0.0.1:10021` | `evm` |

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

## umbra-evm — read-only Ethereum JSON-RPC (profile `evm`)

```bash
./up.sh --with evm      # builds the image on first use, then blocks until eth_chainId answers
./verify.sh             # the `evm` section runs automatically when the profile is up
```

Point any Ethereum tool at it:

```bash
cast chain-id                --rpc-url http://127.0.0.1:8545     # 2400
cast block-number            --rpc-url http://127.0.0.1:8545
cast balance 0x178c5bad4ded7d8455542f8e6bd667e3d986f3a0 --rpc-url http://127.0.0.1:8545
```

Or add it to MetaMask as a custom network: RPC `http://127.0.0.1:8545`, chain ID `2400`, symbol
`NIGHT`. Balances and blocks show up; sends do not (see below).

### THE SURFACE IS READ-ONLY, AND THAT IS FINAL FOR THIS PROJECT

There is no relayer, no `RELAY_URL`, and therefore no `eth_sendRawTransaction` — upstream only
registers that method when `RELAY_URL` is set, so read-only here is a property of the
configuration, not a filter bolted on top. `verify.sh` **asserts** that
`eth_sendRawTransaction` answers `-32601`, so a future accidental write path fails the build
rather than quietly appearing.

**These endpoints are reserved for a future EVM-wallet / Compact signing project**, which will
connect an EVM wallet through them to sign messages consumed by a Compact contract. Treat the
exposed surface as a stable contract: the two ports, the service names, chainId 2400, and the
method shapes documented in the source repo's `evm-rpc/METHODS.md`. Changing any of them is a
breaking change for that project, not a detail.

### What is served, and what each answer is made of

| Method(s) | Source of truth |
|---|---|
| `eth_chainId`, `net_version`, `web3_clientVersion`, `eth_gasPrice`, `eth_estimateGas`, `eth_feeHistory`, `eth_accounts` (`[]`), `eth_syncing` (`false`) | constants / config |
| `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getBlockTransactionCountBy*` | the **indexer** GraphQL v4, live |
| `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getTransactionByHash`, `eth_getTransactionReceipt` | **Postgres**, filled by `wallet-monitor` |
| `eth_getLogs`, `eth_subscribe("logs")`, ERC20 `eth_call` views | **Postgres**, filled by the contract-event ingester from `config/watch.json` |
| `eth_subscribe("newHeads")` | the indexer head (see the patch note below) |

Two consequences worth knowing before you debug something:

- **`eth_getLogs` never touches the indexer.** Log and balance reads keep working while the
  indexer is down or restarting; only the block-shaped methods fail (with `-32603`) until it is
  back. Verified: `docker kill`-ing the indexer leaves `evm-rpc` running with `restarts=0`, still
  answering `eth_chainId`/`eth_getLogs`/`eth_getBalance`, and `eth_blockNumber` plus `newHeads`
  resume on their own when it returns — no restart, no manual step.
- **`eth_getBalance` is only as good as the watch list.** It reads a Postgres table that
  `wallet-monitor` fills from the indexer's `unshieldedTransactions` subscription, per watched
  address. An address nobody watches is not an error — it reads `0x0`.

### Error policy: `-32004` vs `-32601`

The difference is load-bearing for clients, so it is asserted in `verify.sh`:

| Code | Meaning | Example |
|---|---|---|
| `-32004` | "I know this method and am deliberately not serving it" — a client can fall back | `eth_getStorageAt` (no EVM storage trie exists), `eth_newFilter` (poll `eth_getLogs` instead) |
| `-32601` | "I have never heard of this name" — a typo or a foreign namespace | `eth_thisMethodDoesNotExist`, and `eth_sendRawTransaction` on this read-only stack |

The full `-32004` list with a reason per method is in the source repo's
`evm-rpc/METHODS.md#not-implemented--32004`; every `-32004` response carries its classification
and reason in the error `data`.

### Finding a wallet's EVM address

An EVM address here is `keccak256(bech32m payload of the mn_addr)[12:32]`. It is not guessable,
so there is a tool:

```bash
./scripts/evm-address.sh --watched     # exactly what wallet-monitor is watching
./scripts/evm-address.sh --all         # every wallets/wallets.json entry
./scripts/evm-address.sh 0000000000000000000000000000000000000000000000000000000000000001
# <input>	<mn_addr>	<0x evm address>
```

Balances are **stars scaled by 10¹²** and presented as wei, so a genesis wallet's 250,000,000
NIGHT reads as `0xcecb8f27f4200f3a000000` (2.5 × 10²⁶).

### Which wallets are monitored

All seven `wallets/wallets.json` entries, out of the box, via two env vars:

| Variable | Takes | Why both |
|---|---|---|
| `EVM_WATCH_SEEDS` | comma-separated **32-byte** seeds; the monitor derives the address itself | Short, already in `.env`, and self-checking — the monitor's HD derivation was verified identical to `midnight-node-toolkit show-address` for all six seeds |
| `EVM_WATCH_ADDRESSES` | comma-separated `mn_addr` values, verbatim | The **Lace test wallet's seed is 64 bytes**, which the monitor's derivation rejects outright. Address is the only way to watch it |

The four genesis wallets report a non-zero balance within a second or two of bring-up with **no
funding step**: the indexer replays their genesis UTXOs as ordinary unshielded transactions.
Running `./scripts/fund-wallet.sh --all-demo` then brings the three `demo-*` wallets to
`0x84595161401484a000000` (10,000,000 NIGHT) and drops the faucet's balance by the same amount —
which is a nice way to watch the whole node → indexer → monitor → Postgres → RPC path work.

### Watching contract events

`config/watch.json` is `[]`, because this demo deploys no contracts. Adding an entry turns on
`eth_getLogs`, `eth_subscribe("logs")` and the ERC20 `eth_call` views for that contract; it needs
no rebuild, just a restart of `evm-rpc`. Entry shape and the two gotchas (duplicate addresses are
rejected; `decimals` defaults to **0**, not 18) are in [`config/README.md`](config/README.md).

`DEMO_TOKEN_AS_NIGHT` is deliberately left off. It makes `eth_getBalance` add an address's
Transfer-folded token balance to its native balance so MetaMask shows minted tokens as the account
number — useful only in a demo that actually deploys a token, and it conflates native with token
value.

### How the image is built

`images/umbra-evm/Dockerfile` fetches `acedward/UmbraDB` at `UMBRA_REF`
(default `feat/00006-json-rpc-review`, PR #7) and installs it — the upstream repo ships no Docker
packaging, so this is it. Three services share the one image: `evm-rpc`
(`npm run evm-rpc:all`), `wallet-monitor` (`npm run monitor:wallet`) and the one-shot
`evm-migrate` (`npx tsx tools/migrate.ts`).

- **`evm-migrate` is not optional.** `serve-all.ts` does not apply its own migrations — upstream,
  only `wallet-monitor` does — so without an explicit init step the two services race for the
  schema and `evm-rpc` dies on a missing relation whenever it wins. Both depend on it with
  `service_completed_successfully`. It is idempotent, so it re-runs as a no-op on every bring-up.
- **Docker cannot tell that a branch moved.** `UMBRA_REF` defaults to a branch name, so a rebuild
  reuses the cached fetch layer. Use `docker compose … build --no-cache evm-rpc`, or pin
  `UMBRA_REF` to a commit sha. `docker run --rm midnight-2-offers/umbra-evm:local cat
  /app/.umbra-commit` prints the commit actually baked in.
- **Two upstream defects are patched at build time** (`images/umbra-evm/patches/apply.mjs`), both
  in the `createSubscribeServer` call and both about the WebSocket surface. Neither touches the
  write path. The patcher does exact-anchor rewrites and **fails the build** if an anchor moved,
  printing it — a fuzzy patch that half-applies would be far worse than a broken build:
  1. `evm-rpc/logs/ws.ts` defaults `listen(port, host = "127.0.0.1")` and `serve-all.ts` never
     passes a host, so the WS server binds container-loopback and refuses every client. It fails
     invisibly: the published port accepts TCP (docker-proxy), the client sees only close `1006`,
     and the server logs nothing.
  2. With no `blockSource`, `newHeads` falls back to a source that can only announce blocks
     carrying a *watched contract log* — i.e. nothing at all with an empty `watch.json`. The patch
     injects a source polling the same indexer head that answers `eth_blockNumber`.

## Verifying and tearing down

```bash
./verify.sh              # node finality + indexer GraphQL + proof-server + wallets (+ evm if up)
./verify.sh --core-only  # skip the wallet checks (each spawns a toolkit container) and evm
./verify.sh --evm        # require the evm section — fail if the profile is not up
./verify.sh --no-evm     # skip the evm section even when it is up
./down.sh                # stop, keep the chain — ./up.sh resumes it
./down.sh -v             # FULL RESET: wipes node, indexer, evm-postgres and toolkit-cache volumes
```

The `evm` section runs automatically when the profile's containers exist, so `./verify.sh` needs
no argument either way. `./scripts/verify-evm.sh` runs it alone (`--quick` skips the `newHeads`
check, which waits for a block).

`down.sh -v` wipes the node volume and the indexer volume **together**, and that is a
correctness requirement rather than tidiness: a ledger v8→v9 chain cannot be upgraded in
place, so a fresh node genesis paired with a surviving indexer database gives you an indexer
serving a chain that no longer exists. The toolkit's fetch cache and the umbra-evm Postgres volume
go with them for the same reason — every one of them holds state keyed to one specific genesis.

`down.sh` always passes **every** fragment in `compose/`, so a profile you brought up earlier is
torn down even if you do not name it now. Every volume is declared in a fragment for the same
reason: only a compose-created volume carries the project label that the "nothing left behind"
count filters on.

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
  no `eth_sendRawTransaction`. **These endpoints are reserved for a future EVM-wallet / Compact
  signing project** that will connect an EVM wallet through them to sign messages consumed by a
  Compact contract, so the read surface (the two ports, service names, chainId 2400, and the method
  shapes in the source repo's `evm-rpc/METHODS.md`) is treated as a stable contract. `verify.sh`
  asserts `eth_sendRawTransaction` → `-32601` so a write path cannot appear by accident.
- **umbra-evm has no historical state and no EVM execution.** `eth_getStorageAt`, `eth_getProof`,
  `eth_call` into contract code, `eth_simulateV1` and the polling-filter family answer `-32004` by
  design — Midnight contract state is a ledger blob, not an EVM storage trie. A block tag other
  than a height or `latest`-family is accepted syntactically but there is no archival state behind
  it. `eth_getCode` returns a non-empty stub for known contract addresses, not real bytecode.
- **`eth_getBalance` only knows the wallets it is told to watch,** and reports `0x0` (not an
  error) for anything else. Reorgs are not handled either: `eth_getLogs` rows are never marked
  `removed`.
- **The umbra-evm image is built from a moving branch.** `UMBRA_REF` defaults to
  `feat/00006-json-rpc-review`, and Docker cannot detect that a branch advanced — a rebuild reuses
  the cached fetch layer until you pass `--no-cache`. Pin `UMBRA_REF` to a commit sha for a
  reproducible build; `docker run --rm midnight-2-offers/umbra-evm:local cat /app/.umbra-commit`
  reports what is actually in the image. Two upstream defects are patched during that build (the
  WS server's container-loopback bind, and `newHeads` having no chain-head source) — if upstream
  moves those lines, the build **fails loudly** and the patch anchors need re-deriving; see
  `images/umbra-evm/patches/apply.mjs`.
- **The umbra-evm image is large (~1 GB).** It installs UmbraDB's full dev dependency tree because
  `tsx` and the `@midnightntwrk/wallet-sdk-*` packages the wallet monitor imports are all
  devDependencies, and the repo is run as TypeScript rather than built. The upside is that the
  repo's own offline test suites can be run inside the image.
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
