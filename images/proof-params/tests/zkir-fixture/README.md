# ZKIR-v2 / ZKIR-v3 contract-circuit proof fixture (test-only)

One minimal Compact contract, compiled twice by the same pinned compiler, proved once per
proof-server variant. It exists to close the one gap the sibling
[`../proof-fixture/`](../proof-fixture/README.md) cannot close by construction.

## Why a second fixture

`../proof-fixture/real-proof.mjs` proves a Zswap output. Its proving key
(`zswap/9/output.prover`) **lives in the shared cache generation**, so the request carries
no key material at all and the proof is a direct measurement of "can this reader prove from
the fixed read-only generation with the origin unreachable". Both rc.5 variants pass it.

But the Zswap lane is the **v1/v2** ZKIR path that both builds share, so it cannot tell the
two builds apart. The experimental build links a `zkir-v3` interpreter the plain build does
not have; the plain build instead carries the error string `Unsupported ZKIR version`. The
difference becomes observable only when a **v3 IR** is POSTed — which requires a Compact
contract circuit compiled with `--feature-zkir-v3`.

A contract circuit's proving key can never be cache-resident: FR-013 deliberately scopes the
shared generation to SRS + Ledger-static-9. So this fixture splits the two halves and asserts
each one separately:

| Half | Source | How it is asserted |
|---|---|---|
| circuit prover / verifier / IR | carried **in the request** | the exact on-disk bytes must appear inside the payload that was POSTed to `/prove` |
| universal SRS | the server's **read-only `MIDNIGHT_PP` generation** | the readers sit on an `internal: true` network, so no origin fetch is possible |

## The compiler pin — and why nothing new had to be pinned

`compactc-v0.33.0-rc.2` is **already** the compiler this repo uses for the kernel
(`images/offerfiles-kernel/Dockerfile`) and the AA contracts
(`images/aa-contracts/Dockerfile`). It is v3-capable out of the box: the release archive
ships **both** backends and `compactc --feature-zkir-v3` selects the newer one.

| Field | Value |
|---|---|
| Release | `https://github.com/LFDT-Minokawa/compact/releases/tag/compactc-v0.33.0-rc.2` |
| Asset (amd64) | `compactc_v0.33.0-rc.2_x86_64-unknown-linux-musl.zip` — SHA-256 `3055ab92bbc8d5bb0d6282b661b83761d2a0de2ee37e21cf7107e25aaf2a9aad`, 32 498 268 B, asset id `478090789` |
| Asset (arm64) | `compactc_v0.33.0-rc.2_aarch64-unknown-linux-musl.zip` — SHA-256 `3aa23812b0b086dbce07da3931a40dcb01bec9676b1ceed7f2d0be370ab2dc46`, 31 550 294 B, asset id `478090787` |
| `compactc --version` | `0.33.0` (upstream records the rc.2 archive under the `0.33.0` line) |
| `--language-version` | `0.25.0` |
| `--runtime-version` | `0.18.0-rc.1` — equal to the `@midnight-ntwrk/compact-runtime` pin in `package.json` |
| Bundled backends | `zkir` (`midnight-zkir 2.2.0`, default) and `zkir-v3` (`midnight-zkir-v3 3.0.0-rc.2`) |

**This pin is test-only and changes no demo toolchain pin.** Spec FR-014 keeps Compact on its
current official LFDT acquisition, and the Compact `0.34` / runtime `0.19` migration remains
out of scope. Reusing the pin the demo already carries is what keeps that true: the
`Dockerfile` here verifies the archive SHA-256 and then asserts `--version` and
`--runtime-version` before it is allowed to compile anything.

## The fixture contract

[`zkir-fixture.compact`](zkir-fixture.compact) — 8 significant lines: one `Counter` ledger
field and one circuit that increments it. No witnesses, no arguments, no private state. The
point is the interpreter lane, not the circuit, so it is as small as a proving circuit gets.

| Backend | Flag | IR header | k (SRS object used) | `bump.prover` | `bump.verifier` | `bump.bzkir` |
|---|---|---|---:|---:|---:|---:|
| `zkir` (default) | *(none)* | `midnight:ir-source[v2]:` | 5 (`bls_midnight_2p5`) | 14 071 B | 1 351 B | 64 B |
| `zkir-v3` | `--feature-zkir-v3` | `midnight:ir-source[v3-generic]:` | 6 (`bls_midnight_2p6`) | 58 166 B | 1 353 B | 102 B |

The IR container header **is** the ZKIR version, so `zkir-proof.mjs` asserts it on the
committed artifact before proving anything. That is what makes "this is a ZKIR-v3 proof" a
measurement rather than a claim.

## Key hygiene — the boundaries this fixture must not cross

- **No proving key in any OCI layer.** [`Dockerfile`](Dockerfile) ships the compiler only and
  fails its own build if any `*.prover` file is present. Compilation happens in a
  `docker run`, writing into a test-scoped volume that the gate's scoped teardown removes.
- **No proving key in the shared cache.** The generation is mounted **read-only** into the
  compile container, and [`compile.sh`](compile.sh) fails if a `bump.*` file is ever found
  under `/proof-params`. The gate re-verifies the generation byte-exact after the proofs.
- **No proving key in the admission manifests.** `manifests/q8b-*.json` are untouched; the
  admitted generation is still exactly 21 payloads / 32 files.
- **No origin fetch for key generation.** The compiler's parameter cache is a farm of
  symlinks into the read-only generation, and the compile container runs on the gate's
  `internal: true` network — a silent download would fail DNS resolution, not succeed quietly.

## What it runs

`tests/run-gate.sh` drives three cases (see the `zkir` stage there):

| # | Artifact | Server | Expectation |
|---:|---|---|---|
| 1 | v2 | plain `sha256:d96a4d0f…` | accept — the matching lane |
| 2 | v3 | experimental `sha256:4f02ca27…` | accept — the genuine ZKIR-v3 proof |
| 3 | v3 | plain `sha256:d96a4d0f…` | **reject** — the variant-distinction control |

Case 3 is what makes cases 1 and 2 falsifiable: the same plain server, the same harness and
the same contract source differ only in the compiler backend, and only the v3 artifact is
refused (`HTTP 400` at `/check`). rc.5 answers an IR it cannot parse with a generic
`bad input` body, so the gate asserts the *cause* directly against the two executables:

| Needle | plain `189974b9…` | experimental `913d5e65…` |
|---|---:|---:|
| `Unsupported ZKIR version` | 1 | 0 |
| `ir-source[v3-generic]` | 0 | 2 |
| `zkir-v3/src` | 0 | 7 |
| `ir-source[v2]` | 4 | 4 |

The plain executable does not contain the v3 IR tag at all — it cannot parse
`midnight:ir-source[v3-generic]:` even in principle — and it is the only one carrying the
`Unsupported ZKIR version` error. (The tag is stored without the `midnight:` prefix, which
the encoder adds separately.)

## Reproducibility

The request side is deterministic: a public seed drives `getRandomValues`, so the contract
address, the proof preimage and the whole proving payload are byte-identical across runs.
The **response** is not — the server's prover uses its own randomness, so `proofBytes` is
stable while `provenTxSha256` legitimately differs run to run. Nothing asserts the latter.

## Not in scope

No wallet, node, indexer, on-chain deployment, or business flow. The in-process "deploy"
inside `zkir-proof.mjs` never leaves the process; it only derives the contract address and
initial state that a call transaction needs.
