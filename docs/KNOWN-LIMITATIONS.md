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

## The ledger-v9 kernel re-pin (2026-09-03), and the contract removal on top of it

- **⚠ An existing `postgres-data` volume must be wiped.** The pin moves
  `migrations/000-init.sql` (the token price service's `asset_prices`,
  `price_feed_status` and `known_tokens.decimals`, with seeded reference prices), and the
  kernel applies that file only on an EMPTY database — it has no migration path for a database
  that already exists. A stale volume produces a stack where every container is healthy and
  every quote is wrong. `scripts/verify-kernel.sh` asserts `GET /v1/prices` returns the seeded
  asset table so the situation is loud, and the fix is `./down.sh -v && ./up.sh …`.
- **⚠ The offer-files CONTRACT is gone, and that needs the same wipe for a second, independent
  reason.** Kernel PRs #69/#70 (merged by #71, which is the `5d794f9…` pin) deleted it: no
  `packages/contracts-midnight`, no `mint_shielded`/`mint_unshielded`, no compactc in the kernel
  image, and no `contractAddress` in `GET /v1/midnight/config`. The `offerfiles-deploy` and
  `register-tokens` services are gone, and so is the `offerfiles-deploy` volume — which an upgrade
  cannot tidy away for you: compose leaves it orphaned, and any colour derived from that address
  stays in the database naming a contract nothing can call. `aa-out` and `faucet-registry` go for
  their own reasons; see [OPERATIONS.md](OPERATIONS.md#full-reset).
- **`--with offerfiles` is no longer a useful stack on its own.** The kernel comes up and serves an
  empty book, because nothing in that profile can create a token any more. `--with poster` is
  stricter still: it needs `--with faucet` and `up.sh` refuses the pair without it (exit 2). The
  smallest useful combination is `./up.sh --with faucet --with offerfiles`.
- **Decimals are per token, and "6 everywhere" is now actively wrong.** Amounts in the book are
  base units at each token's own scale: twBTC 8, twETH 18, twUSDC 6, twUSDM 6, utwUSDC 6, utwBTC 8.
  The kernel's `known_tokens.decimals` still carries `DEFAULT 6` with a comment claiming that is
  universal; `registry-bridge` sends each real value explicitly, so the registry is right and the
  comment is stale. The `frontend` profile's zswap-da SPA is pinned to a template that reads and
  writes WHOLE COINS against a 6-decimal assumption, which predates these six tokens — a display
  concern, and re-pinning it is a separate change. Any external client that predates the re-pin —
  a saved curl, a script holding base units — is the thing that needs updating.
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
- **The AA console's token set moved, and it no longer derives a colour at all.** It used to
  compute `rawTokenType(domainSepFromName(name), offerFilesContractAddress)` with the address read
  from `GET /v1/midnight/config`; both halves are gone. It now reads
  `${AA_FAUCET_URL}/metadata.undeployed.json` and takes symbol, colour, decimals, privacy and the
  per-token ISSUER ADDRESS out of it — six tokens, one contract each — and its faucet, fund and
  send actions call each issuer's own `mint` circuit. Three consequences. The tokens the console
  offers are named `twBTC`/`twETH`/… rather than `wBTC`/`wETH`/`wUSD`, and its UI defaults became
  positional ("the Nth token of this family, in registry order") rather than those literals. The
  console no longer registers names in the kernel — it used to POST every token with a hardcoded
  `decimals: 6`, wrong for four of the six, and `registry-bridge` owns `known_tokens` now. And the
  `aa` profile's swap panel needs the `faucet` profile to have tokens at all. Nothing about
  deposits, withdrawals or the EIP-712 action set changed: the Manager only ever saw 32 raw colour
  bytes.
- **The AA images are pinned to mint-test-tokens as well now, and that pin must match the faucet's
  exactly.** The console loads the issuers' COMMITTED generated modules, copied into the
  image and never recompiled, because those exact bytes are the ones whose verifier keys the
  `faucet` profile registered on chain. `MINT_TEST_TOKENS_REF` in `compose/aa.yml` and in
  `compose/faucet.yml` must be the same commit; `verify-source-pins.sh` asserts
  `/aa/.mint-test-tokens-commit` on both AA images, because an AA image built from a different
  commit would prove against keys this stack never deployed and nothing else would notice.
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
- **sNight is named in the kernel's registry by a direct `UPDATE`, because the API has no
  update route.** The kernel serves only `GET` and `POST /v1/known-tokens`, and the schema
  always seeds a `SNIGHT` row, so the POST always answers 409. `shielded-night-register`
  therefore issues one `UPDATE known_tokens SET token_color=… WHERE name='SNIGHT'` — the exact
  command the kernel's own `000-init.sql` prints for this situation — and then re-reads the row
  through the API. Two consequences worth knowing: this repository writes one row of a table the
  kernel owns, and the registration only happens when the `offerfiles` profile is up (with no
  kernel the one-shot exits 0 after saying so, and sNight simply has no name anywhere). The real
  fix is an upsert route upstream; it is recorded as a follow-up rather than done here, because
  the kernel pin is deliberately frozen for this project.
- **The solver sink is internal, and that is a deliberate loss of a debugging surface.** Its feed
  page (`:10800`) and its relay-inspection port (`:10801`) were removed on 2026-09-04 so the
  monitor site is the ONE page about the solver. The sink still holds the only proof that nothing
  was ever sent to the solver (`framesSentToSolver == 0`), and `./verify.sh --solver` still asserts
  it — through `docker exec`, not a host port. To look at it by hand:
  `docker exec $(docker ps -q -f label=com.docker.compose.service=solver-sink) bun -e 'console.log(await (await fetch("http://127.0.0.1:8080/api/snapshot")).text())'`.
  Block offsets +10 and +11 of `pick-ports.sh` are now unused rather than renumbered, on purpose:
  renumbering would have moved every port above them on every existing stack.
- **`packages/solver/config/ladders.dev.json` inside the solver image names PREPROD colours, and
  is inert on this stack.** It is harmless, and it is recorded here because a reader who finds it
  will reasonably mistake it for configuration and try to "fix" it. Measured at this pin: the
  ladders the solver PUBLISHES are derived from the kernel's BOOK (`deriveLadderPush` over
  `cache.book.all()`), and the identifiers on the wire are the book offers' own lower-cased 64-hex
  colours — so a colour minted minutes ago quotes fine. The config file is consumed only by
  `packages/solver/src/engine.ts`, which nothing in `run.ts` or `swap-job-executor.ts` imports at
  this commit, and `SOLVER_LADDER_CONFIG` left unset is a WARNING, never a refusal. Nothing in
  `packages/solver` or `packages/solver-core` consults `known_tokens` at all. Upstream's
  `solver-provision` one-shot is deliberately NOT in this stack either: it would require funding
  the solver wallet with NIGHT and DUST, which this demo's observation-mode solver does not have,
  and upstream states plainly that the solver "needs NO swap-token inventory to quote or settle
  whole-maker rungs. It needs NIGHT/DUST, and that is all." `registry-env` renders
  `SOLVER_PROVISION_TOKEN_IN`/`_OUT` regardless, so an operator who does enable it has the ids.
- **The `poster` profile only works on `undeployed`,** and now needs `--with faucet` as well as
  `--with offerfiles`. It used to mint through the offer-files contract's permissionless dev faucet
  circuit; that circuit is gone, so both of its token ids come from `registry-env`'s
  `stack-tokens.env` on the `faucet-registry` volume and its coins come from `faucet-mint`. Its
  seed is public like every other seed here, and it must never be scaled past one replica — two
  wallet facades on one seed against one node force each other's connection down, which is also
  why it waits for `faucet-mint` to COMPLETE rather than merely to start.
- **The offer poster's inventory is FINITE, and `insufficient_inventory` is a normal steady-state
  failure if three numbers are mis-sized.** It selects a coin worth exactly
  `OFFER_POSTER_GIVE_AMOUNT` and never creates or splits one, and a coin is tied up from the moment
  it is offered until the wallet releases it (`OFFER_POSTER_TTL_MINUTES`) or a taker spends it — so
  steady state needs about `TTL_MINUTES × 60000 / OFFER_POSTER_INTERVAL_MS` coins. The demo
  defaults (4 coins, a 5-minute tick, a 10-minute TTL) leave roughly two in flight, with headroom.
  When it does run out, `degraded: insufficient_inventory` is the honest report and not a fault to
  retry away: **a restart cannot create inventory**, and nothing in this deployment mints on
  demand. `./verify.sh --poster` fails on it and names `FAUCET_MINT_POSTER_COINS`,
  `OFFER_POSTER_INTERVAL_MS` and `OFFER_POSTER_TTL_MINUTES` along with the live `freeCoins`.
  Raising the TTL makes starvation MORE likely, not less, which is the one counter-intuitive part.
- **The poster's health document lost its `mints` field.** `poster-health.ts` reports no `mints`
  and no `offer_poster_mints_total` metric at this pin. The successors are `inventoryAdoptions`,
  `reoffers`, `freeCoins`, `candidates` and the metrics
  `offer_poster_inventory_adoptions_total` / `offer_poster_free_coins`. A dashboard or scrape
  config that predates the re-pin reads zeros, not errors.
- **The `price-feed` service is OPT-IN, and off by default.** Without `--with prices` the stack
  quotes from the CoinGecko values `000-init.sql` seeded on 2026-09-02: real ratios, but static.
  The profile needs `COINGECKO_API_KEY` — the only genuine secret this repository uses — and
  internet access at runtime, so `./up.sh --all` skips it (out loud) when no key is set, and
  `./up.sh --with prices` refuses to start without one. A key is never defaulted, never baked
  into an image and never committed; it travels as the `x-cg-demo-api-key` header.
- **The price feed refreshes ASSETS, not colours.** What decides that a colour means `bitcoin` is,
  in order: the `asset_id` on its `known_tokens` row, then `PRICE_FEED_MAP`, then the built-in name
  map. A colour with none of those stays unpriced no matter how often the feed runs. Naming is
  `registry-bridge`'s job now — `register-tokens` went with the contract — and on a fresh database
  it works by re-pointing the kernel's own SEEDED rows, which is what preserves their `asset_id`.
  `PRICE_FEED_MAP` is also read by the NODE only: `packages/price-feed` fetches `SEEDED_ASSET_IDS`
  and ignores it.
- **A running feed does not guarantee fresh prices.** A provider outage, a `429` or a lost key
  leaves the last good rows in place — nothing is ever deleted — so the failure mode is STALE,
  not missing, and it is silent unless you look: `./verify.sh --prices` is what turns it into a
  failure (`PRICES_MAX_AGE_S`, default 3600 s). On the default 24 h interval a long-lived stack
  needs that limit raised, or `PRICE_FEED_INTERVAL_MS` lowered.
- **The KERNEL image has no compactc any more, and the AA image is the only one that still takes
  its compiler pin from the kernel tree.** Kernel PR #70 deleted the `compact` build stage along
  with the contract, and `images/offerfiles-kernel` now asserts its own absence at build time
  (`test ! -e /app/packages/contracts-midnight`, `! command -v compactc`). `verify-source-pins.sh`
  asserts the
  same thing on a live stack — the kernel image must carry NO `/app/.compactc-version` — and its
  "one toolchain" check compares the two AA images to each other, because there is no kernel-side
  version left to compare them against. What the kernel image does bake is
  `/app/.compact-runtime-version`, from the root manifest's override; upstream's one live compact
  fact is `bun run check:compact-runtime`, exactly one `@midnight-ntwrk/compact-runtime@0.19.0`
  resolving across the workspace.

  The AA image still reads its compiler pin (`0.34.0`) and the release hashes out of the fetched
  kernel tree — `infra/compact-version.txt` and `infra/compact-checksums.sha256` survive there but
  are ORPHANED, read by nothing upstream — and it still loads everything it compiles with ONE
  `compact-runtime`, because two runtime copies in one process fail `instanceof` and generated code
  opens with `checkRuntimeVersion()`. **The constraint gained a third party.** The console now also
  loads mint-test-tokens' COMMITTED artifacts, so the image asserts that the copied artifacts'
  `compiler/contract-info.json` `runtime-version` equals the installed runtime, and its
  compactc-vs-runtime expectation moved from the kernel's deleted `contract-offer-files/package.json`
  to mint-test-tokens' `contracts/v2/package.json`. **The AA pin, the kernel pin and the
  mint-test-tokens pin cannot be moved independently.** The build fails closed on any disagreement.

## The AA Manager's `execute` circuit comes from an unaudited third-party compiler

This is the single most important caveat in this repository, and it is the DEFAULT, so it is
stated here rather than left to a build flag nobody reads.

- **`execute` is compiled by MinoCrab, not by `compactc`.** By default (`AA_ZKIR_SOURCE=minocrab`)
  the AA image takes the Manager's `execute` ZKIR and keys from
  [acedward/AA-midnight-evm-experiment-minocrab](https://github.com/acedward/AA-midnight-evm-experiment-minocrab)
  release `v0.2.0` — the same contract transcribed into MinoCrab, a third-party Rust eDSL
  compiler for Midnight. It buys a real thing: k = 18 / 211,047 rows instead of k = 19 / 382,780,
  which halves the proving key (544 MiB rather than 1.14 GB) and roughly halves proving time,
  and it is why the console's proof server stops being OOM-killed on a memory-tight host.
- **MinoCrab is UNAUDITED and the equivalence is TESTED, NOT PROVEN.** The port's own differential
  suite compares it against the `compactc` artifact for the same contract commit — 59 tests, 26
  scenarios, 5,128 tamper probes, 0 acceptance disagreements — plus 7/7 proved selectors and
  14/14 preimage accepts at the previous pin. That is evidence. Evidence is not a proof, and a
  wrong circuit in a custody contract is a wrong circuit. **Dev chains only.** Do not put this on
  anything that holds value.
- **What IS mechanically guaranteed** is only the identity of the bytes: the image asserts
  `sha256(SHA256SUMS) == MINOCRAB_SUMS_SHA256` (the pin in this repository), verifies every file
  it takes against that `SHA256SUMS`, and asserts the release manifest's contract pin equals
  `AA_REF` — so it cannot silently deploy keys for a different contract. None of that says the
  circuit is correct.
- **The other eight circuits stay compactc's** by default, deliberately: `execute` is the one
  with end-to-end proving evidence, and it is the only one where k moves. `AA_ZKIR_SOURCE=minocrab-all`
  opts into all nine and is gated by hashes alone. `AA_ZKIR_SOURCE=compactc` opts out entirely,
  and `./verify.sh --aa` reports which one is live rather than assuming.
- **Changing it is KEY-BREAKING.** A contract is deployed with one verifier key; proofs made
  against another are rejected. Switching `AA_ZKIR_SOURCE` needs `./down.sh -v` and a redeploy.

## The `faucet` profile

These are properties of the upstream site, of the kernel's registry API and of the 2.x line —
not defects introduced here. Everything the automated gates *can* prove, they prove; this is the
honest list of what they cannot.

- **The browser cannot mint on a stack this repository drives, and that is upstream's design.**
  The faucet site discovers DApp Connector API 4.x wallets: it has **no in-page wallet**, it
  delegates proving to whichever wallet is connected, and it submits the exact bytes wallet
  balancing returned. A headless browser with no injected `window.midnight` extension can load
  the page, select `undeployed`, read the registry and see six ready tokens — and every mint
  control stays unavailable, correctly. The automated mint evidence is therefore
  `faucet-mint-test` (`./scripts/verify-faucet.sh --mint`), which runs upstream's own
  `contracts/v2/mint-wallet-test.ts`: it mints to a **second** wallet and waits for that wallet
  to discover the balance through its regular chain scan, so it proves the encrypted-output path
  a real wallet depends on rather than merely that a transaction was accepted. Since the contract
  removal the `faucet-mint` one-shot makes the same claim on **every** bring-up, for the wallets
  the demo actually uses: it mints each recipient's shortfall and then waits for that recipient's
  own wallet to see the balance. `--mint` remains the isolated, opt-in version of the proof.
- **An EXTENSION wallet only reaches the stack on the DEFAULT port block.** Same limitation the
  `shielded-night` profile has, for the same reason: an extension's `undeployed` preset
  hardcodes node `9944`, indexer `8088`, proof-server `6300`, and nothing this stack serves can
  change what a browser extension dials. A stack from `scripts/pick-ports.sh` is unreachable
  from it. The runner-based mint test passes on any port block, so this affects the hand test
  only.
- **The six tokens are NOT 6 decimals.** `twBTC`/`utwBTC` are 8 and `twETH` is 18. Every earlier
  faucet in this repository minted 6-decimal tokens and whole coins × 10⁶, and the kernel's
  `known_tokens.decimals` still carries `DEFAULT 6` with a comment asserting that is universal.
  `registry-bridge` sends each token's real value explicitly, so the *registry* is right — but
  any demo amount, quote assertion or UI display that assumed 6 has to be re-read against the
  registry. `scripts/verify-faucet.sh` asserts the real values, so a regression to 6 fails a gate.
- **The six local symbols reach the kernel UPPER-CASED, and pricing depends on it.**
  `POST /v1/known-tokens` normalises with `String(name).trim().toUpperCase().slice(0, 16)`, so the
  kernel holds `TWBTC` and never `twBTC`; `name` is `UNIQUE`, and the schema at this pin already
  SEEDS all six upper-case names — with their real decimals, their CoinGecko asset ids, and
  **PreProd** colours no local chain has. So every POST answers 409 and the `UPDATE … WHERE name`
  lane is the normal path, not the exception. That UPDATE is case-SENSITIVE, which is why
  `registry-bridge` normalises on all three lanes (read, POST, UPDATE): sending the registry's own
  spelling matched no row and would have failed every bring-up after eight retries. Because the
  UPDATE re-points only `token_color`, `kind` and `decimals` and leaves `asset_id` alone, the
  seeded asset survives and a colour minted an hour ago is priceable. `scripts/verify-kernel.sh`
  asserts the end of that chain: six names with decimals 8/18/6/6/6/8, and a `GET /v1/quote` that
  prices 1 twBTC → twETH with a positive suggested amount.
- **`PRICE_FEED_MAP` is a belt for one case only.** `compose/offerfiles.yml` defaults it to
  `TWBTC=bitcoin,TWETH=ethereum,TWUSDC=usd-coin,TWUSDM=usdm-2,UTWUSDC=usd-coin,UTWBTC=bitcoin`, and
  a fresh database never consults it, because the seeded `asset_id` wins. It matters on a
  `postgres-data` volume that PREDATES those seeds, where the bridge takes the POST lane and the
  row arrives with a NULL `asset_id` — the built-in name map knows `WBTC`/`WETH`/`USDC`/`USDM` and
  never the `TW*` spellings, so without the override those rows quote unpriced. `registry-bridge`
  still sends no `asset_id` itself, deliberately: `known_tokens.asset_id` REFERENCES
  `asset_prices(asset_id)`, a fabricated value would fail the foreign key or price a test token as
  something it is not, and the registry it reads carries no price opinion to pass on.
- **`registry-bridge` writes one `UPDATE` directly to postgres.** The kernel serves only
  `GET`/`POST` for `known_tokens`, its insert is `ON CONFLICT (token_color) DO NOTHING`, and
  `name` is `UNIQUE` — so a row whose NAME exists carrying a different colour answers 409 and
  cannot be corrected through the API at all. That is the case the kernel's own `000-init.sql`
  names `UPDATE known_tokens … WHERE name` as the remedy for, and it is the only SQL this profile
  writes. The end state is always re-read through the API. A kernel with an update route would
  remove this; so, more fundamentally, would a kernel that could import from
  `TOKEN_REGISTRY_BASE_URL` on `undeployed`, which is the follow-up worth having.
- **A killed deploy can leave a lock behind, and the tooling will not steal it.** Two writers
  could otherwise publish conflicting registries. Read the PID out of the `.lock`, confirm no
  such process is running, and remove it by hand — see
  [OPERATIONS.md](OPERATIONS.md#stale-locks). Likewise, a deploy call that timed out before
  returning an address leaves an **uncertain in-flight marker** and the next run refuses to
  submit again; that is a deliberate stop, not a bug.
- **The `runner` image ships `.git`, and it must.** Upstream's provenance gate shells out to
  `git rev-parse`, `git diff`, `git ls-files`, `git ls-tree` and `git show` on every deploy and
  every verify. Stripping it to save ~33 MB would break the property this profile is built on.

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
