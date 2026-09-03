#!/usr/bin/env bash
#
# Assertions for the `shielded-night` profile — the `shielded-night` section of ./verify.sh.
#
#   ./scripts/verify-shielded-night.sh
#
# THE QUESTION THIS SCRIPT EXISTS TO ANSWER is not "does nginx serve a page". It is: IS THE
# THING THIS STACK IS SERVING THE CONTRACT THIS STACK DEPLOYED, and does that contract actually
# work? Those are six separate claims, and each is checked where it can fail:
#
#   serves      GET / answers an HTML document (nginx up, dist/ present).
#   config.js   GET /config.js is 200 and carries EXACTLY the address on the deploy volume —
#               not a stale one, not the baked-in preview one, not an empty string. It is
#               written at container start, so a 404 means the entrypoint never ran; and
#               index.html must load it as a CLASSIC script or it cannot run before the bundle.
#   zk assets   all 11 circuits' keys/<c>.prover, keys/<c>.verifier and zkir/<c>.bzkir answer
#               with non-empty BYTES, and a circuit that does not exist answers 404 — because
#               midnight-js's FetchZkConfigProvider only checks `response.ok`, so an SPA
#               fallback would hand the prover an HTML document as a proving key.
#   manifest    compiler/contract-manifest.json is served, and is a manifest for THIS
#               toolchain. On the 2.x line midnight-js 5 verifies every artifact it fetches
#               against that file with integrity checking defaulting to `require` — fail
#               closed. A page that serves 33 perfect keys and no manifest connects a wallet
#               and then refuses to prove anything.
#   on-chain    the DEPLOYED contract's verifier keys are byte-identical to those served ones,
#               11 of 11, none missing and none extra (upstream's own verify-deployment.ts,
#               run inside the compose network against this stack's indexer).
#   round trip  a funded wallet distinct from the deployer completes NIGHT -> sNight -> NIGHT
#               both ways the contract offers — atomic (one transaction each) and two-step —
#               with EXACT balance assertions.
#
# The last two run inside a container from the same image the contract was deployed from
# (`docker compose run --rm shielded-night-verify`), so this script needs no bun, no node and
# no dependency a clean macOS box does not already have: curl, grep and sed.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

require_docker
load_env
# `dc` passes exactly the fragments named in PROFILES, and compose calls any container it has
# no definition for an ORPHAN — so naming only this profile would print "Found orphan
# containers (…)" on every exec as soon as a second profile is up. Nothing is started here.
use_all_profiles

BIND="${HOST_ADDR:-127.0.0.1}"
SNPORT="${SHIELDED_NIGHT_HOST_PORT:-10900}"
BASE="http://${BIND}:${SNPORT}"
ARTIFACTS="${BASE}/contract/compiled/shielded-night"

# The 11 circuits of the ShieldedNight contract. Written out rather than discovered, because
# "the page serves some keys" and "the page serves THIS contract" are different claims and only
# the second one is worth checking. The image asserts the same count on its own compiled
# output, from the other side.
CIRCUITS="convertToShielded convertToUnshielded decimals depositShielded depositUnshielded \
getBalance name symbol tokenColor withdrawShielded withdrawUnshielded"

# The toolchain this repository pins for this profile. The served manifest must name it: a
# manifest from another compiler would mean the page is serving artifacts this stack did not
# build, and midnight-js would then verify them against the wrong expectations.
COMPACT_VERSION_EXPECTED="${SHIELDED_NIGHT_COMPACT_VERSION:-0.34.0}"

FAILURES=0
fail() { err "$*"; FAILURES=$(( FAILURES + 1 )); }

log "shielded-night: endpoints"
info "page      ${BASE}"
info "artifacts ${ARTIFACTS}/"

# ── the static surface ───────────────────────────────────────────────────────
echo
log "shielded-night: the page"

HTML="$(curl -fsS --max-time 10 "$BASE/" 2>/dev/null || true)"
if [[ "$HTML" == *"<html"* || "$HTML" == *"<!doctype"* || "$HTML" == *"<!DOCTYPE"* ]]; then
  ok "serves an HTML document on :${SNPORT}"
else
  fail "did not serve HTML on :${SNPORT}"
fi

CONFIG_JS=""
if CONFIG_JS="$(curl -fsS --max-time 10 "$BASE/config.js" 2>/dev/null)"; then
  # 200 IS NOT ENOUGH. Upstream ships a no-op `public/config.js` placeholder so that every
  # deployment serves a real script rather than a 404 the browser refuses to execute — and
  # that placeholder is in dist/. What proves this container learned an address is the marker
  # its ENTRYPOINT writes, so that is what is matched.
  case "$CONFIG_JS" in
    *'entrypoint-web.sh'*)
      ok "serves the GENERATED /config.js (written at container start, not the shipped placeholder)"
      ;;
    *)
      fail "/config.js is the upstream placeholder — the web entrypoint never wrote this stack's address"
      ;;
  esac
else
  CONFIG_JS=""
  fail "/config.js is missing — the web entrypoint did not run, or it never saw a contract"
fi

# WHAT MAKES config.js RUN FIRST IS THAT IT IS A *CLASSIC* SCRIPT, not where it sits in the
# document — and asserting document order here would be both wrong and red. Vite hoists the
# bundle's `<script type="module">` into <head> while the `<script src="/config.js">` tag stays
# in <body>, so the module tag comes FIRST in the served HTML. A module script is deferred by
# specification: it executes after the document is parsed, therefore after every classic script.
# A `type="module"` on the config tag is what would actually break this — the override would
# then be a second deferred script racing the bundle — so that is what is checked.
CFG_TAG="$(printf '%s' "$HTML" | grep -o '<script[^>]*src="/config\.js"[^>]*>' | head -1 || true)"
if [[ -z "$CFG_TAG" ]]; then
  fail "index.html does not reference /config.js — the runtime address override is dead"
elif [[ "$HTML" != *'<script type="module"'* ]]; then
  fail "index.html loads no module bundle — the served page is not the built SPA"
elif [[ "$CFG_TAG" == *'type="module"'* ]]; then
  fail "the /config.js tag is a MODULE script (${CFG_TAG}); it would be deferred alongside the bundle instead of running before it"
else
  ok "index.html loads /config.js as a classic script, so it runs before the deferred bundle"
fi

# THE PREPROD NETWORK, BAKED AT BUILD TIME. Unlike UNDEPLOYED_ADDRESS (runtime-injected via
# /config.js, checked above), PREVIEW_ADDRESS and PREPROD_ADDRESS come from the pinned tree's
# own committed `frontend/.env` and are inlined into the module bundle by Vite at build time —
# there is no container-side lane to check them through. Since ledger-v9 @ 36caf599… (project
# 00007 phase F2) merged shielded-night main's PR #11, that file carries a real PreProd address,
# so the page this profile serves now offers Preview / PreProd / Local (undeployed) in its
# network dropdown, not just the first and third. This is a consequence of the re-pin, not new
# code here — the assertion exists so a future re-pin that silently drops PREPROD_ADDRESS (or
# points it at the wrong contract) fails loudly instead of shipping a broken menu entry.
BUNDLE_SRC="$(printf '%s' "$HTML" | grep -o '<script type="module"[^>]*src="[^"]*"' | grep -o '/assets/[^"]*\.js' | head -1 || true)"
if [[ -z "$BUNDLE_SRC" ]]; then
  fail "index.html has no module bundle <script src>; cannot check the baked PreProd address"
else
  BUNDLE_JS="$(curl -fsS --max-time 20 "${BASE}${BUNDLE_SRC}" 2>/dev/null || true)"
  case "$BUNDLE_JS" in
    *'e354e6725893397e6a2dfa44522a017fabb5d9c92efed50288711f5f865c8950'*)
      ok "the served bundle carries the baked PreProd address e354e672… (network dropdown offers PreProd)"
      ;;
    *)
      fail "the served bundle (${BUNDLE_SRC}) does not carry the PreProd contract address — the network dropdown would be missing PreProd"
      ;;
  esac
fi

# ── the address, from the volume, compared EXACTLY ───────────────────────────
echo
log "shielded-night: the contract this stack deployed"

# Read the deploy volume through the web container, which mounts it read-only. `|| true` on
# both halves: an exec failure must be reported by the assertion below rather than killing the
# script through errexit, and a non-matching grep is a normal answer here.
CONTRACT_JSON="$(dc exec -T shielded-night cat /srv/shielded-night/contract.json 2>/dev/null || true)"
ADDRESS="$(printf '%s' "$CONTRACT_JSON" \
  | grep -o '"address"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed -e 's/.*:[[:space:]]*"//' -e 's/"$//' || true)"

if [[ -z "$ADDRESS" ]]; then
  fail "no contract address on the shielded-night-deploy volume — the one-shot published nothing"
else
  ok "deploy volume carries contract ${ADDRESS:0:16}…"
  # EXACT, not a prefix: a stale /config.js from a previous chain would share no bytes with
  # this one, but a truncated comparison is how a "close enough" check passes on the wrong
  # contract. `case`, not `printf … | grep -Fq …`: a match makes grep close the pipe, the
  # producer dies of SIGPIPE and the pipeline reports failure under `pipefail`.
  case "$CONFIG_JS" in
    *"UNDEPLOYED_ADDRESS: \"${ADDRESS}\""*)
      ok "/config.js injects exactly this stack's address"
      ;;
    *)
      fail "/config.js does not carry the deployed address ${ADDRESS}"
      printf '%s\n' "$CONFIG_JS" | sed 's/^/      /' >&2
      ;;
  esac
  # The deploy record is this profile's identity document; the fields the docs promise must
  # actually be in it.
  for field in networkId symbol decimals deployerSeedRole commit; do
    case "$CONTRACT_JSON" in
      *"\"${field}\""*) ;;
      *) fail "contract.json carries no \"${field}\"" ;;
    esac
  done
  case "$CONTRACT_JSON" in
    *'"networkId": "undeployed"'*) ok "contract.json records networkId=undeployed" ;;
    *) fail "contract.json does not record networkId=undeployed" ;;
  esac
fi

# ── the ZK artifact lane ─────────────────────────────────────────────────────
#
# THREE FETCHES PER CIRCUIT, which is exactly what FetchZkConfigProvider makes. Each must be a
# 200 with a non-empty body that is NOT text/html: the provider checks only `response.ok`, so
# an SPA fallback would be accepted and the failure would surface deep inside proving.
echo
log "shielded-night: ZK artifacts for all 11 circuits"

ASSET_OK=0
ASSET_BAD=0
BODY="$(mktemp)"
HEADERS="$(mktemp)"
trap 'rm -f "$BODY" "$HEADERS"' EXIT

for circuit in $CIRCUITS; do
  for asset in "keys/${circuit}.prover" "keys/${circuit}.verifier" "zkir/${circuit}.bzkir"; do
    url="${ARTIFACTS}/${asset}"
    if ! curl -fsS -o "$BODY" -D "$HEADERS" --max-time 60 "$url" >/dev/null 2>&1; then
      fail "GET ${asset} did not answer 2xx — the browser prover cannot fetch this circuit"
      ASSET_BAD=$(( ASSET_BAD + 1 ))
      continue
    fi
    ctype="$(grep -i '^content-type:' "$HEADERS" | head -1 | tr -d '\r' | tr '[:upper:]' '[:lower:]' || true)"
    case "$ctype" in
      *text/html*)
        fail "GET ${asset} answered text/html — that is the SPA fallback, not a ZK artifact"
        ASSET_BAD=$(( ASSET_BAD + 1 ))
        continue
        ;;
    esac
    if [[ ! -s "$BODY" ]]; then
      fail "GET ${asset} answered an EMPTY body"
      ASSET_BAD=$(( ASSET_BAD + 1 ))
      continue
    fi
    ASSET_OK=$(( ASSET_OK + 1 ))
  done
done

if (( ASSET_BAD == 0 )); then
  ok "${ASSET_OK}/33 artifacts served as non-empty binary (11 circuits x prover/verifier/bzkir)"
else
  err "${ASSET_BAD} of $(( ASSET_OK + ASSET_BAD )) artifact fetches failed"
fi

# THE 34th FILE, and on this line it is the one that makes the other 33 usable.
#
# midnight-js 5's FetchZkConfigProvider verifies every artifact it fetches against compactc's
# `compiler/contract-manifest.json`, with integrity checking defaulting to `require` — fail
# closed. compactc only started emitting that file at 0.33, so on the 1.x sibling stack it does
# not exist and nothing looks for it; here, a page serving 33 perfect keys and no manifest
# connects a wallet and then refuses to prove anything, with an error that names none of this.
#
# The manifest's own version fields are checked too: a manifest from a different compiler would
# mean the served artifacts are not the ones this repository pinned and rebuilt.
echo
log "shielded-night: the ZK integrity manifest (midnight-js 5 verifies against it, fail-closed)"
MANIFEST="$(curl -fsS --max-time 30 "${ARTIFACTS}/compiler/contract-manifest.json" 2>/dev/null || true)"
if [[ -z "$MANIFEST" ]]; then
  fail "compiler/contract-manifest.json is not served — the browser's ZK config provider fails closed without it"
else
  ok "serves compiler/contract-manifest.json"
  case "$MANIFEST" in
    *"\"compiler-version\": \"${COMPACT_VERSION_EXPECTED}\""*)
      ok "the manifest names compactc ${COMPACT_VERSION_EXPECTED}, the toolchain this profile pins"
      ;;
    *)
      fail "the served manifest does not name compactc ${COMPACT_VERSION_EXPECTED}"
      printf '%s\n' "$MANIFEST" | head -6 | sed 's/^/      /' >&2
      ;;
  esac
  # Every circuit must appear in it, or the provider would reject the key it just fetched.
  MANIFEST_MISSING=0
  for circuit in $CIRCUITS; do
    case "$MANIFEST" in
      *"${circuit}.verifier"*) ;;
      *) fail "the manifest does not cover ${circuit}"; MANIFEST_MISSING=$(( MANIFEST_MISSING + 1 )) ;;
    esac
  done
  (( MANIFEST_MISSING == 0 )) && ok "the manifest covers all 11 circuits"
fi

# THE NEGATIVE CONTROL, and it is the whole point of `try_files … =404` in nginx.conf. Without
# it this URL answers 200 with the app shell and every check above would still pass while the
# prover was being handed HTML.
BOGUS_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  "${ARTIFACTS}/keys/thisCircuitDoesNotExist.prover" 2>/dev/null || true)"
if [[ "$BOGUS_CODE" == "404" ]]; then
  ok "a missing artifact answers 404, not the SPA fallback"
else
  fail "a missing artifact answered HTTP ${BOGUS_CODE:-none}; it must be 404, never the app shell"
fi

# ── the on-chain verifier keys ───────────────────────────────────────────────
#
# `docker compose run --rm`, not an exec into a running container: the verify service exists
# precisely so this runs in a container with the pinned tree, its node_modules and the compiled
# keys, INSIDE the compose network, and then goes away. `--profile` is passed because the
# service is profile-gated so `up.sh` never starts it.
echo
log "shielded-night: on-chain verifier keys == served keys"
if dc --profile shielded-night-verify run --rm -T shielded-night-verify keys; then
  ok "11/11 circuits verified on chain against the served keys"
else
  fail "the on-chain verifier keys do not match the served ones (see the output above)"
fi

# ── the round trip ───────────────────────────────────────────────────────────
#
# The UPSTREAM integration suite, run against THIS stack (MN_EXTERNAL_STACK=1) with a driver
# wallet distinct from the deployer. Both selected tests assert EXACT balances: wrapped == N,
# and final NIGHT == starting NIGHT.
#
# It is a REQUIRED check, not an optional one — a profile that serves a page for a contract
# nobody has ever transacted with is not verified. The driver wallet is funded at bring-up by
# the `shielded-night-fund` one-shot; if it were not, this container fails and so does this
# section, loudly.
#
# IT IS SLOW ON THIS LINE. The same two round trips that take ~280 s against the 1.x triple
# were measured at 487–537 s in the ledger-v9 branch's own CI, which is why the branch raised
# its integration timeout from 60 to 150 minutes. Budget minutes, not seconds.
echo
log "shielded-night: NIGHT <-> sNight round trips (atomic and two-step)"
info "driver wallet is SHIELDED_NIGHT_DRIVER_SEED (distinct from the deployer, spec FR-011)"
info "expect 8-12 minutes: proving on the 2.x line runs 1.25-1.6x slower than on 1.x"
if dc --profile shielded-night-verify run --rm -T shielded-night-verify roundtrip; then
  ok "both round trips completed with exact balance assertions"
else
  fail "a NIGHT <-> sNight round trip failed (see the output above)"
fi

echo
if (( FAILURES == 0 )); then
  ok "shielded-night assertions passed"
  exit 0
fi
err "${FAILURES} shielded-night assertion(s) failed"
exit 1
