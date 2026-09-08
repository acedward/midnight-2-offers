#!/usr/bin/env bash
#
# Assertions for the `aa` profile — the `aa` section of ./verify.sh.
#
#   ./scripts/verify-aa.sh
#
# What it proves:
#
#   deployed     the one-shot finished (exit 0) and wrote aa-contracts.json — which it
#                only does after BOTH deploys finalized and BOTH mint calls proved and
#                landed. The artifact is the receipt, read back from the aa-out volume.
#   addresses    manager + minter addresses present and hex-shaped.
#   minted       both mint entries carry a 64-hex colour and a transaction id — the
#                actual "we can mint a token" evidence, proven through the profile's
#                own experimental proof server (zkir-v3 verifier keys).
#   zkir source  WHICH compiler produced the Manager circuits that are live on this
#                chain, read out of the DEPLOY RECEIPT rather than out of a build
#                argument: the receipt was written by the process that registered the
#                verifier keys, and it records the hash of the key file that process
#                actually read. On the default (`AA_ZKIR_SOURCE=minocrab`) this asserts
#                that the deployed `execute` verifier is byte-for-byte the one the
#                pinned MinoCrab release published, that k is 18, and that the release
#                identity in the receipt equals the one this repository pins. It also
#                PRINTS the unaudited-compiler statement, because a gate that proves a
#                third-party artifact is live should say so out loud every time.
#
# The artifact is read via `docker compose run` against the same image, mounting the
# same volume — no host jq needed (the image ships bun).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

load_env

FAILURES=0

# Exit code of the (kept, exited) one-shot container.
cid=$(docker ps -aq \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=aa-deploy" | head -1)
if [[ -n "$cid" ]]; then
  rc=$(docker inspect "$cid" --format '{{.State.ExitCode}}')
  if [[ "$rc" == "0" ]]; then
    ok "aa-deploy one-shot exited 0"
  else
    err "aa-deploy exited ${rc} — docker logs $cid"
    FAILURES=$(( FAILURES + 1 ))
  fi
else
  err "no aa-deploy container for project '${COMPOSE_PROJECT_NAME}'"
  FAILURES=$(( FAILURES + 1 ))
fi

# The artifact, from the volume, validated in-container (bun ships in the image).
# --env-file only when the file exists: on the ordinary clean-clone path there
# is no .env, and compose hard-fails on a missing --env-file even though every
# value has a built-in default (the same no-.env class dc() already handles).
aa_env_args=()
[[ -f "${ENV_FILE:-}" ]] && aa_env_args=(--env-file "$ENV_FILE")
artifact=$(docker compose ${aa_env_args[@]+"${aa_env_args[@]}"} \
    -f "$REPO_ROOT/compose/core.yml" -f "$REPO_ROOT/compose/aa.yml" \
    run --rm --no-deps --entrypoint cat aa-deploy /aa/out/aa-contracts.json 2>/dev/null) || artifact=""
if [[ -z "$artifact" ]]; then
  err "aa-contracts.json missing from the aa-out volume"
  FAILURES=$(( FAILURES + 1 ))
else
  summary=$(printf '%s' "$artifact" | docker run --rm -i \
    --entrypoint bun "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" 2>/dev/null -e '
      const j = JSON.parse(await new Response(Bun.stdin.stream()).text());
      const hex = (s) => typeof s === "string" && /^[0-9a-f]{64,}$/i.test(s.replace(/^0x/, ""));
      const checks = {
        manager: hex(j.manager?.address),
        minter: hex(j.minter?.address),
        shieldedColour: hex(j.mints?.shielded?.color),
        unshieldedColour: hex(j.mints?.unshielded?.color),
        shieldedTx: !!j.mints?.shielded?.tx,
        unshieldedTx: !!j.mints?.unshielded?.tx,
      };
      console.log(JSON.stringify(checks));
      process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
    ' ) && aok=1 || aok=0
  # Fallback shape check without bun if the docker run path failed for tooling reasons.
  if [[ "$aok" == "1" ]]; then
    ok "artifact complete: addresses + both colours + both mint txs ($summary)"
  else
    if printf '%s' "$artifact" | grep -q '"address"' \
       && printf '%s' "$artifact" | grep -q '"shielded"' \
       && printf '%s' "$artifact" | grep -q '"unshielded"' \
       && printf '%s' "$artifact" | grep -qE '"tx": *"[^"]+"'; then
      ok "artifact carries addresses, both mint families and tx ids (grep-level check)"
    else
      err "artifact incomplete: $(printf '%s' "$artifact" | head -c 300)"
      FAILURES=$(( FAILURES + 1 ))
    fi
  fi
fi

# The web console, presence-detected: only asserted when the aa-console service
# has a container (older bring-ups of the profile predate it).
console_cid=$(docker ps -q \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=aa-console" | head -1)
if [[ -n "$console_cid" ]]; then
  CONSOLE_URL="http://${HOST_ADDR:-127.0.0.1}:${AA_CONSOLE_HOST_PORT:-10700}"
  health=$(curl -fsS --max-time 10 "$CONSOLE_URL/healthz" 2>/dev/null) || health=""
  if printf '%s' "$health" | grep -q '"ok":true'; then
    ok "aa-console serving on ${CONSOLE_URL}"
  else
    err "aa-console /healthz not answering on ${CONSOLE_URL}"
    FAILURES=$(( FAILURES + 1 ))
  fi
  if printf '%s' "$health" | grep -q '"funded":true'; then
    ok "aa-console relay wallet funded"
  else
    err "aa-console relay wallet UNFUNDED — operations will fail (./scripts/fund-wallet.sh with the aa-console seed)"
    FAILURES=$(( FAILURES + 1 ))
  fi
  # RETRIED, bounded (infra issue 00016): one 10s curl at a single-threaded Bun server that is
  # mid-wallet-sync is a coin flip, and 00015 P5 lost it once while every other aa assertion in
  # the same run passed. `curl_retry_match` keeps the assertion exactly as strict — the page
  # must contain "AA Console" — and only stops calling a slow page a broken one.
  if curl_retry_match "$CONSOLE_URL/" "AA Console" "aa-console page" >/dev/null; then
    ok "aa-console page serves"
  else
    err "aa-console page did not serve HTML"
    FAILURES=$(( FAILURES + 1 ))
  fi
  # The console and the deploy artifact must agree on the Manager address.
  INFO="$(curl -fsS --max-time 10 "$CONSOLE_URL/api/info" 2>/dev/null || true)"
  mgr=$(printf '%s' "$artifact" | grep -oE '"address": *"[0-9a-fx]+"' | head -1 | grep -oE '[0-9a-f]{32,}' | head -1) || mgr=""
  if [[ -n "$mgr" ]] && printf '%s' "$INFO" | grep -q "$mgr"; then
    ok "aa-console reports the deployed Manager (${mgr:0:16}…)"
  else
    err "aa-console /api/info does not match the deployed Manager address"
    FAILURES=$(( FAILURES + 1 ))
  fi

  # ── the console's TOKEN SET comes from the local faucet registry ───────────
  #
  # This is the US4 assertion, and it is worth making from the outside because
  # every way it can break is silent. The console used to DERIVE three colours
  # from the offer-files contract address it read out of the kernel; that
  # contract is gone at KERNEL_REF 5d794f9 and `/v1/midnight/config` no longer
  # carries an address, so a console still on the old path would come up
  # perfectly healthy, serve its page, and answer `tokens: []` with a
  # `tokensError` nobody reads until a mint button fails.
  #
  # Three things are checked, and the third is the one that used to be wrong:
  #   * the tokens resolved at all, and say where from (`mint-test-tokens`);
  #   * they are the local issuers' six, not three invented names;
  #   * their DECIMALS are the registry's. The console registered every token
  #     with a hardcoded `decimals: 6` before this change, which was wrong for
  #     four of the six and is exactly the class of error that only shows up as
  #     a price off by a factor of 10^n.
  #
  # CONDITIONAL on the faucet profile: `./up.sh --with aa` alone is legal, and
  # then there is no registry to read and the console says so.
  if docker ps -aq \
       --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
       --filter "label=com.docker.compose.service=faucet-deploy" 2>/dev/null | grep -q .; then
    if printf '%s' "$INFO" | grep -q '"tokensSource":"mint-test-tokens"'; then
      ok "aa-console takes its token set from the local mint-test-tokens registry"
    else
      err "aa-console /api/info does not report tokensSource=mint-test-tokens"
      info "  a console still deriving colours from the deleted offer-files contract answers"
      info "  tokens:[] with a tokensError — it will serve every page and mint nothing."
      info "  answer was: $(printf '%s' "$INFO" | head -c 300)"
      FAILURES=$(( FAILURES + 1 ))
    fi
    # PARSED, NOT GREPPED, and for a measured reason: the first version of this
    # split `/api/info` with `tr '}' '}\n'` and matched name and decimals on the
    # result. `tr` cannot expand one character into two — SET2 is truncated to
    # SET1's length, so it replaced `}` with `}` — the JSON stayed on one line,
    # and the regex matched across object boundaries. It passed while asserting
    # nothing: any `twBTC` anywhere followed by any `"decimals":8` anywhere.
    AA_TOKENS_MISSING="$(printf '%s' "$INFO" | python3 -c '
import json, sys
want = {"twBTC": 8, "twETH": 18, "twUSDC": 6, "twUSDM": 6, "utwUSDC": 6, "utwBTC": 8}
try:
    doc = json.load(sys.stdin)
except Exception as exc:
    print("unparsable /api/info: " + str(exc))
    raise SystemExit(0)
by_name = {str(t.get("name")): t for t in (doc.get("tokens") or [])}
missing = []
for name in sorted(want):
    row = by_name.get(name)
    if row is None:
        missing.append(name + "/absent")
    elif row.get("decimals") != want[name]:
        missing.append("{}/decimals={} (want {})".format(name, row.get("decimals"), want[name]))
print(", ".join(missing))
' 2>/dev/null)"
    if [[ -z "$AA_TOKENS_MISSING" ]]; then
      ok "aa-console lists all six local tokens with their real decimals (8/18/6/6/6/8)"
    else
      err "aa-console token list is missing or misreporting: ${AA_TOKENS_MISSING}"
      FAILURES=$(( FAILURES + 1 ))
    fi
  else
    info "faucet profile not in this stack — skipping the aa-console token-set assertions"
  fi
fi

# ── the zkir-source receipt ─────────────────────────────────────────────────
# Read from the SAME artifact the assertions above read, so there is no second
# source for "what is deployed". `AA_ZKIR_SOURCE` here is the CONFIGURED value; the
# receipt is what the deploy actually did, and the two disagreeing is the defect
# this exists to catch (a stale image, or an `.env` changed without a redeploy).
AA_ZKIR_SOURCE_EXPECTED="${AA_ZKIR_SOURCE:-minocrab}"
MINOCRAB_RELEASE_EXPECTED="${MINOCRAB_RELEASE:-v0.2.0}"
MINOCRAB_REF_EXPECTED="${MINOCRAB_REF:-7cdfa5b0c994a70502ab2b564b509c8abe2f7efb}"
MINOCRAB_SUMS_EXPECTED="${MINOCRAB_SUMS_SHA256:-4a8c0183cd887e3ca2d3446f196fab1102540e09d6e0e8ae9c1859532d8dd7ac}"

if [[ -n "$artifact" ]]; then
  # The expectations travel as CONTAINER env, not as shell interpolation into the
  # script body: a value with a quote in it would otherwise be code.
  zk=$(printf '%s' "$artifact" | docker run --rm -i \
    -e WANT_SOURCE="$AA_ZKIR_SOURCE_EXPECTED" \
    -e WANT_RELEASE="$MINOCRAB_RELEASE_EXPECTED" \
    -e WANT_REF="$MINOCRAB_REF_EXPECTED" \
    -e WANT_SUMS="$MINOCRAB_SUMS_EXPECTED" \
    --entrypoint bun "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" 2>/dev/null \
    -e '
      const j = JSON.parse(await new Response(Bun.stdin.stream()).text());
      const z = j.zkirSource;
      const want = { source: Bun.env.WANT_SOURCE, release: Bun.env.WANT_RELEASE,
                     ref: Bun.env.WANT_REF, sums: Bun.env.WANT_SUMS };
      if (!z) { console.log("MISSING"); process.exit(1); }
      if (z.source !== want.source) {
        console.log(`SOURCE_MISMATCH receipt=${z.source} configured=${want.source}`);
        process.exit(1);
      }
      if (z.source === "compactc") { console.log("OK compactc"); process.exit(0); }
      const bad = [];
      if (z.release !== want.release) bad.push(`release ${z.release} != ${want.release}`);
      if (z.portCommit !== want.ref)  bad.push(`portCommit ${z.portCommit} != ${want.ref}`);
      if (z.sumsSha256 !== want.sums) bad.push(`SHA256SUMS ${z.sumsSha256} != ${want.sums}`);
      if (z.contractCommit !== j.aaCommit)
        bad.push(`the release keys are for contract ${z.contractCommit}, the image is ${j.aaCommit}`);
      for (const [name, c] of Object.entries(z.circuits ?? {})) {
        if (!c.verifierMatches)
          bad.push(`${name}: deployed verifier ${c.deployed?.verifier?.sha256 ?? "absent"} is not the published ${c.published?.verifier?.sha256}`);
        if (c.proverMatches === false)
          bad.push(`${name}: the prover key in the image is not the published one`);
      }
      if (bad.length) { console.log("BAD " + bad.join("; ")); process.exit(1); }
      const names = Object.keys(z.circuits ?? {});
      const ks = names.map((n) => `${n} k=${z.circuits[n].k}`).join(", ");
      console.log(`OK ${z.source} ${z.release} (${z.portCommit.slice(0, 12)}…) — ${names.length} circuit(s): ${ks}`);
    ' ) && zkok=1 || zkok=0
  if [[ "$zkok" == "1" ]]; then
    ok "manager zkir source: ${zk#OK }"
    if [[ "$AA_ZKIR_SOURCE_EXPECTED" != "compactc" ]]; then
      # Not decoration. A gate that proves an UNAUDITED third-party compiler's
      # artifact is live on this chain has to say that where the operator reads it,
      # not only in a doc they may never open.
      info "  MinoCrab is an UNAUDITED third-party compiler; equivalence is TESTED, NOT PROVEN"
      info "  (59 differential tests, 5,128 tamper probes, 0 acceptance disagreements) — dev chains only."
      info "  docs/KNOWN-LIMITATIONS.md · AA_ZKIR_SOURCE=compactc opts out (redeploy: keys change)."
    fi
  else
    err "manager zkir source: ${zk:-unreadable} (configured ${AA_ZKIR_SOURCE_EXPECTED})"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

if (( FAILURES == 0 )); then
  ok "aa assertions passed"
  exit 0
fi
err "${FAILURES} aa assertion(s) failed"
exit 1
