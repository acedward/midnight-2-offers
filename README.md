# midnight-2-offers — one-command Midnight 2.x demo stack

A single Docker Compose project that brings up a complete local Midnight 2.x demo environment:
the core chain, an EVM read façade, a Celestia-backed zswap offer-files book with its solver,
AA contracts driven from a browser wallet, and one web console tying it all together.

**Everything here is dev-only.** Every seed and mnemonic in this repo is public and controls
value only on a throwaway local `undeployed` chain. Never reuse any of them anywhere else.

## The stack

One row per component: what runs, where to reach it, and exactly which repo/ref it is built
from. We manage the `acedward/*` and `effectstream/*` repos; rows marked *(upstream)* are
consumed as-is with no code changes of ours.

| Component | Profile | Endpoint (default) | Source · ref · note |
|---|---|---|---|
| Midnight node | `core` | RPC `http://127.0.0.1:9944` (HTTP+WS) | midnightntwrk/midnight-node *(upstream)* — official image `2.0.0-rc.4` pinned by multiarch index digest, `CFG_PRESET=dev` |
| Indexer | `core` | GraphQL v4 `http://127.0.0.1:8088/api/v4/graphql` (+`/ws`; `/api/v3` aliases v4) | official `4.4.0-rc.3` executable from the [`effectstream/binaries@0.3.120`](https://github.com/effectstream/binaries/releases/tag/0.3.120) warehouse *(development-only, mutable — pinned by SHA-256)*, installed into a thin local image: **no Rust build**, native `amd64` **and** `arm64`. Built upstream from [midnightntwrk/midnight-indexer](https://github.com/midnightntwrk/midnight-indexer) `56561b2f…`, recorded in the image as provenance; includes the standalone SQLite deadlock fix missing from rc1 |
| Proof server ×2 | `core` + `aa` | plain `http://127.0.0.1:6300`; experimental internal-only | `9.0.0-rc.5` plain (kernel's v6 / zkir-v2 keys) + `9.0.0-rc.5` experimental (the aa profile's zkir-v3 / v7 keys), pulled from `ghcr.io/effectstream/midnight-proof-server` by digest. Exact byte-for-byte mirrors of the upstream `midnightntwrk/proof-server` indexes *(upstream availability at startup is unreliable; the bytes are identical — `images/proof-server-mirror/`)*. Two **different programs**, separately pinned |
| Proof data (shared cache) | `core` | internal — one named `proof-params` volume | SRS K0-K19 + Ledger-static `9.0.0`, 21 noarch payloads from the same `effectstream/binaries@0.3.120` warehouse. A one-shot initializer verifies every hash and activates ONE immutable generation; both proof servers mount it **read-only**. Not in any image layer, never duplicated per architecture or variant |
| PostgreSQL (shared store) | `core` | internal only — `docker compose … exec postgres psql -U offerfiles offerfiles` | `postgres:17-alpine` *(upstream)* + `pg_ivm` 1.11 compiled in (`images/postgres/`). ONE server for the stack: db `offerfiles` = the kernel's offer book, db `umbra` = umbra-evm's index |
| Wallet tooling | `core` | `scripts/fund-wallet.sh`, `verify-wallets.sh` | midnightntwrk/midnight-node-toolkit *(upstream)* — official image `2.0.0-rc.4` pinned by multiarch index digest (must match the node) |
| umbra-evm (read-only eth JSON-RPC) | `evm` | HTTP `http://127.0.0.1:8545` (chainId 2400) · WS `ws://127.0.0.1:10021` | [acedward/UmbraDB](https://github.com/acedward/UmbraDB) — pinned `5a463485…` from `evm-compat`; [PR #5](https://github.com/acedward/UmbraDB/pull/5) is the home of the JSON-RPC work |
| Celestia DA devnet | `offerfiles` | DA JSON-RPC `http://127.0.0.1:26658` (bearer token: `scripts/celestia-token.sh`) | app `6.4.10` + node `0.28.4` from the same `effectstream/binaries@0.3.120` warehouse, each archive byte-equal to the official celestiaorg release asset (`images/celestia/official-equality.tsv`); one container, native `amd64` **and** `arm64` |
| Offer-files kernel (sync node) | `offerfiles` | API `http://127.0.0.1:9999` | [effectstream/zswap-offerfiles-kernel](https://github.com/effectstream/zswap-offerfiles-kernel) — pinned `b1420c4…` from [PR #50](https://github.com/effectstream/zswap-offerfiles-kernel/pull/50), which includes [PR #49](https://github.com/effectstream/zswap-offerfiles-kernel/pull/49)'s v9 migration plus the solver's offer-update WS route. Contract deploys ONCE per stack (`offerfiles-deploy` one-shot, address persisted) |
| Offer-files batcher | `offerfiles` | `http://127.0.0.1:3334` | same repo/branch — its own container, restarts independently of the kernel |
| COW solver (observation mode) + sink | `solver` | feed page `http://127.0.0.1:10800` (relay WS `:10801`) | [effectstream/zswap-offerfiles-kernel PR #50](https://github.com/effectstream/zswap-offerfiles-kernel/pull/50) — fetched directly at build time at exact SHA `4af102536f02f137b696a4734bd8c936eddf3672` (`SOLVER_REF`); **not vendored**; generated contract artifacts reuse the service-built kernel image |
| zswap-da frontend (swap SPA) | `frontend` | `http://127.0.0.1:10600` | [`effectstream/effectstream@332503c8`](https://github.com/effectstream/effectstream/tree/332503c8f9216143a8c805f2a0acbcfd39e5a21d/templates/zswap-da) — fetched directly at build time and adapted by the checked-in 10-file `images/zswap-da/ledger-v9.patch`; no frontend source tree is committed |
| Shielded NIGHT dApp (NIGHT ⇄ sNight) | `shielded-night` | `http://127.0.0.1:10900` | [effectstream/shielded-night](https://github.com/effectstream/shielded-night) — branch **`ledger-v9`** @ `30af63f3…` ([PR #10](https://github.com/effectstream/shielded-night/pull/10), the 2.x port; `main` is the 1.x line). Contract, harness and page from ONE commit, no patch of any kind; the contract is **recompiled in-image** with SHA-256-pinned compactc `0.34.0` and the build fails unless the output is byte-identical to the committed `src/managed/`. Deploys ONCE per stack (`shielded-night-deploy` one-shot, address persisted on a volume and injected into the page as `/config.js`) |
| AA Manager + Minter | `aa` | deploy receipt in the `aa-out` volume | [acedward/AA-midnight-evm-experiment-v3](https://github.com/acedward/AA-midnight-evm-experiment-v3) — `main @ 713a2021` (sha-pinned; key-breaking merges need a redeploy) · [PR #10](https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/10) fixed withdraw |
| — k=18 `execute` variation | `aa` (opt-in) | `AA_EXECUTE_K18=1` + `AA_K18_DIR` | [acedward/AA-midnight-evm-experiment-minocrab](https://github.com/acedward/AA-midnight-evm-experiment-minocrab) — 544 MiB prover key, ~2× faster proofs; equivalence-tested vs compactc (56/56 + 4,888 tamper probes), unaudited compiler, dev chains only |
| **AA web console** (this stack's UI) | `aa` | **`http://127.0.0.1:10700`** | this repo (`images/aa-contracts/console/`) — tabs: AA+EVM, AA+Midnight (preview), COW solver feed, infrastructure canvas, Memos, Repos |
| `@effectstream` packages | (npm) | — | [effectstream/effectstream](https://github.com/effectstream/effectstream) — `@effectstream/*@0.200.2` · `mip-zswap-offer@0.4.0-v9.0` · [PR #882](https://github.com/effectstream/effectstream/pull/882) merged |
| Midnight Intents relay | (dropped) | — | [shieldedtech/midnight-intents-swaps](https://github.com/shieldedtech/midnight-intents-swaps) *(upstream)* — pinned `d444c83` by the solver branch; NOT run (the solver observes only) |
| Web Memo (Memos tab) | (embedded) | `https://web-memo.pages.dev` | [acedward/web-memo](https://github.com/acedward/web-memo) — `main`, Cloudflare Pages · builds on [acedward/midnight-ledger PR #2](https://github.com/acedward/midnight-ledger/pull/2) (memo-v3 ledger fork) |
| dusk-wallet | (related work) | — | [acedward/dusk-wallet](https://github.com/acedward/dusk-wallet/tree/00001-utxo-pinning) — branch `00001-utxo-pinning` · PRIVATE repo |

Internal-only ports (never published): `postgres:5432` (the one shared store), celestia consensus `26657`/`9090`,
`aa-proof-server:6300` (exactly one proof host port exists, core's plain one). No service addresses
another by a host port — everything internal runs
on the compose network — so remapping host ports cannot break the stack, which is what makes
[two stacks on one machine](docs/OPERATIONS.md#running-two-stacks-at-once) possible.
`BIND_ADDR` (default `127.0.0.1`) is the interface published ports bind to.

### How each external artifact is chosen

One rule decides every row above, applied in order — so you can tell at a glance *why* a
component is an image, a downloaded binary, a mirror or a build:

1. **A good official OCI image exists** → use it, pinned by its complete multiarch **digest**
   (node, toolkit). We do not repack a good official image just to put everything under one
   registry owner.
2. **No image, but the exact official binary is published** → download it from the
   `effectstream/binaries` warehouse by `TARGETARCH` into a thin local image, verifying the
   archive's and the executable's SHA-256 (indexer, both Celestia binaries). No compiler.
3. **An official image exists but is unreliable to pull** → mirror the complete multiarch
   index into a registry we control and consume it by destination digest (both proof-server
   variants). An exact mirror keeps the upstream bytes; anything that differs would have to
   carry an explicit Effectstream revision marker instead.
4. **Only source exists** → an immutable source build pinned to a full commit SHA (kernel,
   batcher, solver, AA, Umbra, frontend, `pg_ivm`).

**Identity is the digest or the SHA-256, never the tag or the URL.** A tag can be repointed at
different bytes without anything here changing, so overrides that supply a tag are rejected
rather than accepted as a weaker pin. The frozen decisions live in
[`config/artifact-decisions.json`](config/artifact-decisions.json) with the reasoning in
[docs/ARTIFACT-DECISIONS.md](docs/ARTIFACT-DECISIONS.md); four offline checks
(`verify-artifact-decisions.sh`, `verify-artifact-fetch.sh --static`,
`verify-mirror.py --level offline`, `verify-compose-pins.sh`) keep the matrix, the image
build pins, the mirror record and the rendered Compose configuration agreeing with each other.

> **The binary warehouse is DEVELOPMENT-ONLY and MUTABLE.** `effectstream/binaries@0.3.120`
> can re-publish an asset under the same name, so the pinned hashes — not the URL and not the
> version string — are the identity. A byte change fails the build before anything is
> installed, which is intended, but it does mean a build can start failing with no change here.

## Quickstart

```bash
cp .env.example .env       # ports + pinned image digests; defaults are the Midnight-standard ports
./up.sh --all              # everything; blocks until genuinely usable
```

The **first** bring-up (and the first after `./down.sh -v`) also downloads and verifies the
~223 MB shared proof-data generation once, about a minute. Every later run finds it already
active. The proof servers deliberately cannot start until that check passes.

> ### ⚠ Upgrading a checkout that ran an older kernel pin: `./down.sh -v` is REQUIRED
>
> The offer-files kernel moved to the unified `ledger-v9` line, which adds the token price
> service — new tables (`asset_prices`, `price_feed_status`, `known_tokens.decimals`) with
> seeded reference prices, all in `migrations/000-init.sql`. **The kernel applies that file
> only on an EMPTY database.** A `postgres-data` volume created before this pin therefore
> comes up looking healthy while `/v1/prices` prices nothing, `/v1/quote` cannot size a leg,
> the batcher's sponsorship gate treats every offer as unpriced, and the offer poster stalls.
>
> ```bash
> ./down.sh -v && ./up.sh --all      # the only supported upgrade path
> ```
>
> `verify.sh`'s kernel section asserts the seeded table and fails with this instruction, so
> the situation is loud rather than silent — but it is a **full reset**: the local chain,
> book and contract address all go with it. That is correct, not collateral damage: the book
> is a projection of the chain the reset destroys.

Open the console at **http://127.0.0.1:10700** when it is up.

**Options** (each `--with` is additive; a profile is a compose fragment in `compose/`):

```bash
./up.sh                               # core only (node + indexer + proof server + wallets)
./up.sh --with aa --with offerfiles   # pick profiles: aa · evm · offerfiles · frontend · shielded-night · solver
./up.sh --with shielded-night         # NIGHT ⇄ sNight on :10900 — needs nothing but core
./up.sh --converge --with aa          # EXACTLY core + the named profiles; stops the rest
./up.sh --build | --pull              # rebuild local images / pull upstream ones first
./scripts/pick-ports.sh > .env.test   # free port block + unique project name…
ENV_FILE=.env.test ./up.sh --all      # …for a second stack beside the first
```

**Optional scripts** — verify, fund, stop, CI:

```bash
./verify.sh                           # health + wallets + every profile that is up
./verify.sh --shielded-night          # …and REQUIRE the NIGHT ⇄ sNight section (fail if absent)
./scripts/fund-wallet.sh --all-demo   # fund the demo-* wallets (10M NIGHT + DUST each)
./scripts/aa-e2e.sh                   # end-to-end of the EVM-signed AA path
./down.sh                             # stop, keep the chain (./up.sh resumes)
./down.sh -v                          # FULL RESET — wipes every volume, cache included
./scripts/ci-check.sh                 # one command: free ports → up --all → fund → verify → down -v
./scripts/verify-artifact-decisions.sh --self-test   # offline: the frozen artifact contract
./scripts/verify-compose-pins.sh --self-test         # offline: rendered compose really asks for it
```

What `up.sh` actually waits on (and why the container healthchecks are not enough), verify
flags, teardown semantics and the CI harness details: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## The web console

`http://127.0.0.1:10700` (profile `aa`) is the demo's face. The **Midnight-EVM [AA] Wallet**
tab is a wallet-shaped product: connect any injected EVM wallet (MetaMask, Rabby, …) and the
Manager's read surface executes immediately for that address — registration not required; the
rows just read empty. An unregistered address gets a Register warning; a registered one gets
its balances (every demo token, shielded/unshielded chips) and three operations — **Withdraw**
and **Transfer** open on a typed, balance-annotated token list before asking amount/recipient,
and **Publish Offer** builds a real MIP-0005 `swapoffer1…` (shown as bech32m, published to the
kernel with a second click). Shielded withdrawals go to **any** `mn_shield-addr…` — the pasted
address carries the recipient's coin + encryption keys. The relay recovers the signer's public
key from each EIP-712 signature, proves `execute` (~1 min with the k=18 overlay) and submits —
the browser never holds a Midnight key. **AA infra** holds the plumbing: funding, faucet,
mint-and-send to any pasted Midnight address, and the accounts table. The other tabs: the
offer book + the **COW solver** sink page embedded live, an **infrastructure** canvas probing
every component, an embedded **Memos** app, and the **Repos** pin table.
`AA_CONSOLE_DEV_SIGNER=1` adds a built-in signer for wallet-less runs.

Full component write-ups (the AA/console/swap mechanics and their switches, umbra-evm's
surface and error policy, the Celestia devnet, the offerfiles split):
[docs/COMPONENTS.md](docs/COMPONENTS.md). Known limitations:
[docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

## Wallets

`wallets/wallets.json` is the manifest — every wallet, its seed, all address forms. Addresses
derive from `seed + networkId` only, so they survive a `./down.sh -v` reset. The funded roster:

| Name | Seed | Funded by | Role |
|---|---|---|---|
| `genesis-1` | `0x…0001` | genesis | faucet — the funding source for `fund-wallet.sh` |
| `genesis-2` | `0x…0002` | genesis | offer-files batcher wallet |
| `genesis-3` | `0x…0003` | genesis | AA deploy + shielded-funding wallet |
| `demo-alice` | `0a4f358d…680d96` (mnemonic `alpha` ×23 + `avoid`) | `fund-wallet.sh --all-demo` | demo actor |
| `demo-bob` | `1ce2d940…629095` (mnemonic `boss` ×23 + `burst`) | `fund-wallet.sh --all-demo` | demo actor |
| `demo-carol` | `fc14ae81…201090` (mnemonic `cactus` ×23 + `cherry`) | `fund-wallet.sh --all-demo` | demo actor |
| `lace-test` | `a51c86de…93ec9` (mnemonic `abandon` ×23 + `diesel`) | genesis | THE wallet to import into a browser extension — held open by no service |
| `shielded-night-deployer` | `5e5e…5e5e` | `up.sh --with shielded-night` | deploys the ShieldedNight wrapper contract, once per stack |
| `shielded-night-driver` | `d00d…d00d` | `up.sh --with shielded-night` | drives `verify.sh`'s NIGHT ⇄ sNight round trips |

(The console's own relay and taker wallets, `aa-console`/`aa-taker`, are funded automatically
by `up.sh` when the `aa` profile comes up; the two `shielded-night-*` wallets are funded the
same way by a one-shot inside that profile, which skips any wallet already holding NIGHT and
spendable DUST.) Genesis wallets carry 250,000,000 NIGHT with DUST
registered from block zero; `--all-demo` brings each demo actor to 10,000,000 NIGHT + spendable
DUST. Full seeds, mnemonics, Lace import, derivation cross-checks, funding mechanics and the
token-model gotchas: [docs/WALLETS.md](docs/WALLETS.md).

## Layout

```
compose/    docker compose fragments, one per profile
images/     Dockerfiles for the components that ship no Docker packaging upstream
scripts/    funding, verification, port-picking, and the ci-check entrypoint
wallets/    wallets.json — the dev wallets this stack knows about
tools/      standalone helpers (mnemonic-wallets/ — mnemonic → Lace address derivation)
vendor/     pinned source absent from public upstream (zswap-da ledger-v9 migration)
config/     artifact-decisions.json (the frozen artifact contract) + files mounted into containers
docs/       the long-form write-ups this README links to
.env.example  every host port and pinned image digest, with the Midnight-standard defaults
```
