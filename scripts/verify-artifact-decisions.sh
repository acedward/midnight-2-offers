#!/usr/bin/env bash
# Verify the frozen artifact-selection contract in config/artifact-decisions.json.
#
# Static and offline: no network, no Docker, no registry. It answers one question —
# "does this repository still make the artifact choices it promised?" — so a later
# change cannot quietly repack a good official image, fall back to a source build
# where an exact warehouse binary exists, pin by tag instead of digest, drop a Linux
# platform, merge the plain and experimental proof servers, or install a macOS asset
# into a Linux container.
#
#   ./scripts/verify-artifact-decisions.sh              # check the matrix
#   ./scripts/verify-artifact-decisions.sh --self-test  # also prove the checks bite
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

MATRIX="$REPO_ROOT/config/artifact-decisions.json"
CHECKER="$REPO_ROOT/scripts/lib/artifact_decisions.py"

command -v python3 >/dev/null 2>&1 || die "python3 is required to verify the artifact decision matrix"
[[ -f "$MATRIX"  ]] || die "missing artifact decision matrix: $MATRIX"
[[ -f "$CHECKER" ]] || die "missing artifact decision checker: $CHECKER"

if python3 "$CHECKER" "$MATRIX" "$@"; then
  ok "artifact decision matrix verified"
  exit 0
fi

err "artifact decision matrix verification failed"
exit 1
