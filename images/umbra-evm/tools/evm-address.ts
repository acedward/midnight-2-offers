/**
 * Prints the EVM address a Midnight unshielded wallet maps to.
 *
 *   npx tsx tools/evm-address.ts [--net <networkId>] <seed-hex | mn_addr...> ...
 *
 * Output is one TAB-separated line per input, so shell callers need no JSON parser:
 *
 *   <input>\t<mn_addr_unshielded>\t<0x evm address>
 *
 * WHY A TOOL IS NEEDED AT ALL
 * ---------------------------
 * `eth_getBalance` is keyed on an EVM address, and the mapping is
 * `keccak256(bech32m payload bytes)[12:32]` (wallet-monitor/address.ts, the "shared Parts B/C/E
 * mapping contract"). There is no way to eyeball it and no upstream CLI that prints it, so
 * without this there is no way to ask the RPC surface about a wallet you know by seed or by
 * `mn_addr`. `scripts/evm-address.sh` wraps it; `verify.sh`'s `evm` section uses it to turn
 * wallets/wallets.json into the addresses it then queries.
 *
 * A 32-byte (64 hex char) seed is derived exactly the way the wallet monitor derives WATCH_SEEDS
 * — same HD account/role/index — so what this prints is what the monitor watches. A longer seed
 * (the 64-byte Lace test seed) is rejected by that same derivation upstream, which is precisely
 * why wallets like it must be watched via WATCH_ADDRESSES and passed to this tool as an
 * `mn_addr` instead.
 */
import { deriveUnshieldedAddress, evmAddressHex } from "../wallet-monitor/address.js";

const args = process.argv.slice(2);
let networkId = process.env.NET ?? "undeployed";
const inputs: string[] = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--net") {
    const value = args[i + 1];
    if (value === undefined) throw new Error("--net needs a network id");
    networkId = value;
    i += 1;
  } else if (arg.startsWith("--net=")) {
    networkId = arg.slice("--net=".length);
  } else if (arg === "-h" || arg === "--help") {
    console.log("usage: npx tsx tools/evm-address.ts [--net <networkId>] <seed-hex | mn_addr> ...");
    process.exit(0);
  } else {
    inputs.push(arg);
  }
}

if (inputs.length === 0) {
  console.error("evm-address: no inputs. usage: npx tsx tools/evm-address.ts [--net <id>] <seed-hex | mn_addr> ...");
  process.exit(2);
}

let failures = 0;
for (const input of inputs) {
  try {
    // A bare hex string is a seed; anything else must already be a bech32m address. Deciding on
    // the shape rather than on a flag keeps callers from having to classify wallets.json entries.
    const mnAddress = /^[0-9a-fA-F]+$/.test(input) ? deriveUnshieldedAddress(input, networkId) : input;
    process.stdout.write(`${input}\t${mnAddress}\t${evmAddressHex(mnAddress)}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`evm-address: ${input}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.exitCode = failures === 0 ? 0 : 1;
