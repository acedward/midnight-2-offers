// views.js — the console's segmented views: COW Solver feed + Infrastructure.
// (app.js owns the Account Abstraction view and the shared api()/$ helpers.)
"use strict";

// ── router ───────────────────────────────────────────────────────────────────

const HEAD_NOTES = {
  aa: "Your browser EVM wallet signs EIP-712 actions; the stack's relay proves them (~1–2 min) through the compose proof server and submits to Midnight. The wallet never sees a Midnight key.",
  solver: "The ported COW solver, observed live over the relay WebSocket boundary it would normally speak to the Midnight Intents relay — received by a demo sink that can never send it work.",
  infra: "Every component of the compose stack, probed over the internal network by the console's relay service.",
  aamid: "UI preview: the same AA account flows, authorized by a Midnight wallet instead of an EVM one. Not wired yet.",
  memos: "The Web Memo app, embedded as-is from its own deployment.",
  repos: "The exact branches, commits and pull requests every piece of this stack is built from.",
};
const VIEW_NAMES = ["aa", "aamid", "solver", "infra", "memos", "repos"];

function showView(name) {
  for (const b of document.querySelectorAll("#seg button")) b.classList.toggle("active", b.dataset.view === name);
  for (const v of document.querySelectorAll("main.view")) v.classList.toggle("active", v.id === `view-${name}`);
  document.getElementById("head-note").textContent = HEAD_NOTES[name] ?? "";
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "solver") startSolverFeed();
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

const INFRA_NODES = [
  { id: "browser",       label: "Your browser",              sub: "",                  x: 470, y: 14,  w: 180, h: 42, fixed: "up" },
  { id: "console",       label: "AA Console (this page)",    sub: ":10700 · profile aa", x: 55,  y: 100, w: 205, h: 56 },
  { id: "frontend",      label: "zswap-da frontend",         sub: ":10600 · frontend",  x: 330, y: 100, w: 200, h: 56 },
  { id: "solverSink",    label: "Solver sink + feed",        sub: ":10800 · solver",    x: 600, y: 100, w: 200, h: 56 },
  { id: "evmRpc",        label: "umbra-evm JSON-RPC",        sub: ":8545 · evm",        x: 870, y: 100, w: 195, h: 56 },
  { id: "aaProofServer", label: "aa-proof-server",           sub: "experimental · internal", x: 55, y: 225, w: 205, h: 50 },
  { id: "kernel",        label: "offer-files kernel+batcher", sub: ":9999 / :3334 · offerfiles", x: 330, y: 225, w: 200, h: 60 },
  { id: "solver",        label: "COW solver",                sub: "observation mode",   x: 600, y: 225, w: 200, h: 50 },
  { id: "proofServer",   label: "proof-server (plain)",      sub: ":6300 · core",       x: 55,  y: 350, w: 205, h: 50 },
  { id: "celestia",      label: "Celestia DA devnet",        sub: ":26658 · offerfiles", x: 330, y: 350, w: 200, h: 50 },
  { id: "indexer",       label: "indexer 4.4.0-rc.1",        sub: ":8088 · core",       x: 200, y: 480, w: 205, h: 56 },
  { id: "node",          label: "midnight node 2.0.0-rc.4",  sub: ":9944 · core",       x: 480, y: 480, w: 210, h: 56 },
];
const INFRA_EDGES = [
  ["browser", "console"], ["browser", "frontend"], ["browser", "solverSink"], ["browser", "evmRpc"],
  ["console", "aaProofServer"], ["console", "proofServer"], ["console", "kernel"], ["console", "node"], ["console", "indexer"],
  ["frontend", "kernel"],
  ["solver", "kernel"], ["solver", "solverSink"],
  ["kernel", "celestia"], ["kernel", "node"], ["kernel", "indexer"],
  ["evmRpc", "indexer"],
  ["indexer", "node"],
];
const INFRA_LABELS = {
  console: "AA console (relay + page)", node: "midnight node", indexer: "indexer",
  proofServer: "proof-server (plain)", aaProofServer: "aa-proof-server (experimental)",
  kernel: "offer-files kernel", kernelSync: "kernel sync", batcher: "batcher",
  celestia: "celestia", evmRpc: "umbra-evm RPC", frontend: "zswap-da frontend",
  solverSink: "solver sink", solver: "cow-solver",
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
    repo: "effectstream/zswap-offerfiles-kernel", url: "https://github.com/effectstream/zswap-offerfiles-kernel",
    role: "offer-files kernel + batcher (profile offerfiles)",
    ref: "branch 00001-ledger-v9",
    notes: [["PR #49", "https://github.com/effectstream/zswap-offerfiles-kernel/pull/49", "migrated from v8 to v9"]],
  },
  {
    repo: "effectstream/zswap-offerfiles-kernel (solver)", url: "https://github.com/effectstream/zswap-offerfiles-kernel/tree/00001-solver-v9",
    role: "COW solver, observation mode (profile solver; the kernel also builds from this branch when the solver runs)",
    ref: "branch 00001-solver-v9",
    notes: [["PR #50", "https://github.com/effectstream/zswap-offerfiles-kernel/pull/50", "the v9 port, pointing into PR #48"]],
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
    ref: "branch feat/00006-json-rpc-review",
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
    ref: "LOCAL v9-migrated checkout (ZSWAP_DA_TEMPLATE_DIR)",
    notes: [["", "", "checked 2026-08-26: upstream v-next has @effectstream 0.200.1 but still ledger-v8 + midnight-js 4 — the local checkout is still required"]],
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
    ref: "image 2.0.0-rc.4",
    notes: [],
  },
  {
    repo: "midnightntwrk/indexer-standalone", muted: true, url: "https://hub.docker.com/r/midnightntwrk/indexer-standalone",
    role: "the chain indexer (core; GraphQL v4)",
    ref: "image 4.4.0-rc.1 (linux/amd64 only)",
    notes: [],
  },
  {
    repo: "midnightntwrk/proof-server", muted: true, url: "https://hub.docker.com/r/midnightntwrk/proof-server",
    role: "proving — TWO instances: plain (kernel's v6 keys) + _experimental (the aa profile's zkir-v3/v7 keys)",
    ref: "images 9.0.0-rc.5 and 9.0.0-rc.5_experimental",
    notes: [],
  },
  {
    repo: "midnightntwrk/midnight-node-toolkit", muted: true, url: "https://hub.docker.com/r/midnightntwrk/midnight-node-toolkit",
    role: "wallet funding / address derivation (scripts)",
    ref: "image 2.0.0-rc.4 (must match the node)",
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
