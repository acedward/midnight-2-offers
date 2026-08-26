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
