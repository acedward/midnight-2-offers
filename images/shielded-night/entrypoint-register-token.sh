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
# AND THE DISCRIMINATOR ITSELF IS A RACE (00015 P7, questions Q5). Compose starts this one-shot
# the moment `shielded-night-deploy` completes, which has nothing to do with when the kernel
# CONTAINER starts: on `./up.sh --with offerfiles --with shielded-night` the kernel waits for
# `offerfiles-deploy` to finish deploying the contract. Measured on this branch: this one-shot
# ran at 01:40:56 and the kernel started at 01:42:15 — **79 s later** — so `kernel` did not
# resolve, the one-shot declared "the profile is not in this stack" and exited 0, and `up.sh`
# printed "sNight is named in the kernel's token registry" over a registry that had never been
# touched. A silent skip is worse than the 500 that issue 00016 records, because nothing fails.
# So a name that does not resolve YET is treated the same way as a kernel that is not answering
# yet: waited for, bounded (SNIGHT_KERNEL_DNS_WAIT_S, default 300 s), and only then taken to
# mean the profile is absent. The wait costs a kernel-less stack nothing that anyone waits on —
# `up.sh` only blocks on this container when `offerfiles` is in the profile list.
#
# IDEMPOTENT. The registry itself is the state: a SNIGHT row already carrying this colour is
# success, not an error. Nothing here is written to the shared volume.
#
# WHY EVERY KERNEL STEP IS RETRIED (infra issue 00016). `GET /v1/health` is a LIVENESS probe,
# and this one-shot used to treat it as a schema-readiness probe. The kernel answers health
# while it is still applying `000-init.sql`, so the very first `GET /v1/known-tokens` came back
# 500 -- postgres logged `relation "known_tokens" does not exist` for that exact statement --
# and one 500 was fatal: `up.sh` counts this one-shot's exit code, so a lost sub-second race
# failed a six-minute `--all` bring-up over a cosmetic token name. `depends_on: kernel` cannot
# express the missing ordering (see WHY IT IS CONDITIONAL above), so the fix is a bounded
# retry: every kernel/database step below runs through `retry_ready`, which treats a 5xx or a
# refused connection as "not ready yet" and any 4xx as a real answer that must NOT be retried.
# The jitter is the load-bearing half, exactly as in the genesis-funding retries (00010 Q20):
# several one-shots poll the same starting kernel, and a fixed schedule just re-collides. On
# give-up the LAST response body is printed, so the failure still names what the kernel said.

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

# The retry budget: 8 attempts, 2s doubling to a 15s cap, plus up to 3s of jitter -- about 85s
# of tolerance in the worst case. The race it covers is sub-second (the measured failure was
# ONE 0.6s burst of "relation does not exist"), so the budget is generous on purpose: it is
# only ever spent when something is genuinely wrong, and it still ends in a failure.
READY_TRIES="${SNIGHT_REGISTER_TRIES:-8}"
READY_RETRY_S="${SNIGHT_REGISTER_RETRY_S:-2}"
READY_RETRY_MAX_S="${SNIGHT_REGISTER_RETRY_MAX_S:-15}"
READY_JITTER_S="${SNIGHT_REGISTER_JITTER_S:-3}"

# EX_TEMPFAIL is the exit code every step below uses for "the kernel or its database is not
# ready yet" (5xx, a refused connection, a row the schema has not seeded). Any OTHER non-zero
# exit is a definitive answer and is deliberately not retried -- a 4xx means the request was
# wrong, and eight attempts at a wrong request only delay the report by a minute.
EX_TEMPFAIL=75
RETRY_ERR="${TMPDIR:-/tmp}/shielded-night-register.last-error"

# retry_ready <label> <cmd...> -- run <cmd> until it succeeds or the budget runs out.
# The command's STDOUT passes through untouched, so `$(retry_ready ... current_state)` still
# reads the state; its STDERR is captured, echoed once on success (the steps report their own
# status line there) and printed IN FULL on give-up.
retry_ready() {
  local label="$1"; shift
  local try=1 rc=0 delay
  while :; do
    : >"${RETRY_ERR}"
    # `rc=$?` after an `if` is NOT the condition's status -- an `if` with no branch taken is
    # itself a zero-status command -- so the code is captured on the || side, where it is real.
    rc=0
    "$@" 2>"${RETRY_ERR}" || rc=$?
    if [ "${rc}" -eq 0 ]; then
      if [ "${try}" -gt 1 ]; then
        log "${label}: ready on attempt ${try}/${READY_TRIES}"
      fi
      if [ -s "${RETRY_ERR}" ]; then cat "${RETRY_ERR}" >&2; fi
      return 0
    fi
    if [ "${rc}" -ne "${EX_TEMPFAIL}" ]; then
      log "${label}: definitive failure (exit ${rc}) -- not retried"
      if [ -s "${RETRY_ERR}" ]; then cat "${RETRY_ERR}" >&2; fi
      return "${rc}"
    fi
    if [ "${try}" -ge "${READY_TRIES}" ]; then
      log "${label}: still not ready after ${try} attempts -- last response:"
      if [ -s "${RETRY_ERR}" ]; then cat "${RETRY_ERR}" >&2; fi
      return "${rc}"
    fi
    delay=$(( READY_RETRY_S * (1 << (try - 1)) ))
    if [ "${delay}" -gt "${READY_RETRY_MAX_S}" ]; then delay="${READY_RETRY_MAX_S}"; fi
    delay=$(( delay + RANDOM % (READY_JITTER_S + 1) ))
    log "${label}: not ready yet (attempt ${try}/${READY_TRIES}: $(tr '\n' ' ' <"${RETRY_ERR}" | cut -c1-160)) -- retrying in ${delay}s"
    sleep "${delay}"
    try=$(( try + 1 ))
  done
}

[ -f "${CONTRACT_FILE}" ] \
  || die "no ${CONTRACT_FILE} — shielded-night-deploy must complete first"

ADDRESS="$(published_address)" || die "could not read the contract address"
log "contract ${ADDRESS}"

# ── is the offer-files profile even in this stack? ───────────────────────────
KERNEL_HOST="$(printf '%s' "${ZSWAP_API}" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
KERNEL_DNS_WAIT_S="${SNIGHT_KERNEL_DNS_WAIT_S:-300}"

kernel_resolves() {
  ZS_HOST="${KERNEL_HOST}" bun -e '
      const dns = await import("node:dns/promises");
      try { await dns.lookup(process.env.ZS_HOST); } catch { process.exit(1); }
    ' >/dev/null 2>&1
}

WAITED=0
until kernel_resolves; do
  if [ "${WAITED}" -eq 0 ]; then
    log "'${KERNEL_HOST}' does not resolve yet — waiting up to ${KERNEL_DNS_WAIT_S}s in case the"
    log "  offerfiles profile is in this stack and its kernel container has not started"
  fi
  if [ "${WAITED}" -ge "${KERNEL_DNS_WAIT_S}" ]; then
    log "SKIP: '${KERNEL_HOST}' never resolved in ${WAITED}s — the offerfiles profile is not in this stack"
    log "      (bring it up with ./up.sh --with offerfiles --with shielded-night to register sNight)"
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
    const res = await fetch(`${process.env.ZS_API}/v1/known-tokens`).catch((e) => {
      // Nothing listening / connection refused: the kernel is starting, not broken.
      console.error(`GET /v1/known-tokens -> ${e}`);
      process.exit(75);
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`GET /v1/known-tokens -> ${res.status} ${body}`);
      // 5xx while `000-init.sql` is still being applied is the race issue 00016 records.
      process.exit(res.status >= 500 ? 75 : 1);
    }
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.tokens ?? body.knownTokens ?? []);
    const want = process.env.SN_NAME.toUpperCase();
    const row = rows.find((t) => String(t.name ?? "").toUpperCase() === want);
    if (!row) { process.stdout.write("absent"); process.exit(0); }
    const colour = String(row.color ?? row.token_color ?? "").toLowerCase().replace(/^0x/, "");
    process.stdout.write(colour === process.env.SN_COLOUR ? "match" : (colour || "unreadable"));
  '
}

# post_snight -- register a MISSING row through the API.
post_snight() {
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
      }).catch((e) => {
        console.error(`POST /v1/known-tokens -> ${e}`);
        process.exit(75);
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`POST -> ${res.status} ${text}`);
        // A 409 (name taken) is an ANSWER, not a wait: it is reported at once.
        process.exit(res.status >= 500 ? 75 : 1);
      }
      console.error(`POST -> ${res.status} ${text}`);
    '
}

# update_snight -- the one case the API cannot express (Q29): one row, one column, by NAME.
update_snight() {
  PGPASSWORD_VALUE="${DB_PW}" SN_NAME="${SNIGHT_NAME}" SN_COLOUR="${COLOUR}" \
  SN_DECIMALS="${SNIGHT_DECIMALS}" SN_ASSET="${SNIGHT_ASSET}" \
  DB_URL="postgres://${DB_USER}:${DB_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}" bun -e '
      const { SQL } = await import("bun");
      try {
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
          // The seed insert may not have landed yet -- that is a wait, not a defect.
          console.error(`expected to update exactly one row, updated ${rows.length}`);
          process.exit(75);
        }
        console.error(`UPDATE known_tokens -> ${rows[0].token_color}`);
        await sql.end();
      } catch (e) {
        // A missing relation or a refused connection is the same schema-init race.
        console.error(`UPDATE known_tokens -> ${e}`);
        process.exit(75);
      }
    '
}

STATE="$(retry_ready "GET /v1/known-tokens" current_state)" \
  || die "could not read ${ZSWAP_API}/v1/known-tokens"

if [ "${STATE}" = "match" ]; then
  log "OK: ${SNIGHT_NAME} already names ${COLOUR} — nothing to do"
  exit 0
fi

if [ "${STATE}" = "absent" ]; then
  log "no ${SNIGHT_NAME} row — registering through POST /v1/known-tokens"
  retry_ready "POST /v1/known-tokens" post_snight || die "POST /v1/known-tokens failed"
else
  log "${SNIGHT_NAME} currently names ${STATE} (the schema's seeded PREVIEW colour, or a"
  log "  previous deployment's) — the kernel has no update route, so: UPDATE ... WHERE name"
  retry_ready "UPDATE known_tokens" update_snight || die "could not update the ${SNIGHT_NAME} row"
fi

# ── prove it through the API, not through our own write ──────────────────────
FINAL="$(retry_ready "GET /v1/known-tokens (re-read)" current_state)" \
  || die "could not re-read ${ZSWAP_API}/v1/known-tokens"
[ "${FINAL}" = "match" ] \
  || die "${SNIGHT_NAME} still names '${FINAL}' after the write, expected ${COLOUR}"

log "OK: ${SNIGHT_NAME} = ${COLOUR} (decimals ${SNIGHT_DECIMALS}, asset ${SNIGHT_ASSET})"
exit 0
