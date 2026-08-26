// aa-offer.ts — build a PUBLISHABLE unbalanced zswap offer from an AA Manager
// open-swap `execute` (selector 6), and encode it for the offer-files kernel.
//
// The offer IS the proven-but-never-submitted transaction: an open-shape
// selector-6 call leaves segment 0 unbalanced by exactly {+give, −want}
// (the give surplus has no output at all — that positive imbalance is the open
// offer; the want deficit is the coin the contract claims via receiveShielded).
// A taker balances and submits it later; the maker never pays fees and never
// touches its own coins here.
//
// Ported from the AA project's proven research harness (never productized
// upstream — the AA repo's reorg removed it from main):
//   ~/todo/AA/experiments/00008-AA-v3-evm/harness/src/offer/build.ts  (builder)
//   ~/todo/AA/experiments/00008-AA-v3-evm/harness/src/g1/maker.ts     (FR-302 gate)
// with two deliberate changes: the circuit is the v5 `execute` gateway (EIP-712
// authorized) rather than the legacy per-circuit entrypoint, and the encoding
// is the kernel's own MIP-0005 `swapoffer1…` (OfferFiles) rather than the
// harness's bespoke envelope — the kernel's offerId (sha256 of the canonical
// Transaction bytes) is what the harness called the content address.
//
// TWO FAIL-CLOSED GATES, both from the harness (keep them; they are the
// difference between "posted an offer" and "posted an unsettleable artifact"):
//   FR-302  the offer's legs sit at SEGMENT 0 and no other segment carries a
//           delta — a leg in a fallible segment is unsettleable by a taker.
//   FR-301  the maker artifact carries NO DUST actions — dust is the taker's.

import { createUnprovenCallTx } from "@midnight-ntwrk/midnight-js-contracts";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

export type ImbalanceMap = Record<string, string>;
export interface PlacementReport {
  segments: number[];
  imbalances: Record<string, ImbalanceMap>;
  expectedAtSegment0: ImbalanceMap;
  segment0Exact: boolean;
  otherSegmentsEmpty: boolean;
  offendingSegments: string[];
  ok: boolean;
}

const hex = (u: Uint8Array): string =>
  Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

// Token keys out of tx.imbalances() are ledger token-type objects; label them
// stably. Shielded token types carry .raw (32 bytes); dust and unshielded carry
// tags. Unknown shapes degrade to JSON so a mismatch is visible, not hidden.
const tokenLabel = (token: any): string => {
  try {
    if (token === "dust" || token?.tag === "dust") return "dust";
    const tag = token?.tag ?? (token?.raw !== undefined ? "shielded" : undefined);
    const raw = token?.raw ?? token?.value ?? token;
    if (tag && raw instanceof Uint8Array) return `${tag}:${hex(raw)}`;
    if (typeof raw === "string") return `${tag ?? "token"}:${raw.replace(/^0x/, "")}`;
    return JSON.stringify(token);
  } catch {
    return String(token);
  }
};

export const shieldedLabel = (colourHex: string): string =>
  `shielded:${colourHex.replace(/^0x/, "").toLowerCase()}`;

// `Transaction.segments()` is not bound to JS at these pins; derive the set
// from the two maps that ARE bound (harness finding F-304 — `?.()` fallback
// would silently degrade the gate to "segment 0 looks right").
export const segmentsOf = (tx: any): number[] => {
  const set = new Set<number>([0]);
  for (const k of (tx.intents?.keys?.() ?? []) as Iterable<number>) set.add(Number(k));
  for (const k of (tx.fallibleOffer?.keys?.() ?? []) as Iterable<number>) set.add(Number(k));
  return [...set].sort((a, b) => a - b);
};

const readImbalances = (tx: any, segment: number): ImbalanceMap => {
  const out: ImbalanceMap = {};
  for (const [token, delta] of tx.imbalances(segment) as Map<unknown, bigint>) {
    if (delta !== 0n) out[tokenLabel(token)] = String(delta);
  }
  return out;
};

export const assertPlacement = (tx: any, expected: ImbalanceMap): PlacementReport => {
  const segments = segmentsOf(tx);
  const imbalances: Record<string, ImbalanceMap> = {};
  for (const s of segments) {
    try {
      imbalances[String(s)] = readImbalances(tx, s);
    } catch (e) {
      imbalances[String(s)] = { "<unreadable>": e instanceof Error ? e.message : String(e) };
    }
  }
  const seg0 = imbalances["0"] ?? {};
  const segment0Exact =
    Object.keys(seg0).length === Object.keys(expected).length &&
    Object.entries(expected).every(([k, v]) => seg0[k] === v);
  const offendingSegments = segments
    .filter((s) => s !== 0)
    .filter((s) => Object.keys(imbalances[String(s)] ?? {}).length > 0)
    .map((s) => `${s}: ${JSON.stringify(imbalances[String(s)])}`);
  return {
    segments, imbalances, expectedAtSegment0: expected,
    segment0Exact,
    otherSegmentsEmpty: offendingSegments.length === 0,
    offendingSegments,
    ok: segment0Exact && offendingSegments.length === 0,
  };
};

export const requirePlacement = (what: string, report: PlacementReport): PlacementReport => {
  if (report.ok) return report;
  throw new Error(
    `FR-302 VIOLATED for ${what}: expected segment-0 ${JSON.stringify(report.expectedAtSegment0)}, ` +
    `observed ${JSON.stringify(report.imbalances["0"] ?? {})}; ` +
    `other segments carrying deltas: ${report.offendingSegments.join("; ") || "(none)"} — ` +
    `an offer with a leg outside the guaranteed section is unsettleable by an independent taker, refusing to publish`,
  );
};

/** FR-301: a maker artifact must carry no DUST actions (dust is the taker's job). */
const carriesDust = (tx: any): boolean => {
  try {
    const d = tx.dustActions ?? tx.dust;
    if (d === undefined || d === null) return false;
    if (typeof d.isEmpty === "function") return !d.isEmpty();
    if (typeof d.size === "number" || typeof d.size === "bigint") return Number(d.size) > 0;
    return true; // present in an unknown shape — fail closed
  } catch {
    return true;
  }
};

export interface OpenSwapOfferSpec {
  providers: any;              // configureMidnightNodeProviders result (proofProvider = aa-proof-server)
  compiledContract: any;       // the manager's CompiledContract with witnesses
  managerAddress: string;
  args: unknown[];             // [payload, signature, point] from prepareEvmExecute
  giveColorHex: string;        // no 0x prefix needed either way
  giveAmount: bigint;
  wantColorHex: string;
  wantAmount: bigint;
  log?: (line: string) => void;
}

export interface BuiltOffer {
  blob: string;                // swapoffer1… (MIP-0005)
  bytes: number;               // serialized transaction size
  sha256: string;              // == the kernel's offerId
  placement: PlacementReport;
  proveMs: number;
}

export async function buildOpenSwapOffer(spec: OpenSwapOfferSpec): Promise<BuiltOffer> {
  const log = spec.log ?? (() => {});
  const built: any = await createUnprovenCallTx(spec.providers, {
    compiledContract: spec.compiledContract,
    circuitId: "execute",
    contractAddress: spec.managerAddress,
    args: spec.args,
    privateStateId: "aaManagerPrivateState",
  } as any);

  log("proving the open-swap execute — the LAST thing the maker does (no balance, no dust, no submit)");
  const t0 = Date.now();
  const provenUnbound: any = await spec.providers.proofProvider.proveTx(built.private.unprovenTx);
  const proveMs = Date.now() - t0;
  // BINDING form (measured 2026-08-26): the kernel's deserializer accepts only
  // the BOUND wire header `transaction[v12](signature[v2],proof,pedersen-schnorr[v1])`
  // — a pre-binding tx serializes as `embedded-fr` and lands BAD_DESERIALIZE.
  // Wallet-built offers (balanceFinalizedTransaction) are bound too; bind here.
  const proven: any = typeof provenUnbound.bind === "function" ? provenUnbound.bind() : provenUnbound;

  if (carriesDust(proven)) {
    throw new Error("FR-301 VIOLATED: the maker artifact carries DUST actions — refusing to publish");
  }

  // Open shape (recipientKind 0): +give stands beside −want at segment 0. The
  // give and want colours MUST differ — same-colour legs net into one delta and
  // the kernel would reject the offer as NOT_A_SWAP.
  const give = shieldedLabel(spec.giveColorHex);
  const want = shieldedLabel(spec.wantColorHex);
  if (give === want) throw new Error("give and want colours must differ (same-colour legs net out: NOT_A_SWAP)");
  const expected: ImbalanceMap = { [give]: String(spec.giveAmount), [want]: String(-spec.wantAmount) };
  const report = assertPlacement(proven, expected);
  // MEASURED 2026-08-26 on this stack: the v5 k=19 `execute` gateway's transcript
  // exceeds the ledger's guaranteed budget even at 1 pool / 1 custody cell, so
  // the WHOLE call lands in the fallible section (AA issues 0003/0004 mechanism;
  // this datapoint is NEW — v4's boundary was 2 cells). The gate therefore fails
  // closed by default. AA_OFFER_ALLOW_FALLIBLE=1 publishes anyway — an
  // EXPERIMENT lane for measuring what the kernel and a live taker actually do
  // with a fallible-placement offer, not a production path.
  const allowFallible = /^(1|true|yes)$/i.test(process.env["AA_OFFER_ALLOW_FALLIBLE"] ?? "");
  let placement = report;
  if (!report.ok && allowFallible) {
    log(`FR-302 gate OVERRIDDEN (AA_OFFER_ALLOW_FALLIBLE): placement=${JSON.stringify(report.imbalances)}`);
  } else {
    placement = requirePlacement(
      `open-swap offer (give ${spec.giveAmount} ${give.slice(9, 21)}… / want ${spec.wantAmount} ${want.slice(9, 21)}…)`,
      report,
    );
  }

  const bytes: Uint8Array = proven.serialize();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const blob = OfferFiles.encode(bytes);
  log(`offer proven in ${proveMs} ms; ${bytes.length} bytes; sha256(offerId)=${hex(digest).slice(0, 16)}…`);
  return { blob, bytes: bytes.length, sha256: hex(digest), placement, proveMs };
}
