#!/usr/bin/env bash
#
# Assertions for the `frontend` profile — the `frontend` section of ./verify.sh.
#
#   ./scripts/verify-frontend.sh
#
# What it proves:
#
#   serves      GET / answers 200 with an HTML document (nginx up, dist present).
#   config.js   GET /config.js answers 200 — the runtime-config injection point the image
#               generates at container start; a 404 means the entrypoint did not run.
#   wired       index.html references config.js BEFORE the bundle, so window.API_BASE /
#               window.BATCHER_URL are set when src/config.ts evaluates.
#   ports       config.js carries window.MIDNIGHT_HOST_PORTS with THIS stack's published
#               node/indexer/proof-server ports. GET /v1/midnight/config reports the URIs the
#               KERNEL dials — compose hostnames on container ports — and the SPA's
#               browser-network-urls.patch maps them through this table. A stale or missing
#               table is the difference between a wallet that syncs and one that silently
#               dials :9944 on a stack that published something else.
#   network     config.js carries window.MIDNIGHT_NETWORK_ID. Upstream resolves the network
#               at BUILD time and defaults to preprod; on this stack it must be the chain
#               that is actually running, because it is both the wallet's network id and
#               the `?network=` the Faucet link carries.
#   faucet      config.js carries window.FAUCET_HOST_PORT = this stack's FAUCET_PORT, so the
#               SPA's Faucet link resolves to the local mint-test-tokens site rather than
#               the public one the template defaults to. Asserted whether or not the `faucet`
#               profile is up — the frontend fragment has no way to know, and the link is a
#               property of the image's configuration, not of the faucet's liveness. When
#               `faucet` IS up, the link is followed for real: HEAD the composed URL.
#   wallet      config.js carries window.DEMO_WALLET_SEED. Upstream's connectLocal() generates
#               a RANDOM seed per page load, which since #922 means an in-page wallet that can
#               never acquire anything. A fixed seed is what faucet-mint's `spa` grant funds,
#               so a missing or truncated one is the difference between "the demo can trade"
#               and "the mint went to a wallet nobody is looking at".
#   no contract Since FRONTEND_REF 400880ce (upstream #922) the SPA compiles and deploys
#               nothing: no ZK artifacts are served. A 200 on /keys/ or /zkir/ would mean an
#               image built from a tree that still had the contract lane.
#
# The frontend profile remains standalone by design. When runtime endpoint overrides are present
# (as they are in every pick-ports/CI env), this script asserts their exact injected values;
# kernel reachability itself is covered by verify-kernel.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
FPORT="${FRONTEND_HOST_PORT:-10600}"
BASE="http://${HOST_ADDR}:${FPORT}"

FAILURES=0

html=$(curl -fsS --max-time 10 "$BASE/" 2>/dev/null || true)
if [[ "$html" == *"<html"* || "$html" == *"<!doctype"* || "$html" == *"<!DOCTYPE"* ]]; then
  ok "frontend serves an HTML document on :${FPORT}"
else
  err "frontend did not serve HTML on :${FPORT}"
  FAILURES=$(( FAILURES + 1 ))
fi

if config_js=$(curl -fsS --max-time 10 "$BASE/config.js" 2>/dev/null); then
  ok "frontend serves /config.js (runtime-config injection point)"
else
  config_js=""
  err "/config.js missing — the image entrypoint did not generate it"
  FAILURES=$(( FAILURES + 1 ))
fi

if [[ -n "${FRONTEND_API_BASE:-}" ]]; then
  if printf '%s' "$config_js" | grep -Fq "window.API_BASE = \"${FRONTEND_API_BASE}\";"; then
    ok "config.js injects API_BASE=${FRONTEND_API_BASE}"
  else
    err "config.js does not inject expected FRONTEND_API_BASE=${FRONTEND_API_BASE}"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

if [[ -n "${FRONTEND_BATCHER_URL:-}" ]]; then
  if printf '%s' "$config_js" | grep -Fq "window.BATCHER_URL = \"${FRONTEND_BATCHER_URL}\";"; then
    ok "config.js injects BATCHER_URL=${FRONTEND_BATCHER_URL}"
  else
    err "config.js does not inject expected FRONTEND_BATCHER_URL=${FRONTEND_BATCHER_URL}"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

# The map is emitted with the CONTAINER ports as defaults, so the expectation here is exactly
# what compose renders: the .env value if set, else the container port.
EXPECT_NODE="${NODE_HOST_PORT:-9944}"
EXPECT_INDEXER="${INDEXER_HOST_PORT:-8088}"
EXPECT_PROOF="${PROOF_HOST_PORT:-6300}"
EXPECT_MAP="window.MIDNIGHT_HOST_PORTS = {\"node\":\"${EXPECT_NODE}\",\"indexer\":\"${EXPECT_INDEXER}\",\"proof-server\":\"${EXPECT_PROOF}\"};"
if printf '%s' "$config_js" | grep -Fq "$EXPECT_MAP"; then
  ok "config.js injects MIDNIGHT_HOST_PORTS node=${EXPECT_NODE} indexer=${EXPECT_INDEXER} proof-server=${EXPECT_PROOF}"
else
  err "config.js does not carry this stack's published ports; expected: ${EXPECT_MAP}"
  printf '    served config.js: %s\n' "$config_js" >&2
  FAILURES=$(( FAILURES + 1 ))
fi

if [[ "$html" == *"config.js"* ]]; then
  ok "index.html loads config.js before the bundle"
else
  err "index.html does not reference config.js — runtime API_BASE/BATCHER_URL overrides are dead"
  FAILURES=$(( FAILURES + 1 ))
fi

# The network id. Upstream's build-time default is `preprod`; the entrypoint's is
# `undeployed`, and compose passes FRONTEND_NETWORK_ID. Getting this wrong is not
# cosmetic: it is the wallet's network id AND the faucet site's registry selector.
EXPECT_NETWORK="${FRONTEND_NETWORK_ID:-undeployed}"
if printf '%s' "$config_js" | grep -Fq "window.MIDNIGHT_NETWORK_ID = \"${EXPECT_NETWORK}\";"; then
  ok "config.js injects MIDNIGHT_NETWORK_ID=${EXPECT_NETWORK}"
else
  err "config.js does not carry MIDNIGHT_NETWORK_ID=${EXPECT_NETWORK} — the wallet and the faucet link would use the template's build-time default (preprod)"
  FAILURES=$(( FAILURES + 1 ))
fi

# The faucet link. FRONTEND_FAUCET_URL (a complete URL) wins over the port, so the
# expectation follows the same order src/config.ts uses.
EXPECT_FAUCET_PORT="${FAUCET_PORT:-10950}"
if [[ -n "${FRONTEND_FAUCET_URL:-}" ]]; then
  if printf '%s' "$config_js" | grep -Fq "window.FAUCET_URL = \"${FRONTEND_FAUCET_URL}\";"; then
    ok "config.js injects FAUCET_URL=${FRONTEND_FAUCET_URL}"
  else
    err "config.js does not inject expected FRONTEND_FAUCET_URL=${FRONTEND_FAUCET_URL}"
    FAILURES=$(( FAILURES + 1 ))
  fi
elif printf '%s' "$config_js" | grep -Fq "window.FAUCET_HOST_PORT = \"${EXPECT_FAUCET_PORT}\";"; then
  ok "config.js injects FAUCET_HOST_PORT=${EXPECT_FAUCET_PORT} (the SPA composes http://<page host>:${EXPECT_FAUCET_PORT}/?network=${EXPECT_NETWORK})"
else
  err "config.js does not carry this stack's FAUCET_PORT=${EXPECT_FAUCET_PORT} — the Faucet link would point at the PUBLIC mint-test-tokens site, which knows nothing about this chain's issuers"
  printf '    served config.js: %s\n' "$config_js" >&2
  FAILURES=$(( FAILURES + 1 ))
fi

# …and when the faucet profile is actually up, follow the link. This is the one
# assertion that spans the two profiles, so it is conditional on the faucet
# answering at all rather than on a profile list this script does not read.
FAUCET_TARGET="http://${HOST_ADDR}:${EXPECT_FAUCET_PORT}/?network=${EXPECT_NETWORK}"
if curl -fsS --max-time 5 "http://${HOST_ADDR}:${EXPECT_FAUCET_PORT}/" >/dev/null 2>&1; then
  if curl -fsS --max-time 10 "$FAUCET_TARGET" >/dev/null 2>&1; then
    ok "the Faucet link resolves: ${FAUCET_TARGET} answers 200"
  else
    err "the faucet site is up but ${FAUCET_TARGET} did not answer 200"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  info "faucet profile not up — the Faucet link points at ${FAUCET_TARGET}, which nothing is serving (add --with faucet)"
fi

# The demo wallet's seed. Empty is a legitimate configuration (upstream's random
# wallet), so this asserts the RENDERED value rather than mere presence.
EXPECT_SEED="${FRONTEND_WALLET_SEED-5eedcafe5eedcafe5eedcafe5eedcafe5eedcafe5eedcafe5eedcafe5eedcafe}"
if [[ -z "$EXPECT_SEED" ]]; then
  if printf '%s' "$config_js" | grep -q 'DEMO_WALLET_SEED'; then
    err "FRONTEND_WALLET_SEED is empty but config.js still injects DEMO_WALLET_SEED"
    FAILURES=$(( FAILURES + 1 ))
  else
    ok "no DEMO_WALLET_SEED injected — the in-page wallet is upstream's random one, as configured"
  fi
elif printf '%s' "$config_js" | grep -Fq "window.DEMO_WALLET_SEED = \"${EXPECT_SEED}\";"; then
  ok "config.js injects DEMO_WALLET_SEED ${EXPECT_SEED:0:8}… (the wallet faucet-mint's \`spa\` grant funds)"
else
  err "config.js does not carry the expected DEMO_WALLET_SEED — the in-page wallet would be a random empty one the SPA can never fund"
  FAILURES=$(( FAILURES + 1 ))
fi

# No ZK artifacts: the SPA compiles no contract since #922.
#
# A 200 here proves NOTHING and the first version of this check said it did: the
# nginx config is `try_files $uri $uri/ /index.html`, so EVERY path answers 200
# with the app shell. What discriminates is the CONTENT TYPE. With no `keys/`
# directory the fallback serves `text/html`; with a real one, `$uri/` matches the
# directory, nginx looks for an index file inside it, finds none (autoindex is
# off) and answers **403** — and a request for an artifact file itself would come
# back `application/octet-stream`. So: the response must be HTML.
#
# The authoritative check is the in-image one in scripts/verify-source-pins.sh
# ("the frontend image ships no compactc and no ZK artifacts"), which reads the
# filesystem instead of guessing from a web server. This is the running-stack
# echo of it.
for zk in keys zkir; do
  zk_type="$(curl -fsSI --max-time 5 "$BASE/${zk}/" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1) == "content-type:" { print tolower($2) }' | head -1)"
  case "$zk_type" in
    text/html*)
      ok "/${zk}/ falls through to the app shell (${zk_type}) — no ZK artifacts are served"
      ;;
    '')
      err "/${zk}/ did not answer at all — expected the SPA fallback"
      FAILURES=$(( FAILURES + 1 ))
      ;;
    *)
      err "/${zk}/ is served as '${zk_type}', not the app shell — this image ships ZK artifacts, so it was built from a tree that still had the contract lane"
      FAILURES=$(( FAILURES + 1 ))
      ;;
  esac
done

if (( FAILURES == 0 )); then
  ok "frontend assertions passed"
  exit 0
fi
err "${FAILURES} frontend assertion(s) failed"
exit 1
