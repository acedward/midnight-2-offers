// deploy-aa.ts — the `aa-deploy` one-shot: put the stack's SHARED Passport pieces on the
// demo chain and write the receipt everything else reads.
//
// ⚠ WHAT THIS NO LONGER DOES. It used to deploy the AA-v3 MANAGER — one contract holding
// every user's balances — plus a test Minter. There is no Manager any more: an account is
// a contract per user, and `register` in the console deploys one (Q40). A one-shot cannot
// deploy accounts, because it does not know who the users are.
//
// What it deploys instead is the three things that must exist BEFORE any account does:
//
//   1. the SIGNET SINGLETON, from the fork's vendored source. The vault calls it; a
//      contract-typed constructor argument must name a live contract.
//   2. the ERC20 VAULT, and its one-shot `initialise`. The account's constructor seals a
//      reference to the vault, so no account can be deployed until the vault exists — and
//      the compiler embeds a fingerprint of the vault's verifier keys, so an account is
//      bound to ONE vault build for its whole life (spec FR-022). This is also why the
//      entrypoint refuses to run twice: two vaults on one chain would be two mutually
//      incompatible populations of accounts, not a harmless duplicate.
//   3. the fork's TEST FAUCET, and one shielded + one unshielded mint. Shielded tokens on
//      a fresh localnet can only originate from a contract mint, and `aa-e2e.sh` needs
//      colours without depending on the `faucet` profile — exactly what the retired
//      Minter did, from the same repository and the same compiler as the account.
//
// THE LOCAL MPC IS A STUB, DELIBERATELY AND VISIBLY. `initialise` pins the vault to an MPC
// root public key and a chain id, and Sig Network publishes a root key for stagenet only.
// On this stack there is no MPC at all unless the `signet` profile is up, so the root key
// is DERIVED FROM A PUBLIC STRING (`AA_DOMAIN`) and its private half is therefore known to
// anyone reading this file. That is correct for a disposable localnet whose genesis keys
// are in `wallets/wallets.json` and wrong anywhere else, so:
//
//   * the artifact records `mpc.provenance: "derived-from-AA_DOMAIN"` and verify-aa.sh
//     prints it, rather than letting a stub look like a key somebody chose;
//   * `AA_MPC_ROOT_SECRET` overrides it — which is what an operator holding a real root
//     does, so the derived deposit addresses are the ones a responder will actually sweep.
//
// THE `signet` PROFILE (project 00035) TURNS THAT ROUND. With `AA_SIGNET=1` this one-shot
// GENERATES a per-stack 32-byte root secret, writes it to `/aa/out/signet-root.env` (mode
// 600, on the `aa-out` volume) and initialises the vault against its public half — and it
// REFUSES the `AA_DOMAIN` stub outright, because a stub-keyed vault on a profile whose whole
// purpose is to move real funds would strand every deposit at an address whose private key
// is published in this file's own comments. The responder (compose/signet.yml) reads the same
// file. Generating it HERE rather than in a separate one-shot is deliberate: this is the
// EARLIER consumer — it cannot initialise the vault without the public half — and it already
// owns the volume, so nothing has to order a second service ahead of a service declared in
// another compose fragment. `./down.sh -v` removes `aa-out`, which rotates the root key with
// the chain whose vault was initialised against it. Project 00035, question Q12.
//
// Env (all with demo defaults):
//   AA_DOMAIN          the stack label, and the seed of the two derived local keys
//   AA_MINT_AMOUNT     amount minted per family (default 1_000_000_000)
//   AA_EVM_CHAIN_ID    the EIP-155 chain the vault is pinned to (default 31337, anvil;
//                      up.sh raises it to 11155111 when the `signet` profile is on)
//   AA_SIGNET          `1` when the `signet` profile is up: generate/load a per-stack MPC
//                      root secret, refuse the stub, record mpc.provenance = "fakenet"
//   AA_MPC_ROOT_SECRET / AA_VAULT_DEPLOYER_SECRET   32-byte hex overrides
//   MIDNIGHT_WALLET_SEED and the MIDNIGHT_* endpoints — the usual midnight-env set.
//
// Output: /aa/out/aa-contracts.json. The entrypoint's idempotency check keys on this file.

import "./passport-env.ts";

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { encodeContractAddress } from "@midnight-ntwrk/compact-runtime";
import { encodeRawTokenType, rawTokenType } from "@midnightntwrk/ledger-v9";
import { secp256k1PublicKeyOf, signAttestationDigest } from "@sig-net/midnight/testing";

import * as VaultModule from "../passport/contracts/erc20-vault/managed/Erc20Vault/contract/index.js";
import * as SignetModule from "../passport/contracts/erc20-vault/managed/SignetSigner/contract/index.js";
import * as FaucetModule from "../passport/contracts/managed/faucet/contract/index.js";
import {
  deriveDepositEvmAddress,
  deriveVaultEvmAddress,
  pureCircuits as vaultPureCircuits,
} from "../passport/contracts/erc20-vault/src/index.ts";
import {
  deriveMidnightResponseKey,
  formatSecp256k1PublicKey,
  normaliseSecp256k1PublicKey,
} from "../passport/contracts/erc20-vault/src/signet-sdk.ts";

import {
  ARTEFACTS,
  BUILD,
  OUT_DIR,
  ARTIFACT_PATH,
  PASSPORT_ROOT,
  SIGNET_ZK_PATH,
  VAULT_ZK_PATH,
  consoleAccountCircuits,
  consoleWaves,
  hexToBytes,
  openWallet,
  providersFor,
  randomBytes32,
  toHex,
  CONFIG,
  coinPublicKeyBytes,
  userAddressBytes,
} from "./passport.ts";

const TAG = "[aa-deploy]";
const log = (...a: unknown[]) => console.log(TAG, ...a);

const FAUCET_ZK_PATH = `${PASSPORT_ROOT}/contracts/managed/faucet`;

const DOMAIN = process.env["AA_DOMAIN"] ?? "demo-infra:aa:v1";
const MINT_AMOUNT = BigInt(process.env["AA_MINT_AMOUNT"] ?? "1000000000");
const EVM_CHAIN_ID = BigInt(process.env["AA_EVM_CHAIN_ID"] ?? "31337");

const pad32 = (s: string): Uint8Array => {
  const b = new TextEncoder().encode(s);
  if (b.length === 0 || b.length > 32) throw new Error(`cannot pad "${s}" to Bytes<32>`);
  const out = new Uint8Array(32);
  out.set(b);
  return out;
};

/** A deterministic 32-byte value from a public label. NOT a secret; see the header. */
const derivedKey = (purpose: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(`${purpose}:${DOMAIN}`).digest());

const secretFromEnv = (name: string, purpose: string): { bytes: Uint8Array; derived: boolean } => {
  const raw = process.env[name];
  if (!raw) return { bytes: derivedKey(purpose), derived: true };
  const bytes = hexToBytes(raw);
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes of hex`);
  return { bytes, derived: false };
};

// ── the `signet` profile's per-stack MPC root (project 00035) ────────────────
const WITH_SIGNET = /^(1|true|yes|on)$/i.test(process.env["AA_SIGNET"] ?? "");
const SIGNET_ROOT_PATH = `${OUT_DIR}/signet-root.env`;

/**
 * Write the root secret where the `signet` responder reads it. Mode 600, on the `aa-out`
 * volume, and written BEFORE the vault is deployed — so a crash between the two leaves a key
 * whose vault does not exist, which is recoverable, rather than a vault whose key does not.
 *
 * BOTH the generated and the operator-supplied key go through here, and that is the point.
 * The responder takes its key from this file and only from this file: `MPC_ROOT_KEY` is
 * deliberately not a compose value, so the private half never appears in a compose file or in
 * `docker inspect`. An `AA_MPC_ROOT_SECRET` that initialised the vault but was not written
 * here would produce a vault nothing can sign for — measured on the first live run of the
 * static-key configuration, where the responder refused to start with "no MPC root secret at
 * /aa/out/signet-root.env" and was right to.
 */
const writeSignetRoot = (bytes: Uint8Array, origin: string): void => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    SIGNET_ROOT_PATH,
    "# The `signet` profile's MPC root PRIVATE key — the other half of the key this stack's\n" +
      `# bridge vault was initialised against. Origin: ${origin}.\n` +
      "# The responder reads it from HERE and from nowhere else. NEVER copy it anywhere:\n" +
      "# `./down.sh -v` removes this volume, which is the only lifecycle that keeps a vault and\n" +
      "# its signer in step.\n" +
      `MPC_ROOT_KEY=0x${toHex(bytes)}\n`,
    { mode: 0o600 },
  );
  chmodSync(SIGNET_ROOT_PATH, 0o600);
};

/**
 * The 32-byte MPC root secret this stack's vault is initialised against, and which the
 * `signet` responder holds the other use of.
 *
 * Order: an explicit `AA_MPC_ROOT_SECRET` wins (an operator who holds a real root, and the
 * configuration a repeatable demo wants), then an existing `/aa/out/signet-root.env` (a re-run
 * against the same volume must reproduce the same vault), then a freshly generated one.
 *
 * It is never logged, never an argument and never leaves the volume. Only the PUBLIC half
 * reaches the receipt.
 */
const signetRootSecret = (): { bytes: Uint8Array; provenance: string; note: string } => {
  const fromEnv = process.env["AA_MPC_ROOT_SECRET"];
  if (fromEnv) {
    const bytes = hexToBytes(fromEnv);
    if (bytes.length !== 32) throw new Error("AA_MPC_ROOT_SECRET must be 32 bytes of hex");
    // Written to the volume too: the responder has no other way to learn it, and a vault
    // initialised against a key its signer does not hold is a vault nothing can sign for.
    writeSignetRoot(bytes, "AA_MPC_ROOT_SECRET, supplied by the operator");
    return {
      bytes,
      provenance: "fakenet",
      note: `supplied by the operator as AA_MPC_ROOT_SECRET, and written to ${SIGNET_ROOT_PATH} ` +
        "(mode 600) for the `signet` responder. A STATIC root re-initialises an identical vault " +
        "across ./down.sh -v, which is what a repeatable demo wants; the stack holds BOTH halves " +
        "either way, so this bridge is demo-grade by construction",
    };
  }
  if (existsSync(SIGNET_ROOT_PATH)) {
    const line = readFileSync(SIGNET_ROOT_PATH, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("MPC_ROOT_KEY="));
    if (!line) throw new Error(`${SIGNET_ROOT_PATH} exists but carries no MPC_ROOT_KEY=`);
    const bytes = hexToBytes(line.slice("MPC_ROOT_KEY=".length).trim());
    if (bytes.length !== 32) throw new Error(`${SIGNET_ROOT_PATH}: MPC_ROOT_KEY must be 32 bytes of hex`);
    return {
      bytes,
      provenance: "fakenet",
      note: `generated for this stack by an earlier aa-deploy and re-read from ${SIGNET_ROOT_PATH}; ` +
        "the stack holds BOTH halves, so this bridge is demo-grade by construction",
    };
  }
  const bytes = new Uint8Array(randomBytes(32));
  writeSignetRoot(bytes, "generated per stack by aa-deploy");
  return {
    bytes,
    provenance: "fakenet",
    note: `generated for this stack and written to ${SIGNET_ROOT_PATH} (mode 600) for the ` +
      "`signet` responder; the stack holds BOTH halves, so this bridge is demo-grade by construction",
  };
};

const contractRefArg = (address: string): { bytes: Uint8Array } => ({
  bytes: encodeContractAddress(address),
});

/** Deploy a witness-free contract and return a small handle. */
async function deployWitnessFree(
  walletCtx: any,
  name: string,
  module: any,
  zkPath: string,
  args: unknown[] = [],
) {
  const providers = await providersFor(walletCtx, zkPath);
  const compiled = CompiledContract.make(name, module.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkPath),
  );
  const deployed: any = await (deployContract as any)(providers, {
    compiledContract: compiled,
    privateStateId: name,
    initialPrivateState: {},
    ...(args.length > 0 ? { args } : {}),
  });
  const address = deployed.deployTxData.public.contractAddress as string;
  return {
    name,
    address,
    providers,
    call: async (circuit: string, ...callArgs: unknown[]) => {
      const r: any = await deployed.callTx[circuit](...callArgs);
      return { txId: r?.public?.txId ?? r?.public?.transactionHash ?? null, result: r };
    },
    ledgerState: async () => {
      const state = await providers.publicDataProvider.queryContractState(address);
      if (!state) throw new Error(`no contract state at ${address}`);
      return module.ledger(state.data);
    },
  };
}

const t0 = Date.now();

log(`passport ${String(BUILD.passportCommit).slice(0, 12)}… / compactc ${BUILD.compactcVersion} / runtime ${BUILD.compactRuntimeVersion}`);
log(`signet module @sig-net/midnight ${BUILD.signetPkgVersion} (sha256 ${String(BUILD.signetPkgSha256).slice(0, 16)}…)`);
log(`network ${CONFIG.networkId} node ${CONFIG.node} indexer ${CONFIG.indexer}`);

const seed = process.env["MIDNIGHT_WALLET_SEED"];
if (!seed) throw new Error("MIDNIGHT_WALLET_SEED is required");
const walletCtx = await openWallet(seed, "aa-deploy wallet");

// ── 1. the Signet singleton ──────────────────────────────────────────────────
log("deploying the Signet singleton (vendored source, recompiled — question Q20)…");
const singleton = await deployWitnessFree(walletCtx, "SignetSigner", SignetModule, SIGNET_ZK_PATH);
log(`  singleton ${singleton.address}`);

// ── 2. the vault ─────────────────────────────────────────────────────────────
// With `signet`, the stub is REFUSED rather than merely recorded: on that profile the vault
// pins a real EVM chain and a responder signs for it, and a root key whose private half is
// published in this file's comments would send every deposit to an address anybody can sweep.
const mpcRoot = WITH_SIGNET
  ? signetRootSecret()
  : { ...secretFromEnv("AA_MPC_ROOT_SECRET", "demo-infra:aa:mpc-root"), provenance: "", note: "" };
if (WITH_SIGNET) {
  log(`signet profile: per-stack MPC root — ${(mpcRoot as { note: string }).note}`);
} else if ((mpcRoot as { derived?: boolean }).derived === false) {
  log("AA_MPC_ROOT_SECRET supplied — the vault is initialised against an operator-held root");
}
const deployer = secretFromEnv("AA_VAULT_DEPLOYER_SECRET", "demo-infra:aa:vault-deployer");
const mpcRootPublic = normaliseSecp256k1PublicKey(
  formatSecp256k1PublicKey(secp256k1PublicKeyOf(mpcRoot.bytes)),
);
const deployerPublic = secp256k1PublicKeyOf(deployer.bytes);

log(`deploying the ERC20 vault (chain id ${EVM_CHAIN_ID}, MPC root ${mpcRootPublic.slice(0, 18)}…)…`);
const vault = await deployWitnessFree(
  walletCtx,
  "Erc20Vault",
  VaultModule,
  VAULT_ZK_PATH,
  [deployerPublic, contractRefArg(singleton.address)],
);
log(`  vault ${vault.address}`);

// Both values `initialise` pins are derived from the contract's OWN address, which does
// not exist until it is deployed — `kernel.self()` is the zero address in a constructor.
// That is the whole reason `initialise` is a separate circuit (PR-F).
const vaultEvmAddress = deriveVaultEvmAddress(mpcRootPublic, vault.address);
const responseKey = deriveMidnightResponseKey(mpcRootPublic, vault.address);
const responseKeyHex = formatSecp256k1PublicKey(responseKey);
log(`  vault EVM account ${vaultEvmAddress}`);
log(`  MPC response key  ${responseKeyHex.slice(0, 18)}…`);

const initDigest = vaultPureCircuits.initialiseDigest(
  { bytes: hexToBytes(vault.address) },
  hexToBytes(vaultEvmAddress),
  EVM_CHAIN_ID,
  responseKey,
);
const { r, s } = signAttestationDigest(initDigest, deployer.bytes);
log("initialising the vault (the deployer signature is the gate — no witness)…");
const init = await vault.call(
  "initialise",
  hexToBytes(vaultEvmAddress),
  EVM_CHAIN_ID,
  responseKey,
  { r, s },
);
const vaultState: any = await vault.ledgerState();
if (vaultState.initialised !== 1n) {
  throw new Error(`initialise did not take: initialised = ${String(vaultState.initialised)}`);
}
log(`  initialise tx ${init.txId}`);

// ── 3. the test faucet, and the two demo colours ─────────────────────────────
log("deploying the fork's test faucet (the retired Minter's replacement)…");
const faucet = await deployWitnessFree(walletCtx, "faucet", FaucetModule, FAUCET_ZK_PATH);
log(`  faucet ${faucet.address}`);

const walletState: any = await (await import("rxjs")).firstValueFrom(
  (walletCtx.wallet as any).state(),
);
const coinPk = coinPublicKeyBytes(walletState);
const userAddr = userAddressBytes(walletCtx);

// A faucet mint's COLOUR is not the argument: `mint_shielded(color, …)` passes its first
// argument to `mintShieldedToken` as the DOMAIN SEPARATOR, and the ledger derives the real
// colour as `tokenType(domain, <the minting contract>)`. Deriving it client-side with the
// ledger's own `rawTokenType` is what the fork's suites do; calling the contract's
// `unshielded_color` circuit would be a zero-effect call whose finalisation watch has been
// observed to hang the wallet SDK.
const colourOf = (label: string): { domain: Uint8Array; colour: string } => {
  const domain = pad32(`${DOMAIN}:${label}`);
  return { domain, colour: toHex(encodeRawTokenType(rawTokenType(domain, faucet.address))) };
};
// TWO shielded colours, because an offer needs two: same-colour legs net out and the kernel
// refuses the offer as NOT_A_SWAP. The `faucet` profile's six issuers are the demo's real
// token set; these exist so `aa-e2e.sh` needs no profile but its own, exactly as the
// retired Minter's TOKA colours did.
const shieldedA = colourOf("shielded-a");
const shieldedB = colourOf("shielded-b");
const unshielded = colourOf("unshielded");

log(`minting ${MINT_AMOUNT} of shielded-a to the deploy wallet…`);
const sMint = await faucet.call(
  "mint_shielded", shieldedA.domain, MINT_AMOUNT, randomBytes32(), { bytes: coinPk },
);
log(`  shielded-a colour ${shieldedA.colour.slice(0, 16)}… tx=${sMint.txId}`);

log(`minting ${MINT_AMOUNT} unshielded to the deploy wallet…`);
const uMint = await faucet.call("mint_unshielded", unshielded.domain, MINT_AMOUNT, {
  bytes: userAddr,
});
log(`  unshielded colour ${unshielded.colour.slice(0, 16)}… tx=${uMint.txId}`);

// ── 4. the receipt ───────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const waves = consoleWaves();
const artifact = {
  kind: "aa-passport-deploy-receipt",
  version: 2,
  network: CONFIG.networkId,
  domain: DOMAIN,
  build: BUILD,
  // What an account compiled against these bytes is bound to (spec FR-022). The account
  // fingerprint is here too: it is what tells an operator that a running console and a
  // deployed account came out of the same build.
  artefacts: ARTEFACTS,
  signet: { address: singleton.address },
  vault: {
    address: vault.address,
    initialiseTxId: init.txId,
    evmAddress: vaultEvmAddress,
    evmChainId: EVM_CHAIN_ID.toString(),
    deployerPublicKey: formatSecp256k1PublicKey(deployerPublic),
    mpcResponseKey: responseKeyHex,
    depositAddressForVaultItself: deriveDepositEvmAddress(mpcRootPublic, vault.address, {
      is_left: false,
      left: { bytes: new Uint8Array(32) },
      right: { bytes: hexToBytes(vault.address) },
    }),
  },
  mpc: {
    rootPublicKey: mpcRootPublic,
    // The value scripts/verify-signet.sh and the fakenet's own entrypoint gate on. "fakenet"
    // means a responder holds the other half of this key and the bridge can actually move
    // funds; "derived-from-AA_DOMAIN" means the opposite, loudly.
    provenance: WITH_SIGNET
      ? (mpcRoot as { provenance: string }).provenance
      : ((mpcRoot as { derived?: boolean }).derived ? "derived-from-AA_DOMAIN" : "AA_MPC_ROOT_SECRET"),
    note: WITH_SIGNET
      ? (mpcRoot as { note: string }).note
      : ((mpcRoot as { derived?: boolean }).derived
        ? "LOCAL STUB: the private half is sha256('demo-infra:aa:mpc-root:' + AA_DOMAIN) and is therefore public. No MPC runs on this stack unless the `signet` profile is up; the vault is initialised so accounts can be constructed, not so funds can cross a bridge."
        : "supplied by the operator as AA_MPC_ROOT_SECRET"),
    // The MPC's own response key for THIS vault, alongside the root. It is already under
    // `vault.mpcResponseKey`; repeated here because it is an MPC-derived value and
    // scripts/verify-signet.sh re-derives exactly these two, independently, inside the
    // responder's image.
    responseKey: responseKeyHex,
    // Only meaningful with `signet`: where the other half of the root lives on this stack.
    ...(WITH_SIGNET ? { secretFile: SIGNET_ROOT_PATH, attestation: "eth_call replay when the RPC has no debug_traceTransaction — demo-grade (00034 Q62)" } : {}),
  },
  testFaucet: {
    address: faucet.address,
    note: "the fork's contracts/faucet.compact — the retired AA-v3 Minter's replacement. mint_shielded/mint_unshielded take a DOMAIN SEPARATOR; the colour below is the ledger's tokenType(domain, faucet) derivation.",
    colours: {
      "shielded-a": { domain: toHex(shieldedA.domain), color: shieldedA.colour },
      "shielded-b": { domain: toHex(shieldedB.domain), color: shieldedB.colour },
      unshielded: { domain: toHex(unshielded.domain), color: unshielded.colour },
    },
  },
  mints: {
    shielded: { color: shieldedA.colour, tx: sMint.txId, recipient: "deploy wallet (coin public key)" },
    unshielded: { color: unshielded.colour, tx: uMint.txId, recipient: "deploy wallet (user address)" },
  },
  // What the console will deploy on every account it registers, so `verify-aa.sh` can
  // check a live account against the set this build intends rather than against a guess.
  accountPlan: {
    arms: ["evm"],
    circuits: consoleAccountCircuits(),
    waveOne: waves.waveOne,
    waveTwo: waves.waveTwo,
    retireAuthority: true,
    withBridge: BUILD.withBridge,
  },
  deployedAt: new Date().toISOString(),
  tookSeconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
log(`done in ${artifact.tookSeconds}s — wrote ${ARTIFACT_PATH}`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(0);
