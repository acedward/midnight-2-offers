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
- the compactc `0.33.0-rc.2` build-script and 17-artifact manifest update;
- seven TypeScript modules whose ledger transaction imports/names change from v8 to v9, including
  the Midnight.js 5 `FetchZkConfigProvider` options signature.

The patch therefore touches 11 of the template's 100 files, and nothing else: it is generated as a
`git diff` from the pristine subtree, so `index` lines are present and a future rebase can use
`git apply --3way`. Prose divergences (`README.md`, `src/contract/README.md`) are deliberately not
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

No generated `managed/` contract output is committed. The image compiles the upstream tracked
Compact source and verifies every generated file against the patched manifest before Vite builds.
The upstream `LICENSE-APACHE` and `LICENSE-MIT` notices are copied from the pinned source into
`/usr/share/licenses/zswap-da/` in the runtime image.
