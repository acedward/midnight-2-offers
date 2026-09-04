# Known limitations

## Behaviour and compatibility changes in the artifact refactor

These are not bugs; they are deliberate changes that will surprise anyone carrying a `.env`
or a script over from before the refactor. They are listed first because a silently ignored
control is worse than one that is gone.

- **`NODE_TAG`, `PROOF_TAG`, `TOOLKIT_TAG` and `AA_PROOF_TAG` are RETIRED.** External runtime
  images are now pinned by complete immutable digest through `NODE_IMAGE`, `TOOLKIT_IMAGE`,
  `PROOF_IMAGE` and `AA_PROOF_IMAGE`. A `.env` that still sets a `*_TAG` has **no effect** on
  which image runs; the scripts print a `WARN` naming the replacement rather than failing, so
  an old file still boots the stack — it just boots the pinned images. Setting a `*_IMAGE` to
  a *tag* is a hard error: there is no digest→tag fallback anywhere.
- **`INDEXER_PLATFORM`, `INDEXER_REPO`, `INDEXER_REF` and `INDEXER_RUST_VERSION` are RETIRED**
  (they went with the Rust build). The indexer installs a published warehouse executable for
  the building machine's own architecture; `56561b2f…` survives as recorded provenance, not as
  a fetch or compile input. `WAREHOUSE_REPO`, `WAREHOUSE_RELEASE` and `INDEXER_VERSION` say
  *which release*, never *which bytes*. These four also `WARN` and are ignored.
- **Proof-cache initialization is now a MANDATORY startup dependency.** Every proof server
  gates on the `proof-params-init` one-shot completing successfully, so a proof server will
  not start if the shared proof-data generation cannot be downloaded and verified. Previously
  each server started immediately and fetched proof data lazily on its first proof. The first
  `up` (and the first after `./down.sh -v`) therefore costs ~223 MB and about a minute;
  afterwards the one-shot returns `NOOP` in seconds. If a proof server never appears, read
  `docker compose … logs proof-params-init` first — it is what gates them.
- **`./down.sh -v` now also wipes the proof-data cache**, because it is a project-wide wipe
  and a teardown that leaves something behind is not a teardown. Plain `./down.sh` keeps it.
- **Both proof servers come from `ghcr.io/effectstream/midnight-proof-server`**, not Docker
  Hub. The bytes are identical (exact mirror, re-provable offline), but a network policy or
  registry mirror that allowlists `docker.io` only will now need `ghcr.io` as well.
- **The indexer and Celestia builds depend on a development-only MUTABLE GitHub release.** A
  warehouse re-upload under the same asset name fails the build with no change in this
  repository. That is the pinned-hash guarantee working, not a regression.

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
- **The umbra-evm source is commit-pinned.** `UMBRA_REF` defaults to full commit
  `5a46348585ae23994cc408a06f6ef18a78b06273` from `evm-compat`, and
  `/app/.umbra-commit` is verified by the CI provenance gate. The WS bind and `newHeads`
  fixes are merged upstream; this image applies no source patches.
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
- **The plain `9.0.0-rc.5` proof server is the zkir-v2 build.** Circuits compiled to zkir-v3
  (per-primitive native crypto gates) need the experimental variant instead — that is what the
  `aa` profile's own internal server is for. Both are running whenever `--with aa` is up, so
  the usual fix is to send the request to `aa-proof-server:6300` rather than to change an image.
  **`GET /proof-versions` cannot tell you which build you are talking to**: it answers
  `["V2","V3"]` on both, because it reports the proof wire format and not the compiler lane.
  The reliable discriminator is behavioural — the plain server rejects a zkir-v3-compiled
  circuit at `/check`, which is exactly the control `images/proof-params/tests/zkir-fixture/`
  runs.
- **Boolean proof-server environment knobs need literal `true`/`false`.**
  `MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS=1` does not mean "on"; rc.5 aborts at startup. In
  addition to the documented endpoints, rc.5 also serves `GET /proof-versions` and `POST /k`.
- **The shared proof cache covers SRS and Ledger-static only, by design.** A contract's own
  proving key is not cacheable across circuits, so a contract-circuit proof carries its
  proving data in the request while the SRS comes from the read-only generation. That is why
  the cache is one noarch copy for both variants and why no contract key ever enters it.
- **Indexer `4.4.0-rc.3` has no public Docker Hub manifest.** It is not compiled either: the
  repository installs the published `indexer-standalone` executable from the
  `effectstream/binaries@0.3.120` warehouse, verified against the cataloged SHA-256 of both the
  archive and the executable inside it. That release contains the upstream standalone SQLite
  deadlock fix missing from rc1, and full commit `56561b2f5cf5c6839f678257fc69bed1a8b9ba2c` is
  recorded in the image as provenance rather than used as a build input.
  The warehouse publishes **both** `linux-amd64` and `linux-arm64`, so the old
  `platform: linux/amd64` pin is gone and Apple Silicon builds and runs this natively. The
  indexer is no longer the slowest service to build.
- **The binary warehouse is development-only and mutable.** `effectstream/binaries@0.3.120` can
  re-publish an asset under the same name, so the pinned SHA-256 values — not the URL and not the
  version string — are what identify the indexer and Celestia binaries. A byte change fails the
  build before anything is installed, which is the intended behaviour, but it does mean a build
  can start failing without anything in this repository having changed.
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

## The ledger-v9 kernel re-pin (2026-09-03)

- **⚠ An existing `postgres-data` volume must be wiped.** The pin moves
  `migrations/000-init.sql` (the token price service's `asset_prices`,
  `price_feed_status` and `known_tokens.decimals`, with seeded reference prices), and the
  kernel applies that file only on an EMPTY database — it has no migration path for a database
  that already exists. A stale volume produces a stack where every container is healthy and
  every quote is wrong. `scripts/verify-kernel.sh` asserts `GET /v1/prices` returns the seeded
  asset table so the situation is loud, and the fix is `./down.sh -v && ./up.sh …`.
- **Every token now has 6 decimals and faucets mint whole coins.** Amounts in the book are
  whole coins × 10⁶. The `frontend` profile's zswap-da SPA is re-pinned to a template that
  reads and writes WHOLE COINS, so a 1-coin offer reads `1 WBTC` rather than `1000000`. Any
  external client that predates the re-pin — a saved curl, a script holding base units — is the
  thing that needs updating now, not the SPA.
- **The SPA's in-page wallet now works on any port block — but only through the page's own
  `/config.js`.** `GET /v1/midnight/config` reports the URIs the KERNEL dials: compose
  hostnames on CONTAINER ports, and no node URI at all. The image injects
  `window.MIDNIGHT_HOST_PORTS` (compose hostname → published host port) at container start and
  the SPA maps every reported URI through it, so a `scripts/pick-ports.sh` stack is fully
  usable in a browser. Two things follow. Serving `dist/` from anything other than this image —
  a CDN, `vite preview`, a hand-copied build — loses the map and the page falls back to
  `:9944`/`:8088`/`:6300`. And the map is keyed by the compose SERVICE NAME (`node`, `indexer`,
  `proof-server`): renaming a service in `compose/core.yml` without updating
  `images/zswap-da/docker-entrypoint-frontend.sh` silently stops the mapping.
  `./verify.sh --frontend` asserts the served map matches the stack's ports.
- **The AA console's shielded token colours moved.** The console used to derive them from
  private domain separators, which produced a `wBTC` no other component in the stack could
  mint or take. It now uses the faucet's own `domainSepFromName`, so console, offer poster,
  `register-tokens` and the SPA faucet all mean ONE colour per name — and both legs price
  against real reference rates. Breaking only in the sense that the colours differ from a
  previous stack's; they already differed after every `./down.sh -v`, which this pin requires.
- **The solver's status token is public.** `SOLVER_STATUS_AUTH_TOKEN` has a fixed default in
  `compose/solver.yml`, exactly like `SOLVER_RELAY_AUTH_TOKEN` and every other secret in this
  repository. It must exist (the solver refuses a value under 32 characters) but it only
  guards the compose network, because `:9100` is never published. If you uncomment that ports
  block for a debugging session, change the token first — `/status/*` is the solver's entire
  internal state.
- **The monitor site has no authentication of its own.** It binds `BIND_ADDR` (127.0.0.1) like
  everything else here. Put a reverse proxy in front of it before it reaches any wider network,
  and note that its SSE feed needs response buffering off and a read timeout longer than the
  five-minute stream lifetime.
- **The `poster` profile only works on `undeployed`,** and needs `--with offerfiles`: it mints
  through the offer-files contract's permissionless dev faucet circuit, which exists for this
  devnet. Its seed is public like every other seed here, and it must never be scaled past one
  replica — two wallet facades on one seed against one node force each other's connection down.
- **The `price-feed` service is OPT-IN, and off by default.** Without `--with prices` the stack
  quotes from the CoinGecko values `000-init.sql` seeded on 2026-09-02: real ratios, but static.
  The profile needs `COINGECKO_API_KEY` — the only genuine secret this repository uses — and
  internet access at runtime, so `./up.sh --all` skips it (out loud) when no key is set, and
  `./up.sh --with prices` refuses to start without one. A key is never defaulted, never baked
  into an image and never committed; it travels as the `x-cg-demo-api-key` header.
- **The price feed refreshes ASSETS, not colours.** `PRICE_FEED_MAP` and the built-in name map
  are what decide that `WBTC` means `bitcoin`; a colour whose name is unknown stays unpriced no
  matter how often the feed runs. Naming is `register-tokens`' job.
- **A running feed does not guarantee fresh prices.** A provider outage, a `429` or a lost key
  leaves the last good rows in place — nothing is ever deleted — so the failure mode is STALE,
  not missing, and it is silent unless you look: `./verify.sh --prices` is what turns it into a
  failure (`PRICES_MAX_AGE_S`, default 3600 s). On the default 24 h interval a long-lived stack
  needs that limit raised, or `PRICE_FEED_INTERVAL_MS` lowered.
- **The AA image is still pinned to `AA_REF=713a2021…`,** six commits behind its `main`. The AA
  repo moved to compactc 0.34.0 / compact-runtime 0.19.0, and this image compiles the AA
  contracts AND the kernel's offer-files contract with ONE compactc and loads both with ONE
  runtime — while the kernel line still declares 0.33.0-rc.2. Moving AA alone would compile the
  offer-files contract with a different toolchain than the kernel deploys. The image now fails
  the build loudly if the kernel leaves the 0.33 line, rather than doing it silently.

## The `shielded-night` profile

These are properties of the upstream dApp and of the 2.x line, not defects introduced here.
Everything the automated gates *can* prove, they prove; this section is the honest list of what
they cannot.

- **The browser flow is not automatable, and that is by design.** The page has no in-page
  wallet: it enumerates `window.midnight.*` (dApp-connector 4.x) and **refuses a wallet that
  does not implement `getProvingProvider`**, because proving is wallet-owned — the page never
  names or reaches a proof server. So a headless browser cannot exercise a conversion, and the
  automated proof that the contract works comes from upstream's own Node-side integration
  suite, run against this stack (`./verify.sh --shielded-night`). The browser path is a hand
  test; see [WALLETS.md](WALLETS.md#browser-hand-test-night--snight-with-the-moth-wallet).
- **An EXTENSION wallet only reaches the stack on the DEFAULT port block.** An extension's
  `undeployed` preset hardcodes node `9944`, indexer `8088`, proof-server `6300`, and nothing
  this stack serves can change what a browser extension dials. A stack from
  `scripts/pick-ports.sh` is therefore unreachable from it. The driver-based `verify.sh` section
  passes on any port block, so this affects the hand test only. It is NOT shared with the
  `frontend` profile any more: that SPA's own in-page wallet learns the published ports at
  runtime (see the `frontend` note above).
- **On the 2.x line the wallet must also speak ledger-v9.** The wallet measured to do so is
  Moth, built from [`shieldedtech/moth-wallet` PR #30](https://github.com/shieldedtech/moth-wallet/pull/30)
  (`feat/ledger-v9-support`). A ledger-v8 wallet connects and then fails, because the ledger
  types it builds are not the ones the contract's state is decoded with.
- **`ProvingProvider.lookupKey` is a hole in the connector API, and the dApp fills it.**
  ledger-v9 widened `ProvingProvider` from `{check, prove}` to `{check, prove, lookupKey}`, and
  midnight-js 5's `createProofProvider` requires the wider shape — but
  `@midnight-ntwrk/dapp-connector-api` still declares only the narrow one, in `4.0.1` *and* in
  `4.1.0-beta.1`. When the connected wallet's proving provider has no `lookupKey`, the dApp
  supplies it from its own `zkConfigProvider`: **the same public artifacts it already serves at
  `/contract/compiled/shielded-night/` and already handed the wallet a line earlier**, so
  nothing leaks and `prove`/`check` stay untouched. The page logs which lane it took at
  `console.info`. Upstream question, recorded as project 00007 Q9.
- **The reverse path works only for coins minted in that browser.** Shielded balances reachable
  through the connector are aggregate only, and the SPA tracks the individual sNight coins it
  minted in that browser's `localStorage`. So sNight received from somebody else — or minted in
  another browser, or after clearing site data — cannot be unwrapped from the page. The
  contract has no such limitation: the Node-side round trips unwrap fine. Upstream limitation,
  not fixed here.
- **The contract is deployed once and is NOT locked.** `SHIELDED_NIGHT_LOCK=false` by default:
  locking dissolves the maintenance committee permanently, which is a one-way door meant for
  hosted releases. By default upstream's `verify-deployment.ts` exits non-zero on this stack's
  contract *even when all 11 verifier keys match* — its contract is "the code matches AND the
  contract is immutable" — so the verify container passes `--allow-unlocked`, which still
  measures and prints the lock state but folds only the verifier-key/circuit-set check into the
  exit code (project 00007 Q8, delivered as upstream PR #12; consumed here from `ledger-v9` @
  `30af63f3…`, project 00007 phase F2).
- **`./down.sh -v` changes the token.** The sNight colour is derived from the contract address,
  so a full reset does not merely redeploy: every sNight coin from the previous chain becomes a
  different, unspendable token. That is why the deploy is a JOIN-or-deploy one-shot and why
  only dropping the volume can force a new contract.
- **The round trips are slow on this line.** The two `verify.sh` round trips take ~280 s
  against the 1.x triple and were measured at 487–537 s in the `ledger-v9` branch's own CI —
  proving on 2.x runs about 1.25–1.6× slower. Budget minutes, and note that the branch itself
  had to raise its CI integration timeout from 60 to 150 minutes for the same reason.
- **The pin is a branch head, not a merge commit.** `effectstream/shielded-night`'s `ledger-v9`
  branch is deliberately long-lived: it merges into `main` when the network moves to 2.x
  ([PR #10](https://github.com/effectstream/shielded-night/pull/10)). Until then the pin here
  is a commit on that branch. It is a full 40-hex SHA and the image refuses anything shorter,
  so the pin is immutable even though the branch is not — but a reviewer looking for a merged
  upstream commit will not find one.
