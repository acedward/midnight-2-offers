# Components — the long version

Everything that used to live at the top of the README: what each profile is, how it works,
and the design decisions behind it. The README keeps the short table; this file keeps the story.

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
migration rides PR #49 of `effectstream/zswap-offerfiles-kernel`; the image pins PR #50 commit
`b1420c4…`, which includes that migration plus the offer-update WS route required by the solver.

**Cow solver source pin.** Cow solver source is not copied into this repository. Its image fetches
[`effectstream/zswap-offerfiles-kernel` PR #50](https://github.com/effectstream/zswap-offerfiles-kernel/pull/50)
directly at build time at exact SHA `4af102536f02f137b696a4734bd8c936eddf3672`
(`SOLVER_REF`). Compose supplies the separately built kernel image only for its generated Compact
artifacts.

**Frontend source pin.** The zswap-da template's ledger-v9 migration is not published upstream
(`effectstream/effectstream@templates/zswap-da` remains on ledger-v8). The image therefore fetches
[`effectstream/effectstream@332503c8`](https://github.com/effectstream/effectstream/tree/332503c8f9216143a8c805f2a0acbcfd39e5a21d/templates/zswap-da)
directly, verifies the resolved full commit, and applies the fail-closed 10-file
`images/zswap-da/ledger-v9.patch`. The patch carries only dependency/lockfile, compiler manifest,
and six TypeScript/API migrations; 64 byte-identical upstream files are no longer copied here.
Cold builds need GitHub and npm network access. The fetched upstream licenses are preserved in the
runtime image, and `/.zswap-da-commit` makes the source pin part of CI provenance verification.

**The `aa` profile deploys the AA contracts and mints a token.** `--with aa` deploys
[`acedward/AA-midnight-evm-experiment-v3`](https://github.com/acedward/AA-midnight-evm-experiment-v3)'s
Manager (the account-abstraction custody contract) and test Minter on the demo chain at
bring-up, then proves two mint calls (one shielded colour, one unshielded) and writes the
receipt — addresses, colours, tx ids — to the `aa-out` volume as `aa-contracts.json`
(`./scripts/verify-aa.sh` reads it back; `verify.sh` gains an `aa` section). Two design
points worth knowing: the contracts are compiled with `--feature-zkir-v3` (the Manager is
keccak/EIP-712-heavy), so the profile runs its **own internal experimental proof server**
(`AA_PROOF_IMAGE`) next to the plain core one rather than repointing the whole stack's
proving at one variant; and the Manager's 1.1 GB `execute.prover` key is deliberately
NOT in the image — deploying needs only verifier keys, and bring-up never calls `execute`.
The one-shot is idempotent across `up` runs and its state dies with `down.sh -v`.

**The `aa` profile also serves the AA web console** at `http://127.0.0.1:10700`
(`AA_CONSOLE_HOST_PORT`): its face is the **Midnight-EVM [AA] Wallet**, where **any injected
browser EVM wallet** (MetaMask, Rabby, …) drives the AA path — on connect the Manager's
read/pure surface executes for the address (no registration needed), then register, balances,
and token-first Withdraw / Transfer / Publish Offer. The
browser holds no Midnight wallet and no prover: it signs `eth_signTypedData_v4` requests that
the console's relay builds with the AA repo's own EIP-712 codec, and the relay recovers the
signer's secp256k1 point from the signature (the `pk` argument `execute` needs — no EVM wallet
exposes it), proves `execute` through the profile's internal proof server (~1 min with the
k=18 MinoCrab overlay, ~2 min at stock k=19; the page shows the live job log) and submits,
paying fees from its own relay wallet
(`aa-console` in `wallets/wallets.json`, funded automatically by `up.sh` — unshielded NIGHT +
DUST only, deliberately shielded-free). The console's image variant keeps the 1.1 GB
`execute.prover` the deploy image prunes (`midnight-2-offers/aa-contracts:console`).
`AA_CONSOLE_DEV_SIGNER=1` enables a built-in test signer for wallet-less CI runs; leave it off
otherwise. The one-time withdraw limitation is GONE: the node's `Custom error: 214` (a
recipient-encoding defect in the Manager) was fixed upstream in
[AA PR #10](https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/10) — pin `AA_REF`
at or past its merge (`713a2021…`; key-breaking, so redeploy the contracts) and withdraw lands
like every other operation. Unshielded withdraws (selector 3) go to a 32-byte user address only (`recipientKind 0`);
the contract refuses contract-recipient payout shapes by design. Shielded withdraws
(selector 2) go to **any pasted `mn_shield-addr…`** — the address decodes to the recipient's
coin public key (which rides the signed action) and encryption public key (which feeds the
build-time coin-encryption mapping); the stack's own wallets remain selectable shortcuts.
The AA-infra tab's **Send to an address** is the relay-side sibling: it mints a demo token and
wallet-transfers it to any pasted `mn_addr…`/`mn_shield-addr…`, no signature involved.

**The console's Swap panel publishes real offer files.** An `OpenSwapShielded` action (signed by
the browser wallet like every other op) is proven as a Manager `execute` and then **never
submitted**: the proven transaction is unbalanced by exactly +give/−want, which makes it the
offer itself — encoded as a MIP-0005 `swapoffer1…` blob and `POST`ed to the offer-files kernel
(`--with offerfiles` required; the panel degrades gracefully without it). Give and want are
any two **distinct shielded demo tokens** (wBTC/wETH — the offer-files contract's own token
set, unified across the stack in Phase 12); the console's taker flow or the kernel's own
`api-examples/11-settle-offer.ts` settle it. Two switches make this work, both ON in the demo and
OFF upstream by default: `ALLOW_CONTRACT_MAKER_OFFERS` (kernel-side — contract-maker offers
cannot pass `wellFormed` against the kernel's blank reference state, so the exact
missing-contract failure retries without contract-proof verification; native zswap proofs and
signatures are always verified, and the node verifies the contract proof at settlement) and
`AA_OFFER_ALLOW_FALLIBLE` (console-side — the v5 Manager's k=19 transcript exceeds the ledger's
guaranteed-section budget, so every AA offer's legs sit in the fallible section; measured live:
a foreign taker settles them anyway, ledger-exact). Each blob is also saved under the `aa-out`
volume at `/aa/out/offers/<offerId>.swapoffer`.

**The offer book persists across restarts.** It used to be in-memory: the kernel kept its book in
a PGLite database inside its own container, so recreating `kernel` threw the book away and
re-indexed it from Celestia height 1. Since T11.4 the whole stack shares ONE PostgreSQL
(`postgres` in `compose/core.yml`) and the kernel uses its `offerfiles` database, which outlives
the container. Measured on a recreate: the offer row survived, the API served the same offer, and
the sync cursors RESUMED — Celestia fetching restarted at block 11066 having stopped at 11065,
not at height 1 — so the container reached healthy in **8 seconds** instead of re-indexing.
`./down.sh -v` still drops it, which is right: the book is a projection of the chain that command
destroys.

**The contract, however, no longer moves.** The `offerfiles` profile is three services, not one:
`offerfiles-deploy` (a one-shot that deploys the offer-files contract **once per stack** and
persists its address on a volume), `kernel` (the sync node `:9999`, storing into the shared
`postgres`), and `batcher` (the balancing batcher `:3334`, on its own). Before this split everything ran
under one dev orchestrator, and the contract deploy re-ran on every container recreate — its
script begins by deleting the address file, so a `--force-recreate` silently minted a **new
contract** and reset the book's identity. Now a recreate rejoins the existing contract; only the
projection rebuilds. `./down.sh -v` drops the address along with the chain it belongs to, which
is when a fresh deploy is correct.

Practical consequences: `kernel` and `batcher` restart independently of each other, and
`docker compose logs batcher` is the batcher's log alone rather than six processes interleaved.

## The two proof servers, and the one cache they share (profile `core` + `aa`)

**They are two different programs, not two tags on one image.** `9.0.0-rc.5` plain proves the
zkir-v2 / `[v6]` lane — the offer-files kernel's circuits and the wallet's standard lane. The
`9.0.0-rc.5` experimental build additionally carries a zkir-v3 interpreter, which the AA
contracts need because they are compiled `--feature-zkir-v3`. Their Linux-amd64 executables
hash to `189974b9…` and `913d5e65…` respectively and they share no manifest, config or layer
digest at any platform, so each is pinned to its own immutable index digest and the scripts
refuse to start if the two references are equal.

> `GET /proof-versions` answers `["V2","V3"]` on **both** builds — it reports the proof wire
> format, not the compiler lane, so it cannot be used to tell them apart. The reliable
> discriminator is behavioural: feed the plain server a zkir-v3-compiled circuit and it
> refuses it (`images/proof-params/tests/zkir-fixture/` does exactly that as a control).

**Where the images come from.** Upstream `midnightntwrk/proof-server` availability at stack
startup is this stack's most frequent cold-start failure, so both variants are pulled from
`ghcr.io/effectstream/midnight-proof-server` instead. Those are **exact mirrors**: raw index
bytes, both platform manifests, both configs, both layer blobs and both extracted executables
are byte-identical to the upstream indexes, re-provable at any time with
`images/proof-server-mirror/verify-mirror.py`. Anonymous pull, no login. Note that the
standalone proof-server ZIP in the binary warehouse is *not* a usable substitute: it contains
exactly one file, and that executable's ELF interpreter is an absolute `/nix/store/…` path
with an empty `RUNPATH`, so without the 16-directory Nix closure that ships inside the
official image it cannot exec at all. Mirroring the complete image is the only correct option.

**One verified proof-data generation, mounted read-only by both.** Proof data — the SRS
objects K0-K19 plus Ledger-static `9.0.0` — is architecture-neutral and identical for both
variants, so it lives in exactly one place: a named `proof-params` volume, populated once by
the `proof-params-init` one-shot in `compose/core.yml`.

* It downloads exactly the 21 published noarch payloads from the warehouse, verifies every
  outer and member SHA-256 against the reviewed admission manifest, stages on the same
  filesystem, fsyncs, and **atomically** activates `generations/<content-digest>`. A failure
  leaves the previous complete generation untouched; a partial tree is never observable.
* `proof-params-init` is the **only** writer. Both proof servers mount the volume `:ro` and
  point `MIDNIGHT_PP` at the *fixed generation directory* — never at the volume root and
  never at the `current` symlink, so a pointer swap cannot move a running server onto
  different bytes. A server's write attempt fails with `EROFS`.
* Both servers gate on `service_completed_successfully`, so **a proof server cannot start
  before the cache verifies.** That is a deliberate behaviour change: previously each server
  fetched its own ~223 MB from `https://srs.midnight.network/` on first proof.
* The payload bytes are in the volume and in no OCI layer — the initializer image adds about
  230 kB over its pinned Python base. `MIDNIGHT_PARAM_SOURCE` remains the official SRS host
  as a fallback; the development-only GitHub warehouse is explicitly not an admissible
  parameter source and the initializer refuses one.
* A repeat run against an already-active generation downloads nothing and returns `NOOP` in
  a few seconds, so container recreates are free. `./down.sh` keeps the volume; `./down.sh -v`
  is a project-wide wipe and removes it, costing one re-download on the next `up`.

Boolean proof-server environment knobs (`MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS` and friends)
require the **literal** strings `true` / `false` on rc.5; `=1` aborts the server at startup.

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
| `eth_subscribe("newHeads")` | the indexer head (see the provenance note below) |

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
(default full commit `5a463485…` from `evm-compat`) and installs it — the upstream repo ships no Docker
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
- **Source provenance is explicit.** `UMBRA_REF` defaults to full commit `5a463485…`, and
  `/app/.umbra-commit` is checked by CI. The two WebSocket fixes below are merged upstream:
  1. `evm-rpc/logs/ws.ts` defaults `listen(port, host = "127.0.0.1")` and `serve-all.ts` never
     passes a host, so the WS server binds container-loopback and refuses every client. It fails
     invisibly: the published port accepts TCP (docker-proxy), the client sees only close `1006`,
     and the server logs nothing.
  2. With no `blockSource`, `newHeads` falls back to a source that can only announce blocks
     carrying a *watched contract log* — i.e. nothing at all with an empty `watch.json`. The merged
     upstream fix injects a source polling the same indexer head that answers `eth_blockNumber`.

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

- **The image is ~860 MB and built from published release binaries**, native on both `arm64` and
  `amd64` — and so is the indexer now, so neither image carries a `platform:` pin any more. Both
  archives come from the `effectstream/binaries@0.3.120` warehouse by `TARGETARCH`, and each one
  is byte-equal to the corresponding official celestiaorg release asset. That equality is pinned
  offline in `images/celestia/official-equality.tsv` — asset name, official release/tag/asset id,
  and both the release-asset checksum and the `checksums.txt` checksum — rather than re-fetched
  from a release's `checksums.txt` during the build, which used to make a mutable network
  resource part of the trust decision.
  The warehouse is **development-only and mutable**: an asset can be re-uploaded under the same
  name, so those SHA-256 values are the artifact's identity and a byte change fails the build
  before anything is extracted.
  Two of the four rows are cataloged `legacy-unverified` with null source and null member hashes.
  That is truthful and is left alone: their equality is proven directly against the official
  release instead, and the build **rejects** a legacy row that tries to claim a source commit.
  (An earlier version of this image went straight to celestiaorg because the npm package the
  kernel uses mirrors only `linux-amd64` — that claim no longer applies to the warehouse, which
  publishes `linux-arm64` at both of these versions.)
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

## Shielded NIGHT — NIGHT ⇄ sNight (profile `shielded-night`)

```bash
./up.sh --with shielded-night          # core + this profile, and nothing else
./verify.sh --shielded-night           # prove it works, not merely that it runs
open http://127.0.0.1:10900
```

[`effectstream/shielded-night`](https://github.com/effectstream/shielded-night) is a Compact
contract plus a Vite/React dApp that converts native **unshielded NIGHT** into a
contract-minted **shielded wrapper token, sNight**, 1:1, and back — backed by a pool of locked
NIGHT. Eleven circuits, and two conversion models:

* **atomic** — `convertToShielded` / `convertToUnshielded`: one transaction, one wallet
  approval, the shielded and unshielded moves netting inside a single segment;
* **two-step credit-bridged** — `depositUnshielded` → `withdrawShielded` and
  `depositShielded` → `withdrawUnshielded`, with a per-user credit balance keyed by
  `hash(secret)` in between.

`./verify.sh` exercises **both**, in a container, with exact balance assertions.

### The pin is a branch head, and the image checks the line

This stack is Midnight **2.x**. shielded-night's `main` is the **1.x / ledger-v8** line — that
is what its live preview deployment runs, and what the sibling repository `midnight-1-offers`
pins for the same profile. So this repository pins the long-lived **`ledger-v9`** branch
(`30af63f3…`, [PR #10](https://github.com/effectstream/shielded-night/pull/10)), whose own CI
runs the unit tier, the frontend build, the byte-exact contract rebuild and the full
integration suite against node 2.0.0-rc.4 / indexer 4.4.0-rc.3 / proof-server 9.0.0-rc.5.

Because *only the pin* separates the two images, the pin is not trusted. `images/shielded-night`
asserts the line in both directions, in both packages **and in both resolved lockfiles**:
`@midnightntwrk/ledger-v9` is `1.0.0-rc.3`, `@midnight-ntwrk/compact-runtime` is `0.19.0`, no
`ledger-v8` is depended on, and neither `bun.lock` resolves one. The lockfile half is the one
that matters — two ledger wasm instances in a single process fail each other's `instanceof`
checks during proving, hours later and nowhere near the cause.

### The contract is recompiled, not trusted

`src/managed/` is committed upstream and upstream CI proves it is byte-exact. The image
reproduces that proof instead of relying on it: it fetches **compactc 0.34.0** as a
SHA-256-pinned Linux musl release asset, compiles `src/shielded-night.compact` into an *empty*
directory with the same invocation and working directory upstream uses, and `diff -r`s the
result. Any difference fails the build.

Two details are load-bearing:

* **the source path is part of the output.** compactc writes the input path verbatim into
  `contract/index.js.map`, so the compile must run from the repository root as
  `src/shielded-night.compact`. Anything else yields artifacts identical in every ZK key and
  different in two lines of the source map — which is how the byte-exact check would end up
  being "loosened" for the wrong reason.
* **`compiler/contract-manifest.json` is not decorative on this line.** compactc emits it from
  0.33 onwards, and midnight-js 5's `FetchZkConfigProvider` verifies every artifact it fetches
  against it, with integrity checking defaulting to *require* — fail-closed. The build asserts
  the manifest is produced and reaches `dist/`; the page's healthcheck fetches it; and
  `verify.sh` asserts the served copy names compactc 0.34.0 and covers all 11 circuits. A page
  serving 33 perfect keys and no manifest connects a wallet and then refuses to prove anything.

`./verify.sh` closes the loop from the other end: the **on-chain** verifier keys of the
contract this stack deployed are compared byte-for-byte against the keys the page serves,
11 of 11, none missing and none extra — using upstream's own `verify-deployment.ts`, run
inside the compose network against this stack's indexer.

### Four services, two images

| Service | Kind | What it does |
|---|---|---|
| `shielded-night-fund` | one-shot (toolkit) | gives the profile's two dedicated wallets NIGHT + a registered DUST address, and **skips** either one that already has both |
| `shielded-night-deploy` | one-shot (`restart: "no"`) | deploys the contract ONCE per stack and publishes `contract.json` atomically to a named volume |
| `shielded-night` | nginx | serves the SPA and the compiled artifacts; its entrypoint waits for that address and writes `/config.js` before starting nginx |
| `shielded-night-verify` | never started by `up.sh` | the bun-side assertions `./verify.sh` runs with `compose run --rm` (a compose `profiles:` key keeps it out of `up -d`, exactly as `core.yml`'s `fund` service does) |

**Deployed once, deliberately.** The sNight token colour is derived from the contract address
(`tokenType(pad(32,"shielded-night:wrapper"), self())`), so a silent redeploy would not merely
change an address — every sNight coin already minted would become a different, unspendable
token, and the page would show a zero balance with nothing logged anywhere. The presence of
`contract.json` on the volume IS the "already deployed" flag: a container that finds one JOINs
and exits 0. Only `./down.sh -v` (or dropping that volume) forces a new contract.

### How the page learns its address

shielded-night bakes one contract address per network into the bundle at build time
(`UNDEPLOYED_ADDRESS`, via Vite's `envPrefix`). That is right for its hosted deployments and
impossible here — this image is built once and run against throwaway devnets whose contract
does not exist until our own one-shot has run.

Upstream therefore resolves `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS` ahead of the build-time
value, and ships a no-op `public/config.js` placeholder that `index.html` already loads as a
**classic** script. The web entrypoint overwrites that one already-served file at container
start and touches nothing else — **no patch of the source and no patch of the built output**.

What makes it run first is that it is a classic script, not where it sits in the document:
Vite hoists the bundle's `<script type="module">` into `<head>` while the config tag stays in
`<body>`, and a module script is deferred by specification. `verify.sh` asserts that property
rather than document order, because asserting the order would be both wrong and red.

### The network dropdown now also offers PreProd

Since `ledger-v9` @ `30af63f3…` (project 00007 phase F2) merged shielded-night `main`'s own PR
#11, `frontend/.env`'s `PREPROD_ADDRESS` is baked into the bundle at build time alongside
`PREVIEW_ADDRESS` — so the page this profile serves shows **Preview**, **PreProd** and
**Local (undeployed)** in its network dropdown, not just the first and third. This is a
consequence of the re-pin, not new code in this repository: nothing here adds, wires or tests a
PreProd lane. **Selecting PreProd talks to the real, public preprod network and its live,
unlocked contract — not this stack's own devnet.** The devnet deploy this profile drives is
always `Local (undeployed)`, which is what `/config.js` points the dropdown at by default and
what `verify.sh` and the round-trip driver both exercise.

### No browser-endpoint lane, on purpose

Unlike the zswap-da SPA, this page has **no** indexer/node/proof URL overrides and needs none:
there is no in-page wallet, and the connected browser wallet supplies those URLs itself through
the dApp connector's `getConfiguration()`. The only thing the page cannot know is the contract
address. So a random port block changes nothing for the page — and the profile has no browser
URI override to get wrong.

The corollary is that **the wallet owns proving**. The page hands over the contract's ZK key
material and calls `getProvingProvider`; it never names or reaches a proof server. A wallet
without that method is refused with an explicit error. See
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) and [WALLETS.md](WALLETS.md).

### It depends on nothing but core

No kernel, no Celestia, no Postgres, no evm, no aa. `./up.sh --with shielded-night` on its own
is legal and complete, and `scripts/verify-compose-pins.sh` renders `core shielded-night`
alone as one of its combinations so that a dependency added later fails a gate instead of a
demo.
