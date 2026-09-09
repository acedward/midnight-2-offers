import { describe, expect, test } from "bun:test";
import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { bech32m } from "@scure/base";
import { parseMidnightBech32m } from "./midnight-bech32m.ts";

// A real undeployed shielded address (135 chars, public dev material) - the
// exact string that failed in the console with "invalid string length 135".
const SHIELDED =
  "mn_shield-addr_undeployed1h3ttdm04uqx4ce5dvlf2y34jrjpj3gr3p2gwyazgwy8nhn2nwe9wf2x8ql4vfung9x4h3eaexht7ns3sps5k05xqfuwe0ejj0qfyuccdwkuk7";

describe("parseMidnightBech32m", () => {
  test("decodes a 135-char shielded address the SDK's parse rejects", () => {
    expect(() => MidnightBech32m.parse(SHIELDED)).toThrow(/expected \(8\.\.90\)/);
    const m = parseMidnightBech32m(SHIELDED);
    expect(m.type).toBe("shield-addr");
    expect(m.network).toBe("undeployed");
    expect(m.data.length).toBe(64);
    const addr: any = m.decode(ShieldedAddress as any, "undeployed" as any);
    expect(String(addr.coinPublicKeyString())).toMatch(/^[0-9a-f]{64}$/);
    expect(String(addr.encryptionPublicKeyString())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("round-trips an unshielded address exactly like the SDK", () => {
    // The SDK's ENCODER has no length limit (asString passes `false`); only its
    // parser does. Encode through the SDK, parse through both, compare bytes.
    const short = MidnightBech32m.encode("undeployed" as any, new UnshieldedAddress(Buffer.alloc(32, 7)) as any).asString();
    expect(parseMidnightBech32m(short).data).toEqual(MidnightBech32m.parse(short).data);
    expect(parseMidnightBech32m(short).type).toBe("addr");
    expect(parseMidnightBech32m(short).network).toBe("undeployed");
  });

  test("refuses a non-Midnight prefix and garbage", () => {
    // A valid bech32m string whose HRP is not Midnight's: the prefix check fires.
    const foreign = bech32m.encode("xx_addr_undeployed", bech32m.toWords(Buffer.alloc(32, 9)), false);
    expect(() => parseMidnightBech32m(foreign)).toThrow(/Expected prefix mn/);
    // A Bitcoin address is bech32, not bech32m: the checksum fails first.
    expect(() => parseMidnightBech32m("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toThrow(/checksum/i);
    expect(() => parseMidnightBech32m("mn_shield-addr_undeployed1notbech32")).toThrow();
    expect(() => parseMidnightBech32m("")).toThrow(/empty/);
  });
});
