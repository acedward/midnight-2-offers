// faucet-mint.ts — prefund this stack's demo wallets with LOCAL test-token coins.
//
// WHY THIS FILE EXISTS (spec US3, plan P5.4, questions Q3 option A). Since kernel
// PRs #69/#70 the offer poster no longer mints: it SELECTS an existing coin of an
// exact base-unit amount out of its own wallet and never creates one. Inventory
// is therefore external, and on this stack "external" means the six
// mint-test-tokens issuers the `faucet` profile just deployed. This one-shot is
// the bridge between them.
//
// IT IS NOT A COPY OF `mint-wallet-test.ts`, and the differences are the point:
//
//   * IDEMPOTENT BY BALANCE. Upstream's runner mints unconditionally — it is
//     evidence, not provisioning. Compose re-runs a completed one-shot on EVERY
//     `up` (measured, demo T4.7), so an unconditional mint would add four more
//     coins to the poster every bring-up until the wallet was full of them. Here
//     each grant states a TARGET (`amount` x `coins`); the recipient's current
//     balance is read first and only the shortfall is minted, rounded up to whole
//     coins of `amount`.
//   * EXACT COIN SIZES. `poster-config.ts` selects a coin whose value equals
//     GIVE_AMOUNT exactly, so the mint amount is not the registry's faucet
//     amount but the one compose gives — the SAME `${OFFER_POSTER_GIVE_AMOUNT}`
//     the poster reads, so the two cannot drift.
//   * SEVERAL RECIPIENTS, ONE FEE PAYER. The deployer wallet (the only funded one
//     in this profile) pays every fee and signs every mint, exactly as it did for
//     the deployment. Recipients need no NIGHT and no DUST: they only receive.
//   * IT WAITS FOR DISCOVERY. After each mint it waits for the RECIPIENT's own
//     wallet to see the balance through its regular chain scan, which is what
//     makes the next run's idempotence check honest — and, for a shielded token,
//     proves the encrypted-output path (`additionalCoinEncPublicKeyMappings`)
//     that a third-party recipient depends on.
//
// It reads the plan from a JSON file rather than from argv or a mini-DSL in the
// environment, because a seed path per recipient does not survive shell quoting
// intact and because the entrypoint has to write the seed files anyway.
//
// Upstream code is imported, never re-implemented: the registry types and
// validator, the endpoint map, the seed validator and the funded-wallet wait all
// come from the pinned tree beside this file.
//
// WHERE IT LIVES, AND WHY IT IS SAFE THERE. The image copies it to
// `/app/contracts/v2/faucet-mint.ts`, beside upstream's own `deploy.ts` and
// `mint-wallet-test.ts`, so the generated contract modules and
// `contracts/v2/node_modules` resolve exactly as they do for them. It is an
// UNTRACKED file in that work tree, and that is deliberately harmless: the deploy
// and verify runners' provenance check
// (`scripts/lib/deployment-provenance.ts::resolveReproducibleSourceRevision`)
// scopes `git diff`/`git ls-files --others` to four declared paths —
// `contracts/v2/{shielded-token.compact,unshielded-token.compact,managed/shielded,managed/unshielded}`
// — and this file is under none of them. The image asserts that scoped tree is
// still clean after the copy.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract, withContractScopedTransaction } from "@midnight-ntwrk/midnight-js-contracts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { initializeMidnightProviders, MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { NetworkId } from "@midnightntwrk/wallet-sdk";
import pino from "pino";
import { filter, firstValueFrom, timeout } from "rxjs";
import * as Shielded from "./managed/shielded/contract/index.js";
import * as Unshielded from "./managed/unshielded/contract/index.js";
import { validateRegistry } from "../../packages/registry/src/semantic.js";
import type { NetworkKey, TokenRegistry } from "../../packages/registry/src/types.js";
import { waitForFundedDeploymentWallet } from "../../scripts/lib/deployment-wallet.js";
import { endpointConfig } from "../../scripts/lib/network-config.js";
import { validateMasterSeedHex } from "../../scripts/lib/wallet-seed.js";

interface Grant {
  label: string;
  seedFile: string;
  symbol: string;
  /** Base units per coin. Each mint creates exactly one coin of this value. */
  amount: string;
  /** How many such coins the recipient should end up holding. */
  coins: number;
}

const TIMEOUT_MS = Number(process.env.MN_TIMEOUT_MS ?? 600_000);
const networkKey = (process.env.MN_NETWORK?.trim() ?? "undeployed") as NetworkKey;
if (networkKey !== "undeployed") {
  throw new Error(`faucet-mint runs on 'undeployed' only (got '${networkKey}')`);
}
const endpoints = endpointConfig(networkKey);
const root = resolve(new URL("../..", import.meta.url).pathname);
const registryPath = process.env.MN_REGISTRY_FILE?.trim()
  ?? resolve(process.env.MN_METADATA_OUTPUT_DIR ?? "/registry", `metadata.${networkKey}.json`);
const planPath = process.env.FAUCET_MINT_PLAN_FILE?.trim();
if (!planPath) throw new Error("FAUCET_MINT_PLAN_FILE is required");

const readSeedFile = async (path: string, label: string): Promise<string> =>
  validateMasterSeedHex((await readFile(resolve(path), "utf8")).trim(), label);
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
const zero = new Uint8Array(32);
const moduleFor = (privacy: "shielded" | "unshielded") => (privacy === "shielded" ? Shielded : Unshielded);
const artifactPath = (privacy: "shielded" | "unshielded") =>
  resolve(root, "contracts", "v2", "managed", privacy);

const waitSynced = async (wallet: MidnightWalletProvider) =>
  firstValueFrom(wallet.wallet.state().pipe(filter((state) => state.isSynced), timeout({ first: TIMEOUT_MS })));

const withTimeout = async <T>(label: string, operation: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const balanceOf = (state: any, privacy: "shielded" | "unshielded", tokenId: string): bigint =>
  ((privacy === "shielded" ? state.shielded.balances : state.unshielded.balances)[tokenId] ?? 0n) as bigint;

// ── the plan, and the registry it is resolved against ────────────────────────
const plan = JSON.parse(await readFile(resolve(planPath), "utf8")) as { grants: Grant[] };
if (!Array.isArray(plan.grants) || plan.grants.length === 0) {
  console.log("[faucet-mint] the plan carries no grants — nothing to do");
  process.exit(0);
}

const registry = JSON.parse(await readFile(registryPath, "utf8")) as TokenRegistry;
const validation = validateRegistry(registry, networkKey);
if (!validation.ok || registry.status !== "ready" || registry.network.protocolFamily !== "midnight-2.x") {
  throw new Error(`A ready v2 registry is required at ${registryPath}: ${validation.ok ? registry.status : validation.errors.join("; ")}`);
}

const env = {
  walletNetworkId: NetworkId.NetworkId.Undeployed,
  networkId: endpoints.networkId,
  indexer: endpoints.indexer,
  indexerWS: endpoints.indexerWS,
  node: endpoints.node,
  nodeWS: endpoints.nodeWS,
  proofServer: endpoints.proofServer,
  faucet: undefined,
};
setNetworkId(endpoints.networkId);
const logger = pino({ level: "silent" });

// ── wallets: one issuer-caller, one per distinct recipient seed ──────────────
const issuer = await MidnightWalletProvider.build(logger, env, await readSeedFile(process.env.MN_SEED_FILE ?? "", "MN_SEED_FILE"));
const recipientSeeds = [...new Set(plan.grants.map((g) => g.seedFile))];
const recipients = new Map<string, MidnightWalletProvider>();
for (const seedFile of recipientSeeds) {
  recipients.set(seedFile, await MidnightWalletProvider.build(logger, env, await readSeedFile(seedFile, seedFile)));
}

let minted = 0;
let skipped = 0;
let operationError: unknown;
try {
  // `start(true)` on `undeployed` registers a wallet's NIGHT UTXOs for DUST when
  // it has none; with `faucet: undefined` in the provider config it never calls
  // a faucet client. For a recipient that holds no NIGHT it is a no-op, which is
  // correct — recipients only receive.
  const started = await Promise.allSettled([
    issuer.start(true),
    ...[...recipients.values()].map((w) => w.start(true)),
  ]);
  const failure = started.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;

  // The ISSUER must be able to pay a fee before anything else happens; the
  // recipients only have to be synced enough to report a balance.
  await withTimeout("issuer wallet funding", waitForFundedDeploymentWallet(issuer.wallet, TIMEOUT_MS));
  await Promise.all([...recipients.values()].map((w) => waitSynced(w)));

  for (const grant of plan.grants) {
    const token = registry.tokens.find((t) => t.symbol === grant.symbol);
    if (!token) {
      throw new Error(`${grant.label}: symbol "${grant.symbol}" is not in ${registryPath} (have: ${registry.tokens.map((t) => t.symbol).join(", ")})`);
    }
    const active = token.deployments.find((d) => d.deploymentId === token.activeDeploymentId && d.status === "active");
    if (!active) throw new Error(`${grant.label}: ${grant.symbol} has no active deployment`);

    const privacy = token.privacy as "shielded" | "unshielded";
    const recipient = recipients.get(grant.seedFile)!;
    const unit = BigInt(grant.amount);
    if (unit <= 0n) throw new Error(`${grant.label}: amount must be positive, got ${grant.amount}`);
    const target = unit * BigInt(grant.coins);

    let state = await waitSynced(recipient);
    let held = balanceOf(state, privacy, active.tokenId);
    if (held >= target) {
      skipped += 1;
      console.log(`[faucet-mint] ${grant.label} ${grant.symbol}: holds ${held} >= ${target} — nothing to mint`);
      continue;
    }
    // Round the shortfall UP to whole coins of `unit`: the poster matches on an
    // exact coin value, so a part-coin would be inventory it can never select.
    const wanted = Number((target - held + unit - 1n) / unit);
    console.log(`[faucet-mint] ${grant.label} ${grant.symbol}: holds ${held}, target ${target} — minting ${wanted} coin(s) of ${unit}`);

    const zkPath = artifactPath(privacy);
    const providers = initializeMidnightProviders(issuer, env, {
      privateStateStoreName: resolve(root, ".local", "faucet-mint"),
      zkConfigPath: zkPath,
    });
    const contractModule = moduleFor(privacy);
    const compiled = CompiledContract.make(`mint-test-token-${privacy}`, contractModule.Contract as never).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(zkPath),
    );
    const contract = await findDeployedContract(providers as never, {
      compiledContract: compiled as never,
      contractAddress: active.contractAddress,
    } as never);

    const coinPublicKey = recipient.getCoinPublicKey();
    const encryptionPublicKey = recipient.getEncryptionPublicKey();
    const userAddress = recipient.unshieldedKeystore.getAddress();

    for (let i = 0; i < wanted; i += 1) {
      const before = held;
      const finalized = await withTimeout(
        `${grant.label} ${grant.symbol} mint ${i + 1}/${wanted}`,
        privacy === "shielded"
          ? withContractScopedTransaction(
              providers as never,
              async (txContext) => {
                await contract.callTx.mint(
                  txContext,
                  { is_left: true, left: { bytes: bytes(coinPublicKey) }, right: { bytes: zero } },
                  unit,
                  Uint8Array.from(randomBytes(32)),
                );
              },
              // THE RECIPIENT IS A THIRD PARTY, so the transaction has to carry
              // the mapping from its coin public key to its ENCRYPTION public
              // key. Without it the output ciphertext is unreadable by the only
              // wallet entitled to it and the coin is, in practice, burnt.
              { additionalCoinEncPublicKeyMappings: new Map([[coinPublicKey, encryptionPublicKey]]) },
            )
          : withContractScopedTransaction(providers as never, async (txContext) => {
              await contract.callTx.mint(
                txContext,
                { is_left: false, left: { bytes: zero }, right: { bytes: bytes(userAddress) } },
                unit,
              );
            }),
      );
      state = await withTimeout(
        `${grant.label} ${grant.symbol} discovery ${i + 1}/${wanted}`,
        firstValueFrom(
          recipient.wallet.state().pipe(
            filter((s) => s.isSynced && balanceOf(s, privacy, active.tokenId) >= before + unit),
            timeout({ first: TIMEOUT_MS }),
          ),
        ),
      );
      held = balanceOf(state, privacy, active.tokenId);
      minted += 1;
      console.log(`[faucet-mint] ${grant.label} ${grant.symbol} coin ${i + 1}/${wanted} amount=${unit} tx=${finalized.public.txId} discovered=true balance=${held}`);
    }
  }
  console.log(`[faucet-mint] OK: ${minted} coin(s) minted, ${skipped} grant(s) already satisfied`);
} catch (error) {
  operationError = error;
  throw error;
} finally {
  const stopped = await Promise.allSettled([
    withTimeout("issuer wallet stop", issuer.stop(), 10_000),
    ...[...recipients.values()].map((w) => withTimeout("recipient wallet stop", w.stop(), 10_000)),
  ]);
  const failure = stopped.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure && operationError === undefined) throw failure.reason;
  if (failure) {
    console.error(`[wallet-stop] cleanup failed after the operation error: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
  }
}
