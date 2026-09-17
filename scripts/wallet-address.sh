#!/usr/bin/env bash
#
# wallet-address.sh — print ONE public address form of a seed, and nothing else.
#
#   ./scripts/wallet-address.sh <seed> [shielded|unshielded|dust|userAddress]
#
# The derivation is `midnight-node-toolkit show-address`, offline: it needs the compose
# NETWORK (the toolkit runs as a container joined to it) but makes no chain query.
#
# WHY IT IS ITS OWN SCRIPT. Addresses are PUBLIC and seeds are not, and several callers want
# the first without handling the second. `up.sh` uses it to tell the AA console where the
# frontend's in-page wallet lives so the Bridge tab can offer it as one click (project 00035
# FR-003) — the console is given the address and never the seed. Keeping it here rather than
# sourcing scripts/lib/toolkit.sh into up.sh also keeps up.sh's own surface unchanged.
#
# The SEED IS NEVER PRINTED, not even in part: it is an argument, and the only thing that
# reaches stdout is the address.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/toolkit.sh
source "$REPO_ROOT/scripts/lib/toolkit.sh"
load_env

SEED="${1:-}"
KIND="${2:-shielded}"

[[ -n "$SEED" ]] || { echo "usage: $0 <seed> [shielded|unshielded|dust|userAddress]" >&2; exit 2; }
case "$SEED" in
  *[!0-9a-fA-F]* | "") echo "the seed must be hex (64 or 128 characters)" >&2; exit 2 ;;
esac
case "${#SEED}" in
  64|128) ;;
  *) echo "the seed must be 64 or 128 hex characters (32-byte seed or 64-byte BIP-39 master seed)" >&2; exit 2 ;;
esac
case "$KIND" in
  shielded|unshielded|dust|userAddress) ;;
  *) echo "kind must be shielded | unshielded | dust | userAddress" >&2; exit 2 ;;
esac

ADDRESS="$(address_of "$SEED" "$KIND" 2>/dev/null || true)"
[[ -n "$ADDRESS" && "$ADDRESS" != "null" ]] || {
  echo "show-address returned nothing for that seed — is the stack up (the toolkit joins its network)?" >&2
  exit 1
}
printf '%s\n' "$ADDRESS"
