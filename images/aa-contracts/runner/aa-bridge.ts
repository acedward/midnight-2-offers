// aa-bridge.ts — the console's ERC20 bridge layer: tokens, addresses, caps and the
// persisted bridge-request record.
//
// WHERE THE CODE COMES FROM. Nothing here re-implements a derivation. The colour, the
// deposit address, the vault's own EVM account and the relayer all come from the Passport
// fork's `src/wallet/bridge.ts` and the vault package's `src/index.ts`, which this image
// already carries at /aa/passport (the console's own compiled contract is built from the
// same file — see runner/passport.ts). Project 00035 question Q14 records why no `./bridge`
// package export was needed: the image lays the fork's source out as the fork does, and the
// runner imports it by relative path, statically, so a wrong name stops the container.
//
// TWO RECIPIENTS, TWO ADDRESSES, TWO CODE PATHS (spec FR-003/FR-005, 00034 PR-F):
//
//   recipient = right(account contract)   the ACCOUNT path. The account calls the vault
//                                         (depth-2 tree) through `bridge_deposit_start_with_evm`,
//                                         which is DEVICE-GATED — the browser signs it — and
//                                         claims the mint in `bridge_deposit_complete`.
//   recipient = left(coin public key)     the WALLET path. Any funded wallet calls the vault
//                                         at ROOT; the coin mints straight to that key and the
//                                         console never sees the recipient's secrets. The only
//                                         thing the console must be told is the recipient's
//                                         ENCRYPTION public key, which the shielded address
//                                         carries — without it the coin lands and its owner
//                                         cannot see it (00034 question Q42).
//
// Each (vault, recipient) pair has its OWN Ethereum address, and every one of them is scoped
// to the vault's CONTRACT address — so they all change when the chain is wiped (question
// Q13). `./down.sh` without `-v` is what preserves them.
//
// 18-DECIMAL MATH. 10 WEENUS is 10^19, which is larger than Number.MAX_SAFE_INTEGER. Every
// amount in this file is a bigint or a decimal STRING; `Number` is used for nothing but
// decimals counts and array lengths.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ethers } from "ethers";

import {
  AccountBridge,
  DEFAULT_EVM_GAS,
  depositAddressFor,
  randomNonce,
  vaultColour,
  vaultEvmAddressFor,
  type BridgeConfig,
} from "../passport/src/wallet/bridge.js";
import {
  contractRecipient,
  deriveDepositEvmAddress,
  walletRecipient,
  type EitherRecipient,
} from "../passport/contracts/erc20-vault/src/index.ts";
import { normaliseSecp256k1PublicKey } from "../passport/contracts/erc20-vault/src/signet-sdk.ts";

import { BUILD, OUT_DIR, hexToBytes, readArtifact, toHex } from "./passport.ts";

export {
  AccountBridge,
  DEFAULT_EVM_GAS,
  depositAddressFor,
  randomNonce,
  vaultColour,
  vaultEvmAddressFor,
  contractRecipient,
  walletRecipient,
  type BridgeConfig,
  type EitherRecipient,
};

const strip = (h: string): string => String(h ?? "").replace(/^0x/, "").toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** The operator's EVM endpoint. A SECRET (it carries the provider key): it is never put in
 *  `/api/info`, never logged, and never written into a bridge record. compose/aa.yml feeds
 *  it from the same `SIGNET_EVM_RPC_URL` the responder uses, so the two cannot drift. */
export const BRIDGE_RPC_URL = process.env["AA_BRIDGE_EVM_RPC_URL"] ?? "";

/** The gas fields the DEVICE signs, and therefore what the MPC signs verbatim.
 *
 *  Deliberately smaller than the library's `DEFAULT_EVM_GAS` (200,000 × 30 gwei = 0.006 ETH
 *  parked at an MPC-derived address that needs another MPC round trip to sweep). 150,000 ×
 *  10 gwei = 0.0015 ETH is the pair 00034's Sepolia run proved on 2026-09-16, against a
 *  measured base fee of ~1 gwei and an ERC20 `transfer` into a fresh balance slot of ~65k. */
export const EVM_GAS = {
  gasLimit: BigInt(process.env["AA_BRIDGE_GAS_LIMIT"] ?? "150000"),
  maxFeePerGas: BigInt(process.env["AA_BRIDGE_MAX_FEE_WEI"] ?? "10000000000"),
  maxPriorityFeePerGas: BigInt(process.env["AA_BRIDGE_PRIORITY_FEE_WEI"] ?? "1000000000"),
  keyVersion: BigInt(process.env["AA_BRIDGE_KEY_VERSION"] ?? DEFAULT_EVM_GAS.keyVersion),
} as const;

/** What an MPC-signed transaction can cost at most — what its sender address must HOLD
 *  before the transaction can be included. */
export const GAS_BUDGET_WEI = EVM_GAS.gasLimit * EVM_GAS.maxFeePerGas;
/** What to send, with a third of slack over the budget. */
export const GAS_FUNDING_WEI = GAS_BUDGET_WEI + GAS_BUDGET_WEI / 3n;

/** How long a relay may wait for the MPC. Sepolia + our fakenet answered in 41–52 s in the
 *  00034 run; 10 minutes is the stop-and-ask threshold this sub-plan was given. */
export const MPC_TIMEOUT_MS = Number(process.env["AA_BRIDGE_MPC_TIMEOUT_MS"] ?? String(10 * 60_000));

const DEFAULT_TOKENS = [
  "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia USDC, 6 decimals
  "0x7439E9Bb6D8a84dd3A23fe621A30F95403F87fB9", // WEENUS, 18 decimals
].join(",");

export const CONFIGURED_TOKENS: string[] = (process.env["AA_BRIDGE_TOKENS"] ?? DEFAULT_TOKENS)
  .split(",").map((s) => s.trim()).filter(Boolean).map((s) => `0x${strip(s)}`);

const artifact = readArtifact();

export const VAULT_ADDRESS: string | undefined = artifact?.vault?.address;
export const SIGNET_ADDRESS: string | undefined = artifact?.signet?.address;
export const MPC_ROOT_PUBLIC: string | undefined = artifact?.mpc?.rootPublicKey;
export const MPC_PROVENANCE: string | undefined = artifact?.mpc?.provenance;
export const EVM_CHAIN_ID: string | undefined = artifact?.vault?.evmChainId;
/** 00034 question Q62: the responder recovers the Ethereum output by an `eth_call` REPLAY
 *  when the RPC has no `debug` namespace. Every attestation this console shows is labelled
 *  with the kind it actually got, and this is the stack-level caveat beside it. */
export const ATTESTATION_NOTE: string = artifact?.mpc?.attestation
  ?? "unknown (no signet profile on this stack)";

/**
 * Why the Bridge tab is, or is not, usable — one place, so the page, the e2e and the logs
 * all say the same thing.
 *
 * Three independent things have to be true, and each of them fails differently:
 *   * the IMAGE must carry the bridge prover keys (`AA_WITH_BRIDGE=1`; `up.sh --with signet`
 *     exports it). Without them the circuits are deployed on every account but cannot be
 *     proved;
 *   * the VAULT must be pinned to a root key some responder actually holds
 *     (`mpc.provenance === "fakenet"`). A stub-keyed vault would take a deposit whose funds
 *     nothing can ever sweep;
 *   * this process needs an EVM endpoint to read balances and broadcast through.
 */
export function bridgeAvailability(): {
  available: boolean;
  reasons: string[];
  vault: unknown;
  chainId: string | null;
  attestation: string;
  withBridge: boolean;
} {
  const reasons: string[] = [];
  if (!BUILD.withBridge) {
    reasons.push("this aa-contracts image was built without the bridge prover keys "
      + "(AA_WITH_BRIDGE=1; `./up.sh --with aa --with signet` sets it)");
  }
  if (!VAULT_ADDRESS) reasons.push("the deploy receipt carries no vault");
  if (MPC_PROVENANCE !== "fakenet") {
    reasons.push(`the vault's MPC root is '${MPC_PROVENANCE ?? "absent"}', not a key any responder holds `
      + "— bring the stack up with `--with signet` (./down.sh -v first: aa-deploy is idempotent)");
  }
  if (!BRIDGE_RPC_URL) reasons.push("AA_BRIDGE_EVM_RPC_URL is empty (set SIGNET_EVM_RPC_URL in the env file)");
  return {
    available: reasons.length === 0,
    reasons,
    vault: artifact?.vault ?? null,
    chainId: EVM_CHAIN_ID ?? null,
    attestation: ATTESTATION_NOTE,
    withBridge: Boolean(BUILD.withBridge),
  };
}

export function requireBridge(): void {
  const a = bridgeAvailability();
  if (!a.available) throw new Error(`the bridge is not available on this stack: ${a.reasons.join("; ")}`);
}

/** The fixed half of a `BridgeConfig`; `erc20` is per-token. */
export function bridgeConfigFor(erc20: string): BridgeConfig {
  requireBridge();
  return {
    vaultAddress: VAULT_ADDRESS!,
    signetContractAddress: SIGNET_ADDRESS!,
    mpcRootPublicKey: MPC_ROOT_PUBLIC!,
    erc20: `0x${strip(erc20)}`,
    evmRpcUrl: BRIDGE_RPC_URL,
  };
}

/** One provider per call, destroyed by the caller. `staticNetwork` keeps ethers from
 *  re-discovering the chain on every request against a rate-limited free-tier endpoint. */
export function evmProvider(): ethers.JsonRpcProvider {
  requireBridge();
  return new ethers.JsonRpcProvider(BRIDGE_RPC_URL, undefined, { staticNetwork: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

export type BridgedToken = {
  kind: "bridged";
  /** The ERC20's own symbol, read from the contract. */
  symbol: string;
  name: string;
  decimals: number;
  /** 0x-prefixed, lowercase. */
  erc20: string;
  /** The shielded colour this vault mints for it: 64 hex, no 0x. */
  colour: string;
  vault: string;
};

const tokenCache = new Map<string, BridgedToken>();

/** ERC20 metadata + the vault colour, read ONCE per address and cached. The colour is
 *  computed from the vault's own compiled `vaultTokenDomainSeparator`, never re-derived. */
export async function bridgedToken(erc20Address: string): Promise<BridgedToken> {
  requireBridge();
  const key = `0x${strip(erc20Address)}`;
  if (!/^0x[0-9a-f]{40}$/.test(key)) throw new Error(`not an ERC20 address: ${erc20Address}`);
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const provider = evmProvider();
  try {
    const c = new ethers.Contract(key, ERC20_ABI, provider);
    const [symbol, decimals, name] = await Promise.all([
      (c as any).symbol() as Promise<string>,
      (c as any).decimals() as Promise<bigint>,
      (c as any).name().catch(() => "") as Promise<string>,
    ]);
    const token: BridgedToken = {
      kind: "bridged",
      symbol: String(symbol),
      name: String(name || symbol),
      decimals: Number(decimals),
      erc20: key,
      colour: toHex(vaultColour(VAULT_ADDRESS!, key)),
      vault: VAULT_ADDRESS!,
    };
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      throw new Error(`${key}: decimals() returned ${String(decimals)}`);
    }
    tokenCache.set(key, token);
    return token;
  } finally {
    provider.destroy();
  }
}

/** The configured set, plus anything a caller has already asked about. Failures are
 *  reported per token rather than failing the whole list: one unreachable ERC20 must not
 *  hide the others. */
export async function bridgedTokens(): Promise<{ tokens: BridgedToken[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const tokens: BridgedToken[] = [];
  for (const address of CONFIGURED_TOKENS) {
    try {
      tokens.push(await bridgedToken(address));
    } catch (e) {
      errors[address] = e instanceof Error ? e.message : String(e);
    }
  }
  for (const t of tokenCache.values()) {
    if (!tokens.some((x) => x.erc20 === t.erc20)) tokens.push(t);
  }
  return { tokens, errors };
}

/** Resolve "USDC", "weenus" or an 0x address against the configured set. */
export async function resolveToken(idOrSymbol: string): Promise<BridgedToken> {
  const raw = String(idOrSymbol ?? "").trim();
  if (!raw) throw new Error("token is required (a symbol or an ERC20 address)");
  if (/^0x?[0-9a-fA-F]{40}$/.test(raw)) return await bridgedToken(raw);
  const { tokens } = await bridgedTokens();
  const hit = tokens.find((t) => t.symbol.toUpperCase() === raw.toUpperCase());
  if (!hit) {
    throw new Error(`unknown bridged token '${raw}' — configured: `
      + `${tokens.map((t) => t.symbol).join(", ") || "(none resolved)"}; pass an ERC20 address for any other`);
  }
  return hit;
}

// ── decimal ↔ raw, bigint only ──────────────────────────────────────────────

/** Decimal string → raw units. Rejects more fraction digits than the token has, rather
 *  than silently truncating a 19-digit WEENUS amount. */
export function toRaw(amount: string | number | bigint, decimals: number): bigint {
  const s = typeof amount === "bigint" ? amount.toString() : String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`amount must be a non-negative decimal number, got '${s}'`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`${s} has ${frac.length} fraction digits but the token has ${decimals} decimals`);
  }
  return BigInt(whole! + frac.padEnd(decimals, "0"));
}

/** Raw units → decimal string, trailing zeros trimmed. No `Number` anywhere. */
export function fromRaw(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export const formatEth = (wei: bigint | string): string => fromRaw(BigInt(wei), 18);

// ─────────────────────────────────────────────────────────────────────────────
// Recipients and addresses
// ─────────────────────────────────────────────────────────────────────────────

export type BridgeRecipient =
  | { kind: "account"; accountId: string }
  | { kind: "wallet"; coinPublicKey: string; encryptionPublicKey: string; shieldedAddress?: string };

export function recipientEither(r: BridgeRecipient): EitherRecipient {
  return r.kind === "account"
    ? contractRecipient(hexToBytes(strip(r.accountId)))
    : walletRecipient(hexToBytes(strip(r.coinPublicKey)));
}

/** The Ethereum address a depositor must fund for this recipient. Derived from the VAULT's
 *  own `depositPath` pure circuit, so no TypeScript re-implementation can drift from it. */
export function depositAddressOf(cfg: BridgeConfig, r: BridgeRecipient): string {
  return r.kind === "account"
    ? depositAddressFor(cfg, r.accountId)
    : deriveDepositEvmAddress(
      normaliseSecp256k1PublicKey(cfg.mpcRootPublicKey), strip(cfg.vaultAddress), recipientEither(r));
}

export const recipientLabel = (r: BridgeRecipient): string =>
  r.kind === "account" ? `account ${r.accountId.slice(0, 18)}…` : `wallet key ${r.coinPublicKey.slice(0, 16)}…`;

// ─────────────────────────────────────────────────────────────────────────────
// Caps (spec FR-017)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-token caps in DECIMAL units, summed over the console store's lifetime. The two the
 *  owner set (question Q8) are defaults; anything else needs `AA_BRIDGE_CAP_<SYMBOL>` or a
 *  non-zero `AA_BRIDGE_CAP_DEFAULT`, so an unknown ERC20 is refused rather than uncapped. */
export function capDecimalFor(symbol: string): string {
  const key = `AA_BRIDGE_CAP_${symbol.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const builtin: Record<string, string> = { USDC: "5", WEENUS: "50" };
  return process.env[key] ?? builtin[symbol.toUpperCase()] ?? process.env["AA_BRIDGE_CAP_DEFAULT"] ?? "0";
}

export const ETH_CAP_WEI = (): bigint => toRaw(process.env["AA_BRIDGE_CAP_ETH"] ?? "0.05", 18);

// ─────────────────────────────────────────────────────────────────────────────
// The persisted bridge-request store (spec FR-006)
// ─────────────────────────────────────────────────────────────────────────────

export type BridgeState =
  | "started" | "signed" | "broadcast" | "attested" | "completed"
  | "closed-false" | "refunded" | "error";

export type BridgeRequest = {
  /** The vault's own request id (64 hex). It is the resume key: `POST /api/bridge/relay/:id`. */
  requestId: string;
  direction: "deposit" | "withdraw";
  recipient: BridgeRecipient;
  /** Present for the account path; the account whose custody the coin lands in. */
  accountId: string | null;
  erc20: string;
  symbol: string;
  decimals: number;
  colour: string;
  amountRaw: string;
  /** Deposits only. */
  depositAddress: string | null;
  /** Withdrawals only. */
  destEvmAddress: string | null;
  startTxId: string | null;
  settleTxId: string | null;
  evmTxHash: string | null;
  evmStatus: number | null;
  evmBlock: number | null;
  /** `success` | `returned-false` | `never-executed`, straight from the relayer. */
  attestedKind: string | null;
  /** How the responder learned the Ethereum output. "replayed (demo-grade)" whenever the
   *  RPC has no `debug_traceTransaction`, which is this stack's normal case (00034 Q62). */
  attestationLabel: string | null;
  state: BridgeState;
  error: string | null;
  jobId: string | null;
  /** The serialised relay result, so a settle can run without waiting for the MPC again. */
  relay: unknown | null;
  /** The planned coin, chosen BEFORE the settle so its inbox entry can be sealed in the
   *  same transaction. Kept so a resumed settle claims the coin it already announced. */
  planned: { mintNonceHex: string; colourHex: string; value: string } | null;
  createdAt: string;
  updatedAt: string;
  log: string[];
};

type BridgeStore = {
  kind: "aa-console-bridge-store";
  version: 1;
  /** Cap accounting, summed over this store's lifetime (it lives on the `aa-out` volume,
   *  so `./down.sh -v` resets it with the chain — which is the right lifetime: the vault,
   *  and therefore every address a cap protects, is new after a wipe). */
  spent: { tokens: Record<string, string>; ethWei: string };
  requests: BridgeRequest[];
};

export const BRIDGE_STORE_PATH = process.env["AA_BRIDGE_STORE_PATH"] ?? `${OUT_DIR}/aa-bridge.json`;

const emptyStore = (): BridgeStore => ({
  kind: "aa-console-bridge-store", version: 1,
  spent: { tokens: {}, ethWei: "0" },
  requests: [],
});

export function loadBridgeStore(): BridgeStore {
  if (!existsSync(BRIDGE_STORE_PATH)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(BRIDGE_STORE_PATH, "utf-8"));
    return { ...emptyStore(), ...raw, spent: { ...emptyStore().spent, ...(raw.spent ?? {}) } };
  } catch {
    return emptyStore();
  }
}

function saveBridgeStore(store: BridgeStore): void {
  mkdirSync(dirname(BRIDGE_STORE_PATH), { recursive: true });
  writeFileSync(BRIDGE_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

export function upsertRequest(record: BridgeRequest): BridgeRequest {
  const store = loadBridgeStore();
  const next = { ...record, updatedAt: new Date().toISOString() };
  const i = store.requests.findIndex((r) => r.requestId === record.requestId);
  if (i >= 0) store.requests[i] = next; else store.requests.push(next);
  saveBridgeStore(store);
  return next;
}

export function findRequest(requestId: string): BridgeRequest | null {
  return loadBridgeStore().requests.find((r) => r.requestId === strip(requestId)) ?? null;
}

export function requireRequest(requestId: string): BridgeRequest {
  const r = findRequest(requestId);
  if (!r) throw new Error(`this console has no bridge request ${String(requestId).slice(0, 18)}…`);
  return r;
}

/**
 * The most ONE deposit or withdrawal can carry: 2^64 − 1 raw units.
 *
 * It is the VAULT's own assertion, not a client policy —
 * `assert(amount <= 18446744073709551615, "Amount exceeds Uint<64> max")` on `startDeposit` and
 * `startWithdraw`, because `completeDeposit` mints through a `Uint<64>` API. The ledger's coin
 * value is u128 and 10^19 fits it comfortably; the MINT API is what binds.
 *
 * It is checked HERE because the alternative was measured (project 00035 question Q17): a request
 * for 20 WEENUS (2×10^19) failed inside the start's proof, with the contract's own message, AFTER
 * the operator had already sent 20 WEENUS and the gas to the deposit address. A ceiling an operator
 * only meets after spending is not a ceiling, it is a trap.
 *
 * For an 18-decimal token this is ~18.45 units, which is a small enough number to reach by accident
 * — hence the message says the ceiling in the token's own decimals rather than in raw units.
 */
export const LEG_CEILING_RAW = 18_446_744_073_709_551_615n;

export function assertLegCeiling(symbol: string, amountRaw: bigint, decimals: number): void {
  if (amountRaw <= LEG_CEILING_RAW) return;
  throw new Error(
    `${fromRaw(amountRaw, decimals)} ${symbol} is more than one bridge leg can carry: the vault mints `
    + `through a Uint<64> API, so a single deposit or withdrawal tops out at `
    + `${fromRaw(LEG_CEILING_RAW, decimals)} ${symbol} (2^64-1 raw units). Split it into smaller `
    + "deposits — they share one deposit address, so only the first needs funding with gas",
  );
}

/** Read-only cap check, for a quote and for the prepare step: a refusal must arrive before
 *  the wallet is asked to sign, not after. `chargeCap` applies the same rules and commits. */
export function assertCapHeadroom(symbol: string, amountRaw: bigint, decimals: number, ethWei: bigint): void {
  const store = loadBridgeStore();
  const key = symbol.toUpperCase();
  const capDecimal = capDecimalFor(symbol);
  const capRaw = toRaw(capDecimal, decimals);
  const spent = BigInt(store.spent.tokens[key] ?? "0");
  if (capRaw === 0n) {
    throw new Error(`no Sepolia spend cap is set for ${key}: set AA_BRIDGE_CAP_${key} `
      + "(decimal units) or AA_BRIDGE_CAP_DEFAULT. An uncapped bridged token is refused by design (FR-017)");
  }
  if (spent + amountRaw > capRaw) {
    throw new Error(`cap exceeded for ${key}: this stack has already bridged ${fromRaw(spent, decimals)} of `
      + `${capDecimal}, and ${fromRaw(amountRaw, decimals)} more would pass it. `
      + `Headroom: ${fromRaw(capRaw - spent, decimals)} ${key}`);
  }
  const ethCap = ETH_CAP_WEI();
  const ethSpent = BigInt(store.spent.ethWei);
  if (ethSpent + ethWei > ethCap) {
    throw new Error(`ETH cap exceeded: this stack has already authorised ${formatEth(ethSpent)} of `
      + `${formatEth(ethCap)} ETH of gas, and ${formatEth(ethWei)} more would pass it`);
  }
}

/**
 * Charge the caps. Called at START, which is the only moment a console action commits the
 * operator to sending anything: the tokens are the deposit (or withdrawal) amount, and the ETH
 * is the gas budget the console is about to ask for. Throws BEFORE anything is spent.
 *
 * IT COUNTS WHAT WAS AUTHORISED, NOT WHAT MOVED, and there is no refund. A start that is
 * charged and then fails — the vault refusing it, the proof failing, the operator abandoning it —
 * leaves the charge standing, so the ledger drifts ABOVE the truth over a stack's lifetime.
 * Measured on B's own run: 45 WEENUS charged against 25 actually bridged, because one start was
 * refused by the vault's Uint<64> assertion after the cap had been taken.
 *
 * That is the direction a spend ceiling should drift. A cap is a bound on exposure, not an
 * accountant: under-counting would let a stack quietly exceed the number its owner agreed to,
 * and over-counting costs nothing but a `./down.sh -v` (which resets it with the chain, because
 * the vault and every address it protects are new after a wipe anyway).
 */
export function chargeCap(symbol: string, amountRaw: bigint, decimals: number, ethWei: bigint): void {
  assertCapHeadroom(symbol, amountRaw, decimals, ethWei);
  const store = loadBridgeStore();
  const key = symbol.toUpperCase();
  store.spent.tokens[key] = (BigInt(store.spent.tokens[key] ?? "0") + amountRaw).toString();
  store.spent.ethWei = (BigInt(store.spent.ethWei) + ethWei).toString();
  saveBridgeStore(store);
}

export function capView(token: BridgedToken): {
  symbol: string; capDecimal: string; spentDecimal: string; headroomDecimal: string;
  ethCap: string; ethSpent: string; ethHeadroom: string;
} {
  const store = loadBridgeStore();
  const key = token.symbol.toUpperCase();
  const capRaw = toRaw(capDecimalFor(token.symbol), token.decimals);
  const spent = BigInt(store.spent.tokens[key] ?? "0");
  const ethCap = ETH_CAP_WEI();
  const ethSpent = BigInt(store.spent.ethWei);
  return {
    symbol: key,
    capDecimal: fromRaw(capRaw, token.decimals),
    spentDecimal: fromRaw(spent, token.decimals),
    headroomDecimal: fromRaw(capRaw > spent ? capRaw - spent : 0n, token.decimals),
    ethCap: formatEth(ethCap),
    ethSpent: formatEth(ethSpent),
    ethHeadroom: formatEth(ethCap > ethSpent ? ethCap - ethSpent : 0n),
  };
}

export function newRequestRecord(fields: Partial<BridgeRequest> & {
  requestId: string; direction: "deposit" | "withdraw"; recipient: BridgeRecipient;
  erc20: string; symbol: string; decimals: number; colour: string; amountRaw: string;
}): BridgeRequest {
  const now = new Date().toISOString();
  return {
    accountId: null, depositAddress: null, destEvmAddress: null,
    startTxId: null, settleTxId: null,
    evmTxHash: null, evmStatus: null, evmBlock: null,
    attestedKind: null, attestationLabel: null,
    state: "started", error: null, jobId: null, relay: null, planned: null,
    createdAt: now, updatedAt: now, log: [],
    ...fields,
    requestId: strip(fields.requestId),
  };
}

// ── relay-result (de)serialisation ──────────────────────────────────────────
// The relay result carries Uint8Arrays and bigints inside a nested circuit-input object, so
// a settle that runs after a restart has to reconstruct them rather than re-wait for the MPC.
// Same encoding the 00034 driver uses.

export function serialiseRelay(r: unknown): unknown {
  return JSON.parse(JSON.stringify(r, (_k, v) => {
    if (typeof v === "bigint") return { __bigint: String(v) };
    if (v instanceof Uint8Array) return { __bytes: toHex(v) };
    return v;
  }));
}

export function deserialiseRelay(r: unknown): any {
  const walk = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (typeof v.__bigint === "string") return BigInt(v.__bigint);
    if (typeof v.__bytes === "string") return hexToBytes(v.__bytes);
    if (Array.isArray(v)) return v.map(walk);
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = walk(v[k]);
    return o;
  };
  return walk(r);
}

/** The label every surface shows beside an attestation. There are two facts and they are
 *  different: WHAT the MPC attested (`success` / `returned-false` / `never-executed`) and
 *  HOW it learned the output. This stack's responder replays with `eth_call` whenever the
 *  RPC has no `debug` namespace, which is demo-grade (00034 question Q62). */
export function attestationLabelFor(kind: string): string {
  const how = /replay/i.test(ATTESTATION_NOTE) ? "replayed (demo-grade)" : "traced";
  return `${kind} · ${how}`;
}
