/**
 * One genuine CONTRACT-CIRCUIT proof for one ZKIR backend, offline.
 *
 * Companion to ../proof-fixture/real-proof.mjs. That fixture proves the Zswap lane whose
 * proving key lives IN the shared cache generation. This one proves a Compact contract
 * circuit, which by construction can never be cache-resident: FR-013 scopes the shared
 * generation to SRS + Ledger-static-9, so a contract's proving key must travel in the
 * request. The two halves therefore split cleanly, and the split is the whole point:
 *
 *   circuit prover/verifier/IR  -> carried in the request (asserted byte-for-byte below)
 *   universal SRS               -> read by the server from its read-only MIDNIGHT_PP
 *                                  generation, with the origin unreachable
 *
 * That is the only way a ZKIR-**v3** proof can be measured at all, which is why plan 00003
 * task T3.7 exists: the experimental rc.5 build links a zkir-v3 interpreter the plain build
 * does not have, and the difference is observable only when a v3 IR is POSTed.
 *
 * Request construction mirrors the vetted upstream provider
 * `@midnight-ntwrk/midnight-js-http-client-proof-provider` -> `httpClientProvingProvider`:
 * same ZKConfigRegistry key-location resolution, same createCheckPayload /
 * createProvingPayload / parseCheckResult calls. It is inlined only so the harness can
 * observe status codes, byte counts, timings and the server's error body, all of which the
 * upstream provider discards.
 *
 * Deliberately absent: wallet, node, indexer, contract deployment to a chain, business flow.
 * The "deploy" below never leaves this process — it exists solely to derive the contract
 * address and initial state that the call transaction needs.
 *
 * Usage:
 *   node zkir-proof.mjs --base http://aa-proof-server:6300 --artifact-root /artifacts/v3 \
 *     --backend zkir-v3 --role experimental --expect accept --output /out/zkir-v3.json
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Every ledger symbol comes through ONE module instance: two copies of the ledger wasm in a
// single process fail instanceof checks (the trap documented in the AA runner's package.json).
import * as P from "@midnight-ntwrk/midnight-js-protocol/ledger";
import * as compactJs from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import {
  createUnprovenCallTxFromInitialStates,
  createUnprovenDeployTxFromVerifierKeys,
} from "@midnight-ntwrk/midnight-js-contracts";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { ZKConfigRegistry, zkConfigToProvingKeyMaterial } from "@midnight-ntwrk/midnight-js-types";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { sampleSigningKey } from "@midnight-ntwrk/compact-runtime";

const CIRCUIT_ID = "bump";
const PUBLIC_RNG_SEED = Buffer.from("demo-infra/00003/T3.7/zkir-fixture/v1", "utf8");
const REJECTION_MARKER = "ZKIR_FIXTURE_PROOF_SERVER_REJECTED";

// The IR container header IS the ZKIR version. Asserting it on the committed artifact is what
// makes "this is a v3 proof" a measurement rather than a claim.
const IR_HEADER = Object.freeze({
  zkir: "midnight:ir-source[v2]:",
  "zkir-v3": "midnight:ir-source[v3-generic]:",
});
const EXPECTED_COMPILER = Object.freeze({
  "compiler-version": "0.33.0",
  "language-version": "0.25.0",
  "runtime-version": "0.18.0-rc.1",
});
// rc.5 maps an IR it cannot parse onto a generic 400 body; the specific
// "Unsupported ZKIR version" string lives in the plain executable, which run-gate.sh asserts
// separately against both variant binaries.
const DEFAULT_REJECTION_BODY = "^(bad input|.*unsupported zkir version.*)$";

const fail = (message) => {
  throw new Error(message);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseArgs(argv) {
  const values = {
    base: undefined,
    artifactRoot: undefined,
    backend: undefined,
    role: undefined,
    expect: "accept",
    output: undefined,
    expectVersion: "9.0.0-rc.5",
    expectRejectionBody: DEFAULT_REJECTION_BODY,
  };
  const map = {
    "--base": "base",
    "--artifact-root": "artifactRoot",
    "--backend": "backend",
    "--role": "role",
    "--expect": "expect",
    "--output": "output",
    "--expect-version": "expectVersion",
    "--expect-rejection-body": "expectRejectionBody",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = map[argv[index]];
    if (key === undefined || argv[index + 1] === undefined) fail(`invalid argument: ${argv[index]}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  for (const required of ["base", "artifactRoot", "backend", "role"]) {
    if (values[required] === undefined) fail(`missing --${required}`);
  }
  if (IR_HEADER[values.backend] === undefined) fail(`unknown backend: ${values.backend}`);
  if (values.expect !== "accept" && values.expect !== "reject") fail("--expect must be accept|reject");
  return values;
}

/**
 * Deterministic public randomness so a rerun produces the same contract address, preimage and
 * proving payload, and the recorded request evidence is comparable across runs. The seed is a
 * public constant; nothing secret is used. Only the REQUEST side is deterministic -- the
 * server's prover has its own randomness, so `provenTxSha256` legitimately differs run to run
 * and nothing asserts it.
 */
function installDeterministicCrypto() {
  let counter = 0n;
  const deterministic = Object.create(globalThis.crypto);
  Object.defineProperty(deterministic, "getRandomValues", {
    configurable: false,
    enumerable: true,
    value(target) {
      if (!ArrayBuffer.isView(target) || target instanceof DataView) {
        throw new TypeError("getRandomValues target must be an integer TypedArray");
      }
      const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Buffer.alloc(8);
        count.writeBigUInt64BE(counter);
        counter += 1n;
        const block = createHash("sha256").update(PUBLIC_RNG_SEED).update(count).digest();
        offset += block.copy(bytes, offset, 0, Math.min(block.length, bytes.length - offset));
      }
      return target;
    },
  });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: deterministic });
}

async function readArtifactIdentity(artifactRoot, backend) {
  const info = JSON.parse(await readFile(join(artifactRoot, "compiler", "contract-info.json"), "utf8"));
  for (const [field, expected] of Object.entries(EXPECTED_COMPILER)) {
    if (info[field] !== expected) fail(`${field} drift: ${info[field]} (expected ${expected})`);
  }
  if (info.circuits.length !== 1 || info.circuits[0].name !== CIRCUIT_ID) {
    fail(`fixture must expose exactly one circuit named ${CIRCUIT_ID}`);
  }
  if (info.circuits[0].proof !== true) fail(`${CIRCUIT_ID} is not a proving circuit`);
  if (info.witnesses.length !== 0) fail("fixture must declare no witnesses");

  const bzkir = await readFile(join(artifactRoot, "zkir", `${CIRCUIT_ID}.bzkir`));
  const header = IR_HEADER[backend];
  const observed = bzkir.subarray(0, 48).toString("latin1");
  if (!observed.startsWith(header)) {
    fail(`IR header mismatch for backend ${backend}: expected ${JSON.stringify(header)}, got ${JSON.stringify(observed.slice(0, 32))}`);
  }
  // The other backend's header must NOT be present: the two artifacts are provably different IR.
  for (const [otherBackend, otherHeader] of Object.entries(IR_HEADER)) {
    if (otherBackend !== backend && observed.startsWith(otherHeader)) {
      fail(`artifact at ${artifactRoot} carries the ${otherBackend} IR header`);
    }
  }
  const prover = await readFile(join(artifactRoot, "keys", `${CIRCUIT_ID}.prover`));
  const verifier = await readFile(join(artifactRoot, "keys", `${CIRCUIT_ID}.verifier`));
  return {
    compiler: {
      ...EXPECTED_COMPILER,
      backend,
      flag: backend === "zkir-v3" ? "--feature-zkir-v3" : "(default)",
    },
    irHeader: header,
    zkir: { bytes: bzkir.length, sha256: sha256(bzkir) },
    proverKey: { bytes: prover.length, sha256: sha256(prover) },
    verifierKey: { bytes: verifier.length, sha256: sha256(verifier) },
    raw: { bzkir, prover, verifier },
  };
}

async function post(url, payload, timeoutMs) {
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(payload),
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
 * Same rule as the upstream provider: canonical contract key locations
 * (`contract:<address>/<circuit>?vk=<hash>`) resolve through the registry's verifier-key
 * join; protocol builtins resolve to `undefined` and are supplied by the proof server from
 * its own cache.
 */
function makeKeyMaterialResolver(zkConfigProvider) {
  const registry = new ZKConfigRegistry([zkConfigProvider]);
  return async (keyLocation) => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    if (resolved !== undefined) return zkConfigToProvingKeyMaterial(resolved);
    try {
      return zkConfigToProvingKeyMaterial(await zkConfigProvider.get(keyLocation));
    } catch {
      return undefined;
    }
  };
}

function provingProvider(base, resolver, trace, captured, timeoutMs) {
  const call = async (operation, path, payload, keyLocation, keyMaterial) => {
    const response = await post(base + path, payload, timeoutMs);
    const entry = {
      operation,
      endpoint: path,
      keyLocation,
      status: response.status,
      elapsedMs: response.elapsedMs,
      requestBytes: payload.length,
      responseBytes: response.buffer.length,
      keyMaterialInRequest: keyMaterial !== undefined,
    };
    trace.push(entry);
    if (response.status !== 200) {
      entry.errorBody = Buffer.from(response.buffer).toString("utf8").slice(0, 600);
      fail(`${REJECTION_MARKER} ${operation} HTTP ${response.status}: ${entry.errorBody}`);
    }
    return response.buffer;
  };
  return {
    async check(serializedPreimage, keyLocation) {
      const keyMaterial = await resolver(keyLocation);
      const payload = P.createCheckPayload(serializedPreimage, keyMaterial?.ir);
      return P.parseCheckResult(await call("check", "/check", payload, keyLocation, keyMaterial));
    },
    async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
      const keyMaterial = await resolver(keyLocation);
      const payload = P.createProvingPayload(serializedPreimage, overwriteBindingInput, keyMaterial);
      // Kept out of the evidence record; used only for the embedded-key-bytes assertion.
      captured.provingPayload = Buffer.from(payload);
      const details = {
        preimageBytes: serializedPreimage.length,
        preimageSha256: sha256(serializedPreimage),
        provingPayloadBytes: payload.length,
        provingPayloadSha256: sha256(payload),
      };
      const buffer = await call("prove", "/prove", payload, keyLocation, keyMaterial);
      Object.assign(trace[trace.length - 1], details);
      return buffer;
    },
    lookupKey: resolver,
  };
}

async function buildUnprovenCall(artifactRoot, contractModule) {
  const compiledContract = compactJs.CompiledContract.make("zkir-fixture", contractModule.Contract).pipe(
    compactJs.CompiledContract.withWitnesses({}),
    compactJs.CompiledContract.withCompiledFileAssets(artifactRoot),
  );
  const zkConfigProvider = new NodeZkConfigProvider(artifactRoot);
  const coinPublicKey = P.sampleCoinPublicKey();
  const encryptionPublicKey = P.sampleEncryptionPublicKey();
  // In-process only: this derives the contract address and initial state the call needs. It
  // is never submitted anywhere; there is no node in this test.
  const deploy = await createUnprovenDeployTxFromVerifierKeys(
    zkConfigProvider,
    coinPublicKey,
    { compiledContract, signingKey: sampleSigningKey(), initialPrivateState: {}, args: [] },
    encryptionPublicKey,
  );
  const call = await createUnprovenCallTxFromInitialStates(
    zkConfigProvider,
    {
      compiledContract,
      circuitId: CIRCUIT_ID,
      contractAddress: deploy.public.contractAddress,
      args: [],
      coinPublicKey,
      initialContractState: deploy.public.initialContractState,
      initialZswapChainState: new P.ZswapChainState(),
      ledgerParameters: P.LedgerParameters.initialParameters(),
      initialPrivateState: {},
    },
    encryptionPublicKey,
  );
  return { call, zkConfigProvider, contractAddress: deploy.public.contractAddress };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  installDeterministicCrypto();
  setNetworkId("undeployed");

  const artifactRoot = resolve(args.artifactRoot);
  const identity = await readArtifactIdentity(artifactRoot, args.backend);

  const version = await get(args.base, "/version");
  if (version.status !== 200 || version.text !== args.expectVersion) {
    fail(`${args.role}: proof-server version drift: HTTP ${version.status} ${JSON.stringify(version.text)}`);
  }

  const contractModule = await import(pathToFileURL(join(artifactRoot, "contract", "index.js")).href);
  const { call, zkConfigProvider, contractAddress } = await buildUnprovenCall(artifactRoot, contractModule);

  const trace = [];
  const captured = {};
  const provider = provingProvider(args.base, makeKeyMaterialResolver(zkConfigProvider), trace, captured, 900000);

  const evidence = {
    schemaVersion: "proof-params-zkir-proof-v1",
    role: args.role,
    base: args.base,
    expectation: args.expect,
    proofServerVersion: version.text,
    proofVersions: (await get(args.base, "/proof-versions")).text,
    fixture: {
      kind: "compact-contract-circuit",
      source: "zkir-fixture.compact",
      circuitId: CIRCUIT_ID,
      artifactRoot,
      compiler: identity.compiler,
      irHeader: identity.irHeader,
      zkir: identity.zkir,
      proverKey: identity.proverKey,
      verifierKey: identity.verifierKey,
      circuitKeySource: "in-request proving data — never the shared proof-params generation",
      srsSource: "the server's read-only MIDNIGHT_PP generation",
      publicRngSeedSha256: sha256(PUBLIC_RNG_SEED),
      walletNodeIndexerChainDeployment: "none",
    },
    contractAddress: String(contractAddress),
    trace,
  };

  let proven;
  let rejection;
  const started = Date.now();
  try {
    proven = await call.private.unprovenTx.prove(provider, P.CostModel.initialCostModel());
  } catch (error) {
    // The wasm boundary re-wraps a thrown JS error, so the sentinel is matched by message
    // rather than by identity. Anything else must propagate.
    const message = error instanceof Error ? (error.message ?? "") : String(error);
    if (!message.includes(REJECTION_MARKER)) throw error;
    rejection = message.slice(message.indexOf(REJECTION_MARKER) + REJECTION_MARKER.length + 1);
  }
  evidence.elapsedMs = Date.now() - started;

  const checkEntry = trace.find((entry) => entry.operation === "check");
  const proveEntry = trace.find((entry) => entry.operation === "prove");
  const rejected = trace.find((entry) => entry.status !== 200);
  if (checkEntry === undefined) fail(`${args.role}: no /check request reached the proof server`);

  const emit = async () => {
    const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
    if (args.output) await writeFile(resolve(args.output), rendered, { encoding: "utf8", mode: 0o644 });
    process.stdout.write(rendered);
  };

  if (args.expect === "accept") {
    if (rejection !== undefined) {
      evidence.result = { accepted: false, unexpectedRejection: rejection, rejectedAt: rejected?.endpoint };
      await emit();
      fail(`${args.role}: expected acceptance but the server rejected: ${rejection}`);
    }
    if (proveEntry === undefined) fail(`${args.role}: no /prove request reached the proof server`);
    if (!proveEntry.keyMaterialInRequest) fail(`${args.role}: /prove carried no circuit proving data`);

    // Direct, falsifiable evidence that the CIRCUIT key travelled in the request rather than
    // being resolved from the server's cache: the exact prover/verifier/IR bytes must appear
    // inside the very payload that was POSTed to /prove.
    const payload = captured.provingPayload;
    if (payload === undefined) fail(`${args.role}: the proving payload was not captured`);
    for (const [name, bytes] of [
      ["proverKey", identity.raw.prover],
      ["verifierKey", identity.raw.verifier],
      ["zkir", identity.raw.bzkir],
    ]) {
      if (payload.indexOf(bytes) < 0) fail(`${args.role}: ${name} bytes are not embedded in the proving payload`);
    }
    const keyMaterialBytes = identity.proverKey.bytes + identity.verifierKey.bytes + identity.zkir.bytes;
    evidence.provingDataInRequest = {
      proverKeyEmbedded: true,
      verifierKeyEmbedded: true,
      zkirEmbedded: true,
      provingPayloadBytes: payload.length,
      preimageBytes: proveEntry.preimageBytes,
      keyMaterialBytes,
      keyMaterialShareOfRequest: `${((keyMaterialBytes / payload.length) * 100).toFixed(1)}%`,
    };

    const serialized = proven.serialize();
    evidence.result = {
      accepted: true,
      proveStatus: proveEntry.status,
      proveElapsedMs: proveEntry.elapsedMs,
      proofBytes: proveEntry.responseBytes,
      provenTxBytes: serialized.length,
      provenTxSha256: sha256(serialized),
    };
    await emit();
    return;
  }

  if (rejection === undefined || rejected === undefined) {
    evidence.result = { accepted: true, note: "expected a rejection" };
    await emit();
    fail(`${args.role}: expected a rejection but the proof SUCCEEDED`);
  }
  evidence.result = {
    accepted: false,
    rejectedAt: rejected.endpoint,
    status: rejected.status,
    errorBody: rejected.errorBody,
    keyMaterialInRejectedRequest: rejected.keyMaterialInRequest,
    note:
      "rc.5 answers an IR it cannot parse with a generic 400 body; the variant-specific" +
      " 'Unsupported ZKIR version' string is asserted against the executables by run-gate.sh",
  };
  await emit();
  if (!new RegExp(args.expectRejectionBody, "i").test(rejected.errorBody ?? "")) {
    fail(`${args.role}: rejection body ${JSON.stringify(rejected.errorBody)} does not match ${args.expectRejectionBody}`);
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
