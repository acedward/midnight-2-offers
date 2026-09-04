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
| offer-poster (`--with poster`) | the container healthcheck (`/health` binds), then `/health` is READ: `degraded` is a WARN, `failed` is a failure | `/health` answers 200 while the poster is `starting` and while it is `degraded` (no DUST yet) — 503-ing on `degraded` would make Compose restart a container that is correctly waiting for NIGHT. So healthy proves only that the server bound, which happens after wallet sync + dust registration + the dust wait + the contract join (hence `POSTER_WAIT_TIMEOUT=900`). `./verify.sh --poster` is the gate that requires a real mint and a posted offer |

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
./verify.sh --poster     # require the poster section: state, mints >= 1, and lastOfferId present
                         #   in the KERNEL's book with a whole-coin give leg and a quoted want leg
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
(`4af102536f02f137b696a4734bd8c936eddf3672`) is such a move — it adds the token price
service's `asset_prices` / `price_feed_status` tables and `known_tokens.decimals`, with seeded
reference prices. A `postgres-data` volume older than that pin produces a stack where every
container is healthy and every quote is wrong. `scripts/verify-kernel.sh` asserts
`GET /v1/prices` returns the seeded asset table for exactly this reason, and its failure names
the fix.

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
| the deployed offer-files contract address | volume `<project>_offerfiles-deploy` | that same genesis |
| the batcher's accepted-but-unsubmitted inputs | volume `<project>_offerfiles-batcher` | that same genesis |
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

The block is 16 consecutive ports and every published endpoint is derived from its base, so a
new service means a new offset rather than a new fixed number. The current layout:

| Offset | Variable | Default in `.env.example` |
|---|---|---|
| +0 … +2 | `NODE_HOST_PORT`, `INDEXER_HOST_PORT`, `PROOF_HOST_PORT` | 9944 / 8088 / 6300 |
| +3, +4 | `EVM_RPC_HOST_PORT`, `EVM_WS_HOST_PORT` | 8545 / 10021 |
| +5, +6 | `KERNEL_HOST_PORT`, `BATCHER_HOST_PORT` | 9999 / 3334 |
| +7 | `CELESTIA_HOST_PORT` | 26658 |
| +8, +9 | `FRONTEND_HOST_PORT`, `AA_CONSOLE_HOST_PORT` | 10600 / 10700 |
| +10, +11 | `SOLVER_SINK_HOST_PORT`, `SOLVER_RELAY_HOST_PORT` | 10800 / 10801 |
| +12 | `SHIELDED_NIGHT_HOST_PORT` | 10900 |
| +13 | `SOLVER_FRONTEND_PORT` — the COW solver's monitor site | 10802 |
| +14 | `POSTER_HEALTH_PORT` — the offer poster's health/metrics/journal | 10803 |

The `prices` profile adds **no offset**: `price-feed` publishes nothing at all. It is a writer —
CoinGecko in, `asset_prices` out — and what it wrote is read back through the kernel's already
published `GET /v1/prices`.

Two ports are deliberately NOT in that table because they are never published: the shared
`postgres:5432`, and the COW solver's status listener `solver:9100`, which serves the solver's
entire internal state behind a Bearer and is read only by the monitor site over the compose
network. `scripts/verify-solver.sh` asserts `docker port <solver> 9100` is empty.

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

Its step 1 is a set of OFFLINE gates that need no daemon, no network and no registry — the
artifact-decision matrix, the fetch pins, the proof-server mirror record, the rendered compose
pins, and `verify-pin-defaults.sh`, which fails when any two defaults of one SOURCE pin
(`KERNEL_REF`, `SOLVER_REF`, `FRONTEND_REF`, `AA_REF`, `UMBRA_REF`, `SHIELDED_NIGHT_REF`)
disagree anywhere in `compose/`, `images/`, `scripts/` or `.env.example`. That check exists
because the repository once shipped a split kernel pin, and every OTHER check compares a running
image against ONE of the copies — so the failure read as a stale image rather than as the
configuration defect it was. Each gate that has a `--self-test` runs it, so a check that stopped
biting is reported as a failure rather than passing vacuously.

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
   server and the indexer, then deploys the contract and publishes `contract.json` to its
   named volume — temp file plus `mv`, so a reader can never see a half-written record. If a
   record is already there it JOINs and exits 0 without deploying.
3. **`shielded-night`** (nginx) starts only on the one-shot's
   `service_completed_successfully`, blocks until it can read the address, writes `/config.js`
   and execs nginx.
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

### Locking

`SHIELDED_NIGHT_LOCK=true` makes the one-shot run upstream's `deploy-and-lock.ts`, which
dissolves the contract's maintenance committee. That is a **one-way door** meant for hosted
releases: no verifier key and no rule can ever be changed again. A throwaway devnet contract
that dies with `./down.sh -v` gains nothing from it, so it is off by default — and `verify.sh`
asserts the authority state in **both** directions, failing if the contract is locked when
nobody asked for it.

Note that upstream's `verify-deployment.ts`, by default, exits non-zero on an unlocked contract
*even when all 11 verifier keys match*, because its own contract is "the code matches AND the
contract is immutable" — wrong for a throwaway devnet deploy, which is deliberately never
locked. Since shielded-night `ledger-v9` @ `30af63f3…` (project 00007 phase F2, upstream PR #12)
the script takes `--allow-unlocked`: the lock state is still measured and printed, but only the
verifier-key/circuit-set check decides the exit code, so `images/shielded-night/entrypoint-verify.sh`
now trusts that exit status directly instead of parsing stdout (project 00007 Q8/F2).

### What the verify section asserts

`scripts/verify-shielded-night.sh`, in order: the page serves HTML; `/config.js` is the
**generated** one (upstream ships a placeholder, so a 200 proves nothing) and carries *exactly*
the address on the volume; `index.html` loads it as a classic script; the deploy record names
`networkId=undeployed` and the fields the docs promise; all 33 ZK artifacts (11 circuits ×
prover/verifier/bzkir) answer with non-empty non-HTML bytes; `compiler/contract-manifest.json`
is served, names compactc 0.34.0 and covers all 11 circuits; a circuit that does not exist
answers **404**, never the SPA shell; the on-chain verifier keys equal the served ones 11/11;
and a funded driver wallet distinct from the deployer completes **both** round trips — atomic
and two-step — with exact balance assertions, by running the *upstream* integration suite
against this stack (`MN_EXTERNAL_STACK=1`).

**Budget minutes for the round trips.** The same two tests take ~280 s against the 1.x triple
and were measured at 487–537 s in the `ledger-v9` branch's own CI: proving on the 2.x line runs
about 1.25–1.6× slower.
