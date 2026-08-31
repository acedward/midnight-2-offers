# `images/indexer` — artifact provenance

Everything this image installs comes from one of two places, and both are pinned by
SHA-256 rather than by a URL or a version string. Nothing here is compiled.

## 1. The executable — published warehouse binary

`indexer-standalone` `4.4.0-rc.3`, taken from GitHub release
[`effectstream/binaries@0.3.120`](https://github.com/effectstream/binaries/releases/tag/0.3.120).

> **DEVELOPMENT ONLY — NOT FOR PRODUCTION USE.** `0.3.120` is a *mutable* warehouse
> release: an asset can be re-uploaded under the same name. The SHA-256 values below are
> therefore the artifact's identity. The build verifies the archive hash *and* the hash of
> the executable inside it, and fails before installing anything if either differs.

| Platform | Asset | Asset id | Archive SHA-256 | Executable SHA-256 |
|---|---|---:|---|---|
| `linux/amd64` | `indexer-standalone-linux-amd64-v4.4.0-rc.3.zip` | `534359865` | `4b5df2ae3ed01f378adfb64d1c0d20d306470f8fba23a36638f937a4486a9434` | `84b429c3f2eb43372eba4b1fa5739acfdd8c8d472052b281ca6778b2bf4eb17b` |
| `linux/arm64` | `indexer-standalone-linux-arm64-v4.4.0-rc.3.zip` | `534360484` | `eb44e8493df141d552334399dc25277e76cd500e937bedd5c6ff42a068fb15d0` | `623539f18bfd9067ba2f70e43546af70277d113e9d1b486263df668c1d585c82` |

Warehouse catalog: `effectstream/binaries@42c1b610ea1cbafd3eaf4c95901610d79541091b`,
`metadata/releases/0.3.120.json`. Both rows are `provenance=known` and carry the upstream
source identity below. Each archive holds **exactly one member**, named after the asset,
mode `0755`; the build asserts that whole listing, not merely that the member is present.

**Both Linux architectures are published**, which is why this image has no `platform:` pin
and builds native on Apple Silicon as well as x86-64.

## 2. The two runtime-support files — vendored from upstream source

The warehouse ZIP contains only the executable, so `entrypoint.sh` and `config.yaml` are
vendored here verbatim from the same upstream commit that produced it. They are checked
into this directory and hash-verified during the build.

| File | Upstream path | SHA-256 |
|---|---|---|
| `entrypoint.sh` | `indexer-standalone/bin/entrypoint.sh` | `63613bd5933546afa0715489ef759c82e10fa95f15f30a8ea6e5af403e09f178` |
| `config.yaml` | `indexer-standalone/config.yaml` | `dc5a5cb404addd176506f86247f08a00f3ac49d60ba76432fea0f639c883ba7f` |

Source: [`midnightntwrk/midnight-indexer`](https://github.com/midnightntwrk/midnight-indexer)
at commit `56561b2f5cf5c6839f678257fc69bed1a8b9ba2c`, Apache-2.0. Retrieved 2026-08-31.

Neither file is modified. `entrypoint.sh` is the supervisor that creates
`/var/run/indexer-standalone/running` (the container healthcheck's marker) before launching
the binary; `config.yaml` is the default configuration the process reads from its working
directory, with every value this stack cares about overridden through `APP__*` environment
variables in `compose/core.yml`.

## 3. Upstream source identity — provenance, never a build instruction

`midnightntwrk/midnight-indexer` @ `56561b2f5cf5c6839f678257fc69bed1a8b9ba2c`
(`method=build`, `native=true`, Apache-2.0). This is the commit the warehouse built the
executable from, and it is the release that carries the standalone SQLite deadlock fix
missing from `4.4.0-rc.1`.

It is recorded so a running container can prove which upstream revision produced its
binary. **It is not a fetch or compile input.** This image contains no Rust toolchain, no
Cargo state, no source tree, and no downloaded archive.

## What a built image can prove about itself

| Path | Contents |
|---|---|
| `/opt/indexer-standalone/.indexer-commit` | the upstream source commit |
| `/opt/indexer-standalone/.indexer-artifact` | JSON: version, platform, semantic id, warehouse release + catalog commit, asset name, archive SHA-256, member path, executable SHA-256, source repository/commit |

`scripts/verify-source-pins.sh` reads both from a built image and compares every field
against `config/artifact-decisions.json`, including re-hashing the installed executable.
