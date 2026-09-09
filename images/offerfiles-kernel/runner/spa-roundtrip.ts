// spa-roundtrip.ts — the swap SPA's make/take round trip, headless.
//
//   (scripts/verify-spa-roundtrip.sh runs this; ci-check.sh step 4e calls that.)
//
// ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
// Two things in this stack were proved by a human in a browser and by nothing else:
//
//   1. the zswap-da SPA can TAKE an offer from the book and MAKE one of its own, with its
//      in-page wallet, on the six local test tokens;
//   2. the batcher's `midnight-balancer` target works — the SPONSORED settlement path.
//
// (2) is the one that no other gate step reaches. The offer poster does exercise the batcher,
// but only its `celestia` target: `POST /v1/offers` -> validate -> batch -> blob -> indexed.
// The taker's half is a different code path in a different adapter: the taker balances the
// merged maker transaction with NO DUST of its own (`tokenKindsToBalance` omits dust,
// `payFees:false` on the maker side) and posts the finalized bytes to
// `POST ${BATCHER_URL}/send-input`, where the batcher pays the fee if the pair is priced.
// Nothing in the gate did that.
//
// ── WHY THIS AND NOT A HEADLESS BROWSER ────────────────────────────────────
// The SPA is a React bundle that drives a wallet facade in the page. There is no browser in
// this gate and adding one would test the renderer, not the protocol. What CAN break, and
// what this reproduces exactly, is everything below the renderer:
//
//   * the SPA's RUNTIME CONFIGURATION. The seed and the network id are read from the frontend
//     container's own served `/config.js` — the same bytes the page reads — so the wallet this
//     settles with IS the wallet the page would connect, and the `spa` grant that funds it is
//     asserted on the way past.
//   * the SPA's WIRE CONTRACT with the batcher, byte for byte: the same `/send-input` body,
//     the same `addressType: 5`, the same `txStage: "finalized"`, the same
//     `confirmationLevel: "wait-receipt"`, the same target.
//   * the SPA's SEQUENCE, from src/services/localTradeOffers.ts: decode -> (merge) ->
//     balanceFinalizedTransaction(value legs only) -> finalizeRecipe -> ONE batcher submit for
//     the take; initSwap(payFees:false) -> finalize -> MIP-0005 encode -> POST /v1/offers for
//     the make.
//
// It runs in the KERNEL image because that is where the pinned wallet SDK, the ledger-v9 wasm
// and the MIP-0005 codec already are, and because `packages/solver-core/wallet.ts` in the
// pinned tree already has the facade helpers (`buildWalletFacade` WITHOUT a funds wait — this
// wallet holds no NIGHT and never will; both halves of its swap are fee-free by design).
//
// Exit 0 only when: the take settled through the batcher, the wallet's shielded balances moved
// by exactly the two legs, and the SPA's own new offer reached `live` in the kernel's book.

// ── issue 00020: never let bun auto-install a pinned dependency ─────────────
// `await import("<pkg>")` succeeds for a package that is NOT installed when the process has
// network access — bun fetches whatever npm resolves, at run time, into ~/.bun/install/cache.
// For ledger-v9 that would silently swap the wasm this stack's proofs are built against.
for (const pkg of ["@midnightntwrk/ledger-v9", "@effectstream/mip-zswap-offer/mip5",
                   "@effectstream/midnight-contracts"]) {
  const where = Bun.resolveSync(pkg, "/app");
  if (!where.startsWith("/app/node_modules/")) {
    console.error(`[spa-roundtrip] ${pkg} resolved to ${where}, not /app/node_modules — refusing ` +
      `to run against a package this image did not install (infra issue 00020)`);
    process.exit(2);
  }
}

import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  buildWallet, waitForSync, shieldedBalances, shieldedKeys, waitForWalletSettlement,
} from "/app/packages/solver-core/wallet.ts";

const TAG = "[spa-roundtrip]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
const fail = (msg: string): never => { console.error(`${TAG} FAIL ${msg}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const API        = (process.env["SPA_ZSWAP_API"] ?? "http://kernel:9999").replace(/\/+$/, "");
const BATCHER    = (process.env["SPA_BATCHER_URL"] ?? "http://batcher:3334").replace(/\/+$/, "");
const TARGET     = process.env["SPA_BATCHER_TARGET"] ?? "midnight-balancer";
const CONFIG_URL = process.env["SPA_CONFIG_URL"] ?? "http://frontend:10600/config.js";
const TTL_MS     = Number(process.env["SPA_TTL_MINUTES"] ?? "60") * 60_000;
// The SPA's own value: 32-byte Midnight address type in the batcher input envelope.
const MIDNIGHT_ADDRESS_TYPE = 5;

async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (!res.ok) fail(`${init?.method ?? "GET"} ${url} answered ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}
const postJson = <T = any>(url: string, body: unknown) =>
  getJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── 1. the SPA's OWN runtime configuration ──────────────────────────────────
// Read from the frontend container's served /config.js, not from compose: the point is that
// this round trip uses the values the PAGE uses. `window.<NAME> = "<value>";` is the shape the
// image's entrypoint writes (scripts/verify-frontend.sh asserts every one of them).
log(`driving the SPA's own runtime configuration from ${CONFIG_URL}`);
const configJs = await (await fetch(CONFIG_URL, { signal: AbortSignal.timeout(30_000) })).text()
  .catch(() => fail(`could not read ${CONFIG_URL} — is the frontend profile up?`));
const readConfig = (name: string): string => {
  const m = new RegExp(`window\\.${name}\\s*=\\s*"([^"]*)"`).exec(configJs);
  return m ? m[1]! : "";
};
const SEED       = readConfig("DEMO_WALLET_SEED");
const NETWORK_ID = readConfig("MIDNIGHT_NETWORK_ID");
if (!/^[0-9a-f]{64}$/i.test(SEED)) {
  fail(`/config.js carries no 64-hex DEMO_WALLET_SEED (got ${JSON.stringify(SEED)}) — the page's ` +
       `in-page wallet would be a random empty one, and nothing could ever fund it`);
}
if (!NETWORK_ID) fail("/config.js carries no MIDNIGHT_NETWORK_ID");
log(`config.js: network=${NETWORK_ID} seed=${SEED.slice(0, 8)}…${SEED.slice(-6)} ` +
    `api=${readConfig("API_BASE") || "(page origin)"} batcher=${readConfig("BATCHER_URL") || "(page origin)"}`);

const midnightCfg = await getJson<any>(`${API}/v1/midnight/config`);
if (String(midnightCfg.networkId) !== NETWORK_ID) {
  fail(`the page is configured for network '${NETWORK_ID}' but the kernel serves ` +
       `'${midnightCfg.networkId}' — the in-page wallet would sync a different chain`);
}
log(`kernel network ${midnightCfg.networkId} — agrees with the page`);

// ── 2. the two colours ──────────────────────────────────────────────────────
// Preferred source: the ids `registry-env` rendered onto /registry/stack-tokens.env, passed in
// by the shell wrapper. Fallback: the kernel's own registry by NAME, which is what
// `registry-bridge` wrote — either way these are THIS chain's issuers, never a constant.
const known = await getJson<any>(`${API}/v1/known-tokens`);
const rows: any[] = Array.isArray(known) ? known : (known.tokens ?? known.knownTokens ?? []);
const byName = (n: string) => rows.find((t) => String(t.name ?? "").toUpperCase() === n.toUpperCase());
const colourOf = (envName: string, symbol: string): string => {
  const fromEnv = (process.env[envName] ?? "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(fromEnv)) return fromEnv;
  const row = byName(symbol);
  const c = String(row?.color ?? row?.token_color ?? "").replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(c)) fail(`no 64-hex colour for ${symbol}: ${envName} unset and the kernel does not name it`);
  return c;
};
const GIVE_SYMBOL = process.env["SPA_GIVE_SYMBOL"] ?? "twBTC";   // what a taker RECEIVES
const WANT_SYMBOL = process.env["SPA_WANT_SYMBOL"] ?? "twUSDC";  // what a taker PAYS
const GIVE = colourOf("SPA_GIVE_TOKEN", GIVE_SYMBOL);
const WANT = colourOf("SPA_WANT_TOKEN", WANT_SYMBOL);
if (GIVE === WANT) fail("the give and want colours are the same token");
log(`pair ${GIVE_SYMBOL} ${GIVE.slice(0, 16)}…  <-  ${WANT_SYMBOL} ${WANT.slice(0, 16)}…`);

// ── 3. the in-page wallet, and the grant that funds it ──────────────────────
log("building the SPA's in-page wallet facade (no funds wait: this wallet holds no NIGHT by design)");
const w: any = await buildWallet(SEED);
let exitCode = 0;
try {
  await waitForSync(w, { timeoutMs: Number(process.env["SPA_SYNC_TIMEOUT_MS"] ?? 300_000) });
  const before = await shieldedBalances(w);
  const beforeGive = before[GIVE] ?? 0n;
  const beforeWant = before[WANT] ?? 0n;
  log(`wallet before: ${GIVE_SYMBOL}=${beforeGive}  ${WANT_SYMBOL}=${beforeWant}`);

  // faucet-mint's `spa` grant is the ONLY thing that can have put this here: the SPA has no
  // mint since upstream #922 and the faucet site drives an injected extension wallet.
  const GRANT_MIN = BigInt(process.env["SPA_GRANT_MIN"] ?? "1");
  if (beforeWant < GRANT_MIN) {
    fail(`the spa grant is in the SPA wallet: NO — ${WANT_SYMBOL} balance is ${beforeWant}, ` +
         `expected at least ${GRANT_MIN}. faucet-mint's \`spa\` grant did not land, so the page ` +
         `has nothing to pay with (check: docker logs <faucet-mint>)`);
  }
  log(`the spa grant is in the SPA wallet: ${beforeWant} ${WANT_SYMBOL} (>= ${GRANT_MIN})`);

  // ── 4. TAKE ───────────────────────────────────────────────────────────────
  // `0x`-tolerant on BOTH sides: the kernel's own row shape has changed spelling before, and a
  // colour comparison that silently never matches reads as "the book is empty" — the least
  // useful diagnosis available.
  const norm = (v: unknown) => String(v ?? "").replace(/^0x/i, "").toLowerCase();
  const book = await getJson<any>(`${API}/v1/offers?limit=50`);
  const candidates = (book.offers ?? []).filter((o: any) => {
    const c = o.computed ?? {};
    const gives = c.gives ?? [];
    const wants = c.wants ?? [];
    if (gives.length !== 1 || wants.length !== 1) return false;
    if (norm(gives[0].token) !== GIVE) return false;
    if (norm(wants[0].token) !== WANT) return false;
    const pay = BigInt(String(wants[0].amount ?? "0"));
    return pay > 0n && pay <= beforeWant;
  });
  if (candidates.length === 0) {
    for (const o of (book.offers ?? []).slice(0, 5)) {
      const c = o.computed ?? {};
      log(`  book: ${String(o.offerId).slice(0, 12)}… gives ` +
          `${(c.gives ?? []).map((g: any) => `${g.amount}:${norm(g.token).slice(0, 12)}`).join(",")} wants ` +
          `${(c.wants ?? []).map((x: any) => `${x.amount}:${norm(x.token).slice(0, 12)}`).join(",")}`);
    }
    fail(`the book has no live ${GIVE_SYMBOL} -> ${WANT_SYMBOL} offer this wallet can afford ` +
         `(${(book.offers ?? []).length} offer(s) listed, want-colour ${WANT.slice(0, 12)}…, ` +
         `budget ${beforeWant}). The offer poster is what fills it; ./verify.sh --poster names ` +
         `the reason when it is not posting.`);
  }
  const chosen = candidates[0];
  const takeGive = BigInt(String(chosen.computed.gives[0].amount));
  const takeWant = BigInt(String(chosen.computed.wants[0].amount));
  log(`taking offer ${String(chosen.offerId).slice(0, 16)}… — pay ${takeWant} ${WANT_SYMBOL}, ` +
      `receive ${takeGive} ${GIVE_SYMBOL}`);

  const detail = await getJson<any>(`${API}/v1/offers/${chosen.offerId}`);
  const blob: string = detail.offerBech32 ?? detail.offer ?? "";
  if (!/^swapoffer1[a-z0-9]+$/.test(blob)) fail(`offer ${chosen.offerId} has no swapoffer1… blob`);

  // src/services/offerBatch.ts: decode, then merge. N=1 here, so the merge is the identity —
  // but the decode is byte-identical to the SPA's, which is the part that can break.
  const makerTx = Transaction.deserialize("signature", "proof", "binding", OfferFiles.decode(blob));

  log("balancing the taker side (value legs only — the batcher contributes the Dust)…");
  const balanceOpts: any = {
    ttl: new Date(Date.now() + TTL_MS),
    // EXACTLY the SPA's option: no 'dust'. This wallet has none, and asking for it here is the
    // difference between "the batcher sponsors the fee" and InsufficientFunds.
    tokenKindsToBalance: ["shielded", "unshielded"],
  };
  const recipe = await w.wallet.balanceFinalizedTransaction(makerTx, shieldedKeys(w), balanceOpts);
  const settlement: any = await w.wallet.finalizeRecipe(recipe);
  const hex = Array.from(settlement.serialize() as Uint8Array,
    (b: number) => b.toString(16).padStart(2, "0")).join("");
  const address = w.unshieldedKeystore.getBech32Address().asString();
  log(`settlement proven — ${hex.length / 2} bytes; submitting to ${BATCHER}/send-input (target ${TARGET})`);

  // THE SPA'S WIRE CONTRACT, verbatim (src/services/api.ts submitToBatcher).
  const receipt = await postJson<any>(`${BATCHER}/send-input`, {
    data: {
      address,
      addressType: MIDNIGHT_ADDRESS_TYPE,
      input: JSON.stringify({ tx: hex, txStage: "finalized" }),
      timestamp: new Date().toISOString(),
      target: TARGET,
    },
    confirmationLevel: "wait-receipt",
    timeoutMs: Number(process.env["SPA_BATCHER_TIMEOUT_MS"] ?? 600_000),
  });
  if (receipt?.success !== true) {
    fail(`the batcher refused the settlement: ${JSON.stringify(receipt).slice(0, 500)}`);
  }
  log(`the batcher settled the take — transactionHash=${receipt.transactionHash ?? "(none reported)"}`);

  // ── 5. the wallet delta ───────────────────────────────────────────────────
  // The receipt says the batcher accepted and submitted. Only the wallet says the swap
  // HAPPENED: +takeGive of the token the maker gave, -takeWant of the token we paid.
  const wantGive = beforeGive + takeGive;
  const wantWant = beforeWant - takeWant;
  let afterGive = beforeGive, afterWant = beforeWant;
  const deadline = Date.now() + Number(process.env["SPA_DELTA_TIMEOUT_MS"] ?? 300_000);
  for (;;) {
    const now = await shieldedBalances(w);
    afterGive = now[GIVE] ?? 0n;
    afterWant = now[WANT] ?? 0n;
    if (afterGive === wantGive && afterWant === wantWant) break;
    if (Date.now() > deadline) break;
    await sleep(5000);
  }
  log(`wallet after:  ${GIVE_SYMBOL}=${afterGive}  ${WANT_SYMBOL}=${afterWant}`);
  if (afterGive !== wantGive || afterWant !== wantWant) {
    fail(`the SPA wallet's balances did not move by exactly the taken legs: ` +
         `${GIVE_SYMBOL} ${beforeGive}->${afterGive} (expected ${wantGive}), ` +
         `${WANT_SYMBOL} ${beforeWant}->${afterWant} (expected ${wantWant})`);
  }
  log(`the SPA wallet's balances moved by exactly the taken legs ` +
      `(+${takeGive} ${GIVE_SYMBOL}, -${takeWant} ${WANT_SYMBOL})`);

  // ── 6. MAKE ───────────────────────────────────────────────────────────────
  // Sell the coin we just bought, back at the same price. `payFees:false` — an offer file is
  // settled by whoever takes it, so the maker never pays and never needs Dust either.
  await waitForWalletSettlement(w, { label: "post-take" });
  const makeGive = takeGive;
  const makeWant = takeWant;
  const shieldedAddr = await w.wallet.shielded.getAddress();
  log(`making an offer: give ${makeGive} ${GIVE_SYMBOL}, want ${makeWant} ${WANT_SYMBOL} (proving…)`);
  const makeRecipe = await w.wallet.initSwap(
    { shielded: { [GIVE]: makeGive } },
    [{ type: "shielded", outputs: [{ type: WANT, amount: makeWant, receiverAddress: shieldedAddr }] }],
    shieldedKeys(w),
    { ttl: new Date(Date.now() + TTL_MS), payFees: false },
  );
  const madeTx = await w.wallet.finalizeTransaction(makeRecipe.transaction);
  const madeBlob = OfferFiles.encode(madeTx.serialize());
  log(`encoded ${madeBlob.length}-char blob; POST ${API}/v1/offers`);

  // ROOT_UNKNOWN = the node has not yet synced the merkle root the offer was built against.
  // It self-resolves within a few blocks; every other error is real.
  let offerId = "";
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await fetch(`${API}/v1/offers`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: madeBlob }), signal: AbortSignal.timeout(120_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) { offerId = String(body.offerId ?? ""); break; }
    const msg = JSON.stringify(body);
    if (msg.includes("ROOT_UNKNOWN") && attempt < 12) {
      log(`  ROOT_UNKNOWN — the node is still syncing the root; retry ${attempt}/12 in 10s`);
      await sleep(10_000);
      continue;
    }
    fail(`the kernel refused the SPA's offer (${res.status}): ${msg.slice(0, 400)}`);
  }
  log(`accepted as offerId ${offerId.slice(0, 16)}… — waiting for it to go live (batcher -> Celestia -> index)`);

  let live = false;
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const st = await postJson<any>(`${API}/v1/offers/status`, { offer: madeBlob });
    if (st.status === "live") { live = true; break; }
    if (["consumed", "cancelled", "expired"].includes(String(st.status))) {
      fail(`the SPA's offer reached status '${st.status}' before it was ever live`);
    }
    if (i % 4 === 0) log(`  [${i + 1}/40] status: ${st.status}`);
  }
  if (!live) fail("the SPA's maker offer never reached 'live' in the kernel's book");
  log("the SPA's maker offer is live in the kernel book");

  console.log(`${TAG} RESULT take=${chosen.offerId} paid=${takeWant}:${WANT_SYMBOL} ` +
              `received=${takeGive}:${GIVE_SYMBOL} make=${offerId} status=live`);
  log(`OK: the SPA took an offer through the batcher and made one of its own`);
} catch (e) {
  console.error(`${TAG} FAIL ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  exitCode = 1;
} finally {
  await (w?.wallet?.stop?.() ?? Promise.resolve()).catch?.(() => {});
}
process.exit(exitCode);
