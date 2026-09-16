// aa-offer.ts — turn a Passport account's open-swap call into the blob this stack's
// offer-files kernel accepts.
//
// The offer IS the proven-but-never-submitted transaction: an open-shape
// `open_swap_shielded_with_evm` call leaves the give value with no output at all (a
// POSITIVE imbalance) beside the −want deficit the circuit's `receiveShielded` claims. A
// taker balances and submits it later; the maker never pays a fee and never touches its
// own coins here.
//
// ⚠ WHAT CHANGED IN 00034. The builder, the two gates and the imbalance readers used to
// live in this file, ported from the AA project's research harness, and drove the AA-v3
// Manager's `execute` gateway (selector 6). They now live in the Passport fork's
// `src/wallet/offer.ts` (PR-B), which is where they belong: they are properties of the
// circuit, and the fork's own suites exercise them offline against the contract's pure
// circuits. This file is what remains — the two things that are THIS STACK's, not the
// contract's:
//
//   1. BINDING. The fork's `buildOpenSwapOffer` stops at the proven, PRE-BINDING artefact
//      and its envelope declares `form: 'pre-binding'`, because its own taker merges the
//      recipe and binds at the end. This stack's kernel does not: its deserializer accepts
//      only the BOUND wire header `transaction[v12](signature[v2],proof,pedersen-schnorr[v1])`
//      and an unbound transaction serializes as `embedded-fr` and lands BAD_DESERIALIZE
//      (measured 2026-08-26, unchanged). So the artefact is bound HERE, and the bound
//      bytes are what is hashed, published and content-addressed.
//   2. The MIP-0005 `swapoffer1…` encoding the kernel parses (@effectstream/mip-zswap-offer).
//
// ⚠ AND ONE GATE IS GONE. `AA_OFFER_ALLOW_FALLIBLE` no longer exists. It was an override
// for project 00006's FR-302 rule that an offer's legs must sit in the GUARANTEED segment
// 0 — a rule PR-B measured to be unsatisfiable for any device-gated circuit, because the
// MIP-0013 seam writes ledger state (the consumed device entry, its successor, auth_nonce,
// round) BEFORE any value moves, and everything after that write is in the transaction's
// fallible half by construction. Question Q39 replaced it with the rule a taker actually
// needs: ALL the legs in ONE segment, whichever it is, declared in the terms and checked
// against the bytes. That rule is enforced inside the fork's builder and it FAILS CLOSED,
// so there is nothing left to override.

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import {
  buildOpenSwapOffer as buildPassportOffer,
  readAllImbalances,
  legSegmentOf,
  sha256Hex,
  type OfferTerms,
  type OpenSwapOfferSpec,
  type ImbalanceReading,
} from "../passport/src/wallet/offer.js";

export type { OfferTerms, ImbalanceReading };

export interface KernelOffer {
  /** `swapoffer1…` — the MIP-0005 blob the poster/kernel consumes. */
  blob: string;
  /** The BOUND transaction bytes the blob carries. */
  bytes: number;
  /** SHA-256 of those bytes — what the kernel calls the offerId. */
  sha256: string;
  /** The fork's offer terms, with `form` corrected to `binding` and the content address
   *  recomputed over the bound bytes. Published beside the blob. */
  terms: OfferTerms;
  /** Segment → token → signed delta, measured on the BOUND artefact. */
  imbalances: ImbalanceReading;
  /** The one segment the legs are in (Q39). */
  legSegment: string;
  proveMs: number;
}

/**
 * Prove an offer, bind it, and encode it for the kernel.
 *
 * Everything before `bind()` is the fork's: the call, the proof, the DUST refusal and the
 * placement assert. Everything after it is this stack's wire format.
 */
export async function buildKernelOffer(
  spec: OpenSwapOfferSpec,
  log: (line: string) => void = () => {},
): Promise<KernelOffer> {
  log(`proving ${spec.circuitId} — the LAST thing the maker does (no balance, no dust, no submit)`);
  const offer = await buildPassportOffer(spec);
  log(`proved in ${offer.proveMs} ms; legs in segment ${offer.terms.legSegment}`);

  // Bind. `bind()` seals the artefact's pedersen commitments; it adds no value leg, so the
  // imbalances must be identical — and that is asserted rather than assumed, because a
  // change here would be a silent change to what a taker is asked to fund.
  const bound: any =
    typeof (offer.proven as any).bind === "function" ? (offer.proven as any).bind() : offer.proven;
  const imbalances = readAllImbalances(bound, `bound offer (${spec.circuitId})`);
  const legSegment = legSegmentOf(imbalances) ?? "";
  if (JSON.stringify(imbalances[legSegment] ?? {}) !== JSON.stringify(offer.imbalances[offer.terms.legSegment] ?? {})) {
    throw new Error(
      `binding changed the offer's imbalances: before ${JSON.stringify(offer.imbalances)}, ` +
        `after ${JSON.stringify(imbalances)} — refusing to publish`,
    );
  }

  const bytes: Uint8Array = bound.serialize();
  const sha256 = sha256Hex(bytes);
  const terms: OfferTerms = {
    ...offer.terms,
    form: "binding",
    contentAddress: sha256,
    transactionBytes: bytes.length,
    imbalances,
    legSegment,
  };
  const blob = OfferFiles.encode(bytes);
  log(`bound: ${bytes.length} bytes; sha256(offerId)=${sha256.slice(0, 16)}…`);
  return { blob, bytes: bytes.length, sha256, terms, imbalances, legSegment, proveMs: offer.proveMs };
}

/** The label the imbalance readers use for a shielded colour, re-exported for callers
 *  that want to talk about a specific leg (`shielded:<64 hex>`). */
export { shieldedLabel } from "../passport/src/wallet/offer.js";
