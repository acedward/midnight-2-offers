# Proof-server OCI mirror provenance

This directory contains **no Dockerfile and builds no image.** It is the provenance record for
two images that already exist in an owner-controlled registry, plus the command that re-proves
they are what this repository claims they are.

## Why the demo mirrors these images instead of using the upstream tag or the warehouse binary

| Option | Why it was rejected |
|---|---|
| Pull `midnightntwrk/proof-server` directly at stack startup | Upstream Docker Hub availability for this repository is unreliable, and a clean-clone demo that cannot start is worse than one extra registry hop. |
| Install the warehouse `midnight-proof-server-linux-amd64-9.0.0-rc.5.zip` into a thin image | The archive holds **exactly one file**. The executable's ELF program interpreter is the absolute path `/nix/store/jms7zxzm7w1whczwny5m3gkgdjghmi2r-glibc-2.42-51/lib/ld-linux-x86-64.so.2` and its `RUNPATH` is empty, so without the surrounding Nix closure the process cannot exec at all. The warehouse also has **no `linux/arm64` row** for `9.0.0-rc.5` and **no experimental row at any version**. |
| Rebuild the image from source | No reusable executable artifact problem to solve, and a rebuild would produce different config and layer digests — an explicitly different image under Q2, not a mirror. |

Copying the complete official multiarch index is therefore both the most correct and the most
compact option, and it is what `config/artifact-decisions.json` records as `exact-oci-mirror`.

## What was published

The images were copied with `docker buildx imagetools create` — a registry-to-registry manifest
copy that moves no bytes through a rebuild — by an Effectstream-authorized owner from a trusted
terminal. Nothing in this repository, no build context, and no image layer ever held the
credential, and no executor was given it.

| | plain | experimental |
|---|---|---|
| Upstream | `docker.io/midnightntwrk/proof-server:9.0.0-rc.5` | `docker.io/midnightntwrk/proof-server:9.0.0-rc.5_experimental` |
| Upstream index | `sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9` | `sha256:4f02ca2734649eb238d13924df299b1c82bd5546ec928c5d67bdd0ce86dd0bd1` |
| Destination | `ghcr.io/effectstream/midnight-proof-server` | same package |
| Readable alias | `9.0.0-rc.5-plain-upstream-d96a4d0f` | `9.0.0-rc.5-experimental-upstream-4f02ca27` |
| Destination index | `sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9` | `sha256:4f02ca2734649eb238d13924df299b1c82bd5546ec928c5d67bdd0ce86dd0bd1` |
| Equality class | `exact-mirror` | `exact-mirror` |

The destination index digest equals the upstream index digest for both variants, which is only
possible if every byte of the index — and therefore every child manifest, config and layer it
names — survived the copy unchanged.

The package is **public**, so a clean clone pulls it anonymously. Its tag list is exactly the two
aliases above: there is deliberately **no `latest`**, and no bare `9.0.0-rc.5` tag that could
collapse two genuinely different binaries onto one name.

## The two variants are not interchangeable

They share no manifest, config, layer or executable digest at any platform. The `amd64`
executables hash to `189974b9…` (plain) and `913d5e65…` (experimental); the `arm64` executables to
`ed758766…` and `4a3d1669…`. The plain `amd64` executable is additionally byte-identical to the
warehouse `9.0.0-rc.5` plain binary, which is what makes "exact mirror" checkable against a
second, independent source. The experimental build carries an extra ZKIR-v3 interpreter that the
plain build does not have. Compose must keep them separately pinned.

## Consuming them

Always by repository **plus digest**. A tag is a name, not an identity:

```
ghcr.io/effectstream/midnight-proof-server@sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9
ghcr.io/effectstream/midnight-proof-server@sha256:4f02ca2734649eb238d13924df299b1c82bd5546ec928c5d67bdd0ce86dd0bd1
```

Both are complete multiarch indexes covering exactly `linux/amd64` and `linux/arm64`, so the same
reference resolves natively on Intel and Apple Silicon with no platform forcing and no emulation.

## Re-proving the claim

```bash
python3 images/proof-server-mirror/verify-mirror.py                  # indexes, manifests, configs
python3 images/proof-server-mirror/verify-mirror.py --level deep     # + layers and executables
python3 images/proof-server-mirror/verify-mirror.py --level offline  # record consistency only
python3 images/proof-server-mirror/verify-mirror.py --self-test      # negative fixtures
```

The verifier recomputes every digest by hashing the bytes the registry returned, compares source
and destination documents byte-for-byte rather than field-by-field, and cross-checks
`mirror-manifest.json` against `config/artifact-decisions.json` so the two records cannot drift
apart. It uses **only anonymous GETs**: it reads no Docker config, sends no `Authorization` header
to a token endpoint, and accepts no credential argument or environment variable. If the package
ever stops being anonymously readable, the run fails loudly instead of quietly succeeding on an
ambient login.

If any check ever fails, the destination is **not** an exact mirror. Do not repoint the
`…-upstream-…` alias at different bytes: publish the new image under an explicit
`9.0.0-rc.5-<variant>-es.N` identity that records the upstream digest and the difference, per Q2
of the project questions file.
