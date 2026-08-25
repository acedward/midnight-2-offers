// deploy-aa.ts — deploy the AA Manager + test Minter on the demo chain, then mint.
//
// Shaped exactly like the kernel's proven deploy.ts + mint-test-tokens.ts pair
// (same SDK line, same stack): deployMidnightContract builds a fresh wallet per
// deploy from MIDNIGHT_* env; the mint step then joins the deployed Minter with
// findDeployedContract and proves two mint calls through the aa proof server.
//
// Env (all with demo defaults):
//   AA_DOMAIN      Manager EIP-712 deployment salt   (string, padded to Bytes<32>, nonzero)
//   AA_MINTER_TAG  Minter per-deployment tag         (string, padded to Bytes<32>)
//   AA_MINT_AMOUNT amount minted per family          (default 1_000_000_000)
//   MIDNIGHT_WALLET_SEED and the MIDNIGHT_* endpoints — the usual midnight-env set.
//
// Output: /aa/out/aa-contracts.json — addresses, colours, mint evidence. The
// entrypoint's idempotency check keys on this file.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
import {
  deployMidnightContract,
  type DeployConfig,
} from "@effectstream/midnight-contracts/deploy";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";

const TAG = "[aa-deploy]";
const log = (...a: unknown[]) => console.log(TAG, ...a);

(globalThis as any).WebSocket = WebSocket;

const AA_ROOT = "/aa";
const OUT = "/aa/out/aa-contracts.json";

const pad32 = (s: string): Uint8Array => {
  const b = new TextEncoder().encode(s);
  if (b.length === 0 || b.length > 32) throw new Error(`cannot pad "${s}" to Bytes<32>`);
  const out = new Uint8Array(32);
  out.set(b);
  return out;
};
const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h: string): Uint8Array => {
  const clean = h.replace(/^0x/, "");
  return new Uint8Array(clean.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
};

const DOMAIN = pad32(process.env["AA_DOMAIN"] ?? "demo-infra:aa:v1");
const MINTER_TAG = pad32(process.env["AA_MINTER_TAG"] ?? "TOKA");
const MINT_AMOUNT = BigInt(process.env["AA_MINT_AMOUNT"] ?? "1000000000");

// The Manager's single witness. Bring-up never runs a circuit that consumes it
// (deploy only executes the constructor), but midnight-js requires the witness
// map to be total. A fixed dev secret keeps any accidental use deterministic.
const DEV_OWNER_SECRET = pad32("demo-infra:aa:dev-owner-secret");
const managerWitnesses = {
  localOwnerSecret: ({ privateState }: { privateState: unknown }): [unknown, Uint8Array] => [
    privateState,
    DEV_OWNER_SECRET,
  ],
};

async function loadContract(name: string): Promise<any> {
  return await import(resolve(AA_ROOT, name, "src", "managed", "contract", "index.js"));
}

async function deployBoth(): Promise<{ manager: string; minter: string }> {
  const ManagerMod = await loadContract("contract-manager");
  const MinterMod = await loadContract("contract-minter");

  const managerCfg: DeployConfig = {
    contractName: "contract-manager",
    contractFileName: "contract-manager.json",
    contractClass: ManagerMod.Contract,
    witnesses: managerWitnesses,
    privateStateId: "aaManagerPrivateState",
    initialPrivateState: {},
    privateStateStoreName: "aa-manager-private-state",
    deployArgs: [DOMAIN],
  };
  log(`deploying Manager (domain "${process.env["AA_DOMAIN"] ?? "demo-infra:aa:v1"}")…`);
  await deployMidnightContract(managerCfg, midnightNetworkConfig);

  const minterCfg: DeployConfig = {
    contractName: "contract-minter",
    contractFileName: "contract-minter.json",
    contractClass: MinterMod.Contract,
    witnesses: {},
    privateStateId: "aaMinterPrivateState",
    initialPrivateState: {},
    privateStateStoreName: "aa-minter-private-state",
    deployArgs: [MINTER_TAG],
  };
  log(`deploying Minter (tag "${process.env["AA_MINTER_TAG"] ?? "TOKA"}")…`);
  await deployMidnightContract(minterCfg, midnightNetworkConfig);

  const addr = (file: string): string => {
    const j = JSON.parse(
      readFileSync(resolve(AA_ROOT, `${file}.${midnightNetworkConfig.id}.json`), "utf-8"),
    );
    const a = j.contractAddress ?? j.address ?? j;
    if (typeof a !== "string") throw new Error(`no contractAddress in ${file} artifact`);
    return a;
  };
  return { manager: addr("contract-manager"), minter: addr("contract-minter") };
}

async function mint(minterAddress: string) {
  setNetworkId(midnightNetworkConfig.id as any);
  log("building wallet facade for the mint…");
  const walletResult = await buildWalletFacade(
    {
      id: midnightNetworkConfig.id,
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: midnightNetworkConfig.proofServer,
    } as any,
    midnightNetworkConfig.walletSeed,
    midnightNetworkConfig.id as any,
  );
  const wallet = walletResult.wallet as any;
  try {
    log("waiting for wallet sync (funds > 0)…");
    await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.filter((s: any) => {
          const synced = s.isSynced ?? false;
          const sh = s.shielded?.state?.progress?.isStrictlyComplete?.() ?? synced;
          const un = s.unshielded?.progress?.isStrictlyComplete?.() ?? synced;
          const bal = s.unshielded?.balances;
          const total = bal
            ? (bal instanceof Map ? [...bal.values()] : Object.values(bal)).reduce(
                (a: bigint, v: any) => a + (v ?? 0n),
                0n,
              )
            : 0n;
          return sh && un && total > 0n;
        }),
        Rx.timeout({ each: 180_000, with: () => Rx.throwError(() => new Error("wallet sync timeout")) }),
      ),
    );
    try {
      await registerNightForDust(walletResult as any);
    } catch (e) {
      log(`registerNightForDust: ${e instanceof Error ? e.message : e} (continuing — genesis wallets are pre-registered)`);
    }

    const MinterMod = await loadContract("contract-minter");
    const zkPath = resolve(AA_ROOT, "contract-minter", "src", "managed");
    const compiled = CompiledContract.make("contract-minter", MinterMod.Contract as any).pipe(
      CompiledContract.withWitnesses({} as never),
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
      "aa-minter-private-state",
      zkPath,
      walletResult.unshieldedKeystore,
    )) as any;
    const deployed = await findDeployedContract(providers, {
      contractAddress: minterAddress,
      compiledContract: compiled as any,
      privateStateId: "aaMinterPrivateState",
      initialPrivateState: {},
    });
    log(`joined Minter at ${deployed.deployTxData.public.contractAddress}`);

    // Shielded mint → the deploy wallet's own coin public key.
    const coinPk = hexToBytes(String(walletResult.zswapSecretKeys.coinPublicKey));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const zero32 = new Uint8Array(32);
    log(`mintShieldedTo(${MINT_AMOUNT})…`);
    const stx = await (deployed.callTx as any).mintShieldedTo(MINT_AMOUNT, nonce, {
      is_left: true,
      left: { bytes: coinPk },
      right: { bytes: zero32 },
    });
    const sCoin = stx.private?.result;
    const sColor = toHex(sCoin?.color ?? sCoin?.type ?? zero32).toLowerCase();
    const sTx = stx.public?.txId ?? stx.public?.txHash ?? null;
    log(`✅ shielded colour ${sColor.slice(0, 16)}… tx=${sTx}`);

    // Unshielded mint → the deploy wallet's 32-byte user address.
    const parsed = MidnightBech32m.parse(walletResult.unshieldedAddress);
    const userAddr = Uint8Array.prototype.slice.call(parsed.data, 0, 32);
    log(`mintUnshieldedTo(${MINT_AMOUNT})…`);
    const utx = await (deployed.callTx as any).mintUnshieldedTo(MINT_AMOUNT, {
      is_left: false,
      left: { bytes: zero32 },
      right: { bytes: userAddr },
    });
    const uRes = utx.private?.result;
    const uColor = (uRes instanceof Uint8Array ? toHex(uRes) : String(uRes)).toLowerCase();
    const uTx = utx.public?.txId ?? utx.public?.txHash ?? null;
    log(`✅ unshielded colour ${uColor.slice(0, 16)}… tx=${uTx}`);

    return {
      shielded: { color: sColor, tx: sTx, recipient: "deploy wallet (coin public key)" },
      unshielded: { color: uColor, tx: uTx, recipient: walletResult.unshieldedAddress },
    };
  } finally {
    await wallet.stop?.().catch(() => {});
  }
}

const t0 = Date.now();
const addresses = await deployBoth();
const mints = await mint(addresses.minter);
mkdirSync("/aa/out", { recursive: true });
const artifact = {
  network: midnightNetworkConfig.id,
  aaCommit: readFileSync("/aa/.aa-commit", "utf-8").trim(),
  manager: { address: addresses.manager, domain: process.env["AA_DOMAIN"] ?? "demo-infra:aa:v1" },
  minter: { address: addresses.minter, tag: process.env["AA_MINTER_TAG"] ?? "TOKA" },
  mints,
  deployedAt: new Date().toISOString(),
  tookSeconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
log(`done in ${artifact.tookSeconds}s — wrote ${OUT}`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(0);
