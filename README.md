# midnight-2-offers — one-command Midnight 2.x demo stack

A single Docker Compose project that brings up a complete local Midnight 2.x demo environment:

| Component | Profile | State | What it is |
|---|---|---|---|
| Midnight node + indexer + proof-server | `core` (always) | **shipped** | `midnight-node:2.0.0-rc.4` / `indexer-standalone:4.4.0-rc.1` / `proof-server:9.0.0-rc.5` on `CFG_PRESET=dev` (network id `undeployed`) |
| Wallet funding tooling | `core` | **shipped** | Genesis-prefunded NIGHT+DUST dev wallets, three Lace-importable mnemonic wallets, and a CLI to fund arbitrary extra ones |
| umbra-evm | `evm` | **shipped** | Ethereum JSON-RPC **read-only** façade over Midnight (chainId 2400): HTTP `:8545` + WS `:10021`, backed by Postgres |
| Celestia DA devnet | `offerfiles` | **shipped** | Local single-node Celestia (consensus + bridge), DA JSON-RPC `:26658`, funded bridge wallet, blob round trip verified |
| offer-files kernel + batcher | `offerfiles` | **shipped** | zswap offer-files sync node `:9999` and balancing batcher `:3334` as separate services, with a deploy one-shot that lands the contract once per stack |
| zswap-da frontend | `frontend` | **shipped** (needs the local template checkout) | React/Vite make→take swap SPA `:10600` |
| AA Manager + Minter | `aa` | **shipped** | one-shot deploy + mint; internal `_experimental` proof server; receipt in the `aa-out` volume |

**Everything here is dev-only.** Every seed and mnemonic in this repo is public: the genesis
ones are the well-known Midnight `CFG_PRESET=dev` seeds, the `demo-*` ones are obvious
placeholders invented here, and the mnemonics (see [Import into Lace](#import-into-lace)) are
repeated-word BIP-39 test phrases. They control value only on a throwaway local `undeployed`
chain. Never reuse any of them anywhere else.

## What is and is not in this release

**In**: the Midnight 2.x core stack, the wallet story (genesis-prefunded wallets, a funding
CLI, and mnemonics you can type into Lace), the read-only Ethereum JSON-RPC façade, and the
local Celestia DA devnet. `./up.sh --all && ./verify.sh` exercises all of it.

**Also in, since the ledger-v9 migration shipped upstream (2026-08-25)**: the offer-files
**kernel + batcher** (the rest of the `offerfiles` profile — sync node `:9999`, balancing
batcher `:3334`, one-shot contract deploy + dev-token mint at bring-up) and the **`frontend`
profile** (the zswap-da make→take swap SPA on `:10600`). They were previously blocked on the
`@effectstream/*` ledger-v8 → ledger-v9 migration; that migration published as
`@effectstream/*@0.200.1` + `@effectstream/mip-zswap-offer@0.4.0-v9.0`, and the kernel's own
migration rides branch `00001-ledger-v9` of `effectstream/zswap-offerfiles-kernel`, which is
what `images/offerfiles-kernel/Dockerfile` builds.

**One caveat — the frontend build needs a local checkout.** The zswap-da template's ledger-v9
migration is not published anywhere (upstream `effectstream/effectstream@templates/zswap-da` is
frozen on ledger-v8), so `images/zswap-da/Dockerfile` consumes it as a local build context —
`ZSWAP_DA_TEMPLATE_DIR`, defaulting to a sibling checkout. Without it, `--with frontend` fails
at build with a clear error while every other profile is unaffected.

**The `aa` profile deploys the AA contracts and mints a token.** `--with aa` deploys
[`acedward/AA-midnight-evm-experiment-v3`](https://github.com/acedward/AA-midnight-evm-experiment-v3)'s
Manager (the account-abstraction custody contract) and test Minter on the demo chain at
bring-up, then proves two mint calls (one shielded colour, one unshielded) and writes the
receipt — addresses, colours, tx ids — to the `aa-out` volume as `aa-contracts.json`
(`./scripts/verify-aa.sh` reads it back; `verify.sh` gains an `aa` section). Two design
points worth knowing: the contracts are compiled with `--feature-zkir-v3` (the Manager is
keccak/EIP-712-heavy), so the profile runs its **own internal
`proof-server:9.0.0-rc.5_experimental`** next to the plain core one rather than flipping
`PROOF_TAG` for everything; and the Manager's 1.1 GB `execute.prover` key is deliberately
NOT in the image — deploying needs only verifier keys, and bring-up never calls `execute`.
The one-shot is idempotent across `up` runs and its state dies with `down.sh -v`.

**The `aa` profile also serves the AA web console** at `http://127.0.0.1:10700`
(`AA_CONSOLE_HOST_PORT`): a page where **any injected browser EVM wallet** (MetaMask, Rabby, …)
drives the AA path — register an account, fund it, transfer between accounts, withdraw. The
browser holds no Midnight wallet and no prover: it signs `eth_signTypedData_v4` requests that
the console's relay builds with the AA repo's own EIP-712 codec, and the relay recovers the
signer's secp256k1 point from the signature (the `pk` argument `execute` needs — no EVM wallet
exposes it), proves the k=19 `execute` through the profile's internal proof server (~2 min per
operation; the page shows the live job log) and submits, paying fees from its own relay wallet
(`aa-console` in `wallets/wallets.json`, funded automatically by `up.sh` — unshielded NIGHT +
DUST only, deliberately shielded-free). The console's image variant keeps the 1.1 GB
`execute.prover` the deploy image prunes (`midnight-2-offers/aa-contracts:console`).
`AA_CONSOLE_DEV_SIGNER=1` enables a built-in test signer for wallet-less CI runs; leave it off
otherwise. The one-time withdraw limitation is GONE: the node's `Custom error: 214` (a
recipient-encoding defect in the Manager) was fixed upstream in
[AA PR #10](https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/10) — pin `AA_REF`
at or past its merge (`713a2021…`; key-breaking, so redeploy the contracts) and withdraw lands
like every other operation. Withdraws go to a 32-byte user address only (`recipientKind 0`);
the contract now refuses contract-recipient payout shapes by design.

**The console's Swap panel publishes real offer files.** An `OpenSwapShielded` action (signed by
the browser wallet like every other op) is proven as a Manager `execute` and then **never
submitted**: the proven transaction is unbalanced by exactly +give/−want, which makes it the
offer itself — encoded as a MIP-0005 `swapoffer1…` blob and `POST`ed to the offer-files kernel
(`--with offerfiles` required; the panel degrades gracefully without it). The demo pair is
give = the demo token's shielded colour, want = **shielded NIGHT** (any wallet can obtain it via
`fund-wallet.sh <seed> --shielded-amount <n>` and settle the offer with the kernel's own
`api-examples/11-settle-offer.ts` flow). Two switches make this work, both ON in the demo and
OFF upstream by default: `ALLOW_CONTRACT_MAKER_OFFERS` (kernel-side — contract-maker offers
cannot pass `wellFormed` against the kernel's blank reference state, so the exact
missing-contract failure retries without contract-proof verification; native zswap proofs and
signatures are always verified, and the node verifies the contract proof at settlement) and
`AA_OFFER_ALLOW_FALLIBLE` (console-side — the v5 Manager's k=19 transcript exceeds the ledger's
guaranteed-section budget, so every AA offer's legs sit in the fallible section; measured live:
a foreign taker settles them anyway, ledger-exact). Each blob is also saved under the `aa-out`
volume at `/aa/out/offers/<offerId>.swapoffer`.

**Offer history is in-memory (by design).** The kernel stores its offer book in PGLite inside
the container: restarting or recreating the `kernel` container resets the indexed offers, while
the chain keeps the settled state — the book is re-indexed from genesis on the next start. A
demo edge case, not a bug.

**The contract, however, no longer moves.** The `offerfiles` profile is three services, not one:
`offerfiles-deploy` (a one-shot that deploys the offer-files contract **once per stack** and
persists its address on a volume), `kernel` (the sync node `:9999` plus its embedded PGLite),
and `batcher` (the balancing batcher `:3334`, on its own). Before this split everything ran
under one dev orchestrator, and the contract deploy re-ran on every container recreate — its
script begins by deleting the address file, so a `--force-recreate` silently minted a **new
contract** and reset the book's identity. Now a recreate rejoins the existing contract; only the
projection rebuilds. `./down.sh -v` drops the address along with the chain it belongs to, which
is when a fresh deploy is correct.

Practical consequences: `kernel` and `batcher` restart independently of each other, and
`docker compose logs batcher` is the batcher's log alone rather than six processes interleaved.

## Quickstart

```bash
cp .env.example .env                  # then edit ports/tags if needed
./up.sh                               # bring up the core stack; blocks until it is usable
./up.sh --with evm                    # …plus the read-only Ethereum JSON-RPC façade
./up.sh --with offerfiles             # …plus Celestia DA + the offer-files kernel & batcher
./up.sh --with aa                     # …plus the AA Manager + Minter, deployed + a token minted
./up.sh --with frontend               # …plus the swap UI (needs the local template checkout)
./up.sh --all                         # …every profile: core + evm + offerfiles + frontend
./up.sh --converge                    # back to core only: stop the optional profiles
./scripts/fund-wallet.sh --all-demo   # optional: fund the demo-* and mnemonic-* wallets
./verify.sh                           # assert health + prefunded wallets (+ evm, if it is up)
./down.sh -v                          # tear down, wiping all state
```

Or the whole chain in one command, on ports that cannot collide with anything else on the
machine — this is what CI runs, and it is the fastest way to check a change:

```bash
./scripts/ci-check.sh                 # pick free ports → up --all → fund → verify → down -v
```

A **profile** is a compose fragment in `compose/`, named after the profile: `--with evm` adds
`compose/evm.yml`, `--all` adds every fragment there is. There is no compose `profiles:` key
involved, so the fragment's filename *is* the profile name — and a `--with` name with no
fragment behind it is an **error**, not a no-op, because a silently-ignored `--with` gives you a
bare core stack that fails much later with `no such service`. `down.sh` always tears down every
fragment that exists, so a profile brought up earlier can never be orphaned.

**`--with` is additive**: a profile that already has containers in this compose project is folded
back into the bring-up, so adding one profile never stops another. `up.sh` names what it carried
over on every run (`kept  already up, so left running: evm`). The explicit way to go the other
direction is **`--converge`**, which brings up exactly core + the profiles you name and stops the
rest — naming each one before it does it. So `./up.sh --converge --with evm` is "evm and nothing
else", `./up.sh --converge` is "core alone", and `./down.sh` is still the way to stop everything.
Orphan cleanup is untouched either way: a container whose service is no longer declared by any
fragment is still removed.

`up.sh` returns only when the stack is genuinely usable, which is stricter than "docker says
healthy":

| Service | What is waited on | Why not the healthcheck |
|---|---|---|
| node | RPC answers `chain_getBlockHash[1]`, **and** finalized height ≥ 1 | The node answers RPC several blocks before finality moves off genesis, and in that window the toolkit refuses to build transactions (`OnlyGenesisFinalized`) |
| indexer | GraphQL v4 answers a block query | Its container healthcheck only proves the supervisor is alive — the entrypoint touches the running-file *before* launching the indexer |
| proof-server | the port accepts a TCP connection | The image has no curl/wget, and its bash sits behind a per-tag `/nix/store/<hash>…` path |
| evm-rpc (`--with evm`) | `eth_chainId` answers over HTTP, **and** the WS port completes a `101 Switching Protocols` handshake | A TCP probe of a *published* port proves nothing: docker's port proxy accepts the connection before it dials the container, so `nc -z` reports a working endpoint that refuses every client |

## Endpoints

Default URLs, all overridable in `.env`:

| Endpoint | URL | Profile |
|---|---|---|
| node RPC (HTTP + WS) | `http://127.0.0.1:9944` | `core` |
| indexer GraphQL v4 | `http://127.0.0.1:8088/api/v4/graphql` | `core` |
| indexer GraphQL WS | `ws://127.0.0.1:8088/api/v4/graphql/ws` | `core` |
| proof server | `http://127.0.0.1:6300` | `core` |
| **eth JSON-RPC** | `http://127.0.0.1:8545` (chainId 2400 = `0x960`) | `evm` |
| **eth WS (`eth_subscribe`)** | `ws://127.0.0.1:10021` | `evm` |
| **Celestia DA JSON-RPC** | `http://127.0.0.1:26658` (bearer token required) | `offerfiles` |
| **AA web console** | `http://127.0.0.1:10700` | `aa` |

`/api/v3/graphql` on the indexer aliases v4, so a client pinned to the v3 path still works.

## Port map

Two things this table settles: which host ports you need free, and the fact that **no service
addresses another by a host port**. Containers talk over the compose network on fixed container
ports, so remapping the host side cannot break the stack's internals — which is what makes two
stacks on one machine possible.

| Host port (`.env` var) | Default | Container | Service | Who dials it | Profile |
|---|---|---|---|---|---|
| `NODE_HOST_PORT` | 9944 | 9944 | `node` | you, Lace, the toolkit, kernel (later) | `core` |
| `INDEXER_HOST_PORT` | 8088 | 8088 | `indexer` | you, Lace, `evm-rpc` (via `indexer:8088`) | `core` |
| `PROOF_HOST_PORT` | 6300 | 6300 | `proof-server` | you, the **host browser** when proving | `core` |
| — (not published) | — | 5432 | `evm-postgres` | `evm-rpc`, `wallet-monitor` | `evm` |
| `EVM_RPC_HOST_PORT` | 8545 | 8545 | `evm-rpc` | MetaMask, `cast`, `viem` | `evm` |
| `EVM_WS_HOST_PORT` | 10021 | 10021 | `evm-rpc` | `eth_subscribe` clients | `evm` |
| `CELESTIA_HOST_PORT` | 26658 | 26658 | `celestia` (bridge node) | the kernel's DA reads/writes, `verify.sh` | `offerfiles` |
| — (not published) | — | 26657 | `celestia` (consensus RPC) | the bridge, over container-loopback | `offerfiles` |
| — (not published) | — | 9090 | `celestia` (consensus gRPC) | the bridge, over container-loopback | `offerfiles` |
| `KERNEL_HOST_PORT` | 9999 | 9999 | `kernel` (sync node API) | the frontend's order book + ZK assets, `verify.sh` | `offerfiles` |
| `BATCHER_HOST_PORT` | 3334 | 3334 | `batcher` (own service) | the frontend's `send-input` | `offerfiles` |
| `FRONTEND_HOST_PORT` | 10600 | 10600 | `frontend` (nginx) | your browser | `frontend` |
| `AA_CONSOLE_HOST_PORT` | 10700 | 8090 | `aa-console` (web console + relay) | your browser | `aa` |

`BIND_ADDR` (default `127.0.0.1`) is the interface every published port binds to. Leave it as
loopback on a shared machine; set it to `0.0.0.0` only when a browser on another host has to
reach the stack.

**The defaults are the Midnight-standard ports on purpose.** Lace's `undeployed` preset
hardcodes 9944 / 8088 / 6300, so a Lace demo has to keep them. On a shared machine, generate a
block above 10100 instead:

```bash
./scripts/pick-ports.sh > .env.test    # random project name + a free 16-port block
ENV_FILE=.env.test ./up.sh --all
```

That block is laid out at fixed offsets from its base, which is worth knowing when reading a CI
log: base+0 node, +1 indexer, +2 proof-server, +3 evm RPC, +4 evm WS, +5 kernel, +6 batcher,
+7 Celestia, +8 frontend, +9 AA console.

## Layout

```
compose/    docker compose fragments, one per profile
images/     Dockerfiles for the components that ship no Docker packaging upstream
scripts/    funding, verification, port-picking, and the ci-check entrypoint
wallets/    wallets.json — the dev wallets this stack knows about
tools/      standalone helpers (mnemonic-wallets/ — mnemonic → Lace address derivation)
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
| `matrix/run-slot.sh` | The model for the health-wait helpers in `scripts/lib/common.sh` (`wait_node_rpc`, `wait_tcp`, `wait_compose_healthy`) |
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

### Application components

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
| `genesis-2` | `0x…0002` (32 bytes) | reserved as the offer-files batcher wallet, for when that profile lands |
| `genesis-3` | `0x…0003` (32 bytes) | spare prefunded wallet / second demo actor |
| `lace-test` | `a51c86de…0593ec9` (64 bytes, 128 hex chars) | Midnight's own canonical test wallet — **importable into Lace from a mnemonic, see below** |

Two things that are easy to get wrong here:

- **`0x…0004` is NOT funded.** The seed list in midnight-node's
  `scripts/genesis_wallets_test.sh` includes a fourth `0x…0004` seed, but on the published
  `CFG_PRESET=dev` genesis that wallet is empty (0 UTXOs, 0 DUST). Only 01/02/03 and the
  Lace seed are funded.
- **The Lace seed is 128 hex characters**, not 64. It is a 64-byte seed and the toolkit
  accepts it as-is wherever a `--seed` is taken. It is 64 bytes because it is a **BIP-39
  master seed**, not an arbitrary secret — which is exactly what makes it importable into
  Lace (see [Import into Lace](#import-into-lace)).

### Funded by one command, not by genesis

The other three entries start empty and are brought to 10,000,000 NIGHT + spendable DUST by
`./scripts/fund-wallet.sh --all-demo`. They exist so a demo can move value between named
actors without touching the faucet wallet, and **all three are Lace-importable**: each one is
addressed by a BIP-39 mnemonic, so you can type it into a wallet GUI, while its 64-byte master
seed is what you paste into the scripts.

| Name | Mnemonic | BIP-39 master seed (paste into scripts) |
|---|---|---|
| `demo-alice` | `alpha` ×23 + `avoid` | `0a4f358d27c85cc3063c73fe002e9f933722aad5bc009799805946cc5a9e7272f249189587fe0254c6d18b5bc1a24f60617bc62f07c5b57343b0fddf8e680d96` |
| `demo-bob` | `boss` ×23 + `burst` | `1ce2d940e5a46775697fa7878627fbd689b5e6e73c7e32b82ed01468b07534288f9b74cbcd116b75a3f854315accdf39f87d075bd74a23eaf4910d95e7629095` |
| `demo-carol` | `cactus` ×23 + `cherry` | `fc14ae819b1a9ace2304c5cf960596741fccd13522eda7718a2c82c61ab409c2c520ccabc898725c565d25b8b2d84f7117869c36391b1f68a54ea0d89a201090` |

The checksum word shares the actor's initial (a/b/c), so the phrase says whose wallet it is.
All three carry `funding: mnemonic`, which the tooling treats exactly like `fund-script`.

**Seed and phrase are the same wallet, in two formats.** Seeds get copy-pasted into scripts;
mnemonics get typed by hand into a GUI. The seed above is not an arbitrary secret — it is the
BIP-39 master seed of that phrase with an empty passphrase, which is what makes the toolkit
and Lace resolve to the same wallet. `tools/mnemonic-wallets/cross-check.sh` asserts it both
ways, and `./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json` re-derives every
phrase and fails on any mismatch.

Seven wallets in total, then: four funded at genesis and three funded on demand. The
`funding` field is what drives the tooling — `fund-wallet.sh --all-demo` funds everything
that is not `genesis`, and `verify-wallets.sh` asserts the genesis ones by default and all
seven with `--include-script-funded`.

### Funding more wallets

```bash
# fund one wallet: NIGHT + DUST registration + wait until fees are payable
./scripts/fund-wallet.sh <seed-or-address>

# fund every wallets.json entry that is not genesis-funded (demo-alice/bob/carol,
# all funding="mnemonic")
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

## Import into Lace

Lace imports a wallet from a **mnemonic**, never from a raw hex seed, so the wallets below are
addressed by phrase. All four are one word repeated 23 times plus a checksum word, which
means they can be typed into Lace's import screen in well under a minute.

Point Lace at this stack first: its `undeployed` preset expects **node 9944, indexer 8088,
proof-server 6300**, which is what `.env.example` defaults to. If you moved the ports (or ran
`scripts/pick-ports.sh`), Lace will not find the stack.

| Wallet | Mnemonic | Funded by | Receive address (unshielded) |
|---|---|---|---|
| `lace-test` | `abandon` ×23 + `diesel` | **genesis — nothing to run** | `mn_addr_undeployed1nqhdatus5d6tvye57q854kdrs6ur2ytsl8yaygzfsdy2e3tvtmesdcgp8m` |
| `demo-alice` | `alpha` ×23 + `avoid` | `fund-wallet.sh --all-demo` | `mn_addr_undeployed14tjhxluvt773ry7hta5ysvhymjk6usyhlgauzt4al9t8lpe4gtzqvnj8gs` |
| `demo-bob` | `boss` ×23 + `burst` | `fund-wallet.sh --all-demo` | `mn_addr_undeployed1va25tg7d43rcftqeafs6dn3mvycut9zffq989my7p6c8kr0djl5shn25qj` |
| `demo-carol` | `cactus` ×23 + `cherry` | `fund-wallet.sh --all-demo` | `mn_addr_undeployed1ctfkn3nhju6f8p4t92ay0k30eswc4n9s60rjq2s3rkearf454tgqh6ckgy` |

"`abandon` ×23 + `diesel`" means the word `abandon` typed 23 times followed by `diesel` — 24
words total. `wallets/wallets.json` holds each phrase in full, along with the shielded, dust
and `userAddress` forms and the BIP-39 master seed.

### The same wallets as seeds

Type the phrase into Lace; paste the seed into `fund-wallet.sh`, `verify-wallets.sh` or the
toolkit. They address the identical wallet — the seed is the BIP-39 master seed of the phrase
(empty passphrase), which is why the toolkit and Lace agree on every address.

| Wallet | BIP-39 master seed (128 hex = 64 bytes) |
|---|---|
| `lace-test` | `a51c86de32d0791f7cffc3bdff1abd9bb54987f0ed5effc30c936dddbb9afd9d530c8db445e4f2d3ea42a321b260e022aadf05987c9a67ec7b6b6ca1d0593ec9` |
| `demo-alice` | `0a4f358d27c85cc3063c73fe002e9f933722aad5bc009799805946cc5a9e7272f249189587fe0254c6d18b5bc1a24f60617bc62f07c5b57343b0fddf8e680d96` |
| `demo-bob` | `1ce2d940e5a46775697fa7878627fbd689b5e6e73c7e32b82ed01468b07534288f9b74cbcd116b75a3f854315accdf39f87d075bd74a23eaf4910d95e7629095` |
| `demo-carol` | `fc14ae819b1a9ace2304c5cf960596741fccd13522eda7718a2c82c61ab409c2c520ccabc898725c565d25b8b2d84f7117869c36391b1f68a54ea0d89a201090` |

Re-derive any of them yourself — the phrase is the source of truth, the seed is cached in
`wallets/wallets.json`:

```bash
./tools/mnemonic-wallets/derive.sh --mnemonic "alpha alpha … avoid"
./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json   # asserts all four
```

**Start with `lace-test`.** It is prefunded at genesis with 250,000,000 NIGHT and its DUST
address is registered from block zero, so it can pay fees immediately and survives a
`./down.sh -v` reset with no funding step. It is not a phrase we invented either: it is
Midnight's own canonical test wallet — `@midnight-ntwrk/testkit-js` defines exactly this
mnemonic as `TEST_MNEMONIC`, and midnight-node's Earthfile funds its seed at genesis with the
comment *"wallet-seed-3 is the wallet Lace uses for testing"*.

The other two are empty until you fund them, which is one command on a running stack:

```bash
./scripts/fund-wallet.sh --all-demo                    # 10,000,000 NIGHT + DUST each
./scripts/verify-wallets.sh --include-script-funded    # assert they can pay a fee
```

They exist so a two-party demo (make an offer with one wallet, take it with another) needs two
imports and no seed juggling.

### If Lace shows a different address

**Then the derivation differs, and that is a finding worth recording** — not something to work
around. Please note the address Lace shows, next to the one in the table, in the project's
findings log (`00001-demo-infra`, task T2.6) so the mismatch can be chased rather than
rediscovered. A wallet at a different address is simply unfunded, and an unfunded wallet in a
demo reads as "the stack is broken".

Before concluding that, rule out the three things that legitimately change the address:

- **A BIP-39 passphrase.** These wallets have none. Leave any passphrase field empty.
- **A different HD account or address index.** The table is account 0, address index 0 — what
  Lace shows immediately after an import. Switching accounts gives different, empty addresses.
- **A different network.** The addresses are `undeployed`; a Lace pointed at testnet or
  mainnet derives different prefixes from the same phrase.

What has already been checked, so it is not the likely culprit: the two independent
implementations this repo relies on agree exactly. `tools/mnemonic-wallets/` derives these
addresses with the **wallet SDK's** HD derivation (`@midnightntwrk/wallet-sdk@2.0.0-beta.2`,
BIP-39 → BIP-32 `m/44'/2400'/0'/<role>'/0'`), and `midnight-node-toolkit show-address` derives
them from the same master seed; every address form matches, for all three phrases, and
`lace-test`'s match the genesis wallet the chain actually funds. Re-run the proof any time,
offline and with the stack down:

```bash
./tools/mnemonic-wallets/derive.sh                          # show all three, in full
./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json
./tools/mnemonic-wallets/cross-check.sh                     # wallet SDK vs toolkit
```

**Not yet confirmed against the Lace UI itself.** Nobody has typed these phrases into Lace and
compared what it displays — that step needs a human with the extension installed. Everything
up to Lace's own screen is verified; the last hop is not. See `tools/mnemonic-wallets/README.md`
for the derivation, its sources, and how to add more phrases.

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
| `EVM_WATCH_SEEDS` | comma-separated **32-byte** seeds; the monitor derives the address itself | Short, already in `.env`, and self-checking — the monitor's HD derivation was verified identical to `midnight-node-toolkit show-address` for all three 32-byte seeds |
| `EVM_WATCH_ADDRESSES` | comma-separated `mn_addr` values, verbatim | **Every mnemonic-derived wallet must be watched by address.** A BIP-39 master seed is 64 bytes and the monitor's derivation accepts 32 only, so `lace-test` and `demo-alice`/`demo-bob`/`demo-carol` can go nowhere else — which is every wallet except the genesis three |

That split is the one thing to get right when adding a wallet. An address nobody watches is
not an error anywhere in the stack — it simply reads `0x0`, which looks exactly like a funding
run that failed.

The four genesis wallets report a non-zero balance within a second or two of bring-up with **no
funding step**: the indexer replays their genesis UTXOs as ordinary unshielded transactions.
Running `./scripts/fund-wallet.sh --all-demo` then brings the five non-genesis wallets to
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

- **The first bring-up prints `pull access denied` three times, and that is normal.** The image
  tag is local-only, so compose tries a registry pull for each of the three services before
  falling back to building it. The build then runs and the stack comes up; there is nothing to
  fix and nothing to log in to.
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

## Celestia DA devnet (profile `offerfiles`)

```bash
./up.sh --with offerfiles           # core stack + a local single-node Celestia
./scripts/celestia-token.sh         # the DA RPC's auth token
./scripts/celestia-token.sh --curl  # a ready-to-paste authenticated curl
./scripts/verify-celestia.sh        # block production + a blob submitted and read back
```

One container runs two processes: a **consensus node** (`celestia-appd` 6.4.10) producing a block
a second, and a **bridge node** (`celestia-node` 0.28.4) serving the **DA JSON-RPC on `:26658`**
with a funded wallet. Both versions are exactly what `@effectstream/celestia@0.103.1` vendors for
the offer-files kernel's `bun run dev`, so this is the devnet the kernel was developed against.

They share a container on purpose: the bridge dials the consensus node's gRPC over
container-loopback and cannot even *initialise* without its genesis block hash
(`CELESTIA_CUSTOM=<chain>:<hash>`), so splitting them buys a service-discovery dance and a
chicken-and-egg ordering problem in exchange for nothing. The entrypoint exits if either process
dies, so compose never reports half a devnet as running.

### The namespace

Blobs live in a namespace, and `CELESTIA_NAMESPACE` carries the 10-byte hex suffix of one. The
default is the **MIP-0006 shared namespace `6d6e2d737761702d7631`** — ASCII `mn-swap-v1` — which is
also the kernel's own code default (`MIP6_NAMESPACE_ID_SUFFIX_HEX`). That is the whole point of the
standard: one namespace is one liquidity pool, so every compliant UI, indexer and bot reads the
same offer stream, and a per-deployment namespace re-silos the order book.

The wire form is 29 bytes — a `0x00` version byte, 18 zero bytes, then those 10 — and
`celestia-namespace --base64` in the image does that expansion, the same one the kernel's
`mip6NamespaceBytes()` does:

```bash
docker run --rm -e CELESTIA_NAMESPACE=6d6e2d737761702d7631 \
  midnight-2-offers/celestia:local celestia-namespace --base64
# AAAAAAAAAAAAAAAAAAAAAAAAAG1uLXN3YXAtdjE=
```

Overriding it is sanctioned for an **isolated dev/e2e run** — the kernel's hosted preview does
exactly that, so for preview parity set `CELESTIA_NAMESPACE=000000000000deadbeef` (wire form
`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN6tvu8=`). Both values work against this devnet; the devnet is
isolated by its own genesis either way, which is why the default is the honest one rather than the
fake-looking one.

⚠️ Whichever you pick, **every offer-files service must take it from this one `.env` variable**,
never from its own default. A mismatch between publisher and reader is completely silent — blobs
land, nothing reads them, the order book is just always empty with no error anywhere.
`verify.sh` asserts that the running container's handoff file carries the same value the stack is
configured with, so publisher and reader cannot drift apart unnoticed.

### The auth token, and how a container gets it

The DA RPC requires `Authorization: Bearer <jwt>`. That token is signed with a secret inside the
bridge node's store, so it does not exist until the container has bootstrapped — which is *after*
compose has finished evaluating `environment:` and `env_file:` on the host. It therefore cannot be
a compose variable, and is handed over as a file on a small dedicated volume instead:

| Path (volume `celestia-auth`) | Contents |
|---|---|
| `/celestia/auth/token` | the raw JWT, one line |
| `/celestia/auth/celestia.env` | `CELESTIA_RPC_URL`, `CELESTIA_AUTH_TOKEN`, `CELESTIA_NAMESPACE`, `CELESTIA_NETWORK`, `CELESTIA_CHAIN_ID` as `KEY=value` |

A consumer mounts that volume **read-only** and sources the file as its first act — one line in an
entrypoint, and the variable names are already the ones the kernel's `packages/node/env.ts` reads:

```dockerfile
# in the future kernel/batcher entrypoint
set -a; . /celestia/auth/celestia.env; set +a
exec bun run …
```

`depends_on: {celestia: {condition: service_healthy}}` makes the file's presence a guarantee
rather than a race, because **the healthcheck itself reads that token and makes an authenticated
call with it** — so "healthy" means "the file is there and the token in it works". The volume is
separate from the chain data volume so a consumer gets the token and *not* read access to the
validator keyring. From the host, `./scripts/celestia-token.sh` does the same thing through
`docker compose exec`.

Setting `CELESTIA_SKIP_AUTH=true` reverts to an **open** DA RPC with no token to thread anywhere,
which is what the kernel's own dev orchestrator does (`--rpc.skip-auth`). The default here is
auth-on so that the token path is exercised locally instead of only against the hosted preview
endpoint — the one place where a mistake in it costs money.

### What verify.sh proves

`./scripts/verify-celestia.sh` asserts, all over the **published host port**: the token is
readable and accepted; the handoff file carries every variable and the right namespace; the
network head **advances** (a bridge that has lost its consensus node keeps answering with the last
height it saw, forever); the bridge wallet holds utia (it signs and pays for every blob, so an
empty wallet fails every submit *with a message about gas*); a blob **submitted** to the namespace
is **read back by height and namespace** with matching bytes; the same blob is **not** visible in
a different namespace at that height; and an unauthenticated call is rejected.

The round trip is the point: it is exactly what the kernel does — batcher `blob.Submit`, sync node
fetch-by-height — so it is verified before the kernel exists rather than during its bring-up.

### Notes worth knowing

- **The image is ~860 MB and built from upstream release binaries**, native on both `arm64` and
  `amd64` (no `platform:` pin, unlike the indexer). The npm package the kernel uses mirrors only
  `linux-amd64`, which would have meant QEMU-emulating a block-a-second consensus node on Apple
  Silicon; those mirrored tarballs are byte-identical to celestiaorg's own release assets, which
  *do* include `Linux_arm64`, so this fetches from upstream at the same pinned versions.
- **The first bring-up prints `pull access denied`** for the local-only image tag, exactly as the
  umbra-evm one does, then builds.
- **State survives `./down.sh` and dies with `./down.sh -v`**, like the node and indexer volumes.
  A restart reuses the same genesis, the same bridge wallet and the same funding — it does not
  re-bootstrap. (The kernel's dev orchestrator wipes Celestia's home on every run; this does not.)
- **Bootstrap takes ~25 s**: genesis → first block → bridge init → a 6 s pause → bridge start →
  fund the bridge wallet → wait for that transaction to land. `up.sh` blocks until the DA RPC
  answers over the host port.
- **`utia` here is monopoly money.** The validator holds 10¹⁵ and the bridge is funded 10⁸ at
  bootstrap, which is a few thousand blob submissions.

## Verifying and tearing down

```bash
./verify.sh              # node finality + indexer GraphQL + proof-server + wallets (+ evm, celestia if up)
./verify.sh --core-only  # skip the wallet checks (each spawns a toolkit container) and both profiles
./verify.sh --evm        # require the evm section — fail if the profile is not up
./verify.sh --no-evm     # skip the evm section even when it is up
./verify.sh --celestia   # require the celestia section — fail if the profile is not up
./verify.sh --no-celestia # skip the celestia section even when it is up
./down.sh                # stop, keep the chain — ./up.sh resumes it
./down.sh -v             # FULL RESET: wipes node, indexer, evm-postgres, celestia and cache volumes
```

Each optional section runs automatically when that profile's containers exist, so `./verify.sh`
needs no argument either way. `./scripts/verify-evm.sh` and `./scripts/verify-celestia.sh` run
them alone (`--quick` skips the slow check in each: `newHeads` delivery, and the blob round trip).

`down.sh -v` wipes the node volume and the indexer volume **together**, and that is a
correctness requirement rather than tidiness: a ledger v8→v9 chain cannot be upgraded in
place, so a fresh node genesis paired with a surviving indexer database gives you an indexer
serving a chain that no longer exists. The toolkit's fetch cache and the umbra-evm Postgres volume
go with them for the same reason — every one of them holds state keyed to one specific genesis.

`down.sh` always passes **every** fragment in `compose/`, so a profile you brought up earlier is
torn down even if you do not name it now. Every volume is declared in a fragment for the same
reason: only a compose-created volume carries the project label that the "nothing left behind"
count filters on.

### Full reset

`./down.sh -v` **is** the full reset — there is no second cleanup step to remember, and no state
outside what it removes:

```bash
./down.sh -v && ./up.sh --all        # brand-new genesis, brand-new everything
```

What it removes, and what each piece of state is keyed to:

| State | Where it lives | Keyed to |
|---|---|---|
| chain data | volume `<project>_node-data` | the genesis it was created with |
| indexed blocks | volume `<project>_indexer-data` | that same genesis |
| eth balances, logs, cursors | volume `<project>_evm-postgres-data` | that same genesis |
| Celestia chain + validator keyring + bridge store | volume `<project>_celestia-data` | its own Celestia genesis |
| the DA auth token + handoff file | volume `<project>_celestia-auth` | the bridge store above |
| toolkit fetch/ledger cache | host directory `.cache/<project>/` | that same Midnight genesis |

They must go together. A fresh node genesis beside a surviving indexer database gives you an
indexer serving a chain that no longer exists; a surviving toolkit cache makes the next funding
run fail in a way that looks nothing like "stale cache"; and an offer spans **both** chains, so a
Celestia history describing offers against a Midnight genesis that no longer exists is worse than
no history at all. The cache is the one piece compose cannot remove for you (it is a host
directory, not a volume, because a `docker run` volume carries no project label and therefore
escapes `docker compose down -v` entirely) — `down.sh` deletes it explicitly.

Nothing survives a reset except the things derived from `seed + networkId`: every address in
`wallets/wallets.json` stays valid, and `lace-test` is funded again at the new genesis. So a
reset costs you a `fund-wallet.sh --all-demo`, nothing more.

If a teardown ever reports leftovers, `./down.sh -v` printed the exact filter to inspect them
with; the same assertion (plus a name-prefix sweep for unlabelled volumes) is what
`scripts/ci-check.sh` fails on.

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

## One-command check (CI)

```bash
./scripts/ci-check.sh                 # the whole chain, on ports nothing else is using
./scripts/ci-check.sh --core-only     # skip the evm and offerfiles profiles (no image builds)
./scripts/ci-check.sh --no-fund       # genesis wallets only
./scripts/ci-check.sh --keep          # on failure, leave the stack up for inspection
```

It generates its own env file (so it never touches your `.env` or the default ports), brings up
the profiles, funds the five non-genesis wallets, runs `verify.sh` **and**
`verify-wallets.sh --include-script-funded`, then tears everything down and asserts that nothing
survived. Exit 0 means both halves of that: the stack worked, and the machine is clean.

Three details that make it safe to run on a shared box, and that are worth copying if you write
your own harness:

- **It tears down on every exit path** — failure, `Ctrl-C`, `SIGTERM`. `up.sh` deliberately
  leaves a failed stack running so a human can look at it; that is the wrong default for CI, so
  the teardown lives in an `EXIT` trap.
- **The teardown is asserted, not assumed.** Containers, networks and volumes are counted by
  compose-project label *and* by name prefix. A volume created outside compose has no project
  label at all, so a label-only count once reported a clean teardown while state survived.
- **`verify.sh` alone would not prove the funding worked.** Its wallet section checks the
  *genesis* wallets, which are funded whether or not anything ran. Asserting the script-funded
  ones needs the explicit `--include-script-funded`, which is why `ci-check.sh` runs both.

## Known limitations

- **The offer-files kernel and batcher are not in this release, and `offerfiles` is therefore a
  PARTIAL profile** — it brings up the Celestia DA devnet with nothing publishing to it, and
  `up.sh` says so on every bring-up. There is no `frontend` profile and no browser make→take swap.
  The blocker is not packaging: the kernel and the zswap-da template pin ledger-v8 / midnight-js 4
  / wallet-SDK v1, and the `@effectstream/*` packages under them pin `@midnight-ntwrk/ledger-v8` as
  **exact dependencies**, so nothing can be redirected at this repo's level. Node 2.x is a
  ledger-v9 chain (`protocolVersion 2000000`) and the v8 SDK cannot even deserialize its state.
  That migration is ~4,600 lines across five published packages and is tracked as its own project
  (the Effectstream ledger-v9 migration, 00016). Until it publishes prereleases the kernel and
  batcher host ports stay reserved in `.env.example` and `--with frontend` fails with that
  explanation. The kernel's in-memory PGLite behaviour and the browser-reachability requirement
  for the proof-server URL will be documented with those services, not before.
- **`up.sh --with` is additive, and `--converge` is how you take a profile back down without a full
  teardown.** Until 2026-08-23 `--with` named the *complete* set of optional profiles, so
  `./up.sh --with offerfiles` on a stack where `evm` was up silently **stopped** the evm services;
  it no longer does. If you have a script that relied on the old behaviour, add `--converge` to
  it. (`down.sh` needs neither: it always passes every fragment, so nothing can be orphaned by
  forgetting to name it.)
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
- **Both locally-built images are large**: `celestia` ~860 MB (two Go binaries, 285 MB and 190 MB
  unpacked — there is nothing to trim), `umbra-evm` ~990 MB.
- **The umbra-evm image is large (~1 GB).** It installs UmbraDB's full dev dependency tree because
  `tsx` and the `@midnightntwrk/wallet-sdk-*` packages the wallet monitor imports are all
  devDependencies, and the repo is run as TypeScript rather than built. The upside is that the
  repo's own offline test suites can be run inside the image.
- **Ledger v8 → v9 chains cannot be upgraded in place.** Wiping the node volume means wiping the
  indexer, umbra-evm and Celestia state in the same breath — `./down.sh -v` does exactly that.
- **The Celestia devnet has no peers and says so, loudly.** Its log carries
  `error advertising … failed to find any peer in table` and `Host is not reachable from the
  public network!` on repeat. Both are correct and harmless: it is a one-node network with nothing
  to discover. Ignore them.
- **The Celestia binaries need glibc ≥ 2.38**, so `images/celestia` is built on `debian:trixie`
  rather than the `bookworm-slim` the umbra-evm image uses. On bookworm every invocation dies with
  `libc.so.6: version 'GLIBC_2.38' not found` before `main()`, which reads like a corrupt download.
- **The DA RPC's auth token cannot be a compose variable** — it is minted inside the container
  during bootstrap, long after compose evaluates `environment:`/`env_file:` on the host. It is
  handed over as a file on the `celestia-auth` volume; see
  [the auth token section](#the-auth-token-and-how-a-container-gets-it).
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
