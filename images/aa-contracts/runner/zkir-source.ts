// zkir-source.ts — WHICH compiler produced the Manager circuits this process is about
// to prove and deploy, read off the image and cross-checked against the release that
// supplied them.
//
// WHY THIS EXISTS AS A MODULE
//   Three processes need the same answer for three different reasons: `deploy-aa.ts`
//   writes it into the deploy receipt (so `verify.sh` can assert what is live on this
//   chain), `aa-console.ts` prints it before every `execute` proof (so an operator
//   watching a deposit knows which artifact is being proved and roughly how long to
//   expect), and `aa-e2e.ts` records it next to its timings (so a measurement is
//   attributable). Three copies of this logic would be three chances to report a
//   different answer than the one the image actually holds.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//   It hashes the key files that are ACTUALLY ON DISK at the path the zk-config provider
//   reads from, and compares them with `manifest.json` — the release's own record, which
//   the image build already tied to a pinned `SHA256SUMS`. So `verifierMatches: true`
//   means "the verifying key this deploy is about to register is byte-for-byte the one
//   the pinned release published for this circuit". It does NOT re-verify the release
//   (the build did that, fail-closed) and it does not read the key back off the chain.
//
// The compactc path answers `{ source: "compactc" }` and nothing else, because there is
// nothing else true to say: compactc's own artifact carries no release identity.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type FileId = { bytes: number; sha256: string };

export type ZkirCircuitReceipt = {
  k: number | null;
  rows: number | null;
  srs: string | null;
  /** what the release says this circuit's keys are */
  published: { verifier: FileId | null; prover: FileId | null };
  /** what is actually in this image at the path the provider reads */
  deployed: { verifier: FileId | null; prover: FileId | null };
  verifierMatches: boolean;
  proverMatches: boolean | null;
};

export type ZkirSourceReceipt =
  | { source: "compactc" }
  | {
      source: "minocrab" | "minocrab-all";
      release: string;
      repository: string;
      portCommit: string;
      sumsSha256: string;
      minocrabRev: string;
      contractCommit: string;
      fetchMode: string;
      toolchain: Record<string, string>;
      proverKeysInImage: boolean;
      circuits: Record<string, ZkirCircuitReceipt>;
    };

const readTrim = (p: string): string => readFileSync(p, "utf-8").trim();

const idOf = (p: string): FileId | null => {
  if (!existsSync(p)) return null;
  return {
    bytes: statSync(p).size,
    sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
  };
};

const same = (a: FileId | null, b: FileId | null): boolean =>
  a !== null && b !== null && a.bytes === b.bytes && a.sha256 === b.sha256;

/**
 * Read the zkir-source receipt for the Manager artifact in `root` (the image root).
 * Never throws on a missing label: an image built before this existed answers
 * `{ source: "compactc" }`, which is what it was.
 */
export function zkirSourceReceipt(root = "/aa"): ZkirSourceReceipt {
  const label = resolve(root, ".aa-zkir-source");
  const source = existsSync(label) ? readTrim(label) : "compactc";
  if (source !== "minocrab" && source !== "minocrab-all") return { source: "compactc" };

  const manifest = JSON.parse(readFileSync(resolve(root, ".minocrab-manifest.json"), "utf-8"));
  const circuitNames = readTrim(resolve(root, ".minocrab-circuits")).split(/\s+/).filter(Boolean);
  const keys = resolve(root, "contract-manager", "src", "managed", "keys");

  const circuits: Record<string, ZkirCircuitReceipt> = {};
  let proverKeysInImage = false;
  for (const c of circuitNames) {
    const rec = manifest.circuits?.[c] ?? {};
    const deployedVerifier = idOf(resolve(keys, `${c}.verifier`));
    const deployedProver = idOf(resolve(keys, `${c}.prover`));
    if (deployedProver) proverKeysInImage = true;
    const publishedVerifier = rec.verifier ?? null;
    const publishedProver = rec.prover ?? null;
    circuits[c] = {
      k: rec.k ?? null,
      rows: rec.rows ?? null,
      srs: rec.srs ?? null,
      published: { verifier: publishedVerifier, prover: publishedProver },
      deployed: { verifier: deployedVerifier, prover: deployedProver },
      verifierMatches: same(deployedVerifier, publishedVerifier),
      // `null`, not `false`, when the key was pruned: "we did not ship it" and
      // "we shipped the wrong one" are different facts and must not read alike.
      proverMatches: deployedProver === null ? null : same(deployedProver, publishedProver),
    };
  }

  return {
    source,
    release: readTrim(resolve(root, ".minocrab-release")),
    repository: manifest.repository,
    portCommit: readTrim(resolve(root, ".minocrab-commit")),
    sumsSha256: readTrim(resolve(root, ".minocrab-sums-sha256")),
    minocrabRev: manifest.minocrabRev,
    contractCommit: manifest.contractPin?.commit,
    fetchMode: readTrim(resolve(root, ".minocrab-fetch-mode")),
    toolchain: {
      compactcVersion: manifest.toolchain?.compactcVersion,
      compactcLanguageVersion: manifest.toolchain?.compactcLanguageVersion,
      zkirV3Sha256: manifest.toolchain?.zkirV3Sha256,
    },
    proverKeysInImage,
    circuits,
  };
}

/** One line for a log: what will be proved, and with whose artifact. */
export function zkirSourceLine(r: ZkirSourceReceipt, circuit = "execute"): string {
  if (r.source === "compactc") return "compactc artifact (k=19 for execute)";
  const c = r.circuits[circuit];
  const k = c?.k != null ? `k=${c.k}` : "k=?";
  const rows = c?.rows != null ? `, ${c.rows.toLocaleString("en-US")} rows` : "";
  return `MinoCrab ${r.release} (${r.portCommit.slice(0, 12)}…) — ${circuit} at ${k}${rows}`;
}
