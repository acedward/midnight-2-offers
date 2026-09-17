#!/usr/bin/env bash
#
# wallet-balance.sh — what a Midnight wallet actually holds, by syncing it from its own seed.
#
#   ./scripts/wallet-balance.sh <seed> [--json] [--colour <64hex> --min <raw>]
#   ./scripts/wallet-balance.sh --seed-from-env FRONTEND_WALLET_SEED --json
#
# A shielded coin is not in ledger state: it is a commitment plus a ciphertext only its
# recipient can decrypt, so the only party that can answer "does this wallet hold it" is a
# process with that wallet's keys. That is why this takes a seed — and why the console, which
# holds nothing of a third-party wallet, cannot answer it for one.
#
# It is the check the bridge's WALLET-recipient path needs: a coin minted to a key with no
# encryption-key mapping still BELONGS to its owner and is invisible to them (00034 question
# Q42), which is a silent failure. `--colour/--min` turns the read into a WAIT plus an
# assertion, so a caller can say "the 20 WEENUS arrived" instead of sleeping and hoping.
#
# THE SEED IS NEVER ON A COMMAND LINE INSIDE A CONTAINER, and never in `ps` for anybody else:
# it is written to a mode-600 file under a private temp directory and mounted read-only. Pass
# it as an argument only when your own shell history is not a concern — `--seed-from-env NAME`
# reads it from the environment (or from the env file) instead, which is what scripts should use.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

# `dc` renders core.yml plus one fragment per name in $PROFILES, and a standalone script starts
# with that empty — so `dc run … aa-deploy` would answer "no such service" against a stack that is
# plainly running. The aa profile is what defines the service AND what this script needs anyway, so
# it is named here rather than discovered. (scripts/evm-address.sh does the same for `evm`.)
PROFILES="${PROFILES:-} aa"

SEED=""
JSON=0
COLOUR=""
MIN="0"
SYNC_MS="${AA_WALLET_BALANCE_SYNC_MS:-420000}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --colour|--color) COLOUR="${2:?--colour needs a 64-hex colour}"; shift 2 ;;
    --min) MIN="${2:?--min needs a raw amount}"; shift 2 ;;
    --sync-ms) SYNC_MS="${2:?}"; shift 2 ;;
    --seed-from-env) SEED="${!2:-}"; [[ -n "$SEED" ]] || die "\$$2 is empty"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) SEED="$1"; shift ;;
  esac
done
[[ -n "$SEED" ]] || die "usage: $0 <seed> [--json] [--colour <64hex> --min <raw>]"

SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aa-wallet-balance.XXXXXX")"
chmod 700 "$SECRET_DIR"
trap 'rm -rf "$SECRET_DIR"' EXIT INT TERM
umask 077
printf 'export AA_WALLET_BALANCE_SEED=%q\n' "$SEED" > "$SECRET_DIR/seed.env"
chmod 600 "$SECRET_DIR/seed.env"

dc run --rm --no-deps -T \
  -v "$SECRET_DIR/seed.env:/run/wallet-balance.env:ro" \
  -e "AA_WALLET_BALANCE_JSON=${JSON}" \
  -e "AA_WALLET_BALANCE_COLOUR=${COLOUR}" \
  -e "AA_WALLET_BALANCE_MIN=${MIN}" \
  -e "AA_WALLET_BALANCE_SYNC_MS=${SYNC_MS}" \
  --entrypoint sh aa-deploy -c '. /run/wallet-balance.env && exec bun /aa/runner/aa-wallet-balance.ts'
