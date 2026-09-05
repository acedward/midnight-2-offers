// aa-e2e.ts — end-to-end test of the EVM-signed AA path on the demo stack:
//
//   EVM wallet (MetaMask's real V4 signer) → relay (this runner: proves, submits,
//   pays fees from a Midnight wallet) → AA Manager `execute` → Midnight chain.
//
// Flow, against the ALREADY-DEPLOYED contracts from aa-contracts.json:
//   1. register two EVM accounts (selector 1) — authorized purely by EIP-712
//      signatures from their EOAs; the relay wallet has no authority of its own.
//   2. mint fresh unshielded tokens to the relay wallet (Minter).
//   3. depositUnshielded — credit alice's AA account inside the Manager.
//   4. transferInternalUnshielded alice → bob (selector 5), signed by alice.
//   5. assert every step from LEDGER STATE read through the indexer.
//
// Signing fidelity: payloads, frozen hashes and digests come from the AA repo's
// own tests/lib (baked at /aa/aalib); signatures from @metamask/eth-sig-util's
// signTypedData V4 — the code path a real MetaMask executes.
//
// THREE OPERATIONAL RULES, each measured live (see the master plan's T7.5):
//   * DEADLINE HORIZON — an EVM action's validUntil may sit at most 3600 s past
//     block time; the e2e uses now+1800 s.
//   * ONE FACADE PER TRANSACTION — a facade that has signed several txs in one
//     session eventually attaches a piece the aa profile's experimental proof
//     server rejects at /check ("zswap-cc[v1] inputs did not match alignment",
//     runs 2–7: always the session's 5th tx, never the first four; the deploy
//     runner — fresh wallet per operation — never failed once). Fresh facades
//     also sidestep the stale-DUST error-170 class the kernel e2e met.
//   * SHIELDED-FREE RELAY — the relay seed is faucet-funded with unshielded
//     NIGHT + DUST only (scripts/aa-e2e.sh), so wallet balancing can never
//     select a standard-lane shielded coin into an experimental-checked tx.
//
// Needs the :e2e image variant (AA_PRUNE_MANAGER_PROVERS=0): calling `execute`
// proves it locally, so the Manager's proving key must be in the image.
//
// WHICH `execute` — and how long it took — is recorded, not assumed. The report
// carries the zkir-source receipt (which compiler, which release, which k) and the
// wall time of every `execute` proof, so a run with the MinoCrab default and a run
// with `AA_ZKIR_SOURCE=compactc` are directly comparable and each number says which
// artifact produced it.

import { readFileSync, writeFileSync } from "node:fs";
import { zkirSourceReceipt, zkirSourceLine } from "/aa/runner/zkir-source.ts";
import { resolve } from "node:path";
import * as Rx from "rxjs";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  buildWalletFacade,
  registerNightForDust,
  configureMidnightNodeProviders,
} from "@effectstream/midnight-contracts";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";

import { deriveAccountId } from "/aa/aalib/codec.js";
import { prepareEvmExecute } from "/aa/aalib/manager.js";
import { metamaskSign } from "/aa/aalib/metamask.js";
import { addressForPrivateKey } from "/aa/aalib/signature.js";
import type { Hex20, Hex32 } from "/aa/aalib/bytes.js";
import type { RegisterEvmAccount, TransferAction } from "/aa/aalib/schema.js";

const TAG = "[aa-e2e]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
(globalThis as any).WebSocket = WebSocket;

const AA_ROOT = "/aa";
const WALLET_PROOF = process.env["AA_WALLET_PROOF_SERVER_URL"] ?? "http://proof-server:6300";
const E2E_SEED = process.env["AA_E2E_SEED"] ?? midnightNetworkConfig.walletSeed;
const artifact = JSON.parse(readFileSync("/aa/out/aa-contracts.json", "utf-8"));
const MANAGER = artifact.manager.address as string;
const MINTER = artifact.minter.address as string;

const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h: string): Uint8Array => {
  const c = h.replace(/^0x/, "");
  return new Uint8Array(c.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
};
const manager32 = (`0x` + MANAGER.replace(/^0x/, "").slice(0, 64)) as Hex32;

// Two dev EOAs — the "frontend EVM wallets". Public dev keys, throwaway chain.
const ALICE_KEY = ("0x" + "a11ce".padStart(64, "1")) as Hex32;
const BOB_KEY = ("0x" + "b0b".padStart(64, "2")) as Hex32;
const ALICE = addressForPrivateKey(ALICE_KEY) as Hex20;
const BOB = addressForPrivateKey(BOB_KEY) as Hex20;
// Random salts per run: account id = hash(tag, manager, owner, salt), so fresh
// salts give each run fresh accounts on a living chain (fixed salts trip the
// Manager's duplicate-registration assert on the second run).
const randSalt = (): Hex32 => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + toHex(b)) as Hex32;
};
const ALICE_SALT = randSalt();
const BOB_SALT = randSalt();
const ALICE_ID = deriveAccountId(manager32, ALICE, ALICE_SALT);
const BOB_ID = deriveAccountId(manager32, BOB, BOB_SALT);
// Deadline horizon rule — see header.
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 1800);

const DEPOSIT = 600_000n;
const TRANSFER = 250_000n;
const WITHDRAW = 50_000n;

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

/** One facade per transaction — see the header. Builds, syncs, runs, stops. */
async function session<T>(label: string, fn: (walletResult: any) => Promise<T>): Promise<T> {
  const walletResult = await buildWalletFacade(
    {
      id: midnightNetworkConfig.id,
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: WALLET_PROOF,
    } as any,
    E2E_SEED,
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
          const bal = st.unshielded?.balances;
          const total = bal
            ? (bal instanceof Map ? [...bal.values()] : Object.values(bal)).reduce(
                (a: bigint, v: any) => a + (v ?? 0n), 0n)
            : 0n;
          return sh && un && total > 0n;
        }),
        Rx.timeout({ each: 180_000, with: () => Rx.throwError(() => new Error(`${label}: wallet sync timeout`)) }),
      ),
    );
    try { await registerNightForDust(walletResult as any); } catch { /* already registered */ }
    return await fn(walletResult);
  } finally {
    await wallet.stop?.().catch(() => {});
  }
}

/** Join a deployed contract with a fresh providers set inside a session. */
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
  return { Mod, handle, providers };
}

async function readManagerLedger() {
  return await session("ledger-read", async (walletResult) => {
    const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
    const state = await (mgr.providers.publicDataProvider as any).queryContractState(MANAGER);
    if (!state) throw new Error("manager contract state not found via indexer");
    return { ledger: (mgr.Mod as any).ledger(state.data), Mod: mgr.Mod };
  });
}

function artifactDomain(): Hex32 {
  // Same padding rule the deploy runner used for the constructor argument.
  const b = new TextEncoder().encode(artifact.manager.domain);
  const o = new Uint8Array(32);
  o.set(b);
  return ("0x" + toHex(o)) as Hex32;
}

async function main() {
  setNetworkId(midnightNetworkConfig.id as any);
  log(`manager=${MANAGER.slice(0, 16)}… minter=${MINTER.slice(0, 16)}…`);
  log(`alice EOA=${ALICE} account=${ALICE_ID.slice(0, 18)}…`);
  log(`bob   EOA=${BOB} account=${BOB_ID.slice(0, 18)}…`);
  const results: Record<string, unknown> = {};
  // Every `execute` proof's wall time, keyed by step. SC-002 is a comparison, and a
  // comparison needs both sides recorded the same way by the same code.
  const executeTimings: Record<string, number> = {};
  const zkirSource = zkirSourceReceipt(AA_ROOT);
  log(`manager circuits: ${zkirSourceLine(zkirSource)}`);

  // ── 1. register alice + bob (one session per register) ─────────────────────
  const registerAction = (owner: Hex20, salt: Hex32, id: Hex32): RegisterEvmAccount => ({
    primaryType: "RegisterEvmAccount",
    manager: manager32,
    accountId: id,
    owner,
    validUntil: DEADLINE,
    accountSalt: salt,
  });
  for (const [who, key, owner, salt, id] of [
    ["alice", ALICE_KEY, ALICE, ALICE_SALT, ALICE_ID],
    ["bob", BOB_KEY, BOB, BOB_SALT, BOB_ID],
  ] as const) {
    await session(`register-${who}`, async (walletResult) => {
      const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
      const action = registerAction(owner, salt, id);
      const sig = metamaskSign(key, action as any, artifactDomain());
      const prep = prepareEvmExecute(action as any, artifactDomain(), sig);
      if (prep.signer.toLowerCase() !== owner.toLowerCase())
        throw new Error(`${who}: recovered signer ${prep.signer} != ${owner}`);
      log(`register ${who}: proving execute — ${zkirSourceLine(zkirSource)}…`);
      const t0 = Date.now();
      const tx = await (mgr.handle.callTx as any).execute(prep.payload, prep.signature, prep.point);
      executeTimings[`register-${who}`] = (Date.now() - t0) / 1000;
      log(`✅ ${who} registered — tx=${tx.public?.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    });
  }
  {
    const { ledger } = await readManagerLedger();
    for (const [who, id, owner] of [["alice", ALICE_ID, ALICE], ["bob", BOB_ID, BOB]] as const) {
      if (!ledger.accounts.member(hexToBytes(id))) throw new Error(`${who} not in accounts set`);
      const rec = ledger.evmOwners.lookup(hexToBytes(id));
      if (("0x" + toHex(rec)).toLowerCase() !== owner.toLowerCase())
        throw new Error(`${who} evmOwner mismatch: ${toHex(rec)}`);
    }
    log("✅ ledger: both accounts registered with the right EOAs");
    results["register"] = { alice: ALICE_ID, bob: BOB_ID };
  }

  // ── 2. mint fresh unshielded tokens to the relay wallet ────────────────────
  const colour = hexToBytes(artifact.mints.unshielded.color);
  await session("mint", async (walletResult) => {
    const mnt = await join(walletResult, "contract-minter", MINTER, {}, "aaMinterPrivateState");
    const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
    const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
    log(`minting ${DEPOSIT * 2n} unshielded to the relay wallet…`);
    const tx = await (mnt.handle.callTx as any).mintUnshieldedTo(DEPOSIT * 2n, {
      is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: userAddr },
    });
    log(`✅ minted — tx=${tx.public?.txId ?? "?"}`);
    results["mint"] = { amount: String(DEPOSIT * 2n), colour: artifact.mints.unshielded.color };
  });

  // ── 3. deposit into alice's AA account ─────────────────────────────────────
  await session("deposit", async (walletResult) => {
    const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
    log(`depositUnshielded(${DEPOSIT}) → alice…`);
    const t0 = Date.now();
    const tx = await (mgr.handle.callTx as any).depositUnshielded(colour, DEPOSIT, hexToBytes(ALICE_ID));
    log(`✅ deposited — tx=${tx.public?.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  });
  const balanceOf = async (id: Hex32) => {
    const { ledger, Mod } = await readManagerLedger();
    const key = (Mod as any).pureCircuits.unshieldedKey(hexToBytes(id), colour);
    return ledger.unshieldedBalances.member(key) ? ledger.unshieldedBalances.lookup(key) : 0n;
  };
  {
    const a = await balanceOf(ALICE_ID);
    if (a !== DEPOSIT) throw new Error(`alice balance ${a} != deposit ${DEPOSIT}`);
    log(`✅ ledger: alice credited ${a}`);
    results["deposit"] = { alice: String(a) };
  }

  // ── 4. SEND — internal transfer alice → bob (selector 5), DEFAULT flow ─────
  // The proving-layer blocker (a change-coin pool underflow in the Manager,
  // zswap-cc /check alignment refusal) was FIXED upstream in AA PR #9; the
  // internal transfer now proves and LANDS. Nonce 0: first EVM action after
  // registration for this account.
  await session("transfer", async (walletResult) => {
    const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
    const action: TransferAction<"TransferInternalUnshielded"> = {
      primaryType: "TransferInternalUnshielded",
      manager: manager32,
      accountId: ALICE_ID,
      owner: ALICE,
      validUntil: DEADLINE,
      nonce: 0n,
      color: ("0x" + artifact.mints.unshielded.color) as Hex32,
      amount: TRANSFER,
      toAccountId: BOB_ID,
    } as any;
    const sig = metamaskSign(ALICE_KEY, action as any, artifactDomain());
    const prep = prepareEvmExecute(action as any, artifactDomain(), sig);
    log(`transfer ${TRANSFER} alice→bob: proving execute — ${zkirSourceLine(zkirSource)}…`);
    const t0 = Date.now();
    const tx = await (mgr.handle.callTx as any).execute(prep.payload, prep.signature, prep.point);
    executeTimings["transfer"] = (Date.now() - t0) / 1000;
    log(`✅ transferred — tx=${tx.public?.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    results["transfer"] = { amount: String(TRANSFER), tx: tx.public?.txId ?? null };
  });
  {
    const a = await balanceOf(ALICE_ID);
    const b = await balanceOf(BOB_ID);
    if (a !== DEPOSIT - TRANSFER) throw new Error(`alice ${a} != ${DEPOSIT - TRANSFER}`);
    if (b !== TRANSFER) throw new Error(`bob ${b} != ${TRANSFER}`);
    log(`✅ ledger: alice=${a} bob=${b} — transfer exact`);
    (results["transfer"] as any).balances = { alice: String(a), bob: String(b) };
  }

  // ── 5. SEND — withdraw to an address (selector 3), DEFAULT flow ────────────
  // The node's 214 rejection (recipient Either arms inverted in the claim —
  // the 00016 investigation's confirmed root cause) was FIXED upstream in
  // AA PR #10 ("Fix WithdrawUnshielded's 214 … BREAKING: execute keys
  // regenerate"); withdraw is now a fatal assert like every other step.
  // recipientKind 0 (a 32-byte user address) is the ONLY supported withdraw
  // recipient — the contract now refuses contract-recipient payout shapes.
  await session("withdraw", async (walletResult) => {
    const mgr = await join(walletResult, "contract-manager", MANAGER, managerWitnesses, "aaManagerPrivateState");
    const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
    const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
    const action = {
      primaryType: "WithdrawUnshielded",
      manager: manager32,
      accountId: ALICE_ID,
      owner: ALICE,
      validUntil: DEADLINE,
      nonce: 1n, // after the transfer
      color: ("0x" + artifact.mints.unshielded.color) as Hex32,
      amount: WITHDRAW,
      recipientKind: 0n,
      recipient: ("0x" + toHex(userAddr)) as Hex32,
    } as any;
    const sig = metamaskSign(ALICE_KEY, action, artifactDomain());
    const prep = prepareEvmExecute(action, artifactDomain(), sig);
    log(`withdraw ${WITHDRAW} alice→relay (selector 3): proving execute — ${zkirSourceLine(zkirSource)}…`);
    const t0 = Date.now();
    const tx = await (mgr.handle.callTx as any).execute(prep.payload, prep.signature, prep.point);
    executeTimings["withdraw"] = (Date.now() - t0) / 1000;
    log(`✅ withdrawn — tx=${tx.public?.txId ?? "?"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    results["withdraw"] = { amount: String(WITHDRAW), tx: tx.public?.txId ?? null };
  });
  {
    const a = await balanceOf(ALICE_ID);
    if (a !== DEPOSIT - TRANSFER - WITHDRAW) throw new Error(`alice ${a} != ${DEPOSIT - TRANSFER - WITHDRAW} after withdraw`);
    log(`✅ ledger after withdraw: alice=${a} — withdraw exact`);
  }

  const report = {
    path: "EVM wallet (MetaMask V4) → relay → Manager.execute → Midnight",
    network: midnightNetworkConfig.id,
    manager: MANAGER, minter: MINTER,
    actors: { alice: { eoa: ALICE, account: ALICE_ID }, bob: { eoa: BOB, account: BOB_ID } },
    steps: results,
    zkirSource,
    // Seconds, prove-and-submit, per `execute` call. Host-specific by nature — the
    // number that matters is the RATIO between two runs on the same host.
    executeSeconds: executeTimings,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync("/aa/out/aa-e2e.json", JSON.stringify(report, null, 2) + "\n");
  log("E2E PASSED — report at /aa/out/aa-e2e.json");
  console.log(JSON.stringify(report, null, 2));
}

await main();
process.exit(0);
