// aa-console.ts — the AA web console's relay service (compose service `aa-console`):
//
//   browser EVM wallet (EIP-1193, signs EIP-712 only) → THIS relay (builds the
//   payload, recovers the signer's secp256k1 point, proves through the compose
//   aa-proof-server, submits, pays fees) → AA Manager `execute` → Midnight.
//
// The browser deliberately holds NO Midnight wallet and NO prover: it signs
// `eth_signTypedData_v4` requests this server builds with the AA repo's own
// codec (/aa/aalib — the digest scheme is never reimplemented), and everything
// Midnight-side happens here, where the `execute` proof (MinoCrab k=18 by default,
// a 544 MiB key upload per call; compactc k=19 and 1.14 GB with
// AA_ZKIR_SOURCE=compactc) and the wallet machinery belong. `execute(payload, sig, pk)` needs
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
// but fund/deposit proves the Manager's `execute` circuit HERE, reading the proving
// key out of this image — which is exactly why the image must carry it. Which
// artifact that is, and its k, is read off the image at start-up (zkir-source.ts)
// and printed on every job rather than written into a comment that can go stale.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as Rx from "rxjs";
import { findDeployedContract, createUnprovenCallTx } from "@midnight-ntwrk/midnight-js-contracts";
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
import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

import { deriveAccountId, buildEthSignTypedDataV4Request, computeDigest } from "/aa/aalib/codec.js";
import { prepareEvmExecute } from "/aa/aalib/manager.js";
import { recoverSigner, addressForPrivateKey } from "/aa/aalib/signature.js";
import { metamaskSign } from "/aa/aalib/metamask.js";
import type { Hex20, Hex32 } from "/aa/aalib/bytes.js";
import { buildOpenSwapOffer } from "/aa/runner/aa-offer.ts";
import { rawTokenType } from "@midnight-ntwrk/compact-runtime";
import { zkirSourceReceipt, zkirSourceLine } from "/aa/runner/zkir-source.ts";
import { shieldedUserRecipient, unshieldedUserRecipient } from "/aa/runner/mint-recipient.ts";

const TAG = "[aa-console]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
(globalThis as any).WebSocket = WebSocket;

const AA_ROOT = "/aa";
// Read ONCE at start-up: the answer is a property of the image and cannot change
// while this process runs, and a deposit's log line must not depend on a file read
// succeeding mid-proof.
const ZKIR_SOURCE = zkirSourceReceipt(AA_ROOT);
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
// The cow-solver sink (profile `solver`), feature-detected. INTERNAL ONLY: it
// publishes nothing to the host since its feed page was retired, so this
// compose-network URL is the only way to reach it and the only reader here is
// the infra probe below. Nothing is proxied to the browser any more.
const SINK_URL = process.env["AA_SINK_URL"] ?? "http://solver-sink:8080";
// The COW solver's read-only MONITOR SITE, as the BROWSER must reach it — a
// HOST url, because the console embeds it in an iframe and a compose hostname
// would resolve to nothing. This is the one page about the solver.
const SOLVER_FRONTEND_PUBLIC_URL =
  process.env["AA_SOLVER_FRONTEND_PUBLIC_URL"] ?? "http://127.0.0.1:10802";
// …and as THIS PROCESS reaches it, over the compose network, for the infra probe.
const SOLVER_FRONTEND_URL = process.env["AA_SOLVER_FRONTEND_URL"] ?? "http://solver-frontend:8080";
// The solver's own status listener. Never published to the host: /status/* is
// the solver's entire internal state and is bearer-gated. The console probes
// only GET /health, which is OPEN by design and carries no internal data — so
// the console needs no bearer and is given none.
const SOLVER_STATUS_URL = process.env["AA_SOLVER_STATUS_URL"] ?? "http://solver:9100";
// The offer poster's own read-only surface.
const OFFER_POSTER_URL = process.env["AA_OFFER_POSTER_URL"] ?? "http://offer-poster:9977";
// Shielded funding runs on the aa-deploy wallet (genesis-3): prefunded, and it
// already holds the shielded colour minted at bring-up. The RELAY wallet stays
// shielded-free (T7.5 rule) — that is the entire reason for the second seed.
const FUNDER_SEED = process.env["MIDNIGHT_WALLET_SEED"]
  ?? "0000000000000000000000000000000000000000000000000000000000000003";
// ── THE UNIFIED TOKEN SET (user direction 2026-08-26; derivation unified 00010)
// The demo's tokens are the ones the OFFER-FILES contract mints — the same
// colours the kernel's own faucet creates — used for every shielded/unshielded
// flow here. The console-private AA Minter token and the shielded-NIGHT
// want-leg workaround are RETIRED (shielded NIGHT is not a real mintable token).
// colour = rawTokenType(domainSep, offerFilesContractAddress), resolved at
// startup from the kernel's /v1/midnight/config; names are registered in the
// kernel's dev token registry so every UI shows the same wBTC/wETH/wUSD.
//
// THE DOMAIN SEPARATOR IS THE FAUCET'S, NOT THIS FILE'S (00010 Q11). It used to
// be 32 bytes of 0xa1 / 0xb2 / 0xc3 — a console-private derivation. Nothing
// else in the world produced those colours, so:
//   * the offer poster (kernel `deploy/scripts/offer-poster.ts`), which derives
//     WBTC as `rawTokenType(domainSepFromName("WBTC"), addr)`, minted a
//     DIFFERENT colour under the SAME name. `known_tokens.name` is UNIQUE, so
//     one of the two registrations lost with 409 and that side's leg quoted
//     UNPRICED — and the two "WBTC" markets on one contract were disjoint, so a
//     console taker could never take a poster offer.
//   * the kernel's price map (`DEFAULT_NAME_ASSET_MAP`) prices WBTC as bitcoin
//     and WETH as ethereum BY NAME, which the old colours never reached.
// The derivation below is `domainSepFromName` from the pinned kernel tree's
// `docs/src/wallet/mintable.ts` (the zswap-da faucet's own function), copied
// rather than imported: this console image carries the AA repo's node_modules,
// not the kernel workspace. It is pure and 12 lines; keep it byte-equal.
const FAUCET_PREFIX = "zswap-da-faucet:";
function domainSepFromName(name: string): Uint8Array {
  const out = new Uint8Array(32);
  const enc = new TextEncoder().encode(FAUCET_PREFIX + name);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < 32; i++) {
    h = (h ^ (enc[i % enc.length] ?? i + 7)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    out[i] = h & 0xff;
  }
  return out;
}
// `name` is the display spelling; `faucetName` is what the derivation and the
// registry see (the registry upper-cases, and the faucet's presets are
// upper-case). wUSD is unshielded and is NOT one of the faucet's six presets —
// the derivation is defined for any name, so it stays this stack's own
// unshielded token, just built the same way as the other two.
const TOKEN_DEFS = [
  { name: "wBTC", faucetName: "WBTC", family: "shielded" as const },
  { name: "wETH", faucetName: "WETH", family: "shielded" as const },
  { name: "wUSD", faucetName: "WUSD", family: "unshielded" as const },
];
type TokenInfo = { name: string; family: "shielded" | "unshielded"; sep: Uint8Array; color: string };
const tokens: { list: TokenInfo[]; offerFilesAddress: string | null; error: string | null } = {
  list: [], offerFilesAddress: null, error: null,
};
const tokenByName = (name: string): TokenInfo => {
  const t = tokens.list.find((x) => x.name === name);
  if (!t) throw new Error(`unknown token '${name}' — kernel not reachable at startup? (${tokens.error ?? "no error"})`);
  return t;
};
async function resolveTokens() {
  try {
    const cfg: any = await (await fetch(`${KERNEL_URL}/v1/midnight/config`, { signal: AbortSignal.timeout(5000) })).json();
    const addr = String(cfg.contractAddress).replace(/^0x/, "");
    tokens.offerFilesAddress = addr;
    tokens.list = TOKEN_DEFS.map((d) => {
      const sep = domainSepFromName(d.faucetName);
      return {
        name: d.name, family: d.family, sep,
        color: rawTokenType(sep, addr).toLowerCase(),
      };
    });
    tokens.error = null;
    log(`tokens resolved against offer-files ${addr.slice(0, 12)}…: ` +
      tokens.list.map((t) => `${t.name}=${t.color.slice(0, 8)}…`).join(" "));
    // Best-effort name registration (needs ENABLE_TOKEN_REGISTRY on the kernel).
    for (const t of tokens.list) {
      try {
        await fetch(`${KERNEL_URL}/v1/known-tokens`, {
          method: "POST", headers: { "content-type": "application/json" },
          // `decimals` is STATED, not left to the column default: every token
          // this stack mints is whole coins x 10^6, and a wrong scale is off by
          // a million in every price and sponsorship verdict (kernel 00024).
          body: JSON.stringify({ color: t.color, name: t.name, kind: t.family, decimals: 6 }),
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* registry off or kernel busy — names are cosmetic */ }
    }
  } catch (e) {
    tokens.error = e instanceof Error ? e.message : String(e);
    log(`token resolution FAILED (kernel down?): ${tokens.error} — token ops will error until it succeeds`);
  }
}
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
// (The AA Minter's own TOKA colours in the artifact are RETIRED from this
// console — the unified token set comes from the offer-files contract.)

const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h: string): Uint8Array => {
  const c = h.replace(/^0x/, "");
  return new Uint8Array(c.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
};
const manager32 = (`0x` + MANAGER.replace(/^0x/, "").slice(0, 64)) as Hex32;

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

async function join(walletResult: any, name: string, address: string, witnesses: any, stateId: string,
                    proofServer?: string) {
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
      // The AA contracts prove on the experimental server (zkir-v3 / [v7]
      // keys); the offer-files contract is a plain zkir-v2 / [v6] artifact and
      // proves on the PLAIN server — the caller picks.
      proofServer: proofServer ?? midnightNetworkConfig.proofServer,
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

// ── the offer-files contract: the unified token mint ────────────────────────
// Its source is fetched at exact KERNEL_REF and compiled during this AA image's
// build into /aa/contract-offer-files (empty witnesses; [v6] keys → PLAIN proof server).
async function joinOfferFiles(walletResult: any) {
  if (!tokens.offerFilesAddress) await resolveTokens();
  if (!tokens.offerFilesAddress) throw new Error(`offer-files contract unknown: ${tokens.error}`);
  return await join(walletResult, "contract-offer-files", tokens.offerFilesAddress, {},
    "offerFilesPrivateState", WALLET_PROOF);
}

/** Mint `amount` of a SHIELDED token to the CALLING wallet.
 *
 * THE RECIPIENT IS EXPLICIT since kernel PR #67 (KERNEL_REF 80bace3): the
 * circuit took `ownPublicKey()` before and now takes
 * `Either<ZswapCoinPublicKey, ContractAddress>`. This console always passes the
 * LEFT arm holding the CALLING wallet's own coin public key, which reproduces
 * the old behaviour exactly — every caller here (`faucetJob`,
 * `fundShieldedJob`) then deposits or spends the coins from that same wallet.
 * The RIGHT arm (a contract) is never used: a contract recipient must claim the
 * coin by running its receive circuit in the SAME transaction, which nothing in
 * this console does, and ledger-v9 rejects the transaction otherwise. */
async function mintShieldedTo(walletResult: any, j: Job, token: TokenInfo, amount: bigint) {
  const of = await joinOfferFiles(walletResult);
  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const coinPublicKey = String(walletResult.zswapSecretKeys.coinPublicKey);
  jlog(j, `mint_shielded ${amount} ${token.name} → this wallet (${coinPublicKey.replace(/^0x/, "").slice(0, 12)}…)`);
  const tx = await (of.handle.callTx as any).mint_shielded(
    token.sep,
    amount,
    nonce,
    shieldedUserRecipient(coinPublicKey),
  );
  jlog(j, `minted ${token.name} — tx=${tx.public?.txId ?? "?"}`);
  return tx;
}

/** Mint `amount` of the UNSHIELDED token to an arbitrary 32-byte user address.
 *
 * Also explicit since PR #67 — `Either<ContractAddress, UserAddress>`, RIGHT
 * arm. The bytes are the same 32 the old `UserAddress` parameter took; only the
 * wrapper is new. */
async function mintUnshieldedTo(walletResult: any, j: Job, token: TokenInfo, amount: bigint, userAddr32: Uint8Array) {
  const of = await joinOfferFiles(walletResult);
  jlog(j, `mint_unshielded ${amount} ${token.name} → ${toHex(userAddr32).slice(0, 12)}…`);
  const tx = await (of.handle.callTx as any).mint_unshielded(
    token.sep,
    amount,
    unshieldedUserRecipient(toHex(userAddr32)),
  );
  jlog(j, `minted ${token.name} — tx=${tx.public?.txId ?? "?"}`);
  return tx;
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
  if (!tokens.list.length) await resolveTokens();
  const out: Array<Record<string, unknown>> = [];
  for (const [id, owner] of ledger.evmOwners) {
    const balances: Record<string, string> = {};
    for (const t of tokens.list) {
      const col = hexToBytes(t.color);
      if (t.family === "unshielded") {
        const key = Mod.pureCircuits.unshieldedKey(id, col);
        balances[t.name] = String(ledger.unshieldedBalances.member(key) ? ledger.unshieldedBalances.lookup(key) : 0n);
      } else {
        const key = Mod.pureCircuits.shieldedKey(id, col);
        balances[t.name] = String(ledger.shieldedBalances.member(key) ? ledger.shieldedBalances.lookup(key) : 0n);
      }
    }
    out.push({
      accountId: "0x" + toHex(id),
      owner: "0x" + toHex(owner),
      nonce: String(ledger.evmNonces.member(id) ? ledger.evmNonces.lookup(id) : 0n),
      balances,
    });
  }
  return out;
}

// ── pure / read-only functions against the Manager (no signature, no proof) ──
// "Pure" ones run the compiled module's pureCircuits locally; "read" ones are
// ledger lookups through the indexer. Nothing here mutates anything.
const PURE_FN_DOCS = [
  { fn: "deriveAccountId", kind: "pure", params: ["owner (0x…20 bytes)", "salt (0x…32 bytes)"], doc: "account id = hash(tag, manager, owner, salt)" },
  { fn: "shieldedKey", kind: "pure", params: ["accountId (0x…32)", "colour (32-byte hex)"], doc: "the shieldedBalances map key for (account, colour)" },
  { fn: "unshieldedKey", kind: "pure", params: ["accountId (0x…32)", "colour (32-byte hex)"], doc: "the unshieldedBalances map key for (account, colour)" },
  { fn: "isRegistered", kind: "read", params: ["accountId (0x…32)"], doc: "accounts set membership" },
  { fn: "evmOwner", kind: "read", params: ["accountId (0x…32)"], doc: "the EVM address bound to the account" },
  { fn: "evmNonce", kind: "read", params: ["accountId (0x…32)"], doc: "next EIP-712 action nonce" },
  { fn: "unshieldedBalance", kind: "read", params: ["accountId (0x…32)", "colour (32-byte hex, default demo token)"], doc: "unshielded credit for (account, colour)" },
  { fn: "shieldedBalance", kind: "read", params: ["accountId (0x…32)", "colour (32-byte hex, default shielded token)"], doc: "shielded credit for (account, colour)" },
  { fn: "poolHasColour", kind: "read", params: ["colour (32-byte hex, default shielded token)"], doc: "does the contract custody a pooled coin of this colour" },
  { fn: "poolValue", kind: "read", params: ["colour (32-byte hex, default shielded token)"], doc: "the pooled coin for this colour (value, nonce, merkle index)" },
  { fn: "deploymentDomain", kind: "read", params: [], doc: "the Manager's constructor domain (ledger field)" },
];

async function runPureFn(fn: string, args: string[]): Promise<unknown> {
  const b32 = (v: string | undefined, def?: string): Uint8Array => {
    const h = (v && v.trim() !== "" ? v : def ?? "").replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("expected a 32-byte hex value");
    return hexToBytes(h);
  };
  const b20 = (v: string | undefined): Uint8Array => {
    const h = (v ?? "").replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("expected a 20-byte hex value");
    return hexToBytes(h);
  };
  managerMod ??= await loadContract("contract-manager");
  const pc = managerMod.pureCircuits;
  switch (fn) {
    case "deriveAccountId":
      return { accountId: deriveAccountId(manager32, ("0x" + toHex(b20(args[0]))) as Hex20, ("0x" + toHex(b32(args[1]))) as Hex32) };
    case "shieldedKey":
      return { key: "0x" + toHex(pc.shieldedKey(b32(args[0]), b32(args[1], tokenByName("wBTC").color))) };
    case "unshieldedKey":
      return { key: "0x" + toHex(pc.unshieldedKey(b32(args[0]), b32(args[1], tokenByName("wUSD").color))) };
  }
  const { ledger } = await readLedger();
  switch (fn) {
    case "isRegistered":
      return { registered: ledger.accounts.member(b32(args[0])) };
    case "evmOwner": {
      const id = b32(args[0]);
      return ledger.evmOwners.member?.(id) === false
        ? { owner: null }
        : { owner: "0x" + toHex(ledger.evmOwners.lookup(id)) };
    }
    case "evmNonce": {
      const id = b32(args[0]);
      return { nonce: String(ledger.evmNonces.member(id) ? ledger.evmNonces.lookup(id) : 0n) };
    }
    case "unshieldedBalance": {
      const key = managerMod.pureCircuits.unshieldedKey(b32(args[0]), b32(args[1], tokenByName("wUSD").color));
      return { balance: String(ledger.unshieldedBalances.member(key) ? ledger.unshieldedBalances.lookup(key) : 0n) };
    }
    case "shieldedBalance": {
      const key = managerMod.pureCircuits.shieldedKey(b32(args[0]), b32(args[1], tokenByName("wBTC").color));
      return { balance: String(ledger.shieldedBalances.member(key) ? ledger.shieldedBalances.lookup(key) : 0n) };
    }
    case "poolHasColour":
      return { pooled: ledger.pools.member(b32(args[0], tokenByName("wBTC").color)) };
    case "poolValue": {
      const col = b32(args[0], tokenByName("wBTC").color);
      if (!ledger.pools.member(col)) return { pooled: false };
      const coin = ledger.pools.lookup(col);
      return { pooled: true, value: String(coin.value), nonce: "0x" + toHex(coin.nonce), mtIndex: String(coin.mt_index) };
    }
    case "deploymentDomain":
      return { domain: "0x" + toHex(ledger.deploymentDomain), utf8: new TextDecoder().decode(ledger.deploymentDomain).replace(/\0+$/, "") };
  }
  throw new Error(`unknown function '${fn}'`);
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

// Resolve a wallet's zswap public keys from its seed (facade build, no funds
// needed, no session queue — read-only key derivation plus a short sync).
async function walletZswapKeys(seed: string) {
  const wr: any = await buildWalletFacade(
    {
      id: midnightNetworkConfig.id,
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: WALLET_PROOF,
    } as any,
    seed,
    midnightNetworkConfig.id as any,
  );
  try {
    const cpk = wr.zswapSecretKeys.coinPublicKey;
    const epk = wr.zswapSecretKeys.encryptionPublicKey;
    return {
      coinPublicKey: String(cpk).replace(/^0x/, "").toLowerCase(),
      encryptionPublicKey: String(epk).replace(/^0x/, "").toLowerCase(),
      coinPublicKeyRaw: cpk,
      encryptionPublicKeyRaw: epk,
    };
  } finally {
    await wr.wallet?.stop?.().catch(() => {});
  }
}

// ── prepared actions (built here, signed in the browser) ─────────────────────

type Prepared = { action: any; owner: Hex20; kind: string; createdAt: number; summary: Record<string, unknown>; encMapping?: [unknown, unknown] };
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
    const token = tokenByName(String(body.token ?? "wUSD"));
    if (token.family !== "unshielded") throw new Error("transfer (selector 5) moves the UNSHIELDED balance — pick wUSD");
    const action = {
      primaryType: "TransferInternalUnshielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce, toAccountId,
      color: ("0x" + token.color) as Hex32, amount,
    };
    return { prep: { action, owner, kind, createdAt: Date.now(), summary: { nonce: String(nonce), token: token.name } }, accountId };
  }
  if (kind === "transfer-shielded") {
    // Selector 4 — first wired here; moves the SHIELDED in-Manager credit.
    const toAccountId = String(body.toAccountId ?? "") as Hex32;
    if (!/^0x[0-9a-f]{64}$/i.test(toAccountId)) throw new Error("toAccountId must be 0x…32 bytes");
    const token = tokenByName(String(body.token ?? "wBTC"));
    if (token.family !== "shielded") throw new Error("transfer-shielded (selector 4) moves a SHIELDED credit — pick a shielded token");
    const action = {
      primaryType: "TransferInternalShielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce, toAccountId,
      color: ("0x" + token.color) as Hex32, amount,
    };
    return { prep: { action, owner, kind, createdAt: Date.now(), summary: { nonce: String(nonce), token: token.name } }, accountId };
  }
  if (kind === "withdraw-shielded") {
    // Selector 2 — first wired here. recipientKind 0 = the recipient's zswap
    // COIN PUBLIC KEY (PR #10 refuses contract recipients). The matching
    // ENCRYPTION key is resolved at build time (see withdrawShieldedJob) —
    // the action itself only carries the coin key.
    const token = tokenByName(String(body.token ?? "wBTC"));
    if (token.family !== "shielded") throw new Error("withdraw-shielded (selector 2) pays a SHIELDED balance — pick a shielded token");
    const action = {
      primaryType: "WithdrawShielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce,
      color: ("0x" + token.color) as Hex32, amount,
      recipientKind: 0n, recipient: "0x" + "0".repeat(64), // stamped below
    } as any;
    // The recipient's coin + encryption keys come from either a pasted
    // mn_shield-addr… (the address IS both keys — the general form) or one of
    // the stack's wallets, whose keys a quick facade build derives from seed.
    const to = String(body.to ?? "").trim();
    let coinPk: string, encPk: unknown, coinPkRaw: unknown, label: string;
    if (to) {
      if (!to.startsWith("mn_shield-addr")) throw new Error("recipient must be a mn_shield-addr… address for a shielded withdraw");
      const dec: any = MidnightBech32m.parse(to).decode(ShieldedAddress as any, midnightNetworkConfig.id as any);
      coinPk = String(dec.coinPublicKeyString()).toLowerCase();
      coinPkRaw = coinPk;
      encPk = String(dec.encryptionPublicKeyString()).toLowerCase();
      label = `${to.slice(0, 26)}…`;
    } else {
      const target = String(body.target ?? "taker");
      if (!["taker", "relay", "funder"].includes(target)) throw new Error("target must be taker|relay|funder — or pass `to` with a mn_shield-addr… address");
      const seed = target === "taker" ? TAKER_SEED : target === "funder" ? FUNDER_SEED : RELAY_SEED;
      const keys = await walletZswapKeys(seed);
      coinPk = keys.coinPublicKey;
      coinPkRaw = keys.coinPublicKeyRaw;
      encPk = keys.encryptionPublicKeyRaw;
      label = target;
    }
    action.recipient = ("0x" + coinPk) as Hex32;
    return {
      prep: { action, owner, kind, createdAt: Date.now(),
        summary: { nonce: String(nonce), token: token.name, target: label, recipientCoinPk: coinPk },
        encMapping: [coinPkRaw, encPk] },
      accountId,
    };
  }
  if (kind === "swap") {
    // Open-shape selector 6 (SHIELDED-ONLY by contract design): give the demo
    // token, want shielded NIGHT — two distinct colours, so the offer's legs
    // survive as a real {+give, −want} pair (same-colour legs would net out and
    // the kernel would reject NOT_A_SWAP). recipientKind 0 = open offer: zero
    // recipient, the give surplus floats for whoever settles.
    //
    // Friendly pre-check: the give leg spends the account's SHIELDED balance,
    // and "balance 600000, give 1000 → account colour balance too low" has
    // already confused one demo user whose 600000 was all unshielded.
    const giveToken = tokenByName(String(body.giveToken ?? "wBTC"));
    const wantToken = tokenByName(String(body.wantToken ?? "wETH"));
    if (giveToken.family !== "shielded" || wantToken.family !== "shielded")
      throw new Error("open swaps are SHIELDED-only by contract design — pick shielded tokens for both legs");
    if (giveToken.name === wantToken.name)
      throw new Error("give and want must be different tokens (same-colour legs net out: NOT_A_SWAP)");
    {
      const { ledger, Mod } = await readLedger();
      const shKey = Mod.pureCircuits.shieldedKey(hexToBytes(accountId), hexToBytes(giveToken.color));
      const shBal = ledger.shieldedBalances.member(shKey) ? ledger.shieldedBalances.lookup(shKey) : 0n;
      if (shBal < amount) {
        throw new Error(
          `the swap's give leg spends the account's SHIELDED ${giveToken.name} balance, which is ${shBal} ` +
          `(unshielded balances do not count here) — run "Fund shielded" with ${giveToken.name} first, ` +
          `then give at most that amount`,
        );
      }
    }
    const giveAmount = amount;
    const wantAmount = BigInt(body.wantAmount ?? 0);
    if (wantAmount <= 0n) throw new Error("wantAmount must be a positive integer");
    const wantNonce = ("0x" + toHex(crypto.getRandomValues(new Uint8Array(32)))) as Hex32;
    const action = {
      primaryType: "OpenSwapShielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce,
      giveColor: ("0x" + giveToken.color) as Hex32, giveAmount,
      recipientKind: 0n, recipient: ("0x" + "0".repeat(64)) as Hex32,
      wantNonce, wantColor: ("0x" + wantToken.color) as Hex32, wantAmount,
      creditAccountId: accountId,
    };
    return {
      prep: { action, owner, kind, createdAt: Date.now(),
        summary: { nonce: String(nonce), give: `${giveAmount} ${giveToken.name}`, want: `${wantAmount} ${wantToken.name}`, giveToken: giveToken.name, wantToken: wantToken.name, wantNonce } },
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
    const wdToken = tokenByName(String(body.token ?? "wUSD"));
    if (wdToken.family !== "unshielded") throw new Error("withdraw (selector 3) pays the UNSHIELDED balance — pick wUSD");
    const action = {
      primaryType: "WithdrawUnshielded", manager: manager32, accountId, owner,
      validUntil: deadline(), nonce,
      color: ("0x" + wdToken.color) as Hex32, amount,
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
  data?: unknown; // job-specific result payload (e.g. the built offer blob)
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

// The aa-proof-server gets OOM-killed under host memory pressure (measured when
// `execute` was compactc's k=19: a 1.14 GB proving key uploaded per call, 19
// container restarts in one day. The MinoCrab k=18 default halves that key, which
// is the main reason it is the default; the retry stays because the failure class
// is memory pressure, not a particular key size) and the SDK surfaces the dropped
// socket as "'prove' returned an error: The socket connection was closed". Nothing has
// been submitted at that point, so ONE retry after the server's restart window
// is safe and has succeeded every time it was tried by hand. Only this exact
// transient class retries — real failures still surface immediately.
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

function executeJob(prep: Prepared, signature: string): Job {
  return enqueue(prep.kind, async (j) => {
    jlog(j, `verifying the ${prep.action.primaryType} signature`);
    const { digest } = computeDigest(prep.action, artifactDomain());
    const recovered = recoverSigner(digest, signature, { requireLowS: true });
    if (recovered.address.toLowerCase() !== prep.owner.toLowerCase())
      throw new Error(`recovered signer ${recovered.address} is not the action owner ${prep.owner}`);
    const p = prepareEvmExecute(prep.action, artifactDomain(), signature as `0x${string}`);
    jlog(j, `signer verified (${recovered.address}) — opening a wallet session`);
    await withProveRetry(j, prep.kind, () => session(prep.kind, async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      // Which artifact is about to be proved, read off THIS image rather than
      // guessed from a build flag — the whole point of the receipt.
      jlog(j, `proving execute — ${zkirSourceLine(ZKIR_SOURCE)}`);
      const t0 = Date.now();
      if (prep.encMapping) {
        // Selector 2 (withdraw shielded): the payout coin is ENCRYPTED to the
        // recipient, so the builder needs their encryption public key — which
        // callTx cannot carry. Manual path: build the unproven call with the
        // mapping, prove, then wallet-balance (DUST fees) and submit — the
        // exact settle mechanics the taker flow already proved.
        const built: any = await createUnprovenCallTx(mgr.providers, {
          compiledContract: mgr.compiled,
          circuitId: "execute",
          contractAddress: MANAGER,
          args: [p.payload, p.signature, p.point],
          privateStateId: "aaManagerPrivateState",
          additionalCoinEncPublicKeyMappings: new Map([[prep.encMapping[0], prep.encMapping[1]]]),
        } as any);
        const proven: any = await mgr.providers.proofProvider.proveTx(built.private.unprovenTx);
        const bound: any = typeof proven.bind === "function" ? proven.bind() : proven;
        jlog(j, `proven (${((Date.now() - t0) / 1000).toFixed(0)}s) — balancing + submitting…`);
        const wallet = walletResult.wallet as any;
        const keys = { shieldedSecretKeys: walletResult.zswapSecretKeys, dustSecretKey: walletResult.dustSecretKey };
        const recipe = await wallet.balanceFinalizedTransaction(bound, keys, { ttl: new Date(Date.now() + 30 * 60_000) });
        const finalTx = await wallet.finalizeRecipe(recipe);
        await wallet.submitTransaction(finalTx);
        j.txId = finalTx.transactionHash?.().toString?.() ?? null;
        jlog(j, `landed — tx=${j.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s total)`);
      } else {
        const tx = await (mgr.handle.callTx as any).execute(p.payload, p.signature, p.point);
        j.txId = tx.public?.txId ?? null;
        jlog(j, `landed — tx=${j.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }));
  });
}

/** Selector-6 open swap: prove the execute, NEVER submit — the proven-unbalanced
 * transaction IS the offer; encode MIP-0005 and publish to the kernel. */
function offerJob(prep: Prepared, signature: string): Job {
  return enqueue("swap-build", async (j) => {
    jlog(j, `verifying the ${prep.action.primaryType} signature`);
    const { digest } = computeDigest(prep.action, artifactDomain());
    const recovered = recoverSigner(digest, signature, { requireLowS: true });
    if (recovered.address.toLowerCase() !== prep.owner.toLowerCase())
      throw new Error(`recovered signer ${recovered.address} is not the action owner ${prep.owner}`);
    const p = prepareEvmExecute(prep.action, artifactDomain(), signature as `0x${string}`);
    const built = await withProveRetry(j, "swap-offer", () => session("swap-offer", async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      return await buildOpenSwapOffer({
        providers: mgr.providers,
        compiledContract: mgr.compiled,
        managerAddress: MANAGER,
        args: [p.payload, p.signature, p.point],
        giveColorHex: String(prep.action.giveColor).replace(/^0x/, ""),
        giveAmount: prep.action.giveAmount as bigint,
        wantColorHex: String(prep.action.wantColor).replace(/^0x/, ""),
        wantAmount: prep.action.wantAmount as bigint,
        log: (line) => jlog(j, line),
      });
    }, { requireFunds: false })); // the maker contributes no coins and pays no fees
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
    // Step 1 of the user-directed split ends HERE: the proven-unbalanced
    // transaction is the offer, the page shows its bech32m, and publishing is
    // an explicit second step (POST /api/publish-offer).
    j.txId = built.sha256;
    j.data = { blob: built.blob, sha256: built.sha256, bytes: built.bytes };
    jlog(j, `offer BUILT — ${built.bytes} bytes, offerId ${built.sha256.slice(0, 16)}…; use Publish to send it to the kernel`);
  });
}

/** Shielded funding runs on the FUNDER (genesis-3) wallet so the relay stays
 * shielded-free: mint the demo token's shielded colour, then deposit it into
 * the account's shielded Manager balance (what an open swap's give leg spends). */
function fundShieldedJob(accountId: Hex32, amount: bigint, tokenName = "wBTC"): Job {
  return enqueue("fund-shielded", async (j) => {
    const token = tokenByName(tokenName);
    if (token.family !== "shielded") throw new Error(`'${tokenName}' is not a shielded token`);
    // mint_shielded now names its recipient; mintShieldedTo passes the calling
    // wallet's own coin public key, so the funder still mints to itself…
    await withProveRetry(j, "fund-shielded-mint", () => session("fund-shielded-mint", async (walletResult) => {
      await mintShieldedTo(walletResult, j, token, amount);
    }, { seed: FUNDER_SEED }));
    // …then deposits the fresh coins into the account's Manager credit.
    await withProveRetry(j, "fund-shielded-deposit", () => session("fund-shielded-deposit", async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      jlog(j, `depositShielded(${amount} ${token.name}) → ${accountId.slice(0, 18)}…`);
      const coin = {
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        color: hexToBytes(token.color),
        value: amount,
      };
      const tx = await (mgr.handle.callTx as any).depositShielded(coin, hexToBytes(accountId));
      j.txId = tx.public?.txId ?? null;
      jlog(j, `deposited — tx=${j.txId ?? "?"}`);
    }, { seed: FUNDER_SEED }));
  });
}

/** Mint straight to a WALLET (no Manager deposit): the taker side of the demo.
 * Shielded mints go to the target wallet itself (its own coin public key is
 * passed as the circuit's recipient); unshielded mints go to the target's
 * 32-byte user address. */
function faucetJob(tokenName: string, amount: bigint, target: "relay" | "taker" | "funder"): Job {
  return enqueue("faucet", async (j) => {
    const token = tokenByName(tokenName);
    const seed = target === "taker" ? TAKER_SEED : target === "funder" ? FUNDER_SEED : RELAY_SEED;
    await withProveRetry(j, "faucet", () => session(`faucet-${target}`, async (walletResult) => {
      if (token.family === "shielded") {
        const tx = await mintShieldedTo(walletResult, j, token, amount);
        j.txId = tx.public?.txId ?? null;
      } else {
        const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
        const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
        const tx = await mintUnshieldedTo(walletResult, j, token, amount, userAddr);
        j.txId = tx.public?.txId ?? null;
      }
      jlog(j, `faucet done: ${amount} ${token.name} → the ${target} wallet`);
    }, { seed }));
  });
}

/** Send tokens to ANY standard Midnight address (user request): the funder
 * wallet mints the token to itself, then does a plain wallet transfer to the
 * pasted address. Shielded tokens need a mn_shield-addr… (it carries BOTH the
 * coin and encryption public keys — this is the general form of what the
 * withdraw-shielded dropdown special-cases); unshielded tokens a mn_addr…. */
function sendJob(tokenName: string, amount: bigint, to: string): Job {
  return enqueue("send", async (j) => {
    const token = tokenByName(tokenName);
    const netId = midnightNetworkConfig.id as any;
    let receiver: any;
    if (token.family === "shielded") {
      if (!to.startsWith("mn_shield-addr")) throw new Error(`${token.name} is SHIELDED — the recipient must be a mn_shield-addr… address`);
      receiver = MidnightBech32m.parse(to).decode(ShieldedAddress as any, netId);
    } else {
      if (!to.startsWith("mn_addr")) throw new Error(`${token.name} is UNSHIELDED — the recipient must be a mn_addr… address`);
      receiver = MidnightBech32m.parse(to).decode(UnshieldedAddress as any, netId);
    }
    await withProveRetry(j, "send", () => session("send", async (walletResult) => {
      // 1. mint to the funder wallet itself…
      if (token.family === "shielded") {
        await mintShieldedTo(walletResult, j, token, amount);
      } else {
        const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
        const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
        await mintUnshieldedTo(walletResult, j, token, amount, userAddr);
      }
      // 2. …then a standard wallet transfer to the pasted address. The wallet's
      // local view of the fresh mint can lag the chain by a few blocks, so an
      // insufficient-balance error here means "not indexed yet" — retry.
      const wallet = walletResult.wallet as any;
      const keys = { shieldedSecretKeys: walletResult.zswapSecretKeys, dustSecretKey: walletResult.dustSecretKey };
      jlog(j, `transferring ${amount} ${token.name} → ${to.slice(0, 30)}…`);
      let recipe: any = null;
      let lastErr: unknown = null;
      for (let i = 0; i < 10 && !recipe; i++) {
        if (i) await new Promise((r) => setTimeout(r, 6000));
        try {
          recipe = await wallet.transferTransaction(
            [{ type: token.family, outputs: [{ type: token.color, receiverAddress: receiver, amount }] }],
            keys, { ttl: new Date(Date.now() + 30 * 60_000) },
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

function fundJob(accountId: Hex32, amount: bigint, tokenName = "wUSD"): Job {
  return enqueue("fund", async (j) => {
    const token = tokenByName(tokenName);
    if (token.family !== "unshielded") throw new Error(`fund deposits the UNSHIELDED balance — '${tokenName}' is shielded (use Fund shielded)`);
    await withProveRetry(j, "fund-mint", () => session("fund-mint", async (walletResult) => {
      const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
      const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
      await mintUnshieldedTo(walletResult, j, token, amount, userAddr);
    }));
    await withProveRetry(j, "fund-deposit", () => session("fund-deposit", async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      jlog(j, `depositUnshielded(${amount} ${token.name}) → ${accountId.slice(0, 18)}…`);
      const tx = await (mgr.handle.callTx as any).depositUnshielded(hexToBytes(token.color), amount, hexToBytes(accountId));
      j.txId = tx.public?.txId ?? null;
      jlog(j, `deposited — tx=${j.txId ?? "?"}`);
    }));
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
  // TCP-level only, deliberately: the console has no postgres client and does
  // not hold a credential for any of the per-consumer roles. "The shared server
  // is accepting connections" is the whole claim, and it is the one that
  // distinguishes "kernel/evm are down" from "their database is down".
  const probePostgres = async () => {
    const socket = await Bun.connect({
      hostname: "postgres",
      port: 5432,
      socket: { data() {} },
    });
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
      // Its OWN container since the Phase 11 split — not a port on the kernel.
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

  // Since the ledger-v9 re-pin the solver DOES have an HTTP surface of its own:
  // GET /health on its status listener, open by design (no internal data, so a
  // healthcheck needs no secret). Probe it directly — it is the solver speaking
  // for itself — and keep the sink's view as the fallback, because a solver
  // whose listener is off is still visible through the relay socket.
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

  // The monitor site and the offer poster. Both are opt-in profiles, so `absent`
  // (which `probe` reports for a name that does not resolve) is the normal
  // answer on a stack that did not bring them up — not an error.
  const [solverFrontend, offerPoster] = await Promise.all([
    probe(async () => (await fetchJson(`${SOLVER_FRONTEND_URL}/health`)) as any),
    probe(async () => {
      const h = (await fetchJson(`${OFFER_POSTER_URL}/health`)) as any;
      return {
        state: h.state,
        mints: h.mints,
        liveOffers: h.liveOffers,
        lastOfferId: typeof h.lastOfferId === "string" ? h.lastOfferId.slice(0, 12) : null,
        lastFailure: h.lastFailure ?? null,
      };
    }),
  ]);

  // ── the price feed (profile `prices`) ──────────────────────────────────────
  // It has NO endpoint of its own: it publishes no port, serves nothing, and
  // talks only to CoinGecko and Postgres. So it is probed where its output
  // lands — the KERNEL's GET /v1/prices `feed` block, which is the same row
  // (`price_feed_status`) the feed upserts after every cycle.
  //
  // That row is deliberately NOT seeded by 000-init.sql, so the three states map
  // onto the three dots exactly:
  //   absent  no feed row at all — this stack never ran the profile (the normal
  //           answer, since it is opt-in and needs an API key)
  //   down    a cycle ran and recorded an error (no key, a 429, a provider
  //           outage). The stack still quotes: the seeded prices are untouched.
  //   up      a cycle completed cleanly; last_ok_at says when.
  const priceFeed = await probe(async () => {
    const NIGHT = "0".repeat(64);
    const p = (await fetchJson(`${KERNEL_URL}/v1/prices?tokens=${NIGHT}`)) as any;
    const feed = p?.feed ?? {};
    if (!feed.last_run_at && !feed.last_ok_at) {
      // Distinguished from an unreachable kernel: this IS an answer, and it
      // says the feed has never run here.
      throw new Error("no price-feed row — the `prices` profile has not run on this stack");
    }
    return {
      provider: feed.provider ?? null,
      lastOkAt: feed.last_ok_at ?? null,
      lastRunAt: feed.last_run_at ?? null,
      lastError: feed.last_error ?? null,
      // Which assets are live rather than seeded — the one claim that cannot be
      // satisfied by the shipped data (`source` is a two-value CHECK column).
      fedAssets: (p?.assets ?? [])
        .filter((a: any) => a?.source === "feed")
        .map((a: any) => a.asset_id),
    };
  });
  // `probe` cannot know that a recorded last_error means DOWN rather than UP.
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
      evmRpc, frontend, solverSink: sink, solver, solverFrontend, offerPoster,
      priceFeed: priceFeedComponent,
      // The one store for the whole stack (T11.4): the kernel's offer book
      // (`offerfiles`) and umbra-evm's index (`umbra`) both live here.
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
      // /api/solver/snapshot and /api/solver/stream were removed with the sink's
      // feed page: they existed only to proxy that page's data same-origin, and
      // the sink no longer streams anything. The solver's state reaches a human
      // through the monitor site (framed by the Offers+Solver tab) and reaches
      // an automated gate through scripts/verify-solver.sh.
      if (path === "/healthz") {
        return json({ ok: true, relay, taker, jobsQueued: queue.length, deployed: existsSync(ARTIFACT_PATH) });
      }
      if (path === "/api/info") {
        return json({
          network: midnightNetworkConfig.id,
          // Which compiler produced the Manager circuits this relay proves with, and
          // which published release they came from. The page's Repos tab renders it,
          // and it is the one place a reader can see that WITHOUT trusting a doc.
          zkirSource: ZKIR_SOURCE,
          manager: MANAGER, minter: MINTER, domain: artifact.manager.domain,
          minterTag: artifact.minter.tag ?? null,
          relay,
          taker,
          tokens: tokens.list.map((t) => ({ name: t.name, family: t.family, color: t.color })),
          tokensError: tokens.error,
          kernelUrl: KERNEL_URL,
          solverFrontendUrl: SOLVER_FRONTEND_PUBLIC_URL,
          devSigner: DEV_SIGNER ? { address: DEV_ADDR } : null,
          // Withdraw's node-rejection (Custom error 214, recipient Either arm
          // inversion) was FIXED upstream in AA PR #10 (713a2021…) and this
          // stack pins a post-fix AA_REF — no known-issue banner any more.
          withdrawKnownIssue: null,
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
        const job = takeJob(offerId);
        return json({ jobId: job.id });
      }
      if (path === "/api/fund-shielded" && req.method === "POST") {
        const body = await req.json();
        const accountId = String(body.accountId ?? "") as Hex32;
        if (!/^0x[0-9a-f]{64}$/i.test(accountId)) return bad("accountId must be 0x…32 bytes");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const job = fundShieldedJob(accountId, amount, String(body.token ?? "wBTC"));
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
        const job = fundJob(accountId, amount, String(body.token ?? "wUSD"));
        return json({ jobId: job.id });
      }
      if (path === "/api/deposit" && req.method === "POST") {
        // A wallet actor (taker/relay/funder) deposits tokens IT HOLDS into an
        // AA account — the onward-spend half of the withdraw paths.
        const body = await req.json();
        const accountId = String(body.accountId ?? "") as Hex32;
        if (!/^0x[0-9a-f]{64}$/i.test(accountId)) return bad("accountId must be 0x…32 bytes");
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const from = String(body.from ?? "taker");
        if (!["taker", "relay", "funder"].includes(from)) return bad("from must be taker|relay|funder");
        const token = tokenByName(String(body.token ?? "wUSD"));
        const seed = from === "taker" ? TAKER_SEED : from === "funder" ? FUNDER_SEED : RELAY_SEED;
        const job = enqueue(`deposit-from-${from}`, async (j) => {
          await withProveRetry(j, "deposit", () => session(`deposit-${from}`, async (walletResult) => {
            const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
            jlog(j, `deposit${token.family === "shielded" ? "Shielded" : "Unshielded"}(${amount} ${token.name}) from the ${from} wallet → ${accountId.slice(0, 18)}…`);
            let tx;
            if (token.family === "shielded") {
              const coin = { nonce: crypto.getRandomValues(new Uint8Array(32)), color: hexToBytes(token.color), value: amount };
              tx = await (mgr.handle.callTx as any).depositShielded(coin, hexToBytes(accountId));
            } else {
              tx = await (mgr.handle.callTx as any).depositUnshielded(hexToBytes(token.color), amount, hexToBytes(accountId));
            }
            j.txId = tx.public?.txId ?? null;
            jlog(j, `deposited — tx=${j.txId ?? "?"}`);
          }, { seed }));
        });
        return json({ jobId: job.id });
      }
      if (path === "/api/faucet" && req.method === "POST") {
        const body = await req.json();
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const target = String(body.target ?? "taker");
        if (!["relay", "taker", "funder"].includes(target)) return bad("target must be relay|taker|funder");
        const job = faucetJob(String(body.token ?? "wETH"), amount, target as any);
        return json({ jobId: job.id });
      }
      if (path === "/api/send" && req.method === "POST") {
        const body = await req.json();
        const amount = BigInt(body.amount ?? 0);
        if (amount <= 0n) return bad("amount must be a positive integer");
        const to = String(body.to ?? "").trim();
        if (!to) return bad("to must be a bech32m Midnight address (mn_addr… or mn_shield-addr…)");
        const job = sendJob(String(body.token ?? "wBTC"), amount, to);
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
await resolveTokens();
await checkRelayWallet();
await checkTakerWallet();
