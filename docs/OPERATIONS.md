# Operations — waits, verification, teardown, CI

The operational details the README summarizes: what `up.sh` actually waits on and why the
container healthchecks are not enough, what `verify.sh` proves, what a full reset removes,
and how the CI harness stays safe on a shared machine.


## Shipping console/runner changes

The AA console's page (`images/aa-contracts/console/`) and relay
(`images/aa-contracts/runner/`) are **baked into the aa images at build time** — a running
container serves whatever the image was built from, and a recreate resets any files copied in
by hand. After changing them, rebuild so the change is permanent on the stack:

```
./up.sh --with … --build        # rebuilds the local images, then brings the stack up
```

`docker cp … + docker restart` into the live console container is a dev-iteration shortcut
only; the next `--force-recreate`/`down`/`up` discards it.
## What `up.sh` waits on

`up.sh` returns only when the stack is genuinely usable, which is stricter than "docker says
healthy":

| Service | What is waited on | Why not the healthcheck |
|---|---|---|
| node | RPC answers `chain_getBlockHash[1]`, **and** finalized height ≥ 1 | The node answers RPC several blocks before finality moves off genesis, and in that window the toolkit refuses to build transactions (`OnlyGenesisFinalized`) |
| indexer | GraphQL v4 answers a block query | Its container healthcheck only proves the supervisor is alive — the entrypoint touches the running-file *before* launching the indexer |
| proof-server | the port accepts a TCP connection | The image has no curl/wget, and its bash sits behind a per-build `/nix/store/<hash>…` path. Compose has already gated it on the proof-data cache verifying, so reaching this point means the shared generation is active |
| evm-rpc (`--with evm`) | `eth_chainId` answers over HTTP, **and** the WS port completes a `101 Switching Protocols` handshake | A TCP probe of a *published* port proves nothing: docker's port proxy accepts the connection before it dials the container, so `nc -z` reports a working endpoint that refuses every client |
| solver-frontend (`--with solver`) | the container healthcheck (`/health` on the monitor itself) | Deliberately says nothing about the solver: a monitor whose health followed the thing it monitors would be reported down exactly when it is needed. The solver's own wait, one line above it in `up.sh`, is what proves the solver is quoting |
| price-feed (`--with prices`) | nothing container-side — the KERNEL's `GET /v1/prices` is polled until `feed.last_ok_at` is non-null (bounded by `PRICES_WAIT_TIMEOUT`, default 180 s); a timeout is a WARN | The feed publishes no port and has no healthcheck: it is a *writer*, and its liveness signal is a row. `price_feed_status` is deliberately NOT seeded by `000-init.sql`, so a non-null `last_ok_at` means exactly "a cycle completed against THIS database" and nothing weaker. A timeout is a warning because a feed that cannot reach CoinGecko still leaves every quote working from the seeded prices; `./verify.sh --prices` is the gate |
| faucet-site (`--with faucet`) | the container healthcheck, then the SITE's own `/metadata.undeployed.json` is READ over HTTP and required to be `ready` with six active deployments | `service_completed_successfully` on `faucet-deploy` is not enough: it is equally satisfied by a deploy that took the RESUME path against a registry from a previous chain, and by a site container still blocking on an empty volume. It is read through HTTP rather than off the volume because that is where a browser reads it — a page still serving a previous inode would pass a filesystem check and fail a user. `up.sh` then waits on `registry-env`'s and `faucet-mint`'s exit codes unconditionally — the rest of the stack consumes both, and a failure there otherwise surfaces three services away as a container that never starts — and on `registry-bridge`'s only when `offerfiles` is also up (with no kernel that one-shot exits 0 by design) |
| offer-poster (`--with poster`, which now also requires `--with faucet`) | the container healthcheck (`/health` binds), then `/health` is READ: `degraded` is a WARN, `failed` is a failure | `/health` answers 200 while the poster is `starting` and while it is `degraded` — 503-ing on `degraded` would make Compose restart a container that is correctly waiting for NIGHT, or one that has simply run out of coins. So healthy proves only that the server bound, which happens after wallet sync + dust registration + the dust wait (hence `POSTER_WAIT_TIMEOUT=900`; there is no contract to join any more). The reason to expect since the contract removal is `insufficient_inventory` — the poster no longer mints. `./verify.sh --poster` is the gate that requires an adopted coin and a posted offer |

## Verifying and tearing down

```bash
./verify.sh              # node finality + indexer GraphQL + proof-server + wallets (+ evm, celestia if up)
./verify.sh --core-only  # skip the wallet checks (each spawns a toolkit container) and both profiles
./verify.sh --evm        # require the evm section — fail if the profile is not up
./verify.sh --no-evm     # skip the evm section even when it is up
./verify.sh --celestia   # require the celestia section — fail if the profile is not up
./verify.sh --no-celestia # skip the celestia section even when it is up
./verify.sh --solver     # require the solver section: sink safety counters, the status listener's
                         #   bearer gate (200 with / 401 without), :9100 unpublished, monitor page
./verify.sh --poster     # require the poster section: state, inventoryAdoptions + reoffers >= 1,
                         #   and lastOfferId present in the KERNEL's book with a give leg of
                         #   EXACTLY OFFER_POSTER_GIVE_AMOUNT and a quoted want leg
./verify.sh --prices     # require the price-feed section: the container is running, a cycle
                         #   completed with no error, the rows it wrote are recent, and BOTH legs
                         #   of a /v1/quote are `source: feed` rather than `seed`
./scripts/verify-prices.sh --once   # …and spend one CoinGecko credit on an extra synchronous cycle
./down.sh                # stop, keep the chain — ./up.sh resumes it
./down.sh -v             # FULL RESET: wipes every project volume — node, indexer, postgres,
                         #             celestia, toolkit cache AND the proof-data cache
```

Each optional section runs automatically when that profile's containers exist, so `./verify.sh`
needs no argument either way. `./scripts/verify-evm.sh` and `./scripts/verify-celestia.sh` run
them alone (`--quick` skips the slow check in each: `newHeads` delivery, and the blob round trip).

`down.sh -v` wipes the node volume and the indexer volume **together**, and that is a
correctness requirement rather than tidiness: a ledger v8→v9 chain cannot be upgraded in
place, so a fresh node genesis paired with a surviving indexer database gives you an indexer
serving a chain that no longer exists. The toolkit's fetch cache and the shared Postgres volume
go with them for the same reason — every one of them holds state keyed to one specific genesis.

`down.sh` always passes **every** fragment in `compose/`, so a profile you brought up earlier is
torn down even if you do not name it now. Every volume is declared in a fragment for the same
reason: only a compose-created volume carries the project label that the "nothing left behind"
count filters on.

### Full reset

**When it is not optional.** `./up.sh` is normally resumable, but a kernel pin that moves
`packages/database/migrations/000-init.sql` breaks that: the kernel applies the init file only
against an EMPTY database, and it has no migration path for a database that already exists
(new `migrationTable` entries never reach a synced DB). The ledger-v9 pin
(`5d794f9a27f6d65529bf176650405f740531d430`) is such a move — it adds the token price
service's `asset_prices` / `price_feed_status` tables and `known_tokens.decimals`, with seeded
reference prices. A `postgres-data` volume older than that pin produces a stack where every
container is healthy and every quote is wrong. `scripts/verify-kernel.sh` asserts
`GET /v1/prices` returns the seeded asset table for exactly this reason, and its failure names
the fix.

**And the `5d794f9` pin needs it for a second, independent reason: the offer-files CONTRACT is
GONE.** Kernel PRs #69/#70 deleted it — no `packages/contracts-midnight`, no
`mint_shielded`/`mint_unshielded`, no deploy, and no `contractAddress` in
`GET /v1/midnight/config`. The `offerfiles-deploy` service and the volume that held its address
are gone with it, which is not something an upgrade can do to a running stack: compose leaves an
orphaned volume behind, and every colour derived from that address stays in the database naming a
contract nothing can call. `aa-out` goes for the same reason and one more of its own — the AA
console now mints through the LOCAL issuers, so its deploy receipt belongs to a chain whose faucet
registry has to match. And `faucet-registry` is the new load-bearing one: every token id in the
stack is derived from an issuer contract on THIS chain, so a registry beside a different genesis
names six contracts that do not exist. None of that is caught by the database assertion above,
which is exactly why `./down.sh -v` and not a selective cleanup is the instruction.

The kernel's schema also seeds the six local names at this pin (`TWBTC`…`UTWBTC`, with their real
decimals and their CoinGecko asset ids) carrying **PreProd** colours. `registry-bridge` re-points
those seeded rows at this chain's colours and leaves their `asset_id` alone, which is what makes a
brand-new colour priceable — and it only works on a database that HAS those seeds. A
`postgres-data` volume older than them takes a different, weaker path; see the `PRICE_FEED_MAP`
note in `compose/offerfiles.yml`.

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
| eth balances/logs/cursors (db `umbra`) **and** the offer book (db `offerfiles`) | volume `<project>_postgres-data` | that same genesis |
| the batcher's accepted-but-unsubmitted inputs | volume `<project>_offerfiles-batcher` | that same genesis |
| the six local test-token identities (`metadata.undeployed.json`) **and the ids rendered from them** (`stack-tokens.env`) | volume `<project>_faucet-registry` | that same genesis — the runner records the chain name, runtime version and genesis hash in the file, and refuses to reuse it against a different one. `registry-env` re-renders the env file on every bring-up for the same reason: a colour is a property of a contract on one chain |
| the offer poster's journal | volume `<project>_offer-poster-state` | that same genesis — and the coins it describes, which live on the chain and die with it. `faucet-mint` re-mints inventory on the next bring-up |
| the faucet deploy journal + its private state store | volume `<project>_faucet-journal` | the same, and the registry beside it |
| Celestia chain + validator keyring + bridge store | volume `<project>_celestia-data` | its own Celestia genesis |
| the DA auth token + handoff file | volume `<project>_celestia-auth` | the bridge store above |
| toolkit fetch/ledger cache | host directory `.cache/<project>/` | that same Midnight genesis |
| the verified proof-data generation | volume `<project>_proof-params` | **nothing** — see below |

The proof-data cache is the odd one out. Its contents are published SRS and Ledger-static
payloads that have nothing to do with this chain's genesis, so plain `./down.sh` keeps it and
the next bring-up reuses it for free. `-v` removes it anyway, because a project-wide wipe that
leaves something behind is not a wipe and the "nothing left behind" assertion would fail. The
only cost is one ~223 MB re-download (~60 s) the next time the stack comes up — and the proof
servers will not start until that download verifies, by design.

Everything else must go together. A fresh node genesis beside a surviving indexer database gives you an
indexer serving a chain that no longer exists; a surviving `faucet-registry` names six contract
addresses the new chain has never heard of, and every token colour derived from those addresses
would be wrong (the deploy runner catches exactly this and STOPS, marking the registry stale
rather than silently replacing it — see [the faucet profile](#redeploy-and-resume-semantics)); a surviving toolkit cache makes the next funding
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

## The `faucet` profile

```bash
./up.sh --with faucet          # core + this profile; nothing else is needed
./verify.sh --faucet           # REQUIRE the section (fail if the profile is not up)
./verify.sh --no-faucet        # skip it even when the profile is up
./scripts/verify-faucet.sh --static   # the offline seed-distinctness check alone
./scripts/verify-faucet.sh --mint     # …plus one real mint, proved by a second wallet
```

Open **http://127.0.0.1:10950/?network=undeployed**.

### What bring-up actually does, in order

1. **`faucet-fund`** (toolkit one-shot) waits for finality to move off genesis, gives
   `faucet-deployer` 10,000,000 NIGHT, registers its DUST address and waits until a *spendable*
   DUST UTXO exists. It **skips** a wallet that already has both, so the second and later
   `./up.sh` runs cost seconds. On the ledger-9 line this is not optional — see
   [COMPONENTS.md](COMPONENTS.md#six-services-two-runtime-targets-of-one-image) for why the
   upstream code reads as though it were.
2. **`faucet-deploy`** (one-shot, `restart: "no"`) renders `FAUCET_DEPLOYER_SEED` into a
   **tmpfs** file at `/run/faucet/deployer-seed.hex` (mode 0600, removed on exit), waits for
   node block #1, the indexer and the proof server, then runs upstream's deploy — six issuers,
   journalled, resumable — and publishes `metadata.undeployed.json` onto the `faucet-registry`
   volume by atomic rename.
3. **`faucet-verify`** (one-shot, **no seed**) re-verifies all six against the chain.
4. **`registry-env`** (one-shot, no seed, no chain access) reads the registry and publishes
   `/registry/stack-tokens.env` on the same volume by atomic rename: a `<SYMBOL>_TOKEN_ID` block
   per token plus the role names other profiles read (`OFFER_POSTER_GIVE_TOKEN`/`WANT_TOKEN`,
   `SOLVER_PROVISION_TOKEN_IN`/`OUT`, and `MAKER_OFFER_*` / `E2E_TOKEN_*` when their symbols are
   set). Seconds long, and it re-runs on every bring-up because `./down.sh -v` gives every token a
   new colour.
5. **`faucet-mint`** (one-shot) mints the demo's inventory: by default four coins of exactly
   `OFFER_POSTER_GIVE_AMOUNT` twBTC into the offer poster's wallet, plus anything named in
   `FAUCET_MINT_GRANTS`. It is idempotent BY BALANCE — compose re-runs a completed one-shot on
   every `up`, so it reads each recipient's balance and mints only the shortfall — and it waits
   for the RECIPIENT's own wallet to see each mint before it returns. That wait is what makes the
   next run's idempotence honest, and it is also the proof that the shielded encrypted-output path
   works for a third party. Each coin is a full proof cycle on a cold devnet, so
   `FAUCET_MINT_POSTER_COINS` is the knob that decides how long `--with faucet` takes.
6. **`registry-bridge`** (one-shot) names the six colours in the kernel's `known_tokens` once the
   kernel is healthy, or logs one line and exits 0 when the `offerfiles` profile is not in this
   stack. It is last of the one-shots because it is the only one that waits on another profile.
7. **`faucet-site`** starts on `faucet-verify`'s `service_completed_successfully`, blocks until
   it can read the registry, and serves it.
8. `up.sh` waits for the healthcheck, then **reads the registry back over HTTP** and names the
   six symbols in its summary line. It then waits on `registry-env`'s and `faucet-mint`'s exit
   codes: both are consumed by services in other fragments, and a failure in either otherwise
   turns up much later as a poster that exits 78 or never posts.

The first bring-up is the slow one — funding plus six real deploys proved on a cold chain —
which is why `FAUCET_WAIT_TIMEOUT` defaults to 1500 s rather than the core services' 120–420 s.

### Redeploy and resume semantics

The six issuers are deployed **once per stack**, and that is a correctness property rather than
an optimisation: each token's colour is derived from its issuer's contract address, so a silent
redeploy turns every test coin already minted into a different, unspendable token.

Resume is **upstream's** behaviour, not something this repository bolts on. The runner derives a
stack identity from the node's chain name, runtime version and genesis hash; journals every
deployment intent before submitting; and re-verifies a recorded contract — complete on-chain
verifier-key set, immutable metadata, derived token ID — rather than deploying a replacement.

* `./up.sh` again, `--force-recreate`, a restarted deploy container → **the same six
  contracts**, verified, nothing republished.
* `./down.sh` (chain kept) → same. The `faucet-registry` and `faucet-journal` volumes survive
  and the chain identity is unchanged.
* `./down.sh -v` → both volumes go with the chain volumes, and the next bring-up deploys afresh.
  That is the ONLY supported way to get new issuers.
* A registry left beside a **different** chain (a wiped `node-data` with a surviving
  `faucet-registry`, say) is marked **stale** and the deploy STOPS. Replacing a recorded
  deployment silently is how a token somebody already holds becomes unspendable. The remedy is
  an explicit `MN_REDEPLOY_STALE=1` rerun after confirming the reset — and because `./down.sh -v`
  removes the volume, the normal reset path never needs it.

### Stale locks

The runner takes an exclusive writer lock beside the registry and beside its journal, and
**deliberately does not steal locks** — two writers could otherwise publish conflicting state.
A container killed mid-deploy can leave a `.lock` file behind:

```bash
# read the PID the lock records, confirm no such process is running, then:
docker compose … run --rm --entrypoint sh faucet-deploy -c 'cat /registry/*.lock; rm -f /registry/*.lock'
```

The journal's lock lives on the `faucet-journal` volume under `/app/.local/deployments/`. If a
deploy call timed out before returning an address, the journal keeps an **uncertain in-flight
marker** and the next run refuses to submit again: reconcile the node and indexer first, and set
`MN_CONFIRM_NO_DEPLOYMENT=1` only after proving that no contract finalized.

### What the verify section asserts

`./verify.sh --faucet` runs `scripts/verify-faucet.sh`, which checks, in order: the seeds are
dedicated (offline); the page and the v2 receiver ZK artifacts serve as bytes and a missing
artifact answers 404 rather than the app shell; the registry served **over HTTP** is `ready`
with six active deployments and the expected symbols, colours and *real* decimals (8/18/6, not
6 everywhere); **all five** one-shots exited 0 (`faucet-fund`, `faucet-deploy`, `faucet-verify`,
`registry-env`, `faucet-mint`); `/registry/stack-tokens.env` carries a 64-hex id for all six
symbols and for both poster role names, and the poster's two legs are different tokens (equal legs
make `poster-config.ts` exit 78, which would otherwise only be discovered as a restart loop);
upstream's read-only verification passes **freshly** against the chain; and — only when
`offerfiles` is up — the kernel's `GET /v1/known-tokens` names all six with exactly those colours
and decimals. The env file is read out of the VOLUME through a throwaway container, never off the
host: it is a named volume, and reading it any other way would be reading something else.

The mint is **opt-in** (`--mint`), because it is a proof cycle on a cold devnet. It mints
`twUSDC` — a *shielded* token, because the shielded path is the one that needs
`additionalCoinEncPublicKeyMappings` to be right for a third-party recipient, and an unshielded
mint would pass even if that were broken.

## The `poster` profile — and sizing its inventory

```bash
./up.sh --with faucet --with offerfiles --with poster    # or ./up.sh --all
./verify.sh --poster                                     # REQUIRE the section
./scripts/verify-poster.sh --static                      # the offline seed-distinctness check
OFFER_POSTER_DRY_RUN=1 docker compose … run --rm offer-poster   # inspect + quote, post nothing
```

### It needs `--with faucet`, and `up.sh` says so before anything is built

`./up.sh --with offerfiles --with poster` **exits 2** with a named error rather than letting compose
fail. Two consequences of the contract removal put it there. The poster's two token ids are now
required, explicit 64-hex values that exist only once this chain's issuers are deployed — so they
cannot be written into `.env.example`, and `registry-env` renders them onto the `faucet-registry`
volume instead. And the poster no longer mints: the coins it offers come from `faucet-mint`. Both
of those services, and the volume, are declared in `compose/faucet.yml`, so without that fragment
compose does not render at all and says only `service "registry-env" … not found`, which names
nothing useful.

The profile is deliberately **not** auto-added. Asking for a stack that cannot exist should be
answered, not quietly turned into a third profile — the faucet deploys six contracts and takes
minutes, which is not a thing to start on somebody's behalf. `--all` includes both anyway.

An operator who wants neither can still pin both ids by hand: `OFFER_POSTER_GIVE_TOKEN` and
`OFFER_POSTER_WANT_TOKEN` in `.env` skip the file lookup entirely. The coins still have to come
from somewhere.

### Inventory sizing: three numbers that have to agree

The poster **selects** a coin worth exactly `OFFER_POSTER_GIVE_AMOUNT` out of its own wallet and
never creates or splits one. Inventory is therefore finite and externally supplied, and a coin is
tied up from the moment it is offered until the wallet releases it (`OFFER_POSTER_TTL_MINUTES`) or
a taker spends it. Steady state needs roughly

```
coins ≈ OFFER_POSTER_TTL_MINUTES × 60000 / OFFER_POSTER_INTERVAL_MS
```

| Knob | Default | What raising it does |
|---|---|---|
| `FAUCET_MINT_POSTER_COINS` | `4` | more coins at bring-up. Each is a full proof cycle on a cold devnet, so this is also what makes `--with faucet` slower |
| `OFFER_POSTER_INTERVAL_MS` | `300000` (5 min) | slower ticks, so inventory lasts longer |
| `OFFER_POSTER_TTL_MINUTES` | `10` | coins come back LATER — raising this makes starvation more likely, not less |

The defaults leave about two of the four coins in flight, with headroom. `OFFER_POSTER_GIVE_AMOUNT`
defaults to `100000000` — one whole twBTC at 8 decimals — and `compose/faucet.yml` and
`compose/poster.yml` read the SAME variable, so the coin that is minted and the coin that is looked
for cannot drift apart.

**`degraded: insufficient_inventory` is the honest answer, not a fault to retry away.** A restart
cannot create inventory, and this deployment never pretends it can. `./verify.sh --poster` fails on
it and prints `freeCoins` plus the three knobs above; that is the number to read before changing
any of them.

### What the verify section asserts

`state` not `degraded`; `inventoryAdoptions + reoffers ≥ 1` — which REPLACES the old `mints ≥ 1`,
because `poster-health.ts` reports no `mints` field and no `offer_poster_mints_total` metric at
this pin; `lastOfferId` present in the KERNEL's open book; a give leg of **exactly**
`OFFER_POSTER_GIVE_AMOUNT` (the old "a multiple of 10⁶" check encoded the belief that every token
here had 6 decimals, which the six local ones do not); a non-zero, actually-quoted want leg; and
`offer_poster_inventory_adoptions_total` scrapeable on `/metrics`.

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

The block is 16 consecutive ports and every published endpoint is derived from its base, so a
new service means a new offset rather than a new fixed number. The current layout:

| Offset | Variable | Default in `.env.example` |
|---|---|---|
| +0 … +2 | `NODE_HOST_PORT`, `INDEXER_HOST_PORT`, `PROOF_HOST_PORT` | 9944 / 8088 / 6300 |
| +3, +4 | `EVM_RPC_HOST_PORT`, `EVM_WS_HOST_PORT` | 8545 / 10021 |
| +5, +6 | `KERNEL_HOST_PORT`, `BATCHER_HOST_PORT` | 9999 / 3334 |
| +7 | `CELESTIA_HOST_PORT` | 26658 |
| +8, +9 | `FRONTEND_HOST_PORT`, `AA_CONSOLE_HOST_PORT` | 10600 / 10700 |
| +10, +11 | *(unused)* — were the solver sink's feed page and relay-inspection port until 2026-09-04. Left free rather than renumbered, so every other offset in the block is unchanged | — |
| +12 | `SHIELDED_NIGHT_HOST_PORT` | 10900 |
| +13 | `SOLVER_FRONTEND_PORT` — the COW solver's monitor site | 10802 |
| +14 | `POSTER_HEALTH_PORT` — the offer poster's health/metrics/journal | 10803 |
| +15 | `FAUCET_PORT` — the local test-token faucet site | 10950 |

The `prices` profile adds **no offset**: `price-feed` publishes nothing at all. It is a writer —
CoinGecko in, `asset_prices` out — and what it wrote is read back through the kernel's already
published `GET /v1/prices`.

Three things are deliberately NOT in that table because they are never published: the shared
`postgres:5432`; the COW solver's status listener `solver:9100`, which serves the solver's entire
internal state behind a Bearer and is read only by the monitor site over the compose network; and
**the whole `solver-sink`** — both its solver-facing relay ingress (`:8081`) and its observation
surface (`:8080`). `scripts/verify-solver.sh` asserts `docker port <solver> 9100` is empty and
that `docker port <solver-sink>` is empty entirely, and it reads the sink's snapshot through
`docker exec` rather than a host port.

### The swap SPA on a non-default port block

The browser is the one client that cannot be told "talk over the compose network". The kernel's
`GET /v1/midnight/config` reports the URIs the KERNEL dials — `http://indexer:8088/api/v4/graphql`,
`http://proof-server:6300` — and reports no node URI at all, so the page falls back to
`http://<page host>:9944`. Rewriting only the hostname (what this repo did until 2026-09-04) leaves
the CONTAINER port in place, which is right on the default layout and wrong on every
`pick-ports.sh` block: the wallet then dials `:9944`/`:8088` while the stack published `:41234`
and never syncs.

The frontend image closes that gap at container start. `compose/frontend.yml` passes
`NODE_HOST_PORT`, `INDEXER_HOST_PORT` and `PROOF_HOST_PORT` (defaulting to the container ports),
`images/zswap-da/docker-entrypoint-frontend.sh` writes them into `/config.js` as

```js
window.MIDNIGHT_HOST_PORTS = {"node":"41230","indexer":"41231","proof-server":"41232"};
```

and `images/zswap-da/browser-network-urls.patch` maps every reported URI through that table —
host to the page host, port to the published one, **scheme and path untouched**, so the kernel
stays the authority on the indexer's API version. On the default layout the table is the identity
map and nothing changes. `./verify.sh --frontend` asserts the served table matches the env file
in force, so a stack whose ports moved without its map is a FAILURE rather than a mystery.

The kernel API and the batcher were already covered a different way and still are:
`pick-ports.sh` emits `FRONTEND_API_BASE` / `FRONTEND_BATCHER_URL`, which the same `/config.js`
turns into `window.API_BASE` / `window.BATCHER_URL`.

At the template pin `400880ce` upstream has adopted a rewrite of its own in `getMidnightConfig` —
a `window.<SCREAMING_SNAKE>` full-URI override pass, then a hostname-only rewrite that keeps the
container port. The patch no longer inserts a rewrite; it *completes* upstream's, mapping the port
through the table above and synthesizing the missing `nodeUri` from it. An unmapped hostname keeps
its port, so upstream's behaviour is the fallback rather than something the patch overrides.

### The Faucet link, and the network id

Two more values move with the stack, for the same reason and by the same mechanism. Since upstream
[#922](https://github.com/effectstream/effectstream/pull/922) the SPA has no mint of its own, so
its top-nav **Faucet** link is the only way to get test tokens into the wallet it trades with. The
image renders it at container start:

```js
window.MIDNIGHT_NETWORK_ID = "undeployed";
window.FAUCET_HOST_PORT = "31765";
```

and `src/config.ts` composes `http://<page host>:31765/`, which the template's own `buildFaucetUrl`
turns into `…/?network=undeployed`. Both must be right or the link is useless in a way that looks
fine: upstream resolves the network id at BUILD time and defaults to **`preprod`**, and the faucet
site serves a *different registry per network* — a `preprod` link would open a page that knows
nothing about this chain's six issuers. `compose/frontend.yml` passes `FRONTEND_NETWORK_ID`
(default `undeployed`) and `FAUCET_PORT`; `FRONTEND_FAUCET_URL` overrides the whole origin with a
complete URL for a faucet behind a proxy or on another host.

### The in-page wallet's seed

`window.DEMO_WALLET_SEED` is the third value the entrypoint renders, and it is not a URL. Upstream's
`connectLocal()` generates a random 32-byte seed when it is not given one, so the demo wallet was a
brand-new EMPTY wallet on every page load. Since #922 removed the SPA's mint, an empty wallet is one
that can never acquire anything — the faucet site drives an injected extension wallet, and an
in-page wallet is not one. The stack therefore fixes it (`FRONTEND_WALLET_SEED`, wallet `demo-spa`),
the entrypoint refuses anything that is not 64 lowercase hex with **exit 78** (a truncated seed is a
DIFFERENT wallet, which looks exactly like "the mint did not work"), and `faucet-mint`'s default
`spa` grant prefunds it with one whole twETH — the token the poster WANTS, so the SPA can take a
poster offer immediately. `FRONTEND_WALLET_SEED=` restores the random wallet and
`FAUCET_MINT_GRANTS=` removes the grant.

`FAUCET_PORT` is injected whether or not the `faucet` profile is up, because the `frontend`
fragment deliberately does not depend on it — it mounts nothing of that profile's and compose
renders without it. On a stack brought up without `--with faucet` the link therefore points at a
reserved port nothing is serving; `up.sh` prints a WARN saying exactly that, and adding the profile
fixes it with no rebuild. `./verify.sh --frontend` asserts the injected network id and faucet port,
and when the faucet site answers it follows the composed link and requires a 200.

An extension wallet (Lace, Moth) is still limited to the default block — its `undeployed` preset
hardcodes `9944`/`8088`/`6300` and no page can change that. See
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

## One-command check (CI)

```bash
# The key must be in the PROCESS ENVIRONMENT, never in the env file — see below.
set -a; . "$HOME/.midnight-2-offers.coingecko.env"; set +a
./scripts/ci-check.sh                 # the whole chain, on ports nothing else is using
./scripts/ci-check.sh --core-only     # skip the evm and offerfiles profiles (no image builds)
./scripts/ci-check.sh --no-fund       # genesis wallets only
./scripts/ci-check.sh --keep          # on failure, leave the stack up for inspection
```

It generates its own env file (so it never touches your `.env` or the default ports), brings up
the profiles, funds the five non-genesis wallets, runs `verify.sh` **and**
`verify-wallets.sh --include-script-funded`, then tears everything down and asserts that nothing
survived. Exit 0 means both halves of that: the stack worked, and the machine is clean.

### Every service is exercised, and that is itself checked

Which gate step asserts what, per compose service, is
[docs/E2E-COVERAGE.md](E2E-COVERAGE.md) — generated from `config/e2e-coverage.json`, which
`scripts/verify-e2e-coverage.sh` reads in step 1. A new compose service with no row, a renamed
assertion, a one-shot whose only check is `exited 0`, or a long-running service with no
behavioural assertion all fail the gate offline. Read that document before adding a service.

The steps and their opt-outs:

| Step | What | Opt-out |
|---|---|---|
| 1 | offline artifact gates + the coverage matrix (and its self-test) | — |
| 2 | `up.sh --build --all`, then: **the `prices` profile really started** | `--no-prices` |
| 3 | `fund-wallet.sh --all-demo` | `--no-fund` |
| 3b | the **`fund` compose one-shot**, narrowed to one probe wallet by `FUND_ONLY_SEED` | `--no-fund-service` |
| 4a | `verify.sh --aa-mint --faucet-mint` | `--no-aa-mint`, `--no-faucet-mint` |
| 4b | `verify-source-pins.sh` | — |
| 4c | `verify-wallets.sh --include-script-funded` | with `--no-fund` |
| 4d | `verify-oneshots.sh --require-all` — every one-shot's OUTPUT assertion | — |
| 4e | `verify-spa-roundtrip.sh` — the SPA takes an offer through the batcher and makes one | `--no-spa-roundtrip` |
| 4f | `aa-e2e.sh` — the EVM-signed `execute` path | `--no-aa-e2e` |
| 5 | `down.sh -v`, asserted | — |

Three of those are minutes of real proving on a cold devnet (`--aa-mint`, `4e`, `4f`), which is
why the same assertions are OFF for a human typing `./verify.sh` and ON here. The run prints a
step table with per-step timings at the end, and every step's console output is also written to
`.ci-logs/<project>/<step>.log` (gitignored) so a failure can be read after the fact.

**`prices` is required, not optional.** Without a key, `up.sh --all` drops the profile (correctly
— see the CoinGecko section below) and `verify.sh` then skips the section, so the run would pass
having never started `price-feed`. `ci-check.sh` therefore refuses to start an `--all` run with
no `COINGECKO_API_KEY` in the environment, and asserts after bring-up that the container is
actually running. `--no-prices` is the explicit, visible opt-out. Put the key in the PROCESS
ENVIRONMENT and never in the file passed to `--env-file`: that file is regenerated by
`pick-ports.sh` before anything starts (infra issue 00013).

Its step 1 is a set of OFFLINE gates that need no daemon, no network and no registry — the
artifact-decision matrix, the fetch pins, the proof-server mirror record, the rendered compose
pins, and `verify-pin-defaults.sh`, which fails when any two defaults of one SOURCE pin
(`KERNEL_REF`, `SOLVER_REF`, `FRONTEND_REF`, `AA_REF`, `UMBRA_REF`, `SHIELDED_NIGHT_REF`,
`MINOCRAB_REF`) disagree anywhere in `compose/`, `images/`, `scripts/` or `.env.example`. It
covers two pins that are not commits at all and would otherwise go unchecked: the AA image's
`MINOCRAB_SUMS_SHA256` (a 64-hex release identity) and `MINOCRAB_RELEASE` (a `vX.Y.Z` tag) —
a pin with two values is not a pin whatever shape it has. That check exists
because the repository once shipped a split kernel pin, and every OTHER check compares a running
image against ONE of the copies — so the failure read as a stale image rather than as the
configuration defect it was. Each gate that has a `--self-test` runs it, so a check that stopped
biting is reported as a failure rather than passing vacuously.

`verify-compose-pins.sh` gained the combination `core offerfiles faucet poster`, which is the
pairing itself asserted: since the contract removal the poster mounts the `faucet-registry` volume
and waits on `registry-env` and `faucet-mint`, so `core offerfiles poster` alone CANNOT render —
which is correct, and is why it is not in the list. Its widest combination gained `poster` and
`prices` too. That last change fixed a latent defect in passing: the `--self-test` guard compared
the rendered combination against a hard-coded string that had lost `faucet` when that fragment was
added, so it never matched and `--self-test` always took the "no full-stack rendering" failure
branch instead of running the negative fixtures. It now compares against the last entry of the
list, so the two cannot drift apart again — a gate that stopped biting, caught by the rule above.

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

## The `prices` profile — and the one real secret in this repository

```bash
./up.sh --with offerfiles --with prices   # core + the kernel + the CoinGecko feed
./verify.sh --prices                      # REQUIRE the section (fail if the profile is not up)
./verify.sh --no-prices                   # skip it even when the profile is up
docker compose … run --rm price-feed --once   # one cycle now; exit 0/2/64
```

**The stack does not need it.** `migrations/000-init.sql` SEEDS real reference prices, so
`/v1/prices`, `/v1/quote` and the batcher's sponsorship gate all work — a fresh database quotes
1 WBTC ≈ 32 WETH from day one. The profile buys **fresh** prices, not working ones. That is why
it is opt-in here, and why upstream keeps its own copy behind `--profile prices`.

**`COINGECKO_API_KEY` is the only genuine secret this repository uses.** Every other "secret"
here — the wallet seeds, `SOLVER_STATUS_AUTH_TOKEN`, the Celestia auth token — is public dev
material and documented as such. This one is a third-party credential on a metered quota, so:

- it has **no default anywhere** — not in `compose/prices.yml`, not in a Dockerfile, not in
  `.env.example` (which carries the variable NAME and a warning, and no value);
- it lives only in the env file, which `.gitignore` already excludes (`.env`, `.env.*`, with
  `.env.example` the single exception);
- it travels as the `x-cg-demo-api-key` **header**, never as a query parameter — a query string
  lands in access logs, proxy logs, browser history and error reports;
- the service prints `key=present` / `key=ABSENT` at startup and never the value.

**What happens when it is missing**, and why it is spelled this way:

| Path | Behaviour |
|---|---|
| `./up.sh --with prices` | **refuses, before any container is created**, naming the variable and the env file in force (exit 2) |
| `./up.sh --all` | brings up everything EXCEPT `prices`, and says so on the run. This is what keeps `scripts/ci-check.sh` passing on a host with no key |
| `docker compose … up price-feed` by hand | the container starts, warns that it has no key, and IDLES — upstream's deliberate design: a non-zero exit under `restart: unless-stopped` is a crash loop, and the stack is perfectly usable on the seeded prices meanwhile |
| `./verify.sh --prices` | FAILS, naming which of the four things is wrong (container not running, no cycle ever completed, the cycle errored, or the rows are still `seed`-sourced) |

The refusal is in `up.sh` and **not** as `${COINGECKO_API_KEY:?…}` in the compose fragment for a
measured reason: a profile here IS a fragment filename, `./down.sh` passes *every* fragment on
every teardown, and compose interpolates the whole file set on *every* command — so a
required-variable marker in `compose/prices.yml` would break `down.sh`, `ps`, `config` and every
`up.sh` for anyone without a key, including the teardown of a stack that is already running.
It is the same split `scripts/lib/common.sh` already makes for image pins: `require_digest_ref`
reports, `assert_image_pins` dies. Teardown must never depend on a value that only *starting*
something needs.

**What a cycle costs.** One `simple/price` request per cycle: the five seeded asset ids
(`bitcoin`, `ethereum`, `usd-coin`, `midnight-3`, `usdm-2`) are batched into a single call
(`PRICE_FEED_BATCH_SIZE`, default 50), and the default interval is 24 h. A cycle also runs
immediately at start, which is what `up.sh` waits for. A `429` stops a cycle where it stands and
keeps everything it already wrote.

## The `shielded-night` profile

```bash
./up.sh --with shielded-night      # core + this profile; nothing else is needed
./verify.sh --shielded-night       # REQUIRE the section (fail if the profile is not up)
./verify.sh --no-shielded-night    # skip it even when the profile is up
```

### What bring-up actually does, in order

1. **`shielded-night-fund`** (toolkit one-shot) waits for finality to move off genesis, then
   gives the deployer and the verify driver 10,000,000 NIGHT each and registers their DUST
   addresses, waiting until a *spendable* DUST UTXO exists. It **skips** a wallet that already
   holds NIGHT and DUST, so the second and later `./up.sh` runs cost seconds rather than
   minutes. On the ledger-9 line this step is not optional: a wallet holding NIGHT with no
   registered DUST cannot pay a fee at all, and the failure would surface inside transaction
   balancing with an error naming none of this.
2. **`shielded-night-deploy`** (one-shot, `restart: "no"`) waits for node block #1, the proof
   server and the indexer, then runs upstream's `npm --prefix contracts/v2 run deploy` with
   `MN_ENV=undeployed` and publishes `contract.json` to its named volume — temp file plus
   `mv`, so a reader can never see a half-written record. If a record is already there it
   JOINs and exits 0 without deploying. **That JOIN is entirely this deployment's**: upstream
   states outright that `deploy:v2` always deploys a NEW contract and that resumability belongs
   to the caller, so the presence of `contract.json` is the only thing standing between a
   `--force-recreate` and a second contract. The published record is upstream's own, plus the
   flat aliases this repository's consumers read (`address`, `networkId`, `name`, `symbol`,
   `decimals`, `commit`) and the deployer's role.
3. **`shielded-night`** (nginx) starts only on the one-shot's
   `service_completed_successfully`, blocks until it can read the address, writes `/config.js`
   — this stack's contract address **and** `UNDEPLOYED_PROTOCOL: "midnight-2.x"`, without which
   the page would load the ledger-v8 adapter against this ledger-9 chain — and execs nginx.
4. `up.sh` then waits for the container healthcheck **and reads the address back off the
   volume**, naming it in the summary line. `service_completed_successfully` alone is not
   enough: it is equally satisfied by a one-shot that took the JOIN path against a volume left
   over from a previous chain.

The first bring-up is the slow one — funding plus a real contract deploy proved on a cold
chain — which is why `SHIELDED_NIGHT_WAIT_TIMEOUT` defaults to 900 s rather than the core
services' 120–420 s.

### Redeploy semantics

The contract is deployed **once per stack**, and that is a correctness property rather than an
optimisation: the sNight token colour is derived from the contract address, so a silent
redeploy turns every sNight coin already minted into a different, unspendable token.

* `./up.sh` again, `--force-recreate`, a restarted deploy container → **same address**
  (the one-shot logs `JOIN: … already exists — NOT deploying a second contract`).
* `./down.sh` (no `-v`) → the volume survives with the chain; the same contract comes back.
* `./down.sh -v` → the volume goes with the chain, and the next bring-up deploys a **new**
  contract at a new address. That is the only supported way to get one.

After a redeploy the page must be restarted to pick the new address up, because the entrypoint
reads the volume once at container start. `./up.sh` orders this correctly on its own; if you
drop the volume by hand, `docker compose … restart shielded-night`.

### Locking — not available on the 2.x lane, and refused rather than ignored

`deploy-and-lock.ts` and `lock.ts` are the **1.x** tree's scripts. `contracts/v2` has no
counterpart, so on this profile `SHIELDED_NIGHT_LOCK=true` is **refused** by the deploy one-shot
(exit 78, with the reason) instead of quietly doing nothing. Locking dissolves the contract's
maintenance committee — a **one-way door** meant for hosted releases, after which no verifier
key and no rule can ever be changed again — and a throwaway devnet contract that dies with
`./down.sh -v` would gain nothing from it.

The v2 verifier needs no `--allow-unlocked` flag either. The 1.x script did (delivered as
upstream PR #12 for project 00007 Q8): by default it exited non-zero on an unlocked contract
*even when all 11 verifier keys matched*. `contracts/v2/scripts/verify-deployment.ts` reports
the maintenance-authority state and folds only the circuit-set, verifier-key and sealed-metadata
comparison into its exit code, so a deliberately unlocked devnet contract is information rather
than a failure and `images/shielded-night/entrypoint-verify.sh` trusts that exit status
directly.

### What the verify section asserts

`scripts/verify-shielded-night.sh`, in order: the page serves HTML; `/config.js` is the
**generated** one (upstream ships a placeholder, so a 200 proves nothing), carries *exactly* the
address on the volume **and** `UNDEPLOYED_PROTOCOL: "midnight-2.x"`; `index.html` loads it as a
classic script; the served bundle carries the baked PreProd address and the
`Local (undeployed · 2.x)` label the protocol switch produces; the deploy record names
`networkId=undeployed` and the fields the docs promise; all 33 ZK artifacts (11 circuits ×
prover/verifier/bzkir) answer from **`/contract/v2/shielded-night/`** with non-empty non-HTML
bytes; `compiler/contract-manifest.json` is served, names compactc 0.34.0 and covers all 11
circuits; a circuit that does not exist answers **404**, never the SPA shell; the on-chain
verifier keys equal the served ones 11/11; and a funded driver wallet distinct from the deployer
runs the *upstream* 2.x external-stack suite against this stack (`MN_EXTERNAL_STACK=1`,
`CV_ADDRESS` = this stack's contract, so it JOINS rather than deploying another) — four cases
including **both** round trips, atomic and two-step, with exact balance assertions.

**The artifact path is `/contract/v2/`, not `/contract/compiled/`.** On `main` the built site
carries both generations, and `contract/compiled/shielded-night` is the legacy **v1** (compactc
0.31.1) copy — which has no `compiler/contract-manifest.json` at all, because compactc only
began emitting one at 0.33. The compose healthcheck reads the v2 path for the same reason.

**Budget minutes for the round trips.** The equivalent 1.x tests take ~280 s; proving on the 2.x
line runs about 1.25–1.6× slower, and the whole four-case file runs rather than two selected
cases. The suite's own vitest config allows 10 minutes per test and 20 for the hooks, with
retries at **zero**.
