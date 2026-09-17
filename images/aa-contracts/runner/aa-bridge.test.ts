// aa-bridge.test.ts — the bridge layer's arithmetic and its caps, with no chain and no RPC.
//
// WHY THIS EXISTS AS A BUILD GATE. A bridged WEENUS amount is 18 decimals: 10 WEENUS is
// 10^19, which is larger than Number.MAX_SAFE_INTEGER (9.007…×10^15). Every earlier token in
// this stack was 6 or 8 decimals, so a `Number` that slipped into an amount path would have
// been invisible until the first WEENUS deposit — on real Sepolia, after the tokens had
// already moved. These cases fix the contract: decimal string in, exact bigint out, and back.
//
// The Dockerfile runs it next to runner/midnight-bech32m.test.ts, so a regression stops the
// image rather than the demo.

import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cap ledger is a file; point it at a throwaway one BEFORE the module is imported.
process.env["AA_BRIDGE_STORE_PATH"] = join(mkdtempSync(join(tmpdir(), "aa-bridge-")), "store.json");
process.env["AA_BRIDGE_CAP_ETH"] = "0.05";

const {
  toRaw, fromRaw, formatEth, capDecimalFor, chargeCap, assertCapHeadroom, loadBridgeStore,
  assertLegCeiling, LEG_CEILING_RAW,
  GAS_BUDGET_WEI, GAS_FUNDING_WEI, EVM_GAS,
} = await import("./aa-bridge.ts");

test("18-decimal amounts survive as exact bigints", () => {
  expect(toRaw("10", 18)).toBe(10_000_000_000_000_000_000n);
  expect(toRaw("20", 18)).toBe(20_000_000_000_000_000_000n);
  expect(toRaw("0.000000000000000001", 18)).toBe(1n);
  // The value that would round through a double: 10^19 + 1.
  expect(fromRaw(10_000_000_000_000_000_001n, 18)).toBe("10.000000000000000001");
  expect(String(toRaw("10", 18))).toBe("10000000000000000000");
});

test("6-decimal amounts round-trip", () => {
  expect(toRaw("1", 6)).toBe(1_000_000n);
  expect(toRaw("0.5", 6)).toBe(500_000n);
  expect(fromRaw(1_000_000n, 6)).toBe("1");
  expect(fromRaw(1_500_000n, 6)).toBe("1.5");
  expect(fromRaw(0n, 6)).toBe("0");
});

test("more fraction digits than the token has is a refusal, never a truncation", () => {
  expect(() => toRaw("1.0000001", 6)).toThrow(/fraction digits/);
  expect(() => toRaw("-1", 6)).toThrow(/non-negative/);
  expect(() => toRaw("1e18", 18)).toThrow(/non-negative decimal/);
});

test("wei formatting is bigint-only", () => {
  expect(formatEth(1_500_000_000_000_000n)).toBe("0.0015");
  expect(formatEth(GAS_BUDGET_WEI)).toBe("0.0015");
  expect(formatEth(GAS_FUNDING_WEI)).toBe("0.002");
  expect(EVM_GAS.gasLimit * EVM_GAS.maxFeePerGas).toBe(GAS_BUDGET_WEI);
});

test("the owner's caps are the defaults, and an unknown token has none", () => {
  expect(capDecimalFor("USDC")).toBe("5");
  expect(capDecimalFor("weenus")).toBe("50");
  expect(capDecimalFor("SOMETHINGELSE")).toBe("0");
});

test("caps refuse before anything is spent, and accumulate", () => {
  // An uncapped token is refused outright rather than silently allowed.
  expect(() => assertCapHeadroom("NOCAP", 1n, 18, 0n)).toThrow(/no Sepolia spend cap/);

  chargeCap("WEENUS", toRaw("20", 18), 18, 0n);
  expect(loadBridgeStore().spent.tokens["WEENUS"]).toBe("20000000000000000000");
  chargeCap("WEENUS", toRaw("25", 18), 18, 0n);
  expect(() => assertCapHeadroom("WEENUS", toRaw("10", 18), 18, 0n)).toThrow(/cap exceeded for WEENUS/);
  // …and the refusal did not charge anything.
  expect(loadBridgeStore().spent.tokens["WEENUS"]).toBe("45000000000000000000");

  chargeCap("USDC", toRaw("1", 6), 6, GAS_FUNDING_WEI);
  expect(loadBridgeStore().spent.ethWei).toBe(String(GAS_FUNDING_WEI));
  // 0.05 ETH / 0.002 per leg = 25 legs; the 26th is refused.
  expect(() => assertCapHeadroom("USDC", 0n, 6, GAS_FUNDING_WEI * 25n)).toThrow(/ETH cap exceeded/);
});

test("one leg cannot carry more than the vault's Uint<64> mint API (question Q17)", () => {
  // Measured on real Sepolia: 20 WEENUS failed inside the start's proof with the CONTRACT's own
  // message — `assert(amount <= 18446744073709551615, "Amount exceeds Uint<64> max")` — after the
  // tokens had already been sent to the deposit address. The client refuses first now.
  expect(LEG_CEILING_RAW).toBe(18_446_744_073_709_551_615n);
  expect(() => assertLegCeiling("WEENUS", toRaw("18", 18), 18)).not.toThrow();
  expect(() => assertLegCeiling("WEENUS", LEG_CEILING_RAW, 18)).not.toThrow();
  expect(() => assertLegCeiling("WEENUS", LEG_CEILING_RAW + 1n, 18)).toThrow(/more than one bridge leg can carry/);
  expect(() => assertLegCeiling("WEENUS", toRaw("20", 18), 18)).toThrow(/18.446744073709551615 WEENUS/);
  // 1 USDC is nowhere near it, and neither is any plausible 6-decimal amount.
  expect(() => assertLegCeiling("USDC", toRaw("5", 6), 6)).not.toThrow();
});

beforeAll(() => { /* the store path is set at module load, above */ });
