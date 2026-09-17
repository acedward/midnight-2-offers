#!/usr/bin/env bash
#
# Build the `signet` profile's MPC responder image, standalone.
#
#   ./scripts/build-fakenet-image.sh                      # midnight-2-offers/signet-fakenet:local
#   ./scripts/build-fakenet-image.sh --tag <name:tag>      # …under another name
#   ./scripts/build-fakenet-image.sh --ref <40-hex sha>    # …from another commit of the fork
#   ./scripts/build-fakenet-image.sh --print               # just say what would be built
#
# `./up.sh --with aa --with signet --build` builds the same image through compose; this script
# exists so it can be built WITHOUT a stack — in CI, on a fresh clone, or to refresh it after the
# fork moves — and so the provenance is stated in one place a person can read.
#
# WHAT IS BEING BUILT. acedward/solana-signet-program, branch `00034-trace-fallback`, pinned
# commit a1a7798f… — our fork of sig-net/solana-signet-program (MIT; fork PR #1), which is
# upstream `develop` @ 13fd0e8e (tag fakenet-v0.23.0, the commit behind
# ghcr.io/sig-net/fakenet:0.23.0) plus two local patches:
#
#   58c39d5  `eth_call` replay when the RPC has no debug_traceTransaction (project 00034, Q62).
#            DEMO-GRADE: a replay reads pre-block state, so a call whose result depends on
#            same-block writes could differ from the mined trace the real MPC signs. For one
#            ERC20 `transfer` from an address nothing else touches it does not. With a traced
#            endpoint the image takes the upstream path unchanged.
#   a1a7798  MIDNIGHT_CALLER_ALLOWLIST (project 00034, Q64): serve only caller contracts we own.
#            Unset keeps upstream behaviour exactly.
#
# The image asserts both patches are present at build time, so a ref that moved back to upstream
# fails the build rather than producing a responder that cannot attest and answers everyone.
#
# NOTHING SECRET IS BAKED IN: the MPC root key, the EVM RPC URL and the responder's wallet seed
# all arrive at run time.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

# Defaults MUST agree with compose/signet.yml's build args; verify-source-pins.sh keeps them
# honest by asserting the commit baked into a built image.
REPO_URL="${SIGNET_FAKENET_REPO:-https://github.com/acedward/solana-signet-program.git}"
REF="${SIGNET_FAKENET_REF:-a1a7798f35cab07d5279cfd9785777944b94a572}"
TAG="${SIGNET_FAKENET_IMAGE:-midnight-2-offers/signet-fakenet:local}"
PRINT_ONLY=0
NO_CACHE=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)      TAG="${2:?--tag needs an image name}"; shift 2 ;;
    --ref)      REF="${2:?--ref needs a commit}"; shift 2 ;;
    --repo)     REPO_URL="${2:?--repo needs a git url}"; shift 2 ;;
    --no-cache) NO_CACHE=(--no-cache); shift ;;
    --print)    PRINT_ONLY=1; shift ;;
    -h|--help)  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

require_docker

log "signet responder image"
info "  source ${REPO_URL}"
info "  ref    ${REF}"
info "  image  ${TAG}"
(( PRINT_ONLY )) && exit 0

docker build ${NO_CACHE[@]+"${NO_CACHE[@]}"} \
  -t "$TAG" \
  --build-arg "SIGNET_FAKENET_REPO=${REPO_URL}" \
  --build-arg "SIGNET_FAKENET_REF=${REF}" \
  "$REPO_ROOT/images/signet-fakenet"

# The commit is baked in so a running container can be asked what it is, rather than trusted to
# be what a tag once meant. Read it back here: a cache hit on a stale layer would otherwise be
# indistinguishable from a fresh build.
BUILT="$(docker run --rm --entrypoint cat "$TAG" /app/.signet-fakenet-commit 2>/dev/null | tr -d '\r\n')"
if [[ "$BUILT" == "$REF" ]]; then
  ok "built ${TAG} from ${BUILT}"
else
  err "the built image reports commit '${BUILT}', not the requested '${REF}'"
  exit 1
fi
info "  run it with: ./up.sh --with aa --with signet   (needs SIGNET_EVM_RPC_URL in the env file)"
