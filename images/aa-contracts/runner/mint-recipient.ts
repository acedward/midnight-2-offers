// Typed mint recipients for the offer-files contract.
//
// Since zswap-offerfiles-kernel PR #67 (in KERNEL_REF 80bace3) both mint
// circuits take an EXPLICIT recipient instead of implying the caller:
//
//   mint_shielded(domain_sep, amount, nonce, recipient: Either<ZswapCoinPublicKey, ContractAddress>)
//   mint_unshielded(domainSep, amount,        recipient: Either<ContractAddress, UserAddress>)
//
// Compact's `Either<L, R>` crosses the boundary as a struct with BOTH arms
// present — the inactive one must still be 32 zero bytes, not omitted — so
// hand-building it at each call site is how a mint to nobody gets written.
//
// This is a copy of the kernel's own helper at that commit,
// `packages/contracts-midnight/contract-offer-files/src/mint-recipient.ts`
// (exported there as `@zswap-da/contract-offer-files/mint-recipient`), kept
// byte-equal in behaviour. Copied and not imported for the same reason
// `domainSepFromName` is copied into aa-console.ts: this image carries the AA
// repo's node_modules, never the kernel workspace. If the kernel's helper
// changes, this file changes with it — the worked caller to diff against is
// `packages/contracts-midnight/mint-test-tokens.ts` at KERNEL_REF.
//
// The `encode*` functions take HEX STRINGS (ledger-v9 types `CoinPublicKey`,
// `UserAddress` and `ContractAddress` are all `string`) and return exactly 32
// bytes; a wrong-length input throws here rather than minting a coin nobody
// can spend.
import {
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeUserAddress,
  type CoinPublicKey,
  type ContractAddress,
  type UserAddress,
} from "@midnightntwrk/ledger-v9";

export interface CompactBytes32 {
  readonly bytes: Uint8Array;
}

export interface CompactEither<Left, Right> {
  readonly is_left: boolean;
  readonly left: Left;
  readonly right: Right;
}

export type ShieldedMintRecipient = CompactEither<CompactBytes32, CompactBytes32>;
export type UnshieldedMintRecipient = CompactEither<CompactBytes32, CompactBytes32>;

const inactiveArm = (): CompactBytes32 => ({ bytes: new Uint8Array(32) });

function activeArm(bytes: Uint8Array, label: string): CompactBytes32 {
  if (bytes.length !== 32) {
    throw new Error(`${label} must encode to exactly 32 bytes, got ${bytes.length}`);
  }
  return { bytes };
}

/** Shielded `left`: mint to a user's Zswap coin public key. */
export function shieldedUserRecipient(coinPublicKey: CoinPublicKey): ShieldedMintRecipient {
  return {
    is_left: true,
    left: activeArm(encodeCoinPublicKey(coinPublicKey), "coin public key"),
    right: inactiveArm(),
  };
}

/**
 * Shielded `right`: mint to a contract that receives in the SAME transaction.
 *
 * Deliberately unused by this console — nothing here can run a receive circuit
 * in the same transaction, so a contract recipient would produce a malformed
 * transaction. It is kept so the copy stays a copy; the AA project's own
 * mint-to-contract work (00029-AA T-M1) owns that path.
 */
export function shieldedContractRecipient(
  contractAddress: ContractAddress,
): ShieldedMintRecipient {
  return {
    is_left: false,
    left: inactiveArm(),
    right: activeArm(encodeContractAddress(contractAddress), "contract address"),
  };
}

/** Unshielded `left`: mint to a contract address. (Also unused here — see above.) */
export function unshieldedContractRecipient(
  contractAddress: ContractAddress,
): UnshieldedMintRecipient {
  return {
    is_left: true,
    left: activeArm(encodeContractAddress(contractAddress), "contract address"),
    right: inactiveArm(),
  };
}

/** Unshielded `right`: mint to a user's unshielded ledger address. */
export function unshieldedUserRecipient(userAddress: UserAddress): UnshieldedMintRecipient {
  return {
    is_left: false,
    left: inactiveArm(),
    right: activeArm(encodeUserAddress(userAddress), "user address"),
  };
}
