#!/usr/bin/env bash
#
# Bring up the demo stack and block until every service is actually usable.
#
# "Actually usable" is stricter than "docker says healthy":
#   node          RPC answers chain_getBlockHash[1]  → the chain is producing blocks
#   indexer       GraphQL v4 answers a block query   → the API is serving, not just booting
#   proof-server  the port accepts a TCP connection  → nothing inside the image can probe it
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=scripts/lib/evm.sh
source "$REPO_ROOT/scripts/lib/evm.sh"
# shellcheck source=scripts/lib/celestia.sh
source "$REPO_ROOT/scripts/lib/celestia.sh"

PROFILES=""
DO_PULL=0
DO_BUILD=0
WANT_ALL=0
CONVERGE=0

usage() {
  cat <<'EOF'
Usage: ./up.sh [options]

Brings up the core Midnight stack (node + indexer + proof-server) and waits until all
three are serving. Reads .env for image tags and host ports (see .env.example).

Options:
  --with <profile>   ALSO bring up an optional profile; repeatable, and additive — see below.
                     A profile is a compose fragment in compose/, named after the profile. An
                     unknown name is an error, not a no-op.
                     Available now: aa, evm, frontend, offerfiles, shielded-night, solver.
  --all              bring up every shipped profile in compose/. All currently documented
                     profiles have fragments and are included.
  --converge         the opposite of additive: bring up EXACTLY core + the named profiles and
                     STOP any other profile that is currently up. `./up.sh --converge` on its
                     own therefore means "core alone". Every profile it is about to stop is
                     named before it happens.
  --pull             docker compose pull before starting.
  --build            docker compose build before starting (for the locally-built images).
  -h, --help         this text.

`--with` is ADDITIVE: any profile that already has containers in this compose project is folded
back into the bring-up, so `./up.sh --with offerfiles` on a stack where `evm` is running brings
up Celestia and leaves the evm services alone (it used to stop them — that surprise is what
--converge now exists for). The profiles carried over are named on every run.

Orphan cleanup is unaffected: compose still runs with --remove-orphans, and a container whose
service is no longer declared by ANY fragment is still removed. Only whole profiles that are
genuinely up are protected. To take a profile down, use ./down.sh (everything) or --converge
without it (that profile only).

Every shipped profile is complete: offerfiles includes Celestia, the kernel and batcher;
frontend is the immutable-upstream + ledger-v9-patch zswap-da SPA; aa deploys and serves its console; solver is
the observation-mode solver and authenticated sink; shielded-night funds its own wallets,
deploys the NIGHT <-> sNight wrapper contract ONCE per stack and serves its dApp, depending on
nothing but core. `--all` selects all of them.

Environment:
  ENV_FILE=<path>    use a different env file than ./.env — this is how two stacks run
                     side by side on one machine:
                        ENV_FILE=.env.test ./up.sh

Examples:
  ./up.sh                       # core stack, plus whatever profiles are already up
  ./up.sh --with evm            # …and umbra-evm
  ./up.sh --with offerfiles     # …and Celestia + kernel + batcher, without stopping evm
  ./up.sh --with frontend       # …and the zswap-da SPA
  ./up.sh --with shielded-night # …and the Shielded NIGHT dApp (needs nothing but core)
  ./up.sh --converge            # core ONLY: stop every optional profile that is up
  ENV_FILE=.env.ci ./up.sh      # a second, port-shifted instance
EOF
}

# A `--with` name that has no fragment must FAIL. It used to be accepted and then quietly
# dropped by compose_files(), so `./up.sh --with umbra-evm` (the fragment is evm.yml) came
# up as a bare core stack and only failed later, as `no such service: evm-rpc`.
add_profile() {
  local p="$1" pend
  if [[ ! -f "$REPO_ROOT/compose/$p.yml" ]]; then
    err "unknown profile: $p"
    info "available now: $(available_profiles | tr '\n' ' ')"
    pend="$(pending_profiles | tr '\n' ' ')"
    [[ -n "${pend// /}" ]] && info "not built yet, coming with ${FUTURE_PROFILES_BLOCKER}: ${pend}"
    exit 2
  fi
  PROFILES="$PROFILES $p"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with)   add_profile "${2:?--with needs a profile name}"; shift 2 ;;
    --with=*) add_profile "${1#*=}"; shift ;;
    --all)
      while IFS= read -r p; do PROFILES="$PROFILES $p"; done < <(available_profiles)
      WANT_ALL=1
      shift ;;
    --converge) CONVERGE=1; shift ;;
    --pull)  DO_PULL=1; shift ;;
    --build) DO_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; echo; usage; exit 2 ;;
  esac
done

export PROFILES
require_docker
load_env
# Nothing starts against a weak identity. load_env only warns (so `./down.sh` can always
# clean up); this is the fatal form, and it runs before a single container is created.
assert_image_pins

# ── `--with` is ADDITIVE (question Q12) ──────────────────────────────────────
#
# Everything already up in this compose project is folded back into PROFILES, so bringing up a
# new profile cannot stop the ones that are running. Before this, compose was given only core +
# the named fragments and `--remove-orphans` removed the rest: `./up.sh --with offerfiles` on a
# full stack silently stopped evm-rpc, wallet-monitor, evm-postgres and evm-migrate, mid-command,
# among compose's own output. `--with <newthing>` means "and also this" to every reader, and now
# it means that to the script.
#
# `--remove-orphans` stays. With every live profile named, the only containers it can still
# remove are those of a service no longer declared by any fragment — which is the job it was
# there for. See running_profiles() in scripts/lib/common.sh for the service→profile mapping.
#
# It has to run after load_env: the lookup is by COMPOSE_PROJECT_NAME, which the env file sets.
CARRIED=""
STOPPING=""
while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  if (( CONVERGE )); then
    [[ " $PROFILES " == *" $p "* ]] || STOPPING="$STOPPING $p"
  else
    [[ " $PROFILES " == *" $p "* ]] && continue
    PROFILES="$PROFILES $p"
    CARRIED="$CARRIED $p"
  fi
done < <(running_profiles)
export PROFILES

log "demo stack: project '${COMPOSE_PROJECT_NAME}'"
# Print the readable version AND the digest that is the actual identity: a version alone
# cannot be checked against anything, and a bare hash tells an operator nothing.
info "images   node=${NODE_VERSION} ${NODE_IMAGE#*@}"
info "         indexer=${INDEXER_VERSION} (${WAREHOUSE_REPO}@${WAREHOUSE_RELEASE}, native binary)"
info "         proof=${PROOF_VERSION} plain ${PROOF_IMAGE#*@}"
[[ " $PROFILES " == *" aa "* ]] && info "         proof=${PROOF_VERSION} experimental ${AA_PROOF_IMAGE#*@}"
info "         proof-data generation ${PROOF_DATA_GENERATION:0:16}… (one shared read-only cache)"
info "ports    node=${HOST_ADDR}:${NODE_HOST_PORT}  indexer=${HOST_ADDR}:${INDEXER_HOST_PORT}  proof=${HOST_ADDR}:${PROOF_HOST_PORT}"
[[ -n "${PROFILES// /}" ]] && info "profiles core${PROFILES// /, }"
# Say what was carried over and what is about to be stopped. Both directions are named out loud:
# the whole complaint behind Q12 was that a profile got stopped silently, mid-command.
[[ -n "${CARRIED// /}" ]] && info "kept     already up, so left running:${CARRIED}"
if (( CONVERGE )); then
  if [[ -n "${STOPPING// /}" ]]; then
    warn "--converge: STOPPING the profile(s) not named this time:${STOPPING}"
  else
    dim "--converge: no other profile is up, so nothing will be stopped"
  fi
fi
# Name what a partial profile does and does not include, every time. Left unsaid, `--with
# offerfiles` coming up with no kernel on :9999 reads as a broken build rather than as the
# half that was deliberately built first.
for p in ${PROFILES:-}; do
  if note="$(partial_profile_note "$p" 2>/dev/null)"; then
    info "note     ${p} is PARTIAL: ${note}"
  fi
done
if (( WANT_ALL )); then
  # `--all` means "every fragment there is", which today is not the whole demo. Say so, so
  # nobody concludes the offer-files half is broken when it was simply never started.
  PENDING="$(pending_profiles | tr '\n' ' ')"
  if [[ -n "${PENDING// /}" ]]; then
    info "not built yet, so --all skipped them (coming with ${FUTURE_PROFILES_BLOCKER}): ${PENDING}"
  fi
fi

# Pre-create the toolkit cache directory that compose bind-mounts into the `fund` service.
# Letting docker create a missing bind-mount source races with the first container that
# writes there: the toolkit's redb cache creation then fails with
# `failed to create database: Storage(Io(… NotFound …))`.
mkdir -p "$REPO_ROOT/.cache/${COMPOSE_PROJECT_NAME}"

if (( DO_PULL )); then
  log "pulling images"
  dc pull
fi
if (( DO_BUILD )); then
  log "building local images"
  if [[ "${COMPOSE_PARALLEL_LIMIT:-}" == "1" ]]; then
    # Compose v5 delegates one multi-service `build` to a single Bake graph; its internal
    # targets still execute concurrently even when COMPOSE_PARALLEL_LIMIT=1. Issue one
    # service build at a time when strict serialisation was requested. Image-only services
    # are harmless (`No services to build`, exit 0), while shared-image services become
    # cheap cache hits after the first build.
    while IFS= read -r service; do
      [[ -n "$service" ]] || continue
      info "build service ${service}"
      dc build "$service"
    done < <(dc config --services)
  else
    dc build
  fi
fi

FAILED=0
log "starting containers"
# The proof servers gate on the proof-params-init one-shot completing successfully, so on a
# FIRST bring-up (or after `./down.sh -v`) this step also downloads and verifies the ~223 MB
# proof-data generation once — about a minute. Every later run finds it already active and
# the one-shot returns NOOP in a few seconds.
dim "first run only: proof-params-init populates the shared proof-data cache (~223 MB, ~60s)"
if ! dc up -d --remove-orphans; then
  FAILED=1
  echo
  err "docker compose up failed. Container state and last 40 log lines follow:"
  dim "if a proof server never started, read 'dc logs proof-params-init' first — it gates them"
  dc ps -a || true
  dc logs --tail=40 || true
  echo
  info "the stack is left running for inspection — './down.sh' to stop it"
  exit 1
fi

log "waiting for services"
# Node first: the indexer cannot make progress before the chain produces blocks, and a
# node failure is the cheapest one to diagnose.
wait_compose_healthy node "$NODE_WAIT_TIMEOUT" || FAILED=1
if (( ! FAILED )); then
  wait_node_rpc "$NODE_RPC_URL" "$NODE_WAIT_TIMEOUT" || FAILED=1
fi
if (( ! FAILED )); then
  # Answering RPC is not the same as being transactable. Until finality moves off genesis
  # the toolkit refuses to build anything —
  # `GetTransactions(NodeClientError(OnlyGenesisFinalized))` — so a funding run started
  # right after up.sh would fail. Gate on it here, once, instead of making every consumer
  # rediscover it.
  wait_finalized_height "$NODE_RPC_URL" 1 "$NODE_WAIT_TIMEOUT" || FAILED=1
fi

if (( ! FAILED )); then
  # The proof-server is independent of the chain, so probe it while the indexer catches up.
  wait_tcp "$HOST_ADDR" "$PROOF_HOST_PORT" "proof-server" "$PROOF_WAIT_TIMEOUT" || FAILED=1
fi

if (( ! FAILED )); then
  wait_compose_healthy indexer "$INDEXER_WAIT_TIMEOUT" || FAILED=1
fi
if (( ! FAILED )); then
  wait_indexer_graphql "$INDEXER_GQL_URL" "$INDEXER_WAIT_TIMEOUT" || FAILED=1
fi

# Optional profiles, after the core stack they depend on. Each one waits on the thing that
# proves the profile is usable, not merely started — same rule as the core services.
if (( ! FAILED )) && [[ " $PROFILES " == *" evm "* ]]; then
  evm_defaults
  # The one-shot migration service must have run to completion (compose enforces the ordering,
  # but a FAILED migration leaves evm-rpc never started, which is worth naming explicitly).
  wait_compose_healthy evm-rpc "$EVM_WAIT_TIMEOUT" || FAILED=1
  if (( ! FAILED )); then
    wait_evm_rpc "$EVM_WAIT_TIMEOUT" || FAILED=1
  fi
  if (( ! FAILED )); then
    # A handshake, not a TCP probe: docker's port proxy accepts connections even when nothing in
    # the container is listening, so `nc -z` here would report a working WS surface that refuses
    # every client (the pinned Umbra commit contains the upstream bind fix).
    evm_ws_handshake 60 || FAILED=1
  fi
fi

if (( ! FAILED )) && [[ " $PROFILES " == *" aa "* ]]; then
  # The web console (aa-console) starts only after the aa-deploy one-shot completes
  # (compose gates it), so on a first bring-up this wait covers the deploy+mint
  # proving (~3 min) plus the console's own start.
  AA_CONSOLE_URL="http://${HOST_ADDR}:${AA_CONSOLE_HOST_PORT:-10700}"
  wait_compose_healthy aa-console "${AA_CONSOLE_WAIT_TIMEOUT:-600}" || FAILED=1
  if (( ! FAILED )) && ! curl -fsS --max-time 10 "$AA_CONSOLE_URL/healthz" | grep -q '"funded":true'; then
    # SHIELDED-FREE relay wallet (master plan T7.5 rule): unshielded NIGHT + DUST
    # only — never fund this seed with --shielded-amount. Skipped when /healthz
    # already reports it funded, so re-runs cost nothing.
    log "funding the aa-console relay wallet (unshielded NIGHT + DUST, no shielded)…"
    AA_CONSOLE_SEED="${AA_CONSOLE_SEED:-aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0}"
    if "$REPO_ROOT/scripts/fund-wallet.sh" "$AA_CONSOLE_SEED"; then
      # Synchronous re-check server-side; tell the user the outcome either way.
      if curl -fsS --max-time 120 -X POST "$AA_CONSOLE_URL/api/wallet/refresh" | grep -q '"funded":true'; then
        log "aa-console relay wallet funded and verified"
      else
        warn "aa-console wallet funded but /healthz does not report it yet — it re-checks after the first operation"
      fi
    else
      warn "funding the aa-console wallet failed — the console page works, operations will not; retry: ./scripts/fund-wallet.sh <aa-console seed>"
    fi
  fi
  # The TAKER wallet (T9.4): settles book offers from the page. Needs SHIELDED
  # NIGHT too — the want leg of AA open-swap offers is the native shielded colour.
  if (( ! FAILED )) && ! curl -fsS --max-time 10 "$AA_CONSOLE_URL/healthz" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("taker",{}).get("funded") else 1)' 2>/dev/null; then
    log "funding the aa-taker wallet (NIGHT + DUST + shielded NIGHT)…"
    AA_TAKER_SEED="${AA_TAKER_SEED:-7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e}"
    if "$REPO_ROOT/scripts/fund-wallet.sh" "$AA_TAKER_SEED" --shielded-amount "${AA_TAKER_SHIELDED_AMOUNT:-100000000}"; then
      curl -fsS --max-time 120 -X POST "$AA_CONSOLE_URL/api/wallet/refresh" >/dev/null 2>&1 || true
      log "aa-taker wallet funded"
    else
      warn "funding the aa-taker wallet failed — the book's Settle action will not work; retry: ./scripts/fund-wallet.sh <aa-taker seed> --shielded-amount 100000000"
    fi
  fi
fi

if (( ! FAILED )) && [[ " $PROFILES " == *" offerfiles "* ]]; then
  celestia_defaults
  # The container healthcheck is already a real authenticated JSON-RPC call plus a wallet-balance
  # assertion (images/celestia/healthcheck.sh), so `healthy` here genuinely means "a blob can be
  # submitted". It is still not enough on its own: it proves the RPC works on container-localhost,
  # and says nothing about the PUBLISHED port — which is where P3's loopback-bind defect lived.
  wait_compose_healthy celestia "$CELESTIA_WAIT_TIMEOUT" || FAILED=1
  if (( ! FAILED )); then
    wait_celestia_rpc 120 || FAILED=1
  fi
fi

# The shielded-night profile. `service_completed_successfully` on the deploy one-shot is what
# compose gates the web container on, and it is NOT enough on its own: it is equally satisfied
# by a one-shot that took the JOIN path against a volume from a previous chain. So the two
# things that actually matter are asserted here — the address really is on the volume, and the
# page really is serving it — and the address is named in the summary so an operator can see
# at a glance whether a `./down.sh -v` gave them a new contract.
SHIELDED_NIGHT_CONTRACT=""
if (( ! FAILED )) && [[ " $PROFILES " == *" shielded-night "* ]]; then
  wait_compose_healthy shielded-night "${SHIELDED_NIGHT_WAIT_TIMEOUT:-900}" || FAILED=1
  if (( ! FAILED )); then
    # Read through the web container, which mounts the deploy volume read-only. `|| true`
    # keeps a failed exec reportable by the assertion below instead of killing the run.
    SHIELDED_NIGHT_CONTRACT="$(dc exec -T shielded-night \
      cat /srv/shielded-night/contract.json 2>/dev/null \
      | grep -o '"address"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 | sed -e 's/.*:[[:space:]]*"//' -e 's/"$//' || true)"
    if [[ -z "$SHIELDED_NIGHT_CONTRACT" ]]; then
      err "the shielded-night-deploy one-shot published no contract address"
      FAILED=1
    fi
  fi
fi

if (( ! FAILED )) && [[ " $PROFILES " == *" solver "* ]]; then
  # A running process is not enough: it must finish kernel discovery, connect
  # to the observation sink, and publish capabilities + its first ladder.
  wait_compose_healthy solver "${SOLVER_WAIT_TIMEOUT:-300}" || FAILED=1
fi

if (( FAILED )); then
  echo
  err "stack did not come up. Last 40 log lines per service:"
  dc logs --tail=40 || true
  echo
  info "the stack is left running for inspection — './down.sh' to stop it"
  exit 1
fi

echo
log "stack is up"
info "node RPC          ${NODE_RPC_URL}"
info "indexer GraphQL   ${INDEXER_GQL_URL}"
info "indexer GraphQL WS ws://${HOST_ADDR}:${INDEXER_HOST_PORT}/api/v4/graphql/ws"
info "proof server      http://${HOST_ADDR}:${PROOF_HOST_PORT}   (plain; the aa profile's experimental one is internal)"
info "proof data        one verified generation, read-only in every proof server"
if [[ " $PROFILES " == *" evm "* ]]; then
  info "evm JSON-RPC      ${EVM_RPC_URL}   (chainId ${EVM_CHAIN_ID}, READ-ONLY)"
  info "evm WS            ws://${HOST_ADDR}:${EVM_WS_HOST_PORT}"
fi
if [[ " $PROFILES " == *" aa "* ]]; then
  info "AA web console    http://${HOST_ADDR}:${AA_CONSOLE_HOST_PORT:-10700}   (browser EVM wallet → relay → Manager.execute)"
fi
if [[ " $PROFILES " == *" offerfiles "* ]]; then
  info "celestia DA RPC   ${CELESTIA_DA_URL}   (namespace ${CELESTIA_NAMESPACE})"
  if [[ "$CELESTIA_SKIP_AUTH" != "true" && "$CELESTIA_SKIP_AUTH" != "1" ]]; then
    info "celestia token    ./scripts/celestia-token.sh    (or: exec celestia celestia-token)"
  fi
fi
if [[ " $PROFILES " == *" shielded-night "* ]]; then
  info "Shielded NIGHT     http://${HOST_ADDR}:${SHIELDED_NIGHT_HOST_PORT:-10900}   contract ${SHIELDED_NIGHT_CONTRACT:-unknown}"
fi
if [[ " $PROFILES " == *" solver "* ]]; then
  info "solver feed        http://${HOST_ADDR}:${SOLVER_SINK_HOST_PORT:-10800}   (observation-only)"
fi
echo
info "next: ./verify.sh    (health + prefunded wallet assertions)"
info "      ./down.sh -v   (stop and wipe all chain/indexer state)"
