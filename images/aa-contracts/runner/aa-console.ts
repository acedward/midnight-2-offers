// aa-console.ts — the AA web console's relay service (compose service `aa-console`):
//
//   browser EVM wallet (EIP-1193, signs EIP-712 only) → THIS relay (builds the
//   payload, recovers the signer's secp256k1 point, proves through the compose
//   aa-proof-server, submits, pays fees) → AA Manager `execute` → Midnight.
//
// The browser deliberately holds NO Midnight wallet and NO prover: it signs
// `eth_signTypedData_v4` requests this server builds with the AA repo's own
// codec (/aa/aalib — the digest scheme is never reimplemented), and everything
// Midnight-side happens here, where the k=19 proof (~2 min, 1.14 GB key upload
// per call) and the wallet machinery belong. `execute(payload, sig, pk)` needs
// the signer's PUBLIC KEY, which no EVM wallet exposes — aalib's `recoverSigner`
// recovers the affine point from the signature, which is the whole reason a
// relay (not the page) talks to the contract.
//
// Session machinery is lifted from aa-e2e.ts (the proven path) and follows the
// same three measured rules from the master plan's T7.5: deadlines now+1800 s,
// ONE FACADE PER TRANSACTION (a single-worker job queue enforces it), and a
// SHIELDED-FREE relay wallet (fund with scripts/fund-wallet.sh — unshielded
// NIGHT + DUST only; up.sh does this when the profile comes up).
//
// Needs the unpruned image variant (AA_PRUNE_MANAGER_PROVERS=0): every operation
// but fund/deposit proves the Manager's k=19 `execute` circuit.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as Rx from "rxjs";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  buildWalletFacade,
  buildWalletAndWaitForFunds,
  registerNightForDust,
  configureMidnightNodeProviders,
} from "@effectstream/midnight-contracts";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";

import { deriveAccountId, buildEthSignTypedDataV4Request, computeDigest } from "/aa/aalib/codec.js";
import { prepareEvmExecute } from "/aa/aalib/manager.js";
import { recoverSigner, addressForPrivateKey } from "/aa/aalib/signature.js";
import { metamaskSign } from "/aa/aalib/metamask.js";
import type { Hex20, Hex32 } from "/aa/aalib/bytes.js";
import { buildOpenSwapOffer } from "/aa/runner/aa-offer.ts";

const TAG = "[aa-console]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
(globalThis as any).WebSocket = WebSocket;

const AA_ROOT = "/aa";
const PORT = Number(process.env["AA_CONSOLE_PORT"] ?? 8090);
const WALLET_PROOF = process.env["AA_WALLET_PROOF_SERVER_URL"] ?? "http://proof-server:6300";
const RELAY_SEED = process.env["AA_CONSOLE_SEED"]
  ?? "aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0";
const DEV_SIGNER = /^(1|true|yes)$/i.test(process.env["AA_CONSOLE_DEV_SIGNER"] ?? "");
// A throwaway dev key for the env-gated built-in signer (automated verification
// without a wallet extension). Public by design, like every seed in this repo.
const DEV_KEY = ("0x" + "c0de".padStart(64, "d")) as Hex32;
const DEV_ADDR = addressForPrivateKey(DEV_KEY) as Hex20;

// The offer-files kernel (profile `offerfiles`), feature-detected: the swap
// panel publishes there and degrades gracefully when the profile is down.
const KERNEL_URL = process.env["AA_KERNEL_URL"] ?? "http://kernel:9999";
// The cow-solver sink (profile `solver`), feature-detected: the page's solver
// view reads its snapshot/stream through same-origin proxies here.
const SINK_URL = process.env["AA_SINK_URL"] ?? "http://solver-sink:8080";
// Shielded funding runs on the aa-deploy wallet (genesis-3): prefunded, and it
// already holds the shielded colour minted at bring-up. The RELAY wallet stays
// shielded-free (T7.5 rule) — that is the entire reason for the second seed.
const FUNDER_SEED = process.env["MIDNIGHT_WALLET_SEED"]
  ?? "0000000000000000000000000000000000000000000000000000000000000003";
// Shielded NIGHT — the native colour — is the demo want-leg: any wallet can get
// it from the faucet (fund-wallet.sh --shielded-amount), no second minter needed.
const NIGHT_COLOR_HEX = "0".repeat(64);
// The TAKER wallet (T9.4/Q14): settles book offers as "a different wallet" —
// deliberately distinct from the relay so maker account, relay, and taker are
// three visible parties. Funded by up.sh WITH --shielded-amount (the want leg
// is shielded NIGHT). `aa-taker` in wallets/wallets.json.
const TAKER_SEED = process.env["AA_TAKER_SEED"]
  ?? "7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e";

const ARTIFACT_PATH = "/aa/out/aa-contracts.json";
const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf-8"));
const MANAGER = artifact.manager.address as string;
const MINTER = artifact.minter.address as string;
const COLOUR_HEX = artifact.mints.unshielded.color as string;

const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h: string): Uint8Array => {
  const c = h.replace(/^0x/, "");
  return new Uint8Array(c.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
};
const manager32 = (`0x` + MANAGER.replace(/^0x/, "").slice(0, 64)) as Hex32;
const COLOUR = hexToBytes(COLOUR_HEX);
const SHIELDED_COLOR_HEX = (artifact.mints.shielded.color as string).replace(/^0x/, "");

const artifactDomain = (): Hex32 => {
  const b = new TextEncoder().encode(artifact.manager.domain);
  const o = new Uint8Array(32);
  o.set(b);
  return ("0x" + toHex(o)) as Hex32;
};

const DEV_OWNER_SECRET = (() => {
  const b = new TextEncoder().encode("demo-infra:aa:dev-owner-secret");
  const o = new Uint8Array(32);
  o.set(b);
  return o;
})();
const managerWitnesses = {
  localOwnerSecret: ({ privateState }: { privateState: unknown }) => [privateState, DEV_OWNER_SECRET],
};

const loadContract = async (name: string) =>
  await import(resolve(AA_ROOT, name, "src", "managed", "contract", "index.js"));

// ── wallet sessions (one facade per transaction — T7.5 rule) ─────────────────

async function session<T>(
  label: string,
  fn: (walletResult: any) => Promise<T>,
  opts: { requireFunds?: boolean; seed?: string } = {},
): Promise<T> {
  const requireFunds = opts.requireFunds ?? true;
  const walletResult = await buildWalletFacade(
    {
      id: midnightNetworkConfig.id,
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: WALLET_PROOF,
    } as any,
    opts.seed ?? RELAY_SEED,
    midnightNetworkConfig.id as any,
  );
  const wallet = walletResult.wallet as any;
  try {
    await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.filter((st: any) => {
          const synced = st.isSynced ?? false;
          const sh = st.shielded?.state?.progress?.isStrictlyComplete?.() ?? synced;
          const un = st.unshielded?.progress?.isStrictlyComplete?.() ?? synced;
          if (!(sh && un)) return false;
          if (!requireFunds) return true;
          return unshieldedTotal(st) > 0n;
        }),
        Rx.timeout({
          each: 180_000,
          with: () => Rx.throwError(() => new Error(
            `${label}: wallet sync timeout` + (requireFunds ? " (relay wallet unfunded? run scripts/fund-wallet.sh with the aa-console seed)" : ""),
          )),
        }),
      ),
    );
    if (requireFunds) {
      try { await registerNightForDust(walletResult as any); } catch { /* already registered */ }
    }
    return await fn(walletResult);
  } finally {
    await wallet.stop?.().catch(() => {});
  }
}

const unshieldedTotal = (st: any): bigint => {
  const bal = st.unshielded?.balances;
  if (!bal) return 0n;
  const vals = bal instanceof Map ? [...bal.values()] : Object.values(bal);
  return vals.reduce((a: bigint, v: any) => a + (v ?? 0n), 0n);
};

async function join(walletResult: any, name: string, address: string, witnesses: any, stateId: string) {
  const Mod = await loadContract(name);
  const zkPath = resolve(AA_ROOT, name, "src", "managed");
  const compiled = CompiledContract.make(name, Mod.Contract as any).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(zkPath),
  );
  const providers = (await configureMidnightNodeProviders(
    walletResult.wallet,
    walletResult.zswapSecretKeys,
    walletResult.walletZswapSecretKeys,
    walletResult.dustSecretKey,
    walletResult.walletDustSecretKey,
    {
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: midnightNetworkConfig.proofServer,
    },
    `${stateId}-store`,
    zkPath,
    walletResult.unshieldedKeystore,
  )) as any;
  const handle = await findDeployedContract(providers, {
    contractAddress: address,
    compiledContract: compiled as any,
    privateStateId: stateId,
    initialPrivateState: {},
  });
  return { Mod, handle, providers, compiled };
}

// ── walletless ledger reads (straight from the indexer) ──────────────────────

const publicData = indexerPublicDataProvider(
  midnightNetworkConfig.indexer,
  midnightNetworkConfig.indexerWS,
);
let managerMod: any = null;

async function readLedger() {
  managerMod ??= await loadContract("contract-manager");
  const state = await (publicData as any).queryContractState(MANAGER);
  if (!state) throw new Error("manager contract state not found via indexer");
  return { ledger: managerMod.ledger(state.data), Mod: managerMod };
}

async function listAccounts() {
  const { ledger, Mod } = await readLedger();
  const out: Array<Record<string, unknown>> = [];
  const shColour = hexToBytes(SHIELDED_COLOR_HEX);
  for (const [id, owner] of ledger.evmOwners) {
    const key = Mod.pureCircuits.unshieldedKey(id, COLOUR);
    const shKey = Mod.pureCircuits.shieldedKey(id, shColour);
    out.push({
      accountId: "0x" + toHex(id),
      owner: "0x" + toHex(owner),
      nonce: String(ledger.evmNonces.member(id) ? ledger.evmNonces.lookup(id) : 0n),
      balance: String(ledger.unshieldedBalances.member(key) ? ledger.unshieldedBalances.lookup(key) : 0n),
      shieldedBalance: String(ledger.shieldedBalances.member(shKey) ? ledger.shieldedBalances.lookup(shKey) : 0n),
    });
  }
  return out;
}

async function nextNonce(accountId: Hex32): Promise<bigint> {
  const { ledger } = await readLedger();
  const id = hexToBytes(accountId);
  return ledger.evmNonces.member(id) ? ledger.evmNonces.lookup(id) : 0n;
}

// ── relay wallet status (checked at startup and after every job) ─────────────

const relay = {
  address: null as string | null,
  userAddress: null as string | null, // 32-byte hex, the deposit/withdraw target form
  balance: "0",
  funded: false,
  checkedAt: null as string | null,
  error: null as string | null,
};

const taker = {
  address: null as string | null,
  balance: "0",
  funded: false,
  checkedAt: null as string | null,
  error: null as string | null,
};

async function checkTakerWallet() {
  try {
    await session("taker-check", async (walletResult) => {
      const st = await Rx.firstValueFrom((walletResult.wallet as any).state());
      taker.address = walletResult.unshieldedAddress;
      taker.balance = String(unshieldedTotal(st));
      // Unshielded NIGHT is the funding proxy: up.sh funds this seed with
      // NIGHT + DUST + shielded NIGHT in one fund-wallet.sh run, so a nonzero
      // unshielded balance implies the whole set arrived.
      taker.funded = unshieldedTotal(st) > 0n;
      taker.error = null;
    }, { requireFunds: false, seed: TAKER_SEED });
  } catch (e) {
    taker.error = e instanceof Error ? e.message : String(e);
  }
  taker.checkedAt = new Date().toISOString();
  log(`taker wallet: funded=${taker.funded} balance=${taker.balance}${taker.error ? ` error=${taker.error}` : ""}`);
}

/** T9.4 — settle a live book offer with the TAKER wallet (the Phase-9-proven
 * path: fetch blob by offerId, balance, finalize, submit; the kernel's own
 * nullifier fill-markers then flip the book row to `consumed`). */
function takeJob(offerId: string): Job {
  return enqueue("take", async (j) => {
    jlog(j, `fetching offer ${offerId.slice(0, 16)}… from the kernel`);
    const res = await fetch(`${KERNEL_URL}/v1/offers/${offerId}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`kernel: ${res.status} fetching the offer`);
    const detail: any = await res.json();
    const blob = String(detail.offerBech32 ?? "");
    if (!blob.startsWith("swapoffer1")) throw new Error("offer blob missing from the kernel response");
    jlog(j, "building the taker wallet (waits for funds — fund aa-taker if this times out)…");
    const built: any = await buildWalletAndWaitForFunds(
      {
        id: midnightNetworkConfig.id,
        indexer: midnightNetworkConfig.indexer,
        indexerWS: midnightNetworkConfig.indexerWS,
        node: midnightNetworkConfig.node,
        proofServer: WALLET_PROOF,
      } as any,
      TAKER_SEED,
      midnightNetworkConfig.id as any,
    );
    const wallet = built.wallet as any;
    try {
      const keys = { shieldedSecretKeys: built.zswapSecretKeys, dustSecretKey: built.dustSecretKey };
      const offerTx = (Transaction as any).deserialize("signature", "proof", "binding", OfferFiles.decode(blob));
      jlog(j, "balancing the settlement (taker funds the want leg, sweeps the give surplus)…");
      const t0 = Date.now();
      const recipe = await wallet.balanceFinalizedTransaction(offerTx, keys, {
        ttl: new Date(Date.now() + 30 * 60_000),
      });
      const settleTx = await wallet.finalizeRecipe(recipe);
      await wallet.submitTransaction(settleTx);
      j.txId = settleTx.transactionHash?.().toString?.() ?? null;
      jlog(j, `settlement submitted in ${((Date.now() - t0) / 1000).toFixed(0)}s — tx=${j.txId ?? "?"}`);
    } finally {
      await wallet.stop?.().catch(() => {});
    }
    // Confirm on the book — the kernel notices the consumed nullifiers.
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const s: any = await (await fetch(`${KERNEL_URL}/v1/offers/${offerId}/status`)).json();
        if (s.status === "consumed") { jlog(j, "book status: CONSUMED — settlement confirmed"); return; }
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

async function checkRelayWallet() {
  try {
    await session("wallet-check", async (walletResult) => {
      const st = await Rx.firstValueFrom((walletResult.wallet as any).state());
      relay.address = walletResult.unshieldedAddress;
      const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
      relay.userAddress = toHex(Uint8Array.prototype.slice.call(parsed.data, 0, 32));
      relay.balance = String(unshieldedTotal(st));
      relay.funded = unshieldedTotal(st) > 0n;
      relay.error = null;
    }, { requireFunds: false });
  } catch (e) {
    relay.error = e instanceof Error ? e.message : String(e);
  }
  relay.checkedAt = new Date().toISOString();
  log(`relay wallet: funded=${relay.funded} balance=${relay.balance}${relay.error ? ` error=${relay.error}` : ""}`);
}

// ── prepared actions (built here, signed in the browser) ─────────────────────

type Prepared = { action: any; owner: Hex20; kind: string; createdAt: number; summary: Record<string, unknown> };
const prepared = new Map<string, Prepared>();
const PREP_TTL_MS = 30 * 60_000; // the deadline horizon makes older ones useless anyway
const newId = (): string => crypto.randomUUID();

function pruneOld() {
  const now = Date.now();
  for (const [k, v] of prepared) if (now - v.createdAt > PREP_TTL_MS) prepared.delete(k);
}

const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 1800);

async function buildAction(body: any): Promise<{ prep: Prepared; accountId: Hex32 }> {
  const kind = String(body.kind ?? "");
  const owner = String(body.owner ?? "").toLowerCase() as Hex20;
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new Error("owner must be a 0x…20-byte EVM address");
  if (kind === "register") {
    const salt = ("0x" + toHex(crypto.getRandomValues(new Uint8Array(32)))) as Hex32;
    const accountId = deriveAccountId(manager32, owner, salt);
    const action = {
      primaryType: "RegisterEvmAccount", manager: manager32, accountId, owner,
      validUntil: deadline(), accountSalt: salt,
    };
    return { prep: { action, owner, kind, createdAt: Date.now(), summary: { accountId } }, accountId };
  }
  const accountId = String(body.accountId ?? "") as Hex32;
  if (!/^0x[0-9a-f]{64}$/i.test(accountId)) throw new Error("accountId must be 0x…32 bytes");
  const amount = BigInt(body.amount ?? 0);
  if (amount <= 0n) throw new Error("amount must be a positive integer");
  const nonce = await nextNonce(accountId);
  if (kind === "transfer") {
    const toAccountId = String(body.toAccountId ?? "") as Hex32;
    if (!/^0x[0-9a-f]{64}$/i.test(toAccountId)) throw new Error("toAccountId must be 0x…32 bytes");
    const action = {
      primaryType: "TransferInternalUnshielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce, toAccountId,
      color: ("0x" + COLOUR_HEX) as Hex32, amount,
    };
    return { prep: { action, owner, kind, createdAt: Date.now(), summary: { nonce: String(nonce) } }, accountId };
  }
  if (kind === "swap") {
    // Open-shape selector 6 (SHIELDED-ONLY by contract design): give the demo
    // token, want shielded NIGHT — two distinct colours, so the offer's legs
    // survive as a real {+give, −want} pair (same-colour legs would net out and
    // the kernel would reject NOT_A_SWAP). recipientKind 0 = open offer: zero
    // recipient, the give surplus floats for whoever settles.
    const giveAmount = amount;
    const wantAmount = BigInt(body.wantAmount ?? 0);
    if (wantAmount <= 0n) throw new Error("wantAmount must be a positive integer");
    const wantNonce = ("0x" + toHex(crypto.getRandomValues(new Uint8Array(32)))) as Hex32;
    const action = {
      primaryType: "OpenSwapShielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce,
      giveColor: ("0x" + SHIELDED_COLOR_HEX) as Hex32, giveAmount,
      recipientKind: 0n, recipient: ("0x" + "0".repeat(64)) as Hex32,
      wantNonce, wantColor: ("0x" + NIGHT_COLOR_HEX) as Hex32, wantAmount,
      creditAccountId: accountId,
    };
    return {
      prep: { action, owner, kind, createdAt: Date.now(),
        summary: { nonce: String(nonce), give: String(giveAmount), want: String(wantAmount), wantNonce } },
      accountId,
    };
  }
  if (kind === "withdraw") {
    // Recipient: an mn_addr… bech32m or a raw 32-byte hex; default = the relay's own address.
    let recipient32: string;
    const r = String(body.recipient ?? "").trim();
    if (r === "") {
      if (!relay.userAddress) throw new Error("relay wallet not checked yet — no default recipient");
      recipient32 = relay.userAddress;
    } else if (/^0x?[0-9a-f]{64}$/i.test(r)) {
      recipient32 = r.replace(/^0x/, "").toLowerCase();
    } else {
      const parsed = MidnightBech32m.parse(r);
      recipient32 = toHex(Uint8Array.prototype.slice.call(parsed.data, 0, 32));
    }
    const action = {
      primaryType: "WithdrawUnshielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce,
      color: ("0x" + COLOUR_HEX) as Hex32, amount,
      recipientKind: 0n, recipient: ("0x" + recipient32) as Hex32,
    };
    return { prep: { action, owner, kind, createdAt: Date.now(), summary: { nonce: String(nonce), recipient: recipient32 } }, accountId };
  }
  throw new Error(`unknown kind '${kind}' (register | transfer | withdraw)`);
}

// ── the job queue (single worker: one facade per transaction, one proof at a time) ──

type Job = {
  id: string; kind: string; state: "queued" | "running" | "done" | "error";
  log: string[]; txId: string | null; error: string | null;
  createdAt: string; run: (j: Job) => Promise<void>;
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

const jlog = (j: Job, line: string) => { j.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`); log(`job ${j.id.slice(0, 8)} ${line}`); };

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

function executeJob(prep: Prepared, signature: string): Job {
  return enqueue(prep.kind, async (j) => {
    jlog(j, `verifying the ${prep.action.primaryType} signature`);
    const { digest } = computeDigest(prep.action, artifactDomain());
    const recovered = recoverSigner(digest, signature, { requireLowS: true });
    if (recovered.address.toLowerCase() !== prep.owner.toLowerCase())
      throw new Error(`recovered signer ${recovered.address} is not the action owner ${prep.owner}`);
    const p = prepareEvmExecute(prep.action, artifactDomain(), signature as `0x${string}`);
    jlog(j, `signer verified (${recovered.address}) — opening a wallet session`);
    await session(prep.kind, async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      jlog(j, "proving execute (k=19 — expect ~2 minutes)…");
      const t0 = Date.now();
      const tx = await (mgr.handle.callTx as any).execute(p.payload, p.signature, p.point);
      j.txId = tx.public?.txId ?? null;
      jlog(j, `landed — tx=${j.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    });
  });
}

/** Selector-6 open swap: prove the execute, NEVER submit — the proven-unbalanced
 * transaction IS the offer; encode MIP-0005 and publish to the kernel. */
function offerJob(prep: Prepared, signature: string): Job {
  return enqueue("swap-offer", async (j) => {
    jlog(j, `verifying the ${prep.action.primaryType} signature`);
    const { digest } = computeDigest(prep.action, artifactDomain());
    const recovered = recoverSigner(digest, signature, { requireLowS: true });
    if (recovered.address.toLowerCase() !== prep.owner.toLowerCase())
      throw new Error(`recovered signer ${recovered.address} is not the action owner ${prep.owner}`);
    const p = prepareEvmExecute(prep.action, artifactDomain(), signature as `0x${string}`);
    const built = await session("swap-offer", async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      return await buildOpenSwapOffer({
        providers: mgr.providers,
        compiledContract: mgr.compiled,
        managerAddress: MANAGER,
        args: [p.payload, p.signature, p.point],
        giveColorHex: SHIELDED_COLOR_HEX,
        giveAmount: prep.action.giveAmount as bigint,
        wantColorHex: NIGHT_COLOR_HEX,
        wantAmount: prep.action.wantAmount as bigint,
        log: (line) => jlog(j, line),
      });
    }, { requireFunds: false }); // the maker contributes no coins and pays no fees
    // Persist the blob BEFORE publishing — it is the product of two minutes of
    // proving, and it stays reproducible (settle-by-blob, kernel re-post) even
    // when the kernel rejects or is down.
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync("/aa/out/offers", { recursive: true });
      writeFileSync(`/aa/out/offers/${built.sha256}.swapoffer`, built.blob + "\n");
      jlog(j, `blob saved: /aa/out/offers/${built.sha256}.swapoffer`);
    } catch (e) {
      jlog(j, `blob save failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
    }
    jlog(j, `publishing to the offer-files kernel (${KERNEL_URL})…`);
    let res: Response;
    try {
      res = await fetch(`${KERNEL_URL}/v1/offers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer: built.blob }),
      });
    } catch (e) {
      throw new Error(
        `offer PROVEN (sha256 ${built.sha256.slice(0, 16)}…) but the kernel is unreachable at ${KERNEL_URL} — ` +
        `bring the offerfiles profile up (./up.sh --with offerfiles) and retry. ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`kernel rejected the offer (${res.status}): ${JSON.stringify(out).slice(0, 300)}`);
    }
    j.txId = out.offerId ?? built.sha256;
    jlog(j, `PUBLISHED — offerId=${j.txId} (${built.bytes} bytes); track: GET ${KERNEL_URL}/v1/offers/${j.txId}/status`);
  });
}

/** Shielded funding runs on the FUNDER (genesis-3) wallet so the relay stays
 * shielded-free: mint the demo token's shielded colour, then deposit it into
 * the account's shielded Manager balance (what an open swap's give leg spends). */
function fundShieldedJob(accountId: Hex32, amount: bigint): Job {
  return enqueue("fund-shielded", async (j) => {
    await session("fund-shielded-mint", async (walletResult) => {
      const mnt = await join(walletResult, "contract-minter", MINTER, {}, "aaMinterPrivateState");
      const coinPk = hexToBytes(String(walletResult.zswapSecretKeys.coinPublicKey));
      jlog(j, `minting ${amount} SHIELDED to the funding wallet…`);
      const tx = await (mnt.handle.callTx as any).mintShieldedTo(
        amount,
        crypto.getRandomValues(new Uint8Array(32)),
        { is_left: true, left: { bytes: coinPk }, right: { bytes: new Uint8Array(32) } },
      );
      jlog(j, `minted — tx=${tx.public?.txId ?? "?"}`);
    }, { seed: FUNDER_SEED });
    await session("fund-shielded-deposit", async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      jlog(j, `depositShielded(${amount}) → ${accountId.slice(0, 18)}…`);
      const coin = {
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        color: hexToBytes(SHIELDED_COLOR_HEX),
        value: amount,
      };
      const tx = await (mgr.handle.callTx as any).depositShielded(coin, hexToBytes(accountId));
      j.txId = tx.public?.txId ?? null;
      jlog(j, `deposited — tx=${j.txId ?? "?"}`);
    }, { seed: FUNDER_SEED });
  });
}

function fundJob(accountId: Hex32, amount: bigint): Job {
  return enqueue("fund", async (j) => {
    await session("fund-mint", async (walletResult) => {
      const mnt = await join(walletResult, "contract-minter", MINTER, {}, "aaMinterPrivateState");
      const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
      const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
      jlog(j, `minting ${amount} to the relay wallet…`);
      const tx = await (mnt.handle.callTx as any).mintUnshieldedTo(amount, {
        is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: userAddr },
      });
      jlog(j, `minted — tx=${tx.public?.txId ?? "?"}`);
    });
    await session("fund-deposit", async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      jlog(j, `depositUnshielded(${amount}) → ${accountId.slice(0, 18)}…`);
      const tx = await (mgr.handle.callTx as any).depositUnshielded(COLOUR, amount, hexToBytes(accountId));
      j.txId = tx.public?.txId ?? null;
      jlog(j, `deposited — tx=${j.txId ?? "?"}`);
    });
  });
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
// no-store: this is a dev console that redeploys often — stale cached JS has
// already cost one confused verification pass.
const staticFile = (name: string, type: string) =>
  new Response(Bun.file(resolve(STATIC_DIR, name)), {
    headers: { "content-type": type, "cache-control": "no-store" },
  });

// ── infrastructure status (the page's Infrastructure view) ───────────────────
// Every probe runs over the COMPOSE network with a short timeout. A service
// whose DNS name does not resolve is a profile that is not up → "absent";
// a resolvable name that refuses/errors is "down".
type ProbeResult = { status: "up" | "down" | "absent"; info?: unknown };
async function probe(fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    return { status: "up", info: await fn() };
  } catch (e) {
    const m = e instanceof Error ? `${e.message} ${(e as any).code ?? ""}` : String(e);
    // ConnectionRefused = the name resolved but nothing is listening → DOWN
    // (a container exists and is broken/booting). Only a name that does not
    // resolve at all means the profile is not up → ABSENT.
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
// The nix-based proof-server images answer nothing useful at "/" — any HTTP
// response at all (even 404) proves the service is listening.
const fetchAlive = async (url: string, ms = 3000) => {
  const r = await fetch(url, { signal: T(ms) }).catch((e) => {
    // A refused/failed connection throws; an HTTP error status does not.
    throw e;
  });
  return { httpStatus: r.status };
};

async function infraStatus() {
  const rpc = (method: string) =>
    fetchJson("http://node:9944", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });
  const [node, indexer, proofServer, aaProofServer, kernel, kernelSync, batcher, celestia, evmRpc, frontend, sink] =
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
      probe(async () => (await fetchJson("http://kernel:3334/health")) as any),
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
    ]);
  // The solver has no HTTP surface of its own — its liveness is what the sink
  // sees on the authenticated relay socket.
  const solver: ProbeResult =
    sink.status !== "up"
      ? { status: "absent", info: "sink not up — no visibility" }
      : (sink.info as any).solverConnected
        ? { status: "up", info: { via: "sink relay socket" } }
        : { status: "down", info: "sink up, no solver connected" };
  return {
    at: new Date().toISOString(),
    components: {
      console: { status: "up", info: { relayFunded: relay.funded, takerFunded: taker.funded, jobsQueued: queue.length } },
      node, indexer, proofServer, aaProofServer,
      kernel, kernelSync, batcher, celestia,
      evmRpc, frontend, solverSink: sink, solver,
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
      // Any other flat file in /aa/console by extension (no subdirs, no dotfiles).
      if (/^\/[A-Za-z0-9_.-]+\.(html|js|css|svg)$/.test(path)) {
        const ext = path.slice(path.lastIndexOf("."));
        const f = Bun.file(resolve(STATIC_DIR, path.slice(1)));
        if (await f.exists()) {
          return new Response(f, { headers: { "content-type": STATIC_TYPES[ext], "cache-control": "no-store" } });
        }
        return bad("not found", 404);
      }
      if (path === "/api/infra") return json(await infraStatus());
      if (path === "/api/solver/snapshot") {
        try {
          return json({ sink: true, snapshot: await fetchJson(`${SINK_URL}/api/snapshot`, {}, 5000) });
        } catch {
          return json({ sink: false, snapshot: null });
        }
      }
      if (path === "/api/solver/stream") {
        // Pass-through SSE proxy so the browser stays same-origin. No abort
        // signal here — a timeout signal would kill the LONG-LIVED stream, not
        // just the connect; connection failures throw fast on their own.
        try {
          const upstream = await fetch(`${SINK_URL}/api/stream`);
          return new Response(upstream.body, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        } catch {
          return bad("solver sink unreachable (start the solver profile)", 503);
        }
      }
      if (path === "/healthz") {
        return json({ ok: true, relay, taker, jobsQueued: queue.length, deployed: existsSync(ARTIFACT_PATH) });
      }
      if (path === "/api/info") {
        return json({
          network: midnightNetworkConfig.id,
          manager: MANAGER, minter: MINTER, domain: artifact.manager.domain,
          color: COLOUR_HEX, minterTag: artifact.minter.tag ?? null,
          relay,
          taker,
          swap: {
            giveColor: SHIELDED_COLOR_HEX,
            wantColor: NIGHT_COLOR_HEX,
            note: "open swap gives the demo token's SHIELDED colour and wants shielded NIGHT; fund the shielded balance first",
          },
          kernelUrl: KERNEL_URL,
          devSigner: DEV_SIGNER ? { address: DEV_ADDR } : null,
          withdrawKnownIssue:
            "withdraw currently lands a node rejection (Custom error 214 — recipient Either arm " +
            "inversion in manager.compact, fix in flight upstream); the console submits it anyway " +
            "and reports the node's verdict.",
        });
      }
      if (path === "/api/accounts") return json({ accounts: await listAccounts() });
      if (path === "/api/prepare" && req.method === "POST") {
        pruneOld();
        const body = await req.json();
        const { prep } = await buildAction(body);
        const id = newId();
        prepared.set(id, prep);
        return json({
          prepId: id,
          request: buildEthSignTypedDataV4Request(prep.action, artifactDomain()),
          action: prep.action,
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
        const job = prep.kind === "swap" ? offerJob(prep, signature) : executeJob(prep, signature);
        return json({ jobId: job.id });
      }
      if (path === "/api/take" && req.method === "POST") {
        const body = await req.json();
        const offerId = String(body.offerId ?? "");
        if (!/^[0-9a-f]{64}$/i.test(offerId)) return bad("offerId must be 64 hex chars");
        const job = takeJob(offerId);
        return json({ jobId: job.id });
      }
      if (path === "/api/fund-shielded" && req.method === "POST") {
        const body = await req.json();
        const accountId = String(body.accountId ?? "") as Hex32;
        if (!/^0x[0-9a-f]{64}$/i.test(accountId)) return bad("accountId must be 0x…32 bytes");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const job = fundShieldedJob(accountId, amount);
        return json({ jobId: job.id });
      }
      if (path === "/api/offers") {
        // Thin proxy over the kernel book, feature-detected — the page's swap
        // panel degrades gracefully when the offerfiles profile is down.
        try {
          const res = await fetch(`${KERNEL_URL}/v1/offers?limit=20`, { signal: AbortSignal.timeout(5000) });
          return json({ kernel: true, book: await res.json() });
        } catch {
          return json({ kernel: false, book: null });
        }
      }
      if (path === "/api/fund" && req.method === "POST") {
        const body = await req.json();
        const accountId = String(body.accountId ?? "") as Hex32;
        if (!/^0x[0-9a-f]{64}$/i.test(accountId)) return bad("accountId must be 0x…32 bytes");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const job = fundJob(accountId, amount);
        return json({ jobId: job.id });
      }
      if (path === "/api/dev-sign" && req.method === "POST") {
        if (!DEV_SIGNER) return bad("dev signer is disabled (set AA_CONSOLE_DEV_SIGNER=1)", 403);
        const body = await req.json();
        const prep = prepared.get(String(body.prepId ?? ""));
        if (!prep) return bad("unknown or expired prepId — prepare again");
        if (prep.owner.toLowerCase() !== DEV_ADDR.toLowerCase())
          return bad(`dev signer is ${DEV_ADDR}; the prepared action's owner is ${prep.owner}`);
        return json({ signature: metamaskSign(DEV_KEY, prep.action, artifactDomain()), address: DEV_ADDR });
      }
      if (path.startsWith("/api/jobs/")) {
        const job = jobs.get(path.slice("/api/jobs/".length));
        if (!job) return bad("unknown job", 404);
        const { run: _run, ...view } = job;
        return json(view);
      }
      if (path === "/api/wallet/refresh" && req.method === "POST") {
        await checkRelayWallet();
        await checkTakerWallet();
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

setNetworkId(midnightNetworkConfig.id as any);
log(`serving on :${PORT} — manager=${MANAGER.slice(0, 16)}… minter=${MINTER.slice(0, 16)}…`);
if (DEV_SIGNER) log(`dev signer ENABLED — address ${DEV_ADDR} (testing only)`);
await checkRelayWallet();
await checkTakerWallet();
