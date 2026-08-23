#!/usr/bin/env bash
#
# Print the DA RPC's auth token.
#
#   docker compose ... exec -T celestia celestia-token         # the token
#   docker compose ... exec -T celestia celestia-token --env   # the whole handoff file
#
# This is the "exec-based helper" half of the auth-token handoff. The other half — the one a
# CONTAINER uses — is the file this reads, on the shared `celestia-auth` volume:
#
#   /celestia/auth/token        the raw JWT, one line, no trailing newline
#   /celestia/auth/celestia.env RPC url + token + namespace + network, as KEY=value
#
# Why a file and not a compose environment variable: the token does not exist until the bridge
# node's store has been initialised, which happens inside the container long after compose has
# finished evaluating `environment:` and `env_file:` on the host. So the consumer reads it at
# startup instead — one line in an entrypoint:
#
#   set -a; . /celestia/auth/celestia.env; set +a
#
# and `depends_on: {celestia: {condition: service_healthy}}` guarantees the file is there and its
# token valid, because the healthcheck itself uses that token.
#
set -euo pipefail

AUTH_DIR="${CELESTIA_AUTH_DIR:-/celestia/auth}"

case "${1:-token}" in
  token)
    [[ -s "${AUTH_DIR}/token" ]] || { echo "celestia-token: no token at ${AUTH_DIR}/token" >&2; exit 1; }
    cat "${AUTH_DIR}/token"; printf '\n' ;;
  --env)
    [[ -s "${AUTH_DIR}/celestia.env" ]] || { echo "celestia-token: no ${AUTH_DIR}/celestia.env" >&2; exit 1; }
    cat "${AUTH_DIR}/celestia.env" ;;
  *)
    echo "celestia-token: unknown argument '${1}' (token|--env)" >&2; exit 2 ;;
esac
