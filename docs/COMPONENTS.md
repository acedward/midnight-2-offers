# Components — the long version

Everything that used to live at the top of the README: what each profile is, how it works,
and the design decisions behind it. The README keeps the short table; this file keeps the story.

## What is and is not in this release

**In**: the Midnight 2.x core stack, the wallet story (genesis-prefunded wallets, a funding
CLI, and mnemonics you can type into Lace), the read-only Ethereum JSON-RPC façade, and the
local Celestia DA devnet. `./up.sh --all && ./verify.sh` exercises all of it.

**Also in, since the ledger-v9 migration shipped upstream (2026-08-25)**: the offer-files
**kernel + batcher** (the rest of the `offerfiles` profile — sync node `:9999`, balancing
batcher `:3334`, and the local Celestia DA devnet they publish to and read back) and the
**`frontend`
profile** (the zswap-da make→take swap SPA on `:10600`). They were previously blocked on the
`@effectstream/*` ledger-v8 → ledger-v9 migration; that migration published as
`@effectstream/*@0.200.2` + `@effectstream/mip-zswap-offer@0.4.0-v9.0`.

## The kernel source pin — one branch, one SHA

Everything this stack builds from the kernel repository — the sync node, the batcher, the COW
solver, the offer poster and the price feed — comes from ONE commit. It no longer covers a
CONTRACT: the offer-files contract this repository used to compile out of that tree is gone from
it (see the table below), so the kernel image compiles nothing and ships no `compactc` at all.

> **`effectstream/zswap-offerfiles-kernel` @ `5d794f9a27f6d65529bf176650405f740531d430`**
> — branch `ledger-v9`, [PR #65](https://github.com/effectstream/zswap-offerfiles-kernel/pull/65).
> It is [PR #71](https://github.com/effectstream/zswap-offerfiles-kernel/pull/71)'s merge of
> [#69](https://github.com/effectstream/zswap-offerfiles-kernel/pull/69) and
> [#70](https://github.com/effectstream/zswap-offerfiles-kernel/pull/70) — **the removal of the
> offer-files contract** — onto the branch that already carried
> [#67](https://github.com/effectstream/zswap-offerfiles-kernel/pull/67) (Compact 0.34.0 and
> typed mint recipients) and [#68](https://github.com/effectstream/zswap-offerfiles-kernel/pull/68)
> (price-feed blank-env defaults, mint-time name registration).
>
> The pin it replaced is `80bace37bc2412542452e1c597761b2ebce5c677`, the same branch before that
> removal. Moving between the two is not a version bump: it deletes a contract, two compose
> services, a volume and a compiler stage, and it is why `./down.sh -v` is not optional here.

**THE SHA IS THE IDENTITY, NOT THE BRANCH OR THE PR.** PR #65 was a DRAFT when this pin was
taken ("DO NOT MERGE UNTIL LEDGER V9 IS THE STANDARD"), and that is fine: the images fetch by
full SHA, GitHub keeps a PR's commits reachable, and `scripts/verify-source-pins.sh` reads the
commit baked into each running image. If the branch is force-refreshed, or the PR merges to
`main`, the pin stays valid and only the wording here ages. That is why the SHA is written out
in full above rather than only in `.env.example`.

The previous pin was the CLOSED PR #50 branch `00001-solver-v9`, at `b1420c4…` — and in
`compose/offerfiles.yml` alone at `706301e…`, a split nothing in the repository noticed because
every check compared a running image against ONE of the copies. `scripts/verify-pin-defaults.sh`
now fails offline when any two defaults of one pin disagree, and `ci-check.sh` runs it.

What this pin brings that the `b1420c4…` line did not — the last four rows are what the move
from `80bace3…` to `5d794f9…` changed, and they are the ones to read first:

| Change | Kernel PRs | What it means here |
|---|---|---|
| **Token price service** — seeded `asset_prices`, `GET /v1/prices`, `GET /v1/quote`, and the batcher's fee-sponsorship gate | #54–#56 | ⚠ **BREAKING**: it moves `migrations/000-init.sql`, which the kernel applies only on an EMPTY database. An existing `postgres-data` volume needs `./down.sh -v`. The kernel and batcher carry the matching `BATCHER_SPONSOR_*` / `SPONSOR_DISCOUNT_BPS` env |
| **Offer poster** — one takeable offer per interval | #57, #60, #66 | the `poster` profile. It used to MINT the coin it offered; since #69/#70 it selects an existing one, so it needs `--with faucet` for its inventory |
| **Solver status listener** (`:9100`, bearer-gated) and the **`solver-frontend` monitor site** | #58, #59 | the solver's own view of itself, and a page for it |
| Faucets mint whole coins; sNight seeded as a known token; `known_tokens.decimals` added, `DEFAULT 6` | #61, #63 | ⚠ **the `DEFAULT 6` is not a fact about this stack's tokens.** The six local ones are twBTC **8**, twETH **18**, twUSDC 6, twUSDM 6, utwUSDC 6, utwBTC **8**, and `registry-bridge` sends each real value explicitly. Every "whole coins × 10⁶" assumption in a script, a curl or an assertion has to be re-read against the registry |
| Randomised poster give size (`GIVE_MIN`/`GIVE_MAX`) | #66 | `OFFER_POSTER_GIVE_MIN`/`_MAX` in `.env.example`. Since #69/#70 the range SELECTS an existing coin inside it and never splits or creates one, and `GIVE_SIZE_SEED` — which only ever seeded the mint's size draw — is gone with the mint |
| **Compact 0.34.0 / compact-runtime 0.19.0**, and an archive SHA-256 recorded in `infra/compact-checksums.sha256` | #67 | ONE toolchain for every contract this repository compiles — see below. Closes `issues/00011` |
| **Typed mint recipients**: `mint_shielded(sep, amount, nonce, recipient: Either<ZswapCoinPublicKey, ContractAddress>)` and `mint_unshielded(sep, amount, recipient: Either<ContractAddress, UserAddress>)`, changed IN PLACE | #67 | **superseded by #69/#70** — those two circuits no longer exist anywhere. What survived is the recipient SHAPE: the local issuers' own `mint` circuits take the same `Either`, which is why `images/aa-contracts/runner/mint-recipient.ts` carried over with its behaviour unchanged |
| Price-feed config treats blank/whitespace env as unset (`packages/price-feed/src/env.ts`) | #68 | the `prices` entrypoint's unset-blank-knobs workaround is DELETED (00010 Q24 closed) |
| Mint moved out of the deploy one-shot into a post-kernel one, registering names through the live API | #68 | **superseded by #69/#70** — the deploy one-shot and the mint are both gone. Naming this stack's colours is `registry-bridge`'s job now, off the faucet's own registry |
| **The offer-files CONTRACT is DELETED**: no `packages/contracts-midnight`, no `offer-files.compact`, no `mint_shielded`/`mint_unshielded`, and **no compactc stage in the kernel's image** | #69, #70 (merged by #71) | ⚠ **BREAKING and structural.** The `offerfiles-deploy` and `register-tokens` services are gone, and so is the `offerfiles-deploy` volume that held the address. Upstream's `deploy/scripts/lib/check-compose-topology.ts` now ASSERTS that no service is named `offerfiles-deploy`, `mint-test-tokens` or `register-tokens`. `./down.sh -v` is required |
| `GET /v1/midnight/config` answers exactly `indexerUri`, `indexerWsUri`, `proofServerUri`, `networkId` — and **no `contractAddress`** | #69, #70 | `scripts/verify-kernel.sh`'s assertion is INVERTED: a `contractAddress` now means a pre-#69 image is running against this compose, which nothing else would notice because every consumer of that address is gone too. Upstream pins the same thing in `packages/node/api.test.ts` with `expect(body.contractAddress).toBeUndefined()` |
| The tokens a book trades are **external to the kernel** | #69, #70 | this stack issues its own: the `faucet` profile's six mint-test-tokens issuers, named into `known_tokens` by `registry-bridge`, their ids rendered by `registry-env`, their coins minted by `faucet-mint`. **`--with offerfiles` is no longer useful on its own** — the kernel comes up and serves an empty book, because nothing in that profile can create a token any more |
| `infra/compact-version.txt` (`0.34.0`) and `infra/compact-checksums.sha256` survive in the kernel tree, **orphaned** | #70 | nothing upstream reads them; this repository still does, from `images/aa-contracts/Dockerfile` alone. The one live compact fact upstream is `bun run check:compact-runtime` — one `@midnight-ntwrk/compact-runtime@0.19.0` resolution across the workspace |

**The compactc version still travels with that SHA, but only ONE image reads it now.** The kernel
image compiled the offer-files contract and therefore carried a whole `compact` build stage; that
stage is deleted, and the image asserts its own absence at build time — `test ! -e
/app/packages/contracts-midnight` and `! command -v compactc`. What it bakes instead is
`/app/.compact-runtime-version`, taken from the kernel root manifest's `overrides` entry, which is
the only compact fact the kernel line still has: exactly one `@midnight-ntwrk/compact-runtime`
resolves across the workspace, and `bun run check:compact-runtime` is what upstream keeps to prove
it.

`images/aa-contracts` is now the only image here that takes its compiler pin FROM THE KERNEL. It
still reads `infra/compact-version.txt` (**`0.34.0`**) and `infra/compact-checksums.sha256` out of
the fetched tree rather than carrying a hard-coded `ARG`. Those two files are ORPHANED upstream —
no kernel code consumes them at this pin — but they remain the single place this repository keeps a
compiler pin and its release hashes, and reading a pin beats restating one.
`--build-arg COMPACT_VERSION=…` still overrides for an experiment. (The other two images that run
compactc, `images/shielded-night` and `images/zswap-da`, never clone the kernel and carry their own
pinned 0.34.0 with its hashes — see their sections below.)

Three things are asserted, and none of them is a number written down in this repository:

* the downloaded release archive must hash to the SHA-256 the pinned tree records in
  `infra/compact-checksums.sha256`. A release tag is a locator; a compiler is the one input where
  "roughly the right bytes" is worth nothing.
* `compactc --runtime-version` — the string the generated module will pass to
  `checkRuntimeVersion()` — must equal the `@midnight-ntwrk/compact-runtime` that the code loading
  it actually installs. That expectation MOVED REPOSITORIES with the contract: it used to come
  from the kernel's deleted `contract-offer-files/package.json` and now comes from
  mint-test-tokens' `contracts/v2/package.json`, which is the right source anyway — that is the
  package whose committed generated modules this image ships and the console imports. The image
  additionally requires the copied artifacts' own `compiler/contract-info.json` `runtime-version`
  to equal the installed runtime, so the cross-repo half is checked and not assumed.
* on a live stack, `scripts/verify-source-pins.sh` reads `/aa/.compactc-version` off **both** AA
  images and requires them equal — the kernel image has no left-hand side to offer any more — and
  it asserts that the kernel image carries **no** `/app/.compactc-version` at all, which is the
  demo-side twin of upstream's "a fresh clone does zero Compact compilation".

**That is what closed `issues/00011`, and the closure survives the contract's removal.** The AA
contracts at `AA_REF 41de69d` are a 0.34.0 / 0.19.0 build (AA PR #11) while the kernel line once
declared 0.33.0-rc.2, and this image used to paper over the gap by compiling the AA contracts with
the kernel's older compactc — legitimate only because the emitted ZKIR happened to be
byte-identical, which is a coincidence to re-verify per release, not a property. The invariant
that mattered — one compiler, one runtime, per process — still holds; it simply has three parties
now instead of two, because the artifacts the console loads beside the Manager's are
mint-test-tokens' committed ones rather than something this image compiled.

**Cow solver source pin.** Cow solver source is not copied into this repository. Its image fetches
the same commit at build time (`SOLVER_REF` — a separate knob, the same value since the kernel
and the solver live on one branch now). Compose supplies the separately built kernel image only
for its generated Compact artifacts. The image runs `start.solver.ts` behind this repo's own
`undeployed`-only gate (`images/cow-solver/entrypoint-solver.sh`): the older entrypoint,
`packages/solver/solver.dev.ts`, carries that gate itself but calls `runSolver()` without a
`status` option — and the status listener is inert unless that option is present, so the monitor
site would have had nothing to read.

**Frontend source pin.** The zswap-da template's ledger-v9 migration is not published upstream
(`effectstream/effectstream@templates/zswap-da` remains on ledger-v8). The image therefore fetches
[`effectstream/effectstream@ea04ff7c`](https://github.com/effectstream/effectstream/tree/ea04ff7c16dab5118d4bdfeec6e7455c89981827/templates/zswap-da)
directly, verifies the resolved full commit and its `templates/zswap-da` subtree
(`ea22913c345da3dae36e113fdbced2bb1897de63`), and applies the fail-closed 13-file
`images/zswap-da/ledger-v9.patch`. The patch carries dependency/lockfile, the compiler manifest,
the KERNEL's `offer-files.compact`, and eight TypeScript/API modules; the other 87 upstream files
are taken verbatim and none is copied into this repository.

**Why the contract source is in the patch, and what that means now the kernel has none.** The SPA
proved calls against the contract the pinned KERNEL deployed, so its compiled artifacts had to be
the bytes the kernel image produced — same source, same compiler, same runtime. At the `b1420c4…`
pin the template's copy of `offer-files.compact` was already byte-identical to the kernel's, so the
patch could stay silent and the identity held by luck; kernel PR #67 changed both mint circuits in
place and the template did not follow, so the patch took the kernel's file and a manifest
regenerated with compactc 0.34.0.

At `5d794f9…` that file no longer exists in the kernel tree at all, which makes the patch's copy
the last one in this repository — and leaves the SPA's own faucet lane without a contract on this
chain. Nothing deploys offer-files any more, and `GET /v1/midnight/config` carries no address to
find one with, so the SPA's `mint_shielded` button has nothing to call. The make→take swap path
itself is unaffected: it trades whatever colours the book carries, which on this stack are the
six the `faucet` profile issues. Re-pinning the template so its faucet mints through those issuers
instead is a separate change, deliberately not folded into this one. The image's `compact` stage
still verifies the compiler archive against the SHA-256 the kernel records and still refuses to
build if `compactc --runtime-version` disagrees with the `@midnight-ntwrk/compact-runtime` the
patch installs. The pin is a full SHA and stays the identity even if `v-next` moves.
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
exposes it), proves `execute` through the profile's internal proof server (~1 min on the default
MinoCrab k=18 artifact, ~2 min on compactc's k=19; the page shows the live job log, and the log
line names which artifact it is proving — read off the image, not off a build flag) and submits,
paying fees from its own relay wallet
(`aa-console` in `wallets/wallets.json`, funded automatically by `up.sh` — unshielded NIGHT +
DUST only, deliberately shielded-free). The console's image variant keeps the Manager's
`execute.prover`, which the deploy image prunes (`midnight-2-offers/aa-contracts:console`) —
544 MiB on the default, 1.14 GB with `AA_ZKIR_SOURCE=compactc`. It is kept because the RELAY
proves, not the proof server: the key is read out of the image by the zk-config provider and
uploaded per call.
`AA_CONSOLE_DEV_SIGNER=1` enables a built-in test signer for wallet-less CI runs; leave it off
otherwise. The one-time withdraw limitation is GONE: the node's `Custom error: 214` (a
recipient-encoding defect in the Manager) was fixed upstream in
[AA PR #10](https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/10) — pin `AA_REF`
at or past its merge (this stack pins `41de69de…`, well past it; key-breaking, so redeploy the
contracts) and withdraw lands
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
any two **distinct shielded demo tokens** — since the contract removal, two of the four shielded
tokens the local issuers mint (twBTC/twETH/twUSDC/twUSDM), which is the same market the offer
poster posts into; the console's taker flow or the kernel's own
`api-examples/11-settle-offer.ts` settle it. Two switches make this work, both ON in the demo and
OFF upstream by default: `ALLOW_CONTRACT_MAKER_OFFERS` (kernel-side — contract-maker offers
cannot pass `wellFormed` against the kernel's blank reference state, so the exact
missing-contract failure retries without contract-proof verification; native zswap proofs and
signatures are always verified, and the node verifies the contract proof at settlement) and
`AA_OFFER_ALLOW_FALLIBLE` (console-side — measured when `execute` was compactc's k=19, whose
transcript exceeds the ledger's guaranteed-section budget, so every AA offer's legs sat in the
fallible section; measured live: a foreign taker settles them anyway, ledger-exact. The default
MinoCrab k=18 artifact roughly halves the circuit and may no longer force it; the flag stays ON
so the demo behaves identically either way, and the fallible path is the one with live evidence). Each blob is also saved under the `aa-out`
volume at `/aa/out/offers/<offerId>.swapoffer`.

## The AA console mints through the local issuers

This is the largest single change on the `aa` side of the contract removal, and it is almost
invisible from the outside: the console's faucet, fund and send actions still hand a wallet its
named tokens, and the AA Manager still sees nothing but 32 raw colour bytes.

**What went away.** The console used to derive its three colours itself —
`rawTokenType(domainSepFromName("WBTC"), offerFilesContractAddress)` — with the address read from
the kernel's `GET /v1/midnight/config`. Both halves of that are gone: no contract mints by domain
separator any more, and there is no address to derive from, because the route no longer answers
one.

**What replaced it.** The console reads `${AA_FAUCET_URL}/metadata.undeployed.json` — the same
registry document its infrastructure probe already read for the faucet card — and takes symbol,
colour (`deployments[].tokenId`), decimals, privacy and the per-token ISSUER ADDRESS out of it.
Six tokens, one contract each. Its faucet / fund / send actions call each issuer's `mint` circuit
directly (`mint(recipient, amount, nonce)` shielded, `mint(recipient, amount)` unshielded) and then
deposit into the Manager exactly as before. Those circuits take the same `Either` recipient shapes
the deleted offer-files ones did, which is why `images/aa-contracts/runner/mint-recipient.ts`
carried over with its behaviour unchanged — and why deposits, withdrawals and the whole EIP-712
action set did not move at all: the Manager only ever handled colour bytes, and colour bytes are
what it still gets.

**The generated modules are COPIED into the image, never recompiled.** `contracts/v2/managed/` is
committed upstream, and those exact bytes are the ones whose verifier keys the faucet registered on
chain — upstream's deploy runner refuses to touch the chain unless the artifact bytes equal the
committed ones, so recompiling them here, even with the identical compiler, would produce a
different tree to verify against and would be exactly what upstream tells integrators not to do.
They are zkir-v2 / `[v6]`, so the console proves them on the PLAIN proof server
(`AA_WALLET_PROOF_SERVER_URL`), while the Manager and the test Minter keep the profile's own
experimental `[v7]` one. The image gained `MINT_TEST_TOKENS_REPO` / `MINT_TEST_TOKENS_REF` build
args and bakes `/aa/.mint-test-tokens-commit`, which `scripts/verify-source-pins.sh` now asserts on
BOTH AA images: an AA image built from a different mint-test-tokens commit would prove against
verifier keys this stack never deployed, and nothing else in the stack would notice.

**Two smaller consequences.** The console no longer registers token names in the kernel. It used to
POST every token with a hardcoded `decimals: 6`, which was wrong for four of the six, and
`registry-bridge` owns `known_tokens` now. And `/api/info.tokens` carries `decimals`, `label` and
`issuer` per token plus `tokensSource: "mint-test-tokens"` and `tokensRegistryRevision`, so the
page's defaults became POSITIONAL — "the Nth token of this family, in registry order" — rather than
the literals `wBTC`/`wETH`/`wUSD` they used to be.

**The AA E2E driver did not change.** `runner/aa-e2e.ts` mints through the AA repository's own
test-support Minter contract, never through offer-files, so nothing in it referenced the removed
contract and nothing in it had to move.

## The offer book persists across restarts

It used to be in-memory: the kernel kept its book in
a PGLite database inside its own container, so recreating `kernel` threw the book away and
re-indexed it from Celestia height 1. Since T11.4 the whole stack shares ONE PostgreSQL
(`postgres` in `compose/core.yml`) and the kernel uses its `offerfiles` database, which outlives
the container. Measured on a recreate: the offer row survived, the API served the same offer, and
the sync cursors RESUMED — Celestia fetching restarted at block 11066 having stopped at 11065,
not at height 1 — so the container reached healthy in **8 seconds** instead of re-indexing.
`./down.sh -v` still drops it, which is right: the book is a projection of the chain that command
destroys.

**And there is no contract left to move.** The `offerfiles` profile is three services: `celestia`
(the local DA devnet), `kernel` (the sync node `:9999`, storing into the shared `postgres`) and
`batcher` (the balancing batcher `:3334`, on its own).

There used to be a fourth, `offerfiles-deploy` — a one-shot that deployed the offer-files contract
**once per stack** and persisted its address on a volume — and splitting it out was worth doing at
the time. Before the split everything ran under one dev orchestrator and the contract deploy re-ran
on every container recreate; its script begins by deleting the address file, so a
`--force-recreate` silently minted a **new contract** and reset the book's identity. The one-shot
turned that into a JOIN.

Kernel PRs #69/#70 removed the contract itself, so the problem is gone rather than solved: nothing
to deploy, no address to persist, no `offerfiles-deploy` volume, and no mint circuit for anything
to call. Upstream's own `deploy/scripts/lib/check-compose-topology.ts` now ASSERTS that no service
is named `offerfiles-deploy`, `mint-test-tokens` or `register-tokens` — the topology this profile
had is a thing the kernel line now refuses. What the kernel indexes is plain ZSwap offers over
tokens some OTHER contract issued, which on this stack means the `faucet` profile's six local
issuers. **`--with offerfiles` on its own is therefore no longer a useful stack**: the kernel comes
up, serves an empty book and names nothing, because that profile can no longer create a token.
`./up.sh --with faucet --with offerfiles` is the smallest one that does anything.

The consequences of the split that remain are the good ones: `kernel` and `batcher` restart
independently of each other, and `docker compose logs batcher` is the batcher's log alone rather
than six processes interleaved. The batcher lost its last ordering edge in this file with the
one-shot — that `depends_on` was never an address dependency but the wallet-serialization rule,
and the facade it serialised against was the MINT wallet running inside the deploy container.

## The token-naming one-shot: `register-tokens` is gone, `registry-bridge` does its job

`register-tokens` was a one-shot, non-fatal, run once the kernel was healthy: it named this
stack's three demo colours in the kernel's registry (`POST /v1/known-tokens`, `decimals: 6`).
**It is gone at this pin**, along with the contract whose colours it named. The reasons it existed
are worth keeping, because they did not go away — they moved to `registry-bridge` in
`compose/faucet.yml`.

It existed because of two problems that met at the same place. First, `mint-test-tokens.ts` — the
script the deploy one-shot ran — already tried to register names and CANNOT succeed inside a
one-shot: it posts to `/api/known-tokens`, a path the node has never served, and to its own
loopback while the kernel does not yet exist. Both failures were swallowed by a try/catch that only
logs. That is the kernel's own `issues/00008`, and only Compose knows when the kernel is healthy,
so a separate service is where the ordering can actually be fixed. Second, **names are not
cosmetic**: since the token price service, a row in `known_tokens` is what makes a colour
priceable, and an unnamed colour quotes as "no asset behind this", which the batcher's sponsorship
gate then has to treat as unpriced.

**What replaced it, and the one thing that genuinely changed.** `registry-bridge` does the same job
for six rows instead of three, from the faucet's published registry rather than from a derivation —
see [Naming the six tokens](#naming-the-six-tokens-in-the-kernels-token-registry) below. The
derivation is what is gone: a colour used to be
`rawTokenType(domainSepFromName(name), offerFilesContractAddress)`, computed independently by four
consumers, and the whole point of unifying those separators was that the console, the poster, this
one-shot and the SPA faucet had to agree on one colour per name or a console taker could not take a
poster offer. With the contract deleted there is no separator and no address to derive from: a
colour is now the `tokenId` an ISSUER CONTRACT has, published once by the faucet and read by
everyone. Agreement is no longer something four code paths have to maintain — it is a file.

## The COW solver reports on itself: status listener + `solver-frontend` (profile `solver`)

The `solver` profile is now three services.

**The status listener** is the solver's own read-only surface, on `:9100` inside the compose
network: `GET /health` (open — no internal data, so a healthcheck needs no secret) plus
`GET /status/snapshot` and `GET /status/stream` behind a Bearer. It is OPT-IN BY THE PORT and by
nothing else — with `SOLVER_STATUS_PORT` unset the solver behaves byte-for-byte as before.
Collection reads in-memory state only: no wallet call, no proof, no kernel or relay I/O, and no
route mutates anything.

`:9100` is **never published to the host**. `/status/*` is the solver's entire internal state —
book, inventory, journal tail, ladder, configuration — so the token that guards it is the only
thing between that state and whatever can reach the port. `verify-solver.sh` asserts the port is
unpublished and that the gate answers 200 with the bearer and 401 without, in one exec against
the same process. The token itself (`SOLVER_STATUS_AUTH_TOKEN`) is a **fixed public default**,
exactly like `SOLVER_RELAY_AUTH_TOKEN` and every other secret in this repository; it has to exist
(the solver refuses a value shorter than 32 characters) and with the port unpublished it only
guards the compose network.

**The monitor site** (`solver-frontend`, `:10802` on the host) is the page that reads it: "is the
solver quoting, and if not, why". Six-stage health strip, the ladders it published, the kernel's
book and sync state, the relay's advertised tokens, a bounded transition history.

It is a SEPARATE service and not a route on the solver for one reason: *the moment anyone
actually opens it is the moment the solver is down.* So it depends on `kernel` only — never on
`solver`, and least of all with `service_healthy` on it — and it comes up, renders the book, and
says SOLVER UNREACHABLE with the time it was last seen instead of dying alongside the process it
exists to describe. It holds no wallet, no seed and no journal, opens no relay socket, and has no
route that mutates anything. It has **no authentication of its own**, which is why its host port
binds `BIND_ADDR` (127.0.0.1) like everything else here.

**One page about the solver, and the sink is not it.** The sink used to serve its own ladder-feed
page on `:10800` next to the monitor, and the console framed both. Two pages about one solver was
one too many, so as of 2026-09-04 the sink publishes NOTHING to the host: no feed page, and no
relay-inspection port either. What it still is, is the relay's RECEIVE half — the thing the solver
must connect to in order to publish ladders at all — and the only place the observation-safety
property (`framesSentToSolver == 0`) can be demonstrated, because it is the thing that would have
had to send. That proof did not move, it just stopped needing a browser: `scripts/verify-solver.sh`
reads `GET /api/snapshot` on the sink's internal `:8080` through `docker exec`, and the AA
console's infra probe reads it over the compose network. The monitor site is the page.

The sink also gained `GET /tokens` on its relay port — unauthenticated, as on the reference
relay, and the only relay route the monitor knows. It answers from the last `solver-capabilities`
frame the sink accepted, which on a one-solver stack is exactly what the relay would advertise.
It is a READ: nothing was added that can construct or send a frame towards the solver.

### The solver was measured against the token change, and NOT changed

The obvious worry when every colour in the stack moves is that the solver quotes against a list of
colours somewhere. It does not, and the measurement is worth writing down because the artifact that
makes it *look* otherwise is still in the image and a reader will want to "fix" it.

**The ladders the solver publishes come from the kernel's BOOK.** `deriveLadderPush` runs over
`cache.book.all()`, and the identifiers that go out on the wire are the book offers' own
lower-cased 64-hex colours — whatever the poster and the AA console actually posted, on this chain,
minutes ago. Nothing in `packages/solver` or `packages/solver-core` consults `known_tokens` at all,
so a colour that is unnamed, misnamed or brand new is still quotable.

**The ladder CONFIG file is inert here.** `packages/solver/config/ladders.dev.json` names *Preprod*
colours, which exist on no local chain, and it is consumed only by `packages/solver/src/engine.ts`
— which nothing in `run.ts` or `swap-job-executor.ts` imports at this commit. It is dead weight in
the image, and silently so: `SOLVER_LADDER_CONFIG` left unset is a WARNING, never a refusal. So the
file is neither configuration for this stack nor a bug in it; leave it alone.

**And no `solver-provision` one-shot was added.** Upstream ships one, and enabling it here would
require funding the solver's wallet with NIGHT and DUST — which this demo's solver deliberately
does not have, because it runs in observation mode and holds no value. Upstream is explicit that it
would buy nothing anyway: the solver "needs NO swap-token inventory to quote or settle whole-maker
rungs. It needs NIGHT/DUST, and that is all." `registry-env` renders
`SOLVER_PROVISION_TOKEN_IN`/`_OUT` into `stack-tokens.env` regardless, because the two ids cost
nothing to render and are exactly what an operator who does enable that one-shot has to paste.

## The book fills itself: the `poster` profile

`./up.sh --with faucet --with offerfiles --with poster` (or `--all`) adds two services.

**`--with faucet` is not optional any more**, and `up.sh` refuses the combination without it rather
than letting compose fail on a missing service. Two consequences of the contract removal put it
there: both of the poster's token ids are now REQUIRED and EXPLICIT 64-hex values that exist only
once this chain's issuers are deployed (so they cannot be written into `.env.example` either), and
the poster no longer mints — the coins it offers come from the `faucet-mint` one-shot. It mounts
the `faucet-registry` volume read-only and waits on `registry-env` and `faucet-mint`, all three of
which are declared in `compose/faucet.yml`.

`poster-fund` is a one-shot on the toolkit image: it sends the poster's dedicated wallet
4 × 5 000 000 000 000 stars of unshielded NIGHT from genesis. Several LARGE UTXOs rather than
one, because DUST is generated per NIGHT UTXO and the poster pays a fee every interval out of its
own dust. It funds FEES only — the swap tokens are `faucet-mint`'s job. It is idempotent by a CHAIN READ of the wallet's current total, not
by a marker file — a marker would survive a `./down.sh -v` of the chain it describes. It does NOT
register the DUST address: the poster does that itself at startup, and a second registrant for a
value the service already owns would make "the poster could not register" unreportable.

`offer-poster` is the loop. Every `POST_INTERVAL_MS` it either re-offers a coin its journal says
came back, or ADOPTS one already-spendable `GIVE_TOKEN` coin out of its own wallet, and posts a
single ZSwap offer whose only input is that exact coin. The want leg is sized from the kernel's
`GET /v1/quote` each tick, which is what keeps the offer sponsorable by the batcher. Health,
metrics and the journal are on `:9977`, published as `POSTER_HEALTH_PORT`.

**It selects; it never creates.** Until this pin it minted a fresh coin per tick from the
offer-files contract's faucet circuit. There is no such circuit now, so it looks for a coin worth
exactly `OFFER_POSTER_GIVE_AMOUNT` (or one inside `GIVE_MIN..GIVE_MAX`) and never splits or mints
one. Its market is chosen by SYMBOL in compose — `OFFER_POSTER_GIVE_SYMBOL=twBTC`,
`OFFER_POSTER_WANT_SYMBOL=twUSDC` — and the entrypoint resolves each to `<SYMBOL>_TOKEN_ID` out of
`registry-env`'s `stack-tokens.env`; an explicit `OFFER_POSTER_GIVE_TOKEN`/`WANT_TOKEN` always
wins over the lookup.

**Why twUSDC and not twETH for the want leg**, since twBTC→twETH is the prettier decimals story:
twETH has 18 decimals, so one whole twBTC — about $77,387 at the kernel's seeded reference price
— quotes to roughly 3.2 × 10¹⁹ base units of it, past `Uint<64>`. twUSDC at 6 decimals lands on
about 7.5 × 10¹⁰. The 8/18-decimal pair is still exercised, by `verify-kernel.sh`'s twBTC→twETH
quote assertion, where nothing has to fit in a coin.

**Inventory is finite now, and sizing it is a real operational concern.** A coin is tied up from
the moment it is offered until the wallet releases it (`OFFER_POSTER_TTL_MINUTES`) or a taker
spends it, so steady state needs roughly `TTL_MINUTES × 60000 / INTERVAL_MS` coins in the wallet.
The demo defaults are `OFFER_POSTER_INTERVAL_MS=300000` (a 5-minute tick),
`OFFER_POSTER_TTL_MINUTES=10` and `FAUCET_MINT_POSTER_COINS=4`, which leaves about two in flight
with headroom. `degraded: insufficient_inventory` is the honest report when it runs out, not a
fault to retry away: a restart cannot create inventory and this deployment never pretends
otherwise. Change one of those three numbers and check the other two.

**A dedicated seed, and it must stay dedicated.** Two wallet facades on one seed against one
Midnight node force each other's connection down, silently. The poster refuses to start (exit 78)
if its seed equals any of seven named wallet variables, and `scripts/verify-poster.sh --static`
asserts offline that the shipped default (`0ffe…`, listed in `wallets/wallets.json`) differs from
every seed declared in `compose/`, `.env.example` and that file. This service must never be scaled
past one replica.

**Idempotence lives in the journal, not in a marker.** `poster-fund` and the other one-shots write
a marker and exit early on a restart; a marker here would make a restart a permanent no-op, since
this service's whole job is to keep posting. The journal (on its own volume) is written before an
adopted coin is offered and after every state change, so a restart re-adopts the coins this poster
already owns and re-offers the ones that came back. Deleting that volume is what "start over"
means.

`/health` answers 200 while the poster is `starting` and while it is `degraded` — 503 arrives only
after `HEALTH_STALE_TICKS` consecutive FAILED ticks, because 503-ing on `degraded` would make
Compose restart a container that is correctly waiting for NIGHT, or one that has simply run out of
coins. So a healthy container proves very little, and `./verify.sh --poster` is the real gate: it
requires `state` not degraded, `inventoryAdoptions + reoffers ≥ 1`, and `lastOfferId` present **in
the kernel's open book** with a give leg of exactly `OFFER_POSTER_GIVE_AMOUNT` and a non-zero,
actually-quoted want leg.

**The health document changed shape with the mint.** `poster-health.ts` reports no `mints` field
and no `offer_poster_mints_total` metric at this pin; the successors are `inventoryAdoptions`,
`reoffers`, `freeCoins`, `candidates`, and the metrics
`offer_poster_inventory_adoptions_total` / `offer_poster_free_coins`. `freeCoins` is the number to
read before touching any of the three sizing knobs.

## The price feed (profile `prices`) — opt-in, and the one real secret here

`price-feed` is the same kernel image again, running
`packages/price-feed/price-feed.dev.ts`. Once a cycle (default: at start, then every 24 h) it
asks CoinGecko's `simple/price` for the five asset ids the schema seeds — `bitcoin`, `ethereum`,
`usd-coin`, `midnight-3`, `usdm-2` — in **one** batched request, and upserts `asset_prices` and
`price_feed_status` over the Postgres wire. The kernel then serves those rows on `GET /v1/prices`
and `GET /v1/quote`, and the batcher's fee-sponsorship gate reads them *through* the kernel, so
one refresh moves every consumer at once.

**It is the only service here that talks to a third party, and the only one that holds a real
secret.** It talks to no Midnight service and to no Celestia service at all: CoinGecko in,
Postgres out. That is why its compose service gates on `postgres: service_healthy` and
`kernel: service_healthy` (the kernel is what applies `000-init.sql`, and `run.ts` refuses to
spend a request against a database missing `asset_prices` / `price_feed_status`) and on nothing
else, and why it publishes no port.

**It is OPT-IN, and the stack is complete without it.** `000-init.sql` seeds real reference
prices, so a fresh database already quotes 1 WBTC ≈ 32 WETH rather than a colour-hash rate. The
profile buys *fresh* prices, not working ones — the same call upstream makes for its own copy
(`profiles: ["prices"]`, and its dev stack never registers the feed at all). `./up.sh --all`
therefore skips it unless `COINGECKO_API_KEY` is set, out loud, so a host without a key still
brings up everything else and still passes `scripts/ci-check.sh`.

**`COINGECKO_API_KEY` has no default anywhere** — not in `compose/prices.yml`, not in a
Dockerfile, not in `.env.example`, which carries the variable name and a warning and no value. It
lives in the env file (`.gitignore` excludes `.env` and `.env.*`), travels as the
`x-cg-demo-api-key` **header** and never as a query parameter, and the service's own startup line
prints `key=present` / `key=ABSENT`. `./up.sh --with prices` refuses to start without it, naming
the variable; `docker compose … up price-feed` by hand starts a container that warns and IDLES,
which is upstream's deliberate design (a non-zero exit under `restart: unless-stopped` is a crash
loop, and the seeded prices keep the stack usable meanwhile). The refusal deliberately does NOT
live in the compose fragment as `${COINGECKO_API_KEY:?…}`: `./down.sh` passes every fragment on
every teardown and compose interpolates the whole set on every command, so that spelling would
break teardown for everyone without a key. See docs/OPERATIONS.md, "The `prices` profile".

**What `./verify.sh --prices` proves**, and why it reads the KERNEL rather than the feed's logs:
the feed serves nothing, so the only claim worth making is that the rows the rest of the stack
consumes are the ones it wrote. `price_feed_status` is deliberately **not** seeded — an absent
row is how "the feed never ran here" is spelled — so a non-null `feed.last_ok_at` means one thing
only. On top of that: `last_error` is null, the timestamps are inside `PRICES_MAX_AGE_S`, every
priced asset carries `source: "feed"` rather than `"seed"` (a CHECK-constrained column with
exactly those two values, so the seed data cannot satisfy it), and both legs of a live
`GET /v1/quote` report `from_source`/`to_source` = `feed`. `scripts/verify-prices.sh --once`
additionally runs one synchronous cycle and requires exit 0 — which spends a credit, hence the
flag.

**Failure grading, inherited from upstream and worth knowing:** one bad id inside an otherwise
good response fails only that id; a failed *request* is recorded against every id it carried
(blaming one would be a guess); a `429` stops the cycle where it stands, keeping everything
already written. Nothing is ever deleted, and a row is only overwritten by a successful fetch —
so the worst case of a broken feed is stale prices, never missing ones.

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
| `shielded-night-register` | one-shot (`restart: "no"`) | teaches the offer-files kernel THIS stack's sNight colour, when the `offerfiles` profile is in the stack. Every kernel request is retried, bounded and jittered, because health is not schema readiness (infra issue 00016). No kernel → it waits for the name to appear (`SNIGHT_KERNEL_DNS_WAIT_S`, default 300 s — the kernel container starts ~80 s after this one-shot on `--with offerfiles --with shielded-night`), then one log line and exit 0 |
| `shielded-night` | nginx | serves the SPA and the compiled artifacts; its entrypoint waits for that address and writes `/config.js` before starting nginx |
| `shielded-night-verify` | never started by `up.sh` | the bun-side assertions `./verify.sh` runs with `compose run --rm` (a compose `profiles:` key keeps it out of `up -d`, exactly as `core.yml`'s `fund` service does) |

### Naming sNight in the kernel's token registry

The kernel's schema seeds a `SNIGHT` row in `known_tokens`, and the colour it seeds is
**preview's** — because sNight's colour is not a constant. The contract mints
`tokenType(pad(32,"shielded-night:wrapper"), self())`, so the colour follows the contract
ADDRESS, and this profile deploys a fresh contract on every `./down.sh -v`. Left alone, the
registry names a colour this stack can never hold while the colour it does hold has no name:
the swap SPA and the solver monitor show short hex, and neither `/v1/quote` nor the batcher's
sponsorship gate can price it.

`shielded-night-register` fixes that at bring-up. It reads the address from the deploy volume,
derives the colour offline with `rawTokenType` (the deploy image already carries
`@midnightntwrk/ledger-v9`), and then:

| registry state | what it does |
|---|---|
| `SNIGHT` already carries this colour | logs and exits 0 — re-running is the normal case |
| no `SNIGHT` row at all | `POST /v1/known-tokens` |
| `SNIGHT` carries a different colour | **one** `UPDATE known_tokens SET token_color=… WHERE name='SNIGHT'` |

That last row is the interesting one. The kernel serves exactly two routes for this table, `GET`
and `POST`; there is no `PUT`, `PATCH` or `DELETE`, and `POST` answers **409 `Token name
"SNIGHT" is already taken`** — which for `SNIGHT` is *always*, because the migration seeded it.
The SQL is not an end run around the API: it is the remedy the kernel's own `000-init.sql`
prints in the comment above that seed, under `!!! PATCH THIS ROW WHEN DEPLOYING TO ANOTHER
NETWORK !!!`. Whatever path is taken, the result is re-read through `GET /v1/known-tokens` and
the one-shot fails if the colour did not land — it never trusts its own write. Every one of those
requests, and the `UPDATE`, is retried on a bounded jittered budget (8 attempts, 2 s → 15 s, ±3 s;
`SNIGHT_REGISTER_*`): the kernel answers `/v1/health` while it is still applying `000-init.sql`, so
a 5xx or a refused connection means "not ready yet" and is waited out, while a 4xx is a real answer
and fails at once (infra issue 00016). The row carries
`decimals: 6` and `asset_id: midnight-3`, NIGHT's own asset: sNight is locked 1:1, so one sNight
base unit is one Star and an equal-base-unit NIGHT ⇄ sNight offer must price at par.

**It is conditional, and it cannot be a compose dependency.** A profile here IS a fragment
filename, so `compose/shielded-night.yml` may not name a service from `compose/offerfiles.yml`
(the same constraint that ruled out the obvious fix in the funding race). The one-shot
discriminates by DNS instead: if the hostname `kernel` does not resolve, the `offerfiles`
profile is not in this stack and it exits 0 after saying so. If it resolves but is not answering
yet, that is a race, and it waits. `up.sh` waits for its exit code only when both profiles are
present, and `./verify.sh --shielded-night` asserts the registry through the kernel's API — with
the expected colour derived independently, inside the kernel container.

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

## The external test-token faucet — six local issuers + their mint site (profile `faucet`)

`./up.sh --with faucet` deploys [`effectstream/mint-test-tokens`](https://github.com/effectstream/mint-test-tokens)
onto **this** chain and serves its mint site on `:10950`. It is in `--all` (spec answer 6): a
local faucet is key functionality, not an extra.

### Why the faucet is EXTERNAL now

Until this profile, the offer-files kernel carried its own faucet *contract* and minted its own
WBTC/WETH/TESTTOKEN colours. Kernel PR #69/#70 removed that entirely and replaced it with a
**canonical token registry** imported from mint-test-tokens
(`TOKEN_REGISTRY_BASE_URL` / `TOKEN_REGISTRY_NETWORK` ∈ preview|preprod|stagenet|undeployed).
The tokens a demo hands out are now a published artifact of one repository rather than a side
effect of whichever contract a given stack happened to deploy — which is the right shape, and
is what makes a local stack's tokens comparable with Preprod's by symbol and decimals.

**On `undeployed` that import is skipped by design**, because a local chain has no public
canonical registry to import from. So this profile deploys the issuers itself and bridges the
result into the kernel; see `registry-bridge` below.

### The six tokens, and the end of "6 decimals everywhere"

| Symbol | Name | Decimals | Privacy | Faucet amount |
|---|---|---|---|---|
| `twBTC` | Test-wrapped BTC | **8** | shielded | 1 |
| `twETH` | Test-wrapped ETH | **18** | shielded | 5 |
| `twUSDC` | Test-wrapped USDC | 6 | shielded | 10 000 |
| `twUSDM` | Test-wrapped USDM | 6 | shielded | 10 000 |
| `utwUSDC` | Unshielded-test-wrapped USDC | 6 | unshielded | 10 000 |
| `utwBTC` | Unshielded-test-wrapped BTC | **8** | unshielded | 1 |

Every earlier faucet in this repository minted 6-decimal tokens and whole coins × 10⁶; the
kernel's `known_tokens.decimals` even carries `DEFAULT 6` with a comment saying every token
this stack registers has 6. **That is no longer true.** These are the canonical scales of the
assets they stand in for, the column accepts 0–38, and `registry-bridge` sends each token's
real value explicitly. Any assertion that assumed 6 has to be re-read against the registry —
`scripts/verify-poster.sh`'s give-leg check was one of them, and it now asserts an exact
base-unit amount instead of "a multiple of 10⁶".

**The kernel knows these six by name already, and that is new at this pin.** A fresh database
seeds `TWBTC`, `TWETH`, `TWUSDC`, `TWUSDM`, `UTWUSDC` and `UTWBTC` — upper-cased, with exactly
these decimals, and with their CoinGecko asset ids (`bitcoin`, `ethereum`, `usd-coin`, `usdm-2`).
What it seeds with them is the **PreProd** colours, which no local chain has. That single fact is
what shapes `registry-bridge` below: its job on a fresh database is not to insert six rows, it is
to re-point six existing ones at the colours this chain's issuers actually minted, without
disturbing the asset ids that make them priceable.

Their **colours are not constants** either: each is the `tokenId` derived from its issuer's
contract address, so all six change on every fresh chain — the same property that forces
`SNIGHT`'s seeded row to be corrected per stack.

### No compiler in the image, and that is the stronger position

`images/mint-test-tokens` is the only from-source image here that downloads no `compactc` and
runs none. `contracts/v2/managed/` is **tracked** upstream (91 files, 62 MB, stamped compiler
0.34.0 / language 0.26.0 / runtime 0.19.0), and upstream's deploy and verify runners both call
`resolveReproducibleSourceRevision()` before they touch the chain: it refuses to run when any
file under `contracts/v2/{shielded-token.compact,unshielded-token.compact,managed/shielded,managed/unshielded}`
is modified, untracked or ignored. A recompile into that tree would therefore make the very
tool this image exists to run **refuse to deploy**.

That check is *stricter* than this repository's usual rebuild-and-diff, because it proves the
artifacts are the ones a third party can fetch from a named commit — not merely that they can
be reproduced. The image asserts the artifacts are tracked, that they declare the 2.x toolchain,
and that their zkir is **v2** (so `MN_PROOF_SERVER_URL` correctly points at core's plain
proof-server rather than the `aa` profile's experimental zkir-v3 one), and then runs that same
provenance gate itself at build time — so a bad tree fails in seconds rather than after a chain,
an indexer and a prover have come up. See `images/mint-test-tokens/PROVENANCE.md`.

### Eight services, two runtime targets of one image

1. **`faucet-fund`** (toolkit one-shot) waits for finality to move off genesis, gives
   `faucet-deployer` 10,000,000 NIGHT, registers its DUST address and waits for a *spendable*
   DUST UTXO. It **skips** a wallet that already has both.

   This step is not optional, and the upstream code reads as though it were. `deploy.ts` calls
   `wallet.start(true)` on `undeployed`, which upstream's docs describe as "request local
   faucet funding". In testkit `5.0.0-beta.7` `waitForFunds()` only contacts a faucet when
   `env.faucet` is **configured** — and `deploy.ts` passes `faucet: undefined`, so no request is
   ever made. What the flag actually buys is registering the wallet's NIGHT UTXOs for DUST
   generation. The runner then refuses to write a deployment intent until the wallet exposes
   positive DUST.
2. **`faucet-deploy`** (one-shot, `restart: "no"`) renders the seed into a **tmpfs** file
   (`/run/faucet`, mode 0600, removed on exit — RAM only, in no layer and no volume; upstream
   accepts a master seed only through a private file), then deploys or resumes the six issuers
   and publishes `metadata.undeployed.json` onto the `faucet-registry` volume by atomic rename.
3. **`faucet-verify`** (one-shot, **no seed at all**) runs upstream's read-only verification:
   every local verifier key compared with chain state, no missing or extra circuits, immutable
   metadata, each token ID re-derived from its contract address, the artifact tree hashed, the
   pinned source revision proved, the current maintenance authority matched, and the original
   `ContractDeploy` action re-queried at its recorded height for its canonical transaction
   hash, block height and block hash.
4. **`registry-bridge`** (one-shot) upserts the six rows into the kernel's `known_tokens` —
   conditional; see below.
5. **`registry-env`** (one-shot, **no seed, no wallet, no chain access at all**) reads
   `/registry/metadata.undeployed.json` and publishes `/registry/stack-tokens.env` by atomic
   rename: one block per token — `TWBTC_TOKEN_ID`, `TWBTC_DECIMALS`, `TWBTC_PRIVACY`,
   `TWBTC_CONTRACT_ADDRESS` — plus the ROLE names upstream's own `deploy/.env.example` uses:
   `OFFER_POSTER_GIVE_TOKEN`/`WANT_TOKEN`, `SOLVER_PROVISION_TOKEN_IN`/`OUT`, and `MAKER_OFFER_*`
   / `E2E_TOKEN_*` when their symbols are set. The role→symbol map lives in compose
   (`OFFER_POSTER_GIVE_SYMBOL` and friends), so changing the demo's market is a compose edit; a
   symbol the registry does not carry is a hard failure, so a typo cannot quietly produce a file
   whose absence the poster then reports.

   **Why a file on a volume rather than compose `env_file:`.** Compose evaluates `env_file:` on the
   HOST at render time — before any container has run, with no access to a named volume — and these
   ids do not exist until `faucet-deploy` has published the registry. The two alternatives measured
   were a two-phase bring-up (up, read the volume from the host, re-up) and a host bind-mount for
   the registry directory; both trade away the atomic-rename property and the one-volume-per-stack
   isolation, for nothing.
6. **`faucet-mint`** (one-shot) puts spendable local coins in the demo's wallets. It holds the
   deployer's seed plus each recipient's, all rendered into a **tmpfs** at `/run/faucet` (mode
   0600, gone when the container exits), and runs `/app/contracts/v2/faucet-mint.ts` — this
   repository's own runner, sitting beside upstream's `deploy.ts` and `mint-wallet-test.ts`.

   It is **idempotent by BALANCE**, which is not optional: compose re-runs a completed one-shot on
   every `up`, so an unconditional mint would grow the poster's wallet by four coins per bring-up.
   Each grant states a target and only the shortfall is minted, rounded up to whole coins of the
   grant amount. ONE funded fee payer — the faucet deployer — signs every mint, so a recipient
   needs no NIGHT and no DUST of its own. After each mint it waits for the RECIPIENT's own wallet
   to discover the balance, which is both what makes the next run's idempotence honest and what
   proves the shielded encrypted-output path (`additionalCoinEncPublicKeyMappings`) rather than
   merely that a transaction was accepted.

   The default grant is `FAUCET_MINT_POSTER_COINS` (4) coins of `OFFER_POSTER_GIVE_SYMBOL` (twBTC)
   at exactly `OFFER_POSTER_GIVE_AMOUNT` (100000000 — one whole twBTC at 8 decimals) to
   `POSTER_SEED`. The poster and this one-shot read the SAME two variables, which is what stops
   the coin that is minted and the coin that is looked for from drifting apart. Anything else goes
   in `FAUCET_MINT_GRANTS=label:seedhex:symbol:amount:coins;…`, empty by default — the AA console
   mints its own tokens through these very issuers, and the solver needs none.

   It is also **the wallet-serialization point**: it opens a facade on each recipient's seed to
   learn its keys and read its balance, and two facades on one seed against one Midnight node force
   each other's connection down. So every service whose seed appears in a grant must wait for this
   one-shot to COMPLETE, which is exactly what `offer-poster`'s
   `faucet-mint: service_completed_successfully` says.
7. **`faucet-site`** serves `frontend/dist` on container `:14119`, published as
   `${FAUCET_PORT:-10950}`. It uses upstream's own static server rather than nginx because the
   registry is **not** a file in the document root: `/metadata.undeployed.json` is answered out
   of the mounted directory, re-opened by path on every request, which is what makes the
   deploy's atomic rename visible without restarting anything.
8. **`faucet-mint-test`** carries a compose `profiles:` key, so `up.sh` never starts it. It is
   the opt-in mint evidence: `./scripts/verify-faucet.sh --mint`.

### Naming the six tokens in the kernel's token registry

`registry-bridge` is `shielded-night-register` for six rows instead of one, and it is built the
same way for the same reasons.

* It reads `/registry/metadata.undeployed.json` **by path** (the directory is mounted, never
  the file), validates the registry is `ready`, and maps each token to
  `{name: symbol, color: activeDeployment.tokenId, kind: privacy, decimals}`.
* **It upper-cases the symbol, on all three lanes — read, POST and UPDATE — and that is
  load-bearing.** `POST /v1/known-tokens` normalises with
  `String(name).trim().toUpperCase().slice(0, 16)`, so the kernel never holds `twBTC`; it holds
  `TWBTC`. `name` is `UNIQUE` and the schema already seeds all six upper-case names, so every
  POST answers 409 on a fresh database and the UPDATE lane is the one that runs — and that UPDATE
  is `WHERE name = …`, which Postgres compares case-SENSITIVELY. Sending the registry's own
  spelling matched no row, returned an empty `RETURNING`, was classified as "not ready yet" and
  would have failed every bring-up after eight retries. Normalising once, on our side, is what
  makes the write land on the seeded row.
* **It sends no `asset_id`, and at this pin that costs nothing.**
  `known_tokens.asset_id` REFERENCES `asset_prices(asset_id)`: a value that is not already a
  priced asset fails the foreign key, and a wrong one would price `twBTC` as something it is not.
  This one-shot has no price opinion and should not acquire one — the registry it reads carries
  none. It does not need one either. On a fresh database the seeded rows already carry
  `bitcoin`/`ethereum`/`usd-coin`/`usdm-2`, and `asset_id` is deliberately NOT in the UPDATE's
  `SET` list, so the seeded asset survives while only `token_color`, `kind` and `decimals` move.
  Price resolution's first step — `known_tokens.asset_id` — therefore prices a colour that did not
  exist an hour ago. **That is the answer to project question Q6**, and
  `scripts/verify-kernel.sh` asserts the end of it: all six names with decimals 8/18/6/6/6/8, and
  a `GET /v1/quote` that prices 1 twBTC → twETH with a positive suggested amount.
* **`PRICE_FEED_MAP` is a documented belt, not the mechanism.**
  `compose/offerfiles.yml` defaults it to
  `TWBTC=bitcoin,TWETH=ethereum,TWUSDC=usd-coin,TWUSDM=usdm-2,UTWUSDC=usd-coin,UTWBTC=bitcoin`,
  and on a fresh database it is never consulted, because `asset_id` wins. It earns its keep in
  exactly one case: a Postgres volume that PREDATES those seeds, where the bridge takes the POST
  lane and the row arrives with a NULL `asset_id` — and resolution by NAME is then the only thing
  left that prices it. The built-in map knows `WBTC`/`WETH`/`USDC`/`USDM`, never the `TW*`
  spellings. It is read by the NODE only; `packages/price-feed` fetches `SEEDED_ASSET_IDS` and
  ignores it, so naming assets the feed already fetches costs the `prices` profile nothing.
* `POST /v1/known-tokens` registers a missing row. The kernel serves no `PUT`/`PATCH`, its
  insert is `ON CONFLICT (token_color) DO NOTHING`, and `name` is `UNIQUE` — so the one case the
  API cannot express is a row whose NAME exists carrying a DIFFERENT colour, which answers 409.
  That is exactly one `UPDATE known_tokens … WHERE name`, which the kernel's own `000-init.sql`
  names as the remedy. At this pin that is the NORMAL path rather than the exception it was
  written as: the schema seeds all six with PreProd colours, so all six 409. Everything else goes
  through the API, and the end state is always re-read **through** `GET /v1/known-tokens`, never
  trusted from the write.
* It is **conditional**, and the discriminator is DNS rather than `depends_on`: a profile here
  IS a compose fragment filename, so the `kernel` service does not exist when
  `compose/offerfiles.yml` is out of the file set, and naming it would break every
  `--with faucet` stack. An unresolvable name is **waited out** (`FAUCET_KERNEL_DNS_WAIT_S`,
  300 s) before it is taken to mean "absent" — project 00015 P7 measured the silent form of this
  race, where a one-shot declared the profile absent 79 s before the kernel container started
  and `up.sh` then reported an all-clear over a registry it had never touched.
* Every kernel/database step runs through a bounded, **jittered** retry that treats a 5xx or a
  refused connection as "not ready yet" and any 4xx as a definitive answer (infra issue 00016).

Record as a follow-up: a kernel that could import from `TOKEN_REGISTRY_BASE_URL` on
`undeployed` would make this one-shot unnecessary.

### The site has no wallet of its own

It discovers DApp Connector API 4.x wallets, compares the wallet's reported network to the
selected registry, **delegates proving to the wallet**, submits the exact bytes wallet balancing
returned, and then watches the wallet-selected indexer for finalization. There is no in-page
wallet and no proof-server URL in the page at all — which is why `compose/faucet.yml` publishes
one port and injects no endpoints, and why a headless browser can read the registry and see six
ready tokens but cannot mint. The automated mint evidence is `faucet-mint-test`; see
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md#the-faucet-profile).

### It depends on nothing but core

No kernel, no Celestia, no Postgres, no evm, no aa. `./up.sh --with faucet` on its own is legal
and complete, and `scripts/verify-compose-pins.sh` renders `core faucet` alone as one of its
combinations so that a dependency added later fails a gate instead of a demo. That constraint is
also why `registry-bridge` runs on **this profile's own image** rather than the kernel's: a
kernel-image service would make a faucet-only bring-up build the entire offer-files kernel,
Compact toolchain and all.

## Appendix — the per-component notes that used to sit in the README's stack table

Moved here on 2026-09-07 when the README table split into a per-profile table and a
generated pin table. **The refs quoted below are as of that date and are NOT maintained** —
the live pins are the README's generated table and `config/artifact-decisions.json`. The
prose is kept because it explains *why* each row is what it is.

| Component | Profile | Endpoint (then) | Source · ref · note |
|---|---|---|---|
| Midnight node | `core` | RPC `http://127.0.0.1:9944` (HTTP+WS) | midnightntwrk/midnight-node *(upstream)* — official image `2.0.0-rc.4` pinned by multiarch index digest, `CFG_PRESET=dev` |
| Indexer | `core` | GraphQL v4 `http://127.0.0.1:8088/api/v4/graphql` (+`/ws`; `/api/v3` aliases v4) | official `4.4.0-rc.3` executable from the [`effectstream/binaries@0.3.120`](https://github.com/effectstream/binaries/releases/tag/0.3.120) warehouse *(development-only, mutable — pinned by SHA-256)*, installed into a thin local image: **no Rust build**, native `amd64` **and** `arm64`. Built upstream from [midnightntwrk/midnight-indexer](https://github.com/midnightntwrk/midnight-indexer) `56561b2f…`, recorded in the image as provenance; includes the standalone SQLite deadlock fix missing from rc1 |
| Proof server ×2 | `core` + `aa` | plain `http://127.0.0.1:6300`; experimental internal-only | `9.0.0-rc.5` plain (kernel's v6 / zkir-v2 keys) + `9.0.0-rc.5` experimental (the aa profile's zkir-v3 / v7 keys), pulled from `ghcr.io/effectstream/midnight-proof-server` by digest. Exact byte-for-byte mirrors of the upstream `midnightntwrk/proof-server` indexes *(upstream availability at startup is unreliable; the bytes are identical — `images/proof-server-mirror/`)*. Two **different programs**, separately pinned |
| Proof data (shared cache) | `core` | internal — one named `proof-params` volume | SRS K0-K19 + Ledger-static `9.0.0`, 21 noarch payloads from the same `effectstream/binaries@0.3.120` warehouse. A one-shot initializer verifies every hash and activates ONE immutable generation; both proof servers mount it **read-only**. Not in any image layer, never duplicated per architecture or variant |
| PostgreSQL (shared store) | `core` | internal only — `docker compose … exec postgres psql -U offerfiles offerfiles` | `postgres:17-alpine` *(upstream)* + `pg_ivm` 1.11 compiled in (`images/postgres/`). ONE server for the stack: db `offerfiles` = the kernel's offer book, db `umbra` = umbra-evm's index |
| Wallet tooling | `core` | `scripts/fund-wallet.sh`, `verify-wallets.sh` | midnightntwrk/midnight-node-toolkit *(upstream)* — official image `2.0.0-rc.4` pinned by multiarch index digest (must match the node) |
| umbra-evm (read-only eth JSON-RPC) | `evm` | HTTP `http://127.0.0.1:8545` (chainId 2400) · WS `ws://127.0.0.1:10021` | [acedward/UmbraDB](https://github.com/acedward/UmbraDB) — pinned `5a463485…` from `evm-compat`; [PR #5](https://github.com/acedward/UmbraDB/pull/5) is the home of the JSON-RPC work |
| Celestia DA devnet | `offerfiles` | DA JSON-RPC `http://127.0.0.1:26658` (bearer token: `scripts/celestia-token.sh`) | app `6.4.10` + node `0.28.4` from the same `effectstream/binaries@0.3.120` warehouse, each archive byte-equal to the official celestiaorg release asset (`images/celestia/official-equality.tsv`); one container, native `amd64` **and** `arm64` |
| Offer-files kernel (sync node) | `offerfiles` | API `http://127.0.0.1:9999` | [effectstream/zswap-offerfiles-kernel](https://github.com/effectstream/zswap-offerfiles-kernel) — pinned `5d794f9…` (`KERNEL_REF`) on branch **`ledger-v9`**, the unified v9 line: kernel + batcher + solver + the token price service (`/v1/prices`, `/v1/quote`) on ONE commit. The pin is [PR #71](https://github.com/effectstream/zswap-offerfiles-kernel/pull/71)'s merge of [#69](https://github.com/effectstream/zswap-offerfiles-kernel/pull/69) and [#70](https://github.com/effectstream/zswap-offerfiles-kernel/pull/70), **which DELETE the offer-files contract**, onto the branch that already carried [PR #67](https://github.com/effectstream/zswap-offerfiles-kernel/pull/67) (**compactc 0.34.0 · compact-runtime 0.19.0**) and [PR #68](https://github.com/effectstream/zswap-offerfiles-kernel/pull/68). The branch is still open as [PR #65](https://github.com/effectstream/zswap-offerfiles-kernel/pull/65) — the SHA is the identity, not the branch. **NO contract, no deploy one-shot, no compactc in the image**, and `GET /v1/midnight/config` answers no `contractAddress`; the tokens the book trades come from the `faucet` profile |
| Offer-files batcher | `offerfiles` | `http://127.0.0.1:3334` | same repo/commit — its own container, restarts independently of the kernel; asks the kernel's `/v1/prices` for each offer's legs (fee sponsorship) |
| — token-name one-shot | `faucet` | internal | `registry-bridge` — names this stack's six local colours in the kernel's `known_tokens` once the kernel is healthy, upper-cased, with their real decimals (8/18/6/6/6/8). It replaced `offerfiles`' own `register-tokens`, which named three colours derived from the deleted contract. Names are what price a colour since the price service landed, and this one re-points the kernel's SEEDED rows so their `asset_id` survives |
| — token-id renderer | `faucet` | internal | `registry-env` — no seed, no wallet, no chain access: reads the registry and publishes `/registry/stack-tokens.env` by atomic rename, one `<SYMBOL>_TOKEN_ID` block per token plus the role names (`OFFER_POSTER_GIVE_TOKEN`, `SOLVER_PROVISION_TOKEN_IN`, …). Compose `env_file:` cannot do this job — it is evaluated on the host before any container has run |
| — inventory mint | `faucet` | internal | `faucet-mint` — mints this stack's demo wallets their local test-token coins, idempotent BY BALANCE (compose re-runs a completed one-shot on every `up`), one funded fee payer for every recipient, seeds in a tmpfs only. It is also the wallet-serialization point the offer poster waits on |
| COW solver (observation mode) + sink | `solver` | **nothing published** — see the monitor row below | same repo/commit at `SOLVER_REF`; **not vendored**; generated contract artifacts reuse the service-built kernel image. Runs `start.solver.ts` behind an `undeployed`-only gate. `solver-sink` is the relay's receive half and is internal: it holds the observation-safety counters that `./verify.sh --solver` reads over the compose network |
| — solver monitor site | `solver` | **`http://127.0.0.1:10802`** | `solver-frontend` from the kernel image — the read-only "is it quoting, and if not why" page. Reads the solver's status listener on the unpublished `:9100`, the kernel API and the sink's `GET /tokens`; holds no wallet, mutates nothing |
| Offer poster (the book fills itself) | `poster` — **needs `faucet` too** | health `http://127.0.0.1:10803/health` | same repo/commit — **selects** an existing coin of exactly `OFFER_POSTER_GIVE_AMOUNT` and posts one takeable offer per interval, paying fees with its own DUST. It does not mint: inventory is finite and comes from `faucet-mint`, and both token ids are resolved by symbol out of `registry-env`'s file. Dedicated seed (`0ffe…`), NIGHT from a `poster-fund` one-shot; durable journal on its own volume |
| zswap-da frontend (swap SPA) | `frontend` | `http://127.0.0.1:10600` | [`effectstream/effectstream@ea04ff7c`](https://github.com/effectstream/effectstream/tree/ea04ff7c16dab5118d4bdfeec6e7455c89981827/templates/zswap-da) — fetched directly at build time and adapted by the checked-in 13-file `images/zswap-da/ledger-v9.patch`; no frontend source tree is committed. The patch carries a copy of the kernel's `offer-files.compact` and a manifest regenerated with compactc `0.34.0` — taken when the SPA still proved calls against the contract the kernel deployed. At `KERNEL_REF 5d794f9` that file exists nowhere else and nothing deploys it, so the patch's copy is the last one and the SPA's own faucet lane is inert; the swap path itself trades whatever colours the book carries. Whole-coin display against a kernel that no longer assumes 6 decimals anywhere — this template predates the six local tokens' real scales (8/18/6/6/6/8) and its own faucet lane has no contract on this chain — and **usable in a browser on ANY port block**: the image injects `window.MIDNIGHT_HOST_PORTS` at container start and `browser-network-urls.patch` maps the kernel's compose-internal URIs through it |
| Shielded NIGHT dApp (NIGHT ⇄ sNight) | `shielded-night` | `http://127.0.0.1:10900` | [effectstream/shielded-night](https://github.com/effectstream/shielded-night) — branch **`ledger-v9`** @ `30af63f3…` ([PR #10](https://github.com/effectstream/shielded-night/pull/10), the 2.x port; `main` is the 1.x line). Contract, harness and page from ONE commit, no patch of any kind; the contract is **recompiled in-image** with SHA-256-pinned compactc `0.34.0` and the build fails unless the output is byte-identical to the committed `src/managed/`. Deploys ONCE per stack (`shielded-night-deploy` one-shot, address persisted on a volume and injected into the page as `/config.js`). With `--with offerfiles` a second one-shot names **this stack's** sNight colour in the kernel's token registry — the schema seeds *preview's*, and the colour follows the contract address |
| AA Manager + Minter | `aa` | deploy receipt in the `aa-out` volume | [acedward/AA-midnight-evm-experiment-v3](https://github.com/acedward/AA-midnight-evm-experiment-v3) — `main @ 41de69de` (sha-pinned; key-breaking merges need a redeploy) · [PR #12](https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/12) split `manager.compact` into a preset + nine modules. Compiled in-image with the compactc `0.34.0` / compact-runtime `0.19.0` the kernel tree still pins — ONE toolchain, which is what closed the old two-toolchain hazard, and which must now also match the runtime the COPIED mint-test-tokens artifacts were built for, since the console loads those beside the Manager's — **except `execute`**, which comes from [acedward/AA-midnight-evm-experiment-minocrab](https://github.com/acedward/AA-midnight-evm-experiment-minocrab) release **`v0.2.0`** by default (`AA_ZKIR_SOURCE=minocrab`): the same contract transcribed into MinoCrab, a third-party Rust compiler, landing `execute` at **k = 18 / 211,047 rows** instead of compactc's k = 19 / 382,780 — half the proving key (544 MiB vs 1.14 GB), roughly half the proving time. The image downloads the release's files and takes them by SHA-256; the identity is `sha256(SHA256SUMS)` = `4a8c0183…`, **never the tag**. **Unaudited compiler; equivalence TESTED, NOT PROVEN** (59 differential tests, 5,128 tamper probes, 0 acceptance disagreements) — dev chains only, see [KNOWN-LIMITATIONS](docs/KNOWN-LIMITATIONS.md). `AA_ZKIR_SOURCE=compactc` opts out; `minocrab-all` takes all nine circuits |
| **AA web console** (this stack's UI) | `aa` | **`http://127.0.0.1:10700`** | this repo (`images/aa-contracts/console/`) — tabs: AA+EVM, AA+Midnight (preview), COW solver feed, infrastructure canvas, Memos, Repos |
| `@effectstream` packages | (npm) | — | [effectstream/effectstream](https://github.com/effectstream/effectstream) — the versions the kernel pin resolves: `@effectstream/celestia`, `midnight-contracts`, `orchestrator` `@0.200.2` · `mip-zswap-offer@0.4.0-v9.0` · `@midnightntwrk/ledger-v9@1.0.0-rc.3` (a root `overrides` entry, so ONE ledger WASM per process) · midnight-js network-id `5.0.0-beta.6` |
| Midnight Intents relay | (dropped) | — | [shieldedtech/midnight-intents-swaps](https://github.com/shieldedtech/midnight-intents-swaps) *(upstream)* — pinned `d444c83` by the solver branch; NOT run (the solver observes only). `solver-sink` stands in for its RECEIVE half, plus the one public route the monitor reads (`GET /tokens`) |
| Price feed (CoinGecko) | `prices` (opt-in) | no port — writes `asset_prices`, read back through the kernel's `/v1/prices` | same repo/commit — the daily CoinGecko refresh of the USD reference prices behind `/v1/prices`, `/v1/quote` and the batcher's sponsorship gate. **Opt-in and skipped by `--all` unless `COINGECKO_API_KEY` is set**: the schema seeds real prices, so quotes work without it, and this is the only component here that talks to a third party and holds a genuine secret |
| Web Memo (Memos tab) | (embedded) | `https://web-memo.pages.dev` | [acedward/web-memo](https://github.com/acedward/web-memo) — `main`, Cloudflare Pages · builds on [acedward/midnight-ledger PR #2](https://github.com/acedward/midnight-ledger/pull/2) (memo-v3 ledger fork) |
| dusk-wallet | (related work) | — | [acedward/dusk-wallet](https://github.com/acedward/dusk-wallet/tree/00001-utxo-pinning) — branch `00001-utxo-pinning` · PRIVATE repo |
