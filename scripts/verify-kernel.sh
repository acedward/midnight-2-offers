#!/usr/bin/env bash
#
# Assertions for the `offerfiles` profile's kernel + batcher — the `kernel` section of
# ./verify.sh.
#
#   ./scripts/verify-kernel.sh
#
# What it proves, and why each one is here rather than being assumed:
#
#   health         GET /v1/health answers 200. The kernel's bring-up still does real chain
#                  work (first Celestia sync, schema init) before the API answers.
#   config         GET /v1/midnight/config answers the FOUR network fields a browser wallet
#                  needs — and carries NO contract address. That absence is the assertion
#                  now: kernel PRs #69/#70 deleted the offer-files contract, upstream's own
#                  api.test.ts asserts `body.contractAddress === undefined`, and a stack
#                  that answered one would be running a pre-#69 image against this compose.
#   local tokens   the six local test-token names are in `known_tokens` with their REAL
#                  decimals, and `GET /v1/quote` PRICES the twBTC->twETH pair. Together these
#                  are the end-to-end proof of the whole token path at this pin: the faucet
#                  issued the colours, `registry-bridge` wrote them onto the kernel's seeded
#                  rows (which is what preserves those rows' asset_id), and the resolver
#                  therefore finds an asset behind a colour that did not exist an hour ago.
#                  SKIPPED, not failed, when the `faucet` profile is not in the stack.
#   offers API     GET /v1/offers answers 200 with a JSON body. Empty is fine (fresh chain);
#                  an error here means the PGLite/STM half is down even though health is up.
#   prices         GET /v1/prices answers 200 with the SEEDED asset table. New at the
#                  ledger-v9 pin, and it is the assertion that makes a stale Postgres
#                  volume fail loudly: 000-init.sql is applied only on an empty database,
#                  so a volume from before this pin has no asset_prices and every quote
#                  and sponsorship verdict silently degrades. `./down.sh -v` is the fix.
#   zk assets      the ZK asset routes answer — the browser prover fetches keys from here, and
#                  midnight-js 5's FetchZkConfigProvider verifies them against the compiler's
#                  integrity manifest, so these routes are load-bearing for the frontend.
#   batcher        the batcher port accepts an HTTP request. It exposes no health route, so the
#                  assertion is "an HTTP server answers", not a status code.
#
# Everything runs over the PUBLISHED HOST PORT, deliberately — same rule as verify-celestia.sh:
# that is the endpoint a human or the frontend actually uses, and an in-container check cannot
# see a loopback-bound listener.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env
BIND="${HOST_ADDR:-127.0.0.1}"
KPORT="${KERNEL_HOST_PORT:-9999}"
BPORT="${BATCHER_HOST_PORT:-3334}"
API="http://${BIND}:${KPORT}"

FAILURES=0
check() { # <label> <cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    err "$label"
    FAILURES=$(( FAILURES + 1 ))
  fi
}

# health — 200 means deploy + mint + first sync all happened.
check "kernel /v1/health answers" \
  curl -fsS --max-time 10 "$API/v1/health"

# ── /v1/midnight/config: the four fields, and NO contract address ────────────
#
# THE ABSENCE IS THE ASSERTION. Until KERNEL_REF 5d794f9 this block demanded a
# non-empty `contractAddress` and treated its absence as a failed deploy. Kernel
# PRs #69/#70 deleted the offer-files contract; the route now answers exactly
# `indexerUri`, `indexerWsUri`, `proofServerUri` and `networkId`, and upstream's
# `packages/node/api.test.ts` pins that with
# `expect(body.contractAddress).toBeUndefined()`. So a `contractAddress` here
# would mean a pre-#69 kernel image is running against this compose — a real
# misconfiguration, and one nothing else in the stack would notice, because every
# consumer of that address is gone too.
if cfg=$(curl -fsS --max-time 10 "$API/v1/midnight/config" 2>/dev/null); then
  if printf '%s' "$cfg" | grep -q '"indexerUri"'; then
    ok "/v1/midnight/config answers the network endpoints"
  else
    err "/v1/midnight/config answered but carries no indexerUri: $(printf '%s' "$cfg" | head -c 200)"
    FAILURES=$(( FAILURES + 1 ))
  fi
  if printf '%s' "$cfg" | grep -q '"contractAddress"'; then
    err "/v1/midnight/config carries a contractAddress — this kernel PREDATES the contract removal"
    info "  KERNEL_REF must be 5d794f9a27f6d65529bf176650405f740531d430 or later."
    info "  A stale image is the usual cause: ./up.sh --build (and ./down.sh -v for the volumes)."
    FAILURES=$(( FAILURES + 1 ))
  else
    ok "/v1/midnight/config carries no contract address (the kernel line is contract-free)"
  fi
else
  err "/v1/midnight/config did not answer"
  FAILURES=$(( FAILURES + 1 ))
fi

# offers API — the PGLite/STM half.
check "kernel /v1/offers answers JSON" \
  bash -c "curl -fsS --max-time 10 '$API/v1/offers' | head -c 1 | grep -qE '[{[]'"

# ── the token price service (kernel PRs #54-#56, new at the ledger-v9 pin) ────
# THIS IS THE SCHEMA ASSERTION, and it is the loud failure the BREAKING note in
# the README promises. `000-init.sql` creates and SEEDS `asset_prices` /
# `known_tokens`, and the kernel applies that file only on an EMPTY database —
# so a Postgres volume created before this pin comes up looking perfectly
# healthy while `/v1/prices` returns nothing, `/v1/quote` cannot price a leg,
# the batcher's sponsorship gate treats every offer as unpriced and the offer
# poster cannot size a want leg. None of that is visible from /v1/health.
#
# NIGHT is asked for because it is the one colour that is the same everywhere:
# 32 zero bytes on every network, seeded in `known_tokens` with the `midnight-3`
# asset. Every LOCAL colour is derived from an issuer contract deployed minutes
# ago and so cannot be written down here — the block after this one reads them
# out of the live registry instead. `tokens=` is REQUIRED by the route — there is
# no unfiltered form.
NIGHT_COLOR='0000000000000000000000000000000000000000000000000000000000000000'
if prices=$(curl -fsS --max-time 10 "$API/v1/prices?tokens=${NIGHT_COLOR}" 2>/dev/null); then
  if printf '%s' "$prices" | grep -q '"midnight-3"'; then
    ok "kernel /v1/prices answers and the seeded asset table is present"
  else
    err "/v1/prices answered but priced nothing — the seeded schema is missing"
    info "  This is almost always a Postgres volume that PREDATES the ledger-v9 kernel"
    info "  pin: 000-init.sql (which creates and seeds asset_prices/known_tokens) is"
    info "  applied only on an EMPTY database. Fix: ./down.sh -v && ./up.sh …"
    info "  answer was: $(printf '%s' "$prices" | head -c 200)"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "/v1/prices did not answer 200 — the token price service is not serving"
  info "  A pre-ledger-v9 Postgres volume is the usual cause: ./down.sh -v && ./up.sh …"
  FAILURES=$(( FAILURES + 1 ))
fi

# ── the six LOCAL tokens, and a real quote over them ─────────────────────────
#
# CONDITIONAL: only when the `faucet` profile is in this stack. It is a hard
# SKIP, not a soft pass — `./up.sh --with offerfiles` alone is legal and then
# there is simply nothing local to name. The discriminator is the same one
# `verify.sh` uses everywhere: does a container with that compose service label
# exist.
#
# WHY IT LIVES HERE AND NOT IN verify-faucet.sh. `verify-faucet.sh` already
# asserts the six names and decimals against the registry the SITE serves — that
# is the faucet's own claim about itself. What this block asserts is the KERNEL's
# side of the same fact, and one thing more that only the kernel can answer:
# that a colour minted on this chain an hour ago RESOLVES TO AN ASSET and can be
# quoted. That is the end state of project question Q6, and it is worth its own
# assertion because every part of it is silent when it breaks — an unpriced leg
# is a 200 with a null, not an error.
if docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
              --filter "label=com.docker.compose.service=faucet-deploy" 2>/dev/null | grep -q .; then
  TOKENS_JSON="$(curl -fsS --max-time 10 "$API/v1/known-tokens" 2>/dev/null || true)"
  if [[ -z "$TOKENS_JSON" ]]; then
    err "/v1/known-tokens did not answer — the faucet profile is up but the kernel names nothing"
    FAILURES=$(( FAILURES + 1 ))
  else
    # name -> expected decimals, from the mint-test-tokens registry. These are
    # CANONICAL scales, not this repo's choice: BTC 8, ETH 18, stables 6.
    #
    # PARSED, NOT GREPPED — and the first version of this block WAS grepped, which
    # is how the bug below was found. It split the response with `tr '}' '}\n'`
    # and matched `"name":"TWBTC".*"decimals":8` on the result. `tr` CANNOT expand
    # one character into two: SET2 is truncated to SET1's length, so that call
    # replaced `}` with `}` and changed nothing. The whole array stayed on ONE
    # line, every regex then matched ACROSS object boundaries, and this assertion
    # passed while proving nothing — any TWBTC anywhere followed by any
    # `"decimals":8` anywhere satisfied it. The colour extraction below used the
    # same idiom and failed loudly (it read NIGHT's 64 zeros for both legs, and
    # `/v1/quote` refused the two equal token ids), which is what exposed it.
    # python3 is already required by verify-poster.sh and verify-prices.sh.
    KERNEL_TOKENS="$(printf '%s' "$TOKENS_JSON" | python3 -c '
import json, sys
want = {"TWBTC": 8, "TWETH": 18, "TWUSDC": 6, "TWUSDM": 6, "UTWUSDC": 6, "UTWBTC": 8}
try:
    doc = json.load(sys.stdin)
except Exception as exc:
    print("PARSE\t" + str(exc))
    raise SystemExit(0)
rows = doc.get("tokens") if isinstance(doc, dict) else doc
by_name = {}
for row in rows or []:
    by_name[str(row.get("name", "")).upper()] = row
missing = []
for name in sorted(want):
    row = by_name.get(name)
    if row is None:
        missing.append(name + "/absent")
    elif row.get("decimals") != want[name]:
        missing.append("{}/decimals={} (want {})".format(name, row.get("decimals"), want[name]))
print("MISSING\t" + ", ".join(missing))
for name in ("TWBTC", "TWETH"):
    row = by_name.get(name) or {}
    print("COLOUR\t{}\t{}".format(
        name, str(row.get("token_color") or row.get("color") or row.get("tokenColor") or "")))
' 2>/dev/null)"
    if printf '%s' "$KERNEL_TOKENS" | grep -q '^PARSE'; then
      err "/v1/known-tokens did not parse as JSON: $(printf '%s' "$KERNEL_TOKENS" | sed -n 's/^PARSE.//p')"
      FAILURES=$(( FAILURES + 1 ))
      MISSING="unparsable"
    else
      MISSING="$(printf '%s' "$KERNEL_TOKENS" | sed -n 's/^MISSING.//p')"
      if [[ -z "$MISSING" ]]; then
        ok "kernel names all six local tokens with their real decimals (8/18/6/6/6/8)"
      else
        err "kernel registry is missing or misnaming: ${MISSING}"
        info "  registry-bridge is what writes these. Check: docker compose … logs registry-bridge"
        FAILURES=$(( FAILURES + 1 ))
      fi
    fi

    # THE QUOTE. twBTC -> twETH deliberately: an 8-decimal token against an
    # 18-decimal one, which is the pair where a wrong `decimals` is off by 10^10
    # and where the old "6 everywhere" assumption used to hide.
    GIVE="$(printf '%s' "$KERNEL_TOKENS" | awk -F'\t' '$1=="COLOUR" && $2=="TWBTC" { print $3; exit }')"
    WANT="$(printf '%s' "$KERNEL_TOKENS" | awk -F'\t' '$1=="COLOUR" && $2=="TWETH" { print $3; exit }')"
    if [[ ! "$GIVE" =~ ^[0-9a-f]{64}$ ]] || [[ ! "$WANT" =~ ^[0-9a-f]{64}$ ]]; then
      err "could not read the TWBTC/TWETH colours out of /v1/known-tokens (give='${GIVE}' want='${WANT}')"
      FAILURES=$(( FAILURES + 1 ))
    else
      QUOTE_URL="$API/v1/quote?from_token=${GIVE}&to_token=${WANT}&from_amount=100000000"
      if quote=$(curl -fsS --max-time 15 "$QUOTE_URL" 2>/dev/null); then
        # `source` IS THE ASSERTION, not the amount. This route NEVER fails on an
        # unpriced colour: `/v1/quote` serves a "demo fallback" of $1 per token
        # for anything it cannot price, loudly logged but answered 200 with a
        # perfectly positive `suggested_to_amount`. So a numeric check here would
        # pass on exactly the state project question Q6 is about — six local
        # colours resolving to no asset. `"source":"token-prices"` is the field
        # that distinguishes a real reference price from that fallback, and
        # `sponsored` is what the batcher's fee gate actually reads.
        if printf '%s' "$quote" | grep -q '"source"[[:space:]]*:[[:space:]]*"token-prices"' \
           && printf '%s' "$quote" | grep -qE '"suggested_to_amount"[[:space:]]*:[[:space:]]*"[1-9]'; then
          ok "kernel /v1/quote prices 1 twBTC -> twETH from the SEEDED assets (source=token-prices)"
          info "  $(printf '%s' "$quote" | head -c 300)"
          if printf '%s' "$quote" | grep -q '"sponsored"[[:space:]]*:[[:space:]]*true'; then
            ok "the quoted leg is sponsorable"
          else
            err "the quoted leg is NOT sponsorable — the batcher would refuse to pay its blob fee"
            FAILURES=$(( FAILURES + 1 ))
          fi
        else
          err "/v1/quote fell back to the \$1 demo price — the local colours resolve to no asset"
          info "  This is project question Q6's failure mode, and it is SILENT without this check."
          info "  registry-bridge must UPDATE the kernel's SEEDED rows (which carry asset_id)"
          info "  rather than insert new ones — which is why it upper-cases the registry symbol"
          info "  to the kernel's own spelling. PRICE_FEED_MAP in compose/offerfiles.yml is the"
          info "  fallback for a database that predates those seeds."
          info "  Answer was: $(printf '%s' "$quote" | head -c 300)"
          FAILURES=$(( FAILURES + 1 ))
        fi
      else
        err "/v1/quote did not answer 200 for the local twBTC->twETH pair"
        FAILURES=$(( FAILURES + 1 ))
      fi
    fi
  fi
else
  info "faucet profile not in this stack — skipping the local-token and quote assertions"
fi

# zk assets — one existing route is enough to prove the router is mounted; the
# exact key set is the contract build's concern, not this script's.
check "kernel serves ZK assets (/keys or /zkir route mounted)" \
  bash -c "curl -s --max-time 10 -o /dev/null -w '%{http_code}' '$API/keys/' | grep -qvE '^(000|5..)$'"

# batcher — an HTTP answer on the published port (no health route exists).
check "batcher answers HTTP on :${BPORT}" \
  bash -c "curl -s --max-time 10 -o /dev/null -w '%{http_code}' 'http://${BIND}:${BPORT}/' | grep -qvE '^000$'"

if (( FAILURES == 0 )); then
  ok "kernel assertions passed"
  exit 0
fi
err "${FAILURES} kernel assertion(s) failed"
exit 1
