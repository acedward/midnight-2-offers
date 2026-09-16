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

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as Rx from "rxjs";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { nodeZkConfigRegistry } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
} from "@midnightntwrk/wallet-sdk-address-format";

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
  bytes32,
  coinPublicKeyBytes,
  consoleAccountCircuits,
  consoleCompiledAccount,
  consoleWaves,
  createWallet,
  hexToBytes,
  managedPath,
  openWallet,
  providersFor,
  randomBytes32,
  readArtifact,
  toHex,
  userAddressBytes,
  zkConfigPath,
} from "./passport.ts";
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
  authorise,
  evmChallengeFor,
  evmTypedMessage,
  type AuthRequest,
  type CallContext,
} from "../passport/src/wallet/signer.js";
import { buildTypedData, computeDigest } from "../passport/src/wallet/eip712.js";
import { generateEncKeyPair } from "../passport/src/wallet/inbox.js";
import { depositAsThirdParty, inboxWalkPortable } from "../passport/src/wallet/deposit.js";
import { candidateIndices } from "../passport/src/wallet/capture.js";
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
const DEV_ADDR = `0x${DEV_DEVICE.addressHex}`;

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
    tokens.list = list;
    tokens.registryRevision = doc.registryRevision ?? doc.revision ?? null;
    tokens.error = null;
    log(`tokens resolved from ${url}: ` +
      list.map((t) => `${t.name}=${t.color.slice(0, 8)}…/${t.decimals}d`).join(" "));
  } catch (e) {
    tokens.error = e instanceof Error ? e.message : String(e);
    log(`token resolution FAILED (faucet profile down?): ${tokens.error} — token ops will error until it succeeds`);
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
  if (!token.issuer) throw new Error(`${token.name}: the registry carries no issuer address (${tokens.error ?? "?"})`);
  const name = MTT_MODULE[token.family];
  const zkPath = resolve("/aa", name, "src", "managed");
  const Mod: any = await import(resolve(zkPath, "contract", "index.js"));
  const compiled = CompiledContract.make(name, Mod.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkPath),
  );
  const providers: any = await providersFor(walletCtx, zkPath);
  // …and back to the PLAIN server for this one contract.
  providers.proofProvider = httpClientProofProvider(
    WALLET_PROOF_SERVER,
    await nodeZkConfigRegistry(managedPath),
  );
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
    out.push({
      accountId: rec.address,
      address: rec.address,
      owner: `0x${rec.owner}`,
      registeredAt: rec.registeredAt,
      liveOffer: rec.liveOffer ?? null,
      shielded,
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
    const useCounter = await account.resolveUseCounter(EvmDevice.fromPublicPointless?.(owner) ?? deviceForRead(owner));
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

/** A device object good enough for a ledger READ (entry derivation binds the address only). */
function deviceForRead(owner: string): EvmDevice {
  return EvmDevice.fromBackend({
    address: hexToBytes(owner),
    async signTypedData() { throw new Error("read-only device"); },
  } as any);
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
    const { recoverPoint, parseSignature, lowS, eip191Digest, ethereumAddress } =
      await import("../passport/src/wallet/signer.js") as any;
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
        jlog(j, `the spend returned ${change.value} of change — capturing it and sealing its inbox entry`);
        next = await captureCoin(next, j.txId!, change, j);
        // The change coin's description is NOT on chain: the circuit returns it and the
        // owner appends the entry itself, which is a second gated call. Without it the
        // coin is invisible to anyone rebuilding the store from chain data alone (S3).
        const { sealInboxEntry } = await import("../passport/src/wallet/inbox.js");
        const entry = sealInboxEntry(hexToBytes(next.encPublicKey), change);
        const account2 = await connectAccount(walletCtx, next);
        const ctx2 = await account2.callContext();
        const counter2 = await account2.resolveUseCounter(deviceForRead(prep.owner));
        jlog(j, "the change entry needs a second signature — the console cannot sign for you, so it is queued for the page");
        j.data = { ...(j.data as any ?? {}), pendingChangeEntry: { entry: toHex(entry), authNonce: String(ctx2.authNonce), useCounter: String(counter2) } };
        void account2;
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
    writeRecord({
      ...record,
      liveOffer: {
        offerId: built.sha256,
        give: `${offerSpec.call.giveAmount} ${offerSpec.giveToken}`,
        want: `${offerSpec.call.want.value} ${offerSpec.wantToken}`,
        createdAt: new Date().toISOString(),
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
          clearLiveOffer(offerId);
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

function clearLiveOffer(offerId: string): void {
  const store = readStore();
  const rec = store.accounts.find((a) => a.liveOffer?.offerId === offerId);
  if (rec) writeRecord({ ...rec, liveOffer: null });
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
          })),
          tokensError: tokens.error,
          tokensSource: "mint-test-tokens",
          tokensRegistryRevision: tokens.registryRevision,
          kernelUrl: KERNEL_URL,
          solverFrontendUrl: SOLVER_FRONTEND_PUBLIC_URL,
          faucetUrl: `${FAUCET_PUBLIC_URL.replace(/\/+$/, "")}/?network=${NETWORK_KEY}`,
          devSigner: DEV_SIGNER ? { address: DEV_ADDR } : null,
          // The bridge tab is only meaningful when the image carries the bridge circuits.
          bridge: BUILD.withBridge ? { available: true, vault: artifact?.vault ?? null } : { available: false },
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
        if (prep.owner !== DEV_DEVICE.addressHex) {
          return bad(`dev signer is ${DEV_ADDR}; the prepared action's owner is 0x${prep.owner}`);
        }
        const { serializeSignature, signDigest, eip191Digest } =
          await import("../passport/src/wallet/signer.js") as any;
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
await checkWallet("relay");
await checkWallet("taker");
