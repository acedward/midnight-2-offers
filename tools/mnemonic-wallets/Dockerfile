# Dependencies for tools/mnemonic-wallets/derive.mjs, baked into an image.
#
# Why an image rather than `npm ci` into a bind mount: installing this dependency tree
# directly into a macOS bind mount fails —
#   ENOTDIR: not a directory, mkdir '/app/node_modules/@scure/bip32/node_modules/@noble'
# — because npm's nested-node_modules writes do not survive the Docker Desktop filesystem.
# Building the tree inside the image sidesteps it entirely, the docker layer cache makes
# repeat runs instant, and nothing is ever written to the host.
#
# Only the manifests are copied, so editing derive.mjs or mnemonics.json needs NO rebuild:
# derive.sh mounts the repo at /app/repo and node's module resolution walks up from the
# script to /app/node_modules.
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Derivation is pure computation — no chain, no network, no state.
ENTRYPOINT ["node"]
