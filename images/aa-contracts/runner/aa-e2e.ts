// aa-e2e.ts — the headless end-to-end proof that this stack runs on PASSPORT ACCOUNTS.
//
//   an Ethereum key (the code path MetaMask executes, minus the extension)
//     → register   deploy + activate ONE ACCOUNT CONTRACT for that key
//     → fund       mint a shielded coin, deposit it with its inbox entry, capture it
//     → offer      prove `open_swap_shielded_with_evm` and STOP (the offer is the artefact)
//     → settle     a taker with no maker key funds the want leg and submits — the solver
//                  when the kernel is up, our own taker wallet otherwise
//     → spend      the account spends the coin it received, from its own custody
//
// Spec User Story 3, SC-005. Run it with `scripts/aa-e2e.sh` against a stack brought up
// with the `aa` profile.
//
// ⚠ WHAT THIS REPLACED. The previous version drove the AA-v3 Manager: register ×2 → mint →
// deposit → INTERNAL TRANSFER → withdraw, four proofs of one `execute` gateway. Two of
// those steps no longer exist. There is no shared Manager to register INTO (register now
// DEPLOYS a contract, Q40), and there are no internal transfers, because both accounts used
// to be rows in one contract's balance map and are now separate contracts (Q41). What
// replaced them is the thing this stack is actually for: an offer a stranger settles.
//
// FIVE PROPERTIES THIS RUN ASSERTS, each of which failed at least once while it was written:
//   1. the account id is the CONTRACT ADDRESS, and it exists only after wave 1 lands;
//   2. a deposited coin is discoverable ONLY through its inbox entry — the walk is run
//      against chain state, not against what the depositor happened to remember;
//   3. the offer artefact carries no DUST and all its legs in ONE segment (Q39), which is
//      what makes a stranger able to settle it;
//   4. the settlement is submitted by a wallet that holds no key of the account's;
//   5. afterwards the account can SPEND what it received — the coin is real custody, not a
//      number in a map.
//
// THREE OPERATIONAL RULES, each measured live (master plan T7.5) and all still in force:
//   * ONE FACADE PER TRANSACTION — every step opens and closes its own wallet;
//   * a SHIELDED-FREE relay wallet for the fee-paying side (scripts/aa-e2e.sh funds it with
//     unshielded NIGHT + DUST only), so balancing can never pull a standard-lane shielded
//     coin into a transaction the experimental proof server checks;
//   * short transaction TTLs, because node 2.1.0 dismisses a fee calculation made too far
//     ahead of the block it lands in.

import "./passport-env.ts";

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as Rx from "rxjs";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import * as FaucetModule from "../passport/contracts/managed/faucet/contract/index.js";
import { CustodyAccount, deployEvmAccount } from "../passport/src/wallet/account.js";
import { EvmDevice } from "../passport/src/wallet/signer.js";
import { generateEncKeyPair, sealInboxEntry } from "../passport/src/wallet/inbox.js";
import { depositAsThirdParty, inboxWalkPortable } from "../passport/src/wallet/deposit.js";
import { candidateIndices } from "../passport/src/wallet/capture.js";
import {
  freshWantNonce,
  offerAuthArgs,
  offerInboxEntries,
  predictChangeCoin,
  signOpenSwapOffer,
  RECIPIENT_OPEN,
  type OfferCallArgs,
} from "../passport/src/wallet/offer.js";

import { buildKernelOffer } from "./aa-offer.ts";
import {
  ARTEFACTS,
  BUILD,
  CONFIG,
  PASSPORT_ROOT,
  SWAP_CIRCUIT,
  consoleAccountCircuits,
  consoleCompiledAccount,
  consoleWaves,
  createWallet,
  hexToBytes,
  providersFor,
  randomBytes32,
  readArtifact,
  toHex,
  zkConfigPath,
} from "./passport.ts";

const TAG = "[aa-e2e]";
const log = (...a: unknown[]) => console.log(TAG, ...a);

const KERNEL_URL = process.env["AA_KERNEL_URL"] ?? "http://kernel:9999";
const OUT = "/aa/out/aa-e2e.json";
const FAUCET_ZK_PATH = `${PASSPORT_ROOT}/contracts/managed/faucet`;

// The fee-paying wallet (funded unshielded-only by scripts/aa-e2e.sh) and the TAKER, a
// second wallet that holds the want colour and no key of the account's.
const E2E_SEED = process.env["AA_E2E_SEED"]
  ?? "e2ee2e0000000000000000000000000000000000000000000000000000e2ee2e";
const TAKER_SEED = process.env["AA_TAKER_SEED"]
  ?? "7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e7a4e";
// A deterministic Ethereum key: the e2e's "MetaMask". Public by design, like every seed here.
const OWNER_KEY = hexToBytes(
  process.env["AA_E2E_OWNER_KEY"]?.replace(/^0x/, "") ?? `${"a11ce".padStart(60, "0")}beef`,
);

const GIVE = BigInt(process.env["AA_E2E_GIVE"] ?? "4");
const WANT = BigInt(process.env["AA_E2E_WANT"] ?? "7");
const MINT = BigInt(process.env["AA_E2E_MINT"] ?? "1000");

const artifact = readArtifact();
if (!artifact) throw new Error("/aa/out/aa-contracts.json is missing — bring the stack up with ./up.sh --with aa");
const VAULT_ADDRESS: string | undefined = artifact.vault?.address;
const FAUCET_ADDRESS: string = artifact.testFaucet?.address;
const COLOURS = artifact.testFaucet?.colours ?? {};
if (!FAUCET_ADDRESS || !COLOURS["shielded-a"] || !COLOURS["shielded-b"]) {
  throw new Error("the deploy receipt carries no test-faucet colours — is this an old aa-contracts.json?");
}
const GIVE_COLOUR = String(COLOURS["shielded-a"].color);
const GIVE_DOMAIN = hexToBytes(String(COLOURS["shielded-a"].domain));
const WANT_COLOUR = String(COLOURS["shielded-b"].color);
const WANT_DOMAIN = hexToBytes(String(COLOURS["shielded-b"].domain));

const steps: Record<string, unknown> = {};
const t0 = Date.now();
let stepStart = Date.now();
function step(name: string) {
  log("");
  log(`── ${name} ──`);
  stepStart = Date.now();
}
const took = () => Math.round((Date.now() - stepStart) / 1000);

async function session<T>(label: string, seed: string, fn: (ctx: any) => Promise<T>, requireFunds = true): Promise<T> {
  const walletCtx: any = await createWallet(seed);
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
          if (!requireFunds) return true;
          const bal = st.unshielded?.balances;
          const vals = bal ? (bal instanceof Map ? [...bal.values()] : Object.values(bal)) : [];
          return (vals as any[]).reduce((a: bigint, v: any) => a + (v ?? 0n), 0n) > 0n;
        }),
        Rx.timeout({ each: 240_000, with: () => Rx.throwError(() => new Error(`${label}: wallet sync timeout`)) }),
      ),
    );
    return await fn(walletCtx);
  } finally {
    await (walletCtx.wallet as any).stop?.().catch(() => {});
  }
}

/** The fork's test faucet: `mint_shielded(domainSep, amount, nonce, recipientCoinPk)`. The
 *  minted COLOUR is `tokenType(domainSep, faucetAddress)`, which the deploy receipt already
 *  derived — this call only has to name the same domain separator. */
async function mintShielded(walletCtx: any, domain: Uint8Array, amount: bigint, coinPk: Uint8Array) {
  const providers = await providersFor(walletCtx, FAUCET_ZK_PATH);
  const compiled = CompiledContract.make("faucet", (FaucetModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(FAUCET_ZK_PATH),
  );
  const handle: any = await (findDeployedContract as any)(providers, {
    contractAddress: FAUCET_ADDRESS,
    compiledContract: compiled,
    privateStateId: `faucet-${Date.now().toString(36)}`,
    initialPrivateState: {},
  });
  const r: any = await handle.callTx.mint_shielded(domain, amount, randomBytes32(), { bytes: coinPk });
  return r?.public?.txId ?? r?.public?.transactionHash ?? null;
}

const coinPkOf = (st: any): Uint8Array => hexToBytes(String(st.shielded.coinPublicKey.toHexString()));

// ─────────────────────────────────────────────────────────────────────────────

log(`passport ${String(BUILD.passportCommit).slice(0, 12)}… / compactc ${BUILD.compactcVersion}`);
log(`network ${CONFIG.networkId}; vault ${VAULT_ADDRESS?.slice(0, 18) ?? "(none)"}…; faucet ${FAUCET_ADDRESS.slice(0, 18)}…`);
log(`give ${GIVE} of ${GIVE_COLOUR.slice(0, 12)}… / want ${WANT} of ${WANT_COLOUR.slice(0, 12)}…`);

// ── 1. register ──────────────────────────────────────────────────────────────
step("1/5 register — deploy and activate ONE account contract for an Ethereum key");
const device = EvmDevice.fromPrivateKey(OWNER_KEY);
const encKeys = generateEncKeyPair();
const waves = consoleWaves();
log(`owner ${device.addressHex}`);   // addressHex already carries the 0x
log(`waves: ${waves.waveOne.length} operations in wave 1, ${waves.waveTwo.length} in wave 2 (then the authority is retired)`);

const accountAddress = await session("register", E2E_SEED, async (walletCtx) => {
  const providers = await providersFor(walletCtx, zkConfigPath);
  const account = await deployEvmAccount({
    providers, device, encKeys,
    compiledContract: consoleCompiledAccount(),
    waveOneCircuits: waves.waveOne,
    waveTwoCircuits: waves.waveTwo,
    armsInWaveTwo: [],
    retireAuthority: true,
    ...(VAULT_ADDRESS ? { vaultAddress: hexToBytes(VAULT_ADDRESS) } : {}),
  } as any);
  return account.address;
});
log(`✅ account ${accountAddress} (the account id IS this address)`);
steps.register = {
  owner: device.addressHex,
  accountAddress,
  circuits: consoleAccountCircuits(),
  waveOne: waves.waveOne,
  waveTwo: waves.waveTwo,
  vaultAddress: VAULT_ADDRESS ?? null,
  artefactFingerprints: ARTEFACTS,
  seconds: took(),
};

// The console's own private state, rebuilt here rather than shared: this driver is a second
// client of the same account, which is exactly the situation the coin store and the roster
// exist for.
let coins: Record<string, { nonceHex: string; colorHex: string; value: string; mtIndex: string }> = {};
const connect = async (walletCtx: any): Promise<CustodyAccount> =>
  CustodyAccount.connect(
    await providersFor(walletCtx, zkConfigPath),
    consoleCompiledAccount(),
    accountAddress,
    { encSecretKeyHex: toHex(encKeys.secretKey), coins },
  );

// ── 2. fund ──────────────────────────────────────────────────────────────────
step("2/5 fund — mint a shielded coin and deposit it WITH its inbox entry");
const depositCoin = { nonce: randomBytes32(), color: hexToBytes(GIVE_COLOUR), value: MINT };
const fund = await session("fund", E2E_SEED, async (walletCtx) => {
  const st: any = await Rx.firstValueFrom((walletCtx.wallet as any).state());
  const mintTx = await mintShielded(walletCtx, GIVE_DOMAIN, MINT, coinPkOf(st));
  log(`minted ${MINT} of the give colour to the e2e wallet — tx=${mintTx}`);
  const account = await connect(walletCtx);
  const { txId } = await depositAsThirdParty(account as any, depositCoin, { encKey: encKeys.publicKey });
  log(`deposit_shielded + a 192-byte entry sealed to the account's enc_key — tx=${txId}`);
  const { candidates } = await candidateIndices(txId);
  // Discovery is the assertion, not the bookkeeping: the walk reads the CHAIN, decrypts what
  // it can with the account's viewing key, and must find this coin without being told.
  const found = await inboxWalkPortable(await account.ledgerState(), encKeys.secretKey);
  const mine = found.filter((c) => toHex(c.color) === GIVE_COLOUR && c.value === MINT);
  if (mine.length === 0) throw new Error("the inbox walk did not recover the deposited coin — it would be unspendable");
  log(`inbox walk: ${found.length} entries readable, the deposit among them`);
  return { mintTx, txId, candidates: candidates.map(String) };
});
coins = {
  [GIVE_COLOUR]: {
    nonceHex: toHex(depositCoin.nonce), colorHex: GIVE_COLOUR,
    value: MINT.toString(), mtIndex: fund.candidates[0]!,
  },
};
log(`✅ funded: ${MINT} of ${GIVE_COLOUR.slice(0, 12)}… held by the account`);
steps.fund = { ...fund, colour: GIVE_COLOUR, amount: MINT.toString(), seconds: took() };

// ── 3. offer ─────────────────────────────────────────────────────────────────
step("3/5 offer — prove open_swap_shielded_with_evm and STOP");
const offer = await session("offer", E2E_SEED, async (walletCtx) => {
  const account = await connect(walletCtx);
  const ctx = await account.callContext();
  const counter = await account.resolveUseCounter(device);
  const held = await account.heldCoin(hexToBytes(GIVE_COLOUR));
  const want = { nonce: freshWantNonce(), color: hexToBytes(WANT_COLOUR), value: WANT };
  const change = predictChangeCoin(held, GIVE);
  const { wantEntry, changeEntry } = offerInboxEntries(encKeys.publicKey, want, change);
  const call: OfferCallArgs = {
    giveColor: hexToBytes(GIVE_COLOUR), giveAmount: GIVE,
    recipientKind: RECIPIENT_OPEN, recipient: new Uint8Array(32),
    want, wantEntry, changeEntry, validUntil: 0n,
  };
  const auth = await signOpenSwapOffer(device, ctx, call, held, counter);
  const built = await buildKernelOffer({
    providers: (account as any).providers,
    compiledContract: consoleCompiledAccount(),
    accountAddress,
    privateStateId: (account as any).privateStateId,
    circuitId: SWAP_CIRCUIT,
    call,
    authArgs: offerAuthArgs(auth),
  }, (line) => log(`  ${line}`));
  return { built, want, change };
});
log(`✅ offer ${offer.built.sha256.slice(0, 16)}… — ${offer.built.bytes} bytes, legs in segment ${offer.built.legSegment}`);
steps.offer = {
  offerId: offer.built.sha256,
  bytes: offer.built.bytes,
  legSegment: offer.built.legSegment,
  imbalances: offer.built.imbalances,
  terms: offer.built.terms,
  proveMs: offer.built.proveMs,
  circuit: SWAP_CIRCUIT,
  seconds: took(),
};
mkdirSync("/aa/out/offers", { recursive: true });
writeFileSync(`/aa/out/offers/${offer.built.sha256}.swapoffer`, `${offer.built.blob}\n`);

// ── 4. settle ────────────────────────────────────────────────────────────────
step("4/5 settle — a taker with NO key of the account's funds the want leg and submits");
// The taker needs the want colour before it can fund the deficit.
await session("taker-mint", TAKER_SEED, async (walletCtx) => {
  const st: any = await Rx.firstValueFrom((walletCtx.wallet as any).state());
  const tx = await mintShielded(walletCtx, WANT_DOMAIN, MINT, coinPkOf(st));
  log(`taker minted ${MINT} of the want colour — tx=${tx}`);
});

// Publish to the kernel when it is up, so the SOLVER can settle it; fall back to settling
// with our own taker wallet, which is the same act by a different party and is what makes
// this driver usable on `./up.sh --with aa` alone.
let settlement: Record<string, unknown> = {};
let published = false;
try {
  const res = await fetch(`${KERNEL_URL}/v1/offers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer: offer.built.blob }),
    signal: AbortSignal.timeout(30_000),
  });
  const out: any = await res.json().catch(() => ({}));
  published = res.ok;
  log(published
    ? `published to the kernel — offerId ${out.offerId ?? offer.built.sha256}`
    : `the kernel refused the offer (${res.status}): ${JSON.stringify(out).slice(0, 200)}`);
} catch (e) {
  log(`kernel not reachable (${e instanceof Error ? e.message : e}) — settling directly`);
}

let solverSettled = false;
if (published) {
  const waitSeconds = Number(process.env["AA_E2E_SOLVER_WAIT"] ?? "120");
  log(`waiting up to ${waitSeconds}s for the solver to settle it…`);
  for (let i = 0; i * 5 < waitSeconds; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const s: any = await (await fetch(`${KERNEL_URL}/v1/offers/${offer.built.sha256}/status`)).json();
      if (s.status === "consumed") { solverSettled = true; break; }
      if (["cancelled", "expired"].includes(s.status)) throw new Error(`offer ended ${s.status}`);
    } catch { /* keep waiting */ }
  }
  log(solverSettled ? "✅ the SOLVER settled it" : "the solver did not take it in time — settling with the e2e taker");
}

if (!solverSettled) {
  const takeTx = await session("take", TAKER_SEED, async (walletCtx) => {
    const wallet = walletCtx.wallet as any;
    const keys = { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey };
    const offerTx = (Transaction as any).deserialize(
      "signature", "proof", "binding", OfferFiles.decode(offer.built.blob),
    );
    const recipe = await wallet.balanceFinalizedTransaction(offerTx, keys, {
      ttl: new Date(Date.now() + Number(process.env["TX_TTL_MS"] ?? "60000")),
    });
    const settleTx = await wallet.finalizeRecipe(recipe);
    await wallet.submitTransaction(settleTx);
    return String(settleTx.transactionHash?.().toString?.() ?? settleTx.transactionHash ?? "");
  });
  log(`✅ settled by the e2e taker — tx=${takeTx}`);
  settlement = { by: "e2e-taker-wallet", txId: takeTx };
} else {
  settlement = { by: "solver", offerId: offer.built.sha256 };
}
steps.settle = { published, ...settlement, seconds: took() };

// ── 5. the account spends what it received ───────────────────────────────────
step("5/5 spend — the account spends the coin it received from the settlement");
const spend = await session("spend", E2E_SEED, async (walletCtx) => {
  const account = await connect(walletCtx);
  // The settlement created the want coin and the change; both are discoverable only through
  // the inbox entries the offer sealed BEFORE it was proved.
  const found = await inboxWalkPortable(await account.ledgerState(), encKeys.secretKey);
  const received = found.find((c) => toHex(c.color) === WANT_COLOUR && c.value === WANT);
  if (!received) {
    throw new Error(
      `the settlement's want coin (${WANT} of ${WANT_COLOUR.slice(0, 12)}…) is not in the inbox — ` +
      `entries readable: ${found.map((c) => `${c.value}/${toHex(c.color).slice(0, 8)}`).join(", ")}`,
    );
  }
  log(`inbox walk after settlement: ${found.length} entries, the want coin among them`);
  // ITS mt_index COMES FROM THE SETTLEMENT TRANSACTION, WHICH SOMEBODY ELSE SUBMITTED. That
  // is the honest cost of not having been the submitter: the coin's Merkle position is not in
  // anything the maker holds. `candidateIndices` narrows it to the commitments that ONE
  // transaction produced — usually three or four, of which two are the account's (the want
  // coin and the change) and the rest are the taker's — so the scan is a handful of attempts
  // rather than a search. A wrong index fails while PROVING, before any transaction exists,
  // so a retry costs time and nothing else. A k=18 proof is about a minute, which is why the
  // range matters more here than the elegance of the loop.
  let candidates: bigint[] = [];
  const settleTxId = (settlement as any).txId as string | undefined;
  if (settleTxId) {
    candidates = (await candidateIndices(settleTxId)).candidates;
    log(`settlement ${settleTxId.slice(0, 16)}… produced commitments ${candidates.map(String).join(", ")}`);
  } else {
    // The solver settled it and this driver never saw the transaction id. Fall back to a
    // bounded scan from the account's own inbox position, which is the best a maker can do.
    for (let i = 0n; i < 24n; i++) candidates.push(i);
    log("the solver settled it, so the settlement tx id is unknown here — scanning a bounded range");
  }
  const st: any = await Rx.firstValueFrom((walletCtx.wallet as any).state());
  const recipient = coinPkOf(st);
  let lastError: unknown = null;
  for (const idx of candidates) {
    await account.putCoin({ nonce: received.nonce, color: received.color, value: received.value, mtIndex: idx });
    try {
      const r = await account.withdrawShielded(device, recipient, received.color, received.value);
      return { txId: r.txId, mtIndex: idx.toString(), colour: WANT_COLOUR, value: String(received.value) };
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // A wrong index fails while PROVING. Anything else is a real failure and must not be
      // retried against every candidate.
      if (!/merkle|mt_index|proof|prove|witness|commitment|invalid/i.test(msg)) throw e;
      log(`  mt_index ${idx} rejected (${msg.slice(0, 80)}) — next candidate`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
});
log(`✅ the account spent ${spend.value} of the received colour — tx=${spend.txId} (mt_index ${spend.mtIndex})`);
steps.spend = { ...spend, seconds: took() };

// ── the report ───────────────────────────────────────────────────────────────
const report = {
  kind: "aa-passport-e2e",
  version: 1,
  ranAtUtc: new Date().toISOString(),
  network: CONFIG.networkId,
  build: BUILD,
  deployReceipt: {
    vault: artifact.vault ?? null,
    signet: artifact.signet ?? null,
    testFaucet: FAUCET_ADDRESS,
    artefacts: artifact.artefacts ?? null,
  },
  steps,
  totalSeconds: Math.round((Date.now() - t0) / 1000),
  pass: true,
};
mkdirSync("/aa/out", { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
log("");
log(`✅ PASS in ${report.totalSeconds}s — wrote ${OUT}`);
log(`   account   ${accountAddress}`);
log(`   offer     ${offer.built.sha256}`);
log(`   settled   ${JSON.stringify(settlement)}`);
log(`   spend tx  ${spend.txId}`);
void createHash;
process.exit(0);
