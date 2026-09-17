# signet-fakenet — the MPC responder of the `signet` profile.
#
# Source: acedward/solana-signet-program, branch `00034-trace-fallback`, pinned commit
# a1a7798f… — our fork of sig-net/solana-signet-program (MIT) with TWO local patches on top
# of upstream `develop` @ 13fd0e8e (= tag fakenet-v0.23.0, the commit behind
# ghcr.io/sig-net/fakenet:0.23.0). Fork PR: acedward/solana-signet-program#1.
#
#   58c39d5  `eth_call` replay when the RPC has no debug_traceTransaction (project 00034,
#            question Q62). Alchemy's free tier rejects `debug_traceTransaction`, which is
#            how upstream recovers a mined call's return data, so without this the signed
#            Sepolia transfer can be broadcast but never attested. The patch falls back —
#            and ONLY when the error is "method not supported" — to an `eth_call` of the
#            same from/to/data/value at the mined block's PARENT. It is DEMO-GRADE: that
#            reads pre-block state, so a call whose result depends on same-block writes
#            could differ from what the MPC would have signed. For one ERC20 `transfer`
#            from an address nothing else touches it does not. With a traced endpoint the
#            image takes the upstream path unchanged and this code is never reached.
#   a1a7798  MIDNIGHT_CALLER_ALLOWLIST (project 00034, question Q64). Upstream serves EVERY
#            request notified on the signet contract it watches, which is right on a private
#            stack and wrong on a shared one. Unset keeps upstream behaviour exactly.
#
# This file IS the packaging for THIS stack: it reproduces the fork's own
# `fakenet-signer/Dockerfile` (which builds from the repository root, because yarn-1
# workspace resolution needs all three package.jsons) and adds the entrypoint that reads
# this stack's per-stack MPC root secret and deploy receipt out of the `aa-out` volume.
# Built from a REMOTE clone rather than a vendored copy, exactly like images/umbra-evm, so
# `git clone <this repo> && ./up.sh --with aa --with signet` works with nothing else on disk.
#
#   docker compose ... build signet-fakenet
#   ./scripts/build-fakenet-image.sh            # the same build, standalone
#
# SIGNET_FAKENET_REF defaults to a full commit SHA so a clean build cannot silently move.
# The resolved commit is baked in at /app/.signet-fakenet-commit:
#
#   docker run --rm <image> cat /app/.signet-fakenet-commit
#
# NO SECRET IS BAKED IN. The MPC root key, the Sepolia RPC URL and the responder's wallet
# seed all arrive at RUN time — the first from a file on the `aa-out` volume, the others
# from the environment.

# Declared before the first FROM so the defaults reach BOTH stages.
ARG SIGNET_FAKENET_REPO=https://github.com/acedward/solana-signet-program.git
ARG SIGNET_FAKENET_REF=a1a7798f35cab07d5279cfd9785777944b94a572

# ── stage 1: fetch the source ────────────────────────────────────────────────
FROM node:24-bookworm-slim AS source

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG SIGNET_FAKENET_REPO
ARG SIGNET_FAKENET_REF

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$SIGNET_FAKENET_REPO" \
 && git fetch -q --depth 1 origin "$SIGNET_FAKENET_REF" \
 && git checkout -q FETCH_HEAD \
 && git rev-parse HEAD > /signet-fakenet-commit \
 && rm -rf .git

# The two patches are the identity of this build, so their presence is asserted rather than
# assumed: a ref that moved back to upstream would otherwise produce an image that cannot
# attest on a free-tier RPC and answers every caller on a shared singleton, silently.
RUN set -eux; \
    grep -q 'replayCallOutput'            /src/fakenet-signer/src/modules/ethereum/EthereumMonitor.ts; \
    grep -q 'MIDNIGHT_CALLER_ALLOWLIST'   /src/fakenet-signer/src/config/EnvConfig.ts; \
    grep -q 'callerAllowlist'             /src/fakenet-signer/src/modules/MidnightMonitor.ts

# ── stage 2: install and run ─────────────────────────────────────────────────
# glibc base, never alpine/musl: the Midnight SDKs load WASM/native artifacts that are
# untested on musl. This mirrors the fork's own fakenet-signer/Dockerfile.
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Manifests first for layer caching. All three workspace package.jsons are needed for
# yarn-1 workspace resolution even though only fakenet-signer runs here.
COPY --from=source /src/package.json /src/yarn.lock ./
COPY --from=source /src/fakenet-signer/package.json  fakenet-signer/
COPY --from=source /src/signet-program/package.json  signet-program/
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Source + committed runtime assets (idl/). The signet contract's zk artifacts (including
# its prover keys) come from the @sig-net/midnight-contract npm package installed above.
COPY --from=source /src/fakenet-signer/ fakenet-signer/
COPY --from=source /signet-fakenet-commit /app/.signet-fakenet-commit

# Our own wrapper: it reads the per-stack MPC root secret and the deploy receipt from the
# `aa-out` volume, refuses a stack whose vault was initialised against the LOCAL STUB key,
# and only then execs the responder. It is the only file in this image that is not the
# fork's.
COPY docker-entrypoint-signet.sh /usr/local/bin/signet-fakenet-entrypoint
RUN chmod +x /usr/local/bin/signet-fakenet-entrypoint

# cwd matters: the LevelDB private state is created at ./midnight-level-db (fresh per
# container recreate, intentional — it is a single-writer store tied to the joined
# contract), and EnvConfig's optional dotenv file resolves to /app/.env, which is absent:
# configuration comes from the environment.
WORKDIR /app/fakenet-signer
ENTRYPOINT ["/usr/local/bin/signet-fakenet-entrypoint"]
CMD ["/app/node_modules/.bin/tsx", "src/cli/Run.ts"]
