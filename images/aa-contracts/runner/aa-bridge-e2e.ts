// aa-bridge-e2e.ts — the headless proof of the ERC20 bridge, driven entirely over the
// console's OWN HTTP API (spec FR-016, SC-006).
//
//   ./scripts/aa-bridge-e2e.sh                 (real EVM chain, needs the `signet` profile)
//
//   an Ethereum key (the code path MetaMask executes, minus the extension)
//     → register      deploy + activate ONE account contract for that key
//     → guard         start a deposit whose address is empty, and be REFUSED by name
//     → deposit A     an ERC20 into the ACCOUNT: device-gated start → MPC → settle
//     → deposit B     an ERC20 to a FRESH MIDNIGHT WALLET the console holds no key of
//     → withdraw      part of the account's bridged coin back to the funder's EVM address
//     → caps          ask for more than the cap and be refused before anything moves
//     → resume        press the relay route again on a finished request; nothing is redone
//
// ── WHAT MAKES IT A TEST OF THE CONSOLE AND NOT OF A LIBRARY ────────────────
// Every step here is an HTTP call to the running aa-console, in the order and the shape the
// browser page makes them: `/api/prepare` → sign locally → `/api/submit` → poll `/api/jobs`.
// Nothing imports the console's internals. What this file adds on top of the page is the one
// thing a browser cannot do — moving tokens on the EVM chain — and that is why the funder key
// lives here and NEVER in the console (spec FR-015).
//
// ── THE THREE ASSERTIONS THAT ARE NOT ABOUT MIDNIGHT ────────────────────────
//   1. the ERC20 `transfer` the MPC signed was MINED with status 1, at the hash the console
//      reported — not at some other hash the run found for itself (SC-002);
//   2. the deposit address is EMPTY afterwards: the sweep took everything it was told to;
//   3. the withdrawal's destination gained exactly the withdrawn amount, measured from the
//      balance recorded BEFORE the relay — the ERC20 transfer executes during the relay, not
//      at the settle, so a window around the settle shows nothing moving (00034 S-F finding).
//
// ── AND THE ONE THAT IS THE POINT OF THE WALLET PATH ────────────────────────
// A wallet the console holds no key of, synced from its own seed, must SEE the coin. Without
// the recipient's encryption key mapped into the settle transaction the coin still belongs to
// them and is invisible (00034 question Q42), which is a silent failure; this is the check
// that catches it.

import "./passport-env.ts";

import { mkdirSync, writeFileSync } from "node:fs";
import * as Rx from "rxjs";

import { ethers } from "ethers";
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
for (const pkg of ["@metamask/eth-sig-util"]) {
  const where = Bun.resolveSync(pkg, "/aa");
  if (!where.startsWith("/aa/node_modules/")) {
    console.error(`[aa-bridge-e2e] ${pkg} resolved to ${where}, not /aa/node_modules — refusing to run`);
    process.exit(2);
  }
}
const { personalSign, signTypedData, SignTypedDataVersion } = await import("@metamask/eth-sig-util");

const TAG = "[aa-bridge-e2e]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
const fail = (msg: string): never => { console.error(`${TAG} FAIL ${msg}`); process.exit(1); };

const BASE = (process.env["AA_BRIDGE_E2E_URL"] ?? "http://aa-console:8090").replace(/\/+$/, "");
const OUT = process.env["AA_BRIDGE_E2E_OUT"] ?? "/aa/out/aa-bridge-e2e.json";
const MODE = process.env["AA_BRIDGE_E2E_MODE"] ?? "sepolia";
const RPC_URL = process.env["AA_BRIDGE_E2E_RPC_URL"] ?? "";
const FUNDER_KEY = process.env["AA_BRIDGE_E2E_FUNDER_KEY"] ?? "";
/** A throwaway EVM key: the run's "MetaMask". Public by design, like every seed in this repo. */
const OWNER_KEY = (process.env["AA_BRIDGE_E2E_OWNER_KEY"] ?? `0x${"b21d6e".padStart(64, "0")}`) as `0x${string}`;
/** The recipient of the WALLET-path deposit: a Midnight wallet generated per run, whose seed
 *  the console never learns. */
const RECIPIENT_SEED = process.env["AA_BRIDGE_E2E_RECIPIENT_SEED"] ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
/**
 * `wallet` runs ONLY the wallet-recipient deposit, to an address given rather than generated.
 *
 * That is the demo's step 3 — "bridge WEENUS to the owner's own Midnight wallet" — and it is the
 * same code path as the full run's step 4, which is the point: the demo is not a second
 * implementation. The recipient's SEED is unknown in this mode (it is the owner's), so the
 * "and they can see it" half is proved separately, by `./scripts/wallet-balance.sh` run against
 * that wallet — the only party that can answer it is one holding its keys.
 */
const ONLY = process.env["AA_BRIDGE_E2E_ONLY"] ?? "";
const RECIPIENT_ADDRESS = process.env["AA_BRIDGE_E2E_RECIPIENT_ADDRESS"] ?? "";
if (ONLY && ONLY !== "wallet") fail(`AA_BRIDGE_E2E_ONLY must be empty or 'wallet', got '${ONLY}'`);
if (ONLY === "wallet" && !RECIPIENT_ADDRESS.startsWith("mn_shield-addr")) {
  fail("AA_BRIDGE_E2E_ONLY=wallet needs AA_BRIDGE_E2E_RECIPIENT_ADDRESS (a mn_shield-addr… address)");
}

const TOKEN_A = process.env["AA_BRIDGE_E2E_TOKEN_A"] ?? "USDC";     // → the account
const TOKEN_B = process.env["AA_BRIDGE_E2E_TOKEN_B"] ?? "WEENUS";   // → a Midnight wallet
const AMOUNT_A = process.env["AA_BRIDGE_E2E_AMOUNT_A"] ?? "0.5";
const AMOUNT_B = process.env["AA_BRIDGE_E2E_AMOUNT_B"] ?? "10";
const AMOUNT_WITHDRAW = process.env["AA_BRIDGE_E2E_WITHDRAW"] ?? "0.2";
const JOB_TIMEOUT_MS = Number(process.env["AA_BRIDGE_E2E_JOB_TIMEOUT_MS"] ?? 2_400_000);

if (!RPC_URL) fail("AA_BRIDGE_E2E_RPC_URL is required (the EVM endpoint this run funds through)");
if (!FUNDER_KEY) fail("AA_BRIDGE_E2E_FUNDER_KEY is required (scripts/aa-bridge-e2e.sh reads it from the operator's env)");

const steps: Record<string, unknown> = {};
const t0 = Date.now();

// ── the console's API, exactly as the page calls it ─────────────────────────

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) fail(`${path} answered ${res.status}: ${text.slice(0, 500)}`);
  return parsed as T;
}

/** The same call, but the REFUSAL is the expected result. Returns the message. */
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

// ── the EVM side: the ONE thing a browser cannot do ─────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined,
  MODE === "anvil" ? { staticNetwork: true, cacheTimeout: -1 } : { staticNetwork: true });
const funder = new ethers.Wallet(FUNDER_KEY.startsWith("0x") ? FUNDER_KEY : `0x${FUNDER_KEY}`, provider);
const erc20Of = (address: string) => new ethers.Contract(address, ERC20_ABI, funder);

const spend = { eth: 0n, tokens: {} as Record<string, string> };

/** Send tokens and gas to a deposit address. On a local chain the token is MINTED and the gas
 *  is set outright; on a public one both are transfers from the operator's funder, and every
 *  unit is a real test asset — which is why the amounts are capped and recorded. */
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
    if (MODE === "anvil") {
      await provider.send("anvil_setBalance", [to, `0x${(BigInt(haveEth) + need).toString(16)}`]);
    } else {
      const tx = await funder.sendTransaction({ to, value: need });
      gasTx = (await tx.wait(1))!.hash;
      spend.eth += need;
    }
    log(`  gas   ${formatEth(need)} ETH → ${to} ${gasTx ?? "(anvil_setBalance, no transaction)"}`);
  } else log(`  gas   already present (${formatEth(BigInt(haveEth))} ETH)`);
  if (BigInt(haveToken) < amountRaw) {
    const need = amountRaw - BigInt(haveToken);
    const tx = MODE === "anvil" ? await (token as any).mint(to, need) : await (token as any).transfer(to, need);
    tokenTx = (await tx.wait(1))!.hash;
    spend.tokens[symbol] = String(BigInt(spend.tokens[symbol] ?? "0") + need);
    log(`  token ${fromRaw(need, decimals)} ${symbol} → ${to} ${tokenTx}`);
  } else log(`  token already present`);
  return { token: tokenTx, gas: gasTx };
}

const balanceOf = async (erc20: string, who: string): Promise<bigint> =>
  BigInt(await (erc20Of(erc20) as any).balanceOf(who));

// ═══════════════════════════════════════════════════════════════════════════
// 0. what the stack says about itself
// ═══════════════════════════════════════════════════════════════════════════
log(`mode ${MODE}; console ${BASE}; funder ${funder.address}`);
const info = await api("/api/info");
if (!info.bridge?.available) {
  fail(`the console says the bridge is not available: ${JSON.stringify(info.bridge?.reasons ?? info.bridge)}`);
}
const network = await provider.getNetwork();
if (String(network.chainId) !== String(info.bridge.chainId)) {
  fail(`this run's RPC serves chain ${network.chainId}, and the vault is pinned to ${info.bridge.chainId} — `
    + "every derived deposit address is scoped to the pinned chain, so funding one on another chain strands it");
}
const tokenList = await api("/api/bridge/tokens");
const pickToken = (symbol: string) => {
  const t = (tokenList.tokens ?? []).find((x: any) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!t) fail(`the console lists no bridged token '${symbol}' (has: ${(tokenList.tokens ?? []).map((x: any) => x.symbol).join(", ")})`);
  return t;
};
const A = pickToken(TOKEN_A);
const B = pickToken(TOKEN_B);
const amountA = toRaw(AMOUNT_A, A.decimals);
const amountB = toRaw(AMOUNT_B, B.decimals);
const amountW = toRaw(AMOUNT_WITHDRAW, A.decimals);
log(`token A ${A.symbol} ${A.decimals}d ${A.erc20} colour ${A.colour.slice(0, 16)}…`);
log(`token B ${B.symbol} ${B.decimals}d ${B.erc20} colour ${B.colour.slice(0, 16)}…`);
if (amountW > amountA) fail(`the withdrawal (${AMOUNT_WITHDRAW}) is larger than the deposit (${AMOUNT_A})`);
steps["0-info"] = {
  chainId: String(network.chainId), vault: info.bridge.vault?.address,
  vaultEvmAddress: tokenList.vaultEvmAddress, attestation: info.bridge.attestation,
  tokens: [A, B].map((t) => ({ symbol: t.symbol, decimals: t.decimals, erc20: t.erc20, colour: t.colour })),
  funder: funder.address,
  funderBefore: {
    eth: formatEth(await provider.getBalance(funder.address)),
    [A.symbol]: fromRaw(await balanceOf(A.erc20, funder.address), A.decimals),
    [B.symbol]: fromRaw(await balanceOf(B.erc20, funder.address), B.decimals),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. register a throwaway account
// ═══════════════════════════════════════════════════════════════════════════
let accountId = "";
if (ONLY !== "wallet") {
  log("");
  log(`── 1. register an account for ${OWNER} (two transactions, k=18 proving) ──`);
  const reg = await signedAction({ kind: "register" }, "register");
  accountId = reg.job.data?.address ?? reg.job.txId;
  if (!/^[0-9a-f]{64}$/i.test(String(accountId))) fail(`register finished without an account address`);
  log(`account ${accountId}`);
  steps["1-register"] = { owner: OWNER, accountId, seconds: Math.round((Date.now() - t0) / 1000) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. the guard: an empty deposit address is refused BEFORE anything is spent
// ═══════════════════════════════════════════════════════════════════════════
let quoteA0: any = null;
let recA: any = null;
let fundA: any = null;
let vaultEvm: string = tokenList.vaultEvmAddress;
if (ONLY !== "wallet") {
log("");
log("── 2. guard: start a deposit before funding the address (FR-004) ──");
quoteA0 = await api("/api/bridge/quote", {
  direction: "deposit", token: A.erc20, amount: AMOUNT_A, recipient: { account: accountId },
});
if (quoteA0.ready) fail("the quote says READY for an address nothing has funded");
const guardMsg = await apiExpectRefusal("/api/prepare",
  { kind: "bridge-deposit-start", owner: OWNER, accountId, token: A.erc20, amount: AMOUNT_A },
  "a deposit start with an unfunded address");
if (!/holds .* and this deposit needs|Send .* ETH/i.test(guardMsg)) {
  fail(`the refusal does not name the shortfall: ${guardMsg}`);
}
steps["2-guard"] = {
  depositAddress: quoteA0.depositAddress, ready: quoteA0.ready,
  shortfall: quoteA0.shortfall, refusal: guardMsg,
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. deposit A into the ACCOUNT
// ═══════════════════════════════════════════════════════════════════════════
log("");
log(`── 3. deposit ${AMOUNT_A} ${A.symbol} into the account ──`);
log(`  deposit address ${quoteA0.depositAddress} (required ETH ${quoteA0.requiredEth})`);
fundA = await fundAddress(
  quoteA0.depositAddress, A.erc20, A.symbol, A.decimals, amountA, BigInt(quoteA0.requiredEthWei));
const quoteA1 = await api("/api/bridge/quote", {
  direction: "deposit", token: A.erc20, amount: AMOUNT_A, recipient: { account: accountId },
});
if (!quoteA1.ready) fail(`the address is funded and the quote still says not ready: ${JSON.stringify(quoteA1.shortfall)}`);
const vaultABefore = await balanceOf(A.erc20, vaultEvm);
const depA = await signedAction(
  { kind: "bridge-deposit-start", accountId, token: A.erc20, amount: AMOUNT_A }, "deposit-to-account");
recA = (depA.job.data as any)?.request;
if (!recA) fail("the deposit job carries no bridge request record");
if (recA.state !== "completed") fail(`the deposit ended in state '${recA.state}': ${recA.error ?? "(no error)"}`);
if (!recA.evmTxHash) fail("the deposit completed without an EVM transaction hash");

// The three EVM assertions, each against the chain rather than against the job's own word.
const receiptA = await provider.getTransactionReceipt(recA.evmTxHash);
if (!receiptA) fail(`no receipt on chain for the hash the console reported (${recA.evmTxHash})`);
if (receiptA.status !== 1) fail(`the deposit's ERC20 transfer has status ${receiptA.status}`);
if (receiptA.from.toLowerCase() !== String(quoteA0.depositAddress).toLowerCase()) {
  fail(`the mined transfer was sent by ${receiptA.from}, not by the derived deposit address`);
}
const depAAfter = await balanceOf(A.erc20, quoteA0.depositAddress);
if (depAAfter !== 0n) fail(`the deposit address still holds ${fromRaw(depAAfter, A.decimals)} ${A.symbol}`);
const vaultAAfter = await balanceOf(A.erc20, vaultEvm);
if (vaultAAfter - vaultABefore !== amountA) {
  fail(`the vault's EVM account moved by ${vaultAAfter - vaultABefore}, expected ${amountA}`);
}

// …and the Midnight side, read back over the same API the page reads.
const accountsAfterA = await api(`/api/accounts?owner=${OWNER}`);
const rowA = (accountsAfterA.accounts ?? []).find((a: any) => a.address === accountId);
const heldA = BigInt(rowA?.shielded?.[A.symbol] ?? "0");
if (heldA !== amountA) {
  fail(`the account's coin store holds ${heldA} of ${A.symbol}, expected ${amountA} `
    + `(${AMOUNT_A} at ${A.decimals} decimals)`);
}
if (BigInt(rowA.inboxCount ?? "0") < 1n) fail("inbox_count did not advance — the claimed coin filed no entry");
log(`deposit A OK — EVM ${recA.evmTxHash} status 1, attested ${recA.attestationLabel}, `
  + `the account holds ${fromRaw(heldA, A.decimals)} ${A.symbol}`);
steps["3-deposit-account"] = {
  depositAddress: quoteA0.depositAddress, funding: fundA, requestId: recA.requestId,
  startTxId: recA.startTxId, settleTxId: recA.settleTxId,
  evmTxHash: recA.evmTxHash, evmStatus: recA.evmStatus, evmBlock: recA.evmBlock,
  attested: recA.attestedKind, attestationLabel: recA.attestationLabel,
  amount: AMOUNT_A, amountRaw: String(amountA), colour: A.colour,
  accountHolds: fromRaw(heldA, A.decimals), inboxCount: rowA.inboxCount,
  vaultEvmDelta: String(vaultAAfter - vaultABefore),
  depositAddressAfter: String(depAAfter),
};
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. deposit B to a MIDNIGHT WALLET the console holds no key of
// ═══════════════════════════════════════════════════════════════════════════
log("");
log(`── 4. deposit ${AMOUNT_B} ${B.symbol} to a fresh Midnight wallet ──`);
// In `wallet` mode the address is GIVEN (it is the owner's wallet, whose seed nobody here
// has); otherwise it is a wallet generated for this run, so the run can prove the recipient
// sees the coin by syncing it.
let recipientAddress = RECIPIENT_ADDRESS;
let recipientKeys: { coinPublicKey: string; encryptionPublicKey: string } = { coinPublicKey: "", encryptionPublicKey: "" };
const recipientCtx: any = ONLY === "wallet" ? null : await createWallet(RECIPIENT_SEED);
if (recipientCtx) try {
  const st: any = await Rx.firstValueFrom((recipientCtx.wallet as any).state());
  recipientKeys = {
    coinPublicKey: String(st.shielded.coinPublicKey.toHexString()).replace(/^0x/, "").toLowerCase(),
    encryptionPublicKey: String(st.shielded.encryptionPublicKey.toHexString()).replace(/^0x/, "").toLowerCase(),
  };
  recipientAddress = MidnightBech32m.encode(CONFIG.networkId as any, new (ShieldedAddress as any)(
    new (ShieldedCoinPublicKey as any)(Buffer.from(recipientKeys.coinPublicKey, "hex")),
    new (ShieldedEncryptionPublicKey as any)(Buffer.from(recipientKeys.encryptionPublicKey, "hex")),
  )).asString();
} finally {
  await (recipientCtx.wallet as any).stop?.().catch(() => {});
}
log(`recipient ${recipientAddress.slice(0, 34)}… (its seed is generated per run and never leaves this process)`);
const quoteB = await api("/api/bridge/quote", {
  direction: "deposit", token: B.erc20, amount: AMOUNT_B, recipient: { shieldedAddress: recipientAddress },
});
if (quoteA0 && quoteB.depositAddress === quoteA0.depositAddress) {
  fail("the wallet recipient derived the SAME deposit address as the account — the recipient is not in the path");
}
log(`  deposit address ${quoteB.depositAddress}`);
const fundB = await fundAddress(
  quoteB.depositAddress, B.erc20, B.symbol, B.decimals, amountB, BigInt(quoteB.requiredEthWei));
const vaultBBefore = await balanceOf(B.erc20, vaultEvm);
const startB = await api("/api/bridge/deposit/start", {
  token: B.erc20, amount: AMOUNT_B, recipient: { shieldedAddress: recipientAddress },
});
const jobB = await awaitJob(startB.jobId, "deposit-to-wallet");
const recB = (jobB.data as any)?.request;
if (!recB || recB.state !== "completed") fail(`the wallet deposit ended in state '${recB?.state}': ${recB?.error}`);
const receiptB = await provider.getTransactionReceipt(recB.evmTxHash);
if (!receiptB || receiptB.status !== 1) fail(`the wallet deposit's ERC20 transfer did not succeed (${recB.evmTxHash})`);
const vaultBAfter = await balanceOf(B.erc20, vaultEvm);
if (vaultBAfter - vaultBBefore !== amountB) {
  fail(`the vault's EVM account moved by ${vaultBAfter - vaultBBefore} of ${B.symbol}, expected ${amountB}`);
}

// THE assertion of this path: the recipient, syncing on its own, sees the coin. Skipped only
// in `wallet` mode, where the recipient is the OWNER's wallet and nothing here holds its seed —
// `./scripts/wallet-balance.sh` answers it from that wallet's side instead.
const seen = ONLY === "wallet" ? amountB : await (async () => {
  log("syncing the recipient wallet from its own seed (the console never had its keys)…");
  const ctx: any = await createWallet(RECIPIENT_SEED);
  try {
    const deadline = Date.now() + Number(process.env["AA_BRIDGE_E2E_SYNC_MS"] ?? 420_000);
    for (;;) {
      const st: any = await Rx.firstValueFrom((ctx.wallet as any).state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((x: any) => x.isSynced === true),
        Rx.timeout({ each: 300_000, with: () => Rx.throwError(() => new Error("recipient wallet sync timeout")) }),
      ));
      const bal = st.shielded?.balances;
      const entries = bal instanceof Map ? [...bal.entries()] : Object.entries(bal ?? {});
      const hit = entries.find(([colour]) => String(colour).replace(/^0x/, "").toLowerCase() === B.colour);
      if (hit && BigInt(hit[1] as any) > 0n) return BigInt(hit[1] as any);
      if (Date.now() > deadline) return 0n;
      await new Promise((r) => setTimeout(r, 8000));
    }
  } finally {
    await (ctx.wallet as any).stop?.().catch(() => {});
  }
})();
if (ONLY !== "wallet" && seen !== amountB) {
  fail(`the recipient wallet sees ${seen} of the bridged ${B.symbol} colour, expected ${amountB}. `
    + "A coin that lands without the recipient's encryption key mapped into the settle is invisible to them "
    + "(00034 question Q42) — that is the failure this check exists for");
}
log(ONLY === "wallet"
  ? `deposit B OK — EVM ${recB.evmTxHash} status 1; ${fromRaw(amountB, B.decimals)} ${B.symbol} minted to `
    + `${recipientAddress.slice(0, 34)}…. Prove the other half from that wallet: ./scripts/wallet-balance.sh`
  : `deposit B OK — EVM ${recB.evmTxHash} status 1; the recipient wallet sees `
    + `${fromRaw(seen, B.decimals)} ${B.symbol} by syncing from its own seed`);
steps["4-deposit-wallet"] = {
  recipientShieldedAddress: recipientAddress,
  recipientCoinPublicKey: recipientKeys!.coinPublicKey,
  depositAddress: quoteB.depositAddress, funding: fundB, requestId: recB.requestId,
  startTxId: recB.startTxId, settleTxId: recB.settleTxId,
  evmTxHash: recB.evmTxHash, evmStatus: recB.evmStatus, evmBlock: recB.evmBlock,
  attested: recB.attestedKind, attestationLabel: recB.attestationLabel,
  amount: AMOUNT_B, amountRaw: String(amountB), colour: B.colour,
  ...(ONLY === "wallet"
    ? { recipientSeenBy: "not checked here — the recipient's seed is the owner's; use ./scripts/wallet-balance.sh" }
    : { recipientSeesRaw: String(seen), recipientSees: fromRaw(seen, B.decimals) }),
  vaultEvmDelta: String(vaultBAfter - vaultBBefore),
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. withdraw part of the account's bridged coin back to the funder
// ═══════════════════════════════════════════════════════════════════════════
let recW: any = null;
if (ONLY !== "wallet") {
log("");
log(`── 5. withdraw ${AMOUNT_WITHDRAW} ${A.symbol} back to ${funder.address} ──`);
const quoteW0 = await api("/api/bridge/quote", { direction: "withdraw", token: A.erc20, amount: AMOUNT_WITHDRAW });
log(`  the vault's own EVM account ${quoteW0.vaultEvmAddress} holds ${quoteW0.balances.eth} ETH`);
const gasW = await fundAddress(
  quoteW0.vaultEvmAddress, A.erc20, A.symbol, A.decimals, 0n, BigInt(quoteW0.requiredEthWei));
const destBefore = await balanceOf(A.erc20, funder.address);
const vaultWBefore = await balanceOf(A.erc20, vaultEvm);
const wd = await signedAction(
  { kind: "bridge-withdraw-start", accountId, token: A.erc20, amount: AMOUNT_WITHDRAW, dest: funder.address },
  "withdraw");
recW = (wd.job.data as any)?.request;
if (!recW || recW.state !== "completed") fail(`the withdrawal ended in state '${recW?.state}': ${recW?.error}`);
const receiptW = await provider.getTransactionReceipt(recW.evmTxHash);
if (!receiptW || receiptW.status !== 1) fail(`the withdrawal's ERC20 transfer did not succeed (${recW.evmTxHash})`);
const destAfter = await balanceOf(A.erc20, funder.address);
if (destAfter - destBefore !== amountW) {
  fail(`the destination gained ${destAfter - destBefore}, expected ${amountW} `
    + "(measured from the balance recorded BEFORE the relay — the transfer executes there, not at the settle)");
}
const vaultWAfter = await balanceOf(A.erc20, vaultEvm);
if (vaultWBefore - vaultWAfter !== amountW) {
  fail(`the vault's EVM account fell by ${vaultWBefore - vaultWAfter}, expected ${amountW}`);
}
const accountsAfterW = await api(`/api/accounts?owner=${OWNER}`);
const rowW = (accountsAfterW.accounts ?? []).find((a: any) => a.address === accountId);
const heldAfterW = BigInt(rowW?.shielded?.[A.symbol] ?? "0");
if (heldAfterW !== amountA - amountW) {
  fail(`the account's ${A.symbol} coin is ${heldAfterW} after the withdrawal, expected ${amountA - amountW}`);
}
log(`withdraw OK — EVM ${recW.evmTxHash} status 1; ${funder.address} gained `
  + `${fromRaw(amountW, A.decimals)} ${A.symbol}, the account keeps ${fromRaw(heldAfterW, A.decimals)}`);
steps["5-withdraw"] = {
  destination: funder.address, gasFunding: gasW, requestId: recW.requestId,
  startTxId: recW.startTxId, settleTxId: recW.settleTxId,
  evmTxHash: recW.evmTxHash, evmStatus: recW.evmStatus, evmBlock: recW.evmBlock,
  attested: recW.attestedKind, attestationLabel: recW.attestationLabel,
  amount: AMOUNT_WITHDRAW, amountRaw: String(amountW),
  destinationDelta: String(destAfter - destBefore),
  vaultEvmDelta: String(vaultWAfter - vaultWBefore),
  accountChange: fromRaw(heldAfterW, A.decimals),
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. the caps, and the resume route's idempotency
// ═══════════════════════════════════════════════════════════════════════════
log("");
log("── 6. caps (FR-017) and the resumable relay (FR-006) ──");
const cap = (await api("/api/bridge/tokens")).tokens.find((t: any) => t.symbol === A.symbol).cap;
const overCap = `${BigInt(Math.ceil(Number(cap.capDecimal))) + 10n}`;
const capMsg = await apiExpectRefusal("/api/bridge/quote",
  { direction: "deposit", token: A.erc20, amount: overCap, recipient: { account: accountId } },
  `a quote for ${overCap} ${A.symbol}, past the ${cap.capDecimal} cap`);
if (!/cap exceeded/i.test(capMsg)) fail(`the cap refusal does not say so: ${capMsg}`);
const capStartMsg = await apiExpectRefusal("/api/prepare",
  { kind: "bridge-deposit-start", owner: OWNER, accountId, token: A.erc20, amount: overCap },
  `a deposit start for ${overCap} ${A.symbol}`);
if (!/cap exceeded/i.test(capStartMsg)) fail(`the cap refusal at start does not say so: ${capStartMsg}`);

// Pressing the resume route on a finished request must do NOTHING — not re-relay, not
// re-settle, not re-spend. That is what makes it safe to offer in the UI.
const resume = await api(`/api/bridge/relay/${recA.requestId}`, {});
const resumeJob = await awaitJob(resume.jobId, "resume");
const resumed = (resumeJob.data as any)?.request;
if (resumed?.settleTxId !== recA.settleTxId) {
  fail(`resuming a completed request changed its settle transaction (${resumed?.settleTxId} vs ${recA.settleTxId})`);
}
steps["6-guards"] = {
  cap, overCapRequested: overCap, refusedAtQuote: capMsg, refusedAtStart: capStartMsg,
  resumeOnCompleted: { requestId: recA.requestId, unchangedSettleTxId: resumed?.settleTxId },
};
}

// ═══════════════════════════════════════════════════════════════════════════
// the report
// ═══════════════════════════════════════════════════════════════════════════
const funderAfter = {
  eth: formatEth(await provider.getBalance(funder.address)),
  [A.symbol]: fromRaw(await balanceOf(A.erc20, funder.address), A.decimals),
  [B.symbol]: fromRaw(await balanceOf(B.erc20, funder.address), B.decimals),
};
provider.destroy();

const report = {
  kind: "aa-bridge-e2e",
  mode: MODE,
  only: ONLY || "full",
  chainId: String(network.chainId),
  startedAt: new Date(t0).toISOString(),
  finishedAt: new Date().toISOString(),
  tookSeconds: Math.round((Date.now() - t0) / 1000),
  attestation: info.bridge.attestation,
  spend: {
    note: "what LEFT the funder in this run. The gas parked at an MPC-derived address is spent from "
      + "the funder's point of view even though most of it is still there.",
    ethWei: String(spend.eth), eth: formatEth(spend.eth),
    tokens: Object.fromEntries(Object.entries(spend.tokens).map(([sym, raw]) => {
      const t = sym === A.symbol ? A : B;
      return [sym, { raw, decimal: fromRaw(BigInt(raw), t.decimals) }];
    })),
  },
  funderAfter,
  steps,
};
mkdirSync(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
log("");
log(`report → ${OUT}`);
log(ONLY === "wallet"
  ? `PASS — one deposit to a Midnight wallet, in ${report.tookSeconds}s on chain ${report.chainId}`
  : `PASS — deposit to an account, deposit to a wallet, a withdrawal, the guards and the caps, `
    + `in ${report.tookSeconds}s on chain ${report.chainId}`);
log(ONLY === "wallet"
  ? `${TAG} RESULT walletDeposit=${recB.evmTxHash} recipient=${recipientAddress}`
  : `${TAG} RESULT account=${accountId} depositA=${recA.evmTxHash} depositB=${recB.evmTxHash} withdraw=${recW?.evmTxHash}`);
