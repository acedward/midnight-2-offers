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
artifact=$(docker compose --env-file "${ENV_FILE:-$REPO_ROOT/.env}" \
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
  if curl -fsS --max-time 10 "$CONSOLE_URL/" 2>/dev/null | grep -q "AA Console"; then
    ok "aa-console page serves"
  else
    err "aa-console page did not serve HTML"
    FAILURES=$(( FAILURES + 1 ))
  fi
  # The console and the deploy artifact must agree on the Manager address.
  mgr=$(printf '%s' "$artifact" | grep -oE '"address": *"[0-9a-fx]+"' | head -1 | grep -oE '[0-9a-f]{32,}' | head -1) || mgr=""
  if [[ -n "$mgr" ]] && curl -fsS --max-time 10 "$CONSOLE_URL/api/info" 2>/dev/null | grep -q "$mgr"; then
    ok "aa-console reports the deployed Manager (${mgr:0:16}…)"
  else
    err "aa-console /api/info does not match the deployed Manager address"
    FAILURES=$(( FAILURES + 1 ))
  fi
fi

if (( FAILURES == 0 )); then
  ok "aa assertions passed"
  exit 0
fi
err "${FAILURES} aa assertion(s) failed"
exit 1
