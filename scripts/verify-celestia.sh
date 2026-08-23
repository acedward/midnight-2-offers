#!/usr/bin/env bash
#
# Assertions for the `offerfiles` profile's Celestia devnet — the `celestia` section of
# ./verify.sh.
#
#   ./scripts/verify-celestia.sh            # all checks, including the blob round trip
#   ./scripts/verify-celestia.sh --quick    # skip the round trip (it costs a fee and ~10s)
#
# What it proves, and why each one is here rather than being assumed:
#
#   auth handoff   the token can be read out of the container and the DA RPC accepts it. This is
#                  the exact mechanism P4b's kernel will use, so it is checked as a mechanism and
#                  not merely as a side effect of the calls below.
#   producing      the network head ADVANCES. A bridge node that has lost its consensus node
#                  keeps answering header.NetworkHead with the last height it saw, forever.
#   funded         the bridge wallet holds utia. It signs its own blob submissions, so an empty
#                  wallet means every submit fails at the fee — with a message about gas, not
#                  about funding.
#   blob round     a blob SUBMITTED to the namespace is READ BACK by height and namespace, and the
#     trip        bytes match. This is precisely what the kernel does (batcher
#                  ZswapCelestiaAdapter.submitBatch → sync-node fetch by height), so proving it
#                  here is what makes P4b wiring rather than discovery.
#   isolation      a DIFFERENT namespace at the same height does NOT return the blob. Without
#                  this, a `blob.GetAll` that ignored its namespace argument would pass every
#                  check above — and the whole MIP-0006 design rests on namespace separation.
#   auth enforced  an unauthenticated call is REJECTED (skipped when CELESTIA_SKIP_AUTH=true).
#
# Everything runs over the PUBLISHED HOST PORT, deliberately: that is the endpoint a human, the
# frontend, or a debugging session actually uses, and an in-container check cannot see a
# loopback-bound listener (the defect P3 spent a build on).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/celestia.sh
source "$REPO_ROOT/scripts/lib/celestia.sh"

QUICK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) QUICK=1; shift ;;
    -h|--help) sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown option: $1"; exit 2 ;;
  esac
done

require_docker
load_env
# Every fragment, not just offerfiles: this one is what `dc exec celestia` needs to resolve the
# service, and the rest keep compose from calling another profile's containers orphans.
use_all_profiles
celestia_defaults

FAILURES=0
fail() { err "$*"; FAILURES=$(( FAILURES + 1 )); }

AUTH_REQUIRED=1
if [[ "$CELESTIA_SKIP_AUTH" == "true" || "$CELESTIA_SKIP_AUTH" == "1" ]]; then
  AUTH_REQUIRED=0
fi

log "celestia: endpoint"
info "da rpc     ${CELESTIA_DA_URL}"
info "namespace  ${CELESTIA_NAMESPACE}  (chain-id ${CELESTIA_CHAIN_ID}, network ${CELESTIA_NETWORK})"

# ── the auth handoff ─────────────────────────────────────────────────────────
echo
log "celestia: auth handoff"
if (( AUTH_REQUIRED )); then
  TOKEN="$(celestia_token || true)"
  if [[ "$TOKEN" =~ ^ey[A-Za-z0-9._-]+$ ]]; then
    ok "auth token readable from the container (${#TOKEN} chars, JWT-shaped)"
  else
    fail "could not read an auth token from the celestia container — the DA RPC cannot be
          reached without it, so nothing below can be checked"
    exit 1
  fi
  # The same file a container consumer sources. Asserted as a FILE, because that is the contract
  # P4b depends on: `set -a; . /celestia/auth/celestia.env; set +a` in the kernel's entrypoint.
  HANDOFF="$(dc exec -T celestia celestia-token --env 2>/dev/null || true)"
  MISSING=""
  for key in CELESTIA_RPC_URL CELESTIA_AUTH_TOKEN CELESTIA_NAMESPACE CELESTIA_NETWORK CELESTIA_CHAIN_ID; do
    [[ "$HANDOFF" == *"${key}="* ]] || MISSING="$MISSING $key"
  done
  if [[ -z "$MISSING" ]]; then
    ok "/celestia/auth/celestia.env carries every variable the kernel reads"
  else
    fail "/celestia/auth/celestia.env is missing:${MISSING}"
  fi
  if [[ "$HANDOFF" == *"CELESTIA_NAMESPACE=${CELESTIA_NAMESPACE}"* ]]; then
    ok "the handoff namespace matches this stack's CELESTIA_NAMESPACE"
  else
    fail "the handoff file's CELESTIA_NAMESPACE does not match ${CELESTIA_NAMESPACE} — the kernel
          would publish into one namespace and read another, silently"
  fi
else
  warn "CELESTIA_SKIP_AUTH is set — the DA RPC is unauthenticated and the token path is untested"
fi

# ── the devnet is alive and producing ────────────────────────────────────────
echo
log "celestia: block production"
if ! wait_celestia_rpc 60; then
  fail "the DA RPC is not answering — nothing else can be checked"
  exit 1
fi
if wait_celestia_head_advances 90; then :; else
  fail "the Celestia head is not advancing: the consensus node has stopped producing blocks, or
        the bridge has lost its connection to it"
fi

# ── the bridge wallet can pay ───────────────────────────────────────────────
echo
log "celestia: bridge wallet"
BAL="$(celestia_bridge_balance || true)"
if [[ -n "$BAL" ]] && (( BAL > 0 )); then
  ok "bridge wallet holds ${BAL} utia (it signs and pays for every blob)"
else
  fail "bridge wallet balance is ${BAL:-unreadable} — blob submission will fail at the fee"
fi

# ── the blob round trip ──────────────────────────────────────────────────────
echo
log "celestia: blob round trip"
if (( QUICK )); then
  warn "skipping the blob round trip (--quick)"
else
  NS_B64="$(celestia_namespace_b64 || true)"
  if [[ -z "$NS_B64" ]]; then
    fail "could not compute the base64 namespace (celestia-namespace failed in the container)"
  else
    ok "namespace ${CELESTIA_NAMESPACE} → 29 wire bytes ${NS_B64}"

    # A payload that is unmistakably ours, so reading it back cannot be confused with somebody
    # else's blob at the same height. base64 is done on the host (a plain-ASCII payload, so no
    # binary handling is involved); the namespace expansion is the only part that needed bytes.
    PAYLOAD="midnight-2-offers verify.sh $(date -u +%Y-%m-%dT%H:%M:%SZ) $$"
    PAYLOAD_B64="$(printf '%s' "$PAYLOAD" | base64 | tr -d '\n')"

    SUBMIT_BODY="$(cel_rpc blob.Submit \
      "[[{\"namespace\":\"${NS_B64}\",\"data\":\"${PAYLOAD_B64}\",\"share_version\":0}],{\"gas_price\":${CELESTIA_GAS_PRICE}}]" || true)"
    HEIGHT="$(printf '%s' "$SUBMIT_BODY" | grep -oE '"result"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)"

    if [[ -z "$HEIGHT" ]]; then
      fail "blob.Submit did not return an inclusion height: $(cel_rpc_error "$SUBMIT_BODY")
            ${SUBMIT_BODY:0:300}"
    else
      ok "blob.Submit accepted ${#PAYLOAD} bytes, included at height ${HEIGHT}"

      # Read it back the way the kernel's sync node does: by height, filtered by namespace.
      GOT=""
      DEADLINE=$(( SECONDS + 60 ))
      while (( SECONDS < DEADLINE )); do
        GOT="$(cel_rpc blob.GetAll "[${HEIGHT},[\"${NS_B64}\"]]" || true)"
        [[ "$GOT" == *"$PAYLOAD_B64"* ]] && break
        sleep 2
      done
      if [[ "$GOT" == *"$PAYLOAD_B64"* ]]; then
        ok "blob.GetAll(${HEIGHT}, [namespace]) returned the same bytes back"
      else
        fail "blob.GetAll(${HEIGHT}, [namespace]) did not return the submitted blob:
              $(cel_rpc_error "$GOT") ${GOT:0:300}"
      fi

      # Namespace isolation. `0000000000000000dead` differs from the configured namespace in its
      # id bytes only, so this also proves the expansion is not collapsing distinct namespaces.
      OTHER_NS_B64="$(dc exec -T -e CELESTIA_NAMESPACE=0000000000000000dead \
        celestia celestia-namespace --base64 2>/dev/null | tr -d '\r\n' || true)"
      if [[ -z "$OTHER_NS_B64" || "$OTHER_NS_B64" == "$NS_B64" ]]; then
        warn "could not build a second, different namespace — isolation not checked"
      else
        OTHER="$(cel_rpc blob.GetAll "[${HEIGHT},[\"${OTHER_NS_B64}\"]]" || true)"
        if [[ "$OTHER" == *"$PAYLOAD_B64"* ]]; then
          fail "the blob is visible in a DIFFERENT namespace at height ${HEIGHT} — namespace
                filtering is not working, and MIP-0006 relies on it entirely"
        else
          ok "the blob is NOT visible in a different namespace at the same height"
        fi
      fi
    fi
  fi
fi

# ── auth is actually enforced ────────────────────────────────────────────────
if (( AUTH_REQUIRED )); then
  echo
  log "celestia: auth enforcement"
  # No Authorization header at all. An accepted call would mean the token is decoration and the
  # DA RPC is open to anything that can reach the port.
  #
  # The rejection is a JSON-RPC error at HTTP 200, NOT a 401 — celestia-node answers
  # `{"error":{"code":1,"message":"missing permission to invoke 'NetworkHead' (need 'read')"}}`.
  # So the body is what must be asserted; a check on the status code alone would read "open" as
  # "rejected", which is the wrong way round for a security assertion to fail.
  UNAUTH="$(curl -sS --max-time 15 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"header.NetworkHead","params":[]}' \
    "$CELESTIA_DA_URL" 2>/dev/null || true)"
  if [[ "$UNAUTH" == *'"error"'* && "$UNAUTH" != *'"result"'* ]]; then
    ok "an unauthenticated call is rejected: $(cel_rpc_error "$UNAUTH")"
  else
    fail "an unauthenticated header.NetworkHead was ACCEPTED — the DA RPC is open even though
          CELESTIA_SKIP_AUTH is false: ${UNAUTH:0:200}"
  fi
fi

echo
if (( FAILURES == 0 )); then
  ok "verify-celestia.sh: all checks passed"
  exit 0
fi
err "verify-celestia.sh: ${FAILURES} check(s) failed"
exit 1
