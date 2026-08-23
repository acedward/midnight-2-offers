#!/usr/bin/env bash
#
# Print the Celestia namespace the demo stack uses, in the form a caller asks for.
#
#   celestia-namespace            # the configured hex suffix, e.g. 000000000000deadbeef
#   celestia-namespace --hex      # same, with a 0x prefix (what the `celestia blob` CLI takes)
#   celestia-namespace --base64   # the full 29 bytes, base64 (what the JSON-RPC API takes)
#   celestia-namespace --full-hex # the full 29 bytes, hex (for eyeballing the layout)
#
# WHY THIS EXISTS RATHER THAN THE CALLER DOING IT.
# A Celestia namespace is 29 bytes: a version byte plus a 28-byte id. For version-0 (user)
# namespaces the first 18 id bytes MUST be zero, leaving 10 freely chosen bytes — so config
# everywhere carries just that 10-byte suffix and the wire format is `0x00` ‖ 18×`0x00` ‖ suffix.
# The kernel does this expansion in `mip6NamespaceBytes()`
# (packages/offer-guard/mod.ts: `bytes[19 + i] = suffix[i]`); this is the same expansion, so a
# blob written by verify.sh lands in exactly the namespace the kernel will read.
#
# It lives in the image, not in scripts/lib/, because turning hex into raw bytes on the host
# would mean depending on xxd/python — neither of which the repo's other scripts assume (they
# borrow the jq inside a container for the same reason).
#
set -euo pipefail

NS="${CELESTIA_NAMESPACE:-}"
MODE="${1:-suffix}"

[[ -n "$NS" ]] || { echo "celestia-namespace: CELESTIA_NAMESPACE is not set" >&2; exit 1; }
NS="${NS#0x}"
NS="$(printf '%s' "$NS" | tr 'A-F' 'a-f')"

[[ "$NS" =~ ^[0-9a-f]+$ ]] || { echo "celestia-namespace: '$NS' is not hex" >&2; exit 1; }
(( ${#NS} % 2 == 0 )) || { echo "celestia-namespace: '$NS' has an odd number of hex digits" >&2; exit 1; }
# 28 bytes is the whole id; anything shorter is right-aligned into it, which is what makes the
# 10-byte form and the fully-written-out 56-char form mean the same namespace.
(( ${#NS} <= 56 )) || { echo "celestia-namespace: '$NS' is longer than a 28-byte namespace id" >&2; exit 1; }

# Right-align into the 28-byte id, then prepend the version byte.
ID_HEX="$(printf '%056s' "$NS" | tr ' ' '0')"
FULL_HEX="00${ID_HEX}"

hex_to_bytes() {
  local hex="$1" esc="" i
  for (( i = 0; i < ${#hex}; i += 2 )); do esc+="\\x${hex:i:2}"; done
  # shellcheck disable=SC2059  # the format string is built from validated hex only
  printf "$esc"
}

case "$MODE" in
  suffix)   printf '%s\n' "$NS" ;;
  --hex)    printf '0x%s\n' "$NS" ;;
  --full-hex) printf '%s\n' "$FULL_HEX" ;;
  --base64) hex_to_bytes "$FULL_HEX" | base64 | tr -d '\n'; printf '\n' ;;
  *) echo "celestia-namespace: unknown mode '$MODE' (suffix|--hex|--full-hex|--base64)" >&2; exit 2 ;;
esac
