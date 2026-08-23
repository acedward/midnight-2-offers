#!/usr/bin/env bash
#
# Print the EVM address a Midnight unshielded wallet maps to — the address you hand to
# eth_getBalance, MetaMask, `cast`, or viem.
#
#   ./scripts/evm-address.sh 0000000000000000000000000000000000000000000000000000000000000001
#   ./scripts/evm-address.sh mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s
#   ./scripts/evm-address.sh --all              # every wallets/wallets.json entry
#   ./scripts/evm-address.sh --watched          # exactly what wallet-monitor is watching
#
# Output: one TAB-separated line per input — <input> <mn_addr> <0x evm address>.
#
# The mapping is keccak256(bech32m address payload)[12:32]. It is not guessable and there is no
# upstream CLI for it, so without this there is no way to ask the JSON-RPC surface about a wallet
# you know by seed. The work happens in the umbra-evm image (tools/evm-address.ts) using the very
# code the wallet monitor uses, so what this prints is what the monitor watches.
#
# Requires the `evm` profile's image to exist — i.e. `./up.sh --with evm` at least once. The
# containers do not need to be running: the tool touches neither Postgres nor the indexer.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/lib/evm.sh
source "$REPO_ROOT/scripts/lib/evm.sh"

require_docker
load_env
PROFILES="${PROFILES:-} evm"
export PROFILES
evm_defaults

INPUTS=()
MODE=args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)     MODE=all; shift ;;
    --watched) MODE=watched; shift ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) INPUTS+=("$1"); shift ;;
  esac
done

case "$MODE" in
  watched)
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then INPUTS+=("$line"); fi
    done < <(watched_wallet_inputs)
    ;;
  all)
    # Every wallet's UNSHIELDED address, taken verbatim from wallets.json rather than derived
    # from its seed. One line per wallet, and it works for the Lace entry too — whose seed is 64
    # BYTES, which the image's HD derivation rejects outright (32-byte seeds only).
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then INPUTS+=("$line"); fi
    done < <(grep -oE '"unshielded"[[:space:]]*:[[:space:]]*"mn_addr[^"]+"' "$REPO_ROOT/wallets/wallets.json" \
             | sed -E 's/.*"(mn_addr[^"]+)"$/\1/')
    ;;
esac

if (( ${#INPUTS[@]} == 0 )); then
  die "nothing to map — pass a seed or mn_addr, or use --all / --watched"
fi

evm_addresses "${INPUTS[@]}"
