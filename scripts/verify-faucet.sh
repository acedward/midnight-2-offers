#!/usr/bin/env bash
#
# Assertions for the `faucet` profile — the `faucet` section of ./verify.sh.
#
#   ./scripts/verify-faucet.sh              the profile as it stands
#   ./scripts/verify-faucet.sh --static     the offline seed-distinctness check only
#   ./scripts/verify-faucet.sh --mint       …plus a REAL mint, proved by a second wallet
#
# THE QUESTION THIS SCRIPT EXISTS TO ANSWER is not "does a page answer 200". It is: ARE THE SIX
# TOKENS THIS SITE OFFERS THE SIX CONTRACTS THIS STACK DEPLOYED, and does anything downstream
# know their names? Those are separate claims, and each is checked where it can fail:
#
#   registry    the published metadata.undeployed.json is `ready`, names the six expected
#               symbols, and each has exactly one ACTIVE deployment with a 64-hex tokenId.
#               Read out of the site's own HTTP surface, not off a volume — because that is
#               where a browser reads it, and a page serving a stale inode would pass a
#               filesystem check and fail a user.
#   identity    the registry's recorded chain/runtime/genesis identity is THIS chain's. A
#               registry that outlived its chain is the failure mode `./down.sh` (without -v)
#               plus a wiped registry volume produces, and every colour in it would be wrong.
#   on-chain    upstream's own read-only verifier, run FRESH inside the compose network: every
#               local verifier key compared with chain state, no missing or extra circuits,
#               immutable metadata checked, each token ID re-derived from its contract address,
#               the artifact tree hashed, the pinned source revision proved, and the original
#               ContractDeploy action re-queried at its recorded height. This is the check —
#               everything above it is cheap corroboration.
#   site        the SPA shell, the registry route, the v2 receiver ZK artifacts as BYTES, and
#               a missing artifact answering 404 rather than the app shell.
#   kernel      ONLY when the `offerfiles` profile is also up: GET /v1/known-tokens names all
#               six symbols with EXACTLY the colours in the registry and their real decimals.
#               A name pointing at a colour nobody on this stack can hold is worse than no name
#               at all, because every display believes it.
#   mint        --mint only: one real mint through upstream's runner, discovered by a SECOND
#               wallet. Opt-in because it is a proof cycle on a cold devnet.
#
# The chain-facing checks run inside a container from the same image the issuers were deployed
# from (`docker compose run --rm`), so this script needs no node and no dependency a clean
# macOS box does not already have: curl, grep, sed, python3.
#
# WHY THERE IS NO BROWSER MINT HERE. The faucet site discovers DApp Connector API 4.x wallets:
# it has NO in-page wallet, delegates proving to whichever wallet is connected, and submits the
# bytes that wallet balanced. A browser with no injected `window.midnight` extension can read
# the registry and see six ready tokens, and cannot mint. See docs/KNOWN-LIMITATIONS.md.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

STATIC_ONLY=0
WITH_MINT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --static) STATIC_ONLY=1; shift ;;
    --mint)   WITH_MINT=1; shift ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

FAILURES=0
fail() { err "$*"; FAILURES=$(( FAILURES + 1 )); }

# The six symbols this profile deploys, written out rather than discovered: "the registry has
# some tokens" and "the registry has THESE tokens" are different claims, and only the second is
# worth checking. The image asserts the same six from the other side, in the pinned source.
EXPECTED_SYMBOLS="twBTC twETH twUSDC twUSDM utwUSDC utwBTC"
# Their canonical decimals. NOT 6 across the board — that was every earlier faucet in this
# repository, and assuming it here would let a bridged twETH be off by 10^12.
declare -a EXPECTED_DECIMALS=(twBTC:8 twETH:18 twUSDC:6 twUSDM:6 utwUSDC:6 utwBTC:8)

# ── --static: the seed distinctness check (offline) ──────────────────────────
#
# WHY THIS IS A CHECK AND NOT A COMMENT. Two wallet facades on one seed against one Midnight
# node force each other's connection down — silently, and in a way that looks like an indexer
# problem. The image entrypoints refuse the three genesis seeds outright, but they can only see
# the environment they were given: a seed that collides with a value spelled in a DIFFERENT
# compose fragment, or in .env.example, never reaches them. This finds that offline, before
# anything is built. Same shape as scripts/verify-poster.sh --static.
static_check() {
  local failures=0 seeds dupes name value
  log "faucet seed distinctness (offline)"

  for name in FAUCET_DEPLOYER_SEED FAUCET_MINT_RECIPIENT_SEED; do
    value="$(grep -hoE "${name}:-[0-9a-f]{64}" "$REPO_ROOT/compose/faucet.yml" | head -1 | sed -E 's/.*:-//')"
    if [[ ! "$value" =~ ^[0-9a-f]{64}$ ]]; then
      err "compose/faucet.yml carries no 64-hex ${name} default"
      failures=$(( failures + 1 ))
      continue
    fi
    info "${name} default ${value:0:8}…${value: -6}"

    # Every OTHER seed-shaped default anywhere in the stack's configuration:
    # `${SOMETHING_SEED:-<hex>}` in a compose fragment, `SOMETHING_SEED=<hex>` in .env.example
    # (commented or not), and every `seed` in wallets/wallets.json.
    seeds="$(
      {
        grep -hoE "[A-Z_]*SEED:-[0-9a-f]{64,128}" "$REPO_ROOT"/compose/*.yml 2>/dev/null \
          | sed -E 's/^([A-Z_]*SEED):-/\1\t/'
        grep -hoE "^[[:space:]]*#?[[:space:]]*[A-Z_]*SEED=[0-9a-f]{64,128}" "$REPO_ROOT/.env.example" 2>/dev/null \
          | sed -E 's/^[[:space:]]*#?[[:space:]]*([A-Z_]*SEED)=/\1\t/'
        python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
for wallet in doc.get("wallets", []):
    print("wallets.json:" + wallet.get("name", "?") + "\t" + wallet.get("seed", ""))
' "$REPO_ROOT/wallets/wallets.json"
      } | sort -u
    )"

    # A seed EQUAL to this one, declared under any other name, is the defect. Its OWN
    # declarations are not collisions: compose/faucet.yml states the deployer default twice
    # (faucet-fund and faucet-mint-test, which must agree), and wallets/wallets.json documents
    # the same wallet.
    local own_wallet
    case "$name" in
      FAUCET_DEPLOYER_SEED)       own_wallet="wallets.json:faucet-deployer" ;;
      FAUCET_MINT_RECIPIENT_SEED) own_wallet="wallets.json:faucet-mint-recipient" ;;
    esac
    dupes="$(printf '%s\n' "$seeds" \
      | awk -F'\t' -v s="$value" -v n="$name" -v w="$own_wallet" '$2 == s && $1 != n && $1 != w { print $1 }')"
    if [[ -n "$dupes" ]]; then
      err "${name} collides with another wallet in this repository:"
      while IFS= read -r where; do [[ -n "$where" ]] && info "  also declared as ${where}"; done <<< "$dupes"
      info "  two facades on one seed against one node force each other's connection down"
      failures=$(( failures + 1 ))
    else
      ok "${name} differs from every other seed in compose/, .env.example and wallets/wallets.json"
    fi
  done

  # The three the entrypoints themselves refuse, named here so a future edit to one of them is
  # caught by this script rather than by an exit 78 on a live stack.
  local forbidden dep
  dep="$(grep -hoE "FAUCET_DEPLOYER_SEED:-[0-9a-f]{64}" "$REPO_ROOT/compose/faucet.yml" | head -1 | sed -E 's/.*:-//')"
  for forbidden in \
    0000000000000000000000000000000000000000000000000000000000000001 \
    0000000000000000000000000000000000000000000000000000000000000002 \
    0000000000000000000000000000000000000000000000000000000000000003; do
    if [[ "$dep" == "$forbidden" ]]; then
      err "FAUCET_DEPLOYER_SEED is a genesis seed the image entrypoints refuse (exit 78)"
      failures=$(( failures + 1 ))
    fi
  done
  (( failures == 0 )) && ok "the faucet profile's seeds are dedicated"

  # The deployer and the recipient must differ — entrypoint-mint-test.sh refuses a run where
  # they are equal, and a mint a wallet makes to itself proves nothing about discoverability.
  local rec
  rec="$(grep -hoE "FAUCET_MINT_RECIPIENT_SEED:-[0-9a-f]{64}" "$REPO_ROOT/compose/faucet.yml" | head -1 | sed -E 's/.*:-//')"
  if [[ -n "$dep" && "$dep" == "$rec" ]]; then
    err "FAUCET_DEPLOYER_SEED and FAUCET_MINT_RECIPIENT_SEED are the same wallet"
    failures=$(( failures + 1 ))
  else
    ok "the mint recipient is a different wallet from the deployer"
  fi

  return $(( failures > 0 ))
}

if (( STATIC_ONLY )); then
  static_check || exit 1
  exit 0
fi

require_docker
load_env
# `dc` passes exactly the fragments named in PROFILES, and compose calls any container it has
# no definition for an ORPHAN — so naming only this profile would print "Found orphan
# containers (…)" on every run as soon as a second profile is up. Nothing is started here.
use_all_profiles

BIND="${HOST_ADDR:-127.0.0.1}"
FPORT="${FAUCET_PORT:-10950}"
BASE="http://${BIND}:${FPORT}"
REGISTRY_URL="${BASE}/metadata.undeployed.json"

static_check || FAILURES=$(( FAILURES + 1 ))

echo
log "faucet: endpoints"
info "site     ${BASE}/?network=undeployed"
info "registry ${REGISTRY_URL}"

# ── the site's static surface ────────────────────────────────────────────────
echo
log "faucet: the page"

if curl -fsS --max-time 10 "${BASE}/" | grep -qi '<html'; then
  ok "GET / serves an HTML document"
else
  fail "GET ${BASE}/ did not serve a page"
fi

# `?network=undeployed` is the URL an operator is told to open. It is the same document (the
# selection is client-side), so this proves the route rather than the selection — but a 404
# here would mean the query string was being routed rather than ignored.
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE}/?network=undeployed" || true)"
if [[ "$CODE" == "200" ]]; then
  ok "GET /?network=undeployed answers 200"
else
  fail "GET /?network=undeployed answered HTTP ${CODE:-none}"
fi

# THE V2 RECEIVER ARTIFACTS, AS BYTES. The browser adapter fetches these to prove a contract
# mint; `serve-static.mjs` answers a missing path THAT HAS AN EXTENSION as a real 404 rather
# than with the SPA shell, so an HTML body here would be handed to a prover as a ZK artifact.
for artifact in \
  contract/v2/receiver/zkir/receiveShieldedTokenFromIssuer.bzkir \
  contract/v2/receiver/zkir/receiveUnshieldedTokenFromIssuer.zkir ; do
  BODY="$(curl -fsS --max-time 20 "${BASE}/${artifact}" 2>/dev/null | head -c 4096 || true)"
  if [[ -n "$BODY" ]] && ! printf '%s' "$BODY" | grep -qi '<html'; then
    ok "${artifact} answers with bytes"
  else
    fail "${artifact} is not served as bytes (empty, or the SPA shell)"
  fi
done

BOGUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "${BASE}/contract/v2/receiver/zkir/thisCircuitDoesNotExist.bzkir" || true)"
if [[ "$BOGUS" == "404" ]]; then
  ok "a missing artifact answers 404, not the SPA fallback"
else
  fail "a missing artifact answered HTTP ${BOGUS:-none}; it must be 404, never the app shell"
fi

# ── the published registry, read the way a browser reads it ──────────────────
echo
log "faucet: the published registry"

REG_JSON="$(curl -fsS --max-time 20 "${REGISTRY_URL}" 2>/dev/null || true)"
if [[ -z "$REG_JSON" ]]; then
  fail "GET ${REGISTRY_URL} returned nothing — the site is not serving this stack's registry"
else
  REG_SUMMARY="$(printf '%s' "$REG_JSON" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
rows = []
for token in doc.get("tokens", []):
    active = next((d for d in token.get("deployments", [])
                   if d.get("deploymentId") == token.get("activeDeploymentId")
                   and d.get("status") == "active"), None)
    rows.append("{} {} {} {}".format(
        token.get("symbol", "?"),
        (active or {}).get("tokenId", "-"),
        token.get("privacy", "?"),
        token.get("decimals", "?")))
print(doc.get("status", "?"))
print(doc.get("network", {}).get("chainId", "?"))
print(doc.get("network", {}).get("stackIdentity", "?"))
print("\n".join(rows))
' 2>/dev/null || true)"

  if [[ -z "$REG_SUMMARY" ]]; then
    fail "the served registry is not parseable JSON"
  else
    REG_STATUS="$(printf '%s\n' "$REG_SUMMARY" | sed -n 1p)"
    REG_CHAIN="$(printf '%s\n' "$REG_SUMMARY" | sed -n 2p)"
    REG_STACK="$(printf '%s\n' "$REG_SUMMARY" | sed -n 3p)"
    REG_ROWS="$(printf '%s\n' "$REG_SUMMARY" | tail -n +4)"

    if [[ "$REG_STATUS" == "ready" ]]; then
      ok "registry status is ready"
    else
      fail "registry status is '${REG_STATUS}', expected 'ready'"
    fi
    info "chain ${REG_CHAIN} · stack identity ${REG_STACK:0:16}…"

    N_ACTIVE="$(printf '%s\n' "$REG_ROWS" | awk 'NF && $2 ~ /^[0-9a-f]{64}$/' | wc -l | tr -d ' ')"
    if [[ "$N_ACTIVE" == "6" ]]; then
      ok "6 tokens with exactly one active deployment each"
    else
      fail "the registry has ${N_ACTIVE} active deployments, expected 6"
    fi

    for sym in $EXPECTED_SYMBOLS; do
      ROW="$(printf '%s\n' "$REG_ROWS" | awk -v s="$sym" '$1 == s')"
      if [[ -z "$ROW" ]]; then
        fail "the registry does not name ${sym}"
        continue
      fi
      COLOUR="$(printf '%s' "$ROW" | awk '{print $2}')"
      DEC="$(printf '%s' "$ROW" | awk '{print $4}')"
      WANT_DEC=""
      for pair in "${EXPECTED_DECIMALS[@]}"; do
        [[ "${pair%%:*}" == "$sym" ]] && WANT_DEC="${pair##*:}"
      done
      if [[ ! "$COLOUR" =~ ^[0-9a-f]{64}$ ]]; then
        fail "${sym}: tokenId is not a 64-hex colour (${COLOUR})"
      elif [[ "$DEC" != "$WANT_DEC" ]]; then
        fail "${sym}: registry says ${DEC} decimals, this profile expects ${WANT_DEC}"
      else
        ok "${sym} ${COLOUR:0:16}… decimals ${DEC}"
      fi
    done
  fi
fi

# ── the deploy one-shot completed, and the site is not serving a corpse ──────
echo
log "faucet: the one-shots"
for svc in faucet-fund faucet-deploy faucet-verify; do
  CID="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=${svc}" 2>/dev/null | head -1)"
  if [[ -z "$CID" ]]; then
    fail "no ${svc} container for project '${COMPOSE_PROJECT_NAME}'"
    continue
  fi
  RC="$(docker inspect -f '{{.State.ExitCode}}' "$CID" 2>/dev/null || echo '?')"
  if [[ "$RC" == "0" ]]; then
    ok "${svc} exited 0"
  else
    fail "${svc} exited ${RC}"
  fi
done

# ── upstream's own read-only verification, run FRESH ─────────────────────────
#
# `docker compose run --rm`, not a replay of the bring-up container's exit code: ./verify.sh is
# a check AT VERIFY TIME, and a one-shot that passed an hour ago says nothing about a chain that
# has moved since. This is the expensive assertion and it is the one that matters — every other
# check in this file is corroboration.
echo
log "faucet: upstream verification against the chain (read-only, no wallet)"
info "expect ~1-2 minutes: it re-queries six deploy actions and re-hashes the artifact trees"
if dc run --rm -T faucet-verify; then
  ok "six issuers verified: on-chain verifier keys, immutable metadata, derived token IDs,"
  info "  artifact digests, pinned source revision, deploy action and block evidence"
else
  fail "upstream's read-only verification failed (see the output above)"
fi

# ── the kernel's token registry (only when offerfiles is up) ─────────────────
#
# On `undeployed` the kernel SKIPS its canonical token-registry import by design, so the six
# local colours have no name unless `registry-bridge` gave them one. This asserts the end state
# through the kernel's own API, never from the bridge's exit code.
echo
KERNEL_PRESENT=0
if [[ -n "$(docker ps -aq \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=kernel" 2>/dev/null)" ]]; then
  KERNEL_PRESENT=1
fi

if (( ! KERNEL_PRESENT )); then
  log "faucet: kernel token registry"
  dim "offerfiles profile not up — the six tokens are not bridged anywhere"
  dim "  (./up.sh --with faucet --with offerfiles names them in the kernel registry)"
elif [[ -z "${REG_ROWS:-}" ]]; then
  log "faucet: kernel token registry"
  fail "cannot check the kernel registry: the served registry could not be read above"
else
  log "faucet: kernel token registry"
  KBASE="http://${BIND}:${KERNEL_HOST_PORT:-9999}"
  KNOWN="$(curl -fsS --max-time 10 "${KBASE}/v1/known-tokens" 2>/dev/null || true)"
  if [[ -z "$KNOWN" ]]; then
    fail "GET ${KBASE}/v1/known-tokens returned nothing"
  else
    while IFS=' ' read -r sym colour privacy dec; do
      [[ -n "$sym" ]] || continue
      MATCH="$(printf '%s' "$KNOWN" | SYM="$sym" COLOUR="$colour" DEC="$dec" PRIV="$privacy" python3 -c '
import json, os, sys
body = json.load(sys.stdin)
rows = body if isinstance(body, list) else (body.get("tokens") or body.get("knownTokens") or [])
want = os.environ["SYM"].upper()
row = next((t for t in rows if str(t.get("name", "")).upper() == want), None)
if row is None:
    print("absent"); sys.exit(0)
colour = str(row.get("color") or row.get("token_color") or "").lower()
if colour.startswith("0x"):
    colour = colour[2:]
if colour != os.environ["COLOUR"]:
    print("colour:" + (colour or "unreadable")); sys.exit(0)
if str(row.get("decimals")) != os.environ["DEC"]:
    print("decimals:" + str(row.get("decimals"))); sys.exit(0)
kind = str(row.get("kind") or "")
if kind and kind != os.environ["PRIV"]:
    print("kind:" + kind); sys.exit(0)
print("match")
' 2>/dev/null || echo 'unreadable')"
      case "$MATCH" in
        match)     ok "${sym} is named in the kernel registry (${colour:0:16}…, decimals ${dec})" ;;
        absent)    fail "${sym} is NOT in the kernel's /v1/known-tokens — registry-bridge did not register it" ;;
        colour:*)  fail "${sym} names colour ${MATCH#colour:} in the kernel, this stack's is ${colour}" ;;
        decimals:*) fail "${sym} carries ${MATCH#decimals:} decimals in the kernel, the registry says ${dec}" ;;
        kind:*)    fail "${sym} is '${MATCH#kind:}' in the kernel, the registry says ${privacy}" ;;
        *)         fail "${sym}: could not read the kernel registry row" ;;
      esac
    done <<< "$REG_ROWS"
  fi
fi

# ── the mint (opt-in) ────────────────────────────────────────────────────────
#
# One token, not six: the claim is that the issuers mint and that another wallet DISCOVERS the
# coin, and six proofs make that claim six times at six times the cost. twUSDC is chosen as a
# shielded token, because the shielded path is the one that needs
# `additionalCoinEncPublicKeyMappings` to be right for a third-party recipient — the unshielded
# path would pass even if that were broken.
if (( WITH_MINT )); then
  echo
  log "faucet: a real mint, discovered by a second wallet"
  info "expect several minutes: this is a proof cycle on a cold 2.x devnet"
  if dc --profile faucet-mint-test run --rm -T -e MN_TOKEN_SYMBOL=twUSDC faucet-mint-test; then
    ok "twUSDC minted and discovered by the recipient wallet"
  else
    fail "the mint test failed (see the output above)"
  fi
else
  echo
  dim "mint not attempted — pass --mint to run one (a proof cycle, minutes)"
  dim "  the faucet SITE cannot be used for this: it discovers DApp-connector wallets only,"
  dim "  and delegates proving to them (docs/KNOWN-LIMITATIONS.md)"
fi

echo
if (( FAILURES == 0 )); then
  ok "faucet: all assertions passed"
  exit 0
fi
err "faucet: ${FAILURES} assertion(s) failed"
exit 1
