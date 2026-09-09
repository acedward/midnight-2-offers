// parseMidnightBech32m — MidnightBech32m.parse() with a Midnight-sized length limit.
//
// `@midnightntwrk/wallet-sdk-address-format` (4.0.0-beta.2, unchanged through
// 4.0.0-beta.3) implements `MidnightBech32m.parse()` as
// `bech32m.decodeToBytes(str)` — the bech32 DEFAULT limit of 90 characters, which
// is Bitcoin's. A Midnight shielded address (`mn_shield-addr_<network>1…`, coin
// public key + encryption public key = 64 bytes) is 135 characters on
// `undeployed`, so the SDK's parse throws `invalid string length 135, expected
// (8..90)` for EVERY shielded address, and the console's send / withdraw paths
// could never accept a pasted mn_shield-addr… (infra issue 00023).
//
// This helper is the same algorithm with the limit the bech32m spec allows for
// non-Bitcoin uses (1023) and the same prefix/segment validation the SDK's own
// constructor performs. It returns the SDK's MidnightBech32m, so `.decode(...)`
// with the SDK's ShieldedAddress / UnshieldedAddress codecs works unchanged.
import { MidnightBech32m, mainnet } from "@midnightntwrk/wallet-sdk-address-format";
import { bech32m } from "@scure/base";

/** bech32m's own ceiling for non-Bitcoin encodings; Midnight addresses are <= ~140. */
export const MIDNIGHT_BECH32M_LIMIT = 1023;

export function parseMidnightBech32m(input: string): MidnightBech32m {
  const s = String(input ?? "").trim();
  if (!s) throw new Error("empty address");
  const parsed = bech32m.decodeToBytes(s, MIDNIGHT_BECH32M_LIMIT);
  const [prefix, type, network] = parsed.prefix.split("_");
  if (prefix !== "mn") throw new Error(`Expected prefix mn, got ${JSON.stringify(prefix)}`);
  if (!type) throw new Error("address carries no type segment (mn_<type>[_<network>]1...)");
  // The SDK's constructor re-validates both segments (letters, digits, hyphen).
  return new MidnightBech32m(type, (network ?? mainnet) as any, Buffer.from(parsed.bytes));
}
