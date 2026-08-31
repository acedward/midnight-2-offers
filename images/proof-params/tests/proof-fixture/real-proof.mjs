/**
 * One representative REAL proof against the shared proof-data cache, offline.
 *
 * Why this fixture and not a contract circuit: the standard Zswap lane's proving key
 * (`zswap/9/output.prover`) lives IN the cache generation. The proof-server resolves it
 * from MIDNIGHT_PP using the `key_location` string carried inside the proof preimage, so
 * the request supplies `option(proving-data) = None` and no external prover key exists
 * anywhere in this test. That makes the proof a direct measurement of the thing Phase 3
 * owns: can a reader actually PROVE from the fixed read-only generation with the origin
 * unreachable.
 *
 * Deliberately absent: wallet, node, indexer, contract compilation, deployment, business
 * flow. A Zswap *output* needs no Merkle/chain data, which is what keeps this to one
 * library call. (A Zswap *input* would need a qualified coin from real chain state.)
 *
 * Usage: node real-proof.mjs --base http://proof-server:6300 --role plain --output x.json
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import * as L from "@midnightntwrk/ledger-v9";

const EXPECTED_KEY_LOCATION = "midnight/zswap/output";
const PUBLIC_SEED_BYTE = 7;

function parseArgs(argv) {
  const values = { base: undefined, role: undefined, output: undefined, expectVersion: "9.0.0-rc.5" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = { "--base": "base", "--role": "role", "--output": "output", "--expect-version": "expectVersion" }[argv[index]];
    if (key === undefined || argv[index + 1] === undefined) throw new Error(`invalid argument: ${argv[index]}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  for (const required of ["base", "role"]) {
    if (values[required] === undefined) throw new Error(`missing --${required}`);
  }
  return values;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function post(base, path, body, timeoutMs = 600000) {
  const started = Date.now();
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buffer = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, elapsedMs: Date.now() - started, buffer };
}

async function get(base, path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
  return { status: response.status, text: await response.text() };
}

/**
 * Build an unproven single-output Zswap transaction and capture the exact preimage the
 * ledger would hand a proving provider. The spy provider throws so nothing is proved
 * locally -- the real proving must happen server-side, from the server's own cache.
 */
async function capturePreimage() {
  const secretKeys = L.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(PUBLIC_SEED_BYTE));
  const coin = L.createShieldedCoinInfo(L.sampleRawTokenType(), 1000n);
  const output = L.ZswapOutput.new(coin, undefined, secretKeys.coinPublicKey, secretKeys.encryptionPublicKey);
  const transaction = L.Transaction.fromParts("undeployed", L.ZswapOffer.fromOutput(output));

  let captured;
  // The WASM boundary re-wraps a thrown JS error, so the sentinel is matched by message
  // rather than by identity. Anything else must propagate.
  const SENTINEL = "PROOF_PARAMS_PREIMAGE_CAPTURED";
  const sentinel = new Error(SENTINEL);
  try {
    await transaction.prove(
      {
        async check() {
          return [];
        },
        async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
          captured = { serializedPreimage, keyLocation, overwriteBindingInput };
          throw sentinel;
        },
        async lookupKey() {
          return undefined;
        },
      },
      L.CostModel.initialCostModel(),
    );
    throw new Error("preimage capture unexpectedly completed a local proof");
  } catch (error) {
    const message = error instanceof Error ? (error.message ?? "") : String(error);
    if (!message.includes(SENTINEL)) throw error;
  }
  if (captured === undefined) throw new Error("no proof preimage was captured");
  return { transaction, ...captured };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const version = await get(args.base, "/version");
  if (version.status !== 200 || version.text !== args.expectVersion) {
    throw new Error(`${args.role}: proof-server version drift: HTTP ${version.status} ${JSON.stringify(version.text)}`);
  }

  const captured = await capturePreimage();
  if (captured.keyLocation !== EXPECTED_KEY_LOCATION) {
    throw new Error(`${args.role}: unexpected key location ${captured.keyLocation}`);
  }

  // option(proving-data) = None and option(fr-bls) = None: the server MUST resolve
  // zswap/9/output.prover from its own read-only MIDNIGHT_PP generation.
  const provingPayload = L.createProvingPayload(captured.serializedPreimage, undefined, undefined);
  const trailingOptions = Buffer.from(provingPayload.slice(-2)).toString("hex");
  if (trailingOptions !== "0000") {
    throw new Error(`${args.role}: request unexpectedly carries key material (trailing options ${trailingOptions})`);
  }

  const checkPayload = L.createCheckPayload(captured.serializedPreimage, undefined);
  const checked = await post(args.base, "/check", checkPayload);
  if (checked.status !== 200) {
    throw new Error(`${args.role}: /check failed: HTTP ${checked.status} ${Buffer.from(checked.buffer).toString("utf8").slice(0, 300)}`);
  }

  const proved = await post(args.base, "/prove", provingPayload);
  if (proved.status !== 200) {
    throw new Error(`${args.role}: /prove failed: HTTP ${proved.status} ${Buffer.from(proved.buffer).toString("utf8").slice(0, 300)}`);
  }
  // Round-trip the response through the ledger library: a genuine proof object, not an echo.
  const deserialized = L.Proof.deserialize(proved.buffer);
  if (deserialized === undefined || deserialized === null) {
    throw new Error(`${args.role}: /prove response did not deserialize as a Proof`);
  }

  const evidence = {
    schemaVersion: "proof-params-real-proof-v1",
    role: args.role,
    base: args.base,
    proofServerVersion: version.text,
    proofVersions: (await get(args.base, "/proof-versions")).text,
    fixture: {
      kind: "zswap-output",
      lane: "standard",
      keyLocation: captured.keyLocation,
      proverKeySuppliedByCaller: false,
      proverKeyResolvedFrom: "MIDNIGHT_PP generation (zswap/9/output.prover)",
      publicSeedByte: PUBLIC_SEED_BYTE,
      walletNodeIndexerContract: "none",
    },
    request: {
      preimageBytes: captured.serializedPreimage.length,
      preimageSha256: sha256(captured.serializedPreimage),
      provingPayloadBytes: provingPayload.length,
      provingPayloadSha256: sha256(provingPayload),
      trailingOptionBytes: trailingOptions,
    },
    check: { status: checked.status, elapsedMs: checked.elapsedMs, bytes: checked.buffer.length },
    prove: {
      status: proved.status,
      elapsedMs: proved.elapsedMs,
      bytes: proved.buffer.length,
      sha256: sha256(proved.buffer),
      deserializedAs: deserialized.constructor?.name ?? "Proof",
    },
  };

  const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.output) writeFileSync(args.output, rendered, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(rendered);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
