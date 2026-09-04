#!/bin/bash
# register-tokens — give this stack's three demo colours their NAMES, once the
# kernel is healthy. ONE-SHOT, NON-FATAL.
#
# WHY IT EXISTS (00010 P1.4; kernel issues/00008). Two problems meet here:
#
#   1. `mint-test-tokens.ts`, which the deploy one-shot runs, tries to register
#      names itself and CANNOT succeed on this stack: it POSTs to
#      `/api/known-tokens` — a path the node has never served, the route is
#      `POST /v1/known-tokens` — and it posts to 127.0.0.1:9999, which inside
#      the deploy container is that container's own loopback while the kernel
#      does not exist yet (`kernel` waits on this one-shot completing). Both
#      failures are swallowed by a try/catch that only logs.
#   2. Until now the ONLY thing that named wBTC/wETH/wUSD was the AA console,
#      which runs under the `aa` profile. `./up.sh --with offerfiles` alone left
#      every colour unnamed, so the kernel priced both legs of every offer as
#      "no asset behind this colour" and the batcher's sponsorship gate had
#      nothing to work with. Names are not cosmetic since the token price
#      service (kernel PRs #54-#56): `known_tokens.name` is what
#      `DEFAULT_NAME_ASSET_MAP` prices WBTC as bitcoin and WETH as ethereum by.
#
# THE COLOURS ARE DERIVED, NEVER CONFIGURED. `mint_shielded(domain_sep, …)`
# mints `rawTokenType(domain_sep, contractAddress)`, so a colour is a property
# of THIS deployment and changes on every fresh stack — there is nothing to
# write down. The domain separator comes from `docs/src/wallet/mintable.ts`
# inside the pinned kernel tree (`domainSepFromName`), which is the zswap-da
# faucet's own function, so this stack, the SPA faucet, the offer poster and the
# AA console all land on ONE colour per name (00010 Q11).
#
# NON-FATAL, like the mint step it follows: the stack trades without names, and
# a cosmetic-plus-pricing step must not block the kernel, batcher or solver.
# Every outcome is logged with its HTTP status — a 409 is reported, not hidden.
set -euo pipefail

. /usr/local/lib/offerfiles/entrypoint-common.sh

ROLE=register-tokens

if [ "${REGISTER_TOKENS_ENABLED:-true}" != "true" ]; then
  log "$ROLE" "REGISTER_TOKENS_ENABLED=${REGISTER_TOKENS_ENABLED:-} — not registering token names"
  exit 0
fi

: "${ZSWAP_API:?ZSWAP_API is required (the kernel API base, e.g. http://kernel:9999)}"

load_contract_address "$ROLE"

# `kernel` is a service_healthy dependency, so it is already answering; this
# only covers the gap between the healthcheck passing and this container's first
# packet, and it fails loudly instead of posting into a void.
for _try in $(seq 1 60); do
  if bun -e 'const r = await fetch(process.env.ZSWAP_API + "/v1/health"); process.exit(r.ok ? 0 : 1)' 2>/dev/null; then
    break
  fi
  sleep 2
done

log "$ROLE" "registering demo token names with ${ZSWAP_API}/v1/known-tokens"

cd /app
# One `bun -e`: the image has no curl, and the derivation must come from the
# kernel's own module rather than a re-implementation that could drift.
REGISTER_CONTRACT_ADDRESS="$MIDNIGHT_CONTRACT_ADDRESS" bun -e '
import { rawTokenType } from "@midnightntwrk/ledger-v9";
import { domainSepFromName } from "/app/docs/src/wallet/mintable.ts";

const api = process.env.ZSWAP_API;
const addr = String(process.env.REGISTER_CONTRACT_ADDRESS).replace(/^0x/, "").toLowerCase();

// The demo set. `name` is what the registry stores (it upper-cases anyway);
// `kind` must match how the colour is minted. decimals is STATED: every token
// this stack mints is whole coins x 10^6 (kernel 00024), and the column default
// would be right today but silent about it.
const WANTED = [
  { name: "WBTC", kind: "shielded" },
  { name: "WETH", kind: "shielded" },
  { name: "WUSD", kind: "unshielded" },
];

let registered = 0, already = 0, failed = 0;
for (const { name, kind } of WANTED) {
  const color = rawTokenType(domainSepFromName(name), addr).toLowerCase();
  let response;
  try {
    response = await fetch(`${api}/v1/known-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color, name, kind, decimals: 6 }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(`[register-tokens] ${name} ${color.slice(0, 16)}…: request failed — ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
    continue;
  }
  const body = (await response.text()).slice(0, 200);
  if (response.ok) {
    console.error(`[register-tokens] ${name} = ${color} registered (${response.status})`);
    registered += 1;
  } else if (response.status === 409) {
    console.error(`[register-tokens] ${name} = ${color} already registered (409) ${body}`);
    already += 1;
  } else if (response.status === 404) {
    console.error(`[register-tokens] ${name}: registry disabled (404) — set ENABLE_TOKEN_REGISTRY=true on the kernel`);
    failed += 1;
  } else {
    console.error(`[register-tokens] ${name} ${color.slice(0, 16)}…: HTTP ${response.status} ${body}`);
    failed += 1;
  }
}
console.error(`[register-tokens] done: ${registered} registered, ${already} already present, ${failed} failed`);
' || log "$ROLE" "WARNING: registration exited non-zero — continuing (non-fatal)"

log "$ROLE" "done"
