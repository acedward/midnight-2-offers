// views.js — the console's segmented views: COW Solver feed + Infrastructure.
// (app.js owns the Account Abstraction view and the shared api()/$ helpers.)
"use strict";

// ── router ───────────────────────────────────────────────────────────────────

const HEAD_NOTES = {
  aa: "The AA Wallet — your browser EVM wallet signs EIP-712 actions; the stack's relay proves them (~1–2 min) and submits to Midnight. The wallet never sees a Midnight key.",
  aainfra: "The AA plumbing: the stack's contracts and wallets, token faucets and funding, and every account on the Manager.",
  solver: "The offer book, and the ported COW solver observed live over its relay WebSocket boundary — received by a demo sink that can never send it work.",
  infra: "Every component of the compose stack, probed over the internal network by the console's relay service.",
  aamid: "UI preview: the same AA account flows, authorized by a Midnight wallet instead of an EVM one. Not wired yet.",
  memos: "The Web Memo app, embedded as-is from its own deployment.",
  repos: "The exact branches, commits and pull requests every piece of this stack is built from.",
};
const VIEW_NAMES = ["aa", "aainfra", "aamid", "solver", "infra", "memos", "repos"];

function showView(name) {
  for (const b of document.querySelectorAll("#seg button")) b.classList.toggle("active", b.dataset.view === name);
  for (const v of document.querySelectorAll("main.view")) v.classList.toggle("active", v.id === `view-${name}`);
  document.getElementById("head-note").textContent = HEAD_NOTES[name] ?? "";
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "solver") {
    // Two frames, one lazy load each: the sink's feed (what the relay received)
    // and the solver's own monitor site (what the solver says about itself).
    const lazyFrame = (frameId, linkId, infoKey, fallback) => {
      const frame = document.getElementById(frameId);
      if (!frame || frame.src) return;
      const setSrc = (url) => {
        frame.src = url;
        const link = document.getElementById(linkId);
        if (link) link.href = url;
      };
      const known = (window.state && state.info && state.info[infoKey]) || null;
      if (known) setSrc(known);
      else fetch("/api/info").then((r) => r.json())
        .then((i) => setSrc(i[infoKey] || fallback))
        .catch(() => setSrc(fallback));
    };
    lazyFrame("solver-frame", "solver-frame-link", "sinkPublicUrl", "http://127.0.0.1:10800");
    lazyFrame("solver-monitor-frame", "solver-monitor-frame-link", "solverFrontendUrl", "http://127.0.0.1:10802");
  }
  if (name === "infra") startInfraPoll(); else stopInfraPoll();
  if (name === "memos") {
    // Lazy: the external app loads only when the tab is first opened.
    const frame = document.getElementById("memos-frame");
    if (!frame.src) frame.src = frame.dataset.src;
  }
  if (name === "repos") renderRepos();
}
document.getElementById("seg").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-view]");
  if (b) showView(b.dataset.view);
});
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (VIEW_NAMES.includes(name)) showView(name);
});
// (initial hash routing runs at the BOTTOM of this file — showView touches
// view state declared below, and a top-level call here lands in the TDZ)

// ── solver view ──────────────────────────────────────────────────────────────

let solverStarted = false;
let solverEs = null;

function startSolverFeed() {
  if (solverStarted) return;
  solverStarted = true;
  const poll = async () => {
    try {
      const r = await fetch("/api/solver/snapshot").then((x) => x.json());
      if (r.sink) renderSolver(r.snapshot);
      else renderSolverDown();
    } catch { renderSolverDown(); }
  };
  poll();
  setInterval(() => { if (!solverEs) poll(); }, 5000); // fallback while no SSE
  try {
    solverEs = new EventSource("/api/solver/stream");
    solverEs.onmessage = (ev) => { try { renderSolver(JSON.parse(ev.data)); } catch {} };
    solverEs.onerror = () => { solverEs?.close(); solverEs = null; }; // polling takes over
  } catch { solverEs = null; }
}

function pillTo(el, kind, text) {
  el.innerHTML = "";
  const p = document.createElement("span");
  p.className = `pill ${kind}`;
  p.textContent = text;
  el.append(p);
}

function renderSolverDown() {
  pillTo(document.getElementById("sv-state"), "dim", "sink offline — start the solver profile (./up.sh --with offerfiles --with solver)");
}

function renderSolver(s) {
  pillTo(document.getElementById("sv-state"), "ok", solverEs ? "live (SSE)" : "polling");
  const conn = s.solver ?? {};
  pillTo(document.getElementById("sv-conn"), conn.connected ? "ok" : "warn", conn.connected ? "connected" : "not connected");
  document.getElementById("sv-conn").append(
    ` sessions=${conn.connections ?? 0}${conn.lastFrameAt ? ` last frame ${new Date(conn.lastFrameAt).toLocaleTimeString()}` : ""}`);
  const f = s.frames ?? {};
  document.getElementById("sv-frames").textContent =
    `received ${f.received ?? 0} · accepted ${f.accepted ?? 0} · rejected ${f.rejected ?? 0}`;
  document.getElementById("sv-book").textContent = s.bookError
    ? `error: ${s.bookError}`
    : `${(s.book?.offers ?? s.book ?? []).length ?? 0} offer(s)` + (s.kernelSync ? ` · kernel sync ${JSON.stringify(s.kernelSync).slice(0, 80)}` : "");
  const safety = s.safety ?? {};
  document.getElementById("sv-safety").textContent =
    `frames sent to solver ${safety.framesSentToSolver ?? 0} · jobs dispatched ${safety.swapJobsDispatched ?? 0} · unauthorized upgrades ${safety.unauthorizedUpgrades ?? 0}`;
  const alarm = document.getElementById("sv-alarm");
  if ((safety.jobFramesReceived ?? 0) > 0) {
    alarm.style.display = "";
    alarm.textContent = `ALARM: the solver answered ${safety.jobFramesReceived} job frame(s) nobody sent — this should be impossible in observation mode.`;
  } else alarm.style.display = "none";

  // Ladders — the real wire shape (measured live 2026-08-26) is ONE
  // price-levels frame: {type:"price-levels", levels:[{tokenIn, tokenOut,
  // levels:[{input, output}]}]}. A map-of-pairs fallback stays for safety.
  const wrap = document.getElementById("sv-ladders");
  wrap.innerHTML = "";
  const shortHex = (v) => typeof v === "string" && /^[0-9a-f]{16,}$/i.test(v) ? `${v.slice(0, 8)}…${v.slice(-6)}` : String(v);
  const NIGHT = "0".repeat(64);
  const tokenName = (t) => (t === NIGHT ? "NIGHT" : shortHex(t));
  const raw = s.ladders ?? {};
  const pairEntries = Array.isArray(raw.levels)
    ? raw.levels.map((e) => ({
        label: `${tokenName(e.tokenIn)} → ${tokenName(e.tokenOut)}`,
        title: `${e.tokenIn} → ${e.tokenOut}`,
        levels: e.levels ?? [],
      }))
    : Object.entries(raw).map(([pair, e]) => ({
        label: shortHex(pair), title: pair,
        levels: Array.isArray(e) ? e : e?.levels ?? [e],
      }));
  if (!pairEntries.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "no ladders published yet" + (conn.connected ? " (solver connected, waiting for price-levels frames)" : "");
    wrap.append(p);
  }
  for (const pair of pairEntries.slice(0, 12)) {
    const box = document.createElement("div");
    box.className = "ladder";
    const h = document.createElement("h3");
    h.textContent = pair.label;
    h.title = pair.title;
    box.append(h);
    const tbl = document.createElement("table");
    for (const lvl of pair.levels.slice(0, 10)) {
      const tr = document.createElement("tr");
      if (lvl && typeof lvl === "object") {
        for (const [k, v] of Object.entries(lvl).slice(0, 4)) {
          const td = document.createElement("td");
          td.textContent = `${k} ${shortHex(v)}`;
          td.className = "num";
          tr.append(td);
        }
        if ("input" in lvl && "output" in lvl && Number(lvl.input) > 0) {
          const td = document.createElement("td");
          td.textContent = `rate ${(Number(lvl.output) / Number(lvl.input)).toFixed(3)}`;
          tr.append(td);
        }
      } else {
        const td = document.createElement("td");
        td.textContent = String(lvl);
        tr.append(td);
      }
      tbl.append(tr);
    }
    box.append(tbl);
    if (s.laddersAt) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = `at ${new Date(s.laddersAt).toLocaleTimeString()}`;
      box.append(n);
    }
    wrap.append(box);
  }

  // Admission (inferred) — array or map of {pair, onBook, published}-ish rows.
  const tbody = document.getElementById("sv-admission");
  tbody.innerHTML = "";
  const adm = s.admission ?? [];
  const rows = Array.isArray(adm) ? adm : Object.entries(adm).map(([pair, v]) => ({ pair, ...(typeof v === "object" ? v : { value: v }) }));
  for (const r of rows.slice(0, 20)) {
    const tr = document.createElement("tr");
    const cells = [
      shortHex(String(r.pair ?? r.id ?? "?")),
      String(r.onBook ?? r.book ?? r.offers ?? "—"),
      String(r.published ?? r.ladder ?? r.laddered ?? "—"),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  }

  // History — newest first, compact single lines.
  const hist = document.getElementById("sv-history");
  hist.textContent = (s.history ?? [])
    .map((e) => typeof e === "string" ? e : JSON.stringify(e))
    .join("\n") || "(no frames yet)";
}

// ── infrastructure view ──────────────────────────────────────────────────────

const INFRA_LAYERS = [
  { label: "Browser",        y: 12,  band: [12, 84] },
  { label: "dApps",          y: 96,  band: [96, 196] },
  { label: "Infrastructure", y: 208, band: [208, 452] },
  { label: "Blockchain",     y: 464, band: [464, 590] },
];
const INFRA_NODES = [
  // Browser
  { id: "browser",       label: "Your browser",              sub: "MetaMask + these pages", x: 460, y: 28,  w: 200, h: 46, fixed: "up" },
  // dApps
  { id: "console",       label: "aa-relay (console backend)", sub: "serves this page + API · :10700", x: 30,  y: 122, w: 210, h: 56 },
  { id: "frontend",      label: "aa-frontend (zswap-da)",    sub: ":10600 · static, backend = kernel", x: 265, y: 122, w: 210, h: 56 },
  { id: "solverSink",    label: "solver-sink (ladder feed)", sub: ":10800 · relay-WS receive half", x: 500, y: 122, w: 205, h: 56 },
  { id: "solverMonitor", label: "solver-frontend (monitor)", sub: ":10802 · read-only, no wallet", x: 730, y: 122, w: 205, h: 56 },
  // Infrastructure
  { id: "indexer",       label: "indexer",                   sub: ":8088 · GraphQL v4", x: 30,  y: 240, w: 150, h: 52 },
  { id: "evmRpc",        label: "umbra (eth JSON-RPC)",      sub: ":8545 · read-only",  x: 195, y: 240, w: 175, h: 52 },
  { id: "kernel",        label: "offer-files kernel",        sub: ":9999 · contract deployed once", x: 385, y: 240, w: 190, h: 52 },
  { id: "batcher",       label: "batcher",                   sub: ":3334 · own container", x: 590, y: 240, w: 140, h: 52 },
  { id: "offerPoster",   label: "offer-poster",              sub: ":9977 · mints + posts, profile `poster`", x: 745, y: 240, w: 175, h: 52 },
  { id: "solver",        label: "cow (solver)",              sub: "observation · status :9100", x: 935, y: 240, w: 155, h: 52 },
  { id: "proofServer",   label: "proof-server 9.0.0-rc.5",   sub: "plain · zkir-v2 / [v6] + wallet lane", x: 240, y: 356, w: 250, h: 52 },
  { id: "aaProofServer", label: "proof-server 9.0.0-rc.5 experimental", sub: "zkir-v3 / [v7] — the AA circuits", x: 530, y: 356, w: 290, h: 52 },
  { id: "postgres",      label: "postgres (shared)",         sub: "offerfiles + umbra · one store", x: 845, y: 356, w: 200, h: 52 },
  // Blockchain
  { id: "node",          label: "midnight-node 2.0.0-rc.4",  sub: ":9944 · the chain",  x: 280, y: 496, w: 240, h: 56 },
  { id: "celestia",      label: "celestia (DA devnet)",      sub: ":26658 · the offer blobs", x: 600, y: 496, w: 240, h: 56 },
];
const INFRA_EDGES = [
  ["browser", "console"], ["browser", "frontend"], ["browser", "solverSink"], ["browser", "solverMonitor"],
  ["console", "kernel"], ["console", "proofServer"], ["console", "aaProofServer"],
  ["console", "node"], ["console", "indexer"],
  ["frontend", "kernel"], ["frontend", "batcher"],
  ["solver", "solverSink"], ["solver", "kernel"],
  // The monitor reads three sources and writes to none of them. `solver` is the
  // UNPUBLISHED :9100 status listener — this edge exists entirely inside the
  // compose network, which is the point: the page is the listener's only
  // intended reader.
  ["solverMonitor", "solver"], ["solverMonitor", "kernel"], ["solverMonitor", "solverSink"],
  // The poster: it mints and posts through the kernel, and pays with its own
  // dust — so it needs the chain, the indexer and a prover of its own.
  ["offerPoster", "kernel"], ["offerPoster", "node"], ["offerPoster", "indexer"], ["offerPoster", "proofServer"],
  ["kernel", "batcher"], ["kernel", "node"], ["kernel", "indexer"], ["kernel", "celestia"],
  ["batcher", "celestia"], ["batcher", "node"],
  ["evmRpc", "indexer"],
  ["indexer", "node"],
  // The one store (T11.4): the kernel's offer book and umbra's index.
  ["kernel", "postgres"], ["evmRpc", "postgres"],
];
// Short names for the table (long text hover-only — it was forcing a scroll).
const INFRA_LABELS = {
  console: "aa-relay", node: "midnight-node", indexer: "indexer",
  proofServer: "proof-server (plain)", aaProofServer: "proof-server (exp)",
  kernel: "offer-files kernel", kernelSync: "kernel sync", batcher: "batcher",
  celestia: "celestia", evmRpc: "umbra-evm RPC", frontend: "zswap-da frontend",
  solverSink: "solver sink", solver: "cow-solver", postgres: "postgres (shared)",
  solverFrontend: "solver monitor", offerPoster: "offer-poster",
};
const INFRA_TITLES = {
  console: "the relay: serves this page, runs wallet sessions/proving/submission, proxies the kernel + solver sink, probes this table",
  kernel: "sync node :9999; contract deployed once per stack, address persisted",
  batcher: ":3334 — own container since the split",
  postgres: "the one store for the stack: the kernel's offer book (db offerfiles) + umbra's index (db umbra); no host port, TCP-level probe",
  aaProofServer: "9.0.0-rc.5 experimental — zkir-v3 / [v7], the AA circuits; internal only, digest-pinned from the ghcr.io/effectstream mirror",
  proofServer: "9.0.0-rc.5 plain — zkir-v2 / [v6] + the wallet standard lane; digest-pinned from the ghcr.io/effectstream mirror. Both read ONE verified proof-data generation, read-only",
  solver: "observation mode. Probed on its OWN status listener :9100 (open GET /health, no internal data); /status/* is bearer-gated and unpublished, and the monitor site is its only intended reader. Falls back to the sink's view of the relay socket",
  solverFrontend: "the read-only monitor site :10802 — is the solver quoting, and if not why. Holds no wallet, opens no relay socket, mutates nothing; depends on the KERNEL only, so it stays up (and says SOLVER UNREACHABLE) exactly when the solver is down",
  offerPoster: "profile `poster`: every interval it re-offers a released coin or mints one fresh coin from the faucet circuit and posts a single takeable offer, paying with its own dust. /health carries state, mints and lastOfferId",
};
const DOT = { up: "#6fd18b", down: "#e57373", absent: "#4a5563" };

let infraTimer = null;
function startInfraPoll() {
  if (infraTimer) return;
  const tick = async () => {
    try {
      const r = await fetch("/api/infra").then((x) => x.json());
      renderInfra(r);
      pillTo(document.getElementById("if-state"), "ok", `probed ${new Date(r.at).toLocaleTimeString()}`);
    } catch (e) {
      pillTo(document.getElementById("if-state"), "err", "probe failed");
    }
  };
  tick();
  infraTimer = setInterval(tick, 6000);
}
function stopInfraPoll() {
  if (infraTimer) { clearInterval(infraTimer); infraTimer = null; }
}

function renderInfra(r) {
  const comps = r.components ?? {};
  const canvas = document.getElementById("infra-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const byId = Object.fromEntries(INFRA_NODES.map((n) => [n.id, n]));
  const center = (n) => ({ cx: n.x + n.w / 2, cy: n.y + n.h / 2 });

  // Layer bands: label on the left, a dashed separator above each band.
  for (const [i, L] of INFRA_LAYERS.entries()) {
    if (i > 0) {
      ctx.strokeStyle = "#2c3542";
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(0, L.band[0] - 6);
      ctx.lineTo(canvas.width, L.band[0] - 6);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#8b96a5";
    ctx.font = "600 11px system-ui";
    ctx.save();
    ctx.translate(14, (L.band[0] + L.band[1]) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(L.label.toUpperCase(), 0, 0);
    ctx.restore();
    ctx.textAlign = "left";
  }

  // Edges first (under the boxes): from the source's edge toward the target.
  ctx.strokeStyle = "#2c3542";
  ctx.lineWidth = 1.25;
  for (const [a, b] of INFRA_EDGES) {
    const A = center(byId[a]), B = center(byId[b]);
    ctx.beginPath();
    ctx.moveTo(A.cx, A.cy);
    ctx.lineTo(B.cx, B.cy);
    ctx.stroke();
  }

  for (const n of INFRA_NODES) {
    const status = n.fixed ?? comps[n.id]?.status ?? "absent";
    ctx.beginPath();
    const r8 = 8;
    ctx.roundRect(n.x, n.y, n.w, n.h, r8);
    ctx.fillStyle = "#171c24";
    ctx.fill();
    ctx.lineWidth = status === "up" ? 1.5 : 2;
    ctx.strokeStyle = DOT[status] ?? DOT.absent;
    if (status === "absent") ctx.setLineDash([4, 4]); else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = DOT[status] ?? DOT.absent;
    ctx.beginPath();
    ctx.arc(n.x + 14, n.y + n.h / 2 - (n.sub ? 8 : 0), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#dde4ee";
    ctx.font = "600 13px system-ui";
    ctx.fillText(n.label, n.x + 26, n.y + n.h / 2 - (n.sub ? 4 : -4), n.w - 34);
    if (n.sub) {
      ctx.fillStyle = "#8b96a5";
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.fillText(n.sub, n.x + 26, n.y + n.h / 2 + 12, n.w - 34);
    }
  }

  // Table with every probed component (including the ones not drawn: batcher, kernelSync).
  const tbody = document.getElementById("if-table");
  tbody.innerHTML = "";
  for (const [id, c] of Object.entries(comps)) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = INFRA_LABELS[id] ?? id;
    tdName.style.whiteSpace = "normal";
    if (INFRA_TITLES[id]) tdName.title = INFRA_TITLES[id];
    const tdStatus = document.createElement("td");
    const dot = document.createElement("span");
    dot.className = "statusdot " + (c.status === "up" ? "dot-up" : c.status === "down" ? "dot-down" : "dot-absent");
    tdStatus.append(dot, c.status);
    const tdInfo = document.createElement("td");
    tdInfo.style.whiteSpace = "normal";
    tdInfo.textContent = typeof c.info === "object" ? JSON.stringify(c.info) : String(c.info ?? "");
    tr.append(tdName, tdStatus, tdInfo);
    tbody.append(tr);
  }
}

// ── repos view ───────────────────────────────────────────────────────────────

const REPOS = [
  {
    repo: "acedward/midnight-2-offers", url: "https://github.com/acedward/midnight-2-offers",
    role: "THIS demo stack — compose, scripts, wallets, this console",
    ref: "main",
    notes: [],
  },
  {
    repo: "acedward/AA-midnight-evm-experiment-v3", url: "https://github.com/acedward/AA-midnight-evm-experiment-v3",
    role: "AA Manager + test Minter contracts, EIP-712 codec (baked as /aa/aalib)",
    ref: "main @ 713a2021 (sha-pinned)",
    notes: [["PR #10", "https://github.com/acedward/AA-midnight-evm-experiment-v3/pull/10", "merged to main; pinned because key-breaking merges need an explicit redeploy"]],
  },
  {
    repo: "acedward/AA-midnight-evm-experiment-minocrab", url: "https://github.com/acedward/AA-midnight-evm-experiment-minocrab",
    role: "the k=18 execute variation (MinoCrab-compiled alternative zkir — the AA_EXECUTE_K18 overlay: 544 MiB prover key, ~2x faster proofs)",
    ref: "00020 handoff artifacts (AA_K18_DIR)",
    notes: [["", "", "equivalence-tested against compactc (56/56 + 4,888 tamper probes); unaudited compiler — dev chains only"]],
  },
  {
    repo: "effectstream/zswap-offerfiles-kernel", url: "https://github.com/effectstream/zswap-offerfiles-kernel",
    role: "offer-files kernel + batcher + the token price service (profile offerfiles) — ONE commit for the whole kernel line",
    ref: "4af102536f02f137b696a4734bd8c936eddf3672 (branch ledger-v9)",
    notes: [
      ["PR #65", "https://github.com/effectstream/zswap-offerfiles-kernel/pull/65", "the unified ledger-v9 line — DRAFT when pinned; the SHA is the identity, not the branch or the PR"],
      ["", "", "brings /v1/prices + /v1/quote and the batcher sponsorship gate (#54–#56) — BREAKING: it moves 000-init.sql, so an older postgres volume needs ./down.sh -v"],
      ["", "", "and 6 decimals on every token (#61, #63): the book's amounts are whole coins × 10⁶"],
    ],
  },
  {
    repo: "effectstream/zswap-offerfiles-kernel (solver)", url: "https://github.com/effectstream/zswap-offerfiles-kernel/tree/ledger-v9",
    role: "COW solver, observation mode, + its status listener :9100 and the solver-frontend monitor site (profile solver)",
    ref: "pinned 4af1025… — the SAME commit as the kernel (SOLVER_REF is a separate knob)",
    notes: [
      ["PR #58 / #59", "https://github.com/effectstream/zswap-offerfiles-kernel/pull/59", "the read-only status listener and the monitor page it feeds"],
      ["", "", "runs start.solver.ts behind this repo's undeployed-only gate: solver.dev.ts never passes the status option, so the listener could not come up on it"],
    ],
  },
  {
    repo: "effectstream/zswap-offerfiles-kernel (offer poster)", url: "https://github.com/effectstream/zswap-offerfiles-kernel/tree/ledger-v9",
    role: "the offer poster (profile poster) — mints one exact coin and posts one takeable offer per interval, from its own dedicated wallet",
    ref: "pinned 4af1025… — deploy/scripts/offer-poster.ts from the same commit",
    notes: [
      ["PR #57 / #60 / #66", "https://github.com/effectstream/zswap-offerfiles-kernel/pull/66", "the poster, its journal, and the randomised give size (GIVE_MIN/GIVE_MAX)"],
    ],
  },
  {
    repo: "effectstream/effectstream", url: "https://github.com/effectstream/effectstream",
    role: "the @effectstream npm packages every runner here uses",
    ref: "npm @effectstream/*@0.200.2 · mip-zswap-offer@0.4.0-v9.0",
    notes: [["PR #882", "https://github.com/effectstream/effectstream/pull/882", "merged; consumed from npm"]],
  },
  {
    repo: "acedward/UmbraDB", url: "https://github.com/acedward/UmbraDB",
    role: "umbra-evm read-only Ethereum JSON-RPC (profile evm)",
    ref: "pinned 5a463485… from evm-compat",
    notes: [["PR #5", "https://github.com/acedward/UmbraDB/pull/5", "home of the JSON-RPC work — everything merged into it"]],
  },
  {
    repo: "shieldedtech/midnight-intents-swaps", muted: true, url: "https://github.com/shieldedtech/midnight-intents-swaps",
    role: "the Midnight Intents relay the solver would execute through",
    ref: "pinned d444c83 — DROPPED (observation-only solver)",
    notes: [],
  },
  {
    repo: "effectstream templates/zswap-da", url: "https://github.com/effectstream/effectstream",
    role: "the swap frontend (profile frontend)",
    ref: "effectstream/effectstream @ ea04ff7c + local ledger-v9 patch",
    notes: [["", "", "upstream templates/zswap-da is fetched at the immutable commit (subtree ea22913c verified too); images/zswap-da/ledger-v9.patch carries the 11 required v9 adaptations, with no copied SPA tree"]],
  },
  {
    repo: "acedward/web-memo", url: "https://github.com/acedward/web-memo",
    role: "the Memos tab app (web-memo.pages.dev)",
    ref: "main (deployed on Cloudflare Pages)",
    notes: [],
  },
  {
    repo: "acedward/midnight-ledger", url: "https://github.com/acedward/midnight-ledger",
    role: "the memo-v3 ledger fork Web Memo builds on",
    ref: "PR #2 branch",
    notes: [["PR #2", "https://github.com/acedward/midnight-ledger/pull/2", "the memo format lives on a ledger fork, not upstream"]],
  },
  {
    repo: "acedward/dusk-wallet", url: "https://github.com/acedward/dusk-wallet/tree/00001-utxo-pinning",
    role: "dusk wallet — UTxO pinning work",
    ref: "branch 00001-utxo-pinning",
    notes: [["", "", "PRIVATE repo — the link needs access"]],
  },
  {
    repo: "midnightntwrk/midnight-node", muted: true, url: "https://hub.docker.com/r/midnightntwrk/midnight-node",
    role: "the Midnight node (core)",
    ref: "official image 2.0.0-rc.4, multiarch index-digest pinned",
    notes: [],
  },
  {
    repo: "midnightntwrk/midnight-indexer", muted: true, url: "https://github.com/midnightntwrk/midnight-indexer",
    role: "the chain indexer (core; GraphQL v4)",
    ref: "4.4.0-rc.3 published binary; source 56561b2f recorded as provenance",
    notes: [["", "", "rc3 fixes rc1's standalone SQLite deadlock; its Docker Hub manifest was not published, so the exact executable is installed from the warehouse instead of compiled"]],
  },
  {
    repo: "effectstream/binaries", url: "https://github.com/effectstream/binaries/releases/tag/0.3.120",
    role: "binary warehouse — the indexer, both Celestia binaries, and the 21 noarch proof-data payloads",
    ref: "release 0.3.120, every asset pinned by SHA-256",
    notes: [["", "", "DEVELOPMENT ONLY and MUTABLE: an asset can be re-uploaded under the same name, so the hashes are the identity, not the URL"]],
  },
  {
    repo: "midnightntwrk/proof-server", muted: true, url: "https://hub.docker.com/r/midnightntwrk/proof-server",
    role: "proving — TWO different programs: plain (kernel's v6 / zkir-v2 keys) + experimental (the aa profile's zkir-v3 / v7 keys)",
    ref: "9.0.0-rc.5 plain and 9.0.0-rc.5 experimental, consumed by digest",
    notes: [["ghcr mirror", "https://github.com/effectstream/binaries", "pulled from ghcr.io/effectstream/midnight-proof-server — an exact byte-for-byte mirror of these upstream indexes, because upstream availability at startup is unreliable"]],
  },
  {
    repo: "midnightntwrk/midnight-node-toolkit", muted: true, url: "https://hub.docker.com/r/midnightntwrk/midnight-node-toolkit",
    role: "wallet funding / address derivation (scripts)",
    ref: "official image 2.0.0-rc.4, index-digest pinned (must match the node)",
    notes: [],
  },
];

let reposRendered = false;
function renderRepos() {
  if (reposRendered) return;
  reposRendered = true;
  const tbody = document.getElementById("repos-table");
  for (const r of REPOS) {
    const tr = document.createElement("tr");
    if (r.muted) {
      // Upstream / third-party rows we consume but do not change (we manage
      // the acedward/* and effectstream/* repos).
      tr.style.opacity = "0.45";
      tr.title = "upstream dependency — no code changes of ours";
    }
    const tdRepo = document.createElement("td");
    const a = document.createElement("a");
    a.href = r.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = r.repo;
    tdRepo.append(a);
    const tdRole = document.createElement("td");
    tdRole.style.whiteSpace = "normal";
    tdRole.textContent = r.role;
    const tdRef = document.createElement("td");
    tdRef.style.whiteSpace = "normal";
    tdRef.textContent = r.ref;
    const tdNotes = document.createElement("td");
    tdNotes.style.whiteSpace = "normal";
    r.notes.forEach(([label, href, why], i) => {
      if (i) tdNotes.append(document.createElement("br"));
      if (label) {
        const n = document.createElement("a");
        n.href = href; n.target = "_blank"; n.rel = "noopener";
        n.textContent = label;
        tdNotes.append(n);
      }
      if (why) tdNotes.append((label ? " — " : "") + why);
    });
    tr.append(tdRepo, tdRole, tdRef, tdNotes);
    tbody.append(tr);
  }
}

// initial route (after all view state above is initialized)
if (VIEW_NAMES.includes(location.hash.slice(1)) && location.hash !== "#aa") showView(location.hash.slice(1));
