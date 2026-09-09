# E2E coverage — which gate step exercises which service

`./scripts/ci-check.sh` (no flags) brings up **every** profile, funds, verifies and tears down.
This document is the answer to the only question that makes that meaningful: **for each service
this stack runs, what did the gate actually assert about it?**

It is generated from, and checked against, **`config/e2e-coverage.json`** — the machine-readable
matrix. Two scripts make it load-bearing rather than decorative:

| Script | When | What it fails on |
|---|---|---|
| `scripts/verify-e2e-coverage.sh` | ci-check **step 1**, offline | a compose service with no row; a row for a service compose no longer renders; a check naming a script that is not there or an assertion string that script no longer contains; a one-shot with no OUTPUT assertion; a long-running service with no behavioural check; a service missing from this document |
| `scripts/verify-oneshots.sh` | ci-check **step 4d**, live | a one-shot that is still running, exited non-zero, or exited **0 without printing what it was supposed to print** |

`./scripts/verify-e2e-coverage.sh --self-test` mutates the matrix six ways and requires the check
to fail on each, so a checker that has stopped biting is itself a failure.

## The three rules

1. **A one-shot needs an OUTPUT assertion, not `exited 0`.** Every one-shot here is idempotent and
   every one has a path where it correctly does nothing — `faucet-deploy` verifying an existing
   registry, `faucet-mint` skipping a satisfied grant, `shielded-night-deploy` joining the contract
   on the volume, `registry-bridge` exiting 0 when there is no kernel to teach. By exit code those
   are indistinguishable from a one-shot that hit its no-op branch for the wrong reason. So each
   one declares a `logPattern` and `verify-oneshots.sh` requires it in the container's own logs.
2. **A long-running service needs a behavioural assertion, not a healthcheck.** A healthcheck is
   written by the same person as the service. `faucet-site` and both SPAs answer HTTP 200 on every
   path (SPA fallback), so a 200 proves nothing — which is why the faucet's real assertion is that
   a **missing** artifact answers 404. Behavioural checks are marked **·B** below.
3. **A `profiles:`-gated service is never started by `up`,** so some gate step has to run it and
   the row has to name that step. Three services are in this class: `fund`, `faucet-mint-test` and
   `shielded-night-verify`.

## Gate steps

| Step | What runs | Opt-out |
|---|---|---|
| 1 | offline artifact gates + **`verify-e2e-coverage.sh`** (and its self-test) | — |
| 2 | `up.sh --build --all` — and, in `--all` mode, the assertion that the `prices` profile really started | `--no-prices` |
| 3 | `fund-wallet.sh --all-demo` | `--no-fund` |
| 3b | the **`fund` compose one-shot**, narrowed to one probe wallet by `FUND_ONLY_SEED` | `--no-fund-service` |
| 4a | `verify.sh` — every profile's section, plus `--aa-mint` and `--faucet-mint` | `--no-aa-mint`, `--no-faucet-mint` |
| 4b | `verify-source-pins.sh` — the running images carry the pinned commits | — |
| 4c | `verify-wallets.sh --include-script-funded` | with `--no-fund` |
| 4d | **`verify-oneshots.sh --require-all`** — every one-shot's OUTPUT assertion | — |
| 4e | **`verify-spa-roundtrip.sh`** — headless take + make through the batcher | `--no-spa-roundtrip` |
| 4f | **`aa-e2e.sh`** — register ×2 → mint → deposit → transfer → withdraw, four `execute` proofs | `--no-aa-e2e` |
| 5 | `down.sh -v`, asserted: containers, volumes, networks, unlabelled volumes, toolkit cache, CI image tags | — |

Every step's console output is also written to `.ci-logs/<project>/NN-<step>.log`.

## The matrix

**·B** marks a behavioural assertion — one that fails if the service is up but not doing its job.
`↳` rows are further assertions about the service above them.

#### `compose/core.yml` — profile `core`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `postgres` | service | 4a verify.sh | `scripts/verify-kernel.sh` | `kernel /v1/prices answers and the seeded asset table is present` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-evm.sh` | `eth_getLogs answers from Postgres (evm_rpc schema present)` **·B** |
| `node` | service | 4a verify.sh | `verify.sh` | `wait_finalized_advances` **·B** |
| `indexer` | service | 4a verify.sh | `verify.sh` | `indexer has indexed at least one block` **·B** |
| ↳ |  | 4a verify.sh | `verify.sh` | `indexer main database is running in WAL mode` |
| `proof-params-init` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/"result":"(NOOP\|ACTIVATED)"/` in its own logs, after `exited 0` |
| `proof-server` | service | 4a verify.sh --faucet-mint | `scripts/verify-faucet.sh` | `twUSDC minted and discovered by the recipient wallet` **·B** |
| ↳ |  | 4a verify.sh | `verify.sh` | `core: proof-server` |
| `fund` | on-demand | 3b fund compose one-shot | `scripts/ci-check.sh` | `fund compose one-shot funded the probe wallet` **·B** |
| ↳ |  | 4c verify-wallets.sh | `scripts/verify-wallets.sh` | `holds NIGHT and can pay fees` |

#### `compose/evm.yml` — profile `evm`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `evm-migrate` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/"module":"evm-migrate","event":"done"/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-evm.sh` | `eth_getLogs answers from Postgres (evm_rpc schema present)` |
| `evm-rpc` | service | 4a verify.sh | `scripts/verify-evm.sh` | `eth_chainId = ` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-evm.sh` | `eth_blockNumber tracks the indexer head` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-evm.sh` | `eth_subscribe(newHeads) delivered a header` **·B** |
| `wallet-monitor` | service | 4a verify.sh | `scripts/verify-evm.sh` | `monitored wallet(s) report a non-zero eth_getBalance` **·B** |

#### `compose/offerfiles.yml` — profile `offerfiles`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `celestia` | service | 4a verify.sh | `scripts/verify-celestia.sh` | `blob.Submit accepted` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-celestia.sh` | `the blob is NOT visible in a different namespace at the same height` **·B** |
| `kernel` | service | 4a verify.sh | `scripts/verify-kernel.sh` | `/v1/midnight/config carries no contract address (the kernel line is contract-free)` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-kernel.sh` | `kernel names all six local tokens with their real decimals` **·B** |
| `batcher` | service | 4a verify.sh | `scripts/verify-poster.sh` | `lastOfferId is in the kernel's open book` **·B** |
| ↳ |  | 4e spa-roundtrip | `scripts/verify-spa-roundtrip.sh` | `the batcher settled the take` **·B** |

#### `compose/poster.yml` — profile `poster`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `poster-fund` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/(poster funded with\|already funded — nothing to do)/` in its own logs, after `exited 0` |
| `offer-poster` | service | 4a verify.sh | `scripts/verify-poster.sh` | `poster state=ok` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-poster.sh` | `poster has used` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-poster.sh` | `give leg is exactly OFFER_POSTER_GIVE_AMOUNT` |

#### `compose/prices.yml` — profile `prices`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `price-feed` | service | 2 up --build --all | `scripts/ci-check.sh` | `the prices profile is up: price-feed is running` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-prices.sh` | `the feed has completed a cycle against this database` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-prices.sh` | `both legs of the quote are priced from the FEED (not the seed)` **·B** |

#### `compose/aa.yml` — profile `aa`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `aa-proof-server` | service | 4a verify.sh | `scripts/verify-aa.sh` | `artifact complete: addresses + both colours + both mint txs` **·B** |
| ↳ |  | 4f aa-e2e.sh | `scripts/aa-e2e.sh` | `four execute proofs` **·B** |
| `aa-deploy` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/wrote /aa/out/aa-contracts.json/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-aa.sh` | `manager zkir source` |
| `aa-console` | service | 4a verify.sh | `scripts/verify-aa.sh` | `aa-console takes its token set from the local mint-test-tokens registry` |
| ↳ |  | 4a verify.sh --aa-mint | `scripts/verify-aa.sh` | `console mint: one shielded and one unshielded token minted through the local issuers and deposited` **·B** |

#### `compose/faucet.yml` — profile `faucet`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `faucet-fund` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/the mint-test-tokens deployer is funded and fee-capable/` in its own logs, after `exited 0` |
| `faucet-deploy` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/is ready with 6 active deployments/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `registry status is ready` |
| `faucet-verify` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/OK: six issuers verified/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `six issuers verified: on-chain verifier keys, immutable metadata, derived token IDs,` **·B** |
| `registry-bridge` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/OK: six local tokens in the kernel registry/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `is named in the kernel registry` **·B** |
| `registry-env` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/stack-tokens\.env rendered/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `stack-tokens.env carries a 64-hex id for all six symbols` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `stack-tokens.env carries the registry decimals for all six symbols` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `the poster's give leg is the id registry-env rendered` **·B** |
| `faucet-mint` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/OK: the demo wallets hold their local test-token inventory/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-poster.sh` | `poster has used` **·B** |
| ↳ |  | 4e spa-roundtrip | `scripts/verify-spa-roundtrip.sh` | `the spa grant is in the SPA wallet` **·B** |
| `faucet-site` | service | 4a verify.sh | `scripts/verify-faucet.sh` | `GET / serves an HTML document` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-faucet.sh` | `a missing artifact answers 404, not the SPA fallback` **·B** |
| `faucet-mint-test` | on-demand | 4a verify.sh --faucet-mint | `scripts/verify-faucet.sh` | `twUSDC minted and discovered by the recipient wallet` **·B** |

#### `compose/frontend.yml` — profile `frontend`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `frontend` | service | 4a verify.sh | `scripts/verify-frontend.sh` | `config.js injects MIDNIGHT_HOST_PORTS` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-frontend.sh` | `the Faucet link resolves` **·B** |
| ↳ |  | 4e spa-roundtrip | `scripts/verify-spa-roundtrip.sh` | `driving the SPA's own runtime configuration` **·B** |

#### `compose/shielded-night.yml` — profile `shielded-night`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `shielded-night-fund` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/both shielded-night wallets are funded and fee-capable/` in its own logs, after `exited 0` |
| `shielded-night-deploy` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/(published\|JOIN:) .*/contract\.json/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-shielded-night.sh` | `deploy volume carries contract` **·B** |
| `shielded-night` | service | 4a verify.sh | `scripts/verify-shielded-night.sh` | `/config.js selects the 2.x adapter for the local network (UNDEPLOYED_PROTOCOL)` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-shielded-night.sh` | `artifacts served as non-empty binary` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-shielded-night.sh` | `both round trips completed with exact balance assertions` **·B** |
| `shielded-night-register` | one-shot | 4d | `scripts/verify-oneshots.sh` | OUTPUT: `/OK: SNIGHT (=\|already names) [0-9a-f]{64}/` in its own logs, after `exited 0` |
| ↳ |  | 4a verify.sh | `scripts/verify-shielded-night.sh` | `GET /v1/known-tokens names SNIGHT` **·B** |
| `shielded-night-verify` | on-demand | 4a verify.sh | `scripts/verify-shielded-night.sh` | `11/11 circuits verified on chain against the served keys` **·B** |

#### `compose/solver.yml` — profile `solver`

| Service | Kind | Gate step | Script | Assertion |
|---|---|---|---|---|
| `solver-sink` | service | 4a verify.sh | `scripts/verify-solver.sh` | `solver sink healthy and solver connected` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-solver.sh` | `solver published capabilities + ladder; observation safety holds` **·B** |
| `solver` | service | 4a verify.sh | `scripts/verify-solver.sh` | `solver /status/snapshot is bearer-gated` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-solver.sh` | `solver status port :9100 is not published to the host` **·B** |
| `solver-frontend` | service | 4a verify.sh | `scripts/verify-solver.sh` | `solver monitor read all three sources` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-solver.sh` | `the monitor's rendered kernel book carries` **·B** |
| ↳ |  | 4a verify.sh | `scripts/verify-solver.sh` | `the monitor renders the solver's ladder state` **·B** |

## What each new step buys, and what it costs

Measured on one cold `--all` run (Apple silicon, every image rebuilt, 2 257 s end to end):

| Step | Why it exists | Measured cost |
|---|---|---|
| `verify-e2e-coverage.sh` (step 1) | the whole point: a new service, or a renamed assertion, cannot silently un-cover anything | **< 2 s**, offline (step 1 is 20 s in total) |
| `verify-oneshots.sh` (step 4d) | 13 one-shots were asserted by exit code alone | **2 s** — it only reads `docker logs` |
| `verify-aa.sh --mint` (step 4a) | PR-B's claim that the AA console mints through the **local mint-test-tokens issuers** was proven by hand in a browser and by nothing else. This drives the console's own HTTP API — the exact path the page uses — and then reads the **Manager's ledger balances** back | **156 s** (64 s of it is the one `execute` proof to register; then two mint+deposit cycles) |
| `verify-faucet.sh --mint` (step 4a) | `faucet-mint-test` never ran in the gate, and with it nothing ever asked the plain `proof-server` for a proof | **~60 s** |
| `verify-spa-roundtrip.sh` (step 4e) | the batcher's **`midnight-balancer`** target — the sponsored take — is reachable from no other step. The poster only exercises the `celestia` target | **54 s** (a warm chain; two proving rounds and a Celestia round trip) |
| `aa-e2e.sh` (step 4f) | the EVM-signed `execute` path had no gate at all | **331 s**, including the `:e2e` image build. Four `execute` proofs at ~59 s each |
| the `prices` anti-skip gate (step 2) | `up.sh --all` drops `prices` with no key and `verify.sh` then skips the section, so a whole profile could vanish from a green run (infra issue 00013 produced exactly that) | **free** |
| the `fund` compose one-shot (step 3b) | `fund-wallet.sh` reaches the toolkit through `docker run`, so the `fund` **service** had no caller anywhere | **34 s** (one probe wallet) |

Whole-run step table from that run:

| step | result | seconds | what ran |
|---|---|---|---|
| 1 | pass | 20 | offline artifact gates + e2e coverage matrix |
| 2 | pass | 666 | `up --build --all` |
| 3 | pass | 256 | fund the demo and mnemonic wallets |
| 3b | pass | 34 | the `fund` compose one-shot (one probe wallet) |
| 4a | pass | 841 | `verify.sh --aa-mint --faucet-mint` (every profile section) |
| 4b | pass | 9 | verify exact baked source pins |
| 4c | pass | 30 | `verify-wallets.sh --include-script-funded` |
| 4d | pass | 2 | one-shot output assertions |
| 4e | pass | 54 | spa round trip: take through the batcher, then make |
| 4f | pass | 331 | `aa-e2e.sh` |
| | | **2 257** | TOTAL, cold, every image rebuilt |

## Deliberate non-coverage

* **`aa-e2e.sh` mints through the AA repo's own `contract-minter`, not through the local issuers.**
  That is on purpose and documented in the script: what it tests is the EVM-signed `execute` path,
  which takes a colour as 32 opaque bytes. The local-issuer claim is `verify-aa.sh --mint`'s.
* **No browser runs in the gate.** The two SPAs need an injected DApp-connector wallet (the faucet
  site) or a rendered React app (zswap-da). `verify-spa-roundtrip.sh` therefore drives the SPA's
  *own runtime configuration and its own wire contract* from a container instead — same
  `/config.js`, same wallet seed, same `POST /send-input` body — which is the part that can break.
  The pixels are checked by hand, and that is recorded as such in the plan.
* **`shielded-night`'s browser round trip** is likewise covered by upstream's own external suite
  (`MN_EXTERNAL_STACK=1`, joined to this stack's contract through `CV_ADDRESS`) rather than by a
  browser. See `docs/KNOWN-LIMITATIONS.md`.
