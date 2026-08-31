# Artifact decisions — why each external dependency arrives the way it does

Every external runtime dependency in this demo arrives by exactly one of four routes. This
file explains the rule; [`config/artifact-decisions.json`](../config/artifact-decisions.json)
is the machine-readable contract, and `./scripts/verify-artifact-decisions.sh` enforces it.

The point is boring on purpose. Someone reading a Dockerfile six months from now should be
able to answer "why is this a source build?" without archaeology, and someone editing one
should find it hard to quietly make the wrong choice.

## The selection order

Work down the list and stop at the first route that applies.

1. **`official-oci`** — a good official multiarch image exists for the exact required
   version. Use it, pinned by its **index digest**. Do not repack it under another registry
   owner just to put every image under one namespace; that adds a copy to maintain and
   buys nothing.
2. **`warehouse-binary`** — no suitable official image, but an exact native Linux executable
   is published in the [`effectstream/binaries`](https://github.com/effectstream/binaries)
   warehouse. Select it by `TARGETARCH`, verify its SHA-256, and install it into a thin
   local image. Do not compile the dependency.
3. **`exact-oci-mirror`** — a suitable official image exists but its registry is unreliable
   at stack startup. Copy the **complete** multiarch index into an owner-controlled registry
   without rebuilding, and consume it by destination repository plus digest.
4. **`source-build`** — nothing reusable exists. Build from an immutable source pin. This is
   the last resort, not the default.

## What is pinned where

| Component | Version | Route | Identity |
|---|---|---|---|
| `midnight-node` | `2.0.0-rc.4` | `official-oci` | index `sha256:caf93d6f…` |
| `midnight-node-toolkit` | `2.0.0-rc.4` | `official-oci` | index `sha256:c3efb50d…` |
| `indexer-standalone` | `4.4.0-rc.3` | `warehouse-binary` | amd64 `4b5df2ae…`, arm64 `eb44e849…` |
| `celestia-appd` | `6.4.10` | `warehouse-binary` | amd64 `fa182618…`, arm64 `52cc9d59…` |
| `celestia-node` | `0.28.4` | `warehouse-binary` | amd64 `bb8b9fd2…`, arm64 `09eb0505…` |
| proof server, plain | `9.0.0-rc.5` | `exact-oci-mirror` | upstream index `sha256:d96a4d0f…` |
| proof server, experimental | `9.0.0-rc.5` | `exact-oci-mirror` | upstream index `sha256:4f02ca27…` |
| proof data | SRS K0–K19 + Ledger-static `9.0.0` | one verified generation | `b7358497…` |
| Compact | current compatible pin | direct official LFDT | unchanged by this policy |
| kernel, batcher, solver, AA, frontend, umbra-evm, Postgres | — | `source-build` | unchanged by this policy |

Full digests, asset ids, member hashes, and per-platform manifest/config/layer digests live
in the JSON. This table is the readable summary; the JSON is the truth.

## Four rules that are easy to get wrong

**A tag is not an identity.** Every external runtime reference resolves to a digest. Tags
are kept alongside as readable comments, never as the thing Compose consumes. `9.0.0-rc.5`
pointed at the right bytes on the day it was checked; nothing guarantees it still does.

**The proof server cannot be repackaged from the warehouse ZIP.** The warehouse publishes a
standalone `9.0.0-rc.5` executable, and it is byte-identical to the one inside the official
plain image (`189974b9…`). It still cannot be dropped into a generic Linux base: its ELF
program interpreter is the absolute path
`/nix/store/jms7zxzm7w1whczwny5m3gkgdjghmi2r-glibc-2.42-51/lib/ld-linux-x86-64.so.2` and its
`RUNPATH` is empty, so it needs the 16-directory Nix closure that only ships inside the
image. The warehouse also has no `linux/arm64` row and no experimental row for that version.
Mirroring the whole index is both the correct and the smaller answer.

**Plain and experimental are different programs.** Their amd64 executables hash to
`189974b9…` and `913d5e65…` respectively. They keep separate names, tags, digests, and
compatibility records, and the destination aliases each carry their variant name and their
upstream digest prefix so no generic tag can collapse them.

**Some warehouse rows are honestly marked `legacy-unverified`.** The two Celestia `amd64`
archives have null source and null member-hash fields in the catalog. Those nulls are not a
gap to fill in — they are the truthful record. Instead each carries an independent equality
record binding the exact official release, asset id, and published checksum, and the build
fails before installation if that equality does not hold.

## Verifying, and changing a pin

```sh
./scripts/verify-artifact-decisions.sh              # is the contract still internally consistent?
./scripts/verify-artifact-decisions.sh --self-test  # ...and does it still reject known-bad inputs?
```

The self-test mutates in-memory copies of the matrix and asserts each one is rejected —
altered digests, a dropped platform, a swapped plain/experimental identity, a macOS asset
selected for a Linux container, a tag-only reference, a repacked official image, a source
build where a warehouse binary exists, and more. A checker nobody has watched fail is a
checker nobody should trust.

The matrix carries a `pinsDigest` over every identity-bearing field. Editing a digest to make
a build pass will fail verification. That is deliberate: **re-verify the artifact against its
source first**, then record the new value and run:

```sh
./scripts/verify-artifact-decisions.sh --update-pins
```

Regenerating the pins digest is a visible, reviewable act, which is the entire point.

## Deliberate non-goals

- Repacking good official images so everything sits under one registry owner.
- Turning the development-only `0.3.120` warehouse into a production artifact source. It is
  mutable; download-time SHA-256 is authoritative, which is why every hash is pinned here.
- Migrating Compact `0.34` / runtime `0.19`, or changing application behaviour in the
  source-built components.
