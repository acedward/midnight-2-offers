// aa-bridge-dryrun.ts — raise ONE signing request and watch the responder answer it, with
// ZERO funds at risk on the EVM chain.
//
//   ./scripts/aa-bridge-dryrun.sh
//
// ── WHAT IT SETTLES (project 00035, question Q11) ───────────────────────────
// This stack compiles the Signet singleton with `--feature-zkir-v3`, so its verifier keys
// are `[v7]` and compose/aa.yml's rule is that a call proved against them needs the
// EXPERIMENTAL proof server. The responder proves its own `respond` write against that same
// singleton — and in project 00034's stagenet run the same responder image did it
// successfully against a PLAIN proof server. Those two facts cannot both be the whole story,
// and which one governs decides the URL `signet-fakenet` must be given.
//
// The owner's answer (Q11 option C) was: decide it empirically, on a request created LOCALLY,
// BEFORE any Sepolia funds move. That is this file.
//
// ── WHY IT COSTS NOTHING ────────────────────────────────────────────────────
// A deposit request's Ethereum leg is `transfer(vault, amount)` signed FROM the recipient's
// derived deposit address. The recipient here is a RANDOM 32-byte coin public key, so its
// deposit address is one nobody has ever funded and nobody will: it holds no tokens and no
// gas. The MPC signs anyway — signing is what the request asks for — and the signature is
// what this file measures. Nothing is broadcast, so no gas is spent and no token moves; the
// signed transaction is simply thrown away.
//
// What is left behind is ONE open request in the vault's deposit map, on a local chain that
// `./down.sh -v` wipes. It can never be settled into anything, because the mint is pinned to
// a recipient whose key nobody holds.
//
// ── WHAT A PASS MEANS ───────────────────────────────────────────────────────
// A signature on the singleton means the responder PROVED `respond` against the proof server
// it was configured with. That is the whole of the question: if the configured lane were
// wrong, the proof would fail and no signature would ever appear.

import "./passport-env.ts";

import { mkdirSync, writeFileSync } from "node:fs";
import * as Rx from "rxjs";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";

import * as VaultModule from "../passport/contracts/erc20-vault/managed/Erc20Vault/contract/index.js";
import { makeReader } from "../passport/contracts/erc20-vault/src/relayer.ts";
import { VAULT_DEPOSIT_REQUESTS_PATH } from "../passport/contracts/erc20-vault/src/index.ts";

import {
  CONFIG,
  VAULT_ZK_PATH,
  createWallet,
  hexToBytes,
  providersFor,
  toHex,
} from "./passport.ts";
import {
  EVM_GAS,
  MPC_PROVENANCE,
  SIGNET_ADDRESS,
  VAULT_ADDRESS,
  bridgeAvailability,
  bridgeConfigFor,
  depositAddressOf,
  fromRaw,
  recipientEither,
  resolveToken,
  type BridgeRecipient,
} from "./aa-bridge.ts";

const TAG = "[aa-bridge-dryrun]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
const fail = (msg: string): never => { console.error(`${TAG} FAIL ${msg}`); process.exit(1); };

const OUT = process.env["AA_BRIDGE_DRYRUN_OUT"] ?? "/aa/out/aa-bridge-dryrun.json";
const SEED = process.env["AA_CONSOLE_SEED"]
  ?? "aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0";
const SIGN_TIMEOUT_MS = Number(process.env["AA_BRIDGE_DRYRUN_TIMEOUT_MS"] ?? 600_000);
/** The proof server the RESPONDER was pointed at. Passed in by the shell wrapper, which reads
 *  it off the running container; recorded so the answer names the thing it proves. */
const RESPONDER_PROOF_SERVER = process.env["AA_BRIDGE_DRYRUN_PROOF_SERVER"] ?? "(not reported)";

const availability = bridgeAvailability();
if (!availability.available) fail(`the bridge is not available: ${availability.reasons.join("; ")}`);
log(`vault ${VAULT_ADDRESS} on EVM chain ${availability.chainId}, MPC provenance ${MPC_PROVENANCE}`);
log(`the responder's configured proof server: ${RESPONDER_PROOF_SERVER}`);

const token = await resolveToken(process.env["AA_BRIDGE_DRYRUN_TOKEN"] ?? "USDC");
const cfg = bridgeConfigFor(token.erc20);

// A recipient nobody can spend for, so the request can never become a claimable coin.
const throwaway = new Uint8Array(32);
globalThis.crypto.getRandomValues(throwaway);
const recipient: BridgeRecipient = {
  kind: "wallet", coinPublicKey: toHex(throwaway), encryptionPublicKey: toHex(new Uint8Array(32)),
};
const depositAddress = depositAddressOf(cfg, recipient);
log(`throwaway recipient; its deposit address on the EVM chain is ${depositAddress}`);
log("that address holds nothing, and nothing will be broadcast — this run spends no gas and moves no token");

// ── raise the request ────────────────────────────────────────────────────────
const walletCtx: any = await createWallet(SEED);
const t0 = Date.now();
let startTxId = "";
let requestId = "";
try {
  await Rx.firstValueFrom((walletCtx.wallet as any).state().pipe(
    Rx.throttleTime(5_000),
    Rx.filter((st: any) => st.isSynced === true),
    Rx.timeout({ each: 240_000, with: () => Rx.throwError(() => new Error("wallet sync timeout")) }),
  ));
  const providers = await providersFor(walletCtx, VAULT_ZK_PATH);
  const compiled = CompiledContract.make("Erc20Vault", (VaultModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(VAULT_ZK_PATH),
  );
  const handle: any = await (findDeployedContract as any)(providers, {
    contractAddress: VAULT_ADDRESS!,
    compiledContract: compiled,
    privateStateId: `Erc20Vault-dryrun-${Date.now().toString(36)}`,
    initialPrivateState: {},
  });
  const ledgerBefore = (VaultModule as any).ledger(
    (await providers.publicDataProvider.queryContractState(VAULT_ADDRESS!))!.data);
  const before = new Set([...(ledgerBefore.depositEventMap as any)].map((e: any) => toHex(Uint8Array.from(e[0]))));

  log("proving the vault's startDeposit at ROOT (vault → SignetSigner.signBidirectional)…");
  const r = await handle.callTx.startDeposit(
    0n, EVM_GAS.gasLimit, EVM_GAS.maxFeePerGas, EVM_GAS.maxPriorityFeePerGas, EVM_GAS.keyVersion,
    hexToBytes(token.erc20), 1n, recipientEither(recipient),
  );
  startTxId = String(r?.public?.txId ?? r?.public?.transactionHash ?? "");
  const ledgerAfter = (VaultModule as any).ledger(
    (await providers.publicDataProvider.queryContractState(VAULT_ADDRESS!))!.data);
  const after = [...(ledgerAfter.depositEventMap as any)].map((e: any) => toHex(Uint8Array.from(e[0])));
  requestId = after.filter((id) => !before.has(id)).pop() ?? after.pop() ?? "";
  if (!requestId) fail("the vault records no open deposit request after the start");
  log(`start tx ${startTxId}; request ${requestId} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
} finally {
  await (walletCtx.wallet as any).stop?.().catch(() => {});
}

// ── wait for the responder's SIGNATURE ───────────────────────────────────────
// This is the measurement. `getSignedEvmTransaction` returns only when a response event that
// recovers to the expected derived sender is on the singleton — which the responder can only
// post after PROVING `respond` against whichever proof server it was given.
const publicData = indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS);
const reader = makeReader({
  publicDataProvider: publicData,
  requesterContractAddress: VAULT_ADDRESS!.replace(/^0x/, "").toLowerCase(),
  requesterRequestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
  signetContractAddress: SIGNET_ADDRESS!.replace(/^0x/, "").toLowerCase(),
});

log(`waiting up to ${Math.round(SIGN_TIMEOUT_MS / 60000)} min for the MPC to sign as ${depositAddress}…`);
const tSign = Date.now();
let signed: any;
while (signed === undefined) {
  if (Date.now() - tSign > SIGN_TIMEOUT_MS) break;
  signed = await reader.getSignedEvmTransaction(requestId as never, depositAddress);
  if (signed === undefined) await new Promise((r) => setTimeout(r, 3000));
}
const waitedSeconds = Number(((Date.now() - tSign) / 1000).toFixed(1));

const verdict = signed !== undefined;
const report = {
  kind: "aa-bridge-dryrun",
  question: "Q11 — which proof server proves the fakenet's `respond` on this stack?",
  answeredAt: new Date().toISOString(),
  responderProofServer: RESPONDER_PROOF_SERVER,
  vault: VAULT_ADDRESS,
  signet: SIGNET_ADDRESS,
  evmChainId: availability.chainId,
  mpcProvenance: MPC_PROVENANCE,
  erc20: token.erc20,
  erc20Symbol: token.symbol,
  amountRaw: "1",
  amount: fromRaw(1n, token.decimals),
  recipient: "a RANDOM throwaway coin public key — the mint could never be claimed",
  depositAddress,
  startTxId,
  requestId,
  signed: verdict,
  waitedSeconds,
  signedBy: verdict ? String(signed.from) : null,
  signedTo: verdict ? String(signed.to) : null,
  signedNonce: verdict ? String(signed.nonce) : null,
  broadcast: false,
  evmFundsMoved: false,
  note: verdict
    ? "the responder proved `respond` against the proof server named above and posted a signature "
      + "that recovers to the expected derived sender. Nothing was broadcast, so no gas was spent."
    : "no signature appeared within the timeout. Either the responder could not PROVE `respond` "
      + "against the configured proof server (flip SIGNET_PROOF_SERVER_URL and re-run), or it is "
      + "not watching this singleton / not allow-listed to this vault — check its log.",
};
mkdirSync(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
log(`report → ${OUT}`);

if (!verdict) {
  fail(`no signature within ${Math.round(SIGN_TIMEOUT_MS / 60000)} min — see ${OUT} and the signet-fakenet log`);
}
if (String(signed.from).toLowerCase() !== depositAddress.toLowerCase()) {
  fail(`the MPC signed as ${String(signed.from)}, expected the derived deposit address ${depositAddress}`);
}
log(`SIGNED in ${waitedSeconds}s by ${String(signed.from)} → ${String(signed.to)} nonce ${String(signed.nonce)}`);
log(`Q11 ANSWERED: the responder proves 'respond' against ${RESPONDER_PROOF_SERVER}`);
log("nothing was broadcast; no gas was spent and no token moved");
