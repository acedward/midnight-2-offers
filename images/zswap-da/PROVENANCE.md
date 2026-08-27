# zswap-da frontend build provenance

The frontend image fetches `templates/zswap-da` directly from
[`effectstream/effectstream`](https://github.com/effectstream/effectstream) at immutable commit
`332503c8f9216143a8c805f2a0acbcfd39e5a21d`, whose template subtree is
`1f63d7eedc9a8aff729b7fe026486cb89cb618de`. Both identities are verified before checkout, and the
resolved commit is recorded as `/.zswap-da-commit` in the runtime image. Changing the ref therefore
requires an explicit review of the expected subtree and adaptation patch.

Upstream is still on the ledger-v8 dependency lane. `ledger-v9.patch` is the complete local
adaptation and applies fail-closed with `git apply --check`. It contains only:

- `package.json` and the reproducible `bun.lock` dependency migration;
- the compactc `0.33.0-rc.2` build-script and 17-artifact manifest update;
- six TypeScript modules whose ledger transaction imports/names change from v8 to v9, including
  the Midnight.js 5 `FetchZkConfigProvider` options signature.

Audit against the pinned upstream tree found 64 byte-identical files and 12 divergent files. The
two prose-only divergences (`README.md` and `src/contract/README.md`) are intentionally not carried;
the other ten are represented by the patch. The former packaging-only `.dockerignore` and
`VENDORED.md` are also not runtime inputs.

No generated `managed/` contract output is committed. The image compiles the upstream tracked
Compact source and verifies every generated file against the patched manifest before Vite builds.
The upstream `LICENSE-APACHE` and `LICENSE-MIT` notices are copied from the pinned source into
`/usr/share/licenses/zswap-da/` in the runtime image.
