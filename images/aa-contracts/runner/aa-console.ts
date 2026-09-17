// aa-console.ts — the AA web console's relay service (compose service `aa-console`):
//
//   browser EVM wallet (EIP-1193, signs EIP-712 only) → THIS relay (builds the typed data,
//   recovers the signer's secp256k1 point from the signature, proves through the compose
//   aa-proof-server, submits, pays fees) → the user's own PASSPORT ACCOUNT → Midnight.
//
// ⚠ PROJECT 00034 CHANGED WHAT IS ON THE OTHER SIDE OF THE ARROW. It used to be one shared
// AA-v3 Manager contract and one `execute` gateway carrying a selector. It is now ONE
// CONTRACT PER USER — a fork of the Midnight Passport account — and one circuit per
// operation. Four consequences a reader of this file needs up front:
//
//   1. REGISTER DEPLOYS A CONTRACT (Q40). The account id IS the contract address, and a
//      contract address does not exist until its deploy transaction is built, so there is
//      no id to sign over in advance. Registration is two transactions and minutes of
//      proving, not one `execute`. The console keeps the owner → address map itself
//      (./aa-store.ts) because nothing on chain does.
//   2. THE SIGNATURE IS NEVER CARRIED ALONE. A gated circuit takes `(…args, pk,
//      use_counter, sig)`: the PUBLIC POINT, which no EVM wallet exposes, is recovered from
//      the signature itself, and `use_counter` is the device's rolling position, which the
//      chain stores only as an entry HASH (MIP-0013 S11) — so the console keeps a roster
//      and re-verifies it against ledger membership on every call.
//   3. CUSTODY IS STATELESS (MIP-0012 §6.5). A shielded coin the account holds is NOT in
//      ledger state; it lives in the owner's private coin store, and the chain carries only
//      an encrypted inbox entry. So a deposit is coin + entry, and the console has to walk
//      the inbox and capture the coin's `mt_index` afterwards or the coin is unspendable.
//   4. THE INTERNAL TRANSFERS ARE GONE (Q41). Both accounts used to be rows in one
//      contract's balance map; they are now separate contracts, and an account never calls
//      another account. The console's send is withdraw → deposit through a wallet.
//
// Session machinery keeps the three measured rules from the master plan's T7.5: short
// transaction TTLs, ONE FACADE PER TRANSACTION (a single-worker job queue enforces it), and
// a SHIELDED-FREE relay wallet (fund with scripts/fund-wallet.sh — unshielded NIGHT + DUST
// only; up.sh does it when the profile comes up).

import "./passport-env.ts";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Rx from "rxjs";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
} from "@midnightntwrk/wallet-sdk-address-format";

import { ethers } from "ethers";

import * as VaultModule from "../passport/contracts/erc20-vault/managed/Erc20Vault/contract/index.js";

import { parseMidnightBech32m } from "./midnight-bech32m.ts";
import { shieldedUserRecipient, unshieldedUserRecipient } from "./mint-recipient.ts";
import { buildKernelOffer } from "./aa-offer.ts";
import {
  ARTIFACT_PATH,
  BUILD,
  CONFIG,
  ROSTER_PATH,
  SWAP_CIRCUIT,
  WALLET_PROOF_SERVER,
  CONTRACT_PROOF_SERVER,
  VAULT_ZK_PATH,
  bytes32,
  coinPublicKeyBytes,
  consoleAccountCircuits,
  consoleCompiledAccount,
  consoleWaves,
  createWallet,
  hexToBytes,
  openWallet,
  providersFor,
  randomBytes32,
  readArtifact,
  toHex,
  userAddressBytes,
  zkConfigPath,
} from "./passport.ts";
import {
  AccountBridge,
  ATTESTATION_NOTE,
  EVM_GAS,
  GAS_BUDGET_WEI,
  GAS_FUNDING_WEI,
  MPC_TIMEOUT_MS,
  assertCapHeadroom,
  attestationLabelFor,
  bridgeAvailability,
  bridgeConfigFor,
  bridgedToken,
  bridgedTokens,
  capView,
  chargeCap,
  depositAddressOf,
  deserialiseRelay,
  evmProvider,
  findRequest,
  formatEth,
  fromRaw,
  loadBridgeStore,
  newRequestRecord,
  randomNonce as randomMintNonce,
  recipientEither,
  recipientLabel,
  requireBridge,
  requireRequest,
  resolveToken,
  serialiseRelay,
  toRaw,
  upsertRequest,
  vaultColour,
  vaultEvmAddressFor,
  ERC20_ABI,
  type BridgeRecipient,
  type BridgeRequest,
  type BridgedToken,
} from "./aa-bridge.ts";
import {
  coinStoreOf,
  findByAddress,
  findByOwner,
  loadStore,
  saveStore,
  upsert,
  type AccountRecord,
} from "./aa-store.ts";

import { CustodyAccount, deployEvmAccount } from "../passport/src/wallet/account.js";
import {
  EvmDevice,
  authArgs,
  authorise,
  eip191Digest,
  evmChallengeFor,
  evmTypedMessage,
  type AuthRequest,
  type CallContext,
} from "../passport/src/wallet/signer.js";
// The raw secp256k1 helpers are NOT in signer.ts — they are its dependency, one module down.
// They were reached through `await import("./signer.js")` until 2026-09-16, which is a silent
// `undefined` per name at CALL time: `signer.js` exists, so the import resolves, and the
// destructure of a name it does not export yields undefined rather than throwing. Only two
// code paths used them — the console recovering a wallet's public point from an enrolment
// signature, and the dev signer — and neither runs in `aa-e2e.sh`, which holds a private key
// and computes the point directly. `verify.sh --aa-mint` is the only gate that reaches them,
// and it caught this. Imported STATICALLY now: a wrong name here fails at module load, so the
// console does not start rather than failing in front of a user mid-registration.
import {
  ethereumAddress,
  lowS,
  parseSignature,
  recoverPoint,
  serializeSignature,
  signDigest,
} from "../passport/src/wallet/evm-signature.js";
import { buildTypedData, computeDigest } from "../passport/src/wallet/eip712.js";
import { generateEncKeyPair } from "../passport/src/wallet/inbox.js";
import { depositAsThirdParty, inboxWalkPortable } from "../passport/src/wallet/deposit.js";
import { candidateIndices, mtIndexForSingleOutput } from "../passport/src/wallet/capture.js";
import { sealInboxEntry } from "../passport/src/wallet/inbox.js";
import {
  buildOpenSwapTypedData,
  freshWantNonce,
  offerAuthArgs,
  offerInboxEntries,
  openSwapChallenge,
  openSwapDigest,
  openSwapMessage,
  predictChangeCoin,
  signOpenSwapOffer,
  RECIPIENT_OPEN,
  type OfferCallArgs,
} from "../passport/src/wallet/offer.js";

const TAG = "[aa-console]";
const log = (...a: unknown[]) => console.log(TAG, ...a);

const PORT = Number(process.env["AA_CONSOLE_PORT"] ?? 8090);
const RELAY_SEED = process.env["AA_CONSOLE_SEED"]
  ?? "aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0";
const TAKER_SEED = process.env["AA_TAKER_SEED"]
  ?? "7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e";
// Shielded funding runs on the aa-deploy wallet (genesis-3): prefunded, and it already
// holds the colour minted at bring-up. The RELAY wallet stays shielded-free (T7.5 rule) —
// that is the entire reason for the second seed.
const FUNDER_SEED = process.env["MIDNIGHT_WALLET_SEED"]
  ?? "0000000000000000000000000000000000000000000000000000000000000003";
const DEV_SIGNER = /^(1|true|yes)$/i.test(process.env["AA_CONSOLE_DEV_SIGNER"] ?? "");
// A throwaway dev key for the env-gated built-in signer (automated verification without a
// wallet extension). Public by design, like every seed in this repo.
const DEV_KEY = hexToBytes("d".repeat(60) + "c0de");
const DEV_DEVICE = EvmDevice.fromPrivateKey(DEV_KEY);
// ⚠ `EvmDevice.addressHex` ALREADY CARRIES THE `0x`. Measured, not assumed: the client's own
// `toHex` prefixes, while this file's does not, and the two are one character apart in a
// value that is compared as a STRING against the owner the page sends. Wrapping it again
// produced `0x0x…`, which failed the owner regex and made the dev signer unusable while
// every log line still looked plausible. `DEV_OWNER` is the bare form this file compares.
const DEV_ADDR = DEV_DEVICE.addressHex;
const DEV_OWNER = DEV_ADDR.replace(/^0x/, "").toLowerCase();

const KERNEL_URL = process.env["AA_KERNEL_URL"] ?? "http://kernel:9999";
const SINK_URL = process.env["AA_SINK_URL"] ?? "http://solver-sink:8080";
const SOLVER_FRONTEND_PUBLIC_URL =
  process.env["AA_SOLVER_FRONTEND_PUBLIC_URL"] ?? "http://127.0.0.1:10802";
const SOLVER_FRONTEND_URL = process.env["AA_SOLVER_FRONTEND_URL"] ?? "http://solver-frontend:8080";
const SOLVER_STATUS_URL = process.env["AA_SOLVER_STATUS_URL"] ?? "http://solver:9100";
const OFFER_POSTER_URL = process.env["AA_OFFER_POSTER_URL"] ?? "http://offer-poster:9977";
const FAUCET_URL = process.env["AA_FAUCET_URL"] ?? "http://faucet-site:14119";
const FAUCET_PUBLIC_URL = process.env["AA_FAUCET_PUBLIC_URL"] ?? "http://127.0.0.1:10950";
const NETWORK_KEY = process.env["AA_FAUCET_NETWORK"] ?? "undeployed";

const artifact = readArtifact();
if (!artifact) throw new Error(`${ARTIFACT_PATH} is missing — bring the stack up with ./up.sh --with aa`);
const VAULT_ADDRESS = artifact?.vault?.address as string | undefined;
const TEST_FAUCET = artifact?.testFaucet?.address as string | undefined;

// ── the token set: the LOCAL FAUCET's registry (unchanged by 00034) ─────────
// Six mint-test-tokens issuers, one contract each, published as a registry document by
// the `faucet` profile. The console reads it rather than deriving anything: the colours
// are `tokenType(_domain, kernel.self())` computed ON CHAIN at deploy time, and the
// decimals are 8/18/6/6/6/8 rather than the 6 this console used to assume.
type TokenInfo = {
  name: string;
  family: "shielded" | "unshielded";
  color: string;
  decimals: number;
  issuer: string;
  label: string;
  /** Where the colour comes from. `faucet` tokens are minted by one of the six local
   *  mint-test-tokens issuers; `bridged` ones are minted by the ERC20 VAULT and have no
   *  issuer at all, so every mint path must refuse them by name rather than by a null
   *  dereference three calls later. */
  source?: "faucet" | "bridged";
  /** Bridged tokens only: the ERC20 on the EVM chain this colour represents. */
  erc20?: string;
};
const tokens: { list: TokenInfo[]; registryRevision: string | null; error: string | null } = {
  list: [], registryRevision: null, error: null,
};
const tokenByName = (name: string): TokenInfo => {
  const t = tokens.list.find((x) => x.name === name);
  if (!t) {
    throw new Error(
      `unknown token '${name}' — the faucet registry lists ${tokens.list.map((x) => x.name).join(", ") || "nothing"}` +
      ` (${tokens.error ?? "no error"}). Bring the profile up: ./up.sh --with faucet --with aa`,
    );
  }
  return t;
};
const ofFamily = (family: "shielded" | "unshielded"): TokenInfo[] =>
  tokens.list.filter((t) => t.family === family);
const defaultToken = (family: "shielded" | "unshielded", index = 0): TokenInfo => {
  const candidates = ofFamily(family);
  const hit = candidates[index] ?? candidates[0];
  if (!hit) {
    throw new Error(
      `no ${family} token in the faucet registry (have: ${tokens.list.map((t) => t.name).join(", ") || "nothing"};` +
      ` ${tokens.error ?? "no error"}). Bring the profile up: ./up.sh --with faucet --with aa`,
    );
  }
  return hit;
};
const defaultTokenName = (family: "shielded" | "unshielded", index = 0): string =>
  defaultToken(family, index).name;

async function resolveTokens() {
  const url = `${FAUCET_URL}/metadata.${NETWORK_KEY}.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const doc: any = await res.json();
    if (doc.status !== "ready") throw new Error(`registry is '${doc.status}', not ready`);
    const list: TokenInfo[] = [];
    for (const token of doc.tokens ?? []) {
      const active = (token.deployments ?? []).find(
        (d: any) => d.deploymentId === token.activeDeploymentId && d.status === "active");
      if (!active) continue;
      const color = String(active.tokenId ?? "").toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(color)) throw new Error(`${token.symbol}: tokenId is not a 64-hex colour`);
      if (token.privacy !== "shielded" && token.privacy !== "unshielded") {
        throw new Error(`${token.symbol}: unknown privacy '${token.privacy}'`);
      }
      if (!Number.isInteger(token.decimals)) throw new Error(`${token.symbol}: decimals is not an integer`);
      list.push({
        name: String(token.symbol),
        label: String(token.name ?? token.symbol),
        family: token.privacy,
        color,
        decimals: token.decimals,
        issuer: String(active.contractAddress ?? "").replace(/^0x/, ""),
      });
    }
    if (list.length === 0) throw new Error("the registry carries no ACTIVE token");
    for (const t of list) t.source = "faucet";
    tokens.list = [...list, ...bridged.list];
    tokens.registryRevision = doc.registryRevision ?? doc.revision ?? null;
    tokens.error = null;
    log(`tokens resolved from ${url}: ` +
      list.map((t) => `${t.name}=${t.color.slice(0, 8)}…/${t.decimals}d`).join(" "));
  } catch (e) {
    tokens.error = e instanceof Error ? e.message : String(e);
    log(`token resolution FAILED (faucet profile down?): ${tokens.error} — token ops will error until it succeeds`);
  }
}

// ── the bridged colours: a SECOND token source (spec FR-008) ─────────────────
//
// The console's list used to be the faucet registry and nothing else. A bridged colour has
// no issuer, no faucet and no entry there: it is `tokenType(vaultTokenDomainSeparator(erc20),
// vault)`, and its decimals are the ERC20's — 6 for USDC and 18 for WEENUS, which is why
// every amount on every surface is rendered by decimals rather than assumed (question Q6).
// They are appended AFTER the faucet tokens so the positional defaults the page uses
// ("the Nth shielded token") keep pointing at what they pointed at before.

const bridged: { list: TokenInfo[]; error: string | null; registered: string[] } = {
  list: [], error: null, registered: [],
};

async function resolveBridgedTokens(): Promise<void> {
  if (!bridgeAvailability().available) {
    bridged.list = [];
    return;
  }
  try {
    const { tokens: found, errors } = await bridgedTokens();
    bridged.list = found.map((t) => ({
      name: t.symbol,
      label: `${t.name} (bridged from ${t.erc20.slice(0, 10)}…)`,
      family: "shielded" as const,
      color: t.colour,
      decimals: t.decimals,
      issuer: "",
      source: "bridged" as const,
      erc20: t.erc20,
    }));
    bridged.error = Object.keys(errors).length ? JSON.stringify(errors) : null;
    // Keep the merged list current even when the faucet registry has not moved.
    const faucetOnly = tokens.list.filter((t) => t.source !== "bridged");
    tokens.list = [...faucetOnly, ...bridged.list];
    if (bridged.list.length) {
      log(`bridged colours: ${bridged.list.map((t) => `${t.name}=${t.color.slice(0, 8)}…/${t.decimals}d`).join(" ")}`);
    }
  } catch (e) {
    bridged.error = e instanceof Error ? e.message : String(e);
    log(`bridged-token resolution failed: ${bridged.error}`);
  }
}

/**
 * Put the bridged colours in the kernel's name registry (spec FR-009), so the offer-files
 * frontend renders an offer in them as "1 USDC" and "10 WEENUS" rather than as 1000000 and
 * 10000000000000000000.
 *
 * Idempotent and fail-soft. `POST /v1/known-tokens` is the only write route the kernel has —
 * there is no PUT and no DELETE — and `name` is UNIQUE, so a row that already names ANOTHER
 * colour cannot be repaired from here. That is reported loudly and the console carries on:
 * the registry is a display convenience, and nothing about custody depends on it.
 */
async function registerBridgedColours(): Promise<void> {
  if (!bridged.list.length) return;
  let rows: any[] = [];
  try {
    const res = await fetch(`${KERNEL_URL}/v1/known-tokens`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`GET /v1/known-tokens -> ${res.status}`);
    const body: any = await res.json();
    rows = Array.isArray(body) ? body : (body.tokens ?? body.knownTokens ?? []);
  } catch (e) {
    log(`kernel token registry unreachable (${e instanceof Error ? e.message : String(e)}) — `
      + "bridged colours will be registered on a later pass");
    return;
  }
  for (const t of bridged.list) {
    const want = t.name.toUpperCase();
    if (bridged.registered.includes(want)) continue;
    const row = rows.find((r: any) => String(r.name ?? "").toUpperCase() === want);
    const colour = String(row?.color ?? row?.token_color ?? "").toLowerCase().replace(/^0x/, "");
    if (row && colour === t.color) {
      bridged.registered.push(want);
      continue;
    }
    if (row) {
      log(`WARNING: the kernel's '${want}' row names colour ${colour.slice(0, 16)}…, not this vault's `
        + `${t.color.slice(0, 16)}…. The kernel has no update route, so the offer-files frontend will show `
        + "the wrong symbol for this colour until that row is corrected out of band");
      continue;
    }
    try {
      const res = await fetch(`${KERNEL_URL}/v1/known-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color: t.color, name: want, kind: "shielded", decimals: t.decimals }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
      bridged.registered.push(want);
      log(`registered the bridged colour ${want} (${t.decimals}d, ${t.color.slice(0, 16)}…) in the kernel registry`);
    } catch (e) {
      log(`could not register ${want} in the kernel registry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── the console's own state file ─────────────────────────────────────────────

const readStore = () => loadStore(ROSTER_PATH);
const writeRecord = (record: AccountRecord) => saveStore(ROSTER_PATH, upsert(readStore(), record));
const requireRecord = (address: string): AccountRecord => {
  const r = findByAddress(readStore(), address);
  if (!r) {
    throw new Error(
      `this console has no record of account ${address.slice(0, 18)}… — it holds the coin store and the ` +
      "encryption secret, so an account registered by another console cannot be driven from here (Q40)",
    );
  }
  return r;
};

// ── wallet sessions (one facade per transaction — T7.5 rule) ────────────────

const unshieldedTotal = (st: any): bigint => {
  const bal = st.unshielded?.balances;
  if (!bal) return 0n;
  const vals = bal instanceof Map ? [...bal.values()] : Object.values(bal);
  return vals.reduce((a: bigint, v: any) => a + (v ?? 0n), 0n);
};

/**
 * Open a wallet, run `fn`, close it. The fork's `createWallet` + a sync that also waits for
 * funds when the caller needs them, because a facade that is synced but empty fails later,
 * inside proving, with a message about DUST rather than about funding.
 */
async function session<T>(
  label: string,
  fn: (ctx: any) => Promise<T>,
  opts: { requireFunds?: boolean; seed?: string } = {},
): Promise<T> {
  const requireFunds = opts.requireFunds ?? true;
  const walletCtx: any = await createWallet(opts.seed ?? RELAY_SEED);
  try {
    await Rx.firstValueFrom(
      (walletCtx.wallet as any).state().pipe(
        // THE THROTTLE IS LOAD-BEARING, not politeness: `isSynced` flaps true → false → true
        // early in a sync, so a filter on the raw stream can fire on a wallet that is about to
        // un-sync itself — and the transaction built against that view fails minutes later,
        // inside proving, with a message about dust. Sampling every 5 s waits for a state that
        // has stayed synced. (The fork's own `syncWallet` does the same, for the same reason.)
        Rx.throttleTime(5_000),
        Rx.filter((st: any) => {
          if (st.isSynced !== true) return false;
          return requireFunds ? unshieldedTotal(st) > 0n : true;
        }),
        Rx.timeout({
          each: 240_000,
          with: () => Rx.throwError(() => new Error(
            `${label}: wallet sync timeout` +
            (requireFunds ? " (wallet unfunded? run scripts/fund-wallet.sh with this seed)" : ""),
          )),
        }),
      ),
    );
    return await fn(walletCtx);
  } finally {
    await (walletCtx.wallet as any).stop?.().catch(() => {});
  }
}

// ── the mint-test-tokens issuers ─────────────────────────────────────────────
// ONE CONTRACT PER TOKEN. The generated modules are COPIED into this image from the pinned
// mint-test-tokens tree and never recompiled: those exact bytes are the ones whose verifier
// keys the `faucet` profile registered on chain. They are zkir-v2 / [v6], so they prove on
// the PLAIN proof server — while every Passport circuit is [v7] and proves on the
// experimental one. That split is the reason this helper builds its own providers instead
// of reusing `providersFor`.
const MTT_MODULE = { shielded: "contract-mtt-shielded", unshielded: "contract-mtt-unshielded" } as const;

async function joinIssuer(walletCtx: any, token: TokenInfo) {
  if (tokens.list.length === 0) await resolveTokens();
  if (token.source === "bridged") {
    throw new Error(
      `${token.name} is a BRIDGED colour: it is minted by the ERC20 vault against tokens that arrived `
      + "on the EVM chain, and no faucet can create it. Use the Bridge tab (or /api/bridge/…) to bring "
      + "more of it in",
    );
  }
  if (!token.issuer) throw new Error(`${token.name}: the registry carries no issuer address (${tokens.error ?? "?"})`);
  const name = MTT_MODULE[token.family];
  const zkPath = resolve("/aa", name, "src", "managed");
  const Mod: any = await import(resolve(zkPath, "contract", "index.js"));
  const compiled = CompiledContract.make(name, Mod.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkPath),
  );
  const providers: any = await providersFor(walletCtx, zkPath);
  // …and back to the PLAIN server for this one contract — with ITS OWN bundle, not a
  // registry. A registry exists to prove a CALL TREE: it spans the artefact root so a
  // caller's proof can reach every callee's keys. An issuer is a leaf — one standalone
  // contract, no callees — and the only root this image has is the Passport fork's, which
  // contains no issuer bundle at all. Handing that registry to the issuer's proof provider
  // is what produced `ZKArtifactNotFoundError: No ZK artifact bundle matches the deployed
  // verifier key … circuit 'mint'` on 2026-09-16: the message says "missing or stale
  // artifacts", but the artifacts were neither — the provider was looking in the wrong tree.
  // `createProviders` already built the leaf provider over `zkPath`; reuse it.
  providers.proofProvider = httpClientProofProvider(WALLET_PROOF_SERVER, providers.zkConfigProvider);
  const handle = await (findDeployedContract as any)(providers, {
    contractAddress: token.issuer,
    compiledContract: compiled,
    privateStateId: `mtt-${token.family}-${Date.now().toString(36)}`,
    initialPrivateState: {},
  });
  return { Mod, handle, providers, compiled };
}

async function mintShieldedTo(walletCtx: any, j: Job, token: TokenInfo, amount: bigint) {
  const issuer = await joinIssuer(walletCtx, token);
  const nonce = randomBytes32();
  const state: any = await Rx.firstValueFrom((walletCtx.wallet as any).state());
  const coinPublicKey = String(state.shielded.coinPublicKey.toHexString());
  jlog(j, `mint ${amount} ${token.name} (${token.decimals}d) → this wallet (${coinPublicKey.replace(/^0x/, "").slice(0, 12)}…)`);
  const tx: any = await (issuer.handle.callTx as any).mint(
    shieldedUserRecipient(coinPublicKey), amount, nonce,
  );
  jlog(j, `minted ${token.name} — tx=${tx.public?.txId ?? "?"}`);
  return tx;
}

async function mintUnshieldedTo(walletCtx: any, j: Job, token: TokenInfo, amount: bigint, userAddr32: Uint8Array) {
  const issuer = await joinIssuer(walletCtx, token);
  jlog(j, `mint ${amount} ${token.name} (${token.decimals}d) → ${toHex(userAddr32).slice(0, 12)}…`);
  const tx: any = await (issuer.handle.callTx as any).mint(
    unshieldedUserRecipient(toHex(userAddr32)), amount,
  );
  jlog(j, `minted ${token.name} — tx=${tx.public?.txId ?? "?"}`);
  return tx;
}

// ── walletless ledger reads (straight from the indexer) ──────────────────────

const publicData = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
let accountLedgerFn: ((data: unknown) => any) | null = null;

async function accountLedger(address: string): Promise<any> {
  if (!accountLedgerFn) {
    const Mod: any = await import("../passport/src/wallet/contract.js");
    accountLedgerFn = Mod.ledger;
  }
  const state = await (publicData as any).queryContractState(address);
  if (!state) throw new Error(`no contract state at ${address} — was it deployed on THIS chain?`);
  return accountLedgerFn!(state.data);
}

/** The console's registry (Q40): its own records, enriched with a ledger read each. */
async function listAccounts(owner?: string) {
  const store = readStore();
  const records = owner ? findByOwner(store, owner) : store.accounts;
  if (!tokens.list.length) await resolveTokens();
  const out: Array<Record<string, unknown>> = [];
  for (const rec of records) {
    let ledgerView: Record<string, unknown> = { error: null };
    try {
      const l = await accountLedger(rec.address);
      const unshielded: Record<string, string> = {};
      for (const t of ofFamily("unshielded")) {
        const col = hexToBytes(t.color);
        unshielded[t.name] = String(l.unshielded_balances.member(col) ? l.unshielded_balances.lookup(col) : 0n);
      }
      ledgerView = {
        booted: Boolean(l.booted),
        authNonce: String(l.auth_nonce),
        round: String(l.round),
        inboxCount: String(l.inbox_count),
        deviceEpoch: String(l.device_epoch),
        encKey: toHex(Uint8Array.from(l.enc_key)),
        unshielded,
        error: null,
      };
    } catch (e) {
      ledgerView = { error: e instanceof Error ? e.message : String(e) };
    }
    // The SHIELDED holdings are private state: they are in this console's coin store, not
    // on the ledger. That asymmetry is the custody model, not a gap in the view.
    const shielded: Record<string, string> = {};
    for (const [colour, coin] of Object.entries(rec.coins)) {
      const t = tokens.list.find((x) => x.color === colour);
      shielded[t?.name ?? `0x${colour.slice(0, 12)}…`] = coin.value;
    }
    // `balances` is the two halves merged, for a caller that just wants a number per token
    // name. Keeping `unshielded` and `shielded` separate beside it is deliberate: they come
    // from different places — public ledger state and this console's private coin store —
    // and a view that hides that hides the custody model.
    const balances: Record<string, string> = {
      ...((ledgerView as any).unshielded ?? {}),
      ...shielded,
    };
    out.push({
      accountId: rec.address,
      address: rec.address,
      owner: `0x${rec.owner}`,
      registeredAt: rec.registeredAt,
      liveOffer: rec.liveOffer ?? null,
      shielded,
      balances,
      nonce: (ledgerView as any).authNonce ?? null,
      ...ledgerView,
    });
  }
  return out;
}

// ── connecting to an account ─────────────────────────────────────────────────

/**
 * Connect a client to a registered account, restoring what the chain does not hold.
 *
 * The compiled contract MUST be the same circuit list the registration deployed:
 * `findDeployedContract` verifies every declared circuit's verifier key against the
 * deployed state, so one extra or one missing circuit is a `ContractTypeError` rather than
 * a subtle failure later. Both sides come from `consoleAccountCircuits()`.
 */
async function connectAccount(walletCtx: any, record: AccountRecord): Promise<CustodyAccount> {
  const providers = await providersFor(walletCtx, zkConfigPath);
  const account = await CustodyAccount.connect(
    providers,
    consoleCompiledAccount(),
    record.address,
    coinStoreOf(record),
  );
  account.importRoster(record.roster);
  return account;
}

/** Persist the coin store and roster after a call that may have changed either. */
async function persistAccount(account: CustodyAccount, record: AccountRecord): Promise<AccountRecord> {
  const store = await account.coinStore();
  const next: AccountRecord = {
    ...record,
    coins: store.coins,
    roster: account.exportRoster(),
  };
  writeRecord(next);
  return next;
}

/**
 * Capture a coin the account now holds: work out its `mt_index` so `held_coin` can serve it.
 *
 * A shielded coin is spendable only with the index of its commitment in the ledger's Merkle
 * tree, and nothing in the deposit's own result carries it. `candidateIndices` returns the
 * commitments the transaction produced — usually the account's coin AND the depositing
 * wallet's change — and there is no cheap way to tell them apart from outside, so the
 * remaining candidates are STORED. A wrong index fails at PROVING, before any transaction
 * exists, so the first spend can simply try the next one (see `spendWithCandidates`).
 */
async function captureCoin(
  record: AccountRecord,
  txId: string,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
  j: Job,
): Promise<AccountRecord> {
  const { candidates } = await candidateIndices(txId);
  if (candidates.length === 0) throw new Error(`no commitment was produced by ${txId} — nothing to capture`);
  const colour = toHex(coin.color);
  jlog(j, `capturing the coin: mt_index candidates ${candidates.map(String).join(", ")}`);
  const next: AccountRecord = {
    ...record,
    coins: {
      ...record.coins,
      [colour]: {
        nonceHex: toHex(coin.nonce),
        colorHex: colour,
        value: coin.value.toString(),
        mtIndex: candidates[0]!.toString(),
      },
    },
    mtCandidates: { ...(record.mtCandidates ?? {}), [colour]: candidates.map(String) },
  };
  writeRecord(next);
  return next;
}

/** Run a spend, advancing the coin's mt_index through the stored candidates on a proving
 *  failure. Nothing is submitted until a candidate proves, so a retry is free of on-chain
 *  effect — only of time. */
async function spendWithCandidates<T>(
  j: Job,
  record: AccountRecord,
  colour: string,
  walletCtx: any,
  run: (account: CustodyAccount, record: AccountRecord) => Promise<T>,
): Promise<{ result: T; record: AccountRecord }> {
  const all = record.mtCandidates?.[colour] ?? [record.coins[colour]?.mtIndex ?? "0"];
  let current = record;
  let lastError: unknown = null;
  for (let i = 0; i < all.length; i++) {
    const idx = all[i]!;
    if (current.coins[colour]) {
      current = { ...current, coins: { ...current.coins, [colour]: { ...current.coins[colour]!, mtIndex: idx } } };
    }
    const account = await connectAccount(walletCtx, current);
    try {
      const result = await run(account, current);
      // The index that proved is the right one; drop the alternatives.
      current = await persistAccount(account, {
        ...current,
        mtCandidates: { ...(current.mtCandidates ?? {}), [colour]: [idx] },
      });
      return { result, record: current };
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (i === all.length - 1) throw e;
      jlog(j, `mt_index ${idx} did not prove (${msg.slice(0, 120)}) — trying the next candidate`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ── relay / taker wallet status ──────────────────────────────────────────────

const relay = {
  address: null as string | null,
  userAddress: null as string | null,
  balance: "0", funded: false, checkedAt: null as string | null, error: null as string | null,
};
const taker = { ...relay };

async function checkWallet(which: "relay" | "taker") {
  const target = which === "relay" ? relay : taker;
  try {
    await session(`${which}-check`, async (walletCtx) => {
      const st: any = await Rx.firstValueFrom((walletCtx.wallet as any).state());
      target.address = String(walletCtx.unshieldedKeystore.getAddress());
      target.userAddress = toHex(userAddressBytes(walletCtx));
      target.balance = String(unshieldedTotal(st));
      target.funded = unshieldedTotal(st) > 0n;
      target.error = null;
    }, { requireFunds: false, seed: which === "relay" ? RELAY_SEED : TAKER_SEED });
  } catch (e) {
    target.error = e instanceof Error ? e.message : String(e);
  }
  target.checkedAt = new Date().toISOString();
  log(`${which} wallet: funded=${target.funded} balance=${target.balance}${target.error ? ` error=${target.error}` : ""}`);
}

/** A wallet's zswap public keys, from its seed. Read-only key derivation plus a short sync. */
async function walletZswapKeys(seed: string) {
  return await session("keys", async (walletCtx) => {
    const st: any = await Rx.firstValueFrom((walletCtx.wallet as any).state());
    return {
      coinPublicKey: String(st.shielded.coinPublicKey.toHexString()).replace(/^0x/, "").toLowerCase(),
      encryptionPublicKey: String(st.shielded.encryptionPublicKey.toHexString()).replace(/^0x/, "").toLowerCase(),
      coinPublicKeyRaw: st.shielded.coinPublicKey,
      encryptionPublicKeyRaw: st.shielded.encryptionPublicKey,
      coinPublicKeyBytes: coinPublicKeyBytes(st),
      userAddress: toHex(userAddressBytes(walletCtx)),
    };
  }, { requireFunds: false, seed });
}

// ── prepared actions (built here, signed in the browser) ─────────────────────
//
// TWO SHAPES OF SIGNATURE, and the difference matters to the page:
//
//   * ENROLMENT (register only) is an EIP-191 `personal_sign` over a fixed sentence. It
//     authorises NOTHING and names no operation; its only purpose is to reveal the public
//     point, which no EVM wallet exposes and which `activate_initial_device_with_evm`
//     carries as an argument (Q30). One per wallet, ever.
//   * AUTHORISATION is `eth_signTypedData_v4` over the operation's EIP-712 struct, whose
//     `challenge` field is the MIP-0013 challenge core — it binds the account, the
//     arguments, the witness coin and `auth_nonce`, so the approved call and the executed
//     call are provably the same one.
//
// The prepared record keeps the exact `ctx`, `request` and `useCounter` the typed data was
// built from, and the submit step re-derives the digest from those same values rather than
// from fresh chain reads. If anything had moved in between, the re-derived digest differs,
// the point recovered from the old signature is a different point, and the client refuses
// by address — a loud failure instead of a call the circuit would silently reject.

type Prepared = {
  kind: string;
  owner: string;              // 20-byte hex, no 0x
  createdAt: number;
  /** `personal_sign` message, for the enrolment shape. */
  message?: string;
  /** The typed data the wallet is asked to sign, for the authorisation shape. */
  typedData?: unknown;
  digest?: string;
  summary: Record<string, unknown>;
  /** Everything the submit step needs, kept verbatim. */
  exec?: {
    address: string;
    ctx: CallContext;
    useCounter: bigint;
    request?: AuthRequest;
    offer?: { call: OfferCallArgs; coin: any; giveToken: string; wantToken: string };
    /** Everything the bridge start jobs need that the AuthRequest does not carry. */
    bridge?: {
      token: BridgedToken;
      amountRaw: bigint;
      depositAddress?: string;
      destEvmAddress?: string;
      evmNonce: bigint;
    };
  };
};
const prepared = new Map<string, Prepared>();
const PREP_TTL_MS = 30 * 60_000;
const newId = (): string => crypto.randomUUID();
function pruneOld() {
  const now = Date.now();
  for (const [k, v] of prepared) if (now - v.createdAt > PREP_TTL_MS) prepared.delete(k);
}

const ownerOf = (body: any): string => {
  const owner = String(body.owner ?? "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(owner)) throw new Error("owner must be a 0x…20-byte EVM address");
  return owner;
};

/**
 * A device object good enough for a ledger READ.
 *
 * `resolveUseCounter` derives the device's rolling entry from its ADDRESS, its epoch and a
 * candidate counter — it never needs a key or a point. So the prepare step, which has only
 * the 20 bytes the page sent, can still find where the device sits.
 */
function deviceForRead(owner: string): EvmDevice {
  return EvmDevice.fromBackend({
    address: hexToBytes(owner),
    async signTypedData() { throw new Error("read-only device"); },
  } as any);
}

/** A device that signs with a signature somebody else already produced. */
function deferredDevice(owner: string, signature: Uint8Array, point?: { x: bigint; y: bigint }): EvmDevice {
  return EvmDevice.fromBackend({
    address: hexToBytes(owner),
    async signTypedData() { return signature; },
    ...(point ? { publicPoint: () => ({ x: point.x, y: point.y, identity: false as const }) } : {}),
  } as any);
}

async function buildAction(body: any): Promise<Prepared> {
  const kind = String(body.kind ?? "");
  const owner = ownerOf(body);

  if (kind === "register") {
    // Nothing on chain yet, and nothing to bind: this is the Q30 enrolment signature.
    return {
      kind, owner, createdAt: Date.now(),
      message: EvmDevice.enrolmentMessage("a midnight-2-offers demo account"),
      summary: {
        what: "reveal this wallet's public key (EIP-191). It authorises nothing and moves no funds.",
        then: "the console deploys your account contract: two transactions, a few minutes.",
      },
    };
  }

  const address = String(body.accountId ?? body.address ?? "");
  if (!address) throw new Error("accountId (the account's contract address) is required");
  const record = requireRecord(address);
  if (record.owner !== owner) throw new Error(`account ${address.slice(0, 18)}… is owned by 0x${record.owner}`);

  // One ledger read serves the challenge, the typed data and the counter.
  const prep = await session("prepare", async (walletCtx) => {
    const account = await connectAccount(walletCtx, record);
    const ctx = await account.callContext();
    const useCounter = await account.resolveUseCounter(deviceForRead(owner));
    return { account, ctx, useCounter, walletCtx };
  }, { requireFunds: false });

  const { ctx, useCounter } = prep;
  const salt = ctx.evmDomainSalt!;
  const amount = body.amount === undefined ? 0n : BigInt(body.amount);

  const finish = (request: AuthRequest, summary: Record<string, unknown>): Prepared => {
    const challenge = evmChallengeFor(ctx, hexToBytes(owner), request);
    const { op, message } = evmTypedMessage(ctx, hexToBytes(owner), request, challenge);
    const typedData = buildTypedData(ctx.contractAddress, salt, op, message);
    const { digest } = computeDigest(ctx.contractAddress, salt, op, message);
    return {
      kind, owner, createdAt: Date.now(), typedData, digest: toHex(digest),
      summary: { ...summary, authNonce: String(ctx.authNonce), useCounter: String(useCounter) },
      exec: { address, ctx, useCounter, request },
    };
  };

  if (kind === "withdraw") {
    const token = tokenByName(String(body.token ?? defaultTokenName("unshielded")));
    if (token.family !== "unshielded") {
      throw new Error(`withdraw pays the UNSHIELDED balance — pick one of ${ofFamily("unshielded").map((t) => t.name).join(", ")}`);
    }
    if (amount <= 0n) throw new Error("amount must be a positive integer");
    let recipient32: string;
    const r = String(body.recipient ?? "").trim();
    if (r === "") {
      if (!relay.userAddress) throw new Error("relay wallet not checked yet — no default recipient");
      recipient32 = relay.userAddress;
    } else if (/^0x?[0-9a-f]{64}$/i.test(r)) {
      recipient32 = r.replace(/^0x/, "").toLowerCase();
    } else {
      recipient32 = toHex(Uint8Array.prototype.slice.call(parseMidnightBech32m(r).data, 0, 32));
    }
    return finish(
      { op: "withdrawUnshielded", color: hexToBytes(token.color), amount, recipient: hexToBytes(recipient32) },
      { token: token.name, amount: String(amount), recipient: recipient32 },
    );
  }

  if (kind === "withdraw-shielded") {
    const token = tokenByName(String(body.token ?? defaultTokenName("shielded")));
    if (token.family !== "shielded") throw new Error("withdraw-shielded pays a SHIELDED coin — pick a shielded token");
    if (amount <= 0n) throw new Error("amount must be a positive integer");
    const held = record.coins[token.color];
    if (!held) throw new Error(`the account holds no ${token.name} coin — fund it first`);
    if (BigInt(held.value) < amount) {
      throw new Error(`the account's ${token.name} coin is ${held.value}; stateless custody has no in-circuit merge, so at most that can be spent in one call`);
    }
    const to = String(body.to ?? "").trim();
    const target = String(body.target ?? "taker");
    let coinPk: string;
    let label: string;
    if (to) {
      if (!to.startsWith("mn_shield-addr")) throw new Error("recipient must be a mn_shield-addr… address for a shielded withdraw");
      const dec: any = parseMidnightBech32m(to).decode(ShieldedAddress as any, CONFIG.networkId as any);
      coinPk = String(dec.coinPublicKeyString()).replace(/^0x/, "").toLowerCase();
      label = `${to.slice(0, 26)}…`;
    } else {
      if (!["taker", "relay", "funder"].includes(target)) {
        throw new Error("target must be taker|relay|funder — or pass `to` with a mn_shield-addr… address");
      }
      const seed = target === "taker" ? TAKER_SEED : target === "funder" ? FUNDER_SEED : RELAY_SEED;
      coinPk = (await walletZswapKeys(seed)).coinPublicKey;
      label = target;
    }
    const coin = {
      nonce: hexToBytes(held.nonceHex), color: hexToBytes(held.colorHex),
      value: BigInt(held.value), mt_index: BigInt(held.mtIndex),
    };
    return finish(
      { op: "withdrawShielded", recipient: hexToBytes(coinPk), color: hexToBytes(token.color), amount, coin },
      { token: token.name, amount: String(amount), target: label, recipientCoinPk: coinPk },
    );
  }

  if (kind === "send-to-account") {
    // Q41: AA-v3's internal transfers moved value between two ROWS of one contract's balance
    // map. Two Passport accounts are two contracts, and an account never calls another
    // account, so the same move is a withdraw and a deposit — ONE HOP through a wallet the
    // console already runs. The owner signs only the first half; the second is
    // permissionless, which is why it needs no second signature.
    const token = tokenByName(String(body.token ?? defaultTokenName("shielded")));
    if (token.family !== "shielded") {
      throw new Error(
        "an account-to-account send moves a SHIELDED coin. The unshielded half is a plain " +
        "withdraw to the other owner's wallet address followed by their own deposit, because " +
        "unshielded value is a public balance and needs no inbox entry",
      );
    }
    if (amount <= 0n) throw new Error("amount must be a positive integer");
    const to = String(body.toAccountId ?? body.to ?? "");
    const target = findByAddress(readStore(), to);
    if (!target) throw new Error(`this console has no record of the recipient account ${to.slice(0, 18)}…`);
    if (target.address === address) throw new Error("the sender and the recipient are the same account");
    const held = record.coins[token.color];
    if (!held) throw new Error(`the account holds no ${token.name} coin — fund it first`);
    if (BigInt(held.value) < amount) {
      throw new Error(`the account's ${token.name} coin is ${held.value}; one call spends one coin`);
    }
    // The hop wallet is the FUNDER, which is also the wallet that will pay for the deposit.
    // Because it is both the recipient of the withdraw and the balancer of that transaction,
    // midnight-js attaches the coin's ciphertext for it automatically — no third-party
    // encryption-key mapping is needed (Q42 is about the case where they differ).
    const hop = await walletZswapKeys(FUNDER_SEED);
    const coin = {
      nonce: hexToBytes(held.nonceHex), color: hexToBytes(held.colorHex),
      value: BigInt(held.value), mt_index: BigInt(held.mtIndex),
    };
    const prepared = finish(
      { op: "withdrawShielded", recipient: hexToBytes(hop.coinPublicKey), color: hexToBytes(token.color), amount, coin },
      { token: token.name, amount: String(amount), toAccount: target.address, via: "funder wallet (one hop)" },
    );
    return { ...prepared, kind: "send-to-account", exec: { ...prepared.exec!, toAccount: target.address, token: token.name } as any };
  }

  // ── the bridge's two DEVICE-GATED starts ───────────────────────────────────
  //
  // Both spend GAS from an MPC-derived Ethereum account — the account's own deposit address
  // on the way in, the vault's on the way out — so the gas fields are part of what the
  // wallet signs (00034 PR-G). That is also why the EVM NONCE is read here, at prepare time,
  // and carried verbatim into the job: the MPC signs a transaction FROM that address, and a
  // stale nonce produces one the chain will not accept.

  if (kind === "bridge-deposit-start") {
    requireBridge();
    const token = await resolveToken(String(body.token ?? ""));
    const amountRaw = toRaw(String(body.amount ?? "0"), token.decimals);
    if (amountRaw <= 0n) throw new Error("amount must be positive");
    // Stateless custody keeps ONE coin per colour in this console's store and there is no
    // in-circuit merge, so a second bridged coin of the same colour would displace the first
    // (it would still be the account's, and still discoverable by an inbox walk — but not by
    // this console). Refused here rather than after the tokens have moved on Sepolia.
    if (record.coins[token.colour]) {
      throw new Error(
        `this account already holds a bridged ${token.symbol} coin of ` +
        `${fromRaw(record.coins[token.colour]!.value, token.decimals)}. Stateless custody has no ` +
        "in-circuit merge and this console keeps one coin per colour: spend, withdraw or offer it first",
      );
    }
    assertCapHeadroom(token.symbol, amountRaw, token.decimals, GAS_FUNDING_WEI);
    const cfg = bridgeConfigFor(token.erc20);
    const recipient: BridgeRecipient = { kind: "account", accountId: address };
    const depositAddress = depositAddressOf(cfg, recipient);
    const provider = evmProvider();
    let evmNonce: bigint;
    let held: { token: bigint; eth: bigint };
    try {
      const erc20 = new ethers.Contract(token.erc20, ERC20_ABI, provider);
      const [nonce, bal, eth] = await Promise.all([
        provider.getTransactionCount(depositAddress, "latest"),
        (erc20 as any).balanceOf(depositAddress) as Promise<bigint>,
        provider.getBalance(depositAddress),
      ]);
      evmNonce = BigInt(nonce);
      held = { token: BigInt(bal), eth: BigInt(eth) };
    } finally {
      provider.destroy();
    }
    // FR-004: refuse BEFORE any Midnight transaction, naming the exact shortfall. A start
    // whose deposit address is empty burns DUST and a device entry for a request whose
    // Ethereum leg can only ever return false.
    if (held.token < amountRaw) {
      throw new Error(
        `${depositAddress} holds ${fromRaw(held.token, token.decimals)} ${token.symbol}, and this ` +
        `deposit needs ${fromRaw(amountRaw, token.decimals)}. Send ` +
        `${fromRaw(amountRaw - held.token, token.decimals)} ${token.symbol} to that address first`,
      );
    }
    if (held.eth < GAS_BUDGET_WEI) {
      throw new Error(
        `${depositAddress} holds ${formatEth(held.eth)} ETH, and the MPC-signed transfer can cost up to ` +
        `${formatEth(GAS_BUDGET_WEI)} ETH. Send ${formatEth(GAS_FUNDING_WEI - held.eth)} ETH to that address first`,
      );
    }
    const preparedDeposit = finish(
      { op: "bridgeDepositStart", erc20: hexToBytes(token.erc20), amount: amountRaw, evm: { ...EVM_GAS, nonce: evmNonce } },
      {
        direction: "deposit", recipient: "my account", token: token.symbol,
        amount: `${fromRaw(amountRaw, token.decimals)} ${token.symbol}`,
        amountRaw: String(amountRaw), erc20: token.erc20, colour: token.colour,
        depositAddress, depositAddressHolds: `${fromRaw(held.token, token.decimals)} ${token.symbol} / ${formatEth(held.eth)} ETH`,
        evmNonce: String(evmNonce), gasBudgetEth: formatEth(GAS_BUDGET_WEI),
        attestation: ATTESTATION_NOTE,
      },
    );
    return {
      ...preparedDeposit,
      exec: { ...preparedDeposit.exec!, bridge: { token, amountRaw, depositAddress, evmNonce } },
    };
  }

  if (kind === "bridge-withdraw-start") {
    requireBridge();
    const token = await resolveToken(String(body.token ?? ""));
    const amountRaw = toRaw(String(body.amount ?? "0"), token.decimals);
    if (amountRaw <= 0n) throw new Error("amount must be positive");
    const held = record.coins[token.colour];
    if (!held) throw new Error(`this account holds no bridged ${token.symbol} coin`);
    if (BigInt(held.value) < amountRaw) {
      throw new Error(
        `the account's ${token.symbol} coin is ${fromRaw(held.value, token.decimals)}; stateless custody ` +
        "has no in-circuit merge, so at most that can be withdrawn in one call",
      );
    }
    const dest = String(body.dest ?? `0x${owner}`).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) throw new Error("dest must be a 0x…20-byte EVM address");
    // A withdrawal moves tokens OUT of the bridge, so it does not consume the token cap —
    // but its gas does leave the operator's wallet, so the ETH half is checked.
    assertCapHeadroom(token.symbol, 0n, token.decimals, GAS_FUNDING_WEI);
    const cfg = bridgeConfigFor(token.erc20);
    const vaultEvm = vaultEvmAddressFor(cfg);
    const provider = evmProvider();
    let evmNonce: bigint;
    let vaultEth: bigint;
    let vaultToken: bigint;
    try {
      const erc20 = new ethers.Contract(token.erc20, ERC20_ABI, provider);
      const [nonce, eth, bal] = await Promise.all([
        provider.getTransactionCount(vaultEvm, "latest"),
        provider.getBalance(vaultEvm),
        (erc20 as any).balanceOf(vaultEvm) as Promise<bigint>,
      ]);
      evmNonce = BigInt(nonce);
      vaultEth = BigInt(eth);
      vaultToken = BigInt(bal);
    } finally {
      provider.destroy();
    }
    // A withdrawal is paid out of the VAULT's own Ethereum account and its gas comes from
    // there too, so both have to be present before the coin is surrendered.
    if (vaultToken < amountRaw) {
      throw new Error(
        `the vault's Ethereum account ${vaultEvm} holds ${fromRaw(vaultToken, token.decimals)} ${token.symbol}, ` +
        `less than the ${fromRaw(amountRaw, token.decimals)} this withdrawal pays out`,
      );
    }
    if (vaultEth < GAS_BUDGET_WEI) {
      throw new Error(
        `the vault's Ethereum account ${vaultEvm} holds ${formatEth(vaultEth)} ETH and the MPC-signed ` +
        `transfer can cost up to ${formatEth(GAS_BUDGET_WEI)}. Send ${formatEth(GAS_FUNDING_WEI - vaultEth)} ETH there first`,
      );
    }
    const coin = {
      nonce: hexToBytes(held.nonceHex), color: hexToBytes(held.colorHex),
      value: BigInt(held.value), mt_index: BigInt(held.mtIndex),
    };
    const preparedWithdraw = finish(
      {
        op: "bridgeWithdrawStart",
        dest: hexToBytes(dest), color: hexToBytes(token.colour), amount: amountRaw,
        erc20: hexToBytes(token.erc20), coin, evm: { ...EVM_GAS, nonce: evmNonce },
      },
      {
        direction: "withdraw", token: token.symbol,
        amount: `${fromRaw(amountRaw, token.decimals)} ${token.symbol}`,
        amountRaw: String(amountRaw), erc20: token.erc20, colour: token.colour,
        dest, vaultEvmAddress: vaultEvm, evmNonce: String(evmNonce),
        gasBudgetEth: formatEth(GAS_BUDGET_WEI), attestation: ATTESTATION_NOTE,
      },
    );
    return {
      ...preparedWithdraw,
      exec: { ...preparedWithdraw.exec!, bridge: { token, amountRaw, destEvmAddress: dest, evmNonce } },
    };
  }

  if (kind === "swap") {
    const giveToken = tokenByName(String(body.giveToken ?? defaultTokenName("shielded", 0)));
    const wantToken = tokenByName(String(body.wantToken ?? defaultTokenName("shielded", 1)));
    if (giveToken.family !== "shielded" || wantToken.family !== "shielded") {
      throw new Error("open swaps are SHIELDED-only by contract design — pick shielded tokens for both legs");
    }
    if (giveToken.name === wantToken.name) {
      throw new Error("give and want must be different tokens (same-colour legs net out: NOT_A_SWAP)");
    }
    const giveAmount = amount;
    const wantAmount = BigInt(body.wantAmount ?? 0);
    if (giveAmount <= 0n || wantAmount <= 0n) throw new Error("give and want amounts must be positive integers");
    // Q7: the MIP-0013 seam consumes ONE device entry per call, so a second offer signed
    // while the first is unsettled makes the first unsettleable — its auth_nonce is stale.
    // The console serialises rather than letting a user strand an offer.
    if (record.liveOffer) {
      throw new Error(
        `this account already has a live offer (${record.liveOffer.offerId.slice(0, 16)}…, ` +
        `${record.liveOffer.give} for ${record.liveOffer.want}). One live offer per account (Q7): ` +
        "settle or cancel it first. The seam consumes one device entry per call, so signing a second " +
        "offer now would make the first one permanently unsettleable.",
      );
    }
    const held = record.coins[giveToken.color];
    if (!held) {
      throw new Error(
        `the swap's give leg spends a SHIELDED ${giveToken.name} coin this account holds, and it holds none — ` +
        `run "Fund shielded" with ${giveToken.name} first`,
      );
    }
    if (BigInt(held.value) < giveAmount) {
      throw new Error(
        `the account's ${giveToken.name} coin is ${held.value} and the give leg is ${giveAmount}. Stateless ` +
        "custody has no in-circuit merge: one offer spends exactly one coin",
      );
    }
    const coin = {
      nonce: hexToBytes(held.nonceHex), color: hexToBytes(held.colorHex),
      value: BigInt(held.value), mt_index: BigInt(held.mtIndex),
    };
    const want = { nonce: freshWantNonce(), color: hexToBytes(wantToken.color), value: wantAmount };
    const change = predictChangeCoin(coin as any, giveAmount);
    const { wantEntry, changeEntry } = offerInboxEntries(hexToBytes(record.encPublicKey), want, change);
    const call: OfferCallArgs = {
      giveColor: hexToBytes(giveToken.color),
      giveAmount,
      recipientKind: RECIPIENT_OPEN,
      recipient: new Uint8Array(32),
      want,
      wantEntry,
      changeEntry,
      validUntil: 0n,
    };
    const challenge = openSwapChallenge(ctx.contractAddress, hexToBytes(owner), ctx.authNonce, call, coin as any);
    const message = openSwapMessage(ctx.contractAddress, hexToBytes(owner), ctx.authNonce, call, challenge);
    const typedData = buildOpenSwapTypedData(salt, message);
    const { digest } = openSwapDigest(salt, message);
    return {
      kind, owner, createdAt: Date.now(), typedData, digest: toHex(digest),
      summary: {
        give: `${giveAmount} ${giveToken.name}`, want: `${wantAmount} ${wantToken.name}`,
        giveToken: giveToken.name, wantToken: wantToken.name,
        wantNonce: toHex(want.nonce), authNonce: String(ctx.authNonce), useCounter: String(useCounter),
      },
      exec: { address, ctx, useCounter, offer: { call, coin, giveToken: giveToken.name, wantToken: wantToken.name } },
    };
  }

  throw new Error(`unknown kind '${kind}' (register | withdraw | withdraw-shielded | swap)`);
}

// ── the job queue (single worker: one facade per transaction) ────────────────

type Job = {
  id: string; kind: string; state: "queued" | "running" | "done" | "error";
  log: string[]; txId: string | null; error: string | null;
  data?: unknown; createdAt: string; run: (j: Job) => Promise<void>;
};
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let working = false;

function enqueue(kind: string, run: (j: Job) => Promise<void>): Job {
  const job: Job = {
    id: newId(), kind, state: "queued", log: [], txId: null, error: null,
    createdAt: new Date().toISOString(), run,
  };
  jobs.set(job.id, job);
  queue.push(job);
  void work();
  return job;
}

const jlog = (j: Job, line: string) => {
  j.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  log(`job ${j.id.slice(0, 8)} ${line}`);
};

// The aa-proof-server gets OOM-killed under host memory pressure — an `evm` circuit is
// k=18 and its 570 MB proving key is uploaded per call — and the SDK surfaces the dropped
// socket as "'prove' returned an error: The socket connection was closed". Nothing has been
// submitted at that point, so ONE retry after the server's restart window is safe. Only
// this exact transient class retries.
const TRANSIENT_PROVE =
  /socket connection was closed|'prove' returned an error|ConnectionRefused|Failed to connect|fetch failed/i;
async function withProveRetry<T>(j: Job, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!TRANSIENT_PROVE.test(msg)) throw e;
    jlog(j, `${what}: transient proving failure — the proof server likely restarted (OOM class); retrying once in 20 s`);
    await new Promise((r) => setTimeout(r, 20_000));
    return await fn();
  }
}

async function work() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const job = queue.shift();
      if (!job) break;
      job.state = "running";
      try {
        await job.run(job);
        job.state = "done";
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
        job.state = "error";
        jlog(job, `FAILED: ${job.error}`);
      }
    }
  } finally {
    working = false;
  }
}

// ── register: DEPLOY an account ──────────────────────────────────────────────

function registerJob(prep: Prepared, signatureHex: string): Job {
  return enqueue("register", async (j) => {
    jlog(j, "recovering the wallet's public point from the enrolment signature");
    const sig = lowS(parseSignature(hexToBytes(signatureHex)));
    const point = recoverPoint(eip191Digest(prep.message!), sig);
    const derived = toHex(ethereumAddress(point));
    if (derived !== prep.owner) throw new Error(`the enrolment signature belongs to 0x${derived}, not 0x${prep.owner}`);
    jlog(j, `point recovered and checked against 0x${prep.owner}`);

    const device = EvmDevice.fromPublicPoint(hexToBytes(prep.owner), point);
    const encKeys = generateEncKeyPair();
    const waves = consoleWaves();
    jlog(j, `deploying: wave 1 = ${waves.waveOne.length} operations, wave 2 = ${waves.waveTwo.length} ` +
      `(the offer circuit and the authority retirement ride wave 2)`);
    jlog(j, `vault ${VAULT_ADDRESS ? `${VAULT_ADDRESS.slice(0, 18)}…` : "(none)"} — sealed into the constructor (FR-022)`);

    const t0 = Date.now();
    const account = await withProveRetry(j, "register", () => session("register", async (walletCtx) => {
      const providers = await providersFor(walletCtx, zkConfigPath);
      return await deployEvmAccount({
        providers,
        device,
        encKeys,
        compiledContract: consoleCompiledAccount(),
        waveOneCircuits: waves.waveOne,
        waveTwoCircuits: waves.waveTwo,
        armsInWaveTwo: [],
        retireAuthority: true,
        ...(VAULT_ADDRESS ? { vaultAddress: hexToBytes(VAULT_ADDRESS) } : {}),
      } as any);
    }));
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    jlog(j, `account deployed and activated in ${secs}s — ${account.address}`);

    const record: AccountRecord = {
      address: account.address,
      owner: prep.owner,
      encPublicKey: toHex(encKeys.publicKey),
      encSecretKey: toHex(encKeys.secretKey),
      roster: account.exportRoster(),
      coins: {},
      liveOffer: null,
      registeredAt: new Date().toISOString(),
      meta: { network: CONFIG.networkId, vault: VAULT_ADDRESS ?? "", deploySeconds: secs },
    };
    writeRecord(record);
    j.txId = account.address;
    j.data = { address: account.address, owner: `0x${prep.owner}`, circuits: consoleAccountCircuits().length };
    jlog(j, `registered — the account id IS the contract address (Q40): ${account.address}`);
  });
}

// ── gated calls ──────────────────────────────────────────────────────────────

function gatedJob(prep: Prepared, signatureHex: string): Job {
  return enqueue(prep.kind, async (j) => {
    const exec = prep.exec!;
    const record = requireRecord(exec.address);
    const sig = hexToBytes(signatureHex);
    const device = deferredDevice(prep.owner, sig);
    jlog(j, `re-deriving the ${prep.kind} authorisation from the prepared context (authNonce ${exec.ctx.authNonce})`);
    const auth = await authorise(device, exec.ctx, exec.request!, exec.useCounter);
    jlog(j, `signature verified: the point recovered from it hashes to 0x${prep.owner}`);

    // The two bridge starts run their own transport: each is followed by an off-chain MPC
    // round trip and a settle, which cannot live inside one wallet session (ONE FACADE PER
    // TRANSACTION, master plan T7.5).
    if (exec.request!.op === "bridgeDepositStart") return await runBridgeDepositStart(j, prep, auth);
    if (exec.request!.op === "bridgeWithdrawStart") return await runBridgeWithdrawStart(j, prep, auth);

    await withProveRetry(j, prep.kind, () => session(prep.kind, async (walletCtx) => {
      const t0 = Date.now();
      if (exec.request!.op === "withdrawUnshielded") {
        const account = await connectAccount(walletCtx, record);
        const req = exec.request as Extract<AuthRequest, { op: "withdrawUnshielded" }>;
        jlog(j, `proving withdraw_unshielded_with_evm (k=18) …`);
        const r = await account.withdrawUnshieldedWithAuth(req.color, req.amount, req.recipient, auth as any);
        j.txId = r.txId;
        await persistAccount(account, record);
        jlog(j, `landed — tx=${r.txId} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        return;
      }
      // withdrawShielded: the spend consumes the held coin and returns the change, which
      // has to go back into the coin store or the remainder is lost to the client.
      const req = exec.request as Extract<AuthRequest, { op: "withdrawShielded" }>;
      const colour = toHex(req.color);
      const { result, record: after } = await spendWithCandidates(j, record, colour, walletCtx,
        async (account) => {
          jlog(j, "proving withdraw_shielded_with_evm (k=18) …");
          return await account.withdrawShieldedWithAuth(req.recipient, req.color, req.amount, auth as any);
        });
      j.txId = (result as any).txId;
      jlog(j, `landed — tx=${j.txId} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      const change = (result as any).change;
      let next = { ...after, coins: { ...after.coins } };
      delete next.coins[colour];
      writeRecord(next);
      if (change) {
        jlog(j, `the spend returned ${change.value} of change — capturing it`);
        next = await captureCoin(next, j.txId!, change, j);
        // THE CHANGE COIN HAS NO INBOX ENTRY, and that is a stated limitation rather than an
        // oversight. `withdraw_shielded` RETURNS the change to the caller; filing its
        // description on chain is `append_inbox_with_evm`, a second DEVICE-GATED call and
        // therefore a second wallet signature. This console keeps the coin in its own store,
        // so it can spend it — but a client rebuilding this account from chain data alone
        // would not see it (MIP-0012 S3). The Append-inbox action is how an owner files it.
        jlog(j, "note: the change coin is in this console's store but has NO inbox entry — filing one "
          + "is a second gated call (append_inbox_with_evm) and needs a second signature");
      }
      // Q41's second half: an account-to-account send is this withdraw plus a PERMISSIONLESS
      // deposit into the recipient, which needs no signature from anybody.
      const toAccount = (exec as any).toAccount as string | undefined;
      if (toAccount) {
        const recipient = requireRecord(toAccount);
        jlog(j, `one hop: depositing ${req.amount} into ${toAccount.slice(0, 18)}… from the funder wallet`);
        await session("send-to-account-deposit", async (hopCtx) => {
          const hopAccount = await connectAccount(hopCtx, recipient);
          const hopCoin = { nonce: randomBytes32(), color: req.color, value: req.amount };
          const { txId } = await depositAsThirdParty(hopAccount as any, hopCoin, {
            encKey: hexToBytes(recipient.encPublicKey),
          });
          jlog(j, `deposited into the recipient — tx=${txId}`);
          await captureCoin(recipient, txId, hopCoin, j);
          j.data = { ...(j.data as any ?? {}), hopTxId: txId, toAccount };
        }, { seed: FUNDER_SEED });
      }
    }));
  });
}

// ── the open-swap offer ──────────────────────────────────────────────────────

function offerJob(prep: Prepared, signatureHex: string): Job {
  return enqueue("swap-build", async (j) => {
    const exec = prep.exec!;
    const record = requireRecord(exec.address);
    const offerSpec = exec.offer!;
    const device = deferredDevice(prep.owner, hexToBytes(signatureHex));
    jlog(j, "re-deriving the OpenSwapShielded authorisation from the prepared context");
    const auth = await signOpenSwapOffer(device, exec.ctx, offerSpec.call, offerSpec.coin, exec.useCounter);
    jlog(j, `signature verified: the point recovered from it hashes to 0x${prep.owner}`);

    const built = await withProveRetry(j, "swap-offer", () => session("swap-offer", async (walletCtx) => {
      const account = await connectAccount(walletCtx, record);
      return await buildKernelOffer({
        providers: (account as any).providers,
        compiledContract: consoleCompiledAccount(),
        accountAddress: record.address,
        privateStateId: (account as any).privateStateId,
        circuitId: SWAP_CIRCUIT,
        call: offerSpec.call,
        authArgs: offerAuthArgs(auth),
      }, (line) => jlog(j, line));
      // The maker contributes no coins and pays no fees — hence requireFunds: false.
    }, { requireFunds: false }));

    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync("/aa/out/offers", { recursive: true });
      writeFileSync(`/aa/out/offers/${built.sha256}.swapoffer`, `${built.blob}\n`);
      writeFileSync(`/aa/out/offers/${built.sha256}.terms.json`, `${JSON.stringify(built.terms, null, 2)}\n`);
      jlog(j, `blob saved: /aa/out/offers/${built.sha256}.swapoffer`);
    } catch (e) {
      jlog(j, `blob save failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
    }

    // Q7: one live offer per account, recorded the moment the artefact exists. The device
    // entry this offer consumed is spent when (and only when) the taker submits, but a
    // SECOND signature from this account would make this one unsettleable either way.
    const change = predictChangeCoin(offerSpec.coin, offerSpec.call.giveAmount);
    writeRecord({
      ...record,
      liveOffer: {
        offerId: built.sha256,
        give: `${offerSpec.call.giveAmount} ${offerSpec.giveToken}`,
        want: `${offerSpec.call.want.value} ${offerSpec.wantToken}`,
        createdAt: new Date().toISOString(),
        giveColour: toHex(offerSpec.call.giveColor),
        giveAmount: String(offerSpec.call.giveAmount),
        wantColour: toHex(offerSpec.call.want.color),
        wantAmount: String(offerSpec.call.want.value),
        wantNonceHex: toHex(offerSpec.call.want.nonce),
        changeValue: change ? String(change.value) : null,
        changeNonceHex: change ? toHex(change.nonce) : null,
      },
    });

    j.txId = built.sha256;
    j.data = {
      blob: built.blob, sha256: built.sha256, bytes: built.bytes,
      legSegment: built.legSegment, terms: built.terms,
    };
    jlog(j, `offer BUILT — ${built.bytes} bytes, offerId ${built.sha256.slice(0, 16)}…; use Publish to send it to the kernel`);
  });
}

// ── funding ──────────────────────────────────────────────────────────────────

/** Unshielded: mint to the funder's own user address, then `deposit_unshielded`. The
 *  depositor pays the fee and the circuit is PERMISSIONLESS — no device, no signature. */
function fundJob(address: string, amount: bigint, tokenNameArg?: string): Job {
  return enqueue("fund", async (j) => {
    const record = requireRecord(address);
    const token = tokenByName(tokenNameArg ?? defaultTokenName("unshielded"));
    if (token.family !== "unshielded") throw new Error(`fund deposits the UNSHIELDED balance — '${token.name}' is shielded (use Fund shielded)`);
    await withProveRetry(j, "fund-mint", () => session("fund-mint", async (walletCtx) => {
      await mintUnshieldedTo(walletCtx, j, token, amount, userAddressBytes(walletCtx));
    }, { seed: FUNDER_SEED }));
    await withProveRetry(j, "fund-deposit", () => session("fund-deposit", async (walletCtx) => {
      const account = await connectAccount(walletCtx, record);
      jlog(j, `deposit_unshielded(${amount} ${token.name}) → ${address.slice(0, 18)}…`);
      const r = await account.depositUnshielded(hexToBytes(token.color), amount);
      j.txId = r.txId;
      jlog(j, `deposited — tx=${r.txId}`);
    }, { seed: FUNDER_SEED }));
  });
}

/**
 * Shielded: mint a coin to the funder wallet, then `deposit_shielded(coin, entry)`.
 *
 * TWO THINGS THAT WERE NOT THERE BEFORE. The entry is a 192-byte ciphertext sealed to the
 * account's own `enc_key` — the Manager had a public balance map, and Passport has an
 * encrypted inbox, so without the entry the coin is invisible to anyone rebuilding the
 * store from chain data. And the coin's `mt_index` has to be CAPTURED afterwards, because
 * `held_coin` cannot serve a coin whose Merkle position the client does not know.
 */
function fundShieldedJob(address: string, amount: bigint, tokenNameArg?: string): Job {
  return enqueue("fund-shielded", async (j) => {
    let record = requireRecord(address);
    const token = tokenByName(tokenNameArg ?? defaultTokenName("shielded"));
    if (token.family !== "shielded") throw new Error(`'${token.name}' is not a shielded token`);
    if (record.coins[token.color]) {
      // Stateless custody holds ONE coin per colour in this client's store, and there is no
      // in-circuit merge: a second deposit of the same colour would overwrite the first in
      // the store and strand it (it is still the account's, and still discoverable by an
      // inbox walk — but not by this console). Refuse rather than lose track.
      throw new Error(
        `this account already holds a ${token.name} coin of ${record.coins[token.color]!.value}. Stateless ` +
        "custody has no in-circuit merge and this console keeps one coin per colour: spend or withdraw it first",
      );
    }
    await withProveRetry(j, "fund-shielded-mint", () => session("fund-shielded-mint", async (walletCtx) => {
      await mintShieldedTo(walletCtx, j, token, amount);
    }, { seed: FUNDER_SEED }));
    await withProveRetry(j, "fund-shielded-deposit", () => session("fund-shielded-deposit", async (walletCtx) => {
      const account = await connectAccount(walletCtx, record);
      const coin = { nonce: randomBytes32(), color: hexToBytes(token.color), value: amount };
      jlog(j, `deposit_shielded(${amount} ${token.name}) + a 192-byte inbox entry sealed to the account's enc_key`);
      const { txId } = await depositAsThirdParty(account as any, coin, { encKey: hexToBytes(record.encPublicKey) });
      j.txId = txId;
      jlog(j, `deposited — tx=${txId}`);
      record = await captureCoin(record, txId, coin, j);
    }, { seed: FUNDER_SEED }));
    // Prove the entry really is discoverable from chain data alone — the one check that
    // catches a depositor who sealed a lie (S3), and the same walk a restored console does.
    await session("fund-shielded-verify", async (walletCtx) => {
      const account = await connectAccount(walletCtx, record);
      const found = await inboxWalkPortable(await account.ledgerState(), hexToBytes(record.encSecretKey));
      const mine = found.filter((c) => toHex(c.color) === token.color);
      jlog(j, `inbox walk: ${found.length} entr${found.length === 1 ? "y" : "ies"} readable, ${mine.length} of ${token.name}`);
      if (mine.length === 0) throw new Error("the deposit's inbox entry did not decrypt — the coin would be undiscoverable");
    }, { requireFunds: false, seed: FUNDER_SEED });
  });
}

/** Mint straight to a WALLET (no account deposit): the taker side of the demo. */
function faucetJob(tokenNameArg: string | undefined, amount: bigint, target: "relay" | "taker" | "funder"): Job {
  return enqueue("faucet", async (j) => {
    const token = tokenByName(tokenNameArg ?? defaultTokenName("shielded", 1));
    const seed = target === "taker" ? TAKER_SEED : target === "funder" ? FUNDER_SEED : RELAY_SEED;
    await withProveRetry(j, "faucet", () => session(`faucet-${target}`, async (walletCtx) => {
      const tx = token.family === "shielded"
        ? await mintShieldedTo(walletCtx, j, token, amount)
        : await mintUnshieldedTo(walletCtx, j, token, amount, userAddressBytes(walletCtx));
      j.txId = (tx as any).public?.txId ?? null;
      jlog(j, `faucet done: ${amount} ${token.name} → the ${target} wallet`);
    }, { seed }));
  });
}

/** Send tokens to ANY standard Midnight address: the funder mints to itself, then does a
 *  plain wallet transfer. Unchanged by 00034 — no account is involved. */
function sendJob(tokenNameArg: string | undefined, amount: bigint, to: string): Job {
  return enqueue("send", async (j) => {
    const token = tokenByName(tokenNameArg ?? defaultTokenName("shielded"));
    const netId = CONFIG.networkId as any;
    let receiver: any;
    if (token.family === "shielded") {
      if (!to.startsWith("mn_shield-addr")) throw new Error(`${token.name} is SHIELDED — the recipient must be a mn_shield-addr… address`);
      receiver = parseMidnightBech32m(to).decode(ShieldedAddress as any, netId);
    } else {
      if (!to.startsWith("mn_addr")) throw new Error(`${token.name} is UNSHIELDED — the recipient must be a mn_addr… address`);
      receiver = parseMidnightBech32m(to).decode(UnshieldedAddress as any, netId);
    }
    await withProveRetry(j, "send", () => session("send", async (walletCtx) => {
      if (token.family === "shielded") await mintShieldedTo(walletCtx, j, token, amount);
      else await mintUnshieldedTo(walletCtx, j, token, amount, userAddressBytes(walletCtx));
      const wallet = walletCtx.wallet as any;
      const keys = { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey };
      jlog(j, `transferring ${amount} ${token.name} → ${to.slice(0, 30)}…`);
      let recipe: any = null;
      let lastErr: unknown = null;
      for (let i = 0; i < 10 && !recipe; i++) {
        if (i) await new Promise((r) => setTimeout(r, 6000));
        try {
          recipe = await wallet.transferTransaction(
            [{ type: token.family, outputs: [{ type: token.color, receiverAddress: receiver, amount }] }],
            keys, { ttl: new Date(Date.now() + Number(process.env["TX_TTL_MS"] ?? "60000")) },
          );
          lastErr = null;
        } catch (e) {
          lastErr = e;
          jlog(j, `transfer not ready (${e instanceof Error ? e.message : e}) — waiting for the mint to index…`);
        }
      }
      if (!recipe) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      const tx = await wallet.finalizeRecipe(recipe);
      await wallet.submitTransaction(tx);
      j.txId = tx.transactionHash?.().toString?.() ?? null;
      jlog(j, `sent — tx=${j.txId ?? "?"}`);
    }, { seed: FUNDER_SEED }));
  });
}

/** A wallet actor deposits tokens IT HOLDS into an account — the onward-spend half of the
 *  withdraw paths, and the second leg of an account-to-account send (Q41). */
function depositFromWalletJob(address: string, amount: bigint, from: "taker" | "relay" | "funder", tokenName?: string): Job {
  return enqueue(`deposit-from-${from}`, async (j) => {
    let record = requireRecord(address);
    const token = tokenByName(tokenName ?? defaultTokenName("unshielded"));
    const seed = from === "taker" ? TAKER_SEED : from === "funder" ? FUNDER_SEED : RELAY_SEED;
    await withProveRetry(j, "deposit", () => session(`deposit-${from}`, async (walletCtx) => {
      const account = await connectAccount(walletCtx, record);
      if (token.family === "shielded") {
        const coin = { nonce: randomBytes32(), color: hexToBytes(token.color), value: amount };
        jlog(j, `deposit_shielded(${amount} ${token.name}) from the ${from} wallet → ${address.slice(0, 18)}…`);
        const { txId } = await depositAsThirdParty(account as any, coin, { encKey: hexToBytes(record.encPublicKey) });
        j.txId = txId;
        record = await captureCoin(record, txId, coin, j);
      } else {
        jlog(j, `deposit_unshielded(${amount} ${token.name}) from the ${from} wallet → ${address.slice(0, 18)}…`);
        const r = await account.depositUnshielded(hexToBytes(token.color), amount);
        j.txId = r.txId;
      }
      jlog(j, `deposited — tx=${j.txId ?? "?"}`);
    }, { seed }));
  });
}

/** Settle a live book offer with the TAKER wallet: fetch the blob, balance, finalize,
 *  submit. Unchanged by 00034 — the taker is a wallet with no maker keys, which is the
 *  whole point of the artefact. */
function takeJob(offerId: string): Job {
  return enqueue("take", async (j) => {
    jlog(j, `fetching offer ${offerId.slice(0, 16)}… from the kernel`);
    const res = await fetch(`${KERNEL_URL}/v1/offers/${offerId}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`kernel: ${res.status} fetching the offer`);
    const detail: any = await res.json();
    const blob = String(detail.offerBech32 ?? "");
    if (!blob.startsWith("swapoffer1")) throw new Error("offer blob missing from the kernel response");
    await session("take", async (walletCtx) => {
      const wallet = walletCtx.wallet as any;
      const keys = { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey };
      const offerTx = (Transaction as any).deserialize("signature", "proof", "binding", OfferFiles.decode(blob));
      jlog(j, "balancing the settlement (taker funds the want leg, sweeps the give surplus)…");
      const t0 = Date.now();
      const recipe = await wallet.balanceFinalizedTransaction(offerTx, keys, {
        ttl: new Date(Date.now() + Number(process.env["TX_TTL_MS"] ?? "60000")),
      });
      const settleTx = await wallet.finalizeRecipe(recipe);
      await wallet.submitTransaction(settleTx);
      j.txId = settleTx.transactionHash?.().toString?.() ?? null;
      jlog(j, `settlement submitted in ${((Date.now() - t0) / 1000).toFixed(0)}s — tx=${j.txId ?? "?"}`);
    }, { seed: TAKER_SEED });
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const s: any = await (await fetch(`${KERNEL_URL}/v1/offers/${offerId}/status`)).json();
        if (s.status === "consumed") {
          jlog(j, "book status: CONSUMED — settlement confirmed");
          await reconcileSettledOffer(offerId, j.txId, j);
          return;
        }
        if (["cancelled", "expired", "unknown", "not_found"].includes(s.status)) {
          throw new Error(`offer ended with status ${s.status}`);
        }
      } catch (e) {
        if (e instanceof Error && /ended with status/.test(e.message)) throw e;
      }
    }
    jlog(j, "submitted, but the book has not flipped to consumed yet — check the offer status");
  });
}

/**
 * A settled offer changes the maker's custody, and NOTHING tells the maker so.
 *
 * The give coin is nullified by a transaction the maker did not submit; the want coin and
 * the change are created by it, and their Merkle positions live only in it. If the console
 * simply forgot the offer, its store would keep a coin that no longer exists — and the
 * account's NEXT call would fail inside proving with a message about a merkle path, minutes
 * later, pointing at nothing. So: drop the spent coin, and capture what came back.
 *
 * `settleTxId` is present when THIS console's taker settled. When the solver did, there is
 * no transaction id here, so the spent coin is still dropped (that part is certain) and the
 * received coins are left for a rescan, which is stated in the log rather than papered over.
 */
async function reconcileSettledOffer(offerId: string, settleTxId: string | null, j?: Job): Promise<void> {
  const store = readStore();
  const rec = store.accounts.find((a) => a.liveOffer?.offerId === offerId);
  if (!rec?.liveOffer) return;
  const offer = rec.liveOffer;
  const say = (line: string) => (j ? jlog(j, line) : log(line));

  const coins = { ...rec.coins };
  const mtCandidates = { ...(rec.mtCandidates ?? {}) };
  delete coins[offer.giveColour];
  delete mtCandidates[offer.giveColour];
  say(`settled: the ${offer.give} coin is nullified — dropped from the store`);

  if (settleTxId) {
    const { candidates } = await candidateIndices(settleTxId);
    const list = candidates.map(String);
    say(`the settlement produced commitments ${list.join(", ")} — the want coin and the change are among them`);
    coins[offer.wantColour] = {
      nonceHex: offer.wantNonceHex, colorHex: offer.wantColour,
      value: offer.wantAmount, mtIndex: list[0]!,
    };
    mtCandidates[offer.wantColour] = list;
    if (offer.changeValue && offer.changeNonceHex) {
      // The change coin's nonce was PREDICTED before the offer was proved (the circuit's own
      // `swap_change_nonce` rule over the GIVE coin's nonce) and stored then, because by now
      // the give coin is gone from the store and the rule's input with it.
      coins[offer.giveColour] = {
        nonceHex: offer.changeNonceHex, colorHex: offer.giveColour,
        value: offer.changeValue, mtIndex: list[0]!,
      };
      mtCandidates[offer.giveColour] = list;
      say(`the change (${offer.changeValue} of the give colour) is back in the store`);
    }
  } else {
    say("the solver settled it, so this console has no transaction id: the received coins need a "
      + "rescan (the account still owns them, and the inbox entries are on chain)");
  }
  writeRecord({ ...rec, coins, mtCandidates, liveOffer: null });
}

function clearLiveOffer(offerId: string): void {
  const store = readStore();
  const rec = store.accounts.find((a) => a.liveOffer?.offerId === offerId);
  if (rec) writeRecord({ ...rec, liveOffer: null });
}

// ── the ERC20 bridge (project 00035 PR-B) ────────────────────────────────────
//
// FOUR ACTS, AND THE MIDDLE ONE IS NOT ON MIDNIGHT. Nothing on Midnight can wait for an
// Ethereum transaction inside one proof, so a round trip is always: a START transaction that
// asks the MPC for a signature, a RELAY (poll the singleton, broadcast, poll for the
// attestation) that happens off-chain, and a SETTLE transaction that verifies the
// attestation in-circuit. The start is device-gated on the account path and permissionless
// at the vault's root on the wallet path; the settle is permissionless either way, which is
// what makes `POST /api/bridge/relay/:id` able to finish a request the operator started
// hours ago (spec FR-006).
//
// THE RECORD IS THE RESUME KEY. Everything a settle needs — the request id, the relay
// result, the planned coin — is written to /aa/out/aa-bridge.json as it is learned, so a
// console restart loses time and nothing else. What it CANNOT survive is `./down.sh -v`:
// every deposit address is derived from the vault CONTRACT address and the chain is new
// (question Q13), so funds parked at a wiped stack's deposit address need the static root
// and a manual tool to recover. The UI says so where it shows the address.

const bridgeVaultCompiled = () =>
  CompiledContract.make("Erc20Vault", (VaultModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(VAULT_ZK_PATH),
  );

/** Connect a wallet to the deployed vault — the WALLET-recipient path's transport. The
 *  vault is witness-free, so its private state is `{}` and its zk bundle is a LEAF: the
 *  proof provider still spans the whole artefact root (providersFor), because a call tree
 *  needs every contract's keys. */
async function connectVault(walletCtx: any): Promise<{ handle: any; providers: any; privateStateId: string }> {
  requireBridge();
  const providers = await providersFor(walletCtx, VAULT_ZK_PATH);
  const privateStateId = `Erc20Vault-console-${Date.now().toString(36)}`;
  const handle: any = await (findDeployedContract as any)(providers, {
    contractAddress: VAULT_ADDRESS!,
    compiledContract: bridgeVaultCompiled(),
    privateStateId,
    initialPrivateState: {},
  });
  return { handle, providers, privateStateId };
}

/** The value a circuit returned, whichever spelling this midnight-js build uses. Same four
 *  candidates the fork's own `bridge.ts` tries; it keeps the shape private, and duplicating
 *  four property names is better than reaching into it. */
function circuitResultOf(r: any): any {
  for (const v of [r?.private?.result, r?.private?.circuitResult, r?.private?.returnValue, r?.result]) {
    if (v !== undefined) return v;
  }
  return undefined;
}

const txIdOf = (r: any): string => String(r?.public?.txId ?? r?.public?.transactionHash ?? "");

/** An `AccountBridge` with no account behind it: enough for `relay()` and `plannedCoin()`,
 *  which read only the public data provider and the config. The fork's own driver builds the
 *  same stub to derive a deposit address without touching the chain. */
const readOnlyBridge = (cfg: any) =>
  new AccountBridge({ providers: { publicDataProvider: publicData } } as never, cfg, new Uint8Array(32));

/** The open request ids in one direction, read straight from the vault's ledger state. */
async function vaultRequestIds(cfg: any, kind: "deposit" | "withdraw"): Promise<string[]> {
  return await readOnlyBridge(cfg).pendingRequests(kind);
}

/** A shielded address (or a raw 64-hex coin public key, for a caller that has one) as a
 *  bridge recipient. The ENCRYPTION key is what makes the minted coin visible to its owner
 *  (00034 question Q42), and only the bech32m address carries both halves — so a bare coin
 *  public key is accepted for the derivation but refused for a deposit. */
function walletRecipientFrom(shieldedAddress: string): BridgeRecipient {
  const a = String(shieldedAddress ?? "").trim();
  if (!a.startsWith("mn_shield-addr")) {
    throw new Error("a Midnight recipient must be a mn_shield-addr… address: it carries BOTH the coin "
      + "public key and the encryption key, and without the second one the bridged coin lands where "
      + "its owner cannot see it (00034 Q42)");
  }
  const dec: any = parseMidnightBech32m(a).decode(ShieldedAddress as any, CONFIG.networkId as any);
  return {
    kind: "wallet",
    coinPublicKey: String(dec.coinPublicKeyString()).replace(/^0x/, "").toLowerCase(),
    encryptionPublicKey: String(dec.encryptionPublicKeyString()).replace(/^0x/, "").toLowerCase(),
    shieldedAddress: a,
  };
}

/** The frontend wallet's shielded address, if this stack published one. PUBLIC data: the
 *  console is never given the seed (the SPA's page already exposes that to anyone who can
 *  load it, which docs/KNOWN-LIMITATIONS.md records). */
function frontendWalletAddress(): string | null {
  const fromEnv = (process.env["AA_FRONTEND_WALLET_SHIELDED_ADDRESS"] ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const doc = JSON.parse(readFileSync("/aa/out/frontend-wallet.json", "utf-8"));
    const a = String(doc.shielded ?? "").trim();
    return a.startsWith("mn_shield-addr") ? a : null;
  } catch {
    return null;
  }
}

function bridgeLog(rec: BridgeRequest, j: Job | null, line: string): BridgeRequest {
  if (j) jlog(j, line);
  else log(`bridge ${rec.requestId.slice(0, 8)} ${line}`);
  return upsertRequest({ ...rec, log: [...rec.log, `${new Date().toISOString().slice(11, 19)} ${line}`] });
}

/**
 * The relayer loop for one request: wait for the MPC's signature, broadcast the signed
 * Ethereum transaction, wait until an attestation verifies. Idempotent — a request whose
 * relay result is already recorded returns it rather than asking the MPC again, which is
 * what makes `POST /api/bridge/relay/:id` safe to press twice.
 */
async function runRelay(j: Job, rec0: BridgeRequest): Promise<BridgeRequest> {
  let rec = rec0;
  if (rec.relay) {
    bridgeLog(rec, j, "the attestation is already recorded — going straight to the settle");
    return rec;
  }
  const token = await bridgedToken(rec.erc20);
  const cfg = bridgeConfigFor(token.erc20);
  const expectedSigner = rec.direction === "deposit" ? rec.depositAddress! : vaultEvmAddressFor(cfg);
  rec = bridgeLog(rec, j, `relay: the MPC must sign as ${expectedSigner}; waiting up to `
    + `${Math.round(MPC_TIMEOUT_MS / 60000)} min`);
  const t0 = Date.now();
  const result: any = await readOnlyBridge(cfg).relay(rec.direction, rec.requestId, expectedSigner, {
    timeoutMs: MPC_TIMEOUT_MS,
    log: (line) => jlog(j, `  ${line.trim()}`),
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  rec = upsertRequest({
    ...rec,
    relay: serialiseRelay(result),
    evmTxHash: result.evmTxHash ?? null,
    evmStatus: result.evmStatus ?? null,
    attestedKind: result.kind,
    attestationLabel: attestationLabelFor(String(result.kind)),
    state: "attested",
  });
  rec = bridgeLog(rec, j, `attested ${result.kind} after ${seconds}s`
    + (result.evmTxHash ? `; EVM tx ${result.evmTxHash} status ${String(result.evmStatus)}` : " (not broadcast)"));
  // The block number is a second read, and a failure to get it must not lose the relay.
  if (result.evmTxHash) {
    const provider = evmProvider();
    try {
      const receipt = await provider.getTransactionReceipt(result.evmTxHash);
      if (receipt) rec = upsertRequest({ ...rec, evmBlock: Number(receipt.blockNumber) });
    } catch { /* the hash and the status are already recorded */ } finally { provider.destroy(); }
  }
  return rec;
}

/** Settle a deposit into an ACCOUNT: `bridge_deposit_complete` claims the mint, files its
 *  inbox entry and returns the coin, whose tree position is then captured so `held_coin`
 *  can spend it (question Q68 — a position we cannot read is a coin we cannot spend). */
async function settleDepositToAccount(j: Job, rec0: BridgeRequest): Promise<BridgeRequest> {
  let rec = rec0;
  const record = requireRecord(rec.accountId!);
  const token = await bridgedToken(rec.erc20);
  const cfg = bridgeConfigFor(token.erc20);
  const relayResult = deserialiseRelay(rec.relay);
  await withProveRetry(j, "bridge_deposit_complete", () => session("bridge-deposit-complete", async (walletCtx) => {
    const account = await connectAccount(walletCtx, record);
    const bridge = new AccountBridge(account, cfg, hexToBytes(record.encPublicKey));
    const planned = rec.planned
      ? {
        mintNonce: hexToBytes(rec.planned.mintNonceHex), nonce: hexToBytes(rec.planned.mintNonceHex),
        color: hexToBytes(rec.planned.colourHex), value: BigInt(rec.planned.value),
      }
      : await bridge.plannedCoin("deposit", rec.requestId, randomMintNonce());
    rec = upsertRequest({
      ...rec,
      planned: {
        mintNonceHex: toHex(planned.mintNonce), colourHex: toHex(planned.color), value: String(planned.value),
      },
    });
    jlog(j, `proving bridge_deposit_complete (k=18) — claiming `
      + `${fromRaw(planned.value, token.decimals)} ${token.symbol} and sealing its inbox entry`);
    const out = await bridge.completeDeposit(rec.requestId, relayResult, planned);
    rec = upsertRequest({ ...rec, settleTxId: out.txId });
    if (!out.coin) {
      rec = upsertRequest({ ...rec, state: "closed-false" });
      rec = bridgeLog(rec, j, `settled with NO mint — the ERC20 transfer returned false. The tokens are `
        + `still at ${rec.depositAddress} and a new deposit can sweep them`);
      return;
    }
    if (!out.entryMatchesCoin) {
      jlog(j, "WARNING: the coin the circuit returned is not the one the inbox entry describes — the coin "
        + "is claimed, but a client rebuilding from chain data alone would not find it (backfill needed)");
    }
    const captured = await captureCoin(record, out.txId, out.coin as any, j);
    rec = bridgeLog(rec, j, `settled — tx=${out.txId}; the account now holds `
      + `${fromRaw(BigInt((captured.coins[token.colour] ?? { value: "0" }).value), token.decimals)} ${token.symbol}`);
    rec = upsertRequest({ ...rec, state: "completed" });
  }, { requireFunds: true }));
  return rec;
}

/**
 * Settle a deposit to a WALLET key: the vault mints straight to that key at the transaction
 * root, and the console never holds anything of the recipient's.
 *
 * `callTx` cannot carry the recipient's encryption key, so this builds, proves, balances and
 * submits by hand with `additionalCoinEncPublicKeyMappings` — the same three lines
 * midnight-js's own `submitTxCore` runs, and the same shape `CustodyAccount.withdrawShieldedToWallet`
 * uses for the identical reason (00034 question Q42). Without the mapping the coin still
 * belongs to the recipient and they simply cannot SEE it, which is a silent failure.
 */
async function settleDepositToWallet(j: Job, rec0: BridgeRequest): Promise<BridgeRequest> {
  let rec = rec0;
  const token = await bridgedToken(rec.erc20);
  const cfg = bridgeConfigFor(token.erc20);
  const relayResult = deserialiseRelay(rec.relay);
  const recipient = rec.recipient as Extract<BridgeRecipient, { kind: "wallet" }>;
  await withProveRetry(j, "vault completeDeposit", () => session("bridge-wallet-complete", async (walletCtx) => {
    const { handle, providers, privateStateId } = await connectVault(walletCtx);
    void handle;
    const planned = rec.planned
      ? {
        mintNonce: hexToBytes(rec.planned.mintNonceHex),
        color: hexToBytes(rec.planned.colourHex), value: BigInt(rec.planned.value),
      }
      : await (async () => {
        const p = await readOnlyBridge(cfg).plannedCoin("deposit", rec.requestId, randomMintNonce());
        return { mintNonce: p.mintNonce, color: p.color, value: p.value };
      })();
    rec = upsertRequest({
      ...rec,
      planned: { mintNonceHex: toHex(planned.mintNonce), colourHex: toHex(planned.color), value: String(planned.value) },
    });
    const { createUnprovenCallTx } = await import("@midnight-ntwrk/midnight-js-contracts");
    // BOTH SPELLINGS. midnight-js normalises the map's keys with `parseCoinPublicKeyToHex`,
    // and the SDK's own wallet state renders these keys 0x-prefixed while the address codec
    // renders them bare. Offering both costs one map entry and removes a class of silent
    // "the coin landed and nobody can see it" failures.
    const mappings = new Map<any, any>([
      [recipient.coinPublicKey, recipient.encryptionPublicKey],
      [`0x${recipient.coinPublicKey}`, `0x${recipient.encryptionPublicKey}`],
    ]);
    jlog(j, `proving the vault's completeDeposit at ROOT — minting `
      + `${fromRaw(planned.value, token.decimals)} ${token.symbol} to ${recipientLabel(recipient)}`);
    const built: any = await (createUnprovenCallTx as any)(providers, {
      compiledContract: bridgeVaultCompiled(),
      contractAddress: VAULT_ADDRESS!,
      circuitId: "completeDeposit",
      args: [hexToBytes(rec.requestId), relayResult.event, relayResult.serializedOutput, planned.mintNonce],
      privateStateId,
      additionalCoinEncPublicKeyMappings: mappings,
    });
    // prove → balance → submit, in that order and with NOTHING in between: the wallet
    // balances through `balanceUnboundTransaction`, so binding first is refused after a
    // successful proof (00034 S-L finding, recorded in the fork's account.ts).
    const proven: any = await providers.proofProvider.proveTx(built.private.unprovenTx);
    const balanced: any = await providers.walletProvider.balanceTx(proven);
    const submitted: any = await providers.midnightProvider.submitTx(balanced);
    const txId = String(
      (typeof submitted === "string" ? submitted : submitted?.txId)
      ?? balanced?.transactionHash?.()?.toString?.() ?? balanced?.transactionHash ?? "",
    );
    const claimed = circuitResultOf(built.private) ?? circuitResultOf(built);
    const minted = claimed === undefined ? null : (claimed.is_some === undefined ? claimed : (claimed.is_some ? claimed.value : null));
    rec = upsertRequest({ ...rec, settleTxId: txId, state: minted ? "completed" : "closed-false" });
    rec = bridgeLog(rec, j, minted
      ? `settled — tx=${txId}; ${fromRaw(BigInt(minted.value), token.decimals)} ${token.symbol} minted to `
        + `${recipient.shieldedAddress ?? recipientLabel(recipient)}. That wallet sees it by syncing; this console holds none of its keys`
      : `settled with NO mint — the ERC20 transfer returned false; the tokens are still at ${rec.depositAddress}`);
  }, { requireFunds: true }));
  return rec;
}

/** Settle a withdrawal. A successful one mints nothing back; a `transfer` that returned
 *  false, or one that never executed, re-mints to the account, which claims it here. */
async function settleWithdraw(j: Job, rec0: BridgeRequest): Promise<BridgeRequest> {
  let rec = rec0;
  const record = requireRecord(rec.accountId!);
  const token = await bridgedToken(rec.erc20);
  const cfg = bridgeConfigFor(token.erc20);
  const relayResult = deserialiseRelay(rec.relay);
  const neverExecuted = relayResult.kind === "never-executed";
  await withProveRetry(j, "bridge_withdraw_settle", () => session("bridge-withdraw-settle", async (walletCtx) => {
    const account = await connectAccount(walletCtx, record);
    const bridge = new AccountBridge(account, cfg, hexToBytes(record.encPublicKey));
    const planned = await bridge.plannedCoin("withdraw", rec.requestId, randomMintNonce());
    jlog(j, neverExecuted
      ? "the transaction never executed — proving bridge_withdraw_refund (the amount is re-minted)"
      : "proving bridge_withdraw_complete");
    const out = neverExecuted
      ? await bridge.refundWithdraw(rec.requestId, relayResult, planned)
      : await bridge.completeWithdraw(rec.requestId, relayResult, planned);
    rec = upsertRequest({ ...rec, settleTxId: out.txId });
    if (out.coin) {
      await captureCoin(record, out.txId, out.coin as any, j);
      rec = upsertRequest({ ...rec, state: neverExecuted ? "refunded" : "closed-false" });
      rec = bridgeLog(rec, j, `settled — tx=${out.txId}; `
        + `${fromRaw(BigInt(out.coin.value), token.decimals)} ${token.symbol} came back to the account`);
    } else {
      rec = upsertRequest({ ...rec, state: "completed" });
      rec = bridgeLog(rec, j, `settled — tx=${out.txId}; the tokens are on `
        + `${rec.destEvmAddress} and nothing was minted back, which is what a successful withdrawal looks like`);
    }
  }, { requireFunds: true }));
  return rec;
}

/** Relay (if it has not happened yet) and settle. The one place the two halves are joined,
 *  used by every start job and by `POST /api/bridge/relay/:id`. */
async function relayAndSettle(j: Job, rec0: BridgeRequest): Promise<void> {
  let rec = rec0;
  try {
    rec = await runRelay(j, rec);
    rec = rec.direction === "withdraw"
      ? await settleWithdraw(j, rec)
      : rec.recipient.kind === "account"
        ? await settleDepositToAccount(j, rec)
        : await settleDepositToWallet(j, rec);
    j.txId = rec.settleTxId ?? j.txId;
    j.data = { ...(j.data as any ?? {}), request: findRequest(rec.requestId) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    upsertRequest({ ...(findRequest(rec.requestId) ?? rec), error: msg });
    jlog(j, `the request is PERSISTED as ${rec.requestId} — resume with `
      + `POST /api/bridge/relay/${rec.requestId} once the cause is cleared`);
    throw e;
  }
}

/** Resume a request from its persisted id (spec FR-006). The start is never redone. */
function bridgeResumeJob(requestId: string): Job {
  return enqueue("bridge-resume", async (j) => {
    const rec = requireRequest(requestId);
    if (rec.state === "completed" || rec.state === "refunded" || rec.state === "closed-false") {
      jlog(j, `request ${rec.requestId.slice(0, 16)}… is already ${rec.state} — nothing to do`);
      j.data = { request: rec };
      return;
    }
    jlog(j, `resuming ${rec.direction} ${rec.requestId.slice(0, 16)}… from state '${rec.state}'`);
    await relayAndSettle(j, upsertRequest({ ...rec, jobId: j.id, error: null }));
  });
}

/**
 * The WALLET-recipient deposit start: the console's relay wallet calls the vault at ROOT
 * with `recipient = left(coin public key)`.
 *
 * No signature is involved and none is possible — the account arm is not in this path at
 * all. What protects the funds is the derivation: the deposit address is
 * `f(root key, vault, depositPath(recipient))`, so tokens sent there can only ever be minted
 * to that recipient, whoever submits the calls (spec FR-017 of project 00034).
 */
function bridgeWalletDepositJob(token: BridgedToken, amountRaw: bigint, recipient: BridgeRecipient): Job {
  return enqueue("bridge-deposit-wallet", async (j) => {
    requireBridge();
    const cfg = bridgeConfigFor(token.erc20);
    const depositAddress = depositAddressOf(cfg, recipient);
    const provider = evmProvider();
    let evmNonce = 0n;
    try {
      const erc20 = new ethers.Contract(token.erc20, ERC20_ABI, provider);
      const [nonce, bal, eth] = await Promise.all([
        provider.getTransactionCount(depositAddress, "latest"),
        (erc20 as any).balanceOf(depositAddress) as Promise<bigint>,
        provider.getBalance(depositAddress),
      ]);
      evmNonce = BigInt(nonce);
      if (BigInt(bal) < amountRaw) {
        throw new Error(`${depositAddress} holds ${fromRaw(BigInt(bal), token.decimals)} ${token.symbol}, `
          + `and this deposit needs ${fromRaw(amountRaw, token.decimals)}`);
      }
      if (BigInt(eth) < GAS_BUDGET_WEI) {
        throw new Error(`${depositAddress} holds ${formatEth(BigInt(eth))} ETH and the MPC-signed transfer `
          + `can cost up to ${formatEth(GAS_BUDGET_WEI)} — send ${formatEth(GAS_FUNDING_WEI - BigInt(eth))} ETH there first`);
      }
    } finally {
      provider.destroy();
    }
    chargeCap(token.symbol, amountRaw, token.decimals, GAS_FUNDING_WEI);
    jlog(j, `deposit ${fromRaw(amountRaw, token.decimals)} ${token.symbol} → ${recipientLabel(recipient)}`);
    jlog(j, `deposit address ${depositAddress}, its Ethereum nonce ${evmNonce}`);

    const before = new Set(await vaultRequestIds(cfg, "deposit"));
    let requestId = "";
    let startTxId = "";
    await withProveRetry(j, "vault startDeposit", () => session("bridge-wallet-start", async (walletCtx) => {
      const { handle } = await connectVault(walletCtx);
      jlog(j, "proving the vault's startDeposit at ROOT (vault → SignetSigner.signBidirectional)…");
      const r = await handle.callTx.startDeposit(
        evmNonce, EVM_GAS.gasLimit, EVM_GAS.maxFeePerGas, EVM_GAS.maxPriorityFeePerGas, EVM_GAS.keyVersion,
        hexToBytes(token.erc20), amountRaw, recipientEither(recipient),
      );
      startTxId = txIdOf(r);
    }));
    const after = await vaultRequestIds(cfg, "deposit");
    const fresh = after.filter((id) => !before.has(id));
    requestId = (fresh[fresh.length - 1] ?? after[after.length - 1] ?? "").toString();
    if (!requestId) throw new Error("the vault records no open deposit request after the start");
    let rec = upsertRequest(newRequestRecord({
      requestId, direction: "deposit", recipient,
      accountId: null, erc20: token.erc20, symbol: token.symbol, decimals: token.decimals,
      colour: token.colour, amountRaw: String(amountRaw),
      depositAddress, startTxId, jobId: j.id, state: "started",
    }));
    j.txId = startTxId;
    rec = bridgeLog(rec, j, `start tx ${startTxId}; request ${requestId}`);
    await relayAndSettle(j, rec);
  });
}


/**
 * The ACCOUNT-path deposit start, after the browser has signed.
 *
 * This is `AccountBridge.startDeposit`'s body minus the `authorise` step: the console
 * authorises in a separate HTTP round trip (prepare → wallet → submit), so it re-derives the
 * authorisation from the PREPARED context and then makes the same call the library makes.
 * The fork's own driver calls `callTx` directly for the same reason in several places.
 */
async function runBridgeDepositStart(j: Job, prep: Prepared, auth: unknown): Promise<void> {
  requireBridge();
  const exec = prep.exec!;
  const record = requireRecord(exec.address);
  const { token, amountRaw, depositAddress, evmNonce } = exec.bridge!;
  const req = exec.request as Extract<AuthRequest, { op: "bridgeDepositStart" }>;
  const cfg = bridgeConfigFor(token.erc20);
  // Charged HERE, one line before the only transaction that commits anything (FR-017).
  chargeCap(token.symbol, amountRaw, token.decimals, GAS_FUNDING_WEI);
  jlog(j, `deposit ${fromRaw(amountRaw, token.decimals)} ${token.symbol} → account ${exec.address.slice(0, 18)}…`);
  jlog(j, `deposit address ${depositAddress}, its Ethereum nonce ${evmNonce}`);

  const before = new Set(await vaultRequestIds(cfg, "deposit"));
  let startTxId = "";
  await withProveRetry(j, "bridge_deposit_start_with_evm", () => session("bridge-deposit-start", async (walletCtx) => {
    const account = await connectAccount(walletCtx, record);
    jlog(j, "proving bridge_deposit_start_with_evm (k=18; account → vault → SignetSigner, one transaction, "
      + "three contract calls)…");
    const r = await account.callTx.bridge_deposit_start_with_evm(
      req.erc20, req.amount, req.evm.nonce, req.evm.gasLimit, req.evm.maxFeePerGas,
      req.evm.maxPriorityFeePerGas, req.evm.keyVersion, ...authArgs(auth as any),
    );
    startTxId = txIdOf(r);
    await persistAccount(account, record);
  }));
  const after = await vaultRequestIds(cfg, "deposit");
  const fresh = after.filter((id) => !before.has(id));
  const requestId = String(fresh[fresh.length - 1] ?? after[after.length - 1] ?? "");
  if (!requestId) throw new Error("the vault records no open deposit request after the start");
  j.txId = startTxId;
  let rec = upsertRequest(newRequestRecord({
    requestId, direction: "deposit",
    recipient: { kind: "account", accountId: exec.address },
    accountId: exec.address,
    erc20: token.erc20, symbol: token.symbol, decimals: token.decimals, colour: token.colour,
    amountRaw: String(amountRaw), depositAddress, startTxId, jobId: j.id, state: "started",
  }));
  rec = bridgeLog(rec, j, `start tx ${startTxId}; request ${requestId}`);
  await relayAndSettle(j, rec);
}

/** The ACCOUNT-path withdraw start, after the browser has signed. The account sends the coin
 *  to the vault, the vault claims it and calls the singleton — one transaction. The change,
 *  if any, comes back to the account and is captured here; it has NO inbox entry (the nonce
 *  the standard library gives it is not derivable in advance, 00034 question Q46), which is
 *  said in the log rather than papered over. */
async function runBridgeWithdrawStart(j: Job, prep: Prepared, auth: unknown): Promise<void> {
  requireBridge();
  const exec = prep.exec!;
  let record = requireRecord(exec.address);
  const { token, amountRaw, destEvmAddress } = exec.bridge!;
  const req = exec.request as Extract<AuthRequest, { op: "bridgeWithdrawStart" }>;
  const cfg = bridgeConfigFor(token.erc20);
  chargeCap(token.symbol, 0n, token.decimals, GAS_FUNDING_WEI);
  jlog(j, `withdraw ${fromRaw(amountRaw, token.decimals)} ${token.symbol} → ${destEvmAddress}`);

  const before = new Set(await vaultRequestIds(cfg, "withdraw"));
  let startTxId = "";
  let change: any = null;
  const colour = token.colour;
  await withProveRetry(j, "bridge_withdraw_start_with_evm", () => session("bridge-withdraw-start", async (walletCtx) => {
    const { result, record: after } = await spendWithCandidates(j, record, colour, walletCtx, async (account) => {
      jlog(j, "proving bridge_withdraw_start_with_evm (k=18)…");
      return await account.callTx.bridge_withdraw_start_with_evm(
        req.dest, req.color, req.amount, req.evm.nonce, req.evm.gasLimit, req.evm.maxFeePerGas,
        req.evm.maxPriorityFeePerGas, req.evm.keyVersion, req.erc20, new Uint8Array(192),
        ...authArgs(auth as any),
      );
    });
    record = after;
    startTxId = txIdOf(result);
    const r = circuitResultOf(result);
    change = r && r.is_some ? r.value : null;
  }));
  // The surrendered coin is gone from the account's custody whatever happens next.
  let next = { ...record, coins: { ...record.coins } };
  delete next.coins[colour];
  writeRecord(next);
  if (change) {
    jlog(j, `the withdrawal left ${fromRaw(BigInt(change.value), token.decimals)} ${token.symbol} of change — capturing it`);
    next = await captureCoin(next, startTxId, change, j);
    jlog(j, "note: the change coin has NO inbox entry (its nonce is not derivable in advance, 00034 Q46) — "
      + "file one with Append inbox if a client must rediscover it from chain data");
  }
  const after = await vaultRequestIds(cfg, "withdraw");
  const fresh = after.filter((id) => !before.has(id));
  const requestId = String(fresh[fresh.length - 1] ?? after[after.length - 1] ?? "");
  if (!requestId) throw new Error("the vault records no open withdraw request after the start");
  j.txId = startTxId;
  let rec = upsertRequest(newRequestRecord({
    requestId, direction: "withdraw",
    recipient: { kind: "account", accountId: exec.address },
    accountId: exec.address,
    erc20: token.erc20, symbol: token.symbol, decimals: token.decimals, colour: token.colour,
    amountRaw: String(amountRaw), destEvmAddress: destEvmAddress ?? null,
    startTxId, jobId: j.id, state: "started",
  }));
  rec = bridgeLog(rec, j, `start tx ${startTxId}; request ${requestId}`);
  await relayAndSettle(j, rec);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? String(v) : v)), {
    status, headers: { "content-type": "application/json" },
  });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

const STATIC_DIR = "/aa/console";
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const staticFile = (name: string, type: string) =>
  new Response(Bun.file(resolve(STATIC_DIR, name)), {
    headers: { "content-type": type, "cache-control": "no-store" },
  });

type ProbeResult = { status: "up" | "down" | "absent"; info?: unknown };
async function probe(fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    return { status: "up", info: await fn() };
  } catch (e) {
    const m = e instanceof Error ? `${e.message} ${(e as any).code ?? ""}` : String(e);
    const refused = /ConnectionRefused|ECONNREFUSED/i.test(m);
    const absent = !refused && /getaddrinfo|resolve|ENOTFOUND|DNS|FailedToOpenSocket|Unable to connect/i.test(m);
    return { status: absent ? "absent" : "down", info: m.slice(0, 160) };
  }
}
const T = (ms: number) => AbortSignal.timeout(ms);
const fetchJson = async (url: string, init: RequestInit = {}, ms = 3500) => {
  const r = await fetch(url, { ...init, signal: T(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
};
const fetchAlive = async (url: string, ms = 3000) => {
  const r = await fetch(url, { signal: T(ms) });
  return { httpStatus: r.status };
};

async function infraStatus() {
  const rpc = (method: string) =>
    fetchJson("http://node:9944", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });
  const probePostgres = async () => {
    const socket = await Bun.connect({ hostname: "postgres", port: 5432, socket: { data() {} } });
    socket.end();
    return { reachable: true, host: "postgres:5432", databases: ["offerfiles", "umbra"] };
  };

  const [node, indexer, proofServer, aaProofServer, kernel, kernelSync, batcher, celestia, evmRpc, frontend, sink, postgres] =
    await Promise.all([
      probe(async () => {
        const health = (await rpc("system_health")) as any;
        const head = (await rpc("chain_getHeader")) as any;
        return { peers: health.result?.peers, block: parseInt(head.result?.number ?? "0", 16) };
      }),
      probe(async () => {
        const r = (await fetchJson("http://indexer:8088/api/v4/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ block { height } }" }),
        })) as any;
        return { height: r.data?.block?.height };
      }),
      probe(() => fetchAlive("http://proof-server:6300/")),
      probe(() => fetchAlive("http://aa-proof-server:6300/")),
      probe(async () => {
        const h = (await fetchJson(`${KERNEL_URL}/health`)) as any;
        return { status: h.status, blockHeight: h.apply?.blockHeight };
      }),
      probe(async () => {
        const s = (await fetchJson(`${KERNEL_URL}/v1/health/sync`)) as any;
        return { current: s.current ?? s.isCurrent ?? null, offers: s.offers ?? null };
      }),
      probe(async () => (await fetchJson("http://batcher:3334/health")) as any),
      probe(() => fetchAlive("http://celestia:26658/")),
      probe(async () => {
        const r = (await fetchJson("http://evm-rpc:8545", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        })) as any;
        return { block: parseInt(r.result ?? "0", 16) };
      }),
      probe(() => fetchAlive("http://frontend:10600/")),
      probe(async () => {
        const h = (await fetchJson(`${SINK_URL}/health`)) as any;
        const snap = (await fetchJson(`${SINK_URL}/api/snapshot`)) as any;
        return {
          health: h,
          solverConnected: snap.solver?.connected ?? false,
          ladderPairs: Object.keys(snap.ladders ?? {}).length,
          framesAccepted: snap.frames?.accepted ?? 0,
        };
      }),
      probe(probePostgres),
    ]);

  const solverStatus = await probe(async () => (await fetchJson(`${SOLVER_STATUS_URL}/health`)) as any);
  const solver: ProbeResult =
    solverStatus.status === "up"
      ? {
          status: "up",
          info: {
            via: "status listener :9100 (unpublished)",
            health: solverStatus.info,
            relaySocket: sink.status === "up" ? ((sink.info as any).solverConnected ?? false) : "unknown",
          },
        }
      : sink.status !== "up"
        ? { status: "absent", info: "no status listener and no sink — no visibility" }
        : (sink.info as any).solverConnected
          ? { status: "up", info: { via: "sink relay socket (status listener unreachable)" } }
          : { status: "down", info: "sink up, no solver connected" };

  const [solverFrontend, offerPoster, faucet] = await Promise.all([
    probe(async () => (await fetchJson(`${SOLVER_FRONTEND_URL}/health`)) as any),
    probe(async () => {
      const h = (await fetchJson(`${OFFER_POSTER_URL}/health`)) as any;
      return {
        state: h.state, mints: h.mints, liveOffers: h.liveOffers,
        lastOfferId: typeof h.lastOfferId === "string" ? h.lastOfferId.slice(0, 12) : null,
        lastFailure: h.lastFailure ?? null,
      };
    }),
    probe(async () => {
      const reg = (await fetchJson(`${FAUCET_URL}/metadata.${NETWORK_KEY}.json`)) as any;
      const active = (reg?.tokens ?? []).filter((t: any) =>
        (t?.deployments ?? []).some((d: any) => d?.deploymentId === t?.activeDeploymentId && d?.status === "active"));
      if (reg?.status !== "ready" || active.length !== 6) {
        throw new Error(`registry is ${reg?.status ?? "unreadable"} with ${active.length} active deployments`);
      }
      return {
        status: reg.status,
        tokens: active.map((t: any) => t.symbol),
        registryRevision: typeof reg.registryRevision === "string" ? reg.registryRevision.slice(0, 12) : null,
      };
    }),
  ]);

  const priceFeed = await probe(async () => {
    const NIGHT = "0".repeat(64);
    const p = (await fetchJson(`${KERNEL_URL}/v1/prices?tokens=${NIGHT}`)) as any;
    const feed = p?.feed ?? {};
    if (!feed.last_run_at && !feed.last_ok_at) {
      throw new Error("no price-feed row — the `prices` profile has not run on this stack");
    }
    return {
      provider: feed.provider ?? null,
      lastOkAt: feed.last_ok_at ?? null,
      lastRunAt: feed.last_run_at ?? null,
      lastError: feed.last_error ?? null,
      fedAssets: (p?.assets ?? []).filter((a: any) => a?.source === "feed").map((a: any) => a.asset_id),
    };
  });
  const priceFeedComponent =
    priceFeed.status === "up" && (priceFeed.info as any)?.lastError
      ? { status: "down" as const, info: priceFeed.info }
      : priceFeed;

  return {
    at: new Date().toISOString(),
    components: {
      console: { status: "up", info: { relayFunded: relay.funded, takerFunded: taker.funded, jobsQueued: queue.length } },
      node, indexer, proofServer, aaProofServer,
      kernel, kernelSync, batcher, celestia,
      evmRpc, frontend, solverSink: sink, solver, solverFrontend, offerPoster, faucet,
      priceFeed: priceFeedComponent,
      postgres,
    },
  };
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/index.html") return staticFile("index.html", "text/html; charset=utf-8");
      if (/^\/[A-Za-z0-9_.-]+\.(html|js|css|svg)$/.test(path)) {
        const ext = path.slice(path.lastIndexOf("."));
        const f = Bun.file(resolve(STATIC_DIR, path.slice(1)));
        if (await f.exists()) {
          return new Response(f, { headers: { "content-type": STATIC_TYPES[ext], "cache-control": "no-store" } });
        }
        return bad("not found", 404);
      }
      if (path === "/api/infra") return json(await infraStatus());
      if (path === "/healthz") {
        return json({ ok: true, relay, taker, jobsQueued: queue.length, deployed: existsSync(ARTIFACT_PATH) });
      }
      if (path === "/api/info") {
        return json({
          network: CONFIG.networkId,
          model: "passport-per-user-account",
          // The build receipt: which fork commit, which compiler, which prover keys this
          // image actually carries. The page's Repos tab renders it, and it is the one
          // place a reader can see it WITHOUT trusting a doc.
          build: BUILD,
          artefacts: artifact?.artefacts ?? null,
          vault: artifact?.vault ?? null,
          signet: artifact?.signet ?? null,
          mpc: artifact?.mpc ?? null,
          testFaucet: TEST_FAUCET ?? null,
          accountPlan: artifact?.accountPlan ?? null,
          swapCircuit: SWAP_CIRCUIT,
          proofServers: { contracts: CONTRACT_PROOF_SERVER, wallet: WALLET_PROOF_SERVER },
          relay, taker,
          tokens: tokens.list.map((t) => ({
            name: t.name, label: t.label, family: t.family, color: t.color,
            decimals: t.decimals, issuer: t.issuer,
            source: t.source ?? "faucet", ...(t.erc20 ? { erc20: t.erc20 } : {}),
          })),
          tokensError: tokens.error,
          // UNCHANGED, and deliberately: scripts/verify-aa.sh greps for this exact string, and
          // it names where the FAUCET colours come from. The bridged ones are a second source
          // and say so per token (`source: "bridged"`), which is what a consumer needs.
          tokensSource: "mint-test-tokens",
          bridgedTokensSource: "erc20-vault colours (AA_BRIDGE_TOKENS)",
          bridgedTokensError: bridged.error,
          tokensRegistryRevision: tokens.registryRevision,
          kernelUrl: KERNEL_URL,
          solverFrontendUrl: SOLVER_FRONTEND_PUBLIC_URL,
          faucetUrl: `${FAUCET_PUBLIC_URL.replace(/\/+$/, "")}/?network=${NETWORK_KEY}`,
          devSigner: DEV_SIGNER ? { address: DEV_ADDR } : null,
          // The Bridge tab's gate (spec FR-001). `available` is now three facts, not one:
          // the image's prover keys, a vault whose MPC root somebody actually holds, and an
          // EVM endpoint. `reasons` says which is missing, so the page can explain itself.
          // THE RPC URL IS NEVER HERE — it carries the operator's provider key.
          bridge: {
            ...bridgeAvailability(),
            frontendWallet: frontendWalletAddress(),
            gas: {
              gasLimit: String(EVM_GAS.gasLimit),
              maxFeePerGasWei: String(EVM_GAS.maxFeePerGas),
              budgetEth: formatEth(GAS_BUDGET_WEI),
              fundEth: formatEth(GAS_FUNDING_WEI),
            },
          },
        });
      }
      // ── the bridge (project 00035) ─────────────────────────────────────────
      //
      // The two DEVICE-GATED starts are not here: they are `kind: bridge-deposit-start` and
      // `kind: bridge-withdraw-start` on the existing /api/prepare → wallet → /api/submit
      // path, because the browser has to sign them. What is here is everything that needs no
      // signature — the quote, the wallet-recipient deposit, and the resumable relay/settle.
      if (path === "/api/bridge/tokens") {
        const a = bridgeAvailability();
        if (!a.available) return json({ available: false, reasons: a.reasons, tokens: [], errors: {} });
        const { tokens, errors } = await bridgedTokens();
        return json({
          available: true, chainId: a.chainId, attestation: a.attestation,
          vaultEvmAddress: tokens.length ? vaultEvmAddressFor(bridgeConfigFor(tokens[0]!.erc20)) : null,
          tokens: tokens.map((t) => ({ ...t, cap: capView(t) })), errors,
        });
      }
      if (path === "/api/bridge/quote" && req.method === "POST") {
        const body = await req.json();
        const direction = String(body.direction ?? "deposit");
        const token = await resolveToken(String(body.token ?? ""));
        const amountRaw = body.amount === undefined || body.amount === ""
          ? 0n : toRaw(String(body.amount), token.decimals);
        const cfg = bridgeConfigFor(token.erc20);
        const vaultEvmAddress = vaultEvmAddressFor(cfg);
        if (direction === "withdraw") {
          const provider = evmProvider();
          try {
            const erc20 = new ethers.Contract(token.erc20, ERC20_ABI, provider);
            const [eth, bal] = await Promise.all([
              provider.getBalance(vaultEvmAddress),
              (erc20 as any).balanceOf(vaultEvmAddress) as Promise<bigint>,
            ]);
            return json({
              direction, token, vaultEvmAddress,
              requiredTokenRaw: String(amountRaw), requiredToken: fromRaw(amountRaw, token.decimals),
              requiredEthWei: String(GAS_FUNDING_WEI), requiredEth: formatEth(GAS_FUNDING_WEI),
              gasBudgetEth: formatEth(GAS_BUDGET_WEI),
              balances: {
                token: fromRaw(BigInt(bal), token.decimals), tokenRaw: String(bal),
                eth: formatEth(BigInt(eth)), ethWei: String(eth),
              },
              ready: BigInt(bal) >= amountRaw && BigInt(eth) >= GAS_BUDGET_WEI,
              cap: capView(token),
              attestation: bridgeAvailability().attestation,
              note: "a withdrawal is paid out of the vault's OWN Ethereum account and its gas comes from "
                + "there too — the operator sends that ETH, the console never holds a key",
            });
          } finally { provider.destroy(); }
        }
        const recipient: BridgeRecipient = body.recipient?.shieldedAddress
          ? walletRecipientFrom(String(body.recipient.shieldedAddress))
          : { kind: "account", accountId: String(body.recipient?.account ?? body.accountId ?? "") };
        if (recipient.kind === "account" && !recipient.accountId) {
          throw new Error("recipient must be {account: <contract address>} or {shieldedAddress: mn_shield-addr…}");
        }
        const depositAddress = depositAddressOf(cfg, recipient);
        const provider = evmProvider();
        try {
          const erc20 = new ethers.Contract(token.erc20, ERC20_ABI, provider);
          const [bal, eth, nonce] = await Promise.all([
            (erc20 as any).balanceOf(depositAddress) as Promise<bigint>,
            provider.getBalance(depositAddress),
            provider.getTransactionCount(depositAddress, "latest"),
          ]);
          const shortToken = amountRaw > BigInt(bal) ? amountRaw - BigInt(bal) : 0n;
          const shortEth = GAS_BUDGET_WEI > BigInt(eth) ? GAS_FUNDING_WEI - BigInt(eth) : 0n;
          return json({
            direction: "deposit", token, depositAddress, vaultEvmAddress,
            recipient: recipient.kind === "account"
              ? { kind: "account", accountId: recipient.accountId }
              : { kind: "wallet", shieldedAddress: recipient.shieldedAddress, coinPublicKey: recipient.coinPublicKey },
            requiredTokenRaw: String(amountRaw), requiredToken: fromRaw(amountRaw, token.decimals),
            requiredEthWei: String(GAS_FUNDING_WEI), requiredEth: formatEth(GAS_FUNDING_WEI),
            gasBudgetEth: formatEth(GAS_BUDGET_WEI),
            balances: {
              token: fromRaw(BigInt(bal), token.decimals), tokenRaw: String(bal),
              eth: formatEth(BigInt(eth)), ethWei: String(eth), evmNonce: String(nonce),
            },
            shortfall: {
              token: fromRaw(shortToken, token.decimals), tokenRaw: String(shortToken),
              eth: formatEth(shortEth), ethWei: String(shortEth),
            },
            ready: shortToken === 0n && shortEth === 0n && amountRaw > 0n,
            cap: capView(token),
            attestation: bridgeAvailability().attestation,
            warning: "this deposit address is derived from the VAULT CONTRACT address, so it dies with "
              + "`./down.sh -v`: fund it, start, relay and complete within one stack session (question Q13)",
          });
        } finally { provider.destroy(); }
      }
      if (path === "/api/bridge/deposit/start" && req.method === "POST") {
        // The WALLET-recipient path only. An account recipient is device-gated and goes
        // through /api/prepare with kind `bridge-deposit-start`.
        const body = await req.json();
        const shielded = String(body.recipient?.shieldedAddress ?? body.shieldedAddress ?? "").trim();
        if (!shielded) {
          return bad("this route starts a deposit to a MIDNIGHT WALLET (recipient.shieldedAddress). "
            + "A deposit to the connected account is device-gated: POST /api/prepare "
            + "{kind:'bridge-deposit-start', owner, accountId, token, amount} and sign it in the browser");
        }
        const token = await resolveToken(String(body.token ?? ""));
        const amountRaw = toRaw(String(body.amount ?? "0"), token.decimals);
        if (amountRaw <= 0n) return bad("amount must be positive");
        assertCapHeadroom(token.symbol, amountRaw, token.decimals, GAS_FUNDING_WEI);
        return json({ jobId: bridgeWalletDepositJob(token, amountRaw, walletRecipientFrom(shielded)).id });
      }
      if (/^\/api\/bridge\/(relay|settle)\/[0-9a-fA-F]{64}$/.test(path) && req.method === "POST") {
        // ONE resume route, two names. `relay` and `settle` are the same act from the
        // record's point of view: whatever has already happened is skipped (the relay result
        // is persisted), and whatever has not is done. A withdrawal whose transaction never
        // executed settles through `bridge_withdraw_refund` automatically — the attestation
        // says which branch, not the caller.
        return json({ jobId: bridgeResumeJob(path.slice(path.lastIndexOf("/") + 1)).id });
      }
      if (path === "/api/bridge/requests") {
        const store = loadBridgeStore();
        return json({
          requests: store.requests, spent: store.spent,
          frontendWallet: frontendWalletAddress(),
        });
      }
      if (path === "/api/accounts") {
        const owner = url.searchParams.get("owner") ?? undefined;
        return json({ accounts: await listAccounts(owner ?? undefined) });
      }
      if (path === "/api/prepare" && req.method === "POST") {
        pruneOld();
        const prep = await buildAction(await req.json());
        const id = newId();
        prepared.set(id, prep);
        return json({
          prepId: id,
          kind: prep.kind,
          // EXACTLY ONE of these two is present, and the page branches on it: a `message`
          // is `personal_sign` (enrolment, authorises nothing); `typedData` is
          // `eth_signTypedData_v4` (an authorisation the circuit will verify).
          message: prep.message ?? null,
          typedData: prep.typedData ?? null,
          digest: prep.digest ?? null,
          summary: prep.summary,
        });
      }
      if (path === "/api/submit" && req.method === "POST") {
        const body = await req.json();
        const prep = prepared.get(String(body.prepId ?? ""));
        if (!prep) return bad("unknown or expired prepId — prepare again");
        const signature = String(body.signature ?? "");
        if (!/^0x[0-9a-f]{130}$/i.test(signature)) return bad("signature must be a 65-byte 0x hex string");
        prepared.delete(String(body.prepId));
        const job = prep.kind === "register" ? registerJob(prep, signature)
          : prep.kind === "swap" ? offerJob(prep, signature)
          : gatedJob(prep, signature);
        return json({ jobId: job.id });
      }
      if (path === "/api/pure") {
        if (req.method !== "POST") return json({ functions: PURE_FN_DOCS });
        const body = await req.json();
        const fn = String(body.fn ?? "");
        const args = Array.isArray(body.args) ? body.args.map(String) : [];
        return json({ fn, result: await runPureFn(fn, args) });
      }
      if (path === "/api/publish-offer" && req.method === "POST") {
        const body = await req.json();
        const blob = String(body.blob ?? "").trim();
        if (!/^swapoffer1[a-z0-9]+$/.test(blob)) return bad("blob must be a swapoffer1… bech32m string");
        let res: Response;
        try {
          res = await fetch(`${KERNEL_URL}/v1/offers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ offer: blob }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (e) {
          return bad(
            `kernel unreachable at ${KERNEL_URL} — bring the offerfiles profile up and retry ` +
            `(the built offer is not lost). Cause: ${e instanceof Error ? e.message : String(e)}`,
            503,
          );
        }
        const out: any = await res.json().catch(() => ({}));
        if (!res.ok) return bad(`kernel rejected the offer (${res.status}): ${JSON.stringify(out).slice(0, 300)}`, 400);
        return json({ published: true, offerId: out.offerId ?? null });
      }
      if (path === "/api/take" && req.method === "POST") {
        const body = await req.json();
        const offerId = String(body.offerId ?? "");
        if (!/^[0-9a-f]{64}$/i.test(offerId)) return bad("offerId must be 64 hex chars");
        return json({ jobId: takeJob(offerId).id });
      }
      if (path === "/api/offer/forget" && req.method === "POST") {
        // Q7's escape hatch: an offer nobody took blocks the account's next one, and the
        // maker's device entry is NOT consumed until a taker submits — so forgetting it
        // locally is safe and is the only way out of a stale live offer.
        const body = await req.json();
        clearLiveOffer(String(body.offerId ?? ""));
        return json({ cleared: true });
      }
      if (path === "/api/fund-shielded" && req.method === "POST") {
        const body = await req.json();
        const address = String(body.accountId ?? body.address ?? "");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        return json({ jobId: fundShieldedJob(address, amount, body.token === undefined ? undefined : String(body.token)).id });
      }
      if (path === "/api/offers") {
        try {
          const res = await fetch(`${KERNEL_URL}/v1/offers?limit=20`, { signal: AbortSignal.timeout(5000) });
          return json({ kernel: true, book: await res.json() });
        } catch {
          return json({ kernel: false, book: null });
        }
      }
      if (path === "/api/fund" && req.method === "POST") {
        const body = await req.json();
        const address = String(body.accountId ?? body.address ?? "");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        return json({ jobId: fundJob(address, amount, body.token === undefined ? undefined : String(body.token)).id });
      }
      if (path === "/api/deposit" && req.method === "POST") {
        const body = await req.json();
        const address = String(body.accountId ?? body.address ?? "");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const from = String(body.from ?? "taker");
        if (!["taker", "relay", "funder"].includes(from)) return bad("from must be taker|relay|funder");
        return json({
          jobId: depositFromWalletJob(address, amount, from as any,
            body.token === undefined ? undefined : String(body.token)).id,
        });
      }
      if (path === "/api/faucet" && req.method === "POST") {
        const body = await req.json();
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const target = String(body.target ?? "taker");
        if (!["relay", "taker", "funder"].includes(target)) return bad("target must be relay|taker|funder");
        return json({ jobId: faucetJob(body.token === undefined ? undefined : String(body.token), amount, target as any).id });
      }
      if (path === "/api/send" && req.method === "POST") {
        const body = await req.json();
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const to = String(body.to ?? "").trim();
        if (!to) return bad("to must be a bech32m Midnight address (mn_addr… or mn_shield-addr…)");
        return json({ jobId: sendJob(body.token === undefined ? undefined : String(body.token), amount, to).id });
      }
      if (path === "/api/dev-sign" && req.method === "POST") {
        if (!DEV_SIGNER) return bad("dev signer is disabled (set AA_CONSOLE_DEV_SIGNER=1)", 403);
        const body = await req.json();
        const prep = prepared.get(String(body.prepId ?? ""));
        if (!prep) return bad("unknown or expired prepId — prepare again");
        if (prep.owner !== DEV_OWNER) {
          return bad(`dev signer is ${DEV_ADDR}; the prepared action's owner is 0x${prep.owner}`);
        }
        const digest = prep.message ? eip191Digest(prep.message) : hexToBytes(prep.digest!);
        return json({ signature: `0x${toHex(serializeSignature(signDigest(DEV_KEY, digest)))}`, address: DEV_ADDR });
      }
      if (path.startsWith("/api/jobs/")) {
        const job = jobs.get(path.slice("/api/jobs/".length));
        if (!job) return bad("unknown job", 404);
        const { run: _run, ...view } = job;
        return json(view);
      }
      if (path === "/api/wallet/refresh" && req.method === "POST") {
        await checkWallet("relay");
        await checkWallet("taker");
        return json({ relay, taker });
      }
      return bad("not found", 404);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ERROR ${req.method} ${path}: ${msg}`);
      return bad(msg, 500);
    }
  },
});

// ── the account's read-only surface ──────────────────────────────────────────
// The Manager's `/api/pure` listed balance-map key derivations and registry lookups. An
// account has neither: what it has is LEDGER STATE (public, per account) and the contract's
// own PURE ORACLES — the same circuits the client uses to build a challenge, exposed so an
// auditor can reproduce a digest without trusting this process.
const PURE_FN_DOCS = [
  { fn: "ledger", kind: "read", params: ["address"], doc: "the account's whole public ledger state" },
  { fn: "encKey", kind: "read", params: ["address"], doc: "the account's advertised X25519 key — what a depositor seals to" },
  { fn: "authNonce", kind: "read", params: ["address"], doc: "the next authorisation nonce" },
  { fn: "inbox", kind: "read", params: ["address"], doc: "inbox_count and the raw entries (opaque without the viewing key)" },
  { fn: "deviceEntry", kind: "pure", params: ["address", "owner (0x…20)", "epoch", "counter"], doc: "derive_device_entry_with_evm — the rolling entry the seam looks up" },
  { fn: "bootCommitment", kind: "pure", params: ["salt (0x…32)", "owner (0x…20)"], doc: "derive_boot_commitment_with_evm" },
  { fn: "domainSeparator", kind: "pure", params: ["address", "salt (0x…32)"], doc: "the EIP-712 domain separator this account's wallet signs under" },
  { fn: "accountAlias", kind: "pure", params: ["address"], doc: "evm_account_alias — the 20-byte verifyingContract of the domain" },
];

async function runPureFn(fn: string, args: string[]): Promise<unknown> {
  const { pureCircuits } = await import("../passport/src/wallet/contract.js");
  const { accountAlias, domainSeparator } = await import("../passport/src/wallet/eip712.js");
  const addr = () => args[0] ?? "";
  switch (fn) {
    case "ledger": {
      const l = await accountLedger(addr());
      return {
        booted: Boolean(l.booted), authNonce: String(l.auth_nonce), round: String(l.round),
        inboxCount: String(l.inbox_count), deviceEpoch: String(l.device_epoch),
        encKey: toHex(Uint8Array.from(l.enc_key)),
        evmDomainSalt: toHex(Uint8Array.from(l.evm_domain_salt)),
      };
    }
    case "encKey": return toHex(Uint8Array.from((await accountLedger(addr())).enc_key));
    case "authNonce": return String((await accountLedger(addr())).auth_nonce);
    case "inbox": {
      const l = await accountLedger(addr());
      const entries: string[] = [];
      for (let i = 0n; i < l.inbox_count; i++) {
        if (l.inbox.member(i)) entries.push(toHex(Uint8Array.from(l.inbox.lookup(i))).slice(0, 32) + "…");
      }
      return { inboxCount: String(l.inbox_count), entries };
    }
    case "deviceEntry":
      return toHex((pureCircuits as any).derive_device_entry_with_evm(
        { bytes: hexToBytes(addr()) },
        hexToBytes(args[1] ?? ""),
        BigInt(args[2] ?? 0),
        BigInt(args[3] ?? 0),
      ));
    case "bootCommitment":
      return toHex((pureCircuits as any).derive_boot_commitment_with_evm(
        bytes32(args[0] ?? ""), hexToBytes(args[1] ?? ""),
      ));
    case "domainSeparator":
      return toHex(domainSeparator(hexToBytes(addr()), bytes32(args[1] ?? "")));
    case "accountAlias":
      return toHex(accountAlias(hexToBytes(addr())));
  }
  throw new Error(`unknown function '${fn}'`);
}

log(`serving on :${PORT} — passport ${String(BUILD.passportCommit).slice(0, 12)}…, ` +
  `${consoleAccountCircuits().length} circuits per account, vault ${VAULT_ADDRESS?.slice(0, 16) ?? "(none)"}…`);
log(`proof servers: contracts ${CONTRACT_PROOF_SERVER} (experimental, [v7]), wallet ${WALLET_PROOF_SERVER} (plain)`);
if (DEV_SIGNER) log(`dev signer ENABLED — address ${DEV_ADDR} (testing only)`);

const resolveTokensWithRetry = async (): Promise<void> => {
  const tries = Number(process.env["AA_TOKENS_RESOLVE_TRIES"] ?? 60);
  const everyMs = Number(process.env["AA_TOKENS_RESOLVE_INTERVAL_MS"] ?? 10_000);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    await resolveTokens();
    if (tokens.list.length > 0) {
      if (attempt > 1) log(`tokens resolved on attempt ${attempt}/${tries}`);
      return;
    }
    if (attempt === 1) {
      log(`the faucet registry is not readable yet — retrying every ${everyMs}ms for up to ${tries} attempts`);
      log("  (this is expected on a cold --all bring-up: the six issuers are still deploying)");
    }
    if (attempt === tries) {
      log(`GIVING UP after ${tries} attempts: ${tokens.error ?? "no error"}`);
      log("  every token action will report it. Is the faucet profile up? ./up.sh --with faucet");
      return;
    }
    await new Promise((r) => setTimeout(r, everyMs + Math.floor(Math.random() * 1000)));
  }
};
void resolveTokensWithRetry();

// The bridged colours are independent of the faucet registry: they resolve as soon as the
// EVM endpoint answers, and the kernel registration is retried until it lands (the kernel
// comes up after the console on a cold `--all` bring-up). Both are cheap reads; the interval
// is long because an ERC20's symbol and decimals never change.
const BRIDGE_REFRESH_MS = Number(process.env["AA_BRIDGE_REFRESH_MS"] ?? 60_000);
void (async () => {
  for (;;) {
    await resolveBridgedTokens().catch(() => {});
    await registerBridgedColours().catch(() => {});
    await new Promise((r) => setTimeout(r, BRIDGE_REFRESH_MS));
  }
})();

await checkWallet("relay");
await checkWallet("taker");
