# `images/proof-params` provenance

One immutable, warehouse-backed Ledger-9 proof-data generation, populated once and mounted
read-only by both `9.0.0-rc.5` proof-server variants.

## Imported unchanged from the audited cache source

Repository `acedward/midnight-binary-forge`, commit
`546185faefcf91f9d1fe9169041b05394e8e4d29` (branch `codex/00002-phase3p-proof-data`,
merged as PR #8). These four files are byte-identical copies — do not hand-edit them; to
change one, change it upstream and re-import, or the audit trail breaks.

| File here | Upstream path | SHA-256 |
|---|---|---|
| `bootstrap/forge_io.py` | `scripts/forge_io.py` | `890e5bc9e62efd01c8a5aaaeca77c3c4430fcb679af029024c89a9b8a70004a7` |
| `bootstrap/proof_cache_bootstrap.py` | `scripts/proof_cache_bootstrap.py` | `560c4b70778a3ffa8e8a3a28be547f75c740cea61d53626edfd765d57cc9327e` |
| `manifests/q8b-v1.json` | `catalog/proof-data/q8b-v1.json` | `ca854fbf98cb0b3ae5343daf8b57524f3b0bb27476ad02731e093d92cc8c66dc` |
| `manifests/q8b-cache-admission-v1.json` | `catalog/proof-data/q8b-cache-admission-v1.json` | `e2e3a4d33ca9a79d18e442d482c24b5dc105c793d1105aba07b561715c4db1df` |

`q8b-v1.json`'s file digest is also its canonical-JSON digest, which is why the admission
contract's `proofSetSha256` (`ca854fbf…`) equals `sha256sum manifests/q8b-v1.json`.

Deliberately **not** imported, because the bootstrap never reads them at run time:
`catalog/proof-data/ledger-static-9-member-manifest.json` and
`…-zip-layout-manifest.json` (the producer-side ZIP assembly inputs). The admission
contract already re-derives the Ledger-static semantic member-manifest digest
`9ba79d1d49d10465f46db247ffe5e4ae3f779ad06f07d1869169a427a907ac0c` from the content rows
themselves, so importing them would only create a second, driftable source of truth.

## Added here

| File | Purpose |
|---|---|
| `manifests/warehouse-proof-data-v1.json` | Binds each of the 21 admitted noarch payloads to one exact `effectstream/binaries@0.3.120` release asset (name, asset id, URL, size, SHA-256, semantic id, source commit). |
| `bootstrap/warehouse_resolver.py` | Validates that binding against the admission contract and downloads exactly those 21 objects, fail-closed. |
| `bootstrap/entrypoint.py` | One-shot orchestration: validate → skip if already active → download → stage → atomically activate → re-verify. |
| `tests/` | Self-contained gate: reference Compose topology, lifecycle/negative cases, and two offline real-proof fixtures. `tests/proof-fixture/README.md` explains the cache-resident Zswap proof and its empty-cache negative control; `tests/zkir-fixture/README.md` explains the ZKIR-v2/v3 contract-circuit proofs and their variant-distinction control. |

### Test-only compiler pin (`tests/zkir-fixture/`)

The ZKIR fixture needs a Compact compiler, so one is pinned **for tests only**. It is the
same release asset the demo already uses for the kernel and the AA contracts, so no demo
toolchain pin changes and spec FR-014 is untouched — reusing it is what keeps that true.

| Field | Value |
|---|---|
| Release | `https://github.com/LFDT-Minokawa/compact/releases/tag/compactc-v0.33.0-rc.2` |
| `compactc_v0.33.0-rc.2_x86_64-unknown-linux-musl.zip` | SHA-256 `3055ab92bbc8d5bb0d6282b661b83761d2a0de2ee37e21cf7107e25aaf2a9aad`, 32 498 268 B, asset id `478090789` |
| `compactc_v0.33.0-rc.2_aarch64-unknown-linux-musl.zip` | SHA-256 `3aa23812b0b086dbce07da3931a40dcb01bec9676b1ceed7f2d0be370ab2dc46`, 31 550 294 B, asset id `478090787` |
| Reported versions | compiler `0.33.0`, language `0.25.0`, runtime `0.18.0-rc.1` |
| Bundled backends | `zkir` (`midnight-zkir 2.2.0`) and `zkir-v3` (`midnight-zkir-v3 3.0.0-rc.2`) |

**No contract proving key produced by it may enter this component.** Keys are generated at
test run time into a test-scoped volume that the gate's scoped teardown removes; the
toolchain image is built to fail if it contains any `*.prover` file; the shared
`proof-params` volume is mounted read-only during compilation; and the admission manifests
still describe exactly 21 payloads / 32 files.

`warehouse-proof-data-v1.json` was generated from the committed catalog
`effectstream/binaries` `metadata/releases/0.3.120.json` at commit
`42c1b610ea1cbafd3eaf4c95901610d79541091b`, and every row was cross-checked against the
admission contract's outer identity before being written. It adds *where to fetch*; it is
never allowed to define *what the generation is*.

## The generation

| Field | Value |
|---|---|
| Selection | `q8b-k0-k19-ledger-static-9` |
| Combined manifest SHA-256 | `b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c` |
| Payloads | 21 (`bls_midnight_2p0` … `bls_midnight_2p19` + `midnight-ledger-static-noarch-9.0.0.zip`) |
| Files in the activated tree | 32 (20 SRS objects + 12 Ledger-static members) |
| Download bytes | 222 935 425 |
| Platform | `noarch` — one copy serves linux/amd64, linux/arm64, plain and experimental alike |
| Cache namespace | `9`; Ledger-static semver `9.0.0` |
| Activated path | `/proof-params/generations/b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c` |

Both proof-server variants set `MIDNIGHT_PP` to that exact fixed generation path, not to
`/proof-params` and not to `/proof-params/current`. A pinned generation directory means a
reader can never be silently moved onto different bytes by a pointer swap.

## Warehouse warning

`effectstream/binaries@0.3.120` is a **development-only, mutable** warehouse release.
Download-time SHA-256 is authoritative: if a pinned asset name ever serves different bytes,
the resolver reports warehouse drift and aborts before anything is staged. It does not
retry a hash mismatch.

## Compatibility

The generation is admitted for proof server `9.0.0-rc.5` only, at Ledger-static `9.0.0` /
cache namespace `9`, source commit `7a89f45d29792be7e09ca5eb246f1e69f0b2a179`, and for
exactly these two upstream image indexes:

- plain — `sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9`
- experimental — `sha256:4f02ca2734649eb238d13924df299b1c82bd5546ec928c5d67bdd0ce86dd0bd1`

The reviewed negative is proof server `9.0.0-rc.7`, which requires Ledger-static `10.0.0` /
namespace `10` and must **not** accept this static-9 generation even though the SRS half is
unchanged.

GitHub is never an admissible `MIDNIGHT_PARAM_SOURCE`
(`githubAsMidnightParamSourceAllowed: false`). The warehouse is where the initializer
fetches payloads once; it is not a live parameter source for a proof server.
