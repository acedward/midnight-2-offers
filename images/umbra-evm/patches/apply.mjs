#!/usr/bin/env node
/**
 * Applies this demo stack's patches to a freshly fetched UmbraDB checkout, during the
 * `images/umbra-evm` image build.
 *
 *   node /patches/apply.mjs <checkout-root>
 *
 * WHY NOT `git apply`
 * -------------------
 * A context diff either applies, applies fuzzily somewhere unintended, or fails with a message
 * about line numbers. These patches instead match one EXACT, unique anchor string and refuse to
 * do anything if that string is not present exactly once — so an upstream change that moves the
 * anchor fails the BUILD with a message naming the anchor, rather than producing a half-patched
 * image that misbehaves at runtime. Loud beats fuzzy.
 *
 * WHAT IS PATCHED, AND WHY
 * ------------------------
 * Both patches are in `evm-rpc/serve-all.ts`, and both are about the WebSocket surface being
 * unusable in a container as shipped.
 *
 * 1. THE WS SERVER BINDS CONTAINER-LOOPBACK, SO NOTHING CAN REACH IT.
 *    `evm-rpc/logs/ws.ts` declares `listen(port: number, host = "127.0.0.1")`.
 *    `createSubscribeServer` passes `options.host` straight through, but `serve-all.ts` never
 *    sets it — so the default wins and the `eth_subscribe` server listens on 127.0.0.1 INSIDE
 *    the container. Docker's published-port proxy connects to the container's bridge IP, not to
 *    its loopback, so every connection is refused. It fails in the most confusing way possible: a
 *    TCP probe of the published port SUCCEEDS (docker-proxy accepts before it dials the
 *    container), and the client then sees an abnormal close 1006 with no server-side log. The
 *    HTTP server has no such problem because serve-all does pass it `EVM_RPC_HOST` (0.0.0.0).
 *    Fixed by threading a host through, defaulting to the same one the HTTP server uses.
 *
 * 2. `newHeads` HAS NO CHAIN-HEAD SOURCE.
 *    With no `blockSource`, `createSubscribeServer` falls back to `createLogsTableBlockSource`,
 *    which can only announce a block that produced a WATCHED CONTRACT LOG. This demo stack is a
 *    read-only façade with an empty `watch.json`, so that source is silent forever and
 *    `eth_subscribe("newHeads")` returns a subscription id that never delivers a header. See
 *    patches/indexer-head-source.ts for the derivation and for the upstream comment that
 *    anticipates exactly this injection.
 *
 * Everything else about UmbraDB runs unmodified. In particular NOTHING here touches the write
 * path: `RELAY_URL` is left exactly as upstream has it (unset ⇒ `eth_sendRawTransaction` is never
 * registered), which is the demo's read-only decision (plan Q2) enforced by configuration rather
 * than by a patch.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const patchDir = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
if (root === undefined) {
  console.error("usage: node apply.mjs <checkout-root>");
  process.exit(2);
}

/** Replaces `anchor` with `replacement` in `file`, requiring exactly one occurrence. */
function rewriteOnce(file, { anchor, replacement, why }) {
  const path = resolve(root, file);
  const before = readFileSync(path, "utf8");
  const occurrences = before.split(anchor).length - 1;
  if (occurrences !== 1) {
    console.error(
      `\napply.mjs: REFUSING TO PATCH ${file}\n` +
        `  reason : ${why}\n` +
        `  anchor : found ${occurrences} time(s), expected exactly 1\n` +
        `  anchor text:\n${anchor.replace(/^/gm, "    | ")}\n\n` +
        `  Upstream moved this code. Re-derive the patch against the current UMBRA_REF and update\n` +
        `  images/umbra-evm/patches/apply.mjs — do NOT relax the anchor to make the build pass.\n`,
    );
    process.exit(1);
  }
  writeFileSync(path, before.replace(anchor, replacement), "utf8");
  console.log(`apply.mjs: patched ${file} (${why})`);
}

// ── 1. the newHeads block source module ──────────────────────────────────────────────────────
copyFileSync(
  resolve(patchDir, "indexer-head-source.ts"),
  resolve(root, "evm-rpc/logs/indexer-head-source.ts"),
);
console.log("apply.mjs: added evm-rpc/logs/indexer-head-source.ts");

// ── 2. import it in serve-all.ts ─────────────────────────────────────────────────────────────
rewriteOnce("evm-rpc/serve-all.ts", {
  why: "import the indexer-head newHeads source",
  anchor: 'import { backfillWatched } from "./logs/backfill.js";',
  replacement:
    'import { backfillWatched } from "./logs/backfill.js";\n' +
    '// demo-infra: a real chain-head source for eth_subscribe("newHeads") — see\n' +
    "// images/umbra-evm/patches/indexer-head-source.ts.\n" +
    'import { createIndexerHeadBlockSource } from "./logs/indexer-head-source.js";',
});

// ── 3. bind address + block source for the subscribe server ──────────────────────────────────
// One rewrite for both fixes, because they touch the same options object.
//
// `sql`/`schema` are deliberately KEPT: they are what the logs-table fallback would have used,
// and `createSubscribeServer` ignores them once an explicit blockSource is supplied. Leaving them
// in keeps the diff to two added options.
//
// `host` reuses serve-all's own `host` const (EVM_RPC_HOST ?? "0.0.0.0") so the two listeners
// cannot drift apart, with EVM_RPC_WS_HOST as an override for anyone who wants them different.
rewriteOnce("evm-rpc/serve-all.ts", {
  why: 'bind the eth_subscribe server to a reachable address and give "newHeads" the indexer head',
  anchor:
    "const wsServer = createSubscribeServer({\n" +
    "  port: logsEnv.evmRpcWsPort,\n" +
    "  sql,\n" +
    "  schema: logsEnv.schema,\n",
  replacement:
    "const wsServer = createSubscribeServer({\n" +
    "  port: logsEnv.evmRpcWsPort,\n" +
    "  // demo-infra: without this, ws.ts's `host = \"127.0.0.1\"` default makes the WS server\n" +
    "  // unreachable from outside the container. See images/umbra-evm/patches/apply.mjs.\n" +
    "  host: process.env.EVM_RPC_WS_HOST ?? host,\n" +
    "  sql,\n" +
    "  schema: logsEnv.schema,\n" +
    "  // demo-infra: a real chain head, instead of the logs-table fallback that can only ever\n" +
    "  // announce blocks carrying a watched contract log.\n" +
    "  blockSource: createIndexerHeadBlockSource(indexer, {\n" +
    '    onError: (error: Error) => log("newheads-error", { message: error.message }),\n' +
    "  }),\n",
});

console.log("apply.mjs: all patches applied");
