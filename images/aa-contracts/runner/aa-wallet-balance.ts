// aa-wallet-balance.ts — what a Midnight wallet ACTUALLY holds, read by syncing it from its
// own seed. Public output only: balances, addresses and colours; never the seed.
//
//   ./scripts/wallet-balance.sh <seed> [--json]
//
// ── WHY A WALLET HAS TO BE SYNCED TO ANSWER THIS ────────────────────────────
// A shielded coin is not in ledger state. It exists as a commitment plus a ciphertext the
// recipient can decrypt, so the only party who can say "this wallet holds 20 WEENUS" is a
// process holding that wallet's keys — which is exactly why this reads a seed and why the
// console cannot answer it for somebody else's wallet.
//
// ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
// The bridge's WALLET-recipient path mints a coin straight to a key the console holds nothing
// of. The claim "the recipient can see it" is therefore not something the console can prove:
// it has to be checked from the recipient's side, by a wallet that was told nothing but its
// own seed. That is the one assertion that catches a settle whose recipient encryption key
// was never mapped in (00034 question Q42), where the coin lands, belongs to them, and is
// invisible forever.
//
// It also answers the demo's step 3 — "and the owner's own wallet shows the bridged WEENUS" —
// without opening a browser.

import "./passport-env.ts";

import * as Rx from "rxjs";

import { CONFIG, createWallet, toHex, userAddressBytes } from "./passport.ts";

const TAG = "[aa-wallet-balance]";
const log = (...a: unknown[]) => console.log(TAG, ...a);

const SEED = process.env["AA_WALLET_BALANCE_SEED"] ?? "";
const JSON_ONLY = /^(1|true|yes)$/i.test(process.env["AA_WALLET_BALANCE_JSON"] ?? "");
const SYNC_MS = Number(process.env["AA_WALLET_BALANCE_SYNC_MS"] ?? 420_000);
/** Optional: wait until a colour's balance is at least this much, so a caller can assert
 *  "the coin arrived" without a sleep-and-hope. */
const WANT_COLOUR = (process.env["AA_WALLET_BALANCE_COLOUR"] ?? "").replace(/^0x/, "").toLowerCase();
const WANT_MIN = BigInt(process.env["AA_WALLET_BALANCE_MIN"] ?? "0");

if (!/^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/.test(SEED)) {
  console.error(`${TAG} AA_WALLET_BALANCE_SEED must be 64 or 128 hex characters`);
  process.exit(2);
}

const ctx: any = await createWallet(SEED);
let out: any;
try {
  const deadline = Date.now() + SYNC_MS;
  for (;;) {
    const st: any = await Rx.firstValueFrom((ctx.wallet as any).state().pipe(
      // Same throttle the console uses, for the same measured reason: `isSynced` flaps
      // true → false → true early in a sync.
      Rx.throttleTime(5_000),
      Rx.filter((x: any) => x.isSynced === true),
      Rx.timeout({ each: 300_000, with: () => Rx.throwError(() => new Error("wallet sync timeout")) }),
    ));
    const shieldedMap = st.shielded?.balances;
    const shielded: Record<string, string> = {};
    for (const [colour, value] of (shieldedMap instanceof Map ? [...shieldedMap.entries()] : Object.entries(shieldedMap ?? {}))) {
      shielded[String(colour).replace(/^0x/, "").toLowerCase()] = String(value);
    }
    const unshieldedMap = st.unshielded?.balances;
    const unshielded: Record<string, string> = {};
    for (const [colour, value] of (unshieldedMap instanceof Map ? [...unshieldedMap.entries()] : Object.entries(unshieldedMap ?? {}))) {
      unshielded[String(colour).replace(/^0x/, "").toLowerCase()] = String(value);
    }
    out = {
      kind: "aa-wallet-balance",
      networkId: CONFIG.networkId,
      readAt: new Date().toISOString(),
      coinPublicKey: String(st.shielded.coinPublicKey.toHexString()).replace(/^0x/, "").toLowerCase(),
      encryptionPublicKey: String(st.shielded.encryptionPublicKey.toHexString()).replace(/^0x/, "").toLowerCase(),
      unshieldedAddress: String(ctx.unshieldedKeystore.getAddress()),
      userAddress: toHex(userAddressBytes(ctx)),
      shielded,
      unshielded,
    };
    if (!WANT_COLOUR) break;
    const have = BigInt(shielded[WANT_COLOUR] ?? "0");
    out.waitedFor = { colour: WANT_COLOUR, min: String(WANT_MIN), have: String(have) };
    if (have >= WANT_MIN) { out.waitSatisfied = true; break; }
    if (Date.now() > deadline) { out.waitSatisfied = false; break; }
    if (!JSON_ONLY) log(`${WANT_COLOUR.slice(0, 16)}… is ${have}, waiting for ${WANT_MIN} …`);
    await new Promise((r) => setTimeout(r, 8000));
  }
} finally {
  await (ctx.wallet as any).stop?.().catch(() => {});
}

if (JSON_ONLY) {
  console.log(JSON.stringify(out, null, 2));
} else {
  log(`network ${out.networkId}`);
  log(`coin public key       ${out.coinPublicKey}`);
  log(`encryption public key ${out.encryptionPublicKey}`);
  log(`unshielded address    ${out.unshieldedAddress}`);
  const rows = Object.entries(out.shielded as Record<string, string>);
  log(`shielded: ${rows.length ? "" : "(nothing)"}`);
  for (const [colour, value] of rows) log(`  ${colour}  ${value}`);
  const urows = Object.entries(out.unshielded as Record<string, string>);
  log(`unshielded: ${urows.length ? "" : "(nothing)"}`);
  for (const [colour, value] of urows) log(`  ${colour}  ${value}`);
}
if (WANT_COLOUR && out.waitSatisfied !== true) {
  console.error(`${TAG} FAIL ${WANT_COLOUR} did not reach ${WANT_MIN} within ${Math.round(SYNC_MS / 1000)}s`);
  process.exit(1);
}
