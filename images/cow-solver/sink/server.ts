// cow-solver-sink — the demo's OBSERVATION endpoint for the ported COW solver.
//
// WHAT THIS IS. The solver (kernel branch `ledger-v9`, PR #65) is, by design, an
// outbound WebSocket CLIENT of a "Midnight Intents relay": it connects with a
// shared Bearer, registers `solver-capabilities`, and re-pushes `price-levels`
// once a second. The real relay (`shieldedtech/midnight-intents-swaps`) is
// DROPPED from this demo (user decision Q14 → option D) and so is
// solver-executed settlement — offers complete through the offer-files
// backend's console taker flow instead. This service stands in for the relay's
// RECEIVE half only, so the solver's pricing can be watched live.
//
// ─── THE SAFETY PROPERTY, AND WHY IT IS STRUCTURAL ──────────────────────────
// The solver only ever builds and proves a transaction in response to a `swap`
// job frame FROM its relay. This sink CONTAINS NO CODE THAT CONSTRUCTS OR
// SENDS A `swap` FRAME — grep it. It never writes to the solver socket at all.
// So "the solver must never submit anything to the chain" is not a runtime
// check that could regress; it is a property of what this file does not
// contain. `/api/snapshot` exposes `safety.framesSentToSolver`, which is
// hard-wired to 0, and `safety.jobFramesReceived`, which counts `swap-tx` /
// `job-error` frames — in observation mode those are UNREACHABLE, so a
// non-zero count means something dispatched work and is a real alarm.
//
// ─── PORTS ──────────────────────────────────────────────────────────────────
// Two listeners, deliberately, so the authenticated ingress and the public
// read-only surface are separable at the firewall:
//   SINK_RELAY_PORT  (default 8081) — solver-facing. Bearer-authenticated WS
//                     upgrade, plus `GET /jobs/:jobId` because a live solver
//                     requires SOLVER_RELAY_HTTP_URL for durable recovery, and
//                     `GET /tokens` (unauthenticated, as on the real relay)
//                     because it is the one relay route the upstream monitor
//                     site reads.
//   SINK_PUBLIC_PORT (default 8080) — browsers. The page, `GET /api/snapshot`,
//                     `GET /api/stream` (SSE) and `GET /ws` (WebSocket).

import { join } from "node:path";

import {
  frameKind,
  parsePriceLevels,
  parseSolverCapabilities,
  RELAY_WS_CONTRACT_REVISION,
  type PriceLevelsMessage,
  type SolverCapabilitiesMessage,
} from "./wire.ts";

const PUBLIC_PORT = Number(process.env["SINK_PUBLIC_PORT"] ?? 8080);
const RELAY_PORT = Number(process.env["SINK_RELAY_PORT"] ?? 8081);
const AUTH_TOKEN = process.env["SOLVER_RELAY_AUTH_TOKEN"] ?? "";
const ZSWAP_API = (process.env["ZSWAP_API"] ?? "http://kernel:9999").replace(/\/$/, "");
const BOOK_POLL_MS = Number(process.env["SINK_BOOK_POLL_MS"] ?? 4000);
const HISTORY_LIMIT = Number(process.env["SINK_HISTORY_LIMIT"] ?? 200);
const PUBLIC_DIR = join(import.meta.dir, "public");

// The relay refuses a bearer shorter than 32 characters and so does this sink.
// Failing at BOOT rather than at the first upgrade is deliberate: a sink that
// starts with a weak token would look healthy while rejecting every solver.
if (AUTH_TOKEN.length < 32) {
  console.error(
    `[sink] SOLVER_RELAY_AUTH_TOKEN must be at least 32 characters (got ${AUTH_TOKEN.length}). ` +
      `This is the relay's own rule; the solver is held to it too.`,
  );
  process.exit(1);
}
for (const [name, value] of [["SINK_PUBLIC_PORT", PUBLIC_PORT], ["SINK_RELAY_PORT", RELAY_PORT]] as const) {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    console.error(`[sink] ${name} must be a valid port, got ${value}`);
    process.exit(1);
  }
}

interface FrameRecord {
  at: number;
  kind: string;
  accepted: boolean;
  detail: string;
}

interface BookOfferView {
  offerId: string;
  status: string;
  blockHeight?: string;
  expiresAt?: string;
  firstSeenAt?: string;
  gives: { token: string; amount: string; type: string }[];
  wants: { token: string; amount: string; type: string }[];
}

const state = {
  startedAt: Date.now(),
  solverConnected: false,
  solverConnections: 0,
  lastConnectedAt: null as number | null,
  lastDisconnectedAt: null as number | null,
  lastFrameAt: null as number | null,
  capabilities: null as SolverCapabilitiesMessage | null,
  capabilitiesAt: null as number | null,
  ladders: null as PriceLevelsMessage | null,
  laddersAt: null as number | null,
  /** Pushes whose levels array was empty — the solver's explicit fail-closed
   *  WITHDRAWAL. Not the same as "no push": it means the solver is telling us
   *  it cannot honour anything right now. */
  withdrawals: 0,
  framesReceived: 0,
  framesAccepted: 0,
  framesRejected: 0,
  /** UNREACHABLE in observation mode — see the safety note at the top. */
  jobFramesReceived: 0,
  unauthorizedUpgrades: 0,
  history: [] as FrameRecord[],
  book: [] as BookOfferView[],
  bookAt: null as number | null,
  bookError: null as string | null,
  kernelSync: null as unknown,
};

function record(kind: string, accepted: boolean, detail: string): void {
  state.history.push({ at: Date.now(), kind, accepted, detail });
  if (state.history.length > HISTORY_LIMIT) {
    state.history.splice(0, state.history.length - HISTORY_LIMIT);
  }
}

// ─── the book the solver mirrors ─────────────────────────────────────────────
// Read from the SAME kernel API the solver's book-sync reads (`GET /v1/offers`,
// `GET /v1/health/sync`). Labelled on the page as the kernel's book, not as
// the solver's internal cache: the solver does not put its book on the wire,
// and inventing a channel for it would mean modifying the solver. What IS
// solver-authored is the ladder — so the page shows the two side by side and
// marks which offers the solver's published ladder covers.

async function pollBook(): Promise<void> {
  try {
    const response = await fetch(`${ZSWAP_API}/v1/offers?limit=200`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GET /v1/offers → ${response.status}`);
    const body = (await response.json()) as { offers?: unknown[] };
    const offers = Array.isArray(body.offers) ? body.offers : [];
    state.book = offers.map((raw): BookOfferView => {
      const offer = raw as Record<string, any>;
      const computed = (offer["computed"] ?? {}) as Record<string, any>;
      return {
        offerId: String(offer["offerId"] ?? ""),
        status: String(computed["status"] ?? "unknown"),
        blockHeight: offer["blockHeight"] === undefined ? undefined : String(offer["blockHeight"]),
        expiresAt: computed["expiresAt"],
        firstSeenAt: computed["firstSeenAt"],
        gives: Array.isArray(computed["gives"]) ? computed["gives"] : [],
        wants: Array.isArray(computed["wants"]) ? computed["wants"] : [],
      };
    });
    state.bookAt = Date.now();
    state.bookError = null;
  } catch (error) {
    state.bookError = error instanceof Error ? error.message : String(error);
  }
  try {
    const response = await fetch(`${ZSWAP_API}/v1/health/sync`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) state.kernelSync = await response.json();
  } catch {
    // The sync-health read is a nicety; its absence must not blank the book.
  }
  broadcast();
}

// ─── admission view ──────────────────────────────────────────────────────────
// The solver's real per-offer exclusion reasons (`LadderExclusion`) stay inside
// the process — they are not on the relay wire. What IS externally decidable is
// whether a directed pair present in the kernel book appears in the solver's
// published ladder. That difference is reported as the admission view, and the
// page labels it INFERRED for exactly that reason: absence proves the solver
// did not publish it, not WHY.

interface AdmissionRow {
  pair: string;
  tokenIn: string;
  tokenOut: string;
  inBook: number;
  published: boolean;
  rungs: number;
}

function admissionView(): AdmissionRow[] {
  const published = new Map<string, number>();
  for (const pair of state.ladders?.levels ?? []) {
    published.set(`${pair.tokenIn}->${pair.tokenOut}`, pair.levels.length);
  }
  const bookPairs = new Map<string, { tokenIn: string; tokenOut: string; count: number }>();
  for (const offer of state.book) {
    if (offer.status !== "live") continue;
    const gives = offer.gives[0];
    const wants = offer.wants[0];
    if (!gives || !wants) continue;
    // A maker GIVES tokenOut and WANTS tokenIn, so the directed pair a taker
    // would trade is wants→gives. This is the same orientation the solver's
    // ladder derivation publishes.
    const key = `${wants.token}->${gives.token}`;
    const existing = bookPairs.get(key);
    if (existing) existing.count += 1;
    else bookPairs.set(key, { tokenIn: wants.token, tokenOut: gives.token, count: 1 });
  }
  const rows: AdmissionRow[] = [];
  for (const [key, value] of bookPairs) {
    rows.push({
      pair: key,
      tokenIn: value.tokenIn,
      tokenOut: value.tokenOut,
      inBook: value.count,
      published: published.has(key),
      rungs: published.get(key) ?? 0,
    });
  }
  for (const [key, rungs] of published) {
    if (bookPairs.has(key)) continue;
    const [tokenIn = "", tokenOut = ""] = key.split("->");
    rows.push({ pair: key, tokenIn, tokenOut, inBook: 0, published: true, rungs });
  }
  return rows.sort((a, b) => a.pair.localeCompare(b.pair));
}

function snapshot(): unknown {
  return {
    now: Date.now(),
    startedAt: state.startedAt,
    contractRevision: RELAY_WS_CONTRACT_REVISION,
    mode: "observation",
    solver: {
      connected: state.solverConnected,
      connections: state.solverConnections,
      lastConnectedAt: state.lastConnectedAt,
      lastDisconnectedAt: state.lastDisconnectedAt,
      lastFrameAt: state.lastFrameAt,
    },
    safety: {
      // Structural, not measured: this service has no code path that writes to
      // the solver socket. See the header comment.
      framesSentToSolver: 0,
      swapJobsDispatched: 0,
      // Non-zero here would mean the solver answered work nobody sent it.
      jobFramesReceived: state.jobFramesReceived,
      unauthorizedUpgrades: state.unauthorizedUpgrades,
    },
    capabilities: state.capabilities,
    capabilitiesAt: state.capabilitiesAt,
    ladders: state.ladders,
    laddersAt: state.laddersAt,
    withdrawals: state.withdrawals,
    frames: {
      received: state.framesReceived,
      accepted: state.framesAccepted,
      rejected: state.framesRejected,
    },
    admission: admissionView(),
    book: state.book,
    bookAt: state.bookAt,
    bookError: state.bookError,
    kernelSync: state.kernelSync,
    history: state.history.slice(-50).reverse(),
  };
}

// ─── browser fan-out ─────────────────────────────────────────────────────────

const browserSockets = new Set<{ send: (data: string) => unknown }>();
const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function broadcast(): void {
  const payload = JSON.stringify(snapshot());
  for (const socket of browserSockets) {
    try {
      socket.send(payload);
    } catch {
      // A browser that cannot be written to is dropped by its own close handler.
    }
  }
  const frame = encoder.encode(`data: ${payload}\n\n`);
  for (const controller of sseControllers) {
    try {
      controller.enqueue(frame);
    } catch {
      sseControllers.delete(controller);
    }
  }
}

// ─── the solver-facing listener ──────────────────────────────────────────────

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  // Length-first, then value: the relay's own rule is a minimum length, and a
  // short token is a configuration error worth distinguishing in the log.
  if (token.length < 32) return false;
  return token === AUTH_TOKEN;
}

function handleSolverFrame(raw: unknown): void {
  state.framesReceived += 1;
  state.lastFrameAt = Date.now();

  const text = typeof raw === "string" ? raw : null;
  if (text === null) {
    state.framesRejected += 1;
    record("non-text", false, "ignored a non-text frame");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    state.framesRejected += 1;
    record("unparseable", false, `ignored ${text.length} bytes of non-JSON`);
    return;
  }

  const kind = frameKind(parsed);

  if (kind === "swap-tx" || kind === "job-error") {
    // Unreachable by construction: the sink dispatches no jobs. Recorded
    // loudly rather than counted quietly.
    state.jobFramesReceived += 1;
    state.framesRejected += 1;
    record(kind, false, "ALARM: a job frame arrived although no job was ever dispatched");
    console.error(`[sink] ALARM: received ${kind} in observation mode — no job was dispatched`);
    broadcast();
    return;
  }

  const capabilities = parseSolverCapabilities(parsed);
  if (capabilities !== null) {
    state.capabilities = capabilities;
    state.capabilitiesAt = Date.now();
    state.framesAccepted += 1;
    record(
      "solver-capabilities",
      true,
      `${capabilities.tokenIds.length} token(s), maxParallelSwaps=${capabilities.maxParallelSwaps ?? "default(8)"}`,
    );
    broadcast();
    return;
  }

  const levels = parsePriceLevels(parsed);
  if (levels !== null) {
    state.ladders = levels;
    state.laddersAt = Date.now();
    state.framesAccepted += 1;
    const rungs = levels.levels.reduce((total, pair) => total + pair.levels.length, 0);
    if (levels.levels.length === 0) {
      state.withdrawals += 1;
      record("price-levels", true, "EMPTY ladder — the solver's fail-closed withdrawal");
    } else {
      record("price-levels", true, `${levels.levels.length} pair(s), ${rungs} rung(s)`);
    }
    broadcast();
    return;
  }

  // The real relay discards a frame it cannot parse SILENTLY, leaving the
  // solver's previous ladder in force. Mirrored — but counted, because a
  // silent discard is exactly the failure this page exists to make visible.
  state.framesRejected += 1;
  record(kind, false, "frame refused by the relay-faithful predicates");
  broadcast();
}

Bun.serve({
  port: RELAY_PORT,
  hostname: "0.0.0.0",
  fetch(request, server) {
    const url = new URL(request.url);

    // The solver requires SOLVER_RELAY_HTTP_URL for durable job recovery. No
    // job can exist here, so every lookup is an honest 404 — the shape the
    // solver's recovery path expects for "this job is not known".
    if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
      return Response.json({ error: "unknown_job" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", mode: "observation" });
    }

    // `GET /tokens` — the reference relay's ONLY unauthenticated public route,
    // and the only relay route the upstream monitor site (`solver-frontend`)
    // knows. It answers "which tokens does this relay advertise", which on the
    // real relay is the union of its solvers' registered capabilities; with one
    // solver, that is exactly the last `solver-capabilities` frame this sink
    // accepted. Empty before the first frame, which is the honest answer.
    //
    // It stays inside the observation-safety property: this is a READ. Nothing
    // here writes to the solver socket, and the response is derived from a
    // frame the solver itself sent — no route added to this file may ever
    // construct or send a frame TOWARDS the solver (see the header).
    if (request.method === "GET" && url.pathname === "/tokens") {
      return Response.json(
        {
          tokens: state.capabilities?.tokenIds ?? [],
          updatedAt: state.capabilitiesAt,
          mode: "observation",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (!authorized(request)) {
      state.unauthorizedUpgrades += 1;
      console.warn(`[sink] refused an unauthenticated upgrade at ${url.pathname}`);
      return new Response("unauthorized", { status: 401 });
    }
    if (server.upgrade(request)) return undefined;
    return new Response("expected a websocket upgrade", { status: 426 });
  },
  websocket: {
    open() {
      state.solverConnected = true;
      state.solverConnections += 1;
      state.lastConnectedAt = Date.now();
      record("connection", true, "solver connected");
      console.log("[sink] solver connected");
      broadcast();
    },
    message(_ws, message) {
      handleSolverFrame(typeof message === "string" ? message : new TextDecoder().decode(message));
    },
    close() {
      state.solverConnected = false;
      state.lastDisconnectedAt = Date.now();
      record("connection", true, "solver disconnected");
      console.log("[sink] solver disconnected");
      broadcast();
    },
  },
});

// ─── the public listener ─────────────────────────────────────────────────────

Bun.serve({
  port: PUBLIC_PORT,
  hostname: "0.0.0.0",
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(request)) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    if (url.pathname === "/api/snapshot") {
      return Response.json(snapshot(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/stream") {
      let self: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          self = controller;
          sseControllers.add(controller);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot())}\n\n`));
        },
        cancel() {
          if (self) sseControllers.delete(self);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", solverConnected: state.solverConnected });
    }

    const name = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    // Serve only from PUBLIC_DIR, and only names without traversal.
    if (/^[a-zA-Z0-9._-]+$/.test(name)) {
      const file = Bun.file(join(PUBLIC_DIR, name));
      if (await file.exists()) return new Response(file);
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      browserSockets.add(ws);
      try {
        ws.send(JSON.stringify(snapshot()));
      } catch {
        // The close handler cleans up a socket that cannot take the first frame.
      }
    },
    message() {
      // The browser surface is read-only. Nothing a page sends is honoured.
    },
    close(ws) {
      browserSockets.delete(ws);
    },
  },
});

setInterval(() => void pollBook(), BOOK_POLL_MS).unref?.();
void pollBook();

console.log(
  `[sink] observation mode — relay ingress :${RELAY_PORT} (bearer-authenticated), ` +
    `public :${PUBLIC_PORT}, kernel ${ZSWAP_API}`,
);
console.log(`[sink] wire contract ${RELAY_WS_CONTRACT_REVISION}; NO swap job will ever be dispatched`);
