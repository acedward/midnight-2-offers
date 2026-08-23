#!/usr/bin/env bash
#
# Assert that the two derivations this repo depends on agree.
#
# There are two independent implementations of "mnemonic/seed -> Midnight addresses" in play:
#
#   1. the wallet SDK's HD derivation (derive.mjs) — what Lace does, and the only thing that
#      can turn a typed-in mnemonic into an address;
#   2. midnight-node-toolkit's `show-address --seed <hex>` — what every funding and
#      verification script in this repo uses.
#
# The whole "type this mnemonic into Lace and it is already prefunded" promise rests on those
# two producing the SAME addresses for the same wallet. This script proves it: it derives the
# BIP-39 master seed from each mnemonic with the SDK, feeds that seed to the toolkit, and
# compares all four address forms.
#
# Fully offline — `show-address` needs no chain, so this runs on a bare checkout with the
# stack down.
#
#   ./tools/mnemonic-wallets/cross-check.sh [--network undeployed]
#
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK="undeployed"
TOOLKIT_IMAGE="${TOOLKIT_IMAGE:-midnightntwrk/midnight-node-toolkit:${TOOLKIT_TAG:-2.0.0-rc.4}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# jq from the toolkit image, so the host needs nothing but docker (same trick as
# scripts/lib/toolkit.sh).
jqf() { docker run -i --rm --entrypoint jq "$TOOLKIT_IMAGE" -r "$1"; }

echo "==> deriving with the wallet SDK (network ${NETWORK})"
SDK_JSON=$("$TOOL_DIR/derive.sh" --json --network "$NETWORK")

# name<TAB>masterSeed<TAB>unshielded<TAB>shielded<TAB>dust<TAB>userAddress
LINES=$(printf '%s' "$SDK_JSON" | jqf '.[] | [.name, .masterSeed, .addresses.unshielded, .addresses.shielded, .addresses.dust, .addresses.userAddress] | @tsv')

FAILURES=0
CHECKED=0

while IFS=$'\t' read -r NAME SEED U S D UA; do
  [[ -z "${NAME:-}" ]] && continue
  CHECKED=$(( CHECKED + 1 ))
  echo
  echo "==> ${NAME}"
  echo "    master seed ${SEED:0:12}…${SEED: -6} (${#SEED} hex chars)"

  TK=$(docker run --rm "$TOOLKIT_IMAGE" -q show-address --network "$NETWORK" --seed "$SEED" 2>/dev/null) \
    || { echo "    FAIL: toolkit show-address failed"; FAILURES=$(( FAILURES + 1 )); continue; }

  WALLET_FAIL=0
  for pair in "unshielded:$U" "shielded:$S" "dust:$D" "userAddress:$UA"; do
    KIND="${pair%%:*}"; WANT="${pair#*:}"
    GOT=$(printf '%s' "$TK" | jqf ".${KIND}")
    if [[ "$GOT" == "$WANT" ]]; then
      echo "    ok   ${KIND}"
    else
      echo "    FAIL ${KIND}"
      echo "         sdk     ${WANT}"
      echo "         toolkit ${GOT}"
      WALLET_FAIL=1
    fi
  done
  (( WALLET_FAIL )) && FAILURES=$(( FAILURES + 1 ))
done <<< "$LINES"

echo
if (( FAILURES == 0 )); then
  echo "==> wallet SDK and toolkit agree on all ${CHECKED} mnemonic wallet(s)"
  exit 0
fi
echo "==> ${FAILURES} of ${CHECKED} mnemonic wallet(s) DISAGREE — the derivation has drifted" >&2
exit 1
