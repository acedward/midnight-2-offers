#!/usr/bin/env bash
# registry-bridge — teach the offer-files kernel THIS stack's six local test-token colours.
#
# WHY IT EXISTS. Since kernel PR #69/#70 the kernel imports a CANONICAL token registry from
# mint-test-tokens (TOKEN_REGISTRY_BASE_URL / TOKEN_REGISTRY_NETWORK ∈ preview|preprod|stagenet|
# undeployed) — and on `undeployed` that import is SKIPPED BY DESIGN, because a local chain has
# no public canonical registry. So on this stack the kernel seeds the six canonical PREPROD
# rows (or, at the current pin, nothing of ours at all) while the colours this chain can
# actually hold have no name: the swap SPA and the solver monitor show short hex, and the quote
# endpoint cannot price them. This one-shot closes exactly that gap, from the registry file the
# local deploy published.
#
# It is the same shape as images/shielded-night/entrypoint-register-token.sh, deliberately —
# same conditionality, same retry, same "prove it through the API, never from our own write" —
# because it is the same problem for six rows instead of one.
#
# WHY IT WRITES SQL FOR ONE CASE. The kernel serves exactly two routes for `known_tokens`:
# `GET /v1/known-tokens` and `POST /v1/known-tokens`. There is no PUT, PATCH or DELETE. The
# POST's insert is `ON CONFLICT (token_color) DO NOTHING`, and `name` is UNIQUE — so a row whose
# NAME already exists carrying a DIFFERENT colour answers 409 `Token name "…" is already taken`
# and cannot be corrected through the API at all. That happens on a stack whose postgres volume
# outlived its chain (`./down.sh` without `-v`, then a wipe of the registry volume alone), and
# it is precisely the case the kernel's own 000-init.sql names the remedy for:
#   UPDATE known_tokens SET token_color = '<colour>' WHERE name = '<NAME>';
# So the API is used wherever it can do the job, and exactly one UPDATE covers the case it
# cannot express. The result is always re-read THROUGH THE API, never trusted from the write.
#
# WHY IT IS CONDITIONAL, AND WHY THE DISCRIMINATOR IS ITSELF WAITED OUT. A profile in this
# repository IS a compose fragment filename, so `depends_on: kernel` cannot be written here —
# the kernel service does not exist when compose/offerfiles.yml is out of the file set, and
# naming it would break every `./up.sh --with faucet` stack. The discriminator is DNS. But a
# name that does not resolve YET is not the same as a profile that is absent: measured in
# project 00015 P7, the sNight one-shot ran 79 s before the kernel container started, declared
# "the profile is not in this stack" and exited 0 — and up.sh then reported an all-clear over a
# registry it had never touched. A silent skip is worse than a failure. So an unresolvable name
# is waited on, bounded and jittered, and only then taken to mean "absent".
#
# WHY EVERY KERNEL STEP IS RETRIED (infra issue 00016). `GET /v1/health` is a LIVENESS probe,
# not a schema-readiness one: the kernel answers health while 000-init.sql is still being
# applied, and the first `GET /v1/known-tokens` can come back 500 with postgres logging
# `relation "known_tokens" does not exist`. One 500 must not fail a six-minute bring-up over a
# token name, so every step runs through retry_ready, which treats a 5xx or a refused
# connection as "not ready yet" and ANY 4xx as a definitive answer that must not be retried.
# The jitter is the load-bearing half: several one-shots poll the same starting kernel and a
# fixed schedule just re-collides.
#
# IDEMPOTENT. The kernel's registry is the state: six rows already carrying these colours is
# success, not an error. Nothing here writes to the shared volume.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=registry-bridge
# shellcheck source=images/mint-test-tokens/entrypoint-common.sh
. /usr/local/lib/mint-test-tokens/entrypoint-common.sh

require_env ZSWAP_API DB_HOST DB_PORT DB_NAME DB_USER DB_PW

KERNEL_WAIT_S="${KERNEL_WAIT_TIMEOUT_S:-300}"
KERNEL_DNS_WAIT_S="${FAUCET_KERNEL_DNS_WAIT_S:-300}"

# The retry budget: 8 attempts, 2s doubling to a 15s cap, plus up to 3s of jitter — about 85s
# of tolerance in the worst case. The race it covers is sub-second, so the budget is generous
# on purpose: it is only ever spent when something is genuinely wrong, and it still ends in a
# failure rather than in a warning.
READY_TRIES="${FAUCET_BRIDGE_TRIES:-8}"
READY_RETRY_S="${FAUCET_BRIDGE_RETRY_S:-2}"
READY_RETRY_MAX_S="${FAUCET_BRIDGE_RETRY_MAX_S:-15}"
READY_JITTER_S="${FAUCET_BRIDGE_JITTER_S:-3}"

# EX_TEMPFAIL is "the kernel or its database is not ready yet" (5xx, refused connection, a row
# the schema has not seeded). Any OTHER non-zero exit is a definitive answer and is deliberately
# not retried — a 4xx means the request was wrong, and eight attempts at a wrong request only
# delay the report by a minute.
EX_TEMPFAIL=75
RETRY_ERR="${TMPDIR:-/tmp}/registry-bridge.last-error"

# retry_ready <label> <cmd...> — run <cmd> until it succeeds or the budget runs out. The
# command's STDOUT passes through untouched, so `$(retry_ready … current_state)` still reads
# the state; its STDERR is captured, echoed once on success and printed IN FULL on give-up.
retry_ready() {
  local label="$1"; shift
  local try=1 rc=0 delay
  while :; do
    : >"${RETRY_ERR}"
    # `rc=$?` after an `if` is NOT the condition's status — an `if` with no branch taken is
    # itself a zero-status command — so the code is captured on the || side, where it is real.
    rc=0
    "$@" 2>"${RETRY_ERR}" || rc=$?
    if [ "${rc}" -eq 0 ]; then
      if [ "${try}" -gt 1 ]; then log "${label}: ready on attempt ${try}/${READY_TRIES}"; fi
      if [ -s "${RETRY_ERR}" ]; then cat "${RETRY_ERR}" >&2; fi
      return 0
    fi
    if [ "${rc}" -ne "${EX_TEMPFAIL}" ]; then
      log "${label}: definitive failure (exit ${rc}) — not retried"
      if [ -s "${RETRY_ERR}" ]; then cat "${RETRY_ERR}" >&2; fi
      return "${rc}"
    fi
    if [ "${try}" -ge "${READY_TRIES}" ]; then
      log "${label}: still not ready after ${try} attempts — last response:"
      if [ -s "${RETRY_ERR}" ]; then cat "${RETRY_ERR}" >&2; fi
      return "${rc}"
    fi
    delay=$(( READY_RETRY_S * (1 << (try - 1)) ))
    if [ "${delay}" -gt "${READY_RETRY_MAX_S}" ]; then delay="${READY_RETRY_MAX_S}"; fi
    delay=$(( delay + RANDOM % (READY_JITTER_S + 1) ))
    log "${label}: not ready yet (attempt ${try}/${READY_TRIES}: $(tr '\n' ' ' <"${RETRY_ERR}" | cut -c1-160)) — retrying in ${delay}s"
    sleep "${delay}"
    try=$(( try + 1 ))
  done
}

[ -f "${REGISTRY_FILE}" ] \
  || die "no ${REGISTRY_FILE} — faucet-deploy must complete first"

# ── the six rows, read from the registry by path ─────────────────────────────
#
# One line per token: "<SYMBOL> <colour> <kind> <decimals>". The registry is validated first —
# a file that is not `ready`, or whose active deployment is missing, must not become six rows
# nobody can trace back to a contract.
read_rows() {
  REG_FILE="${REGISTRY_FILE}" node -e '
    const fs = await import("node:fs/promises");
    const doc = JSON.parse(await fs.readFile(process.env.REG_FILE, "utf8"));
    if (doc.status !== "ready") { console.error(`registry is ${doc.status}, not ready`); process.exit(1); }
    const out = [];
    for (const token of doc.tokens ?? []) {
      const active = (token.deployments ?? []).find(
        (d) => d.deploymentId === token.activeDeploymentId && d.status === "active");
      if (!active) { console.error(`${token.symbol}: no active deployment`); process.exit(1); }
      const colour = String(active.tokenId ?? "").toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(colour)) {
        console.error(`${token.symbol}: tokenId is not a 64-hex colour: ${active.tokenId}`);
        process.exit(1);
      }
      if (token.privacy !== "shielded" && token.privacy !== "unshielded") {
        console.error(`${token.symbol}: unknown privacy ${token.privacy}`); process.exit(1);
      }
      if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 38) {
        console.error(`${token.symbol}: decimals out of range: ${token.decimals}`); process.exit(1);
      }
      // The kernel s known_tokens.name is UNIQUE and is what the SPA, the solver monitor and
      // price-map.ts key on. The registry symbol is used verbatim.
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(token.symbol)) {
        console.error(`${token.symbol}: symbol is not a usable registry name`); process.exit(1);
      }
      out.push(`${token.symbol} ${colour} ${token.privacy} ${token.decimals}`);
    }
    if (out.length !== 6) { console.error(`expected 6 tokens, read ${out.length}`); process.exit(1); }
    process.stdout.write(out.join("\n"));
  '
}

ROWS="$(read_rows)" || die "could not read the six tokens out of ${REGISTRY_FILE}"
log "registry ${REGISTRY_FILE}:"
while IFS=' ' read -r sym colour kind dec; do
  log "  ${sym} ${colour:0:16}… ${kind} decimals=${dec}"
done <<< "${ROWS}"

# ── is the offer-files profile even in this stack? ───────────────────────────
KERNEL_HOST="$(printf '%s' "${ZSWAP_API}" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"

kernel_resolves() {
  ZS_HOST="${KERNEL_HOST}" node -e '
      const dns = await import("node:dns/promises");
      try { await dns.lookup(process.env.ZS_HOST); } catch { process.exit(1); }
    ' >/dev/null 2>&1
}

WAITED=0
until kernel_resolves; do
  if [ "${WAITED}" -eq 0 ]; then
    log "'${KERNEL_HOST}' does not resolve yet — waiting up to ${KERNEL_DNS_WAIT_S}s in case the"
    log "  offerfiles profile IS in this stack and its kernel container has not started"
  fi
  if [ "${WAITED}" -ge "${KERNEL_DNS_WAIT_S}" ]; then
    log "SKIP: '${KERNEL_HOST}' never resolved in ${WAITED}s — the offerfiles profile is not in this stack"
    log "      (bring it up with ./up.sh --with faucet --with offerfiles to name the six tokens)"
    exit 0
  fi
  # Jittered, like every other wait here: several one-shots wake on the same events.
  STEP=$(( 3 + RANDOM % 3 ))
  sleep "${STEP}"
  WAITED=$(( WAITED + STEP ))
done
if [ "${WAITED}" -gt 0 ]; then
  log "'${KERNEL_HOST}' resolved after ${WAITED}s — the offerfiles profile IS in this stack"
fi

wait_http "${ZSWAP_API}/v1/health" "offer-files kernel" "${KERNEL_WAIT_S}" \
  || die "kernel ${ZSWAP_API} never answered — it resolves, so it is starting or broken"

# ── what does the kernel registry hold for one name right now? ───────────────
# "absent" | "match" | "<some other colour>" | "unreadable"
current_state() { # <name> <colour>
  ZS_API="${ZSWAP_API}" TK_NAME="$1" TK_COLOUR="$2" node -e '
    const res = await fetch(`${process.env.ZS_API}/v1/known-tokens`).catch((e) => {
      // Nothing listening / connection refused: the kernel is starting, not broken.
      console.error(`GET /v1/known-tokens -> ${e}`);
      process.exit(75);
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`GET /v1/known-tokens -> ${res.status} ${body}`);
      // 5xx while 000-init.sql is still being applied is the race issue 00016 records.
      process.exit(res.status >= 500 ? 75 : 1);
    }
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.tokens ?? body.knownTokens ?? []);
    const want = process.env.TK_NAME.toUpperCase();
    const row = rows.find((t) => String(t.name ?? "").toUpperCase() === want);
    if (!row) { process.stdout.write("absent"); process.exit(0); }
    const colour = String(row.color ?? row.token_color ?? "").toLowerCase().replace(/^0x/, "");
    process.stdout.write(colour === process.env.TK_COLOUR ? "match" : (colour || "unreadable"));
  '
}

# post_token — register a MISSING row through the API.
#
# NO asset_id. `known_tokens.asset_id` REFERENCES asset_prices(asset_id), and these six local
# test tokens have no asset behind them: a value that is not already a priced asset would fail
# the foreign key, and a wrong one would price twBTC as something it is not. NULL is the state
# the kernel's resolver handles explicitly — priced BY NAME through price-map.ts — which is what
# a test token registered at runtime is meant to be.
post_token() { # <name> <colour> <kind> <decimals>
  ZS_API="${ZSWAP_API}" TK_NAME="$1" TK_COLOUR="$2" TK_KIND="$3" TK_DECIMALS="$4" node -e '
      const res = await fetch(`${process.env.ZS_API}/v1/known-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          color: process.env.TK_COLOUR,
          name: process.env.TK_NAME,
          kind: process.env.TK_KIND,
          decimals: Number(process.env.TK_DECIMALS),
        }),
      }).catch((e) => {
        console.error(`POST /v1/known-tokens -> ${e}`);
        process.exit(75);
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`POST -> ${res.status} ${text}`);
        // A 409 (name taken) is an ANSWER, not a wait: it is reported at once and handled by
        // the UPDATE path below.
        process.exit(res.status >= 500 ? 75 : 1);
      }
      console.error(`POST -> ${res.status} ${text}`);
    '
}

# update_token — the one case the API cannot express: one row, one colour, BY NAME.
#
# psql with `-v` bindings and `:'name'` quoting, so nothing is spliced into SQL by string
# concatenation. ON_ERROR_STOP makes a failed statement a non-zero exit rather than a warning.
update_token() { # <name> <colour> <kind> <decimals>
  local name="$1" colour="$2" kind="$3" dec="$4" out rc=0
  out="$(PGPASSWORD="${DB_PW}" psql \
      --host "${DB_HOST}" --port "${DB_PORT}" --username "${DB_USER}" --dbname "${DB_NAME}" \
      --no-password --quiet --tuples-only --no-align \
      --set=ON_ERROR_STOP=1 \
      --set=tk_name="${name}" --set=tk_colour="${colour}" \
      --set=tk_kind="${kind}" --set=tk_decimals="${dec}" \
      --command "UPDATE known_tokens
                    SET token_color = :'tk_colour',
                        kind        = :'tk_kind',
                        decimals    = :'tk_decimals'::integer
                  WHERE name = :'tk_name'
              RETURNING token_color;" 2>&1)" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    # A missing relation or a refused connection is the same schema-init race the retry covers.
    printf '%s\n' "UPDATE known_tokens (${name}) -> ${out}" >&2
    return "${EX_TEMPFAIL}"
  fi
  out="$(printf '%s' "${out}" | tr -d '[:space:]')"
  if [ "${out}" != "${colour}" ]; then
    # No row with that name yet: the POST path should have handled it, so this is a wait, not
    # a defect — the seed insert or a concurrent writer may not have landed.
    printf '%s\n' "UPDATE known_tokens (${name}) returned '${out}', expected ${colour}" >&2
    return "${EX_TEMPFAIL}"
  fi
  printf '%s\n' "UPDATE known_tokens (${name}) -> ${out}" >&2
}

# ── one row at a time, then prove the whole set through the API ──────────────
FAILED=0
REGISTERED=0
UPDATED=0
UNCHANGED=0

while IFS=' ' read -r SYM COLOUR KIND DEC; do
  [ -n "${SYM}" ] || continue
  STATE="$(retry_ready "GET /v1/known-tokens (${SYM})" current_state "${SYM}" "${COLOUR}")" || {
    log "could not read ${ZSWAP_API}/v1/known-tokens for ${SYM}"; FAILED=1; continue; }

  if [ "${STATE}" = "match" ]; then
    log "OK: ${SYM} already names ${COLOUR:0:16}… — nothing to do"
    UNCHANGED=$(( UNCHANGED + 1 ))
    continue
  fi

  if [ "${STATE}" = "absent" ]; then
    log "${SYM}: no row — registering through POST /v1/known-tokens"
    if retry_ready "POST /v1/known-tokens (${SYM})" post_token "${SYM}" "${COLOUR}" "${KIND}" "${DEC}"; then
      REGISTERED=$(( REGISTERED + 1 ))
      continue
    fi
    # A 409 here means the NAME exists with another colour under a different letter case, or a
    # concurrent writer won the race. Fall through to the UPDATE path rather than failing: the
    # end state is what matters and it is re-read below either way.
    log "${SYM}: POST did not register the row — falling back to UPDATE ... WHERE name"
  else
    log "${SYM}: currently names ${STATE} (a previous chain's colour) — the kernel has no update"
    log "  route, so: UPDATE known_tokens ... WHERE name = '${SYM}'"
  fi

  if retry_ready "UPDATE known_tokens (${SYM})" update_token "${SYM}" "${COLOUR}" "${KIND}" "${DEC}"; then
    UPDATED=$(( UPDATED + 1 ))
  else
    log "could not write the ${SYM} row"
    FAILED=1
  fi
done <<< "${ROWS}"

# ── prove it through the API, not through our own writes ─────────────────────
while IFS=' ' read -r SYM COLOUR KIND DEC; do
  [ -n "${SYM}" ] || continue
  FINAL="$(retry_ready "GET /v1/known-tokens (re-read ${SYM})" current_state "${SYM}" "${COLOUR}")" || {
    log "could not re-read ${SYM}"; FAILED=1; continue; }
  if [ "${FINAL}" != "match" ]; then
    log "${SYM} still names '${FINAL}' after the write, expected ${COLOUR}"
    FAILED=1
  fi
done <<< "${ROWS}"

if [ "${FAILED}" -ne 0 ]; then
  die "the kernel token registry does not name all six local tokens"
fi

log "OK: six local tokens in the kernel registry (${REGISTERED} registered, ${UPDATED} updated, ${UNCHANGED} unchanged)"
exit 0
