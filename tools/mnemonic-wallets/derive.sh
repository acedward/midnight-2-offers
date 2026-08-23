#!/usr/bin/env bash
#
# Run derive.mjs without needing Node on the host — same "docker is the only prerequisite"
# rule the rest of this repo follows.
#
#   ./tools/mnemonic-wallets/derive.sh                          # every entry in mnemonics.json
#   ./tools/mnemonic-wallets/derive.sh --json
#   ./tools/mnemonic-wallets/derive.sh --check wallets/wallets.json
#   ./tools/mnemonic-wallets/derive.sh --mnemonic "abandon abandon … art"
#
# All arguments pass straight through to derive.mjs. Relative paths in arguments are resolved
# against the REPO ROOT, because that is the container's working directory.
#
# Mechanics: dependencies live in a tiny local image (see Dockerfile — installing them into a
# bind mount fails on macOS), the repo is mounted READ-ONLY, and node's module resolution
# walks up from /app/repo/tools/mnemonic-wallets/derive.mjs to the image's /app/node_modules.
# So editing derive.mjs or mnemonics.json takes effect immediately; only a change to
# package.json / package-lock.json triggers a real rebuild.
#
# If Node >= 22 is on the host, `cd tools/mnemonic-wallets && npm ci && node derive.mjs …` is
# equivalent and faster. Remove the image afterwards with
#   docker image rm midnight-2-offers/mnemonic-wallets:local
#
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TOOL_DIR/../.." && pwd)"
REL_TOOL_DIR="${TOOL_DIR#"$REPO_ROOT"/}"

IMAGE="${MNEMONIC_TOOL_IMAGE:-midnight-2-offers/mnemonic-wallets:local}"

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 1; }

# Quiet and layer-cached: a no-op after the first build unless the manifests changed.
docker build -q -t "$IMAGE" "$TOOL_DIR" >/dev/null

exec docker run --rm -i \
  -v "$REPO_ROOT:/app/repo:ro" \
  -w /app/repo \
  "$IMAGE" "/app/repo/$REL_TOOL_DIR/derive.mjs" "$@"
