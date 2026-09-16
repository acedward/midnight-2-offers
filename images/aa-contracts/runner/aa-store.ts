// aa-store.ts — the console's per-account state, which the chain does not hold.
//
// THIS FILE EXISTS BECAUSE OF Q40 AND MIP-0012 §6.5. A Passport account is its own
// contract: there is no shared ledger map to enumerate, no pre-registration id, and no
// on-chain link from an Ethereum address to the accounts it controls. And a shielded coin
// held by an account lives in the OWNER's private state, never in ledger state — the chain
// carries only an encrypted inbox entry. So three things outlive a process and exist
// nowhere else:
//
//   * the account ADDRESS, keyed by its owner's Ethereum address (the console's registry);
//   * the device ROSTER — the S11 use counters, which the chain stores only as a rolling
//     entry hash, so a client without them rescans;
//   * the COIN STORE — `{ colour → qualified coin }`, the `held_coin` witness's source.
//
// ⚠ AND THE ACCOUNT'S ENCRYPTION SECRET, which is the account's VIEWING capability: with
// it, this file can read every inbox entry the account ever received. That is a deliberate
// property of a demo console whose whole job is to be the custodian for a browser that
// holds no Midnight key — it is the same posture the AA-v3 console had when it held the
// Manager's owner secret, and it is the reason this stack is a disposable localnet whose
// wallet seeds are published in `wallets/wallets.json`. A product would keep this key in
// the user's own storage and hand the console only `enc_key`, the public half. Never point
// this at a network whose funds matter.
//
// The file is a compose VOLUME (`aa-out`), so `./down.sh -v` takes it with the chain the
// addresses in it refer to — which is right: the addresses are meaningless on a new genesis.
// Losing it costs a rescan and a re-registration, never funds: an account remains fully
// usable from its address alone, and `importRoster` re-verifies every counter it is given.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import * as path from "node:path";

import type { RosterSnapshot } from "../passport/src/wallet/account.js";
import type { CoinStorePrivateState, StoredCoin } from "../passport/src/wallet/witnesses.js";

export const STORE_VERSION = 2;

export interface AccountRecord {
  /** The contract address — the account id (Q40). */
  address: string;
  /** The owning EVM device's address, lower-case hex, no `0x`. */
  owner: string;
  /** X25519 public key (hex) — what a depositor seals an inbox entry to. */
  encPublicKey: string;
  /** X25519 SECRET key (hex) — the viewing capability. See the header. */
  encSecretKey: string;
  /** The device roster (`CustodyAccount.exportRoster()`). */
  roster: RosterSnapshot;
  /** The wallet-local coin store (MIP-0012 §6.5). */
  coins: Record<string, StoredCoin>;
  /** mt_index candidates still to try per colour, when a capture was ambiguous.
   *  A wrong index fails at PROVING, before any transaction exists, so trying the
   *  next one is safe — it is just slow, which is why the list is kept. */
  mtCandidates?: Record<string, string[]>;
  /** The offer this account currently has live, if any (Q7: one at a time).
   *
   *  It carries what RECONCILING after a settlement needs, because by then the artefact is
   *  gone and the chain does not say which offer a transaction settled. Without this the
   *  console's coin store keeps a coin the settlement nullified, and the account's NEXT call
   *  fails at proving with a message about a merkle path. */
  liveOffer?: {
    offerId: string;
    give: string;
    want: string;
    createdAt: string;
    giveColour: string;
    giveAmount: string;
    wantColour: string;
    wantAmount: string;
    wantNonceHex: string;
    /** The change the circuit returns to the account, or null when the give coin is exact.
     *  Its NONCE is stored rather than re-derived: the rule is `swap_change_nonce(<the GIVE
     *  coin's nonce>)`, and by settlement time the give coin is gone from the store. */
    changeValue: string | null;
    changeNonceHex: string | null;
  } | null;
  registeredAt: string;
  /** Free-form notes (network, the deploy's transaction ids). */
  meta?: Record<string, string>;
}

export interface StoreFile {
  version: number;
  updatedAt: string;
  accounts: AccountRecord[];
}

const empty = (): StoreFile => ({ version: STORE_VERSION, updatedAt: new Date().toISOString(), accounts: [] });

export function loadStore(file: string): StoreFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return empty();
    throw e;
  }
  const parsed = JSON.parse(raw) as StoreFile;
  if (typeof parsed?.version !== "number" || !Array.isArray(parsed.accounts)) {
    throw new Error(`${file} is not a console store (expected { version, accounts: [] })`);
  }
  if (parsed.version > STORE_VERSION) {
    throw new Error(`${file} was written by a newer console (version ${parsed.version} > ${STORE_VERSION})`);
  }
  return parsed;
}

/** Atomic within one process: write a temp file and rename, so a crash mid-write cannot
 *  leave a half-written store that the next start-up refuses to parse. */
export function saveStore(file: string, store: StoreFile): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ ...store, version: STORE_VERSION, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  renameSync(tmp, file);
}

export function findByAddress(store: StoreFile, address: string): AccountRecord | undefined {
  return store.accounts.find((a) => a.address === address);
}

const key = (owner: string): string => owner.replace(/^0x/, "").toLowerCase();

export function findByOwner(store: StoreFile, owner: string): AccountRecord[] {
  return store.accounts.filter((a) => key(a.owner) === key(owner));
}

export function upsert(store: StoreFile, record: AccountRecord): StoreFile {
  const accounts = store.accounts.filter((a) => a.address !== record.address);
  accounts.push(record);
  return { ...store, accounts };
}

/** The coin store shape `CustodyAccount.connect` takes as `initialState`. */
export function coinStoreOf(record: AccountRecord): CoinStorePrivateState {
  return { encSecretKeyHex: record.encSecretKey, coins: { ...record.coins } };
}
