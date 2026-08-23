#!/usr/bin/env bash
#
# Print the Celestia DA RPC's auth token, or the whole handoff file, from the host.
#
#   ./scripts/celestia-token.sh          # the token
#   ./scripts/celestia-token.sh --env    # the KEY=value handoff the kernel will source
#   ./scripts/celestia-token.sh --curl   # a ready-to-paste curl against the DA RPC
#
# The token is minted inside the container (it is a JWT signed with a secret in the bridge node's
# store, which does not exist until that store is initialised) and written to the shared
# `celestia-auth` volume. Nothing on the host can compute it — so this asks the container.
#
# ENV_FILE=<path> selects a different stack instance, as everywhere else.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/celestia.sh
source "$REPO_ROOT/scripts/lib/celestia.sh"

MODE="${1:-token}"

require_docker
load_env
use_all_profiles
celestia_defaults

case "$MODE" in
  token)
    TOKEN="$(celestia_token || true)"
    [[ -n "$TOKEN" ]] || die "no auth token — is the celestia service up? (./up.sh --with offerfiles)"
    printf '%s\n' "$TOKEN" ;;
  --env)
    dc exec -T celestia celestia-token --env ;;
  --curl)
    TOKEN="$(celestia_token || true)"
    [[ -n "$TOKEN" ]] || die "no auth token — is the celestia service up? (./up.sh --with offerfiles)"
    cat <<EOF
curl -sS ${CELESTIA_DA_URL} \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${TOKEN}' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"header.NetworkHead","params":[]}'
EOF
    ;;
  -h|--help)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)
    err "unknown argument: $MODE"; exit 2 ;;
esac
