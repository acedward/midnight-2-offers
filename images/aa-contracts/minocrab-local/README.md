# `minocrab-local` — the local fetch context for the MinoCrab release assets

This folder is the DEFAULT value of the `minocrab` named build context. It is deliberately
empty of artifacts: with nothing but this README in it, the AA image's `minocrab` stage takes
the RELEASE path and downloads what it needs from

    https://github.com/acedward/AA-midnight-evm-experiment-minocrab/releases/download/${MINOCRAB_RELEASE}/

Point `MINOCRAB_LOCAL_DIR` at a directory that holds the release's files instead — the 38 assets
as `scripts/release-artifacts.sh --out <dir> --tag <tag>` writes them — and the stage copies them
from there:

    MINOCRAB_LOCAL_DIR=/abs/path/to/minocrab/generated/release ./up.sh --with aa --build

The VERIFICATION IS IDENTICAL on both paths and neither is trusted more than the other: the
stage asserts `sha256(SHA256SUMS) == MINOCRAB_SUMS_SHA256` (the pin this repository carries),
runs `sha256sum -c --ignore-missing SHA256SUMS` over every file it took, and asserts
`manifest.json`'s tag, `gitCommit` and `contractPin.commit`. Only the transport differs.

That is what makes the local path legitimate while the release tag is still unpublished:
`manifest.json` carries the tag, `SHA256SUMS` covers `manifest.json`, and the release workflow
runs the same script with `--tag <the pushed tag>` — so a local run with the SAME `--tag`
produces byte-identical assets, and the pin recorded here is the pin the published release will
have. (Run it with the default `--tag unreleased` and you get a different `SHA256SUMS`, which
this build will correctly refuse.)
