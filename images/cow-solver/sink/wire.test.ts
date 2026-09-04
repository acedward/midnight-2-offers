// Pins the sink's relay-faithful predicates to the SAME frozen fixtures the
// kernel's solver-core pins, so the two cannot drift apart silently.
//
// Run:  bun test images/cow-solver/sink
//
// `fixtures/relay-ws/v1/` here is a byte-copy of
// `packages/solver-core/fixtures/relay-ws/v1/` in the kernel repo, MANIFEST.sha256
// included. The first test re-verifies every hash, so a copy that was edited fails
// here rather than at 3am against a live solver.
//
// WHAT THAT TEST CANNOT SEE is an upstream change: it hashes the local files
// against the local manifest, so both moving together would still pass. The
// manifest is therefore checked BY HAND against the kernel pin whenever the pin
// moves. Last compared 2026-09-03 at
// `4af102536f02f137b696a4734bd8c936eddf3672` (branch `ledger-v9`, PR #65):
// all seven hashes IDENTICAL to the copy here, so the wire contract did not move
// across the whole PR #50 → PR #65 range.

import { expect, test, describe } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  interpolateQuote,
  isAmountString,
  isCapabilityTokenId,
  isPriceLevelsPair,
  frameKind,
  parsePriceLevels,
  parseSolverCapabilities,
} from "./wire.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "relay-ws", "v1");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("fixture integrity", () => {
  test("every fixture matches the manifest copied from the kernel repo", () => {
    const manifest = readFileSync(join(FIXTURES, "MANIFEST.sha256"), "utf8");
    const expected = new Map<string, string>();
    for (const line of manifest.split("\n")) {
      const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
      if (match) expected.set(match[2]!, match[1]!);
    }
    expect(expected.size).toBe(7);

    for (const [name, hash] of expected) {
      const actual = createHash("sha256").update(readFileSync(join(FIXTURES, name))).digest("hex");
      expect(`${name}:${actual}`).toBe(`${name}:${hash}`);
    }
  });

  test("the manifest covers every json file present", () => {
    const present = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
    expect(present).toEqual([
      "job-error.json",
      "price-levels.json",
      "solver-capabilities.json",
      "submit-failed.json",
      "swap-tx.json",
      "swap.json",
      "tx-submitted.json",
    ]);
  });
});

describe("solver-capabilities", () => {
  test("the canonical frame is accepted and lowercased", () => {
    const parsed = parseSolverCapabilities(read("solver-capabilities.json"));
    expect(parsed).not.toBeNull();
    expect(parsed!.tokenIds).toEqual([
      "0100000000000000000000000000000000000000000000000000000000000000",
      "0200000000000000000000000000000000000000000000000000000000000000",
    ]);
    expect(parsed!.maxParallelSwaps).toBe(8);
  });

  test("an empty token list is valid — it is the solver's withdrawal", () => {
    const parsed = parseSolverCapabilities({ type: "solver-capabilities", tokenIds: [] });
    expect(parsed).not.toBeNull();
    expect(parsed!.tokenIds).toEqual([]);
  });

  test("one non-64-hex token id rejects the WHOLE frame", () => {
    expect(parseSolverCapabilities({ type: "solver-capabilities", tokenIds: ["ab"] })).toBeNull();
    expect(
      parseSolverCapabilities({
        type: "solver-capabilities",
        tokenIds: ["0".repeat(64), "zz" + "0".repeat(62)],
      }),
    ).toBeNull();
  });

  test("a bad maxParallelSwaps still registers the tokens — the relay's asymmetry", () => {
    for (const bad of [0, -1, 2.5, "8", null]) {
      const parsed = parseSolverCapabilities({
        type: "solver-capabilities",
        tokenIds: ["0".repeat(64)],
        maxParallelSwaps: bad,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.tokenIds).toEqual(["0".repeat(64)]);
      expect(parsed!.maxParallelSwaps).toBeUndefined();
    }
  });

  test("isCapabilityTokenId accepts mixed case, rejects wrong length", () => {
    expect(isCapabilityTokenId("A".repeat(64))).toBe(true);
    expect(isCapabilityTokenId("a".repeat(63))).toBe(false);
    expect(isCapabilityTokenId("a".repeat(65))).toBe(false);
  });
});

describe("price-levels", () => {
  test("the canonical frame is accepted with all four rungs", () => {
    const parsed = parsePriceLevels(read("price-levels.json"));
    expect(parsed).not.toBeNull();
    expect(parsed!.levels).toHaveLength(1);
    expect(parsed!.levels[0]!.levels).toHaveLength(4);
    expect(parsed!.levels[0]!.tokenIn).toBe(
      "0200000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test("an empty levels array is accepted — the fail-closed withdrawal", () => {
    const parsed = parsePriceLevels({ type: "price-levels", levels: [] });
    expect(parsed).not.toBeNull();
    expect(parsed!.levels).toEqual([]);
  });

  test("rungs must be STRICTLY ascending in input", () => {
    const pair = (levels: unknown[]) => ({ tokenIn: "a", tokenOut: "b", levels });
    expect(isPriceLevelsPair(pair([{ input: "1", output: "1" }, { input: "2", output: "2" }]))).toBe(true);
    // equal inputs
    expect(isPriceLevelsPair(pair([{ input: "1", output: "1" }, { input: "1", output: "2" }]))).toBe(false);
    // descending
    expect(isPriceLevelsPair(pair([{ input: "2", output: "1" }, { input: "1", output: "2" }]))).toBe(false);
  });

  test("token ids are NOT required to be 64-hex here — relay-faithful, not stricter", () => {
    expect(
      isPriceLevelsPair({ tokenIn: "not-hex", tokenOut: "also-not-hex", levels: [] }),
    ).toBe(true);
  });

  test("amounts must be decimal integer strings", () => {
    expect(isAmountString("0")).toBe(true);
    expect(isAmountString("000123")).toBe(true);
    expect(isAmountString("-1")).toBe(false);
    expect(isAmountString("1.5")).toBe(false);
    expect(isAmountString("0x10")).toBe(false);
    expect(isAmountString(10)).toBe(false);
  });
});

describe("interpolateQuote — what a published ladder commits the solver to", () => {
  const levels = (read("price-levels.json") as any).levels[0].levels;

  test("exact rungs quote their own output", () => {
    expect(interpolateQuote(levels, 10n)).toBe(20n);
    expect(interpolateQuote(levels, 25n)).toBe(35n);
  });

  test("between rungs it floors a linear interpolation", () => {
    // 10→20 and 15→25 : at 12 the exact value is 22
    expect(interpolateQuote(levels, 12n)).toBe(22n);
  });

  test("outside the ladder the relay refuses", () => {
    expect(interpolateQuote(levels, 9n)).toBeNull();
    expect(interpolateQuote(levels, 26n)).toBeNull();
  });

  test("an empty ladder quotes nothing — the withdrawal really withdraws", () => {
    expect(interpolateQuote([], 1n)).toBeNull();
  });
});

describe("frameKind — the observation-mode alarm surface", () => {
  test("classifies each canonical solver→relay frame", () => {
    expect(frameKind(read("solver-capabilities.json"))).toBe("solver-capabilities");
    expect(frameKind(read("price-levels.json"))).toBe("price-levels");
    // These two are UNREACHABLE in observation mode: the sink dispatches no
    // jobs, so the solver has nothing to answer. Classified so the server can
    // raise them as an alarm rather than ignore them.
    expect(frameKind(read("swap-tx.json"))).toBe("swap-tx");
    expect(frameKind(read("job-error.json"))).toBe("job-error");
  });

  test("relay→solver frames are not solver frames", () => {
    for (const name of ["swap.json", "tx-submitted.json", "submit-failed.json"]) {
      expect(frameKind(read(name))).toBe("unknown");
    }
  });
});
