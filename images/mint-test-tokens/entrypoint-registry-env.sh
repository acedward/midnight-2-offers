#!/usr/bin/env bash
# registry-env — turn THIS stack's published token registry into an env file the
# rest of the stack can source.
#
# WHY IT EXISTS. Since kernel PRs #69/#70 every consumer of a token needs an
# EXPLICIT 64-hex token ID: the offer poster (`GIVE_TOKEN`/`WANT_TOKEN`),
# solver-provision (`SOLVER_PROVISION_TOKEN_IN/OUT`), the maker one-shot and the
# E2E driver. `poster-config.ts` states it as rule 3 — "TOKEN IDS ARE EXPLICIT"
# — because there is no contract left to derive a colour from. But those IDs are
# a property of the chain THIS bring-up just created: they cannot be written into
# `.env.example`, and they do not exist until `faucet-deploy` has published the
# registry. Something has to carry them from the registry to the services, and
# this is that something.
#
# WHY AN ENV FILE ON A VOLUME AND NOT compose `env_file:`. Compose reads
# `env_file:` on the HOST at render time — before any container has run, and
# with no access to a named volume. The file simply does not exist yet at the
# moment Compose would need it. See the option table in the project's questions
# file (Q9): the alternatives are a two-phase bring-up (up, read the volume from
# the host, re-up) or a host bind-mount, and both trade the atomic-rename
# property and the one-volume-per-stack isolation for nothing. Consumers mount
# `faucet-registry` read-only and their entrypoints source this file.
#
# WHAT IT WRITES. One block per token, keyed by the registry SYMBOL upper-cased:
#
#     TWBTC_TOKEN_ID=<64 hex>
#     TWBTC_DECIMALS=8
#     TWBTC_PRIVACY=shielded
#     TWBTC_CONTRACT_ADDRESS=<issuer>
#
# and then the ROLE defaults, resolved from symbols this service is given in
# compose. The role names are the ones upstream's `deploy/.env.example` uses, so
# an operator reading either file sees the same names.
#
# IDEMPOTENT, and CHEAP: it opens no wallet, proves nothing and touches no
# chain. It re-renders on every bring-up because the registry may have moved
# (a `./down.sh -v` gives every token a new colour), and it publishes by
# ATOMIC RENAME for the same reason upstream's own publisher does — a consumer
# that sources this file must never see half of it.

# Consumed by log() in the sourced prelude, which shellcheck cannot see from here.
# shellcheck disable=SC2034
ROLE=registry-env
# shellcheck source=images/mint-test-tokens/entrypoint-common.sh
. /usr/local/lib/mint-test-tokens/entrypoint-common.sh

STACK_TOKENS_ENV="${STACK_TOKENS_ENV:-${REGISTRY_DIR}/stack-tokens.env}"

[ -f "${REGISTRY_FILE}" ] \
  || die "no ${REGISTRY_FILE} — faucet-deploy must complete first"

# The role → symbol map. Every one is optional: an unset symbol simply omits its
# pair of lines, and a symbol the registry does not carry is a hard failure
# (a typo must not silently produce a file the poster then reports as missing).
render() {
  REG_FILE="${REGISTRY_FILE}" \
  OUT_FILE="${STACK_TOKENS_ENV}.tmp" \
  ROLE_MAP="poster:OFFER_POSTER_GIVE_TOKEN=${POSTER_GIVE_SYMBOL:-},OFFER_POSTER_WANT_TOKEN=${POSTER_WANT_SYMBOL:-};solver:SOLVER_PROVISION_TOKEN_IN=${SOLVER_TOKEN_IN_SYMBOL:-},SOLVER_PROVISION_TOKEN_OUT=${SOLVER_TOKEN_OUT_SYMBOL:-};maker:MAKER_OFFER_GIVE_TOKEN=${MAKER_GIVE_SYMBOL:-},MAKER_OFFER_WANT_TOKEN=${MAKER_WANT_SYMBOL:-};e2e:E2E_TOKEN_IN=${E2E_TOKEN_IN_SYMBOL:-},E2E_TOKEN_OUT=${E2E_TOKEN_OUT_SYMBOL:-}" \
  node -e '
    const fs = await import("node:fs/promises");
    const doc = JSON.parse(await fs.readFile(process.env.REG_FILE, "utf8"));
    if (doc.status !== "ready") { console.error(`registry is ${doc.status}, not ready`); process.exit(1); }

    const key = (symbol) => symbol.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const bySymbol = new Map();
    const lines = [];
    for (const token of doc.tokens ?? []) {
      const active = (token.deployments ?? []).find(
        (d) => d.deploymentId === token.activeDeploymentId && d.status === "active");
      if (!active) { console.error(`${token.symbol}: no active deployment`); process.exit(1); }
      const id = String(active.tokenId ?? "").toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(id)) {
        console.error(`${token.symbol}: tokenId is not a 64-hex colour: ${active.tokenId}`);
        process.exit(1);
      }
      if (token.privacy !== "shielded" && token.privacy !== "unshielded") {
        console.error(`${token.symbol}: unknown privacy ${token.privacy}`); process.exit(1);
      }
      if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 38) {
        console.error(`${token.symbol}: decimals out of range: ${token.decimals}`); process.exit(1);
      }
      // A shell name, not a shell VALUE: the whole file is `source`d, so a
      // symbol carrying anything but [A-Za-z0-9._-] could smuggle a command in
      // through the key. Rejected rather than sanitised.
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(token.symbol)) {
        console.error(`${token.symbol}: symbol is not a usable shell key`); process.exit(1);
      }
      const k = key(token.symbol);
      bySymbol.set(token.symbol, { k, id });
      lines.push(`${k}_TOKEN_ID=${id}`);
      lines.push(`${k}_DECIMALS=${token.decimals}`);
      lines.push(`${k}_PRIVACY=${token.privacy}`);
      lines.push(`${k}_CONTRACT_ADDRESS=${String(active.contractAddress ?? "").replace(/^0x/, "")}`);
      lines.push("");
    }
    if (bySymbol.size === 0) { console.error("registry carries no tokens"); process.exit(1); }

    const roles = [];
    for (const group of (process.env.ROLE_MAP ?? "").split(";")) {
      const [label, spec] = group.split(":");
      if (!spec) continue;
      const rendered = [];
      for (const pair of spec.split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq);
        const symbol = pair.slice(eq + 1).trim();
        if (symbol === "") continue;
        const hit = bySymbol.get(symbol);
        if (!hit) {
          console.error(`${name}: symbol "${symbol}" is not in this registry (have: ${[...bySymbol.keys()].join(", ")})`);
          process.exit(1);
        }
        rendered.push(`${name}=${hit.id}`);
      }
      if (rendered.length) roles.push(`# ${label}`, ...rendered, "");
    }

    const header = [
      "# stack-tokens.env — GENERATED by the `registry-env` one-shot. Do not edit.",
      "#",
      "# Source: " + process.env.REG_FILE,
      "# Registry revision: " + (doc.registryRevision ?? doc.revision ?? "<none>"),
      "# Network: " + (doc.network?.key ?? "<unknown>") + " / " + (doc.network?.protocolFamily ?? "?"),
      "# Rendered: " + new Date().toISOString(),
      "#",
      "# Every value below belongs to THIS chain. `./down.sh -v` throws the chain",
      "# away and the next bring-up renders different ids.",
      "",
    ];
    await fs.writeFile(process.env.OUT_FILE, header.concat(lines, roles).join("\n"), { mode: 0o644 });
    process.stdout.write(String(bySymbol.size));
  '
}

COUNT="$(render)" || die "could not render ${STACK_TOKENS_ENV} from ${REGISTRY_FILE}"

# ATOMIC. A consumer sourcing a half-written file would get half a token id.
mv -f "${STACK_TOKENS_ENV}.tmp" "${STACK_TOKENS_ENV}"
chmod 0644 "${STACK_TOKENS_ENV}"

log "OK: ${STACK_TOKENS_ENV} rendered — ${COUNT} tokens"
grep -E '^[A-Z0-9_]+=' "${STACK_TOKENS_ENV}" | while IFS='=' read -r k v; do
  case "${k}" in
    *_TOKEN_ID|OFFER_POSTER_*|SOLVER_PROVISION_*|MAKER_OFFER_*|E2E_TOKEN_*) log "  ${k}=${v:0:16}…" ;;
    *) log "  ${k}=${v}" ;;
  esac
done
exit 0
