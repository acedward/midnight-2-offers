#!/usr/bin/env bash
#
# Assertions for the `aa` profile — the `aa` section of ./verify.sh.
#
#   ./scripts/verify-aa.sh
#   ./scripts/verify-aa.sh --mint    …plus a REAL register + mint + deposit through the
#                                    console's own API
#
# ⚠ WHAT THIS PROFILE IS SINCE PROJECT 00034. There is no shared AA-v3 Manager and no test
# Minter. An account is ONE CONTRACT PER USER (a fork of the Midnight Passport account) and
# the console's `register` deploys it; what `aa-deploy` puts on chain is the three SHARED
# things that must exist before any account can: the Signet singleton, the ERC20 bridge
# vault (deployed AND initialised, because an account's constructor seals a reference to it)
# and the fork's test faucet.
#
# What it proves:
#
#   deployed     the one-shot finished (exit 0) and wrote aa-contracts.json — which it only
#                does after all three deploys finalized, `initialise` landed and read back,
#                and both faucet mints proved. The artifact is the receipt, read back from
#                the aa-out volume.
#   vault        the vault's address, its EVM account, the chain id it is pinned to, and
#                whether its MPC root key is a real one or the LOCAL STUB (printed either
#                way — a stub must never be mistaken for a key somebody chose).
#   artefacts    the artefact FINGERPRINT of every compiled bundle (spec FR-022): the
#                SHA-256 over the bundle's verifier keys, computed at build time from the
#                bytes in the image and recorded by the deploy. An account is compiled
#                against one exact vault build, so a rebuilt vault under a running stack is
#                a verification failure rather than a mystery on the first bridge call.
#   account plan what the console will deploy on every account it registers: the circuit
#                list, the two waves, and `retireAuthority`. This is the deploy-budget
#                claim of spec User Story 4 stated where an operator reads it.
#   k per circuit  measured at BUILD time with the same pinned zkir the compiler used, and
#                baked into the image — so the number next to `open_swap_shielded_with_evm`
#                is the one that produced the artefact this stack proves with.
#   console      it serves, its relay wallet is funded, its token set comes from the local
#                registry with the registry's real decimals, and it agrees with the deploy
#                receipt about the vault.
#
# The artifact is read via `docker compose run` against the same image, mounting the same
# volume — no host jq needed (the image ships bun).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

WITH_MINT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mint) WITH_MINT=1; shift ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

load_env

FAILURES=0
AA_IMG="${AA_IMAGE:-midnight-2-offers/aa-contracts:local}"

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

# The artifact, from the volume. --env-file only when the file exists: on the ordinary
# clean-clone path there is no .env, and compose hard-fails on a missing --env-file even
# though every value has a built-in default.
aa_env_args=()
[[ -f "${ENV_FILE:-}" ]] && aa_env_args=(--env-file "$ENV_FILE")
artifact=$(docker compose ${aa_env_args[@]+"${aa_env_args[@]}"} \
    -f "$REPO_ROOT/compose/core.yml" -f "$REPO_ROOT/compose/aa.yml" \
    run --rm --no-deps --entrypoint cat aa-deploy /aa/out/aa-contracts.json 2>/dev/null) || artifact=""
if [[ -z "$artifact" ]]; then
  err "aa-contracts.json missing from the aa-out volume"
  FAILURES=$(( FAILURES + 1 ))
else
  # ONE in-container pass over the receipt, printing a human line per claim and exiting
  # non-zero if any of them is unsatisfied. Parsed, never grepped: a grep over one-line
  # JSON matches across object boundaries and has passed while asserting nothing here
  # before (the `tr '}' '}\n'` defect below).
  summary=$(printf '%s' "$artifact" | docker run --rm -i \
    --entrypoint bun "$AA_IMG" 2>&1 -e '
      const j = JSON.parse(await new Response(Bun.stdin.stream()).text());
      const hex = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`, "i").test(String(s).replace(/^0x/, ""));
      const bad = [];
      const say = (line) => console.log("      " + line);

      if (j.kind !== "aa-passport-deploy-receipt") {
        bad.push(`this is not a Passport deploy receipt (kind=${j.kind ?? "absent"}). A stack ` +
                 "brought up from the AA-v3 image writes a different artifact: ./down.sh -v and up again");
      }
      if (!hex(j.vault?.address, 64)) bad.push("no vault address");
      if (!hex(j.signet?.address, 64)) bad.push("no Signet singleton address");
      if (!hex(j.testFaucet?.address, 64)) bad.push("no test-faucet address");
      if (!j.vault?.initialiseTxId) bad.push("the vault was never initialised (no initialise tx)");
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(j.vault?.evmAddress ?? ""))) bad.push("no vault EVM address");
      if (!j.vault?.evmChainId) bad.push("the vault is pinned to no EVM chain id");
      say(`vault      ${j.vault?.address?.slice(0, 20)}… evm ${j.vault?.evmAddress} chain ${j.vault?.evmChainId}`);
      say(`singleton  ${j.signet?.address?.slice(0, 20)}…   initialise tx ${String(j.vault?.initialiseTxId).slice(0, 18)}…`);
      say(`mpc        ${String(j.mpc?.rootPublicKey ?? "").slice(0, 20)}… (${j.mpc?.provenance})`);

      // FR-022: an account is compiled against ONE vault build. Print the fingerprints, and
      // require the account bundle to have one at all.
      for (const [name, a] of Object.entries(j.artefacts ?? {})) {
        say(`artefact   ${name.padEnd(13)} ${a.fingerprint?.slice(0, 24)}… (${a.verifierKeys} verifier keys, ${a.provers?.length ?? 0} prover keys)`);
      }
      if (!j.artefacts?.account?.fingerprint) bad.push("the receipt records no account artefact fingerprint (FR-022)");
      if (!j.artefacts?.Erc20Vault?.fingerprint) bad.push("the receipt records no vault artefact fingerprint (FR-022)");

      const plan = j.accountPlan ?? {};
      say(`plan       ${(plan.circuits ?? []).length} circuits per account; wave 1 = ${(plan.waveOne ?? []).length}, ` +
          `wave 2 = ${(plan.waveTwo ?? []).length}; authority retired: ${plan.retireAuthority}`);
      if (!(plan.circuits ?? []).includes("open_swap_shielded_with_evm")) {
        bad.push("the account plan carries NO offer circuit — this stack exists to make offers (Q35)");
      }
      if ((plan.waveOne ?? []).length !== 8) {
        bad.push(`wave 1 carries ${(plan.waveOne ?? []).length} operations; the node was measured refusing nine (Q28)`);
      }
      if (plan.retireAuthority !== true) {
        bad.push("the account plan does NOT retire the maintenance authority — an authority sits ABOVE the MIP-0013 seam");
      }

      for (const fam of ["shielded", "unshielded"]) {
        if (!hex(j.mints?.[fam]?.color, 64)) bad.push(`${fam} mint: no 64-hex colour`);
        if (!j.mints?.[fam]?.tx) bad.push(`${fam} mint: no transaction id`);
      }
      say(`mints      shielded ${String(j.mints?.shielded?.color).slice(0, 16)}… / unshielded ${String(j.mints?.unshielded?.color).slice(0, 16)}…`);
      say(`build      passport ${String(j.build?.passportCommit).slice(0, 12)}… compactc ${j.build?.compactcVersion} ` +
          `runtime ${j.build?.compactRuntimeVersion} signet ${j.build?.signetPkgVersion}`);
      say(`prover keys kept: ${(j.build?.proverKeys ?? []).length}${j.build?.withBridge ? " (+ bridge)" : ""}`);

      if (bad.length) { console.log("FAIL " + bad.join("; ")); process.exit(1); }
      console.log("OK");
    ' ) && aok=1 || aok=0
  printf '%s\n' "$summary" | grep -v '^OK$' | grep -v '^FAIL ' || true
  if [[ "$aok" == "1" ]]; then
    ok "deploy receipt complete: vault + singleton + test faucet, initialised, fingerprinted"
  else
    err "deploy receipt incomplete: $(printf '%s' "$summary" | grep '^FAIL ' | head -c 500)"
    FAILURES=$(( FAILURES + 1 ))
  fi

  # The LOCAL-STUB warning, said out loud every time rather than left in a doc. A vault
  # whose MPC root key is derived from a public string can be initialised by anybody who
  # reads this repository, which is correct for a disposable localnet and wrong anywhere
  # else — exactly the class of statement the retired MinoCrab warning occupied.
  if printf '%s' "$artifact" | grep -q '"provenance": *"derived-from-AA_DOMAIN"'; then
    info "  the vault's MPC root key is a LOCAL STUB derived from AA_DOMAIN: its private half is"
    info "  public, no MPC runs on this stack, and the bridge circuits are deployed but cannot"
    info "  move funds. AA_MPC_ROOT_SECRET overrides it. docs/KNOWN-LIMITATIONS.md."
  fi
fi

# ── k per proof-bearing circuit, measured at build time ─────────────────────
# `k` is the log2 of a circuit's constraint domain and decides the proving-key size; it is
# what spec User Story 4's acceptance scenario asks to be recorded. Measured in the image
# with the SAME pinned zkir that produced the artefacts (measuring one compiler's output
# with another's is meaningless) and baked in as /aa/.circuit-k.json.
if k=$(docker run --rm --entrypoint cat "$AA_IMG" /aa/.circuit-k.json 2>/dev/null); then
  printf '%s' "$k" | docker run --rm -i --entrypoint bun "$AA_IMG" 2>/dev/null -e '
    const j = JSON.parse(await new Response(Bun.stdin.stream()).text());
    const rows = Object.entries(j.circuits ?? {}).sort((a, b) => (b[1].k ?? 0) - (a[1].k ?? 0));
    for (const [name, c] of rows.slice(0, 8)) {
      console.log(`      k=${String(c.k).padStart(2)} rows=${String(c.rows).padStart(7)} ${name}`);
    }
    const max = rows[0];
    console.log(`      (${rows.length} proof-bearing circuits; heaviest ${max?.[0]} at k=${max?.[1]?.k})`);
  ' || true
  ok "k recorded per circuit (measured at build time with the pinned zkir)"
else
  info "the image carries no /aa/.circuit-k.json — k was not measured at build time"
fi

# The web console, presence-detected.
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
  # RETRIED, bounded (infra issue 00016): one 10s curl at a single-threaded Bun server that
  # is mid-wallet-sync is a coin flip.
  if curl_retry_match "$CONSOLE_URL/" "AA Console" "aa-console page" >/dev/null; then
    ok "aa-console page serves"
  else
    err "aa-console page did not serve HTML"
    FAILURES=$(( FAILURES + 1 ))
  fi

  INFO="$(curl -fsS --max-time 10 "$CONSOLE_URL/api/info" 2>/dev/null || true)"
  # The console and the deploy receipt must agree about the VAULT — which is the one address
  # that binds them, because every account the console registers seals it at construction.
  vault=$(printf '%s' "$artifact" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("vault") or {}).get("address",""))' 2>/dev/null || true)
  if [[ -n "$vault" ]] && printf '%s' "$INFO" | grep -q "$vault"; then
    ok "aa-console reports the deployed vault (${vault:0:16}…)"
  else
    err "aa-console /api/info does not match the deployed vault address"
    info "  every account this console registers seals THAT address in its constructor, and the"
    info "  compiler embeds a fingerprint of that vault's verifier keys — a disagreement here"
    info "  means accounts would be deployed against a vault this chain does not have."
    FAILURES=$(( FAILURES + 1 ))
  fi
  # The model, stated by the console itself: a stack still running the AA-v3 console would
  # answer with a manager address and no model field, and every other assertion here could
  # still pass.
  if printf '%s' "$INFO" | grep -q '"model":"passport-per-user-account"'; then
    ok "aa-console runs the per-user Passport account model"
  else
    err "aa-console /api/info does not report the passport-per-user-account model"
    FAILURES=$(( FAILURES + 1 ))
  fi

  # ── the console's TOKEN SET comes from the local faucet registry ───────────
  # Unchanged by 00034: the six issuers are external to the account model, and the console
  # still reads the registry rather than deriving anything. CONDITIONAL on the faucet
  # profile — `./up.sh --with aa` alone is legal and then there is no registry to read.
  if docker ps -aq \
       --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
       --filter "label=com.docker.compose.service=faucet-deploy" 2>/dev/null | grep -q .; then
    if printf '%s' "$INFO" | grep -q '"tokensSource":"mint-test-tokens"'; then
      ok "aa-console takes its token set from the local mint-test-tokens registry"
    else
      err "aa-console /api/info does not report tokensSource=mint-test-tokens"
      info "  answer was: $(printf '%s' "$INFO" | head -c 300)"
      FAILURES=$(( FAILURES + 1 ))
    fi
    # PARSED, NOT GREPPED, and for a measured reason: the first version of this split
    # `/api/info` with `tr '}' '}\n'` and matched name and decimals on the result. `tr`
    # cannot expand one character into two — the JSON stayed on one line and the regex
    # matched across object boundaries. It passed while asserting nothing.
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

  # ── the accounts this console has registered ──────────────────────────────
  # Zero is the correct answer on a fresh stack: nothing registers an account until somebody
  # asks. What is asserted is that the endpoint ANSWERS in the per-account shape — a console
  # still iterating a Manager's ledger map would answer differently or fail.
  ACCOUNTS="$(curl -fsS --max-time 15 "$CONSOLE_URL/api/accounts" 2>/dev/null || true)"
  N="$(printf '%s' "$ACCOUNTS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("accounts",[])))' 2>/dev/null || echo "?")"
  if [[ "$N" == "?" ]]; then
    err "aa-console /api/accounts did not answer with an account list"
    FAILURES=$(( FAILURES + 1 ))
  else
    ok "aa-console registry: ${N} account(s) (the console's OWN roster — one account is one contract, Q40)"
    if [[ "$N" != "0" ]]; then
      printf '%s' "$ACCOUNTS" | python3 -c '
import json,sys
for a in json.load(sys.stdin).get("accounts", []):
    print("      {}  owner {}  authNonce {}  inbox {}".format(
        str(a.get("address"))[:22] + "…", str(a.get("owner"))[:12] + "…",
        a.get("authNonce"), a.get("inboxCount")))
' 2>/dev/null || true
    fi
  fi
fi

# ── a real register + mint + deposit through the console's OWN API (opt-in) ──
#
# THE GAP THIS CLOSES. Everything above is CONFIGURATION: the receipt says what was
# deployed and `/api/info` says what the console believes. None of it registers an account
# or moves a token. So this drives the same HTTP surface the page drives — `/api/prepare` →
# sign → `/api/submit` for the enrolment, then `/api/fund` and `/api/fund-shielded` — and
# reads the ACCOUNT'S OWN LEDGER back through `/api/pure`. A job that says "done" only
# proves the relay did not throw; the ledger read is what proves the value landed.
#
# Opt-in because registering an account is two transactions and minutes of proving on a cold
# devnet. `./verify.sh --aa-mint` turns it on; scripts/ci-check.sh passes that by default.
#
# It runs INSIDE the console container, which is where the client and the pinned dependency
# tree already are — and where `http://127.0.0.1:8090` is unambiguously THIS console.
if (( WITH_MINT )); then
  echo
  log "aa: register an account and fund it through the console's API, then read its ledger back"
  if [[ -z "${console_cid:-}" ]]; then
    err "--mint needs a running aa-console container for project '${COMPOSE_PROJECT_NAME}'"
    FAILURES=$(( FAILURES + 1 ))
  elif ! docker ps -aq \
        --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
        --filter "label=com.docker.compose.service=faucet-deploy" 2>/dev/null | grep -q .; then
    err "--mint needs the faucet profile: there are no local issuers to mint through"
    info "  ./up.sh --with aa --with faucet"
    FAILURES=$(( FAILURES + 1 ))
  else
    info "expect several minutes: a two-wave account deploy, then two mint+deposit cycles"
    MINT_OUT="$(docker exec "$console_cid" bun /aa/runner/aa-console-mint.ts 2>&1)" && MINT_RC=0 || MINT_RC=$?
    printf '%s\n' "$MINT_OUT" | sed 's/^/      /'
    if (( MINT_RC == 0 )) && printf '%s' "$MINT_OUT" | grep -q '\[aa-console-mint\] RESULT '; then
      ok "console: an account registered, one shielded and one unshielded token deposited into it"
      info "  $(printf '%s' "$MINT_OUT" | grep '\[aa-console-mint\] RESULT ' | head -1)"
    else
      err "the console register+mint failed (exit ${MINT_RC})"
      FAILURES=$(( FAILURES + 1 ))
    fi
  fi
else
  echo
  dim "console register+mint not attempted — pass --mint (or ./verify.sh --aa-mint) to run one"
  dim "  it is a two-wave account deploy plus two mint+deposit cycles: minutes on a cold devnet"
fi

if (( FAILURES == 0 )); then
  ok "aa assertions passed"
  exit 0
fi
err "${FAILURES} aa assertion(s) failed"
exit 1
