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
  $("s-color").textContent = `${i.minterTag ?? "demo token"} (${short(i.color)})`;
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
  $("devsigner-slot").style.display = i.devSigner ? "" : "none";
}

async function loadAccounts() {
  const r = await api("/api/accounts");
  state.accounts = r.accounts;
  renderAccounts();
}

function renderAccounts() {
  const mine = (a) => state.signer && a.owner.toLowerCase() === state.signer;
  const tbody = $("accounts");
  tbody.innerHTML = "";
  for (const a of state.accounts) {
    const tr = document.createElement("tr");
    const mark = mine(a) ? " (you)" : "";
    for (const [text, cls] of [
      [short(a.accountId), ""], [short(a.owner) + mark, ""],
      [a.nonce, "num"], [a.balance, "num"], [a.shieldedBalance ?? "0", "num"],
    ]) {
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
    for (const a of list) el.append(new Option(`${short(a.accountId)} — bal ${a.balance}`, a.accountId));
    if ([...el.options].some((o) => o.value === prev)) el.value = prev;
  };
  fill("fund-account", state.accounts, "no accounts yet — register first");
  const mineList = state.accounts.filter(mine);
  fill("tr-from", mineList, state.signer ? "no accounts for this signer" : "connect a wallet first");
  fill("tr-to", state.accounts, "no accounts yet");
  fill("wd-from", mineList, state.signer ? "no accounts for this signer" : "connect a wallet first");
  fill("fs-account", state.accounts, "no accounts yet — register first");
  fill("sw-from", mineList, state.signer ? "no accounts for this signer" : "connect a wallet first");
  $("op-register").disabled = !state.signer;
  $("op-transfer").disabled = !mineList.length;
  $("op-withdraw").disabled = !mineList.length;
  $("op-swap").disabled = !mineList.length;
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
  const el = $("joblog");
  const lines = job.log.length ? job.log.join("\n") : "(queued…)";
  el.innerHTML = "";
  const span = document.createElement("span");
  span.className = "hot";
  span.textContent = `[${job.kind}] ${job.state}${job.txId ? ` tx=${job.txId}` : ""}${job.error ? `\n${job.error}` : ""}\n`;
  el.append(span, lines);
  el.scrollTop = el.scrollHeight;
  $("job-state").innerHTML = "";
  const pill = document.createElement("span");
  pill.className = `pill ${job.state === "done" ? "ok" : job.state === "error" ? "err" : "warn"}`;
  pill.textContent = job.state;
  $("job-state").append(pill);
}

async function watchJob(jobId) {
  state.activeJob = jobId;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    renderJob(job);
    if (job.state === "done" || job.state === "error") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  state.activeJob = null;
  await loadAccounts();
}

const busy = (fn) => async (ev) => {
  ev?.preventDefault?.();
  try { await fn(); } catch (e) {
    $("joblog").textContent = `ERROR: ${e?.message ?? e}`;
    $("job-state").innerHTML = '<span class="pill err">error</span>';
  }
};

// ── operations ───────────────────────────────────────────────────────────────

async function prepareSignSubmit(body) {
  const prep = await api("/api/prepare", body);
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
  });
  await watchJob(jobId);
});
$("f-transfer").onsubmit = busy(() => prepareSignSubmit({
  kind: "transfer", owner: state.signer,
  accountId: $("tr-from").value, toAccountId: $("tr-to").value, amount: $("tr-amount").value,
}));
$("f-withdraw").onsubmit = busy(() => prepareSignSubmit({
  kind: "withdraw", owner: state.signer,
  accountId: $("wd-from").value, amount: $("wd-amount").value,
  recipient: $("wd-recipient").value.trim(),
}));
$("f-fundsh").onsubmit = busy(async () => {
  const { jobId } = await api("/api/fund-shielded", {
    accountId: $("fs-account").value, amount: $("fs-amount").value,
  });
  await watchJob(jobId);
});
$("f-swap").onsubmit = busy(async () => {
  await prepareSignSubmit({
    kind: "swap", owner: state.signer,
    accountId: $("sw-from").value,
    amount: $("sw-give").value, wantAmount: $("sw-want").value,
  });
  await loadBook();
});
$("refresh").onclick = busy(loadAccounts);

// ── boot ─────────────────────────────────────────────────────────────────────

busy(async () => {
  await loadInfo();
  await loadAccounts();
  loadBook().catch(() => {});
  setInterval(() => {
    if (state.activeJob) return;
    loadAccounts().catch(() => {});
    loadBook().catch(() => {});
  }, 15000);
})();
