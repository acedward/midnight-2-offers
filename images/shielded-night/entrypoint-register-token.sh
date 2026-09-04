#!/usr/bin/env bash
# shielded-night-register — teach the offer-files kernel THIS stack's sNight colour.
#
# WHY IT EXISTS (infra issue 00012). The kernel's schema seeds a `SNIGHT` row in
# `known_tokens`, and the colour it seeds is **preview's**. sNight's colour is not a constant:
# the contract mints `tokenType(pad(32,"shielded-night:wrapper"), self())`, so it derives from
# the contract ADDRESS, and this stack deploys its own contract on every `./down.sh -v`. Without
# this one-shot the registry names a colour this stack can never hold, while the colour it CAN
# hold has no name: the swap SPA and the solver monitor show short hex, and the poster and the
# quote endpoint cannot price it.
#
# WHY IT WRITES SQL FOR ONE CASE (questions Q29). The kernel serves exactly two routes for that
# table, `GET /v1/known-tokens` and `POST /v1/known-tokens`. There is no PUT, PATCH or DELETE,
# and the POST answers 409 `Token name "SNIGHT" is already taken` — which for SNIGHT is always,
# because the migration seeded it. The kernel's own `000-init.sql` names the remedy in the
# comment above that seed: "patch that one by hand, with
#   UPDATE known_tokens SET token_color = '<colour>' WHERE name = 'SNIGHT';
# or POST /v1/known-tokens". So: the API is used wherever it can do the job, and exactly one
# UPDATE covers the case it cannot express. The result is re-read THROUGH THE API, never
# trusted from the write.
#
# WHY IT IS CONDITIONAL. A profile in this repo IS a compose fragment filename, so
# `depends_on: kernel` cannot be written here — the kernel service does not exist when
# `compose/offerfiles.yml` is not in the file set, and naming it would break every
# `--with shielded-night` stack (the same constraint that ruled out option B in Q20). The
# discriminator is DNS: a hostname that does not resolve means the profile is not in this
# stack, so this one-shot logs one line and exits 0. A hostname that resolves while the kernel
# is still starting is a RACE, and that is waited out.
#
# IDEMPOTENT. The registry itself is the state: a SNIGHT row already carrying this colour is
# success, not an error. Nothing here is written to the shared volume.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=shielded-night-register
# shellcheck source=images/shielded-night/entrypoint-common.sh
. /usr/local/lib/shielded-night/entrypoint-common.sh

require_env ZSWAP_API DB_HOST DB_PORT DB_NAME DB_USER DB_PW

SNIGHT_NAME="${SNIGHT_TOKEN_NAME:-SNIGHT}"
SNIGHT_DECIMALS="${SHIELDED_NIGHT_DECIMALS:-6}"
# NIGHT's own asset: sNight is locked 1:1, so one sNight base unit is one Star and the two rows
# must price identically or an equal-base-unit NIGHT <-> sNight offer stops being at par under
# the batcher's sponsorship gate. This is the seed's own reasoning, kept.
SNIGHT_ASSET="${SNIGHT_ASSET_ID:-midnight-3}"
KERNEL_WAIT_S="${KERNEL_WAIT_TIMEOUT_S:-300}"

[ -f "${CONTRACT_FILE}" ] \
  || die "no ${CONTRACT_FILE} — shielded-night-deploy must complete first"

ADDRESS="$(published_address)" || die "could not read the contract address"
log "contract ${ADDRESS}"

# ── is the offer-files profile even in this stack? ───────────────────────────
KERNEL_HOST="$(printf '%s' "${ZSWAP_API}" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
if ! ZS_HOST="${KERNEL_HOST}" bun -e '
      const dns = await import("node:dns/promises");
      try { await dns.lookup(process.env.ZS_HOST); } catch { process.exit(1); }
    ' >/dev/null 2>&1; then
  log "SKIP: '${KERNEL_HOST}' does not resolve — the offerfiles profile is not in this stack"
  log "      (bring it up with ./up.sh --with offerfiles --with shielded-night to register sNight)"
  exit 0
fi

wait_http "${ZSWAP_API}/v1/health" "offer-files kernel" "${KERNEL_WAIT_S}" \
  || die "kernel ${ZSWAP_API} never answered — it resolves, so it is starting or broken"

# ── the colour, derived offline ──────────────────────────────────────────────
# rawTokenType(domainSep, contract) mirrors the contract's own
# tokenType(pad(32,"shielded-night:wrapper"), self()) — the same derivation the dApp's
# frontend/src/lib/tokens.ts uses to find its balance.
COLOUR="$(SN_ADDRESS="${ADDRESS}" bun -e '
    const { rawTokenType } = await import("@midnightntwrk/ledger-v9");
    const domain = new Uint8Array(32);
    domain.set(new TextEncoder().encode("shielded-night:wrapper"));
    const raw = rawTokenType(domain, process.env.SN_ADDRESS.replace(/^0x/, ""));
    if (typeof raw !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw)) {
      console.error(`rawTokenType returned an unusable value: ${raw}`);
      process.exit(1);
    }
    process.stdout.write(raw.toLowerCase());
  ')" || die "could not derive the sNight colour from ${ADDRESS}"
log "sNight colour ${COLOUR}"

# ── what does the registry hold right now? ───────────────────────────────────
# "absent" | "match" | "<some other colour>"
current_state() {
  ZS_API="${ZSWAP_API}" SN_NAME="${SNIGHT_NAME}" SN_COLOUR="${COLOUR}" bun -e '
    const res = await fetch(`${process.env.ZS_API}/v1/known-tokens`);
    if (!res.ok) { console.error(`GET /v1/known-tokens -> ${res.status}`); process.exit(1); }
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.tokens ?? body.knownTokens ?? []);
    const want = process.env.SN_NAME.toUpperCase();
    const row = rows.find((t) => String(t.name ?? "").toUpperCase() === want);
    if (!row) { process.stdout.write("absent"); process.exit(0); }
    const colour = String(row.color ?? row.token_color ?? "").toLowerCase().replace(/^0x/, "");
    process.stdout.write(colour === process.env.SN_COLOUR ? "match" : (colour || "unreadable"));
  '
}

STATE="$(current_state)" || die "could not read ${ZSWAP_API}/v1/known-tokens"

if [ "${STATE}" = "match" ]; then
  log "OK: ${SNIGHT_NAME} already names ${COLOUR} — nothing to do"
  exit 0
fi

if [ "${STATE}" = "absent" ]; then
  log "no ${SNIGHT_NAME} row — registering through POST /v1/known-tokens"
  ZS_API="${ZSWAP_API}" SN_NAME="${SNIGHT_NAME}" SN_COLOUR="${COLOUR}" \
  SN_DECIMALS="${SNIGHT_DECIMALS}" SN_ASSET="${SNIGHT_ASSET}" bun -e '
      const res = await fetch(`${process.env.ZS_API}/v1/known-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          color: process.env.SN_COLOUR,
          name: process.env.SN_NAME,
          kind: "shielded",
          decimals: Number(process.env.SN_DECIMALS),
          asset_id: process.env.SN_ASSET,
        }),
      });
      const text = await res.text();
      if (!res.ok) { console.error(`POST -> ${res.status} ${text}`); process.exit(1); }
      console.error(`POST -> ${res.status} ${text}`);
    ' || die "POST /v1/known-tokens failed"
else
  # The one case the API cannot express (Q29). One row, one column, matched by NAME.
  log "${SNIGHT_NAME} currently names ${STATE} (the schema's seeded PREVIEW colour, or a"
  log "  previous deployment's) — the kernel has no update route, so: UPDATE ... WHERE name"
  PGPASSWORD_VALUE="${DB_PW}" SN_NAME="${SNIGHT_NAME}" SN_COLOUR="${COLOUR}" \
  SN_DECIMALS="${SNIGHT_DECIMALS}" SN_ASSET="${SNIGHT_ASSET}" \
  DB_URL="postgres://${DB_USER}:${DB_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}" bun -e '
      const { SQL } = await import("bun");
      const sql = new SQL(process.env.DB_URL);
      const rows = await sql`
        UPDATE known_tokens
           SET token_color = ${process.env.SN_COLOUR},
               kind        = ${"shielded"},
               decimals    = ${Number(process.env.SN_DECIMALS)},
               asset_id    = ${process.env.SN_ASSET}
         WHERE name = ${process.env.SN_NAME.toUpperCase()}
        RETURNING token_color`;
      if (rows.length !== 1) {
        console.error(`expected to update exactly one row, updated ${rows.length}`);
        process.exit(1);
      }
      console.error(`UPDATE known_tokens -> ${rows[0].token_color}`);
      await sql.end();
    ' || die "could not update the ${SNIGHT_NAME} row"
fi

# ── prove it through the API, not through our own write ──────────────────────
FINAL="$(current_state)" || die "could not re-read ${ZSWAP_API}/v1/known-tokens"
[ "${FINAL}" = "match" ] \
  || die "${SNIGHT_NAME} still names '${FINAL}' after the write, expected ${COLOUR}"

log "OK: ${SNIGHT_NAME} = ${COLOUR} (decimals ${SNIGHT_DECIMALS}, asset ${SNIGHT_ASSET})"
exit 0
