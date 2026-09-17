// passport.ts — the one place this image builds Passport wallets, providers and compiled
// contracts. Everything else in runner/ goes through it.
//
// WHAT REPLACED WHAT. Before project 00034 this plumbing came from
// @effectstream/midnight-contracts (buildWalletFacade / configureMidnightNodeProviders),
// wrapped around ONE shared Manager contract. The Passport fork ships its own node layer
// and it has to be the one in use, because of a detail the effectstream helpers have no
// reason to know: proving a CROSS-CONTRACT call tree needs the verifier and prover keys of
// every contract in the tree, so the proof provider is built over a zk-config REGISTRY
// rooted at the artefact directory (account, Erc20Vault, SignetSigner side by side), not
// over one bundle. `createProviders` in the fork does exactly that.
//
// THE THREE THINGS THIS FILE ADDS on top of the fork's own helpers:
//   1. the proof-server split (see ./passport-env.ts) — the wallet's pieces on the plain
//      server, the [v7] contract calls on the experimental one;
//   2. the console's compiled contract and its deploy waves, which are NOT the library
//      default `contractForArms(['evm'])`: an account this console registers also carries
//      the offer circuit (Q35 made that a CONSUMER decision, because the offer's 3,321-byte
//      verifier key is on the wrong side of the node's measured deploy wall for an account
//      that will never make one) and the five bridge circuits;
//   3. the roster, which is this stack's answer to Q40: one account is one contract, so
//      "the accounts this wallet owns" is a file the console keeps, not a ledger map.

import './passport-env.ts';

import { readFileSync, existsSync } from 'node:fs';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import { CONTRACT_PROOF_SERVER, WALLET_PROOF_SERVER } from './passport-env.ts';

import {
  CONFIG,
  createWallet,
  createProviders,
  syncWallet,
  managedPath,
  zkConfigPath,
  coinPublicKeyBytes,
  userAddressBytes,
  type WalletContext,
} from "../passport/src/node/wallet.js";
import { Contract } from "../passport/src/wallet/contract.js";
import { makeWitnesses } from "../passport/src/wallet/witnesses.js";
import {
  BRIDGE_CIRCUITS,
  SWAP_CIRCUIT as PASSPORT_SWAP_CIRCUIT,
  bridgeWaves,
  contractForBridgeAccount,
} from "../passport/src/wallet/bridge.js";

export { CONFIG, createWallet, createProviders, syncWallet, managedPath, zkConfigPath };
export { coinPublicKeyBytes, userAddressBytes };
export type { WalletContext };
export { CONTRACT_PROOF_SERVER, WALLET_PROOF_SERVER };

export const AA_ROOT = "/aa";
export const OUT_DIR = "/aa/out";
export const ARTIFACT_PATH = "/aa/out/aa-contracts.json";
export const ROSTER_PATH = process.env["AA_ROSTER_PATH"] ?? "/aa/out/aa-roster.json";
export const PASSPORT_ROOT = "/aa/passport";

/** The offer circuit this console deploys on every account it registers (Q35). The name
 *  comes from the library rather than being retyped here: it is a contract operation id,
 *  and a deploy that names one the contract does not export throws with that id in it. */
export const SWAP_CIRCUIT = PASSPORT_SWAP_CIRCUIT;

/** Does this image carry the bridge's prover keys? Written by the Dockerfile. */
export const WITH_BRIDGE = (() => {
  try {
    return readFileSync("/aa/.aa-with-bridge", "utf-8").trim() === "1";
  } catch {
    return false;
  }
})();

const readTrimmed = (p: string): string | null => {
  try {
    return readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
};

/** The image's build receipt — what `verify-aa.sh` and the deploy artifact quote. */
export const BUILD = {
  passportCommit: readTrimmed("/aa/.passport-commit"),
  kernelCommit: readTrimmed("/aa/.kernel-commit"),
  mintTestTokensCommit: readTrimmed("/aa/.mint-test-tokens-commit"),
  compactcVersion: readTrimmed("/aa/.compactc-version"),
  compactRuntimeVersion: readTrimmed("/aa/.compact-runtime-version"),
  signetPkgVersion: readTrimmed("/aa/.signet-pkg-version"),
  signetPkgSha256: readTrimmed("/aa/.signet-pkg-sha256"),
  proverKeys: (readTrimmed("/aa/.aa-prover-keys") ?? "").split(/\s+/).filter(Boolean),
  withBridge: WITH_BRIDGE,
};

/** SHA-256 of each compiled bundle's verifier keys — spec FR-022's artefact fingerprint.
 *  Computed at BUILD time from the bytes in this image (see the Dockerfile's last stage),
 *  so the deploy receipt and `verify-aa.sh` compare the same number rather than two
 *  independent derivations of it. */
export const ARTEFACTS: Record<
  string,
  { fingerprint: string; verifierKeys: number; moduleSha256: string; provers: string[] }
> = (() => {
  try {
    return JSON.parse(readFileSync("/aa/.artefact-fingerprints.json", "utf-8"));
  } catch {
    return {};
  }
})();

export const VAULT_ZK_PATH = `${PASSPORT_ROOT}/contracts/erc20-vault/managed/Erc20Vault`;
export const SIGNET_ZK_PATH = `${PASSPORT_ROOT}/contracts/erc20-vault/managed/SignetSigner`;

// ── the console's compiled account contract ─────────────────────────────────

/** The circuit ids an account REGISTERED BY THIS CONSOLE carries, read off the restricted
 *  contract itself rather than re-listed — one source, so the deploy, the client and the
 *  receipt cannot disagree. */
export function consoleAccountCircuits(): string[] {
  const contract = new (consoleContractClass() as any)(makeWitnesses());
  return Object.keys(contract.provableCircuits ?? {});
}

/**
 * The console's restricted contract class.
 *
 * `contractForBridgeAccount(['evm'], { withSwap: true })` is the library's own answer, and
 * it is exactly what this console wants: the two permissionless deposits, the `evm` arm's
 * eight, the five bridge circuits and the offer. PR-G measured the split as wave 1 = 8
 * operations (the node's ceiling, Q28) and wave 2 = 8, which fits.
 *
 * Deploying the bridge's VERIFIER keys costs 5 × ~2 KB in one maintenance update and buys
 * an account that can be bridged later; the expensive half is the PROVER keys, and those
 * are what `AA_WITH_BRIDGE` gates in the image.
 *
 * The list is not cosmetic. `findDeployedContract` verifies the local verifier key of EVERY
 * circuit the compiled contract declares against the deployed state, so a client built from
 * a different list cannot connect to an account at all: too many and it fails with
 * ContractTypeError, too few and the missing circuit cannot be called. Registration and
 * connection must therefore agree, which is why both go through here.
 */
export function consoleContractClass(): typeof Contract {
  return contractForBridgeAccount(["evm"], { withSwap: true });
}

/** The compiled contract, with the `held_coin` witness and this image's artefacts. */
export function consoleCompiledAccount() {
  return CompiledContract.make("account", consoleContractClass()).pipe(
    CompiledContract.withWitnesses(makeWitnesses()),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );
}

/**
 * The deploy waves this console uses.
 *
 * Wave 1 is exactly the eight operations PR-A measured the node accepting (Q28: nine are
 * refused, and the client-side fee computation happily prices ten). Everything this
 * console adds therefore rides wave 2 — the maintenance update that also retires the
 * maintenance authority — so an account is usable for custody the moment wave 1 lands and
 * gains the offer (and the bridge) one transaction later.
 */
export function consoleWaves(): { waveOne: string[]; waveTwo: string[] } {
  return bridgeWaves({ withSwap: true });
}

// ── providers, with the proof-server split ──────────────────────────────────

/**
 * The fork's providers, with the contract proof provider re-aimed at the EXPERIMENTAL
 * server. See ./passport-env.ts for why the two servers are not interchangeable.
 *
 * `zkPath` is the LEAF bundle (the contract being deployed or connected); the proof
 * provider's registry always spans the whole artefact root, because a call tree's proofs
 * need every contract's keys.
 */
export async function providersFor(
  walletCtx: WalletContext,
  zkPath: string = zkConfigPath,
): Promise<any> {
  const providers: any = await createProviders(walletCtx, zkPath);
  const registry = await nodeZkConfigRegistry(managedPath);
  providers.proofProvider = httpClientProofProvider(CONTRACT_PROOF_SERVER, registry);
  return providers;
}

/** Open and sync a wallet in one call. */
export async function openWallet(seed: string, label: string): Promise<WalletContext> {
  const ctx = await createWallet(seed);
  await syncWallet(ctx, label);
  return ctx;
}

// ── small shared utilities ──────────────────────────────────────────────────

export const toHex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (h: string): Uint8Array => {
  const clean = String(h ?? "").replace(/^0x/, "").toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error(`not hex: ${String(h).slice(0, 32)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bytes32 = (h: string): Uint8Array => {
  const b = hexToBytes(h);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
};

export const bytes20 = (h: string): Uint8Array => {
  const b = hexToBytes(h);
  if (b.length !== 20) throw new Error(`expected a 20-byte address, got ${b.length}`);
  return b;
};

export const randomBytes32 = (): Uint8Array => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
};

/** The deploy artifact aa-deploy wrote, or null before it has run. */
export function readArtifact(): any | null {
  if (!existsSync(ARTIFACT_PATH)) return null;
  return JSON.parse(readFileSync(ARTIFACT_PATH, "utf-8"));
}
