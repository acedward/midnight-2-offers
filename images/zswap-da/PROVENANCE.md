# zswap-da frontend build provenance

The frontend image fetches `templates/zswap-da` directly from
[`effectstream/effectstream`](https://github.com/effectstream/effectstream) at immutable commit
`ea04ff7c16dab5118d4bdfeec6e7455c89981827`, whose template subtree is
`ea22913c345da3dae36e113fdbced2bb1897de63`. Both identities are verified before checkout, and the
resolved commit is recorded as `/.zswap-da-commit` in the runtime image. Changing the ref therefore
requires an explicit review of the expected subtree and adaptation patch.

Upstream is still on the ledger-v8 dependency lane. `ledger-v9.patch` is the complete local
adaptation and applies fail-closed with `git apply --check`. It contains only:

- `package.json` and the reproducible `bun.lock` dependency migration;
- the compactc `0.34.0` build-script and 17-artifact manifest update;
- `src/contract/offer-files.compact`, taken verbatim from the pinned kernel (see below);
- `src/services/mintRecipient.ts`, a copy of the kernel's `mint-recipient.ts` helper;
- eight TypeScript modules whose ledger transaction imports/names change from v8 to v9, including
  the Midnight.js 5 `FetchZkConfigProvider` options signature and the two faucet mint calls.

The patch therefore touches 13 of the template's 100 files, and nothing else: it is generated as a
`git diff` from the pristine subtree, so `index` lines are present and a future rebase can use
`git apply --3way`.

**Why the contract source is now IN the patch (00015).** The SPA proves calls against the contract
the pinned kernel deployed, so its 17 compiled artifacts must be the bytes that kernel's own image
produced — same source, same compiler, same runtime. At the previous kernel pin the template's
`src/contract/offer-files.compact` was already byte-identical to the kernel's
(`sha256 6fde5f8e…`), so the patch could stay silent about it and the identity held by luck.
Kernel PR #67 changed both mint circuits in place — an explicit
`Either<ZswapCoinPublicKey, ContractAddress>` / `Either<ContractAddress, UserAddress>` recipient —
and the template did not follow, so the patch now carries the kernel's file
(`sha256 3cf4cb51a5bc6ad9ac02adf828254caeee68c5b861d31d7319106289ee0d2546`) and the manifest
regenerated from it with compactc `0.34.0`. `keys/incrementNoun.*` are unchanged across the bump,
which is the expected signature of "only the two mint circuits moved". The `compact` stage of the
Dockerfile verifies the compiler archive against the SHA-256 the kernel records and refuses to build
if `compactc --runtime-version` disagrees with the `@midnight-ntwrk/compact-runtime` this patch
installs, so the three pins cannot drift apart quietly. Prose divergences (`README.md`, `src/contract/README.md`) are deliberately not
carried — this repo documents the stack in its own README — and the template's `.test.ts` files are
excluded from the app build by `tsconfig.app.json`, but `src/services/offerBatch.test.ts` is
migrated with its module so `bun test` keeps working in the patched tree — verified, not assumed:
`bun install --frozen-lockfile && bun test src/` in the patched tree is **241 pass / 0 fail**.

That verification is why the test carries one adaptation beyond the import rename. ledger-v9
declares `SignatureVerifyingKey = { tag: 'schnorr' | 'ecdsa', value: string }` and types
`UtxoSpend.owner` as one, where the v8 package accepted the bare hex string; the fixture helper's
`'gets'` branch therefore has to build `{ tag, value }`. `UtxoOutput.owner` is still a plain
`UserAddress` string and is left alone. Because `tsconfig.app.json` excludes test files, neither
`tsc -b` nor `vite build` can see this — the image builds green either way, so `bun test` is the
only gate that covers it.

The patch was last rebased on 2026-09-03 from `332503c8` to `ea04ff7c` (a three-way merge with the
adaptation as `ours`): upstream's `package.json` and `bun.lock` are byte-identical across those two
commits, so the dependency set is unchanged; two files conflicted (`src/services/browserContract.ts`,
`src/services/localTradeOffers.ts`) because upstream moved single-offer decode/deserialize into the
new `src/services/offerBatch.ts` — upstream's shape was taken in both, and the v8→v9 migration moved
with the code into `offerBatch.ts`. `localTradeOffers.ts` no longer imports the ledger at all.

`browser-network-urls.patch` is the second, much smaller local adaptation, and it exists because
the page is the only client that cannot talk over the compose network. `GET /v1/midnight/config`
reports the URIs the KERNEL dials — compose hostnames on CONTAINER ports — and reports no node URI
at all. The patch fixes both halves in `api.getMidnightConfig`, the one function every consumer
goes through: the hostname becomes the page's own host, the port becomes the PUBLISHED host port
read from `window.MIDNIGHT_HOST_PORTS` (written into `/config.js` by
`docker-entrypoint-frontend.sh` at container start), and the template's `http://<page host>:9944`
node fallback is completed from the same map. Scheme and path are never touched, so the kernel
stays the authority on the indexer's API version — this repository holds no copy of it. The
Dockerfile greps for both `pageHost` and `MIDNIGHT_HOST_PORTS` after applying it, so a patch that
silently stops doing either half fails the build. Extended on 2026-09-04; before that it rewrote
only the hostname, which made the SPA browser-usable on the default port layout alone.

No generated `managed/` contract output is committed. The image compiles the upstream tracked
Compact source and verifies every generated file against the patched manifest before Vite builds.
The upstream `LICENSE-APACHE` and `LICENSE-MIT` notices are copied from the pinned source into
`/usr/share/licenses/zswap-da/` in the runtime image.
