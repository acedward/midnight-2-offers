# aa-contracts — deploy the PASSPORT account stack's shared pieces at bring-up
# (profile `aa`, one-shot service `aa-deploy`), and serve the AA console.
#
# ⚠ BREAKING vs every image before it. This used to build acedward/AA-midnight-evm-
# experiment-v3: ONE shared "Manager" contract holding every user's balances behind a
# single `execute` gateway, plus a test Minter, plus a MinoCrab-ported `execute` ZKIR.
# All three are gone. The stack now runs on the Midnight PASSPORT account model:
#
#   * ONE CONTRACT PER USER. `register` DEPLOYS an account contract whose initial device
#     is the connected Ethereum wallet; the account id IS the contract address (Q40).
#     There is no registry to enumerate and no pre-registration id to sign over.
#   * ONE SHARED VAULT, deployed once by `aa-deploy`. The account's constructor seals a
#     reference to it (`sealed ledger vault`), so an account cannot be built without a
#     vault address, and the compiler embeds a fingerprint of the vault's verifier keys —
#     a redeployed vault orphans every account compiled against the old one (spec FR-022).
#   * NO MINOCRAB. The port produced the Manager's `execute`; there is no `execute` here.
#     `AA_ZKIR_SOURCE`, `MINOCRAB_*` and `AA_PRUNE_MANAGER_PROVERS` are removed. The
#     prover keys this image keeps are now NAMED, in `AA_PROVER_KEYS`.
#
# Source: acedward/passport, branch 00034-passport-evm-account-zswap, pinned by full SHA
# as PASSPORT_REF. Everything this image compiles lives under that repo's `contract/`:
# `contracts/account.compact` (+ `contracts/modules/*`) and `contracts/erc20-vault/`
# (the witness-free vault fork and the vendored Signet singleton). Fetched from the
# remote like the other images, so `git clone <this repo> && ./up.sh --with aa` works
# with nothing else checked out.
#
# TOOLCHAIN FIDELITY — ONE compactc, ONE compact-runtime, and issues/00011 stays CLOSED.
# The compactc pin is still READ FROM THE PINNED KERNEL TREE (`infra/compact-version.txt`
# — 0.34.0 at this KERNEL_REF) and verified against that tree's
# `infra/compact-checksums.sha256`, because ONE compactc compiles the account, the vault,
# the Signet singleton AND has to agree with the mint-test-tokens artifacts this image
# copies. The Passport fork targets compactc 0.34.0 / language 0.26.0 / compact-runtime
# 0.19.0 (its `contract/package.json`), which is the same lane, so the existing guard —
# compactc's emitted `--runtime-version` must equal what the runner installs and what the
# copied artifacts' own receipt records — is unchanged and now covers three repositories.
# `--build-arg COMPACT_VERSION=<x>` still overrides for a deliberate experiment.
#
# It compiles with `--feature-zkir-v3`, and that flag is still load-bearing: the `evm`
# arm is keccak/EIP-712/ECDSA-heavy (k=18 for every gated circuit) and a v3 zkir emits
# verifier-key[v7], which the PLAIN proof-server cannot prove calls against. compose/aa.yml
# therefore still ships its own INTERNAL experimental proof server, and the wallet's own
# standard-lane pieces still go to the core plain one.
#
# THE CALL TREE IS COMPILED IN ONE ORDER, AND IT IS NOT A PREFERENCE. The compiler resolves
# a declared contract type to <compact-path>/<TypeName> and embeds a fingerprint of that
# callee's verifier key, so: SignetSigner, then Erc20Vault (which calls it), then account
# (which calls the vault). The artefact DIRECTORY NAME IS THE DECLARED TYPE NAME, and every
# bundle in one tree must sit side by side under one artefact root, because a caller's
# generated JavaScript imports its callee by relative path.

# ── pins ─────────────────────────────────────────────────────────────────────
# The Passport fork. A full 40-hex commit, never a branch: the account's verifier keys
# are what a deployed account is, so "the tip of a branch" is not an identity.
ARG PASSPORT_REPO=https://github.com/acedward/passport.git
ARG PASSPORT_REF=34c71a48ee3ef475479a0582c50cda5b12feec80

# The kernel tree, for the compactc pin and its checksums ONLY (as before). The kernel
# image itself is built elsewhere; nothing of it runs here.
ARG KERNEL_REPO=https://github.com/effectstream/zswap-offerfiles-kernel.git
ARG KERNEL_REF=5d794f9a27f6d65529bf176650405f740531d430

# The local test-token issuers. Their COMMITTED managed artifacts are copied in; the
# console mints the demo colours by calling them. Same pin as compose/faucet.yml.
ARG MINT_TEST_TOKENS_REPO=https://github.com/effectstream/mint-test-tokens.git
ARG MINT_TEST_TOKENS_REF=a51cf3ad46520d1ded938fb86db8b7b99373ce56

# Override the compactc version for a deliberate experiment; empty = the kernel's pin.
ARG COMPACT_VERSION=

# @sig-net/midnight — the Signet protocol's Compact module. The ONLY thing the compile
# needs from it is two SOURCE files (`src/Signet.compact`, `src/circuits.compact`), so the
# tarball is fetched by URL and verified by SHA-256: no npm, no registry resolution and no
# lockfile in a stage whose job is to compile. The VERSION is a locator; SIGNET_PKG_SHA256
# is the identity, exactly as MINOCRAB_SUMS_SHA256 was for the port it replaces.
ARG SIGNET_PKG_VERSION=0.22.0-rc.1
ARG SIGNET_PKG_SHA256=0e7414d52b225e31def3d776cae376ff1e6c2bf7b592f02dc422b5bb6fb6fd71

# WHICH PROVER KEYS SURVIVE THE BUILD. A k=18 `evm` circuit's prover key is 570 MB and the
# account has eleven of them, so shipping all 33 circuits' keys would be a 7.6 GB image for
# no purpose: a prover key is needed only to PROVE that circuit in this process. Deploying
# needs none (a deploy inserts verifier keys), and a maintenance update needs none.
#
# The default is exactly the set the console proves, and nothing else:
#   activate_initial_device_with_evm       register, step 2
#   deposit_shielded / deposit_unshielded  funding (permissionless, any wallet)
#   withdraw_shielded_with_evm             withdraw to a wallet
#   withdraw_unshielded_with_evm           withdraw unshielded
#   withdraw_shielded_to_contract_with_evm the DIRECT account -> account transfer the client
#                                          exposes. The console's Send uses the one-hop instead
#                                          (Q53), so this is the one key kept for a circuit the
#                                          console does not itself prove — it is deployed in
#                                          wave 1 either way, and the key is 570 MB
#   append_inbox_with_evm                  the change entry after a spend
#   open_swap_shielded_with_evm            the offer (Q35: the console carries it)
#   initialise                             the VAULT's one-shot, proved by aa-deploy
#   mint_shielded / mint_unshielded        the fork's TEST FAUCET, which replaces AA-v3's
#                                          test Minter as the source of the e2e's colours
# `AA_WITH_BRIDGE=1` adds the five bridge circuits and the vault's flow circuits.
# EMPTY means "the default list", which lives in the prune step below rather than here so
# that compose can pass `${AA_PROVER_KEYS:-}` without silently pruning everything.
ARG AA_PROVER_KEYS=
ARG AA_WITH_BRIDGE=0

# ── stage 1: the sources ─────────────────────────────────────────────────────
FROM debian:stable-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG PASSPORT_REPO
ARG PASSPORT_REF
ARG KERNEL_REPO
ARG KERNEL_REF
ARG MINT_TEST_TOKENS_REPO
ARG MINT_TEST_TOKENS_REF

# The Passport fork. A shallow fetch of ONE commit; the identity is asserted, not assumed
# (the same 40-hex rule images/mint-test-tokens enforces — a live branch is not a pin).
WORKDIR /src
RUN set -eux; \
    case "$PASSPORT_REF" in \
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) : ;; \
      *) echo "PASSPORT_REF must be a full 40-hex commit, got '$PASSPORT_REF'" >&2; exit 1 ;; \
    esac; \
    git init -q .; \
    git remote add origin "$PASSPORT_REPO"; \
    git fetch -q --depth 1 origin "$PASSPORT_REF"; \
    git checkout -q FETCH_HEAD; \
    git rev-parse HEAD > /passport-commit; \
    test "$(cat /passport-commit)" = "$PASSPORT_REF"; \
    test -s contract/contracts/account.compact; \
    test -s contract/contracts/erc20-vault/src/erc20-vault.compact; \
    test -s contract/src/index.ts; \
    # The fork's own property check, run HERE so a vault that regrew a witness never
    # reaches a build: a callee with a witness cannot be called at all (PR-F, FR-016).
    test "$(grep -c '^witness' contract/contracts/erc20-vault/src/erc20-vault.compact)" = "0"; \
    rm -rf .git

# The kernel tree — the compactc version and checksum manifest, nothing else.
WORKDIR /kernel-src
RUN git init -q . \
 && git remote add origin "$KERNEL_REPO" \
 && git fetch -q --depth 1 origin "$KERNEL_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /kernel-commit \
 && rm -rf .git

# mint-test-tokens: the COMMITTED managed artifacts of the two issuers, copied verbatim.
WORKDIR /mtt-src
RUN set -eux; \
    git init -q .; \
    git remote add origin "$MINT_TEST_TOKENS_REPO"; \
    git fetch -q --depth 1 origin "$MINT_TEST_TOKENS_REF"; \
    git checkout -q FETCH_HEAD; \
    git rev-parse HEAD > /mint-test-tokens-commit; \
    case "$MINT_TEST_TOKENS_REF" in \
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) : ;; \
      *) echo "MINT_TEST_TOKENS_REF must be a full 40-hex commit, got '$MINT_TEST_TOKENS_REF'" >&2; exit 1 ;; \
    esac; \
    test "$(cat /mint-test-tokens-commit)" = "$MINT_TEST_TOKENS_REF"; \
    mkdir -p /mtt/shielded /mtt/unshielded; \
    cp -a contracts/v2/managed/shielded/.   /mtt/shielded/; \
    cp -a contracts/v2/managed/unshielded/. /mtt/unshielded/; \
    cp contracts/v2/package.json /mtt/contracts-v2-package.json; \
    test -s /mtt/shielded/contract/index.js; \
    test -s /mtt/unshielded/contract/index.js; \
    test -s /mtt/shielded/compiler/contract-info.json; \
    rm -rf /mtt-src/.git

# ── stage 2: compactc, and the whole call tree compiled in one layer ─────────
FROM debian:stable-slim AS compact

ARG COMPACT_VERSION
ARG TARGETARCH
ARG SIGNET_PKG_VERSION
ARG SIGNET_PKG_SHA256
ARG AA_PROVER_KEYS
ARG AA_WITH_BRIDGE

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

COPY --from=source /kernel-src/infra/compact-version.txt     /opt/compact-version.txt
COPY --from=source /kernel-src/infra/compact-checksums.sha256 /opt/compact-checksums.sha256
COPY --from=source /mtt/contracts-v2-package.json /opt/contract-package.json
COPY --from=source /src/contract/package.json     /opt/passport-package.json

RUN set -eux; \
    COMPACT_VERSION="${COMPACT_VERSION:-$(tr -d ' \t\n\r' < /opt/compact-version.txt)}"; \
    test -n "${COMPACT_VERSION}" || { echo "infra/compact-version.txt is empty at this KERNEL_REF" >&2; exit 1; }; \
    echo "compactc pin: ${COMPACT_VERSION} (from the pinned kernel tree)"; \
    case "${TARGETARCH:-arm64}" in \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o "/tmp/${asset}" "$url"; \
    expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' /opt/compact-checksums.sha256)"; \
    test -n "$expected" || { echo "the pinned kernel tree records no SHA-256 for ${asset}" >&2; exit 1; }; \
    printf '%s  %s\n' "$expected" "/tmp/${asset}" | sha256sum -c -; \
    mkdir -p /opt/compactc; \
    unzip -q "/tmp/${asset}" -d /opt/compactc; \
    rm "/tmp/${asset}"; \
    chmod +x /opt/compactc/*; \
    test -x /opt/compactc/zkir || { echo "asset lacks the zkir backend" >&2; exit 1; }; \
    test "$(/opt/compactc/compactc --version)" = "${COMPACT_VERSION}"; \
    got_runtime="$(/opt/compactc/compactc --runtime-version)"; \
    want_runtime="$(sed -n 's/.*"@midnight-ntwrk\/compact-runtime"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /opt/contract-package.json | head -n 1)"; \
    test -n "$want_runtime" || { echo "mint-test-tokens contracts/v2 declares no @midnight-ntwrk/compact-runtime" >&2; exit 1; }; \
    test "$got_runtime" = "$want_runtime" || { echo "FAIL: compactc ${COMPACT_VERSION} emits code for compact-runtime ${got_runtime}, but mint-test-tokens contracts/v2 depends on ${want_runtime}" >&2; exit 1; }; \
    # THE THIRD REPOSITORY. The Passport fork declares its own compact-runtime; a fork that
    # moved to another compiler line must fail HERE, naming the repository that moved,
    # rather than as a contract that refuses to load the first time the console touches it.
    passport_runtime="$(sed -n 's/.*"@midnight-ntwrk\/compact-runtime"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /opt/passport-package.json | head -n 1)"; \
    test -n "$passport_runtime" || { echo "the Passport fork declares no @midnight-ntwrk/compact-runtime" >&2; exit 1; }; \
    test "$got_runtime" = "$passport_runtime" || { echo "FAIL: compactc ${COMPACT_VERSION} emits code for compact-runtime ${got_runtime}, but the Passport fork at PASSPORT_REF depends on ${passport_runtime}" >&2; exit 1; }; \
    echo "compactc ${COMPACT_VERSION} / language $(/opt/compactc/compactc --language-version) / runtime ${got_runtime}"; \
    printf '%s\n' "${COMPACT_VERSION}" > /opt/compactc-version; \
    printf '%s\n' "${got_runtime}"     > /opt/compact-runtime-version

# The Signet Compact module, by SHA-256. `npm` never runs in this stage.
RUN set -eux; \
    url="https://registry.npmjs.org/@sig-net/midnight/-/midnight-${SIGNET_PKG_VERSION}.tgz"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o /tmp/signet.tgz "$url"; \
    printf '%s  %s\n' "${SIGNET_PKG_SHA256}" /tmp/signet.tgz | sha256sum -c -; \
    mkdir -p /work/node_modules/@sig-net/midnight; \
    tar -xzf /tmp/signet.tgz -C /work/node_modules/@sig-net/midnight --strip-components=1; \
    rm /tmp/signet.tgz; \
    test -s /work/node_modules/@sig-net/midnight/src/Signet.compact; \
    printf '%s\n' "${SIGNET_PKG_VERSION}" > /opt/signet-pkg-version; \
    printf '%s\n' "${SIGNET_PKG_SHA256}"  > /opt/signet-pkg-sha256

COPY --from=source /src/contract/contracts /work/contracts

# One layer: compile the whole tree, then PRUNE inside the same layer. Pruning in a later
# layer would leave 7.6 GB of deleted prover keys in the image's history — the reason the
# AA-v3 image deleted its own keys in the layer that made them.
WORKDIR /work
RUN set -eux; \
    export HOME=/tmp XDG_CACHE_HOME=/tmp/zk-cache; \
    CC=/opt/compactc/compactc; \
    V=/work/contracts/erc20-vault; \
    echo "── 1/4 SignetSigner (the singleton, from the fork's VENDORED source) ──"; \
    # NOT from @sig-net/midnight-contract: every published version of that package ships
    # generated TypeScript pinned to compact-runtime 0.18.0-rc.1 and cannot be loaded on
    # 0.19.0 (project 00034 Q20/Q25). The rebuild's verifier keys are byte-identical, which
    # is what keeps a contract compiled here callable against an already-deployed singleton.
    "$CC" --feature-zkir-v3 --compact-path /work/node_modules \
      "$V/src/vendor/signet-contract.compact" "$V/managed/SignetSigner"; \
    echo "── 2/4 the Signet module's own circuits (--skip-zk: TypeScript only) ──"; \
    "$CC" --skip-zk --feature-zkir-v3 --compact-path /work/node_modules \
      /work/node_modules/@sig-net/midnight/src/circuits.compact "$V/managed/SignetCircuits"; \
    echo "── 3/4 Erc20Vault (calls the singleton) ──"; \
    "$CC" --feature-zkir-v3 --compact-path "/work/node_modules:$V/managed" \
      "$V/src/erc20-vault.compact" "$V/managed/Erc20Vault"; \
    # The callee bundles must sit beside the account's, because a caller's generated
    # JavaScript imports its callee by RELATIVE path (../../Erc20Vault/contract/index.js).
    # This is the fork's scripts/link-callees.sh, and its shape is not a style choice:
    #
    #   A DIRECTORY OF LINKS, NOT A LINKED DIRECTORY. `nodeZkConfigRegistry` — the provider
    #   that lets a caller's prover reach its CALLEE's keys — walks this root with
    #   `readdir({withFileTypes: true})` and keeps only entries whose `isDirectory()` is
    #   true. A symlink's Dirent answers `isSymbolicLink()`, so a bundle linked as ONE
    #   directory is invisible to it: the compile succeeds, the deploy succeeds, and the
    #   first cross-contract call fails with `ZKArtifactNotFoundError: No ZK artifact
    #   bundle matches the deployed verifier key`, which reads like a stale build and is
    #   not one. Measured by PR-G on its G4 stack, 2026-09-16. The bundle check one level
    #   down uses `fs.stat`, which DOES follow symlinks, so a real directory whose children
    #   are links is seen.
    #
    # Links rather than copies keeps ONE build of the vault in this image — the account is
    # compiled against the very bytes the deploy fingerprints (spec FR-022) — and does not
    # duplicate the proving keys.
    # RELATIVE targets, because this tree is COPYed into the runtime image at another
    # path: an absolute /work/... link would dangle the moment it left this stage.
    for name in Erc20Vault SignetSigner; do \
      mkdir -p "/work/contracts/managed/$name"; \
      for child in "$V/managed/$name"/*; do \
        ln -s "../../erc20-vault/managed/$name/$(basename "$child")" \
              "/work/contracts/managed/$name/$(basename "$child")"; \
      done; \
    done; \
    echo "── 4/5 account (calls the vault) ──"; \
    "$CC" --feature-zkir-v3 --compact-path "/work/node_modules:/work/contracts/managed" \
      /work/contracts/account.compact /work/contracts/managed/account; \
    echo "── 5/5 the fork's TEST FAUCET ──"; \
    # It replaces AA-v3's `contracts/test-support/minter.compact`, and it comes from the
    # SAME repository and the SAME compiler as the account — which the Minter never did.
    # Shielded tokens on a fresh localnet can only originate from a contract mint, so
    # aa-deploy mints the two demo colours here and `aa-e2e.sh` keeps needing no faucet
    # profile, no registry and no local issuer, exactly as it needed none before.
    "$CC" --feature-zkir-v3 --compact-path /work/node_modules \
      /work/contracts/faucet.compact /work/contracts/managed/faucet; \
    du -sh "$V/managed" /work/contracts/managed/account /work/contracts/managed/faucet

# The prune. A separate RUN because it reads AA_PROVER_KEYS/AA_WITH_BRIDGE, and a rebuild
# with a different key set must not recompile 33 circuits.
#
# MEASURED on this tree (2026-09-16): the account's compiled bundle is 7.2 GB with every
# prover key and 2.9 GB with the default set; the vault's is 717 MB before and 114 MB after;
# the faucet's 54 MB. The manifest each bundle carries still describes the deleted keys at
# this point — the re-stamp that fixes that runs in the final stage, where bun is.
ARG AA_PROVER_KEYS
ARG AA_WITH_BRIDGE
RUN set -eux; \
    DEFAULT_KEYS="activate_initial_device_with_evm deposit_shielded deposit_unshielded \
withdraw_shielded_with_evm withdraw_unshielded_with_evm withdraw_shielded_to_contract_with_evm \
append_inbox_with_evm open_swap_shielded_with_evm initialise \
mint_shielded mint_unshielded mint_unshielded_to_contract"; \
    keep="${AA_PROVER_KEYS:-$DEFAULT_KEYS}"; \
    if [ "${AA_WITH_BRIDGE:-0}" = "1" ]; then \
      keep="$keep bridge_deposit_start_with_evm bridge_deposit_complete bridge_withdraw_start_with_evm bridge_withdraw_complete bridge_withdraw_refund"; \
      keep="$keep startDeposit completeDeposit abandonDeposit startWithdraw completeWithdraw refundWithdraw signBidirectional"; \
    fi; \
    printf '%s\n' "$keep" > /opt/aa-prover-keys; \
    printf '%s\n' "${AA_WITH_BRIDGE:-0}" > /opt/aa-with-bridge; \
    total_before=0; kept=0; dropped=0; \
    for bundle in /work/contracts/managed/account \
                  /work/contracts/managed/faucet \
                  /work/contracts/erc20-vault/managed/Erc20Vault \
                  /work/contracts/erc20-vault/managed/SignetSigner; do \
      [ -d "$bundle/keys" ] || continue; \
      for f in "$bundle"/keys/*.prover; do \
        [ -e "$f" ] || continue; \
        name="$(basename "$f" .prover)"; \
        total_before=$(( total_before + 1 )); \
        case " $keep " in \
          *" $name "*) kept=$(( kept + 1 )); continue ;; \
        esac; \
        rm -f "$f"; dropped=$(( dropped + 1 )); \
      done; \
    done; \
    echo "prover keys: ${kept} kept, ${dropped} pruned (of ${total_before})"; \
    du -sh /work/contracts/managed/account /work/contracts/erc20-vault/managed

COPY --from=source /mtt/shielded   /aa/contract-mtt-shielded/src/managed
COPY --from=source /mtt/unshielded /aa/contract-mtt-unshielded/src/managed

# ── stage 3: the runner ──────────────────────────────────────────────────────
# Same bun pin as the kernel image, same reason (1.3.14 breaks on graphql-17 ESM).
# Inheriting the compact stage rather than COPYing its key tree keeps ONE filesystem
# snapshot of ~3 GB of proving keys; compactc (~64 MB) riding along is the small price.
FROM oven/bun:1.3.11 AS bun-runtime
FROM compact

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /aa
COPY --from=source /passport-commit         /aa/.passport-commit
COPY --from=source /kernel-commit           /aa/.kernel-commit
COPY --from=source /mint-test-tokens-commit /aa/.mint-test-tokens-commit

# The Passport fork's own client library and contract sources, laid out exactly as the
# fork lays them out — `src/wallet/contract.ts` imports
# `../../contracts/managed/account/contract/index.js`, a path relative to the source tree,
# so `src/` and `contracts/` must stay siblings. Bun runs the TypeScript directly and
# resolves the fork's ESM `./x.js` specifiers to `./x.ts`, so nothing is transpiled here.
COPY --from=source /src/contract/src     /aa/passport/src
COPY --from=source /src/contract/docs    /aa/passport/docs
COPY --from=source /src/contract/package.json /aa/passport/package.json
COPY --from=compact /work/contracts      /aa/passport/contracts
COPY runner/ /aa/runner/
COPY console/ /aa/console/

# ONE node_modules, at /aa, for the runner AND the fork's client AND the generated
# contract modules: module resolution walks UP from the importing file, so a single
# hoisted tree is what makes the compactc-generated code at
# /aa/passport/contracts/managed/*/contract/index.js see @midnight-ntwrk/compact-runtime.
RUN cp /aa/runner/package.json /aa/package.json && cd /aa && bun install

# Q47, closed for this consumer. The vault package's `src/signet-sdk.ts` re-exports the
# SDK's plain-TypeScript modules by RELATIVE FILE PATH
# (`../node_modules/@sig-net/midnight/dist/abi-serde.js`), which resolves only when the
# vault package has a node_modules of its own. This image hoists everything to /aa, so the
# path is made true with a link rather than by patching somebody else's file.
RUN ln -s /aa/node_modules /aa/passport/contracts/erc20-vault/node_modules

# The console's recipient parser must accept a full Midnight shielded address (135 chars);
# the SDK's own MidnightBech32m.parse() stops at bech32's 90 (infra issue 00023).
RUN cd /aa && bun test runner/midnight-bech32m.test.ts

# ── ONE compactc, ONE compact-runtime (issues/00011), now across THREE repositories ──
# This process imports generated contract modules from the Passport fork (account, vault,
# singleton — compiled here) and from mint-test-tokens (two issuers — copied), and every
# one of them opens with `checkRuntimeVersion("<what its compiler emitted>")`. The compact
# stage already proved this image's compactc agrees with BOTH package manifests; the three
# assertions below prove the same number against what `bun install` actually RESOLVED,
# that exactly one copy is installed, and that the COPIED artifacts' own compiler receipt
# agrees too.
RUN set -eux; \
    want="$(cat /opt/compact-runtime-version)"; \
    copies="$(find /aa/node_modules -path '*/@midnight-ntwrk/compact-runtime/package.json' | wc -l | tr -d ' ')"; \
    test "$copies" = "1" || { echo "FAIL: ${copies} copies of @midnight-ntwrk/compact-runtime are installed at /aa; exactly one must be" >&2; find /aa/node_modules -path '*/@midnight-ntwrk/compact-runtime/package.json' >&2; exit 1; }; \
    got="$(bun -e 'const p = (await import("/aa/node_modules/@midnight-ntwrk/compact-runtime/package.json", { with: { type: "json" } })).default; console.log(p.version)')"; \
    test "$got" = "$want" || { echo "FAIL: compactc $(cat /opt/compactc-version) emits code for compact-runtime ${want}, but the runner installed ${got}" >&2; exit 1; }; \
    echo "runner compact-runtime ${got} == compactc $(cat /opt/compactc-version) runtime target"; \
    acct="$(bun -e 'const i = (await import("/aa/passport/contracts/managed/account/compiler/contract-info.json", { with: { type: "json" } })).default; console.log(i["runtime-version"]);')"; \
    test "$acct" = "$want" || { echo "FAIL: the account artifact was built for compact-runtime ${acct}, this image installs ${want}" >&2; exit 1; }; \
    mtt="$(bun -e 'const i = (await import("/aa/contract-mtt-shielded/src/managed/compiler/contract-info.json", { with: { type: "json" } })).default; console.log(i["runtime-version"]);')"; \
    test "$mtt" = "$want" || { echo "FAIL: the mint-test-tokens artifacts at $(cat /aa/.mint-test-tokens-commit) were built for compact-runtime ${mtt}, but this image installs ${want}" >&2; exit 1; }; \
    mttc="$(bun -e 'const i = (await import("/aa/contract-mtt-shielded/src/managed/compiler/contract-info.json", { with: { type: "json" } })).default; console.log(i["compiler-version"]);')"; \
    echo "mint-test-tokens artifacts: compiler ${mttc} / runtime ${mtt} (copied, never recompiled)"; \
    cp /opt/compactc-version        /aa/.compactc-version; \
    cp /opt/compact-runtime-version /aa/.compact-runtime-version; \
    cp /opt/signet-pkg-version      /aa/.signet-pkg-version; \
    cp /opt/signet-pkg-sha256       /aa/.signet-pkg-sha256; \
    cp /opt/aa-prover-keys          /aa/.aa-prover-keys; \
    cp /opt/aa-with-bridge          /aa/.aa-with-bridge

# ── the manifest re-stamp the prune made necessary ──────────────────────────
# `NodeZkConfigProvider` runs verify:"require" against `compiler/contract-manifest.json`, so
# a manifest that still describes a `.prover` the prune deleted fails at the first call with
# an ENOENT that reads like a broken build. Every pruned entry is REMOVED rather than left
# describing bytes that are not there. It runs HERE rather than in the compact stage because
# bun is the JSON tool this image has — the first version used jq and got it wrong in a way
# worth recording: inside `contains(…)` the input is the ARGUMENT, so `.key` indexed a
# string and jq exited 5 ("Cannot index string with string \"key\"").
RUN bun -e ' \
  const { readdirSync, existsSync } = await import("node:fs"); \
  const root = "/aa/passport/contracts"; \
  const bundles = [ \
    `${root}/managed/account`, `${root}/managed/faucet`, \
    `${root}/erc20-vault/managed/Erc20Vault`, `${root}/erc20-vault/managed/SignetSigner`, \
  ]; \
  for (const dir of bundles) { \
    const path = `${dir}/compiler/contract-manifest.json`; \
    if (!existsSync(path)) continue; \
    const m = await Bun.file(path).json(); \
    const present = new Set(readdirSync(`${dir}/keys`)); \
    let dropped = 0; \
    for (const name of Object.keys(m.keys ?? {})) { \
      if (name === "type" || present.has(name)) continue; \
      delete m.keys[name]; dropped += 1; \
    } \
    await Bun.write(path, JSON.stringify(m, null, 2) + "\n"); \
    console.log(`re-stamped ${dir.split("/").pop()}: ${dropped} pruned key(s) removed from the manifest`); \
  }'

# The artefact fingerprints every account deploy receipt has to quote (spec FR-022): the
# SHA-256 of each compiled bundle's verifier keys and generated module, computed from the
# bytes in THIS image. `verify-aa.sh` compares the live deploy's receipt against them, so
# a rebuilt vault under a still-running stack is a verification failure, not a mystery.
RUN bun -e ' \
  const { createHash } = await import("node:crypto"); \
  const { readdirSync, readFileSync, existsSync, writeFileSync } = await import("node:fs"); \
  const root = "/aa/passport/contracts"; \
  const bundles = { \
    account: `${root}/managed/account`, \
    faucet: `${root}/managed/faucet`, \
    Erc20Vault: `${root}/erc20-vault/managed/Erc20Vault`, \
    SignetSigner: `${root}/erc20-vault/managed/SignetSigner`, \
  }; \
  const out = {}; \
  for (const [name, dir] of Object.entries(bundles)) { \
    if (!existsSync(dir)) continue; \
    const h = createHash("sha256"); \
    const verifiers = readdirSync(`${dir}/keys`).filter((f) => f.endsWith(".verifier")).sort(); \
    for (const f of verifiers) { h.update(f); h.update(readFileSync(`${dir}/keys/${f}`)); } \
    const mod = readFileSync(`${dir}/contract/index.js`); \
    out[name] = { \
      fingerprint: h.digest("hex"), \
      verifierKeys: verifiers.length, \
      moduleSha256: createHash("sha256").update(mod).digest("hex"), \
      provers: readdirSync(`${dir}/keys`).filter((f) => f.endsWith(".prover")).sort(), \
    }; \
  } \
  writeFileSync("/aa/.artefact-fingerprints.json", JSON.stringify(out, null, 2) + "\n"); \
  for (const [n, v] of Object.entries(out)) console.log(`${n} fingerprint ${v.fingerprint} (${v.verifierKeys} verifier keys, ${v.provers.length} prover keys kept)`);'

# ── k per proof-bearing circuit, measured with the compiler's OWN zkir ───────
# `k` is the log2 of a circuit's constraint domain and decides the proving-key size: a
# circuit that crosses a power of two doubles its key, and at k=20 a key passes 2 GiB and
# Node's readFile refuses it outright. Spec User Story 4 asks for it to be RECORDED, and the
# only honest place to measure it is here, in the image, with the same pinned `zkir-v3` that
# produced these artefacts — measuring one compiler's output with another compiler's zkir is
# meaningless. `mock-compile` generates no key and touches nothing: each `.zkir` is copied to
# a scratch directory first.
#
# It runs LAST so that a re-measure never invalidates the 33-circuit compile above.
RUN set -eux; \
    out=/aa/.circuit-k.json; \
    tmp=$(mktemp -d); \
    printf '{\n  "measuredBy": "zkir-v3 mock-compile",\n  "compiler": "%s",\n  "bundles": {' \
      "$(cat /opt/compactc-version)" > "$out"; \
    first_bundle=1; \
    for bundle in /aa/passport/contracts/managed/account \
                  /aa/passport/contracts/managed/faucet \
                  /aa/passport/contracts/erc20-vault/managed/Erc20Vault \
                  /aa/passport/contracts/erc20-vault/managed/SignetSigner; do \
      [ -d "$bundle/zkir" ] || continue; \
      name=$(basename "$bundle"); \
      [ "$first_bundle" = "1" ] || printf ',' >> "$out"; first_bundle=0; \
      printf '\n    "%s": {' "$name" >> "$out"; \
      first=1; \
      for f in "$bundle"/zkir/*.zkir; do \
        [ -e "$f" ] || continue; \
        c=$(basename "$f" .zkir); \
        cp "$f" "$tmp/"; \
        m=$(cd "$tmp" && /opt/compactc/zkir-v3 mock-compile "$c.zkir" 2>&1 | grep -oE '\(k=[0-9]+, rows=[0-9]+\)' | head -1); \
        k=$(printf '%s' "$m" | sed -E 's/.*k=([0-9]+).*/\1/'); \
        rows=$(printf '%s' "$m" | sed -E 's/.*rows=([0-9]+).*/\1/'); \
        prover=0; [ -f "$bundle/keys/$c.prover" ] && prover=$(stat -c %s "$bundle/keys/$c.prover"); \
        verifier=0; [ -f "$bundle/keys/$c.verifier" ] && verifier=$(stat -c %s "$bundle/keys/$c.verifier"); \
        [ "$first" = "1" ] || printf ',' >> "$out"; first=0; \
        printf '\n      "%s": { "k": %s, "rows": %s, "proverBytes": %s, "verifierBytes": %s }' \
          "$c" "${k:-0}" "${rows:-0}" "$prover" "$verifier" >> "$out"; \
        rm -f "$tmp/$c.zkir"; \
      done; \
      printf '\n    }' >> "$out"; \
    done; \
    printf '\n  }\n}\n' >> "$out"; \
    rm -rf "$tmp"; \
    # ONE flat view for consumers that do not care which bundle a circuit came from.
    bun -e 'const j = await Bun.file("/aa/.circuit-k.json").json(); \
      const flat = {}; for (const b of Object.values(j.bundles)) Object.assign(flat, b); \
      j.circuits = flat; await Bun.write("/aa/.circuit-k.json", JSON.stringify(j, null, 2) + "\n"); \
      const rows = Object.entries(flat).sort((a, b) => b[1].k - a[1].k); \
      console.log(`${rows.length} proof-bearing circuits; heaviest ${rows[0][0]} k=${rows[0][1].k} rows=${rows[0][1].rows}`); \
      console.log(`prover keys kept: ${rows.filter((r) => r[1].proverBytes > 0).length}, ` + \
        `${(rows.reduce((a, r) => a + r[1].proverBytes, 0) / 1e9).toFixed(2)} GB`);'

RUN printf '%s\n' \
      '#!/bin/bash' \
      'set -euo pipefail' \
      '# Idempotent: compose re-runs completed one-shots on EVERY `up` (measured,' \
      '# T4.7 finding) — a second run must not deploy a second vault. A second vault' \
      '# would be WORSE than a duplicate contract here: every account is compiled' \
      '# against one exact vault build and records its address, so two vaults on one' \
      '# chain is two incompatible populations of accounts.' \
      'if [ -f /aa/out/aa-contracts.json ]; then' \
      '  echo "[aa-deploy] already deployed — /aa/out/aa-contracts.json:"' \
      '  cat /aa/out/aa-contracts.json' \
      '  exit 0' \
      'fi' \
      'exec bun run /aa/runner/deploy-aa.ts' \
      > /usr/local/bin/aa-entrypoint \
 && chmod +x /usr/local/bin/aa-entrypoint

ENTRYPOINT ["/usr/local/bin/aa-entrypoint"]
