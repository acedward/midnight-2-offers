#!/bin/sh
# signet-fakenet entrypoint — turn this stack's `aa-out` volume into the responder's
# environment, then exec the fork's CLI unchanged.
#
# The responder needs three things this stack generates rather than configures:
#
#   MPC_ROOT_KEY                      the PER-STACK MPC root PRIVATE key. `aa-deploy`
#                                     generates it and initialises the vault against its
#                                     public half; it lives ONLY in /aa/out/signet-root.env
#                                     (mode 600) on the `aa-out` volume. It is never a
#                                     command-line argument, never logged, and `./down.sh -v`
#                                     rotates it with the chain.
#   MIDNIGHT_SIGNET_CONTRACT_ADDRESS  the singleton `aa-deploy` deployed.
#   MIDNIGHT_CALLER_ALLOWLIST         the vault `aa-deploy` deployed — the ONE caller this
#                                     responder serves (00034 question Q64). Locally the
#                                     singleton is ours alone, so this is a habit rather than
#                                     a defence; the habit is the point.
#
# Both of the last two are read from the deploy receipt, so they cannot drift from the
# contracts actually on chain.
#
# It REFUSES to start when the vault was initialised against the local stub MPC key
# (`mpc.provenance != "fakenet"`). That happens when a stack was brought up with `aa` and
# `signet` was added afterwards: `aa-deploy` is idempotent, so the vault keeps the stub key
# whose private half is public, and a responder holding a different root would sign from
# addresses no deposit will ever land on. The fix is `./down.sh -v` and a fresh bring-up,
# and saying so here is cheaper than discovering it three minutes into a bridge.
set -eu

TAG='[signet-fakenet]'
say() { echo "$TAG $*"; }
die() { echo "$TAG FATAL: $*" >&2; exit 78; }

OUT_DIR="${SIGNET_OUT_DIR:-/aa/out}"
RECEIPT="$OUT_DIR/aa-contracts.json"
ROOT_ENV="$OUT_DIR/signet-root.env"

[ -f "$RECEIPT" ]  || die "no deploy receipt at $RECEIPT — the aa-deploy one-shot must finish first"
[ -f "$ROOT_ENV" ] || die "no MPC root secret at $ROOT_ENV — aa-deploy writes it when AA_SIGNET=1; this stack's vault was deployed without the signet profile. ./down.sh -v and bring the stack up with --with aa --with signet"

# One node pass over the receipt: it prints the three public values as shell assignments and
# fails loudly on a stub-keyed vault. `node` is the image's own runtime; there is no jq here.
RECEIPT_VARS="$(node -e '
  const fs = require("node:fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const hex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);
  const fail = (m) => { console.error(m); process.exit(1); };
  if (j.kind !== "aa-passport-deploy-receipt") fail(`not a Passport deploy receipt (kind=${j.kind ?? "absent"})`);
  if (!hex64(j.signet?.address)) fail("the receipt names no Signet singleton address");
  if (!hex64(j.vault?.address))  fail("the receipt names no vault address");
  if (j.mpc?.provenance !== "fakenet")
    fail(`the vault was initialised with mpc.provenance="${j.mpc?.provenance}", not "fakenet": its MPC root key is the LOCAL STUB derived from AA_DOMAIN, whose private half is public. A responder holding a different root would sign from addresses no deposit can land on. ./down.sh -v, then ./up.sh --with aa --with signet`);
  process.stdout.write(
    `SINGLETON=${j.signet.address}\n` +
    `VAULT=${j.vault.address}\n` +
    `VAULT_EVM=${j.vault.evmAddress}\n` +
    `VAULT_CHAIN=${j.vault.evmChainId}\n` +
    `MPC_ROOT_PUBLIC=${j.mpc.rootPublicKey}\n`);
' "$RECEIPT")" || die "the deploy receipt is not usable (see the line above)"

# shellcheck disable=SC2046
eval "$RECEIPT_VARS"

# The PRIVATE root, sourced into this process only. Nothing echoes it and nothing writes it
# anywhere else; `set -a` is scoped to the two lines below.
set -a
# shellcheck disable=SC1090
. "$ROOT_ENV"
set +a
[ -n "${MPC_ROOT_KEY:-}" ] || die "$ROOT_ENV carries no MPC_ROOT_KEY"
case "$MPC_ROOT_KEY" in
  0x*) ;;
  *) MPC_ROOT_KEY="0x$MPC_ROOT_KEY"; export MPC_ROOT_KEY ;;
esac

[ -n "${EVM_RPC_URL:-}" ] || die "EVM_RPC_URL is empty — set SIGNET_EVM_RPC_URL in the stack's .env (it is the operator's Sepolia endpoint and is a SECRET: it never leaves .env)"

export DISABLE_SOLANA="${DISABLE_SOLANA:-true}"
export MIDNIGHT_SIGNET_CONTRACT_ADDRESS="$SINGLETON"
export MIDNIGHT_CALLER_ALLOWLIST="${MIDNIGHT_CALLER_ALLOWLIST:-$VAULT}"

say "responder for ONE vault on this stack"
say "  singleton      $SINGLETON"
say "  allow-list     $MIDNIGHT_CALLER_ALLOWLIST  (and nothing else — 00034 question Q64)"
say "  vault EVM acct $VAULT_EVM  on chain id $VAULT_CHAIN"
say "  MPC root       $(printf '%s' "$MPC_ROOT_PUBLIC" | cut -c1-20)…  (PUBLIC half; the private half stays in $ROOT_ENV)"
say "  Midnight       node=${MIDNIGHT_NODE_URL:-?} indexer=${MIDNIGHT_INDEXER_URL:-?} proof=${MIDNIGHT_PROOF_SERVER_URL:-?}"
say "  EVM RPC        configured (a secret; the URL is deliberately not printed)"
say "  responses API  port ${RESPONSES_API_PORT:-3040}"
say "  attestation    eth_call replay when the RPC has no debug_traceTransaction — DEMO-GRADE (00034 question Q62)"

exec "$@"
