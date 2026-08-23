/**
 * Asserts that `eth_subscribe("newHeads")` over the WS surface actually DELIVERS a header.
 *
 *   npx tsx tools/ws-newheads.ts <ws-url> [timeout-seconds]
 *
 * Exit 0 and print the header JSON on success; exit 1 with a reason otherwise. Used by
 * `verify.sh`'s `evm` section.
 *
 * Why a tool in the image rather than a host-side check: the host has no guaranteed WebSocket
 * client (no `wscat`, and `curl` cannot speak the subscription protocol), whereas Node 24 ships a
 * global `WebSocket`. Running it inside the compose network also means the check needs no
 * published port, which matters because the host ports are bound to 127.0.0.1 and are therefore
 * unreachable from a container.
 *
 * The distinction this check exists to catch: subscribing SUCCEEDS trivially — the server returns
 * a subscription id for any `newHeads` request regardless of whether a block source is wired up.
 * Only the arrival of a header proves the source is real. That is exactly the failure mode the
 * demo stack patches around (see images/umbra-evm/patches/indexer-head-source.ts), so accepting
 * the subscription id as the pass condition would test nothing.
 */
const url = process.argv[2];
const timeoutSeconds = Number(process.argv[3] ?? "45");

if (url === undefined) {
  console.error("usage: npx tsx tools/ws-newheads.ts <ws-url> [timeout-seconds]");
  process.exit(2);
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error("ws-newheads: timeout must be a positive number of seconds");
  process.exit(2);
}

const fail = (reason: string): never => {
  console.error(`ws-newheads: FAIL ${reason}`);
  process.exit(1);
};

const socket = new WebSocket(url);
let subscriptionId: string | undefined;

const timer = setTimeout(() => {
  fail(
    subscriptionId === undefined
      ? `no subscription confirmed within ${timeoutSeconds}s (url=${url})`
      : `subscription ${subscriptionId} confirmed but NO newHeads header arrived within ${timeoutSeconds}s ` +
        "— the server accepted the subscription and has no working block source",
  );
}, timeoutSeconds * 1_000);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
});

socket.addEventListener("error", () => fail(`websocket transport error (url=${url})`));
socket.addEventListener("close", (event) => {
  if (subscriptionId === undefined) fail(`websocket closed before subscribing (${event.code})`);
});

socket.addEventListener("message", (raw) => {
  const text = typeof raw.data === "string" ? raw.data : Buffer.from(raw.data as ArrayBuffer).toString("utf8");
  let message: { id?: unknown; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: unknown } };
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    fail(`malformed JSON on the wire: ${text.slice(0, 200)}`);
    return;
  }

  if (message.error !== undefined) fail(`server error: ${JSON.stringify(message.error)}`);

  if (message.id === 1) {
    if (typeof message.result !== "string") fail(`eth_subscribe did not return a subscription id: ${text}`);
    subscriptionId = message.result as string;
    console.log(`ws-newheads: subscribed id=${subscriptionId}`);
    return;
  }

  if (message.method === "eth_subscription") {
    const header = message.params?.result as { number?: unknown; hash?: unknown } | undefined;
    if (header === undefined || typeof header.number !== "string" || typeof header.hash !== "string") {
      fail(`newHeads payload is not a header: ${text.slice(0, 300)}`);
      return;
    }
    clearTimeout(timer);
    console.log(`ws-newheads: OK ${JSON.stringify(header)}`);
    socket.close(1000, "done");
    process.exit(0);
  }
});
