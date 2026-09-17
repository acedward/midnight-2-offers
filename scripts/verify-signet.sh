#!/usr/bin/env bash
#
# Assertions for the `signet` profile — the `signet` section of ./verify.sh.
#
#   ./scripts/verify-signet.sh
#
# WHAT THIS PROFILE IS. `signet` runs our patched fakenet as the MPC responder for the bridge
# vault the `aa` profile deploys: it watches the Signet singleton on this chain, serves ONLY
# our vault, signs with the per-stack MPC root key, broadcasts on the operator's EVM RPC and
# posts the attestation back. It is what turns the `aa` profile's bridge from "the circuits are
# deployed" into "funds can cross".
#
# WHAT THIS SCRIPT PROVES, and why each claim is worth a check:
#
#   healthy       the responder answers on its helper API — which the server starts only AFTER
#                 its Midnight monitor has connected, so this is "watching the singleton", not
#                 "process running".
#   receipt       the vault records `mpc.provenance: "fakenet"` and the EVM chain id this stack
#                 was brought up for. A stack that ran `aa` first and gained `signet` later keeps
#                 the STUB key (aa-deploy is idempotent), and a responder holding a different
#                 root would sign from addresses no deposit can land on.
#   derivations   THE CENTRAL CHECK. The vault's own EVM address and the MPC response key the
#                 vault verifies against are re-derived from the per-stack root secret INSIDE the
#                 responder's image, with Sig Network's own @sig-net/midnight, and compared to
#                 the receipt. Deriving them with the fork's client — the code that WROTE the
#                 receipt — would be circular; this is a second implementation of the same
#                 specification, and a disagreement means every deposit address this stack shows
#                 is one the responder will never sweep.
#   allow-list    the responder's own startup log names the singleton it watches and the ONE
#                 caller it serves, and that caller is this stack's vault (00034 question Q64).
#   no FOREIGN    every request the responder SERVED came from this stack's own vault. It used
#   signing       to be "zero requests, ever", which stopped being true the moment the Bridge
#                 tab could raise one (project 00035 PR-B); what must stay zero is a request
#                 from any other caller, which is what the allow-list exists to prevent.
#   evm chain     a READ-ONLY eth_chainId through the responder's own RPC equals the chain the
#                 vault is pinned to. It is the cheapest possible proof that the endpoint the
#                 operator supplied is the chain they think it is — and a mismatch is how funds
#                 get stranded at a correctly derived address on the wrong chain.
#
# NOTHING HERE SPENDS ANYTHING. The only network call is eth_chainId. No secret is printed: the
# root secret never leaves the container, the RPC URL is never echoed, and the derivations print
# only public addresses and public keys.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

load_env
use_all_profiles

FAILURES=0
EXPECT_CHAIN="${AA_EVM_CHAIN_ID:-11155111}"

# ── the container ────────────────────────────────────────────────────────────
cid="$(docker ps -q \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=signet-fakenet" 2>/dev/null | head -1)"
if [[ -z "$cid" ]]; then
  err "no RUNNING signet-fakenet container for project '${COMPOSE_PROJECT_NAME}'"
  dim "bring it up with: ./up.sh --with aa --with signet"
  exit 1
fi
health="$(docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
if [[ "$health" == "healthy" ]]; then
  ok "signet-fakenet is healthy — its responses API answers, so its Midnight monitor connected"
else
  err "signet-fakenet health is '${health}' — it is not watching the singleton"
  FAILURES=$(( FAILURES + 1 ))
fi

# ── the receipt, and the two derivations, in ONE in-container pass ───────────
#
# Run inside the RESPONDER's image on purpose: that image holds @sig-net/midnight, which is the
# implementation the MPC's own derivation is specified by, and it is the only place on this
# stack that can read the root secret at all. The script prints one `key=value` line per public
# fact and nothing else; the secret is read into a local and never rendered.
summary="$(docker exec -i "$cid" node -e '
  const fs = require("node:fs");
  const { deriveEvmAddress, deriveMidnightResponseKey } =
    require("/app/node_modules/@sig-net/midnight/dist/epsilon-derivation.js");
  const { formatSecp256k1PublicKey, normaliseSecp256k1PublicKey, secp256k1PublicKeyOf } =
    require("/app/node_modules/@sig-net/midnight/dist/ecdsa-attestation.js");

  // The responder process own environment, read by name. NUL-separated; only the two names
  // asked for are ever returned, and nothing else in the block is read into a variable.
  const pid1Env = (name) => {
    try {
      const raw = fs.readFileSync("/proc/1/environ", "utf8");
      for (const kv of raw.split("\0")) {
        if (kv.startsWith(name + "=")) return kv.slice(name.length + 1);
      }
    } catch { /* not Linux, or no /proc: fall through to the configured environment */ }
    return process.env[name] ?? "";
  };

  const receipt = JSON.parse(fs.readFileSync("/aa/out/aa-contracts.json", "utf8"));
  const rootLine = fs.readFileSync("/aa/out/signet-root.env", "utf8")
    .split("\n").map((l) => l.trim()).find((l) => l.startsWith("MPC_ROOT_KEY="));
  if (!rootLine) { console.error("no MPC_ROOT_KEY in /aa/out/signet-root.env"); process.exit(1); }
  const secret = Buffer.from(rootLine.slice("MPC_ROOT_KEY=".length).replace(/^0x/i, ""), "hex");
  if (secret.length !== 32) { console.error("the root secret is not 32 bytes"); process.exit(1); }

  // The PUBLIC half, derived here from the secret this stack holds — so the check starts one
  // step earlier than the receipt does and would catch a receipt written from a different key.
  const pub = normaliseSecp256k1PublicKey(
    formatSecp256k1PublicKey(secp256k1PublicKeyOf(new Uint8Array(secret))));

  // The vault renders its own derivation path as pad(32, "vault") and the MPC takes the
  // lowercase hex of all 32 bytes, padding included (contracts/erc20-vault/src/index.ts
  // vaultPathHex). Spelled out here rather than imported, because importing the fork would make
  // this the same implementation the receipt came from.
  const vaultPathHex = Buffer.concat([Buffer.from("vault", "utf8"), Buffer.alloc(27)]).toString("hex");

  const vault = receipt.vault.address;
  const out = {
    provenance: receipt.mpc?.provenance ?? "",
    chainId: String(receipt.vault?.evmChainId ?? ""),
    vaultAddress: vault,
    singleton: receipt.signet?.address ?? "",
    receiptRootPublic: String(receipt.mpc?.rootPublicKey ?? "").toLowerCase(),
    derivedRootPublic: pub.toLowerCase(),
    receiptVaultEvm: String(receipt.vault?.evmAddress ?? "").toLowerCase(),
    derivedVaultEvm: deriveEvmAddress(pub, vault, vaultPathHex).toLowerCase(),
    receiptResponseKey: String(receipt.vault?.mpcResponseKey ?? "").toLowerCase(),
    derivedResponseKey: formatSecp256k1PublicKey(deriveMidnightResponseKey(pub, vault)).toLowerCase(),
    // NOT process.env: `docker exec` starts a new process whose environment is the CONFIGURED
    // one (what compose passes), and these two are deliberately not in compose — the entrypoint
    // derives them from the receipt and exports them into the responder itself. So they are read
    // from PID 1, which is the responder, and is the only place that says what it is ACTUALLY
    // using. Exactly two variables are lifted out; MPC_ROOT_KEY and EVM_RPC_URL live in the same
    // block and are never touched.
    allowlist: pid1Env("MIDNIGHT_CALLER_ALLOWLIST"),
    watching: pid1Env("MIDNIGHT_SIGNET_CONTRACT_ADDRESS"),
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);

  // The one network call: a read-only eth_chainId on the operator endpoint. The URL is read
  // from the environment and never printed.
  fetch(process.env.EVM_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.json())
    .then((j) => console.log(`rpcChainId=${BigInt(j.result).toString()}`))
    .catch((e) => console.log(`rpcChainId=ERROR:${String(e.message ?? e).slice(0, 120)}`));
' 2>&1)" || { err "the in-container derivation pass failed"; printf '%s\n' "$summary" | sed 's/^/      /' >&2; exit 1; }

field() { printf '%s\n' "$summary" | sed -n "s/^$1=//p" | head -1; }

PROVENANCE="$(field provenance)"
CHAIN="$(field chainId)"
VAULT="$(field vaultAddress)"
SINGLETON="$(field singleton)"
ALLOWLIST="$(field allowlist)"
WATCHING="$(field watching)"
RPC_CHAIN="$(field rpcChainId)"

info "  vault      ${VAULT:0:20}…  evm $(field receiptVaultEvm)  chain ${CHAIN}"
info "  singleton  ${SINGLETON:0:20}…"
info "  mpc root   $(field derivedRootPublic | cut -c1-20)…  (public half; provenance ${PROVENANCE})"

# ── provenance and chain id ──────────────────────────────────────────────────
if [[ "$PROVENANCE" == "fakenet" ]]; then
  ok "the vault was initialised against this stack's own MPC root (mpc.provenance=fakenet)"
else
  err "mpc.provenance is '${PROVENANCE}', not 'fakenet' — this vault is STUB-KEYED and the responder holds a different root"
  dim "a stack brought up with 'aa' and given 'signet' afterwards keeps the stub: ./down.sh -v, then ./up.sh --with aa --with signet"
  FAILURES=$(( FAILURES + 1 ))
fi
if [[ "$CHAIN" == "$EXPECT_CHAIN" ]]; then
  ok "the vault is pinned to EVM chain id ${CHAIN}"
else
  err "the vault is pinned to chain ${CHAIN} but this stack is configured for ${EXPECT_CHAIN}"
  FAILURES=$(( FAILURES + 1 ))
fi

# ── the derivations: the receipt vs a second implementation ──────────────────
check_pair() {
  local label="$1" a="$2" b="$3"
  if [[ -n "$a" && "$a" == "$b" ]]; then
    ok "${label} agrees: ${a:0:26}…"
  else
    err "${label} DISAGREES — receipt '${a}' vs derived '${b}'"
    FAILURES=$(( FAILURES + 1 ))
  fi
}
check_pair "MPC root public key" "$(field receiptRootPublic)" "$(field derivedRootPublic)"
check_pair "the vault's own EVM address" "$(field receiptVaultEvm)" "$(field derivedVaultEvm)"
check_pair "the MPC response key" "$(field receiptResponseKey)" "$(field derivedResponseKey)"

# ── the allow-list, from the responder's own environment and its own log ─────
if [[ "$ALLOWLIST" == "$VAULT" ]]; then
  ok "the responder serves exactly one caller, and it is this stack's vault"
else
  err "the responder's allow-list is '${ALLOWLIST}', not the vault '${VAULT}'"
  FAILURES=$(( FAILURES + 1 ))
fi
if [[ "$WATCHING" == "$SINGLETON" ]]; then
  ok "the responder watches the singleton this stack deployed"
else
  err "the responder watches '${WATCHING}', not this stack's singleton '${SINGLETON}'"
  FAILURES=$(( FAILURES + 1 ))
fi

LOGS="$(docker logs "$cid" 2>&1 | tail -400 || true)"
if printf '%s' "$LOGS" | grep -Fq "allow-listed caller contract(s) ONLY"; then
  ok "its startup log states the allow-list out loud (00034 question Q64)"
else
  err "the responder's log carries no allow-list line — it may be serving EVERY caller"
  FAILURES=$(( FAILURES + 1 ))
fi

# Signing activity, and WHOSE.
#
# ⚠ THIS CHECK CHANGED IN PROJECT 00035 PR-B, and the reason is worth stating. Before the
# Bridge tab existed, nothing on this stack could raise a signature request, so ANY signing
# line meant the responder was answering something it was not asked to — and the check was a
# flat "zero". A stack that has bridged a token has served requests, correctly, and a gate that
# fails on that would be a gate an operator learns to ignore.
#
# What stays an error is a FOREIGN request: one whose caller is not this stack's vault. The
# allow-list makes that impossible by construction (00034 question Q64), and this is the
# assertion that the allow-list is doing its job rather than being merely configured.
SIGNED="$(printf '%s' "$LOGS" | grep -cE 'Midnight: Signed tx|New request .* from contract|response posted for' || true)"
FOREIGN="$(printf '%s' "$LOGS" \
  | grep -oE 'New request [^ ]+ from contract [0-9a-fx]+' \
  | awk '{print tolower($NF)}' | sed 's/^0x//' \
  | grep -v -F -x "$(printf '%s' "$VAULT" | tr 'A-Z' 'a-z' | sed 's/^0x//')" | wc -l | tr -d ' ')"
IGNORED="$(printf '%s' "$LOGS" | grep -cE 'ignoring requests from contract' || true)"
if [[ "${FOREIGN:-0}" -ne 0 ]]; then
  err "${FOREIGN} request(s) from a contract that is NOT this stack's vault were SERVED — the allow-list is not holding"
  FAILURES=$(( FAILURES + 1 ))
elif [[ "${SIGNED:-0}" -eq 0 ]]; then
  ok "zero signature requests served — nothing has used the bridge on this stack yet"
else
  ok "${SIGNED} signing log line(s), every one of them for this stack's own vault (bridge traffic)"
fi
if [[ "${IGNORED:-0}" -ne 0 ]]; then
  ok "${IGNORED} request(s) from other callers were IGNORED — the allow-list is doing its job"
fi

# ── the EVM endpoint, read-only ──────────────────────────────────────────────
case "$RPC_CHAIN" in
  "$EXPECT_CHAIN")
    ok "the responder's EVM RPC answers eth_chainId=${RPC_CHAIN} — the chain the vault is pinned to" ;;
  ERROR:*)
    err "the responder's EVM RPC did not answer eth_chainId (${RPC_CHAIN#ERROR:})"
    FAILURES=$(( FAILURES + 1 )) ;;
  *)
    err "the responder's EVM RPC serves chain ${RPC_CHAIN}, but the vault is pinned to ${EXPECT_CHAIN}"
    dim "every derived deposit address is scoped to the pinned chain: funds sent on the other one are stranded"
    FAILURES=$(( FAILURES + 1 )) ;;
esac

# ── the posture, said every run ──────────────────────────────────────────────
info "  this bridge is DEMO-GRADE by construction: the stack holds BOTH halves of the MPC root"
info "  key, and the attestation is recovered by eth_call replay whenever the RPC has no"
info "  debug_traceTransaction (00034 questions Q62/Q64). docs/KNOWN-LIMITATIONS.md."

if (( FAILURES == 0 )); then
  ok "signet assertions passed"
  exit 0
fi
err "${FAILURES} signet assertion(s) failed"
exit 1
