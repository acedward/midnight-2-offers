#!/bin/sh
#
# Wait for this stack's contract address, write /config.js, then exec nginx.
#
# THE PROBLEM THIS SOLVES. shielded-night bakes one contract address per network into the
# bundle at build time (`<NETWORK>_ADDRESS`, via vite's envPrefix). That is right for its
# hosted deployments and impossible here: this image is built once and run against throwaway
# devnets whose contract does not exist until the `shielded-night-deploy` one-shot has run.
# Upstream's runtime-config lane resolves `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS` ahead of
# the build-time value; this script is what writes that global.
#
# IT WRITES TWO KEYS, NOT ONE. Since the re-pin to `main` (upstream PR #16) the same lane
# also carries UNDEPLOYED_PROTOCOL, which selects the ledger generation the local network
# runs. Its default is `midnight-1.x`; this stack is ledger-9, so the value is written
# explicitly — see the block that composes the file.
#
# IT WAITS RATHER THAN GUESSING. compose gates this container on the one-shot's
# `service_completed_successfully`, but that is not the only way it starts: a restart policy,
# a `docker compose up` on a stack whose core is already running, or a manual `restart` can
# all bring it up while the volume is still empty. Writing an empty config there would produce
# a container that passes a naive healthcheck and shows a page with no network to select. So:
# block, bounded, and fail loudly on timeout.
#
# POSIX sh: the nginx alpine base has no bash.
set -eu

CONTRACT_FILE="${CONTRACT_SHARE_DIR:-/srv/shielded-night}/contract.json"
TARGET=/usr/share/nginx/html/config.js
TIMEOUT="${SHIELDED_NIGHT_WAIT_TIMEOUT:-600}"

log() { echo "[shielded-night-web] $*" >&2; }
die() { log "FATAL: $*"; exit 1; }

waited=0
while [ ! -f "${CONTRACT_FILE}" ]; do
    if [ "${waited}" -ge "${TIMEOUT}" ]; then
        die "TIMEOUT after ${TIMEOUT}s waiting for ${CONTRACT_FILE} — the shielded-night-deploy one-shot has published no contract address"
    fi
    [ "$(( waited % 30 ))" -eq 0 ] && log "waiting for ${CONTRACT_FILE} (${waited}s/${TIMEOUT}s)"
    waited=$(( waited + 2 ))
    sleep 2
done

# grep/sed rather than a JSON parser: this image is nginx:alpine and carries neither node nor
# python, and the record is written by one known producer.
ADDRESS="$(grep -o '"address"[[:space:]]*:[[:space:]]*"[^"]*"' "${CONTRACT_FILE}" \
           | head -1 \
           | sed -e 's/.*:[[:space:]]*"//' -e 's/"$//')" || ADDRESS=""
[ -n "${ADDRESS}" ] || die "${CONTRACT_FILE} carries no \"address\""

# THE VALUE IS INTERPOLATED INTO A JAVASCRIPT STRING LITERAL served to every visitor, so it is
# validated rather than trusted. A Midnight contract address is hex; anything else — a quote,
# a backslash, a newline — would not merely break the page, it would inject script into the
# browser of anyone who opens it. The producer is our own one-shot, which is exactly why the
# check costs nothing and turns a corrupted volume into a startup failure.
case "${ADDRESS}" in
    *[!0-9a-fA-F]*)
        die "contract address is not hex: '${ADDRESS}'"
        ;;
esac
if [ "${#ADDRESS}" -lt 16 ]; then
    die "contract address is implausibly short (${#ADDRESS} chars): '${ADDRESS}'"
fi

# THE PROTOCOL SWITCH IS THE SECOND HALF, and on this stack it is not optional. Upstream's
# `undeployed` network defaults to `midnight-1.x` — the ledger-v8 adapter — because that is what
# a local devnet has always been for this dApp. THIS devnet is ledger-9 (node 2.0.0-rc.4 /
# indexer 4.4.0-rc.3 / proof-server 9.0.0-rc.5), so without this line the page would load, show
# "Local (undeployed)", connect a wallet, and then fail every call with an error naming none of
# it. With it, networks.ts resolves the row to midnight-2.x, labels it "Local (undeployed · 2.x)"
# and loads frontend/protocols/v2.
#
# It is a CONSTANT here rather than an env knob: this profile has exactly one chain and its
# generation is a property of the images compose/core.yml pins, not an operator preference. An
# unrecognised value is reported on the page and blocks Connect (upstream refuses to guess),
# which is one more reason not to make it settable from the outside.
PROTOCOL='midnight-2.x'

{
    printf '%s\n' '// Generated at container start by images/shielded-night/entrypoint-web.sh.'
    printf '%s\n' '// The contract this stack deployed and the ledger generation its chain runs;'
    printf '%s\n' '// both resolved ahead of the build-time values by frontend/src/lib/runtime-config.ts.'
    printf 'window.SHIELDED_NIGHT = { UNDEPLOYED_PROTOCOL: "%s", UNDEPLOYED_ADDRESS: "%s" };\n' \
        "${PROTOCOL}" "${ADDRESS}"
} > "${TARGET}"

log "contract ${ADDRESS} on ${PROTOCOL}"
log "wrote ${TARGET}:"
sed 's/^/    /' "${TARGET}" >&2

exec nginx -g 'daemon off;'
