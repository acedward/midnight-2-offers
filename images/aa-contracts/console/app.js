// AA Console — browser side. Deliberately thin: this page holds NO Midnight
// wallet and NO prover. It signs `eth_signTypedData_v4` requests the relay
// builds (AA repo codec, server-side) and polls relay jobs. See aa-console.ts.
"use strict";

const $ = (id) => document.getElementById(id);
const short = (h) => (h && h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h ?? "—");

const state = {
  info: null,
  signer: null,      // lowercase 0x address
  signerKind: null,  // 'wallet' | 'dev'
  accounts: [],
  activeJob: null,
};

const api = async (path, body) => {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} on ${path}`);
  return data;
};

// ── wallet ───────────────────────────────────────────────────────────────────

async function connectWallet() {
  if (!window.ethereum) {
    setStatus("err", "no EIP-1193 provider — install MetaMask (or use the dev signer if enabled)");
    return;
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("wallet returned no accounts");
  state.signer = String(accounts[0]).toLowerCase();
  state.signerKind = "wallet";
  onSignerChanged();
}

function useDevSigner() {
  state.signer = state.info.devSigner.address.toLowerCase();
  state.signerKind = "dev";
  onSignerChanged();
}

window.ethereum?.on?.("accountsChanged", (accounts) => {
  if (state.signerKind !== "wallet") return;
  state.signer = accounts?.length ? String(accounts[0]).toLowerCase() : null;
  onSignerChanged();
});

function onSignerChanged() {
  $("w-addr").textContent = state.signer ?? "—";
  $("w-addr").title = state.signer ?? "";
  $("w-addr").style.display = state.signer ? "" : "none";
  setStatus(
    state.signer ? "ok" : "dim",
    state.signer ? (state.signerKind === "dev" ? "dev signer (testing)" : "connected") : "disconnected",
  );
  renderAccounts();
}

function setStatus(kind, text) {
  $("w-status").innerHTML = `<span class="pill ${kind}"></span>`;
  $("w-status").firstChild.textContent = text;
}

async function signPrepared(prep) {
  if (state.signerKind === "dev") {
    const r = await api("/api/dev-sign", { prepId: prep.prepId });
    return r.signature;
  }
  // prep.request is a ready-made {method:'eth_signTypedData_v4', params:[owner, json]}.
  return await window.ethereum.request(prep.request);
}

// ── data + rendering ─────────────────────────────────────────────────────────

async function loadInfo() {
  state.info = await api("/api/info");
  const i = state.info;
  $("s-net").textContent = i.network;
  $("s-manager").textContent = short(i.manager);
  $("s-minter").textContent = short(i.minter);
  $("s-tokens").textContent = (i.tokens ?? []).length
    ? i.tokens.map((t) => `${t.name} (${t.family}, ${short(t.color)})`).join(" · ")
    : `unresolved — ${i.tokensError ?? "kernel down?"}`;
  // Token selects: unshielded tokens for Fund, shielded for Fund-shielded/swap.
  const fillTokens = (sel, family, def) => {
    const el = $(sel);
    el.innerHTML = "";
    for (const t of (i.tokens ?? []).filter((x) => x.family === family)) el.append(new Option(t.name, t.name));
    if (def && [...el.options].some((o) => o.value === def)) el.value = def;
  };
  fillTokens("fund-token", "unshielded", "wUSD");
  fillTokens("fs-token", "shielded", "wBTC");
  fillTokens("sw-give-token", "shielded", "wBTC");
  fillTokens("sw-want-token", "shielded", "wETH");
  { // send-to-address: ALL tokens
    const el = $("sd-token");
    el.innerHTML = "";
    for (const t of (i.tokens ?? [])) el.append(new Option(`${t.name} (${t.family})`, t.name));
    if ([...el.options].some((o) => o.value === "wBTC")) el.value = "wBTC";
  }
  { // faucet: ALL tokens
    const el = $("fc-token");
    el.innerHTML = "";
    for (const t of (i.tokens ?? [])) el.append(new Option(`${t.name} (${t.family})`, t.name));
    if ([...el.options].some((o) => o.value === "wETH")) el.value = "wETH";
  }
  $("s-relay").innerHTML = "";
  const pill = document.createElement("span");
  pill.className = `pill ${i.relay.funded ? "ok" : "warn"}`;
  pill.textContent = i.relay.funded ? `funded (${i.relay.balance})` : "UNFUNDED — run scripts/fund-wallet.sh with the aa-console seed";
  $("s-relay").append(pill, ` ${short(i.relay.address ?? "")}`);
  $("s-taker").innerHTML = "";
  const tp = document.createElement("span");
  tp.className = `pill ${i.taker?.funded ? "ok" : "warn"}`;
  tp.textContent = i.taker?.funded ? `funded (${i.taker.balance})` : "UNFUNDED — fund-wallet.sh <aa-taker seed> --shielded-amount";
  $("s-taker").append(tp, ` ${short(i.taker?.address ?? "")}`);
  if (i.withdrawKnownIssue) $("withdraw-note").textContent = i.withdrawKnownIssue;
  else $("withdraw-note").style.display = "none";
  $("use-dev").style.display = i.devSigner ? "" : "none";
}

async function loadAccounts() {
  const r = await api("/api/accounts");
  state.accounts = r.accounts;
  renderAccounts();
}

function renderAccounts() {
  const mine = (a) => state.signer && a.owner.toLowerCase() === state.signer;
  const tokenNames = (state.info?.tokens ?? []).map((t) => t.name);
  const thead = $("accounts-head");
  thead.innerHTML = "";
  {
    const tr = document.createElement("tr");
    for (const h of ["account id", "EVM owner", "nonce", ...tokenNames, ""]) {
      const th = document.createElement("th");
      th.textContent = h;
      tr.append(th);
    }
    thead.append(tr);
  }
  const tbody = $("accounts");
  tbody.innerHTML = "";
  for (const a of state.accounts) {
    const tr = document.createElement("tr");
    const mark = mine(a) ? " (you)" : "";
    const cells = [
      [short(a.accountId), ""], [short(a.owner) + mark, ""], [a.nonce, "num"],
      ...tokenNames.map((tn) => [(a.balances ?? {})[tn] ?? "0", "num"]),
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    const td = document.createElement("td");
    if (mine(a)) { const b = document.createElement("span"); b.className = "pill ok"; b.textContent = "yours"; td.append(b); }
    tr.append(td);
    tbody.append(tr);
  }
  const fill = (sel, list, placeholder) => {
    const el = $(sel);
    const prev = el.value;
    el.innerHTML = "";
    if (!list.length) el.append(new Option(placeholder, "", true, true));
    for (const a of list) {
      const bal = a.balances ? Object.entries(a.balances).map(([k, v]) => `${k} ${v}`).join(" ") : "";
      el.append(new Option(`${short(a.accountId)} — ${bal}`, a.accountId));
    }
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;
  };
  fill("fund-account", state.accounts, "no accounts yet — register first");
  const mineList = state.accounts.filter(mine);
  fill("tr-to", state.accounts, "no accounts yet");
  fill("fs-account", state.accounts, "no accounts yet — register first");
  fill("sw-from", mineList, state.signer ? "no accounts for this signer" : "connect a wallet first");
  $("op-register").disabled = !state.signer;
  $("op-transfer").disabled = !mineList.length;
  $("op-withdraw").disabled = !mineList.length;
  $("op-swap").disabled = !mineList.length;
  renderWallet();
}

async function loadBook() {
  const r = await api("/api/offers");
  const state_el = $("book-state");
  state_el.innerHTML = "";
  const pill = document.createElement("span");
  if (!r.kernel) {
    pill.className = "pill dim";
    pill.textContent = "kernel offline (start the offerfiles profile)";
    state_el.append(pill);
    $("book").innerHTML = "";
    return;
  }
  const offers = r.book?.offers ?? [];
  pill.className = "pill ok";
  pill.textContent = `${offers.length} listed`;
  state_el.append(pill);
  const tbody = $("book");
  tbody.innerHTML = "";
  const leg = (side) => (Array.isArray(side) ? side : side ? [side] : [])
    .map((l) => `${l.amount ?? l.value ?? "?"} ${short(String(l.color ?? l.colour ?? l.token ?? "?"))}`)
    .join(", ");
  for (const o of offers) {
    const computed = o.computed ?? {};
    const status = computed.status ?? o.status ?? o.state ?? "open";
    const tr = document.createElement("tr");
    for (const text of [short(o.offerId ?? "?"), leg(computed.gives ?? o.gives), leg(computed.wants ?? o.wants), status]) {
      const td = document.createElement("td");
      td.textContent = String(text);
      tr.append(td);
    }
    // T9.4 — complete the offer with the TAKER wallet (a different wallet from
    // both the maker's EVM account and the relay).
    const td = document.createElement("td");
    if (status === "live" && o.offerId) {
      const b = document.createElement("button");
      b.className = "ghost";
      b.style.cssText = "padding:2px 10px;font-size:12px";
      b.textContent = "Settle (taker wallet)";
      b.onclick = busy(async () => {
        const { jobId } = await api("/api/take", { offerId: o.offerId });
        await watchJob(jobId);
        await loadBook();
      });
      td.append(b);
    }
    tr.append(td);
    tbody.append(tr);
  }
}

// ── jobs ─────────────────────────────────────────────────────────────────────

function renderJob(job) {
  showActivity();
  const lines = job.log.length ? job.log.join("\n") : "(queued…)";
  for (const [logId, stateId] of [["joblog", "job-state"], ["joblog2", "job-state2"]]) {
    const el = $(logId);
    if (!el) continue;
    el.innerHTML = "";
    const span = document.createElement("span");
    span.className = "hot";
    span.textContent = `[${job.kind}] ${job.state}${job.txId ? ` tx=${job.txId}` : ""}${job.error ? `\n${job.error}` : ""}\n`;
    el.append(span, lines);
    el.scrollTop = el.scrollHeight;
    const st = $(stateId);
    st.innerHTML = "";
    const pill = document.createElement("span");
    pill.className = `pill ${job.state === "done" ? "ok" : job.state === "error" ? "err" : "warn"}`;
    pill.textContent = job.state;
    st.append(pill);
  }
}

async function watchJob(jobId) {
  state.activeJob = jobId;
  let job;
  for (;;) {
    job = await api(`/api/jobs/${jobId}`);
    renderJob(job);
    if (job.state === "done" || job.state === "error") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  state.activeJob = null;
  await loadAccounts();
  return job;
}

const showActivity = () => $("activity-aa")?.classList.remove("collapsed");

const busy = (fn) => async (ev) => {
  ev?.preventDefault?.();
  try { await fn(); } catch (e) {
    showActivity();
    $("joblog").textContent = `ERROR: ${e?.message ?? e}`;
    $("job-state").innerHTML = '<span class="pill err">error</span>';
  }
};

// ── operations ───────────────────────────────────────────────────────────────

async function prepareSignSubmit(body) {
  const prep = await api("/api/prepare", body);
  showActivity();
  $("joblog").textContent = `waiting for the wallet to sign ${body.kind}…`;
  const signature = await signPrepared(prep);
  const { jobId } = await api("/api/submit", { prepId: prep.prepId, signature });
  await watchJob(jobId);
}

$("connect").onclick = busy(connectWallet);
$("use-dev").onclick = busy(async () => useDevSigner());
$("op-register").onclick = busy(() => prepareSignSubmit({ kind: "register", owner: state.signer }));
$("f-fund").onsubmit = busy(async () => {
  const { jobId } = await api("/api/fund", {
    accountId: $("fund-account").value, amount: $("fund-amount").value,
    token: $("fund-token").value,
  });
  await watchJob(jobId);
});


// Transfer — token-first flow, symmetric with Withdraw: pick from the typed,
// balance-annotated list, THEN the destination account + amount. The picked
// token's family decides the signed action (selector 5 vs 4).
function renderTransfer() {
  const tok = (state.info?.tokens ?? []).find((t) => t.name === state.trToken);
  $("tr-list").style.display = tok ? "none" : "";
  $("tr-form").style.display = tok ? "" : "none";
  const acct = currentAccount();
  if (!tok) {
    const list = $("tr-list");
    list.innerHTML = "";
    for (const t of state.info?.tokens ?? []) {
      const row = document.createElement("div");
      row.className = "balrow pick";
      const name = document.createElement("span"); name.className = "tok"; name.textContent = t.name;
      const chip = document.createElement("span");
      chip.className = `chip ${t.family === "shielded" ? "sh" : "ush"}`;
      chip.textContent = t.family;
      const amt = document.createElement("span"); amt.className = "amt";
      amt.textContent = (acct?.balances ?? {})[t.name] ?? "0";
      const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "›";
      row.append(name, chip, amt, chev);
      row.onclick = () => { state.trToken = t.name; renderTransfer(); };
      list.append(row);
    }
    return;
  }
  const sh = tok.family === "shielded";
  $("tr-chosen-name").textContent = tok.name;
  const chip = $("tr-chosen-chip");
  chip.className = `chip ${sh ? "sh" : "ush"}`;
  chip.textContent = tok.family;
  $("tr-chosen-bal").textContent = `balance ${(acct?.balances ?? {})[tok.name] ?? "0"}`;
  $("tr-doc").textContent = sh
    ? "Selector 4 — internal SHIELDED transfer between AA accounts, signed by your EVM wallet."
    : "Selector 5 — internal unshielded transfer between AA accounts, signed by your EVM wallet.";
}
$("tr-back").onclick = () => { state.trToken = null; renderTransfer(); };
$("f-tr").onsubmit = busy(() => {
  const tok = (state.info?.tokens ?? []).find((t) => t.name === state.trToken);
  const acct = currentAccount();
  return prepareSignSubmit({
    kind: tok.family === "shielded" ? "transfer-shielded" : "transfer",
    owner: state.signer, accountId: acct.accountId,
    toAccountId: $("tr-to").value, amount: $("tr-amount").value, token: tok.name,
  });
});
// Withdraw — token-first flow: pick from the list (name + family + balance),
// THEN amount + recipient. One form serves both selectors; the family decides
// which recipient control shows and which action kind is signed.
function currentAccount() {
  const mine = state.accounts.filter((a) => a.owner.toLowerCase() === state.signer);
  return mine.find((a) => a.accountId === $("wl-account").value) ?? mine[0] ?? null;
}
function renderWithdraw() {
  const tok = (state.info?.tokens ?? []).find((t) => t.name === state.wdToken);
  $("wd-list").style.display = tok ? "none" : "";
  $("wd-form").style.display = tok ? "" : "none";
  const acct = currentAccount();
  if (!tok) {
    const list = $("wd-list");
    list.innerHTML = "";
    for (const t of state.info?.tokens ?? []) {
      const row = document.createElement("div");
      row.className = "balrow pick";
      const name = document.createElement("span"); name.className = "tok"; name.textContent = t.name;
      const chip = document.createElement("span");
      chip.className = `chip ${t.family === "shielded" ? "sh" : "ush"}`;
      chip.textContent = t.family;
      const amt = document.createElement("span"); amt.className = "amt";
      amt.textContent = (acct?.balances ?? {})[t.name] ?? "0";
      const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "›";
      row.append(name, chip, amt, chev);
      row.onclick = () => { state.wdToken = t.name; renderWithdraw(); };
      list.append(row);
    }
    return;
  }
  const sh = tok.family === "shielded";
  $("wd-chosen-name").textContent = tok.name;
  const chip = $("wd-chosen-chip");
  chip.className = `chip ${sh ? "sh" : "ush"}`;
  chip.textContent = tok.family;
  $("wd-chosen-bal").textContent = `balance ${(acct?.balances ?? {})[tok.name] ?? "0"}`;
  $("wd-rec-un").style.display = sh ? "none" : "";
  $("wd-rec-sh").style.display = sh ? "" : "none";
  $("wd-shaddr-wrap").style.display = sh && $("wd-target").value === "address" ? "" : "none";
  $("wd-doc").textContent = sh
    ? "Selector 2 — shielded, to ANY mn_shield-addr… (the address carries the recipient's coin + encryption keys), or one of the stack's wallets."
    : "Selector 3 — unshielded, to any standard Midnight address (contract recipients are refused by design). Empty = relay wallet.";
}
$("wd-target").onchange = () => {
  $("wd-shaddr-wrap").style.display = $("wd-target").value === "address" ? "" : "none";
};
$("wd-back").onclick = () => { state.wdToken = null; renderWithdraw(); };
$("f-wd").onsubmit = busy(() => {
  const tok = (state.info?.tokens ?? []).find((t) => t.name === state.wdToken);
  const acct = currentAccount();
  return prepareSignSubmit(tok.family === "shielded"
    ? { kind: "withdraw-shielded", owner: state.signer, accountId: acct.accountId,
        amount: $("wd-amount").value, token: tok.name,
        ...($("wd-target").value === "address"
          ? { to: $("wd-shaddr").value.trim() }
          : { target: $("wd-target").value }) }
    : { kind: "withdraw", owner: state.signer, accountId: acct.accountId,
        amount: $("wd-amount").value, token: tok.name, recipient: $("wd-recipient").value.trim() });
});
$("f-send").onsubmit = busy(async () => {
  const { jobId } = await api("/api/send", {
    token: $("sd-token").value, amount: $("sd-amount").value, to: $("sd-to").value.trim(),
  });
  await watchJob(jobId);
});
$("f-faucet").onsubmit = busy(async () => {
  const { jobId } = await api("/api/faucet", {
    token: $("fc-token").value, amount: $("fc-amount").value, target: $("fc-target").value,
  });
  await watchJob(jobId);
});
$("f-fundsh").onsubmit = busy(async () => {
  const { jobId } = await api("/api/fund-shielded", {
    accountId: $("fs-account").value, amount: $("fs-amount").value,
    token: $("fs-token").value,
  });
  await watchJob(jobId);
});
$("f-swap").onsubmit = busy(async () => {
  // Step 1: sign + contract call + prove — the result is the offer's bech32m,
  // shown below; publishing is the explicit second step.
  showActivity();
  $("swap-built").style.display = "none";
  const prep = await api("/api/prepare", {
    kind: "swap", owner: state.signer,
    accountId: $("sw-from").value,
    amount: $("sw-give").value, wantAmount: $("sw-want").value,
    giveToken: $("sw-give-token").value, wantToken: $("sw-want-token").value,
  });
  $("joblog").textContent = "waiting for the wallet to sign the swap…";
  const signature = await signPrepared(prep);
  const { jobId } = await api("/api/submit", { prepId: prep.prepId, signature });
  const job = await watchJob(jobId);
  if (job?.data?.blob) {
    $("swap-blob").value = job.data.blob;
    $("swap-built-meta").textContent = `${job.data.bytes} bytes · offerId ${job.data.sha256.slice(0, 16)}…`;
    $("publish-result").textContent = "";
    $("swap-built").style.display = "";
  }
});
$("op-publish").onclick = busy(async () => {
  $("publish-result").textContent = "publishing…";
  try {
    const r = await api("/api/publish-offer", { blob: $("swap-blob").value });
    $("publish-result").textContent = `PUBLISHED — offerId ${String(r.offerId).slice(0, 16)}… (now on the book below)`;
    await loadBook();
  } catch (e) {
    $("publish-result").textContent = `publish failed: ${e?.message ?? e}`;
  }
});
$("op-copy-blob").onclick = () => {
  navigator.clipboard?.writeText($("swap-blob").value);
  $("publish-result").textContent = "copied to clipboard";
};
$("refresh").onclick = busy(loadAccounts);

// ── Read & pure functions panel ──────────────────────────────────────────────
let pureFns = [];
async function loadPureFns() {
  try {
    pureFns = (await api("/api/pure")).functions;
  } catch { return; }
  const sel = $("pure-fn");
  sel.innerHTML = "";
  for (const f of pureFns) sel.append(new Option(`${f.fn} (${f.kind})`, f.fn));
  sel.onchange = renderPureForm;
  renderPureForm();
}
function renderPureForm() {
  const f = pureFns.find((x) => x.fn === $("pure-fn").value);
  if (!f) return;
  $("pure-doc").textContent = f.doc;
  for (const i of [0, 1]) {
    const wrap = $(`pure-arg${i}-wrap`);
    if (f.params[i]) {
      wrap.style.display = "";
      $(`pure-arg${i}-label`).textContent = f.params[i];
      // Convenience prefills: account ids from the table, the signer for owner.
      const input = $(`pure-arg${i}`);
      input.value = "";
      if (/accountId/.test(f.params[i]) && state.accounts[0]) input.value = state.accounts[0].accountId;
      if (/owner/.test(f.params[i]) && state.signer) input.value = state.signer;
    } else {
      wrap.style.display = "none";
    }
  }
  $("pure-result").textContent = "—";
}
$("f-pure").onsubmit = busy(async () => {
  const f = pureFns.find((x) => x.fn === $("pure-fn").value);
  const args = [ $("pure-arg0").value, $("pure-arg1").value ].slice(0, f?.params.length ?? 0);
  try {
    const r = await api("/api/pure", { fn: $("pure-fn").value, args });
    $("pure-result").textContent = JSON.stringify(r.result, null, 1);
  } catch (e) {
    $("pure-result").textContent = `ERROR: ${e?.message ?? e}`;
  }
});

// ── AA Wallet view state ─────────────────────────────────────────────────────
// The wallet card is a state machine: disconnected → connect only; connected
// but unregistered → warning + Register; registered → balances + operations.
// The per-operation "from account" selects stay in the DOM (hidden) and are
// kept in sync with the wallet's account picker.

function renderWallet() {
  const connected = !!state.signer;
  $("wl-connect").style.display = connected ? "none" : "";
  $("wl-main").style.display = connected ? "" : "none";
  if (!connected) return;
  const mine = state.accounts.filter((a) => a.owner.toLowerCase() === state.signer);
  $("wl-warn").style.display = mine.length ? "none" : "";
  $("wl-balances").style.display = mine.length ? "" : "none";
  renderReads();
  if (!mine.length) return;
  const sel = $("wl-account");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const a of mine) sel.append(new Option(`Account ${short(a.accountId)}`, a.accountId));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  const acct = mine.find((a) => a.accountId === sel.value) ?? mine[0];
  const list = $("wl-ballist");
  list.innerHTML = "";
  // All the stack's demo tokens, zeros included — these are the executed reads
  // (the relay's indexer lookups behind /api/accounts).
  for (const t of state.info?.tokens ?? []) {
    const row = document.createElement("div"); row.className = "balrow";
    const tok = document.createElement("span"); tok.className = "tok"; tok.textContent = t.name;
    const chip = document.createElement("span");
    chip.className = `chip ${t.family === "shielded" ? "sh" : "ush"}`;
    chip.textContent = t.family;
    const amt = document.createElement("span"); amt.className = "amt";
    amt.textContent = (acct.balances ?? {})[t.name] ?? "0";
    row.append(tok, chip, amt); list.append(row);
  }
  $("wl-nonce").textContent = acct.nonce;
  renderWithdraw();
  renderTransfer();
  for (const id of ["sw-from"]) {
    const el = $(id);
    if ([...el.options].some((o) => o.value === acct.accountId)) el.value = acct.accountId;
  }
}
// Live contract reads — the Manager's read/pure surface executed for the
// connected signer as soon as the wallet connects (no registration needed;
// unregistered just reads empty). Re-runs on refresh, account switch, and the
// background accounts poll.
let readsBusy = false;
async function renderReads() {
  if (!state.signer || readsBusy) return;
  readsBusy = true;
  try {
    const mine = state.accounts.filter((a) => a.owner.toLowerCase() === state.signer);
    const acct = mine.find((a) => a.accountId === $("wl-account").value) ?? mine[0] ?? null;
    const fmtAny = (v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
    const run = async (fn, args, label, fmt) => {
      try {
        const r = await api("/api/pure", { fn, args });
        return [label, r.result == null ? "empty" : (fmt ?? fmtAny)(r.result)];
      } catch (e) { return [label, `error: ${e?.message ?? e}`]; }
    };
    const jobs = [run("deploymentDomain", [], "deploymentDomain", (v) => v.utf8 ?? fmtAny(v))];
    if (acct) {
      jobs.push(run("isRegistered", [acct.accountId], "isRegistered", (v) => String(v.registered ?? v)));
      jobs.push(run("evmOwner", [acct.accountId], "evmOwner", (v) => short(String(v.owner ?? v))));
      jobs.push(run("evmNonce", [acct.accountId], "evmNonce", (v) => String(v.nonce ?? v)));
    }
    for (const t of (state.info?.tokens ?? []).filter((t) => t.family === "shielded"))
      jobs.push(run("poolValue", [t.color], `pool ${t.name}`, (v) =>
        v && v.pooled ? `pooled — value ${v.value}, merkle idx ${v.mtIndex}` : "not pooled"));
    const rows = await Promise.all(jobs);
    if (!acct) rows.splice(1, 0,
      ["isRegistered", "false — no account for this address yet"],
      ["evmOwner", "—"], ["evmNonce", "—"]);
    const dl = $("wl-readlist");
    dl.innerHTML = "";
    for (const [k, v] of rows) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }
    const st = $("wl-reads-state");
    st.className = "pill ok";
    st.textContent = `read ${new Date().toLocaleTimeString()}`;
  } finally { readsBusy = false; }
}
$("wl-account").onchange = () => { renderWallet(); renderReads(); };
$("wl-refresh").onclick = busy(async () => { await loadAccounts(); await renderReads(); });
$("wl-more").onclick = busy(() => prepareSignSubmit({ kind: "register", owner: state.signer }));
$("act-head").onclick = () => $("activity-aa").classList.toggle("collapsed");

// Operation groups: Withdraw | Transfer | Publish Offer. Purely a view toggle
// — the wired forms keep their own submit handlers above.
$("ops-seg").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-ops]");
  if (!b) return;
  for (const x of document.querySelectorAll("#ops-seg button")) x.classList.toggle("active", x === b);
  for (const p of document.querySelectorAll(".opspane")) p.classList.toggle("active", p.id === `ops-${b.dataset.ops}`);
});

// ── boot ─────────────────────────────────────────────────────────────────────

busy(async () => {
  await loadInfo();
  await loadAccounts();
  loadBook().catch(() => {});
  loadPureFns().catch(() => {});
  setInterval(() => {
    if (state.activeJob) return;
    loadAccounts().catch(() => {});
    loadBook().catch(() => {});
  }, 15000);
})();
