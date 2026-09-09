# zswap-da frontend build provenance

The frontend image fetches `templates/zswap-da` directly from
[`effectstream/effectstream`](https://github.com/effectstream/effectstream), branch
**`midnight-1`**, at immutable commit `400880ceb6814738d1ae193dae18ad5128922edc`, whose template
subtree is `a750cccd653f33306d3ff7249fe8d5853fbfafa6`. Both identities are verified before
checkout; the resolved commit is recorded as `/.zswap-da-commit` and the branch as
`/.zswap-da-branch` in the runtime image, and `scripts/verify-source-pins.sh` asserts both on a
running stack. Changing the ref therefore requires an explicit review of the expected subtree and
the adaptation patches.

## Why branch `midnight-1`

The owner's decision (spec 00017, answer 3). `midnight-1` is upstream's preprod / Node 1 line: at
this pin it is on `@effectstream/*@0.104.x`, `@midnight-ntwrk/ledger-v8@8.1.0`, midnight-js
`4.1.1` and wallet-sdk-address-format `3.1.2`, where `v-next` is already on the 0.200.x line. The
demo runs the 2.x stack, so `ledger-v9.patch` carries that whole dependency port; the measured
comparison of the two branches' rebase cost is in the project's questions file (Q1). The pinned
commit is the merge of [PR #922](https://github.com/effectstream/effectstream/pull/922), which
removed the template's local faucet contract — the same correction `v-next` got in #921 — so the
two branches' source trees have converged and the only remaining difference is the dependency
generation, which this patch resolves.

## There is no contract and no compiler in this image

Until #922 the template shipped `src/contract/offer-files.compact`, a checked-in 17-artifact
manifest and `scripts/build-contract.ts`, and this image carried a whole SHA-256-pinned compactc
0.34.0 stage to compile that source and verify the output against the manifest before Vite ran.
Both ends of that arrangement are gone: upstream deleted the template's contract lane in #922, and
the pinned kernel deleted its own in [#69/#70](https://github.com/effectstream/zswap-offerfiles-kernel/pull/70).
Test tokens now come from the external `mint-test-tokens` faucet, which deploys its own issuers and
owns their artifacts. Compiling anything here would be compiling a contract nothing deploys, so:

- the `compact` build stage, the `COMPACT_VERSION` / `COMPACT_SHA256_*` ARGs and the
  `bun run scripts/build-contract.ts --verify-only` step are deleted;
- stage 0 asserts the ABSENCE of `scripts/build-contract.ts`, `src/contract/`,
  `src/hooks/useContract.ts`, `src/services/browserContract.ts`, `src/services/contractWallet.ts`,
  `src/screens/Faucet.tsx` and of any `mint_shielded`/`mint_unshielded` reference — so a future
  `FRONTEND_REF` that brings the contract lane back fails the build naming the file, rather than
  quietly producing an image that lost a compilation step it used to have;
- stage 1 asserts that no ZK artifacts were emitted and that no `compactc` is on `PATH`;
- `scripts/verify-source-pins.sh` re-asserts the same two things against the running image.

## `ledger-v9.patch`

The complete dependency and ledger adaptation. It applies fail-closed with `git apply --check`, is
generated as a `git diff` from the pristine subtree (so `index` lines are present and a future
rebase can use `git apply --3way`), and touches **8 files in 31 hunks**:

- `package.json` and the regenerated `bun.lock`. The dependency port is the substance of this
  patch: `@effectstream/midnight-contracts` and `@effectstream/wallets` `0.104.0 → 0.200.2`,
  `@effectstream/mip-zswap-offer` `0.2.0 → 0.4.0-v9.0`, `@midnight-ntwrk/ledger-v8@8.1.0` →
  `@midnightntwrk/ledger-v9@1.0.0-rc.3`, midnight-js `network-id`/`types`/`utils`
  `4.1.1 → 5.0.0-beta.6`, `@midnightntwrk/wallet-sdk-address-format` `3.1.2 → 4.0.0-beta.2`.
  `0.200.2` is not an arbitrary choice of the latest: it is what the pinned kernel's own root
  manifest resolves at `KERNEL_REF`, and the offers this SPA decodes, merges and settles are the
  bytes that kernel and its batcher produced.
- Six modules whose ledger imports and type names move from v8 to v9: `src/decodeOffer.ts`,
  `src/services/{browserOffers,offerBatch,offerParse,offerSender}.ts` and
  `src/services/offerBatch.test.ts`.

`@midnight-ntwrk/compact-runtime` and `@midnight-ntwrk/compact-js` are **not** installed and not
overridden. The previous patch pinned `compact-runtime@0.19.0` because the generated contract
module opened with `checkRuntimeVersion('0.19.0')`; with the contract gone nothing in `src/`
imports either package (the only remaining mention is a comment in `src/shims/crypto.ts`), so the
override has no subject. The five midnight-js provider packages the old manifest carried
(`contracts`, `fetch-zk-config-provider`, `http-client-proof-provider`,
`indexer-public-data-provider`, `level-private-state-provider`) were already dropped upstream.

`overrides` still pins `@midnightntwrk/ledger-v9`. It is a wasm-bindgen module whose exported
classes carry per-instance type identity, so two copies in one bundle make every cross-copy value
fail an `instanceof` check — the historical symptom was `expected instance of _DustParameters` at
wallet connect. The built tree has exactly one `node_modules/@midnightntwrk/ledger-v9` and the
bundle exactly one `midnight_ledger_wasm_v9_bg-*.wasm`.

### The one API change beyond the renames

ledger-v9 declares `SignatureVerifyingKey = { tag: 'schnorr' | 'ecdsa', value: string }` and types
`UtxoSpend.owner` as one, where the v8 package accepted the bare hex string; the fixture helper's
`'gets'` branch in `offerBatch.test.ts` therefore builds `{ tag, value }`. `UtxoOutput.owner` is
still a plain `UserAddress` string and is left alone. Because `tsconfig.app.json` excludes test
files, neither `tsc -b` nor `vite build` can see this — the image would build green either way, so
`bun test` (run inside the image, stage 1) is the only gate that covers it.

Prose divergences (`README.md`) are deliberately not carried — this repo documents the stack in its
own README.

**Verified in the patched tree at this pin:** `bun install` resolves 627 packages,
`bun test` is **250 pass / 0 fail** across 17 files, `tsc -b` exits 0, and `vite build` exits 0
emitting a single 10.3 MB `midnight_ledger_wasm_v9_bg-*.wasm`.

## `browser-network-urls.patch`

The second local adaptation: everything the bundle must not bake, because one image is built once
and run against any stack and any chain. Three files, five hunks. (The name is historical — Q13
weighed a third patch file against widening this one and chose widening, since every value here is
resolved by the same `/config.js` injection.)

**`src/services/api.ts` — where the chain is.** `GET /v1/midnight/config` reports the URIs the
KERNEL dials: inside compose those are service hostnames on CONTAINER ports, and at the pinned
`KERNEL_REF` the response is exactly `{indexerUri, indexerWsUri, proofServerUri, networkId}` —
no contract address (upstream's own `api.test.ts` asserts that) and **no node URI at all**. At this
template pin upstream has adopted a rewrite of its own in `api.getMidnightConfig`: a
`window.<SCREAMING_SNAKE>` full-URI override pass, then a hostname-only rewrite that KEEPS the
container port. That second step is right only on a default port layout, and
`scripts/pick-ports.sh` deliberately does not use one. So the patch no longer inserts a rewrite —
it completes upstream's:

- the hostname match now also captures the port, which is mapped through
  `window.MIDNIGHT_HOST_PORTS` (a compose-hostname → PUBLISHED-host-port table
  `docker-entrypoint-frontend.sh` writes into `/config.js` at container start; only Docker knows
  it). An unmapped hostname keeps its port, so upstream's behaviour is the fallback;
- a third step synthesizes `nodeUri` from the same map, completing the template's own
  `http://<page host>:9944` fallback in `src/state/wallet.ts`;
- `MidnightRuntimeConfig` gains the optional `nodeUri`.

Upstream's override pass is untouched and still wins. Scheme and path are never touched, so the
kernel stays the authority on the indexer's API version — this repository holds no copy of it.

**`src/config.ts` — which network, and where the faucet is.** Upstream resolves both at BUILD time:
`VITE_MIDNIGHT_NETWORK_ID` defaulting to `preprod`, and `VITE_FAUCET_URL` defaulting to the public
`https://mint-test-tokens.pages.dev/`. Neither is usable here. The network id is the wallet's
network id AND the `?network=` the Faucet link carries, and the faucet site serves a different
registry per network — a stack that said `preprod` would send the operator to a page that knows
nothing about this chain's six issuers. The faucet's own origin is worse than build-time: the
container knows the PUBLISHED port and only the page knows the host. So `config.ts` gains the same
`window` override shape `API_BASE`/`BATCHER_URL` already use — `window.MIDNIGHT_NETWORK_ID`,
`window.FAUCET_HOST_PORT` (origin composed in the page from `location.hostname`) and
`window.FAUCET_URL` as a verbatim-URL escape hatch.

`src/faucetUrl.ts` is **not** patched, and that is a measurement rather than an omission:
`buildFaucetUrl` does `searchParams.set('network', networkId.trim().toLowerCase() || 'preprod')`,
so it passes any network through and falls back to preprod only for an EMPTY value. Upstream's own
`faucetUrl.test.ts` already pins `undeployed` as a preserved value.

**`src/config.ts` + `src/state/useZSwapApp.ts` — which wallet.** `connectLocal(seed?)` passes the
seed to `@effectstream/wallets`' local connector, which does `args.seed ?? generateRandomHexSeed(32)`
— and the app calls it with **no seed** and offers no seed field anywhere in its UI. So the in-page
demo wallet was a brand-new EMPTY wallet on every page load. That was survivable while the template
had a faucet contract to mint with; with the contract gone it is a wallet that can never acquire
anything at all, because `faucet-mint` mints to a wallet built from a SEED and the faucet site
drives an injected extension wallet an in-page wallet is not. `config.ts` therefore exports
`DEMO_WALLET_SEED` from `window` (undefined when absent, so upstream's random behaviour is the
fallback for anyone serving this `dist/` outside the demo) and `connectLocalWallet` passes it. The
stack's `demo-spa` wallet is then prefundable, and it survives a page reload.

The Dockerfile greps for `pageHost` and `MIDNIGHT_HOST_PORTS` in `api.ts`, for `FAUCET_HOST_PORT`,
`MIDNIGHT_NETWORK_ID` and `DEMO_WALLET_SEED` in `config.ts`, and for
`connectLocal(DEMO_WALLET_SEED)` in `useZSwapApp.ts` after applying the patch, so a patch that
silently stops doing any of those fails the build.

## Decimals

The SPA reads every token's `decimals` from the kernel registry (`GET /v1/known-tokens`) — this
template pin carries that work already: `src/hooks/useTokens.ts` normalises the field once for
every screen, `src/state/amount.ts` is whole-coins ⇄ base-units in string/bigint maths with
`decimals` as a parameter, and `KnownToken.decimals` is documented as the only thing that says how
an on-chain integer should be read. `DEFAULT_DECIMALS = 6` survives solely as the fallback for a
colour that is in NO registry. Since `registry-bridge` publishes all six local tokens with their
real scales (twBTC 8, twETH 18, twUSDC 6, twUSDM 6, utwUSDC 6, utwBTC 8), the SPA displays those.
No patch is needed for this and none is made.

## Licences

No generated `managed/` contract output is committed, and none is produced. The upstream
`LICENSE-APACHE` and `LICENSE-MIT` notices are copied from the pinned source into
`/usr/share/licenses/zswap-da/` in the runtime image.
