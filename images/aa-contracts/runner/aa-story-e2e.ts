// aa-story-e2e.ts — the owner's seven steps, headless, on a real EVM chain (spec FR-016,
// SC-001/004/005, User Stories 2 and 3).
//
//   ./scripts/aa-story-e2e.sh            (needs --with aa --with signet --with offerfiles --with frontend)
//
//   1 register    deploy + activate ONE account contract for a throwaway Ethereum key
//   3 bridge      WEENUS → the OWNER'S OWN Midnight wallet (the frontend's in-page wallet)
//   4 bridge      USDC  → the account
//   5 publish     prove `open_swap_shielded_with_evm` (give 1 USDC, get 10 WEENUS) and post it
//   6 take        the OWNER'S wallet settles it, through the offer-files SPA's own code path
//   7 notice      the console reconciles the account WITHOUT being asked, and the offer is
//                 marked consumed with the settling transaction
//   ·  and then the account SPENDS what it received: the 10 WEENUS are bridged back out to
//      the funder, which is both the tidy-up and the only assertion that the reconciled coin
//      is real custody rather than a number in a file.
//
// Step 2 of the story is the operator opening MetaMask; here it is the funder key this file
// holds and the console never does.
//
// ── WHY THE TAKE IS NOT `POST /api/take` ───────────────────────────────────
// The console HAS a taker (`/api/take`, the "Settle (taker wallet)" button), and using it
// here would prove nothing about step 6: it is the same process, the same wallet plumbing and
// a wallet whose seed the console holds. The story's taker is the OWNER'S wallet, in ANOTHER
// APP. So this file reproduces the SPA's take exactly as `images/offerfiles-kernel/runner/
// spa-roundtrip.ts` documents it:
//
//   * the seed and the network id come from the frontend container's OWN served `/config.js`
//     — the same bytes the page reads, so the wallet that settles IS the wallet the page
//     would connect (project 00035 question Q10 put the owner's wallet there);
//   * `balanceFinalizedTransaction` with `tokenKindsToBalance: ["shielded","unshielded"]` and
//     no dust — the SPA's own options, which is what makes the batcher sponsor the fee;
//   * `POST ${BATCHER_URL}/send-input` with `addressType: 5`, `txStage: "finalized"`,
//     `confirmationLevel: "wait-receipt"`, target `midnight-balancer`.
//
// What it does NOT reproduce is the renderer, and no headless runner can. `--take node`
// falls back to the same wallet submitting to the node itself (it holds NIGHT and DUST,
// because `up.sh` funds it) for a stack brought up without the batcher; the report records
// which path ran, because the two are not the same claim.
//
// ── NO `--anvil` MODE ───────────────────────────────────────────────────────
// Project question Q16: this repository has no anvil at all, the lane is a compose fragment
// plus a solc build plus a second bring-up, and it is filed as issue 00036. The spec's SC-006
// is amended to Sepolia. There is deliberately no mode switch here to imply otherwise.

import "./passport-env.ts";

import { mkdirSync, writeFileSync } from "node:fs";
import * as Rx from "rxjs";

import { ethers } from "ethers";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";

import { EvmDevice } from "../passport/src/wallet/signer.js";
import { CONFIG, createWallet, hexToBytes, toHex } from "./passport.ts";
import { ERC20_ABI, formatEth, fromRaw, toRaw } from "./aa-bridge.ts";

// issue 00020: never let bun auto-install a pinned dependency at run time.
for (const pkg of ["@metamask/eth-sig-util", "@midnightntwrk/ledger-v9", "@effectstream/mip-zswap-offer/mip5"]) {
  const where = Bun.resolveSync(pkg, "/aa");
  if (!where.startsWith("/aa/node_modules/")) {
    console.error(`[aa-story-e2e] ${pkg} resolved to ${where}, not /aa/node_modules — refusing to run`);
    process.exit(2);
  }
}
const { personalSign, signTypedData, SignTypedDataVersion } = await import("@metamask/eth-sig-util");

const TAG = "[aa-story-e2e]";

const RPC_URL = process.env["AA_STORY_RPC_URL"] ?? "";
const FUNDER_KEY = process.env["AA_STORY_FUNDER_KEY"] ?? "";

// ── NOTHING THIS PROCESS PRINTS MAY CARRY THE OPERATOR'S RPC URL ────────────
//
// Measured, on the first live run of this file: a transient TLS failure inside ethers came
// out of Bun as
//
//     error: unknown certificate verification error
//       path: "https://eth-sepolia.g.alchemy.com/v2/<the operator's key>"
//
// — an uncaught throw, printed by the runtime, with the provider key in it, into a log that
// was about to become evidence. The URL is a secret (spec FR-015) and the error path that
// prints it is one this file does not control. So every line this process writes goes through
// `redact` first, and an uncaught error is caught rather than left to the runtime.
function redact(text: string): string {
  let out = String(text);
  for (const secret of [RPC_URL, FUNDER_KEY, FUNDER_KEY.replace(/^0x/, "")]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("<REDACTED-SECRET>");
  }
  // …and the SHAPE, for a URL this process never saw verbatim (a redirect, a proxied host).
  out = out.replace(/(https?:\/\/[^\s"'`]*\/v2\/)[A-Za-z0-9_\-]{8,}/g, "$1<REDACTED-PROVIDER-KEY>");
  return out;
}
const rawLog = console.log.bind(console);
const rawErr = console.error.bind(console);
const scrub = (a: unknown): unknown => {
  if (typeof a === "string") return redact(a);
  const text = (() => { try { return Bun.inspect(a); } catch { return String(a); } })();
  return redact(text) === text ? a : redact(text);
};
console.log = (...a: unknown[]) => rawLog(...a.map(scrub));
console.error = (...a: unknown[]) => rawErr(...a.map(scrub));

const log = (...a: unknown[]) => console.log(TAG, ...a);

const t0 = Date.now();
const steps: Record<string, unknown> = {};
const spend = { eth: 0n, tokens: {} as Record<string, string> };
const OUT = process.env["AA_STORY_OUT"] ?? "/aa/out/aa-story-e2e.json";

/** A failure writes the report anyway — sub-plan B's lesson, paid for on a real chain: the
 *  first bridge run failed at its last step and took the record of three successful legs
 *  with it. Sepolia transactions are not repeatable for free. */
const fail = (msg0: string): never => {
  const msg = redact(String(msg0));
  console.error(`${TAG} FAIL ${msg}`);
  try {
    mkdirSync(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify({
      kind: "aa-story-e2e", result: "FAILED", failure: msg,
      failedAt: new Date().toISOString(), tookSeconds: Math.round((Date.now() - t0) / 1000),
      note: "the steps below DID happen, on a real chain, before the failure above",
      spend: { ethWei: String(spend.eth), eth: formatEth(spend.eth), tokens: spend.tokens },
      steps,
    }, null, 2)}\n`);
    console.error(`${TAG} the steps that did succeed are recorded in ${OUT}`);
  } catch { /* the failure above is what matters */ }
  process.exit(1);
};

const BASE = (process.env["AA_STORY_CONSOLE_URL"] ?? "http://aa-console:8090").replace(/\/+$/, "");
const KERNEL = (process.env["AA_STORY_KERNEL_URL"] ?? "http://kernel:9999").replace(/\/+$/, "");
const BATCHER = (process.env["AA_STORY_BATCHER_URL"] ?? "http://batcher:3334").replace(/\/+$/, "");
const CONFIG_URL = process.env["AA_STORY_CONFIG_URL"] ?? "http://frontend:10600/config.js";
const TAKE_VIA = (process.env["AA_STORY_TAKE_VIA"] ?? "batcher").toLowerCase();
/** A throwaway EVM key: the run's "MetaMask". Public by design, like every seed in this repo.
 *  `||` rather than `??` — the wrapper passes an EMPTY string when the operator named none,
 *  and an empty string is not nullish (sub-plan B paid for that distinction). */
const OWNER_KEY = (process.env["AA_STORY_OWNER_KEY"] || `0x${"5701e2".padStart(64, "0")}`) as `0x${string}`;

const GIVE_SYMBOL = process.env["AA_STORY_GIVE"] ?? "USDC";     // step 4, and the offer's give leg
const WANT_SYMBOL = process.env["AA_STORY_WANT"] ?? "WEENUS";   // step 3, and the offer's want leg
const GIVE_AMOUNT = process.env["AA_STORY_GIVE_AMOUNT"] ?? "1";
const WANT_AMOUNT = process.env["AA_STORY_WANT_AMOUNT"] ?? "10";
/** What step 3 bridges to the owner's wallet. Defaults to EXACTLY the want leg, so the wallet
 *  ends the run holding none of it and the vault's EVM account keeps only what the story
 *  actually moved. ⚠ One bridge leg cannot carry more than 2^64−1 raw units (question Q17):
 *  ~18.44 units of an 18-decimal token, so anything above that is two deposits. */
const BRIDGE_WANT_AMOUNT = process.env["AA_STORY_BRIDGE_WANT"] ?? WANT_AMOUNT;
/** Withdraw the received want coin back to the funder at the end. On by default: it keeps the
 *  vault's EVM account near zero AND it is the strongest assertion the reconcile has, because
 *  a coin whose Merkle position was recovered wrongly fails at proving and never spends. */
const WITHDRAW_BACK = !/^(0|false|no)$/i.test(process.env["AA_STORY_WITHDRAW_BACK"] ?? "1");
/**
 * RESUME. A run that moves real money cannot repeat its own spend to retry a later step, and
 * the first live run of this file proved that is not hypothetical: it died at step 4's LAST
 * read, on a transient TLS failure, with 1 USDC and 10 WEENUS already bridged and in place.
 *
 * `AA_STORY_ACCOUNT_ID` names an account that already exists (skipping step 1) and
 * `AA_STORY_SKIP_BRIDGE=1` says its coins and the owner's wallet's coins are already there
 * (skipping steps 3 and 4). Both are then ASSERTED rather than assumed — a resume that starts
 * from a state it has not checked is a run whose result means nothing.
 */
const RESUME_ACCOUNT = (process.env["AA_STORY_ACCOUNT_ID"] ?? "").replace(/^0x/, "").toLowerCase();
const SKIP_BRIDGE = /^(1|true|yes)$/i.test(process.env["AA_STORY_SKIP_BRIDGE"] ?? "");
const JOB_TIMEOUT_MS = Number(process.env["AA_STORY_JOB_TIMEOUT_MS"] ?? 2_400_000);
/** SC-005: "within 60 s without any manual action". The default is that number. */
const RECONCILE_WAIT_MS = Number(process.env["AA_STORY_RECONCILE_MS"] ?? 60_000);
const LIVE_WAIT_MS = Number(process.env["AA_STORY_LIVE_MS"] ?? 300_000);
const SYNC_MS = Number(process.env["AA_STORY_SYNC_MS"] ?? 420_000);
const TTL_MS = Number(process.env["TX_TTL_MS"] ?? 600_000);
/** The SPA's own value: the 32-byte Midnight address type in the batcher's input envelope. */
const MIDNIGHT_ADDRESS_TYPE = 5;

// The safety net. A run that dies without writing its report takes the record of everything it
// already did on a real chain with it (sub-plan B paid for that lesson once); a run that dies
// through the RUNTIME'S printer also prints whatever the error happens to carry. Both are
// closed here: every terminal path goes through `fail`, which redacts and writes the report.
process.on("uncaughtException", (e: any) => fail(`uncaught: ${redact(String(e?.stack ?? e))}`));
process.on("unhandledRejection", (e: any) => fail(`unhandled rejection: ${redact(String(e?.stack ?? e))}`));

if (!RPC_URL) fail("AA_STORY_RPC_URL is required (the EVM endpoint this run funds through)");
if (!FUNDER_KEY) fail("AA_STORY_FUNDER_KEY is required (scripts/aa-story-e2e.sh reads it from the operator's env)");
if (!["batcher", "node"].includes(TAKE_VIA)) fail(`AA_STORY_TAKE_VIA must be batcher|node, got '${TAKE_VIA}'`);

// ── the console's API, exactly as the page calls it ─────────────────────────

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) fail(`${path} answered ${res.status}: ${text.slice(0, 500)}`);
  return parsed as T;
}

async function apiExpectRefusal(path: string, body: unknown, what: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (res.ok) fail(`${what}: the console ACCEPTED it (${text.slice(0, 300)}) — the guard is missing`);
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  const msg = String(parsed.error ?? text).slice(0, 400);
  log(`  refused, as it must be: ${msg}`);
  return msg;
}

async function awaitJob(jobId: string, what: string): Promise<any> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let printed = 0;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    for (const line of (job.log ?? []).slice(printed)) log(`  ${what}: ${line}`);
    printed = (job.log ?? []).length;
    if (job.state === "done") return job;
    if (job.state === "error") fail(`${what} failed: ${job.error ?? "no error given"}`);
    if (Date.now() > deadline) fail(`${what} did not finish within ${JOB_TIMEOUT_MS / 1000}s (state=${job.state})`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

const keyBuf = Buffer.from(OWNER_KEY.replace(/^0x/, ""), "hex");
const OWNER = EvmDevice.fromPrivateKey(new Uint8Array(keyBuf)).addressHex.toLowerCase();

/** prepare → sign (the way a wallet signs) → submit → await. */
async function signedAction(body: Record<string, unknown>, what: string): Promise<any> {
  const prep = await api("/api/prepare", { ...body, owner: OWNER });
  const signature = prep.message
    ? personalSign({ privateKey: keyBuf, data: prep.message })
    : signTypedData({ privateKey: keyBuf, data: prep.typedData, version: SignTypedDataVersion.V4 });
  const { jobId } = await api("/api/submit", { prepId: prep.prepId, signature });
  return { job: await awaitJob(jobId, what), summary: prep.summary };
}

// ── the EVM side: the one thing a browser cannot do headlessly ──────────────

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
const funder = new ethers.Wallet(FUNDER_KEY.startsWith("0x") ? FUNDER_KEY : `0x${FUNDER_KEY}`, provider);
const erc20Of = (address: string) => new ethers.Contract(address, ERC20_ABI, funder);
const balanceOf = async (erc20: string, who: string): Promise<bigint> =>
  BigInt(await (erc20Of(erc20) as any).balanceOf(who));

async function fundAddress(
  to: string, erc20: string, symbol: string, decimals: number, amountRaw: bigint, wantWei: bigint,
): Promise<{ token: string | null; gas: string | null }> {
  const token = erc20Of(erc20);
  const [haveToken, haveEth] = await Promise.all([
    (token as any).balanceOf(to) as Promise<bigint>,
    provider.getBalance(to),
  ]);
  let tokenTx: string | null = null;
  let gasTx: string | null = null;
  if (BigInt(haveEth) < wantWei) {
    const need = wantWei - BigInt(haveEth);
    const tx = await funder.sendTransaction({ to, value: need });
    gasTx = (await tx.wait(1))!.hash;
    spend.eth += need;
    log(`  gas   ${formatEth(need)} ETH → ${to} ${gasTx}`);
  } else log(`  gas   already present (${formatEth(BigInt(haveEth))} ETH)`);
  if (BigInt(haveToken) < amountRaw) {
    const need = amountRaw - BigInt(haveToken);
    const tx = await (token as any).transfer(to, need);
    tokenTx = (await tx.wait(1))!.hash;
    spend.tokens[symbol] = String(BigInt(spend.tokens[symbol] ?? "0") + need);
    log(`  token ${fromRaw(need, decimals)} ${symbol} → ${to} ${tokenTx}`);
  } else if (amountRaw > 0n) log("  token already present");
  return { token: tokenTx, gas: gasTx };
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. what the stack, the chain and THE PAGE say about themselves
// ═══════════════════════════════════════════════════════════════════════════
log(`console ${BASE}; kernel ${KERNEL}; take via ${TAKE_VIA}; funder ${funder.address}`);
const info = await api("/api/info");
if (!info.bridge?.available) {
  fail(`the console says the bridge is not available: ${JSON.stringify(info.bridge?.reasons ?? info.bridge)}`);
}
const network = await provider.getNetwork();
if (String(network.chainId) !== String(info.bridge.chainId)) {
  fail(`this run's RPC serves chain ${network.chainId} and the vault is pinned to ${info.bridge.chainId} — `
    + "every derived deposit address is scoped to the pinned chain");
}

// THE PAGE'S OWN RUNTIME CONFIGURATION, read from the frontend container's served /config.js.
// This is the whole reason the take below is the story's take: the seed here is the seed the
// browser's in-page wallet uses, which project question Q10 made the OWNER'S wallet.
const configJs = await (await fetch(CONFIG_URL, { signal: AbortSignal.timeout(30_000) })).text()
  .catch(() => fail(`could not read ${CONFIG_URL} — is the frontend profile up?`));
const readConfig = (name: string): string => {
  const m = new RegExp(`window\\.${name}\\s*=\\s*"([^"]*)"`).exec(configJs as string);
  return m ? m[1]! : "";
};
const FRONTEND_SEED = readConfig("DEMO_WALLET_SEED");
const FRONTEND_NETWORK = readConfig("MIDNIGHT_NETWORK_ID");
if (!/^[0-9a-f]{64}$/i.test(FRONTEND_SEED) && !/^[0-9a-f]{128}$/i.test(FRONTEND_SEED)) {
  fail("the frontend's /config.js carries no 64- or 128-hex DEMO_WALLET_SEED, so the page's wallet is a "
    + "random empty one and nothing could ever take this offer");
}
if (FRONTEND_NETWORK && FRONTEND_NETWORK !== String(CONFIG.networkId)) {
  fail(`the page is configured for network '${FRONTEND_NETWORK}' and this stack runs '${CONFIG.networkId}'`);
}

const tokenList = await api("/api/bridge/tokens");
const pickToken = (symbol: string) => {
  const t = (tokenList.tokens ?? []).find((x: any) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!t) fail(`the console lists no bridged token '${symbol}' (has: ${(tokenList.tokens ?? []).map((x: any) => x.symbol).join(", ")})`);
  return t;
};
const GIVE = pickToken(GIVE_SYMBOL);
const WANT = pickToken(WANT_SYMBOL);
const giveRaw = toRaw(GIVE_AMOUNT, GIVE.decimals);
const wantRaw = toRaw(WANT_AMOUNT, WANT.decimals);
const bridgeWantRaw = toRaw(BRIDGE_WANT_AMOUNT, WANT.decimals);
if (bridgeWantRaw < wantRaw) {
  fail(`step 3 bridges ${BRIDGE_WANT_AMOUNT} ${WANT.symbol} and the offer wants ${WANT_AMOUNT} — `
    + "the owner's wallet could not pay for it");
}
const vaultEvm: string = tokenList.vaultEvmAddress;
log(`give ${GIVE.symbol} ${GIVE.decimals}d ${GIVE.erc20} colour ${GIVE.colour.slice(0, 16)}…`);
log(`want ${WANT.symbol} ${WANT.decimals}d ${WANT.erc20} colour ${WANT.colour.slice(0, 16)}…`);

// The owner's wallet — built here only to learn its PUBLIC shielded address (step 3's
// recipient) and its balances. The seed came from the page's own config, never from a plan.
async function withFrontendWallet<T>(what: string, fn: (ctx: any) => Promise<T>): Promise<T> {
  const ctx: any = await createWallet(FRONTEND_SEED);
  try {
    return await fn(ctx);
  } finally {
    await (ctx.wallet as any).stop?.().catch(() => {});
  }
}
async function syncedState(ctx: any): Promise<any> {
  return await Rx.firstValueFrom((ctx.wallet as any).state().pipe(
    // `isSynced` flaps true → false → true early in a sync; the throttle is the console's
    // own measured workaround, kept identical here.
    Rx.throttleTime(5_000),
    Rx.filter((x: any) => x.isSynced === true),
    Rx.timeout({ each: SYNC_MS, with: () => Rx.throwError(() => new Error("wallet sync timeout")) }),
  ));
}
const shieldedOf = (st: any): Record<string, bigint> => {
  const bal = st.shielded?.balances;
  const entries = bal instanceof Map ? [...bal.entries()] : Object.entries(bal ?? {});
  const out: Record<string, bigint> = {};
  for (const [colour, value] of entries) out[String(colour).replace(/^0x/, "").toLowerCase()] = BigInt(value as any);
  return out;
};

const ownerWallet = await withFrontendWallet("address", async (ctx) => {
  const st = await syncedState(ctx);
  const coinPublicKey = String(st.shielded.coinPublicKey.toHexString()).replace(/^0x/, "").toLowerCase();
  const encryptionPublicKey = String(st.shielded.encryptionPublicKey.toHexString()).replace(/^0x/, "").toLowerCase();
  // Composed from the two public halves rather than read off the facade, exactly as
  // aa-bridge-e2e.ts does — one shape, one place to be wrong.
  const shieldedAddress = MidnightBech32m.encode(CONFIG.networkId as any, new (ShieldedAddress as any)(
    new (ShieldedCoinPublicKey as any)(Buffer.from(coinPublicKey, "hex")),
    new (ShieldedEncryptionPublicKey as any)(Buffer.from(encryptionPublicKey, "hex")),
  )).asString();
  return { shieldedAddress, coinPublicKey, encryptionPublicKey, balances: shieldedOf(st) };
});
// The console publishes the frontend wallet's address as PUBLIC data (up.sh writes it into the
// aa-out volume). If it disagrees with what the page's own seed builds, the "owner's wallet"
// in the Bridge tab and the one that takes the offer are two different wallets — which is
// exactly the failure question Q10 exists to prevent, and it must stop the run.
if (info.bridge?.frontendWallet && String(info.bridge.frontendWallet) !== ownerWallet.shieldedAddress) {
  fail(`the console publishes the frontend wallet as ${info.bridge.frontendWallet} and the page's own seed `
    + `builds ${ownerWallet.shieldedAddress} — those must be the same wallet (question Q10)`);
}
log(`the owner's wallet (the page's in-page wallet) is ${ownerWallet.shieldedAddress.slice(0, 40)}…`);

steps["0-stack"] = {
  chainId: String(network.chainId),
  vault: info.bridge.vault?.address ?? null,
  vaultEvmAddress: vaultEvm,
  attestation: info.bridge.attestation,
  takeVia: TAKE_VIA,
  frontendWallet: {
    shieldedAddress: ownerWallet.shieldedAddress,
    coinPublicKey: ownerWallet.coinPublicKey,
    encryptionPublicKey: ownerWallet.encryptionPublicKey,
    publishedByConsole: info.bridge?.frontendWallet ?? null,
  },
  frontendConfigSource: CONFIG_URL,
  tokens: [GIVE, WANT].map((t: any) => ({ symbol: t.symbol, decimals: t.decimals, erc20: t.erc20, colour: t.colour })),
  funder: funder.address,
  funderBefore: {
    eth: formatEth(await provider.getBalance(funder.address)),
    [GIVE.symbol]: fromRaw(await balanceOf(GIVE.erc20, funder.address), GIVE.decimals),
    [WANT.symbol]: fromRaw(await balanceOf(WANT.erc20, funder.address), WANT.decimals),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. register — step 1 of the story
// ═══════════════════════════════════════════════════════════════════════════
log("");
let accountId: string;
if (RESUME_ACCOUNT) {
  log(`── 1. RESUMING on an existing account (AA_STORY_ACCOUNT_ID) ──`);
  const mine = await api(`/api/accounts?owner=${OWNER}`);
  const row = (mine.accounts ?? []).find((a: any) => String(a.address).toLowerCase() === RESUME_ACCOUNT);
  if (!row) {
    fail(`this console has no account ${RESUME_ACCOUNT.slice(0, 18)}… for ${OWNER} — a resume must name `
      + `an account the SAME throwaway key owns (set AA_STORY_OWNER_KEY to the key that registered it)`);
  }
  if (row.liveOffer) {
    fail(`account ${RESUME_ACCOUNT.slice(0, 18)}… already has a live offer (${row.liveOffer.give} for `
      + `${row.liveOffer.want}). One live offer per account: settle it, or clear it with POST /api/offer/forget`);
  }
  accountId = String(row.address);
  log(`account ${accountId} — holding ${JSON.stringify(row.balancesDecimal ?? {})}`);
  steps["1-register"] = { owner: OWNER, accountId, resumed: true, holdings: row.balancesDecimal ?? null };
} else {
  log(`── 1. register an account for ${OWNER} (two transactions, k=18 proving) ──`);
  const reg = await signedAction({ kind: "register" }, "register");
  accountId = String(reg.job.data?.address ?? reg.job.txId ?? "");
  if (!/^[0-9a-f]{64}$/i.test(accountId)) fail("register finished without an account address");
  log(`account ${accountId}`);
  steps["1-register"] = { owner: OWNER, accountId, seconds: Math.round((Date.now() - t0) / 1000) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. bridge the WANT token to the OWNER'S OWN Midnight wallet
// ═══════════════════════════════════════════════════════════════════════════
if (SKIP_BRIDGE) {
  // A resume: steps 3 and 4 already happened, on a real chain, and repeating them would spend
  // again. What is NOT skipped is the ASSERTION that their result is actually in place —
  // otherwise everything after this proves nothing.
  log("");
  log("── 3 + 4. SKIPPED (AA_STORY_SKIP_BRIDGE): asserting the coins are already where they belong ──");
  const ownerHas = await withFrontendWallet("resume-check", async (ctx) => shieldedOf(await syncedState(ctx)));
  const ownerWant = ownerHas[WANT.colour] ?? 0n;
  if (ownerWant < wantRaw) {
    fail(`a resume needs the owner's wallet to already hold at least ${WANT_AMOUNT} ${WANT.symbol}; it holds `
      + `${fromRaw(ownerWant, WANT.decimals)}. Run without AA_STORY_SKIP_BRIDGE to bridge it`);
  }
  const resumeRows = await api(`/api/accounts?owner=${OWNER}`);
  const resumeRow = (resumeRows.accounts ?? []).find((a: any) => a.address === accountId);
  const accHas = BigInt(resumeRow?.shielded?.[GIVE.symbol] ?? "0");
  if (accHas < giveRaw) {
    fail(`a resume needs the account to already hold at least ${GIVE_AMOUNT} ${GIVE.symbol}; it holds `
      + `${fromRaw(accHas, GIVE.decimals)}. Run without AA_STORY_SKIP_BRIDGE to bridge it`);
  }
  log(`the owner's wallet holds ${fromRaw(ownerWant, WANT.decimals)} ${WANT.symbol} and the account holds `
    + `${fromRaw(accHas, GIVE.decimals)} ${GIVE.symbol} — both bridged by an earlier run of this file`);
  steps["3-bridge-to-wallet"] = { skipped: "AA_STORY_SKIP_BRIDGE — bridged by an earlier run",
    ownerWalletSees: fromRaw(ownerWant, WANT.decimals) };
  steps["4-bridge-to-account"] = { skipped: "AA_STORY_SKIP_BRIDGE — bridged by an earlier run",
    accountHolds: fromRaw(accHas, GIVE.decimals) };
} else {
  log("");
  log(`── 3. bridge ${BRIDGE_WANT_AMOUNT} ${WANT.symbol} to the owner's own Midnight wallet ──`);
  const quoteW = await api("/api/bridge/quote", {
    direction: "deposit", token: WANT.erc20, amount: BRIDGE_WANT_AMOUNT,
    recipient: { shieldedAddress: ownerWallet.shieldedAddress },
  });
  log(`  deposit address ${quoteW.depositAddress} (required ETH ${quoteW.requiredEth})`);
  const fundW = await fundAddress(
    quoteW.depositAddress, WANT.erc20, WANT.symbol, WANT.decimals, bridgeWantRaw, BigInt(quoteW.requiredEthWei));
  const vaultWantBefore = await balanceOf(WANT.erc20, vaultEvm);
  const startW = await api("/api/bridge/deposit/start", {
    token: WANT.erc20, amount: BRIDGE_WANT_AMOUNT,
    recipient: { shieldedAddress: ownerWallet.shieldedAddress },
  });
  const jobW = await awaitJob(startW.jobId, "bridge-to-owner-wallet");
  const recW = (jobW.data as any)?.request;
  if (!recW || recW.state !== "completed") fail(`the wallet deposit ended in state '${recW?.state}': ${recW?.error}`);
  const receiptW = await provider.getTransactionReceipt(recW.evmTxHash);
  if (!receiptW || receiptW.status !== 1) fail(`the wallet deposit's ERC20 transfer did not succeed (${recW.evmTxHash})`);
  const vaultWantAfter = await balanceOf(WANT.erc20, vaultEvm);
  if (vaultWantAfter - vaultWantBefore !== bridgeWantRaw) {
    fail(`the vault's EVM account moved by ${vaultWantAfter - vaultWantBefore} of ${WANT.symbol}, expected ${bridgeWantRaw}`);
  }

  // The assertion the wallet path exists for: the recipient, syncing on its own, SEES the coin.
  // A coin minted to a key with no encryption-key mapping in the settle still belongs to its
  // owner and is invisible to them (00034 question Q42) — a silent failure the console cannot
  // detect from its side, which is why it is checked from the wallet's.
  const ownerSeesWant = await withFrontendWallet("sees-want", async (ctx) => {
    const deadline = Date.now() + SYNC_MS;
    for (;;) {
      const st = await syncedState(ctx);
      const have = shieldedOf(st)[WANT.colour] ?? 0n;
      if (have >= bridgeWantRaw) return have;
      if (Date.now() > deadline) return have;
      await new Promise((r) => setTimeout(r, 8000));
    }
  });
  if (ownerSeesWant < bridgeWantRaw) {
    fail(`the owner's wallet sees ${ownerSeesWant} of the bridged ${WANT.symbol} colour, expected at least `
      + `${bridgeWantRaw}. That is the Q42 failure: the coin is theirs and invisible to them`);
  }
  log(`step 3 OK — EVM ${recW.evmTxHash} status 1; the owner's wallet sees `
    + `${fromRaw(ownerSeesWant, WANT.decimals)} ${WANT.symbol} by syncing with nothing but its own configuration`);
  steps["3-bridge-to-wallet"] = {
    recipient: ownerWallet.shieldedAddress, depositAddress: quoteW.depositAddress, funding: fundW,
    requestId: recW.requestId, startTxId: recW.startTxId, settleTxId: recW.settleTxId,
    evmTxHash: recW.evmTxHash, evmStatus: recW.evmStatus, evmBlock: recW.evmBlock,
    attested: recW.attestedKind, attestationLabel: recW.attestationLabel,
    amount: BRIDGE_WANT_AMOUNT, amountRaw: String(bridgeWantRaw), colour: WANT.colour,
    ownerWalletSeesRaw: String(ownerSeesWant), ownerWalletSees: fromRaw(ownerSeesWant, WANT.decimals),
    vaultEvmDelta: String(vaultWantAfter - vaultWantBefore),
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. bridge the GIVE token into the ACCOUNT
  // ═══════════════════════════════════════════════════════════════════════════
  log("");
  log(`── 4. bridge ${GIVE_AMOUNT} ${GIVE.symbol} into the account ──`);
  const quoteG0 = await api("/api/bridge/quote", {
    direction: "deposit", token: GIVE.erc20, amount: GIVE_AMOUNT, recipient: { account: accountId },
  });
  if (quoteG0.ready) fail("the quote says READY for an address nothing has funded");
  if (quoteG0.depositAddress === quoteW.depositAddress) {
    fail("the account and the wallet derived the SAME deposit address — the recipient is not in the derivation");
  }
  log(`  deposit address ${quoteG0.depositAddress} (required ETH ${quoteG0.requiredEth})`);
  const fundG = await fundAddress(
    quoteG0.depositAddress, GIVE.erc20, GIVE.symbol, GIVE.decimals, giveRaw, BigInt(quoteG0.requiredEthWei));
  const quoteG1 = await api("/api/bridge/quote", {
    direction: "deposit", token: GIVE.erc20, amount: GIVE_AMOUNT, recipient: { account: accountId },
  });
  if (!quoteG1.ready) fail(`the address is funded and the quote still says not ready: ${JSON.stringify(quoteG1.shortfall)}`);
  const vaultGiveBefore = await balanceOf(GIVE.erc20, vaultEvm);
  const depG = await signedAction(
    { kind: "bridge-deposit-start", accountId, token: GIVE.erc20, amount: GIVE_AMOUNT }, "bridge-to-account");
  const recG = (depG.job.data as any)?.request;
  if (!recG) fail("the deposit job carries no bridge request record");
  if (recG.state !== "completed") fail(`the deposit ended in state '${recG.state}': ${recG.error ?? "(no error)"}`);
  const receiptG = await provider.getTransactionReceipt(recG.evmTxHash);
  if (!receiptG || receiptG.status !== 1) fail(`the deposit's ERC20 transfer did not succeed (${recG.evmTxHash})`);
  const vaultGiveAfter = await balanceOf(GIVE.erc20, vaultEvm);
  if (vaultGiveAfter - vaultGiveBefore !== giveRaw) {
    fail(`the vault's EVM account moved by ${vaultGiveAfter - vaultGiveBefore}, expected ${giveRaw}`);
  }
  const accountsAfterG = await api(`/api/accounts?owner=${OWNER}`);
  const rowG = (accountsAfterG.accounts ?? []).find((a: any) => a.address === accountId);
  if (BigInt(rowG?.shielded?.[GIVE.symbol] ?? "0") !== giveRaw) {
    fail(`the account's coin store holds ${rowG?.shielded?.[GIVE.symbol] ?? "0"} of ${GIVE.symbol}, expected ${giveRaw}`);
  }
  // FR-008 on the console's own surface: the same number, in the token's units.
  if (String(rowG?.balancesDecimal?.[GIVE.symbol] ?? "") !== GIVE_AMOUNT) {
    fail(`the console renders the account's ${GIVE.symbol} as `
      + `'${rowG?.balancesDecimal?.[GIVE.symbol]}', expected '${GIVE_AMOUNT}' (FR-008)`);
  }
  log(`step 4 OK — EVM ${recG.evmTxHash} status 1, attested ${recG.attestationLabel}; the account holds `
    + `${rowG.balancesDecimal[GIVE.symbol]} ${GIVE.symbol}`);
  steps["4-bridge-to-account"] = {
    depositAddress: quoteG0.depositAddress, funding: fundG, requestId: recG.requestId,
    startTxId: recG.startTxId, settleTxId: recG.settleTxId,
    evmTxHash: recG.evmTxHash, evmStatus: recG.evmStatus, evmBlock: recG.evmBlock,
    attested: recG.attestedKind, attestationLabel: recG.attestationLabel,
    amount: GIVE_AMOUNT, amountRaw: String(giveRaw), colour: GIVE.colour,
    accountHolds: rowG.balancesDecimal[GIVE.symbol], accountHoldsRaw: rowG.shielded[GIVE.symbol],
    inboxCount: rowG.inboxCount, vaultEvmDelta: String(vaultGiveAfter - vaultGiveBefore),
  };

}

// ═══════════════════════════════════════════════════════════════════════════
// 5. publish the offer — give 1 USDC, get 10 WEENUS, both bridged colours
// ═══════════════════════════════════════════════════════════════════════════
log("");
log(`── 5. publish an offer: give ${GIVE_AMOUNT} ${GIVE.symbol}, get ${WANT_AMOUNT} ${WANT.symbol} ──`);
const built = await signedAction({
  kind: "swap", accountId,
  giveToken: GIVE.symbol, amount: GIVE_AMOUNT,
  wantToken: WANT.symbol, wantAmount: WANT_AMOUNT,
}, "publish-offer");
const offer = built.job.data as any;
if (!offer?.blob?.startsWith("swapoffer1")) fail("the swap job produced no swapoffer1… blob");
const offerId = String(offer.sha256);
// The legs, measured on the BOUND bytes rather than taken from the form.
const legs = (offer.terms?.imbalances ?? {})[offer.legSegment ?? ""] ?? {};
const giveLabelKey = `shielded:${GIVE.colour}`;
const wantLabelKey = `shielded:${WANT.colour}`;
if (String(legs[giveLabelKey] ?? "") !== String(giveRaw)) {
  fail(`the bound offer's give leg is ${legs[giveLabelKey]}, expected +${giveRaw} of ${GIVE.colour.slice(0, 16)}… `
    + `(the whole segment reads ${JSON.stringify(legs)})`);
}
if (String(legs[wantLabelKey] ?? "") !== String(-wantRaw)) {
  fail(`the bound offer's want leg is ${legs[wantLabelKey]}, expected -${wantRaw} of ${WANT.colour.slice(0, 16)}…`);
}
log(`offer built — ${offer.bytes} bytes, legs in segment ${offer.legSegment}, `
  + `+${giveRaw} ${GIVE.symbol} / ${-wantRaw} ${WANT.symbol}`);

// the one-live-offer rule, unchanged by this project
const secondMsg = await apiExpectRefusal("/api/prepare", {
  kind: "swap", owner: OWNER, accountId,
  giveToken: GIVE.symbol, amount: GIVE_AMOUNT, wantToken: WANT.symbol, wantAmount: WANT_AMOUNT,
}, "a second offer while the first is live");
if (!/one live offer per account/i.test(secondMsg)) fail(`the refusal is not the one-live-offer rule: ${secondMsg}`);

const published = await api("/api/publish-offer", { blob: offer.blob });
if (!published.published) fail(`the kernel did not accept the offer: ${JSON.stringify(published)}`);
log(`published — kernel offerId ${String(published.offerId ?? offerId).slice(0, 16)}…`);

// ── FR-009: what the OFFER-FILES FRONTEND will render ──────────────────────
// The SPA reads every token's decimals from the kernel's registry (GET /v1/known-tokens) and
// its `amount.ts` is base-units ⇄ whole-coins with that number as the parameter
// (images/zswap-da/PROVENANCE.md). So "does the frontend show 1 USDC and 10 WEENUS" is
// answerable without a browser: it is the registry row plus the book row, and BOTH are
// asserted here. The browser itself is the demo, and sub-plan C's evidence records it
// separately.
const knownRaw = await (await fetch(`${KERNEL}/v1/known-tokens`, { signal: AbortSignal.timeout(15_000) })).json() as any;
const knownRows: any[] = Array.isArray(knownRaw) ? knownRaw : (knownRaw.tokens ?? knownRaw.knownTokens ?? []);
const registryRow = (t: any) => {
  const row = knownRows.find((r) => String(r.color ?? r.token_color ?? "").replace(/^0x/, "").toLowerCase() === t.colour);
  if (!row) {
    fail(`the kernel's token registry has no row for the bridged ${t.symbol} colour ${t.colour.slice(0, 16)}… — `
      + `the frontend would render its leg as a raw integer (FR-009). Rows: `
      + knownRows.map((r) => `${r.name}=${String(r.color ?? r.token_color ?? "").slice(0, 12)}`).join(", "));
  }
  return row;
};
const rowGive = registryRow(GIVE);
const rowWant = registryRow(WANT);
if (Number(rowGive.decimals) !== GIVE.decimals) fail(`the registry says ${GIVE.symbol} has ${rowGive.decimals} decimals, not ${GIVE.decimals}`);
if (Number(rowWant.decimals) !== WANT.decimals) fail(`the registry says ${WANT.symbol} has ${rowWant.decimals} decimals, not ${WANT.decimals}`);

// the book row, and the exact strings the SPA composes from it
const bookDeadline = Date.now() + LIVE_WAIT_MS;
let bookRow: any = null;
let bookStatus = "";
for (;;) {
  const book: any = await (await fetch(`${KERNEL}/v1/offers?limit=50`, { signal: AbortSignal.timeout(20_000) })).json();
  bookRow = (book.offers ?? []).find((o: any) => String(o.offerId) === offerId) ?? null;
  bookStatus = String(bookRow?.computed?.status ?? bookRow?.status ?? "");
  if (bookRow && bookStatus === "live") break;
  if (Date.now() > bookDeadline) {
    fail(`the offer never reached 'live' in the kernel's book within ${LIVE_WAIT_MS / 1000}s `
      + `(last seen: ${bookRow ? bookStatus : "not listed"}) — the batcher/Celestia/index path is what makes it live`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
const norm = (v: unknown) => String(v ?? "").replace(/^0x/i, "").toLowerCase();
const gives = bookRow.computed?.gives ?? [];
const wants = bookRow.computed?.wants ?? [];
if (gives.length !== 1 || wants.length !== 1) fail(`the book lists ${gives.length} give and ${wants.length} want legs, expected one each`);
if (norm(gives[0].token) !== GIVE.colour) fail(`the book's give leg is colour ${norm(gives[0].token)}, expected ${GIVE.colour}`);
if (norm(wants[0].token) !== WANT.colour) fail(`the book's want leg is colour ${norm(wants[0].token)}, expected ${WANT.colour}`);
const rendersGive = `${fromRaw(String(gives[0].amount), Number(rowGive.decimals))} ${String(rowGive.name)}`;
const rendersWant = `${fromRaw(String(wants[0].amount), Number(rowWant.decimals))} ${String(rowWant.name)}`;
const expectGive = `${GIVE_AMOUNT} ${GIVE.symbol.toUpperCase()}`;
const expectWant = `${WANT_AMOUNT} ${WANT.symbol.toUpperCase()}`;
if (rendersGive.toUpperCase() !== expectGive.toUpperCase() || rendersWant.toUpperCase() !== expectWant.toUpperCase()) {
  fail(`the offer-files frontend would render '${rendersGive}' for '${rendersWant}', expected `
    + `'${expectGive}' for '${expectWant}' (FR-009, SC-004)`);
}
log(`step 5 OK — the kernel lists it live, and the frontend's own inputs render it as `
  + `"${rendersGive}" for "${rendersWant}"`);
steps["5-publish"] = {
  offerId, bytes: offer.bytes, legSegment: offer.legSegment, imbalances: offer.terms?.imbalances ?? null,
  proveMs: offer.terms?.proveMs ?? null,
  secondOfferRefusal: secondMsg,
  kernelStatus: bookStatus,
  registry: {
    [GIVE.symbol]: { name: rowGive.name, decimals: Number(rowGive.decimals), colour: GIVE.colour },
    [WANT.symbol]: { name: rowWant.name, decimals: Number(rowWant.decimals), colour: WANT.colour },
  },
  frontendRenders: { gives: rendersGive, wants: rendersWant },
  seconds: Math.round((Date.now() - t0) / 1000),
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. the take — by the OWNER'S wallet, through the offer-files SPA's own path
// ═══════════════════════════════════════════════════════════════════════════
log("");
log(`── 6. the owner's wallet takes the offer (${TAKE_VIA === "batcher" ? "the SPA's path: balance, then the batcher" : "direct to the node"}) ──`);
const detail: any = await (await fetch(`${KERNEL}/v1/offers/${offerId}`, { signal: AbortSignal.timeout(30_000) })).json();
const blob = String(detail.offerBech32 ?? detail.offer ?? "");
if (!/^swapoffer1[a-z0-9]+$/.test(blob)) fail(`the kernel's detail for ${offerId} carries no swapoffer1… blob`);

const take = await withFrontendWallet("take", async (ctx) => {
  const st = await syncedState(ctx);
  const before = shieldedOf(st);
  const beforeWant = before[WANT.colour] ?? 0n;
  const beforeGive = before[GIVE.colour] ?? 0n;
  log(`  the owner's wallet before: ${fromRaw(beforeWant, WANT.decimals)} ${WANT.symbol}, `
    + `${fromRaw(beforeGive, GIVE.decimals)} ${GIVE.symbol}`);
  if (beforeWant < wantRaw) fail(`the owner's wallet holds ${beforeWant} ${WANT.symbol} and the offer wants ${wantRaw}`);

  const wallet = ctx.wallet as any;
  const keys = { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey };
  const makerTx = (Transaction as any).deserialize("signature", "proof", "binding", OfferFiles.decode(blob));
  const t = Date.now();
  // The SPA's own options (src/services/localTradeOffers.ts, reproduced in the kernel image's
  // spa-roundtrip.ts): value legs only. Omitting 'dust' is the difference between "the batcher
  // sponsors the fee" and InsufficientFunds — and it is what the page does.
  const balanceOpts: any = TAKE_VIA === "batcher"
    ? { ttl: new Date(Date.now() + TTL_MS), tokenKindsToBalance: ["shielded", "unshielded"] }
    : { ttl: new Date(Date.now() + TTL_MS) };
  const recipe = await wallet.balanceFinalizedTransaction(makerTx, keys, balanceOpts);
  const settlement: any = await wallet.finalizeRecipe(recipe);
  let submitted: Record<string, unknown>;
  if (TAKE_VIA === "batcher") {
    const hex = Array.from(settlement.serialize() as Uint8Array, (b: number) => b.toString(16).padStart(2, "0")).join("");
    const address = ctx.unshieldedKeystore.getBech32Address().asString();
    const res = await fetch(`${BATCHER}/send-input`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          address, addressType: MIDNIGHT_ADDRESS_TYPE,
          input: JSON.stringify({ tx: hex, txStage: "finalized" }),
          timestamp: new Date().toISOString(),
          target: process.env["AA_STORY_BATCHER_TARGET"] ?? "midnight-balancer",
        },
        confirmationLevel: "wait-receipt",
        timeoutMs: Number(process.env["AA_STORY_BATCHER_TIMEOUT_MS"] ?? 900_000),
      }),
      signal: AbortSignal.timeout(960_000),
    });
    const receipt: any = await res.json().catch(() => ({}));
    if (!res.ok || receipt?.success !== true) {
      fail(`the batcher refused the settlement (${res.status}): ${JSON.stringify(receipt).slice(0, 500)}`);
    }
    submitted = { via: "batcher", transactionHash: receipt.transactionHash ?? null, receipt };
    log(`  the batcher settled the take — transactionHash=${receipt.transactionHash ?? "(none reported)"}`);
  } else {
    await wallet.submitTransaction(settlement);
    submitted = { via: "node", transactionHash: settlement.transactionHash?.().toString?.() ?? null };
    log(`  submitted to the node — ${(submitted as any).transactionHash ?? "(no hash)"}`);
  }
  return { beforeWant, beforeGive, submitted, seconds: Math.round((Date.now() - t) / 1000) };
});

// The wallet's own delta is the only thing that says the swap HAPPENED. A batcher receipt
// says "accepted and submitted"; the balances say what moved.
const afterOwner = await withFrontendWallet("delta", async (ctx) => {
  const deadline = Date.now() + Number(process.env["AA_STORY_DELTA_MS"] ?? 300_000);
  for (;;) {
    const st = await syncedState(ctx);
    const now = shieldedOf(st);
    const g = now[GIVE.colour] ?? 0n;
    const w = now[WANT.colour] ?? 0n;
    if (g === take.beforeGive + giveRaw && w === take.beforeWant - wantRaw) return { give: g, want: w };
    if (Date.now() > deadline) return { give: g, want: w };
    await new Promise((r) => setTimeout(r, 6000));
  }
});
if (afterOwner.give !== take.beforeGive + giveRaw || afterOwner.want !== take.beforeWant - wantRaw) {
  fail(`the owner's wallet did not move by exactly the two legs: ${GIVE.symbol} `
    + `${take.beforeGive}→${afterOwner.give} (expected ${take.beforeGive + giveRaw}), ${WANT.symbol} `
    + `${take.beforeWant}→${afterOwner.want} (expected ${take.beforeWant - wantRaw})`);
}
log(`step 6 OK — the owner's wallet paid ${WANT_AMOUNT} ${WANT.symbol} and received ${GIVE_AMOUNT} ${GIVE.symbol}`);
steps["6-take"] = {
  by: "the frontend's in-page wallet (the owner's), seeded from the page's own /config.js",
  via: TAKE_VIA, ...take.submitted, balanceSeconds: take.seconds,
  ownerWalletBefore: { [GIVE.symbol]: fromRaw(take.beforeGive, GIVE.decimals), [WANT.symbol]: fromRaw(take.beforeWant, WANT.decimals) },
  ownerWalletAfter: { [GIVE.symbol]: fromRaw(afterOwner.give, GIVE.decimals), [WANT.symbol]: fromRaw(afterOwner.want, WANT.decimals) },
};

// ═══════════════════════════════════════════════════════════════════════════
// 7. the console NOTICES — no click, no page action (FR-011, SC-005)
// ═══════════════════════════════════════════════════════════════════════════
log("");
log(`── 7. the console reconciles the account by itself (≤ ${RECONCILE_WAIT_MS / 1000}s) ──`);
const noticeStart = Date.now();
let noticed: any = null;
for (;;) {
  const accounts = await api(`/api/accounts?owner=${OWNER}`);
  const row = (accounts.accounts ?? []).find((a: any) => a.address === accountId);
  if (row && row.liveOffer === null && row.lastReconcile?.settled) { noticed = row; break; }
  if (Date.now() - noticeStart > RECONCILE_WAIT_MS) {
    fail(`the console did not reconcile the account within ${RECONCILE_WAIT_MS / 1000}s of the settlement. `
      + `liveOffer=${JSON.stringify(row?.liveOffer ?? null)} lastReconcile=${JSON.stringify(row?.lastReconcile ?? null)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
const noticedIn = Math.round((Date.now() - noticeStart) / 1000);
const heldGive = BigInt(noticed.shielded?.[GIVE.symbol] ?? "0");
const heldWant = BigInt(noticed.shielded?.[WANT.symbol] ?? "0");
if (heldGive !== 0n) fail(`the account still lists ${heldGive} of ${GIVE.symbol}; the settlement nullified that coin`);
if (heldWant !== wantRaw) fail(`the account lists ${heldWant} of ${WANT.symbol}, expected ${wantRaw}`);
if (String(noticed.balancesDecimal?.[WANT.symbol] ?? "") !== WANT_AMOUNT) {
  fail(`the console renders the received ${WANT.symbol} as '${noticed.balancesDecimal?.[WANT.symbol]}', expected '${WANT_AMOUNT}'`);
}
const settleTx = noticed.lastReconcile?.settleTx ?? null;
if (!settleTx?.txHash) fail("the reconcile found no settling transaction for the offer");
const kernelFinal: any = await (await fetch(`${KERNEL}/v1/offers/${offerId}/status`)).json().catch(() => ({}));
log(`step 7 OK in ${noticedIn}s — the account shows ${GIVE.symbol} −${GIVE_AMOUNT} / ${WANT.symbol} +${WANT_AMOUNT}, `
  + `settled by ${settleTx.txHash.slice(0, 16)}… in block ${settleTx.blockHeight}; kernel says '${kernelFinal.status}'`);

// FR-011's second half, and the Refresh button: the same reconcile on demand, IDEMPOTENT.
const refresh = await api("/api/refresh", { accountId });
const again = refresh.reports?.[0];
if (!again) fail("POST /api/refresh answered no report");
if (again.settled) fail("a second reconcile claims to have settled the offer again — it is not idempotent");
const afterRefresh = await api(`/api/accounts?owner=${OWNER}`);
const rowAfter = (afterRefresh.accounts ?? []).find((a: any) => a.address === accountId);
if (JSON.stringify(rowAfter.shielded) !== JSON.stringify(noticed.shielded)) {
  fail(`the Refresh reconcile changed the coin store: ${JSON.stringify(noticed.shielded)} → ${JSON.stringify(rowAfter.shielded)}`);
}
log(`Refresh is idempotent: "${(again.changes ?? []).join(" / ")}"`);
steps["7-console-notices"] = {
  secondsToNotice: noticedIn,
  trigger: noticed.lastReconcile?.trigger ?? null,
  kernelStatus: noticed.lastReconcile?.kernelStatus ?? null,
  finalKernelStatus: kernelFinal.status ?? null,
  settleTx, inboxEntries: noticed.lastReconcile?.inboxEntries ?? null,
  changes: noticed.lastReconcile?.changes ?? [],
  accountBefore: noticed.lastReconcile?.balancesBefore ?? null,
  accountAfter: noticed.lastReconcile?.balancesAfter ?? null,
  accountHolds: noticed.balancesDecimal,
  refreshIsIdempotent: { settled: again.settled, changes: again.changes },
};

// ═══════════════════════════════════════════════════════════════════════════
// · the closing leg — the account SPENDS what it received, back to the funder
// ═══════════════════════════════════════════════════════════════════════════
let closing: Record<string, unknown> | null = null;
if (WITHDRAW_BACK) {
  log("");
  log(`── closing: withdraw the received ${WANT_AMOUNT} ${WANT.symbol} back to ${funder.address} ──`);
  log("   (this is also the reconcile's real test: a coin whose Merkle position was recovered");
  log("    wrongly fails at PROVING and never becomes a transaction)");
  const quoteC = await api("/api/bridge/quote", { direction: "withdraw", token: WANT.erc20, amount: WANT_AMOUNT });
  const gasC = await fundAddress(
    quoteC.vaultEvmAddress, WANT.erc20, WANT.symbol, WANT.decimals, 0n, BigInt(quoteC.requiredEthWei));
  const destBefore = await balanceOf(WANT.erc20, funder.address);
  const vaultCBefore = await balanceOf(WANT.erc20, vaultEvm);
  const wd = await signedAction(
    { kind: "bridge-withdraw-start", accountId, token: WANT.erc20, amount: WANT_AMOUNT, dest: funder.address },
    "withdraw-back");
  const recC = (wd.job.data as any)?.request;
  if (!recC || recC.state !== "completed") fail(`the closing withdrawal ended in state '${recC?.state}': ${recC?.error}`);
  const receiptC = await provider.getTransactionReceipt(recC.evmTxHash);
  if (!receiptC || receiptC.status !== 1) fail(`the closing withdrawal's ERC20 transfer did not succeed (${recC.evmTxHash})`);
  const destAfter = await balanceOf(WANT.erc20, funder.address);
  if (destAfter - destBefore !== wantRaw) {
    fail(`the funder gained ${destAfter - destBefore} ${WANT.symbol}, expected ${wantRaw} `
      + "(measured from the balance recorded BEFORE the relay — the transfer executes there, not at the settle)");
  }
  const vaultCAfter = await balanceOf(WANT.erc20, vaultEvm);
  log(`closing OK — EVM ${recC.evmTxHash} status 1; ${funder.address} gained ${WANT_AMOUNT} ${WANT.symbol}`);
  closing = {
    destination: funder.address, gasFunding: gasC, requestId: recC.requestId,
    startTxId: recC.startTxId, settleTxId: recC.settleTxId,
    evmTxHash: recC.evmTxHash, evmStatus: recC.evmStatus, evmBlock: recC.evmBlock,
    attested: recC.attestedKind, attestationLabel: recC.attestationLabel,
    amount: WANT_AMOUNT, amountRaw: String(wantRaw),
    funderDelta: String(destAfter - destBefore),
    vaultEvmDelta: String(vaultCAfter - vaultCBefore),
  };
  steps["8-withdraw-back"] = closing;
}

// ═══════════════════════════════════════════════════════════════════════════
// the report
// ═══════════════════════════════════════════════════════════════════════════
const vaultEnd = {
  [GIVE.symbol]: fromRaw(await balanceOf(GIVE.erc20, vaultEvm), GIVE.decimals),
  [WANT.symbol]: fromRaw(await balanceOf(WANT.erc20, vaultEvm), WANT.decimals),
};
const funderAfter = {
  eth: formatEth(await provider.getBalance(funder.address)),
  [GIVE.symbol]: fromRaw(await balanceOf(GIVE.erc20, funder.address), GIVE.decimals),
  [WANT.symbol]: fromRaw(await balanceOf(WANT.erc20, funder.address), WANT.decimals),
};
provider.destroy();

const report = {
  kind: "aa-story-e2e",
  version: 1,
  mode: "sepolia",
  chainId: String(network.chainId),
  startedAt: new Date(t0).toISOString(),
  finishedAt: new Date().toISOString(),
  tookSeconds: Math.round((Date.now() - t0) / 1000),
  attestation: info.bridge.attestation,
  account: accountId,
  offerId,
  takeVia: TAKE_VIA,
  spend: {
    note: "what LEFT the funder in this run. Gas parked at an MPC-derived address is spent from the "
      + "funder's point of view even though most of it is still there.",
    ethWei: String(spend.eth), eth: formatEth(spend.eth),
    tokens: Object.fromEntries(Object.entries(spend.tokens).map(([sym, raw]) => {
      const t = sym === GIVE.symbol ? GIVE : WANT;
      return [sym, { raw, decimal: fromRaw(BigInt(raw), t.decimals) }];
    })),
  },
  funderAfter,
  vaultEvmAccountAtEnd: {
    address: vaultEvm, balances: vaultEnd,
    note: "what remains here BACKS coins that still exist on Midnight: the give leg is now held by "
      + "the owner's own wallet, and only an ACCOUNT can withdraw through the bridge — so a "
      + "wallet-held bridged coin has no console-driven way back out. That is the design, not a leak.",
  },
  steps,
  pass: true,
};
mkdirSync(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
log("");
log(`report → ${OUT}`);
log(`PASS — the seven steps in ${report.tookSeconds}s on chain ${report.chainId}`);
log(`${TAG} RESULT account=${accountId} offer=${offerId} settledBy=${String(settleTx.txHash)} `
  + `noticedIn=${noticedIn}s takeVia=${TAKE_VIA}`);
process.exit(0);
