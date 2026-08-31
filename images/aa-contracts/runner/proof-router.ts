// proof-router.ts — a routing shim between two proof servers, born of a
// measured incompatibility (master plan T7.5, e2e runs 2–9): the wallet-SDK's
// proving bridge emits a CONSTANT standard-lane zswap-cc[v1] /check on every
// debit-shaped Manager `execute` tx, and the experimental server's v3
// zswap-cc build rejects its input layout ("Inputs did not match alignment:
// b21b32b32b16b1b32") — while that same server proves the v7 contract circuits
// and dust just fine. Everything forwards to the experimental server EXCEPT
// /check bodies carrying the standard zswap-cc marker, which go to the plain
// core server. Delete when either side fixes the layout mismatch upstream.

const EXP = process.env["ROUTER_EXPERIMENTAL"] ?? "http://aa-proof-server:6300";
const PLAIN = process.env["ROUTER_PLAIN"] ?? "http://proof-server:6300";
const MARK = new TextEncoder().encode("midnight:zswap-cc[v1]");

const has = (buf: Uint8Array, pat: Uint8Array): boolean => {
  outer: for (let i = 0; i + pat.length <= buf.length; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
};

Bun.serve({
  port: 6300,
  hostname: "0.0.0.0",
  maxRequestBodySize: 4 * 1024 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
    // PATH-BASED routing (v2, after content-routing failed): a debit tx's
    // /check is ONE request carrying BOTH the v7 execute piece and a
    // standard-lane zswap-cc piece (185 KB + ~755 B — the v3 parser misreads
    // the standard fragment, whose "inputs" include the BLS12-381 scalar
    // modulus little-endian). Unsplittable by content — so ALL /check goes to
    // the PLAIN server and ALL /prove to the experimental one. The content
    // matcher stays as a log annotation only.
    let target = url.pathname === "/check" ? PLAIN : EXP;
    const marked = url.pathname === "/check" && body && has(body, MARK);
    if (marked) console.log("[router] (check carries the standard zswap-cc marker)");
    console.log(
      `[router] ${req.method} ${url.pathname} (${body?.length ?? 0}B) -> ${target === EXP ? "experimental" : "plain"}`,
    );
    return await fetch(target + url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
      body,
    });
  },
});
console.log(`[router] listening on :6300 (exp=${EXP}, plain=${PLAIN})`);
