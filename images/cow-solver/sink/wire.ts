// The solver→relay v1 wire contract, as the SINK must accept it.
//
// This is a deliberate, faithful RE-IMPLEMENTATION, not an import. The
// authoritative copy lives in the kernel repo at
// `packages/solver-core/relay-ws-contract.ts`, which is itself a port of the
// acceptance predicates in the pinned `midnight-intents-swaps` relay
// (@ d444c8379415093460d83a6ba27536af396f759d). The sink cannot import it
// because its isolated image context does not contain the upstream solver tree.
// That tree is public and not copied here: the Cow solver image fetches
// effectstream/zswap-offerfiles-kernel PR #50 directly at exact SHA
// 4af102536f02f137b696a4734bd8c936eddf3672. The separate browser SPA is fetched
// through FRONTEND_REPO/FRONTEND_REF.
//
// The canonical JSON bodies are pinned by that package's
// `fixtures/relay-ws/v1/` + `MANIFEST.sha256`; `wire.test.ts` next to this
// file re-checks these predicates against byte-copies of those fixtures, so a
// drift in either direction fails a test rather than silently accepting a
// frame the real relay would refuse (or refusing one it would take).
//
// Deliberately relay-FAITHFUL, not stricter — the same two consequences the
// kernel module documents apply here:
//   1. price-levels token ids are NOT required to be 64-hex, and a ladder may
//      be empty. Anything the relay accepts, the sink must represent.
//   2. a frame the relay rejects is discarded SILENTLY. The sink mirrors that
//      (it counts the rejection and moves on) rather than answering an error
//      the real relay would never send.

/** Frozen revision the pinned contract was read from. */
export const RELAY_WS_CONTRACT_REVISION = "d444c8379415093460d83a6ba27536af396f759d" as const;

export interface PriceLevel {
  /** Cumulative input accepted, decimal integer string. */
  input: string;
  /** Cumulative output paid for that input, decimal integer string. */
  output: string;
}

export interface PriceLevelsPair {
  tokenIn: string;
  tokenOut: string;
  levels: PriceLevel[];
}

export interface SolverCapabilitiesMessage {
  type: "solver-capabilities";
  tokenIds: string[];
  maxParallelSwaps?: number;
}

export interface PriceLevelsMessage {
  type: "price-levels";
  levels: PriceLevelsPair[];
}

/** Decimal, non-negative integer string — relay-ws.ts `isAmountString`. */
export function isAmountString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

/** Token id grammar the relay applies to `solver-capabilities.tokenIds` ONLY
 *  (`/^[0-9a-f]{64}$/i`). It lowercases on accept. */
export function isCapabilityTokenId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** relay-ws.ts `isPriceLevels`. Token ids only need to be strings; rungs must
 *  be decimal integer strings, STRICTLY ascending in `input`. */
export function isPriceLevelsPair(value: unknown): value is PriceLevelsPair {
  const pair = asRecord(value);
  if (!pair) return false;
  if (typeof pair.tokenIn !== "string" || typeof pair.tokenOut !== "string") return false;
  if (!Array.isArray(pair.levels)) return false;
  return pair.levels.every((rung, index) => {
    const level = asRecord(rung);
    if (!level) return false;
    if (!isAmountString(level.input) || !isAmountString(level.output)) return false;
    if (index > 0) {
      const previous = (pair.levels as PriceLevel[])[index - 1]!;
      if (BigInt(previous.input) >= BigInt(level.input)) return false;
    }
    return true;
  });
}

/**
 * Parse `solver-capabilities` exactly as the relay admits it.
 *
 * Note the asymmetry, reproduced rather than tightened: a bad
 * `maxParallelSwaps` alongside good tokens still registers the tokens and
 * leaves capacity at the relay's default of 8.
 */
export function parseSolverCapabilities(value: unknown): SolverCapabilitiesMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "solver-capabilities") return null;
  const { tokenIds, maxParallelSwaps } = message;
  if (!Array.isArray(tokenIds) || !tokenIds.every(isCapabilityTokenId)) return null;
  const parsed: SolverCapabilitiesMessage = {
    type: "solver-capabilities",
    tokenIds: (tokenIds as string[]).map((token) => token.toLowerCase()),
  };
  if (
    typeof maxParallelSwaps === "number" &&
    Number.isInteger(maxParallelSwaps) &&
    maxParallelSwaps > 0
  ) {
    parsed.maxParallelSwaps = maxParallelSwaps;
  }
  return parsed;
}

/** Parse `price-levels` exactly as the relay admits it. */
export function parsePriceLevels(value: unknown): PriceLevelsMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "price-levels") return null;
  const { levels } = message;
  if (!Array.isArray(levels) || !levels.every(isPriceLevelsPair)) return null;
  return { type: "price-levels", levels: levels as PriceLevelsPair[] };
}

/**
 * relay-ws.ts `interpolateQuote`: what the relay would promise a taker for
 * `amountIn` against one published ladder, flooring linear interpolation
 * between bracketing rungs.
 *
 * Reproduced because it is what the solver's published ladder COMMITS it to —
 * the page uses it to show the quote a taker would actually be given, not just
 * the rungs. `null` is a size the relay refuses (below the first rung or above
 * the last).
 */
export function interpolateQuote(levels: PriceLevel[], amountIn: bigint): bigint | null {
  if (levels.length === 0) return null;
  if (amountIn < BigInt(levels[0]!.input)) return null;
  if (amountIn > BigInt(levels[levels.length - 1]!.input)) return null;
  for (let index = 0; index < levels.length - 1; index += 1) {
    const inputLow = BigInt(levels[index]!.input);
    const inputHigh = BigInt(levels[index + 1]!.input);
    if (amountIn > inputHigh) continue;
    if (inputHigh <= inputLow) return BigInt(levels[index]!.output);
    const outputLow = BigInt(levels[index]!.output);
    const outputHigh = BigInt(levels[index + 1]!.output);
    return outputLow + ((outputHigh - outputLow) * (amountIn - inputLow)) / (inputHigh - inputLow);
  }
  return BigInt(levels[levels.length - 1]!.output);
}

/**
 * Frame types the solver may send us. `swap-tx` and `job-error` are the other
 * two the contract defines; in OBSERVATION mode they can only appear if the
 * sink dispatched a job, which it never does — so seeing one is a real alarm
 * and the sink records it as such rather than ignoring it.
 */
export type SolverFrameKind = "solver-capabilities" | "price-levels" | "swap-tx" | "job-error";

export function frameKind(value: unknown): SolverFrameKind | "unknown" {
  const message = asRecord(value);
  const type = message?.type;
  if (
    type === "solver-capabilities" || type === "price-levels" ||
    type === "swap-tx" || type === "job-error"
  ) {
    return type;
  }
  return "unknown";
}
