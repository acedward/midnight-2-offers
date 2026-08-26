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
| Midnight node | `core` | RPC `http://127.0.0.1:9944` (HTTP+WS) | midnightntwrk/midnight-node *(upstream)* — image `2.0.0-rc.4`, `CFG_PRESET=dev` |
| Indexer | `core` | GraphQL v4 `http://127.0.0.1:8088/api/v4/graphql` (+`/ws`; `/api/v3` aliases v4) | midnightntwrk/indexer-standalone *(upstream)* — image `4.4.0-rc.1` (linux/amd64 only) |
| Proof server ×2 | `core` + `aa` | plain `http://127.0.0.1:6300`; `_experimental` internal-only | midnightntwrk/proof-server *(upstream)* — `9.0.0-rc.5` (kernel's v6 keys) + `9.0.0-rc.5_experimental` (the aa profile's zkir-v3/v7 keys) |
| Wallet tooling | `core` | `scripts/fund-wallet.sh`, `verify-wallets.sh` | midnightntwrk/midnight-node-toolkit *(upstream)* — image `2.0.0-rc.4` (must match the node) |
| umbra-evm (read-only eth JSON-RPC) | `evm` | HTTP `http://127.0.0.1:8545` (chainId 2400) · WS `ws://127.0.0.1:10021` | [acedward/UmbraDB](https://github.com/acedward/UmbraDB) — branch `feat/00006-json-rpc-review` · [PR #5](https://github.com/acedward/UmbraDB/pull/5) is the home of the JSON-RPC work |
| Celestia DA devnet | `offerfiles` | DA JSON-RPC `http://127.0.0.1:26658` (bearer token: `scripts/celestia-token.sh`) | celestiaorg release binaries *(upstream)* — app `6.4.10` + node `0.28.4`, one container |
| Offer-files kernel (sync node) | `offerfiles` | API `http://127.0.0.1:9999` | [effectstream/zswap-offerfiles-kernel](https://github.com/effectstream/zswap-offerfiles-kernel) — branch `00001-ledger-v9` · [PR #49](https://github.com/effectstream/zswap-offerfiles-kernel/pull/49): migrated from v8 to v9. Contract deploys ONCE per stack (`offerfiles-deploy` one-shot, address persisted) |
| Offer-files batcher | `offerfiles` | `http://127.0.0.1:3334` | same repo/branch — its own container, restarts independently of the kernel |
| COW solver (observation mode) + sink | `solver` | feed page `http://127.0.0.1:10800` (relay WS `:10801`) | [zswap-offerfiles-kernel @ `00001-solver-v9`](https://github.com/effectstream/zswap-offerfiles-kernel/tree/00001-solver-v9) — [PR #50](https://github.com/effectstream/zswap-offerfiles-kernel/pull/50), the v9 port pointing into PR #48. Needs `KERNEL_REF` on that branch |
| zswap-da frontend (swap SPA) | `frontend` | `http://127.0.0.1:10600` | effectstream `templates/zswap-da` — LOCAL v9-migrated checkout (`ZSWAP_DA_TEMPLATE_DIR`); upstream `templates/**` is frozen on ledger-v8 |
| AA Manager + Minter | `aa` | deploy receipt in the `aa-out` volume | [acedward/AA-midnight-evm-experiment-v3](https://github.com/acedward/AA-midnight-evm-experiment-v3) — `main @ 713a2021` (sha-pinned; key-breaking merges need a redeploy) · [PR #10](https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/10) fixed withdraw |
| — k=18 `execute` variation | `aa` (opt-in) | `AA_EXECUTE_K18=1` + `AA_K18_DIR` | [acedward/AA-midnight-evm-experiment-minocrab](https://github.com/acedward/AA-midnight-evm-experiment-minocrab) — 544 MiB prover key, ~2× faster proofs; equivalence-tested vs compactc (56/56 + 4,888 tamper probes), unaudited compiler, dev chains only |
| **AA web console** (this stack's UI) | `aa` | **`http://127.0.0.1:10700`** | this repo (`images/aa-contracts/console/`) — tabs: AA+EVM, AA+Midnight (preview), COW solver feed, infrastructure canvas, Memos, Repos |
| `@effectstream` packages | (npm) | — | [effectstream/effectstream](https://github.com/effectstream/effectstream) — `@effectstream/*@0.200.2` · `mip-zswap-offer@0.4.0-v9.0` · [PR #882](https://github.com/effectstream/effectstream/pull/882) merged |
| Midnight Intents relay | (dropped) | — | [shieldedtech/midnight-intents-swaps](https://github.com/shieldedtech/midnight-intents-swaps) *(upstream)* — pinned `d444c83` by the solver branch; NOT run (the solver observes only) |
| Web Memo (Memos tab) | (embedded) | `https://web-memo.pages.dev` | [acedward/web-memo](https://github.com/acedward/web-memo) — `main`, Cloudflare Pages · builds on [acedward/midnight-ledger PR #2](https://github.com/acedward/midnight-ledger/pull/2) (memo-v3 ledger fork) |
| dusk-wallet | (related work) | — | [acedward/dusk-wallet](https://github.com/acedward/dusk-wallet/tree/00001-utxo-pinning) — branch `00001-utxo-pinning` · PRIVATE repo |

Internal-only ports (never published): `evm-postgres:5432`, celestia consensus `26657`/`9090`,
`aa-proof-server:6300`. No service addresses another by a host port — everything internal runs
on the compose network — so remapping host ports cannot break the stack, which is what makes
[two stacks on one machine](docs/OPERATIONS.md#running-two-stacks-at-once) possible.
`BIND_ADDR` (default `127.0.0.1`) is the interface published ports bind to.

## Quickstart

```bash
cp .env.example .env       # ports/tags; defaults are the Midnight-standard ports
./up.sh --all              # everything; blocks until genuinely usable
```

Open the console at **http://127.0.0.1:10700** when it is up.

**Options** (each `--with` is additive; a profile is a compose fragment in `compose/`):

```bash
./up.sh                               # core only (node + indexer + proof server + wallets)
./up.sh --with aa --with offerfiles   # pick profiles: aa · evm · offerfiles · frontend · solver
./up.sh --converge --with aa          # EXACTLY core + the named profiles; stops the rest
./up.sh --build | --pull              # rebuild local images / pull upstream ones first
./scripts/pick-ports.sh > .env.test   # free port block + unique project name…
ENV_FILE=.env.test ./up.sh --all      # …for a second stack beside the first
```

**Optional scripts** — verify, fund, stop, CI:

```bash
./verify.sh                           # health + wallets + every profile that is up
./scripts/fund-wallet.sh --all-demo   # fund the demo-* wallets (10M NIGHT + DUST each)
./scripts/aa-e2e.sh                   # end-to-end of the EVM-signed AA path
./down.sh                             # stop, keep the chain (./up.sh resumes)
./down.sh -v                          # FULL RESET — wipes every chain-keyed volume
./scripts/ci-check.sh                 # one command: free ports → up --all → fund → verify → down -v
```

What `up.sh` actually waits on (and why the container healthchecks are not enough), verify
flags, teardown semantics and the CI harness details: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## The web console

`http://127.0.0.1:10700` (profile `aa`) is the demo's face. Any injected browser EVM wallet
(MetaMask, Rabby, …) signs EIP-712 actions; the console's relay recovers the signer's public
key, proves the Manager's `execute` through the stack's own proof server (~1–2 min per action)
and submits — the browser never holds a Midnight key. Register / fund / transfer / withdraw all
land on-chain; the Swap action builds a real MIP-0005 `swapoffer1…` offer (shown as bech32m,
then published to the kernel with a second click), and the book panel settles live offers with
a separate taker wallet. The other tabs: a live **COW solver** ladder feed, an
**infrastructure** canvas probing every component, an embedded **Memos** app, and the
**Repos** pin table. `AA_CONSOLE_DEV_SIGNER=1` adds a built-in signer for wallet-less runs.

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

(The console's own relay and taker wallets, `aa-console`/`aa-taker`, are funded automatically
by `up.sh` when the `aa` profile comes up.) Genesis wallets carry 250,000,000 NIGHT with DUST
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
config/     files mounted into containers (e.g. umbra-evm watch.json)
docs/       the long-form write-ups this README links to
.env.example  every host port and image tag, with the Midnight-standard defaults
```
