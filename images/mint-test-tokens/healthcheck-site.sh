#!/usr/bin/env bash
# The faucet-site container's healthcheck. A script rather than a CMD-SHELL one-liner because
# the three probes below need quoting that does not survive a YAML scalar intact — and a
# healthcheck that silently degrades to "the shell parsed something" is worse than none.
#
# THREE PATHS, because they prove three different things:
#
#   /                              the server is up and dist/ was copied.
#
#   /metadata.undeployed.json      THE VOLUME IS MOUNTED AND READ THROUGH. This path is served
#                                  from MINT_METADATA_DIR, not from dist/ — and the image build
#                                  asserts dist/ carries no copy of it — so a body here can only
#                                  be this stack's own published registry. It is matched on
#                                  `"status": "ready"` AND on six active deployments, not merely
#                                  fetched: a stale or partially published registry answers 200
#                                  just as happily, and a page over one of those shows six
#                                  unavailable tokens with every mint control disabled.
#
#   contract/v2/receiver/…bzkir    the ZK artifact lane is served as BYTES. serve-static.mjs
#                                  answers a missing path THAT HAS AN EXTENSION as a real 404
#                                  rather than with the SPA shell, so an empty body here means
#                                  the browser adapter could never prove a contract mint.
set -euo pipefail

PORT="${MINT_SITE_PORT:-14119}"
NETWORK="${MN_NETWORK:-undeployed}"

BASE="http://127.0.0.1:${PORT}" NETWORK="${NETWORK}" exec node -e '
  const base = process.env.BASE;
  const network = process.env.NETWORK;

  const shell = await fetch(`${base}/`).catch(() => null);
  if (!shell || !shell.ok) { console.error("GET / failed"); process.exit(1); }

  const reg = await fetch(`${base}/metadata.${network}.json`).catch(() => null);
  if (!reg || !reg.ok) { console.error(`GET /metadata.${network}.json failed`); process.exit(1); }
  const doc = await reg.json().catch(() => null);
  if (!doc || doc.status !== "ready") {
    console.error(`registry status is ${doc ? doc.status : "unreadable"}, not ready`);
    process.exit(1);
  }
  const active = (doc.tokens ?? []).filter((t) =>
    (t.deployments ?? []).some((d) => d.deploymentId === t.activeDeploymentId && d.status === "active"));
  if (active.length !== 6) {
    console.error(`registry has ${active.length} active deployments, expected 6`);
    process.exit(1);
  }

  const art = await fetch(`${base}/contract/v2/receiver/zkir/receiveShieldedTokenFromIssuer.bzkir`).catch(() => null);
  if (!art || !art.ok) { console.error("v2 receiver artifact is not served"); process.exit(1); }
  const bytes = await art.arrayBuffer();
  if (bytes.byteLength === 0) { console.error("v2 receiver artifact served 0 bytes"); process.exit(1); }
'
