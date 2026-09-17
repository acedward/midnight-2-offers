// AA Console — browser side. Deliberately thin: this page holds NO Midnight wallet and NO
// prover. It signs what the relay builds and polls the relay's jobs. See aa-console.ts.
//
// ⚠ PROJECT 00034 CHANGED TWO THINGS A READER OF THIS FILE WILL TRIP OVER.
//
//   1. THERE ARE TWO KINDS OF SIGNATURE NOW. `register` asks for an EIP-191
//      `personal_sign` over a fixed sentence — it names no operation, authorises nothing and
//      moves no funds. Its only job is to reveal the wallet's public POINT, which no EVM
//      wallet exposes and which the account's activation circuit carries as an argument
//      (Q30). Every other action is `eth_signTypedData_v4` over an EIP-712 struct whose
//      `challenge` field binds the account, the arguments and the witness coin. `/api/prepare`
//      answers with exactly one of `message` or `typedData`, and `signPrepared` branches on it.
//   2. REGISTER DEPLOYS A CONTRACT. The account id IS the contract address and it does not
//      exist until the deploy lands, so the page cannot show one in advance, and registering
//      is two transactions and minutes of proving rather than one call (Q40).
"use strict";

const $ = (id) => document.getElementById(id);
const short = (h) => (h && h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h ?? "—");

// ── amounts (project 00035, spec FR-008) ────────────────────────────────────
// Every token on this stack has its OWN scale — the six faucet issuers are 8/18/6/6/6/8 and a
// bridged colour is whatever its ERC20 says (USDC 6, WEENUS 18). A page that prints a base-unit
// integer beside a symbol prints a number nobody can check: 10 WEENUS is 10000000000000000000,
// which is also past what a JS Number can hold — hence BigInt and string maths, never `/ 10**d`.
const fromRaw = (raw, decimals) => {
  let v;
  try { v = BigInt(String(raw ?? "0")); } catch { return String(raw ?? "0"); }
  if (!Number.isInteger(decimals) || decimals < 0) return v.toString();
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
};
/** Decimals for a token NAME, from /api/info's list. Null when the page has no row for it. */
const decimalsOfName = (name) =>
  (state.info?.tokens ?? []).find((t) => t.name === name)?.decimals ?? null;
/** …and for a COLOUR, which is how the kernel's book names a leg. */
const tokenOfColour = (colour) => {
  const c = String(colour ?? "").replace(/^0x/, "").toLowerCase();
  return (state.info?.tokens ?? []).find((t) => String(t.color).toLowerCase() === c) ?? null;
};

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
  if (prep.message) {
    // ENROLMENT (register only). `personal_sign` takes the message first and the address
    // second — the opposite order to `eth_signTypedData_v4`, which is a classic way to get a
    // silent "wrong signer" out of a wallet.
    return await window.ethereum.request({
      method: "personal_sign",
      params: [prep.message, state.signer],
    });
  }
  return await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [state.signer, JSON.stringify(prep.typedData)],
  });
}

// ── data + rendering ─────────────────────────────────────────────────────────

async function loadInfo() {
  state.info = await api("/api/info");
  const i = state.info;
  $("s-net").textContent = i.network;
  // The shared pieces this stack deployed. There is no Manager and no Minter: an account is
  // a contract per user, and what is shared is the VAULT every account's constructor seals.
  $("s-manager").textContent = short(i.vault?.address);
  $("s-manager").title = i.vault?.address ?? "";
  $("s-minter").textContent = i.accountPlan
    ? `${i.accountPlan.circuits.length} circuits · wave 1 ${i.accountPlan.waveOne.length} + wave 2 ${i.accountPlan.waveTwo.length} · authority retired`
    : "—";
  // DECIMALS ARE SHOWN, because they are not all 6 any more: the six local
  // issuers are 8/18/6/6/6/8, and every amount in this page is BASE UNITS.
  $("s-tokens").textContent = (i.tokens ?? []).length
    ? i.tokens.map((t) => `${t.name} (${t.family}, ${t.decimals}d, ${short(t.color)})`).join(" · ")
    : `unresolved — ${i.tokensError ?? "faucet profile down?"}`;
  // ── DEFAULT SELECTIONS ARE POSITIONAL, NOT NAMED ─────────────────────────
  // These used to be the literals "wUSD"/"wBTC"/"wETH" — names this console
  // invented and derived colours for. The tokens now come from the local
  // mint-test-tokens registry (`/api/info.tokensSource === "mint-test-tokens"`),
  // so a hard-coded symbol would break the page the day the registry changed
  // one. "the Nth of this family, in registry order" keeps the same three roles
  // (give / want / unshielded) without naming anything.
  const ofFamily = (family) => (i.tokens ?? []).filter((x) => x.family === family);
  const nth = (family, index) => (ofFamily(family)[index] ?? ofFamily(family)[0])?.name;
  const fillTokens = (sel, family, def) => {
    const el = $(sel);
    el.innerHTML = "";
    for (const t of ofFamily(family)) el.append(new Option(`${t.name} (${t.decimals}d)`, t.name));
    if (def && [...el.options].some((o) => o.value === def)) el.value = def;
  };
  fillTokens("fund-token", "unshielded", nth("unshielded", 0));
  fillTokens("fs-token", "shielded", nth("shielded", 0));
  fillTokens("sw-give-token", "shielded", nth("shielded", 0));
  fillTokens("sw-want-token", "shielded", nth("shielded", 1));
  renderSwapLegs();
  const fillAll = (sel, def) => {
    const el = $(sel);
    el.innerHTML = "";
    for (const t of (i.tokens ?? [])) el.append(new Option(`${t.name} (${t.family}, ${t.decimals}d)`, t.name));
    if (def && [...el.options].some((o) => o.value === def)) el.value = def;
  };
  fillAll("sd-token", nth("shielded", 0));   // send-to-address
  fillAll("fc-token", nth("shielded", 1));   // faucet
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
  const note = $("withdraw-note");
  if (note) {
    note.textContent =
      "A shielded withdraw spends ONE held coin and returns the change to this console's "
      + "store; the change gets no inbox entry unless you file one (a second signature).";
  }
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
    // "account id" IS the contract address now; `inbox` is how many coin descriptions the
    // account has been given, which is the only on-chain trace a shielded holding leaves.
    for (const h of ["account (contract address)", "EVM owner", "authNonce", "inbox", ...tokenNames, ""]) {
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
      [short(a.accountId), ""], [short(a.owner) + mark, ""], [a.authNonce ?? a.nonce ?? "—", "num"],
      [a.inboxCount ?? "—", "num"],
      ...tokenNames.map((tn) => [(a.balancesDecimal ?? {})[tn] ?? fromRaw((a.balances ?? {})[tn] ?? "0", decimalsOfName(tn)), "num"]),
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    const td = document.createElement("td");
    if (mine(a)) { const b = document.createElement("span"); b.className = "pill ok"; b.textContent = "yours"; td.append(b); }
    if (a.liveOffer) {
      const o = document.createElement("span");
      o.className = "pill warn";
      o.title = `${a.liveOffer.give} for ${a.liveOffer.want} — one live offer per account (Q7)`;
      o.textContent = "offer live";
      td.append(" ", o);
    }
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
  // A leg is `{amount, token|color}` in base units. Rendered with the colour's own decimals
  // and symbol when this console knows them (a bridged colour does, as soon as the Bridge tab
  // has resolved it), and truthfully raw-with-a-short-colour when it does not.
  const leg = (side) => (Array.isArray(side) ? side : side ? [side] : [])
    .map((l) => {
      const colour = String(l.color ?? l.colour ?? l.token ?? "?");
      const raw = String(l.amount ?? l.value ?? "?");
      const t = tokenOfColour(colour);
      return t ? `${fromRaw(raw, t.decimals)} ${t.name}` : `${raw} ${short(colour)}`;
    })
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


// Send to another account — token-first flow, symmetric with Withdraw.
//
// ⚠ IT IS NOT AN INTERNAL TRANSFER ANY MORE (Q41). Both accounts used to be rows in ONE
// contract's balance map, so a transfer was two map updates and one signed action. They are
// separate contracts now, and an account never calls another account — so this is a
// WITHDRAW of a shielded coin to a wallet the console runs, followed by a permissionless
// DEPOSIT into the recipient. Two transactions, one signature (the deposit needs none), and
// the hop is visible in the job log rather than hidden.
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
    ? "withdraw_shielded_with_evm → the console's funder wallet → deposit_shielded into the "
      + "recipient. One signature from you; the deposit is permissionless."
    : "UNSHIELDED value is a public balance and needs no inbox entry: withdraw it to the other "
      + "owner's wallet address and let them deposit it. Pick a shielded token to send here.";
}
$("tr-back").onclick = () => { state.trToken = null; renderTransfer(); };
$("f-tr").onsubmit = busy(() => {
  const tok = (state.info?.tokens ?? []).find((t) => t.name === state.trToken);
  const acct = currentAccount();
  return prepareSignSubmit({
    kind: "send-to-account",
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
  // Step 1: sign + contract call + prove — the result is the offer's bech32m, shown below;
  // publishing is the explicit second step.
  //
  // Q7, checked here so the wallet is never asked to sign something that cannot settle: the
  // MIP-0013 seam consumes ONE device entry per call, so signing a second offer while the
  // first is unsettled makes the FIRST one permanently unsettleable. The relay refuses it
  // too; this is only so the refusal arrives before the wallet prompt.
  const from = state.accounts.find((a) => a.accountId === $("sw-from").value);
  if (from?.liveOffer) {
    throw new Error(
      `this account already has a live offer (${from.liveOffer.give} for ${from.liveOffer.want}). `
      + "Settle it, or forget it in the book, before making another — one live offer per account.",
    );
  }
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
/** What the two typed amounts ARE on chain. The offer's legs are base units and the form's
 *  are token units; showing both removes the one ambiguity this form has. */
function renderSwapLegs() {
  const el = $("swap-legs");
  if (!el) return;
  const g = (state.info?.tokens ?? []).find((t) => t.name === $("sw-give-token").value);
  const w = (state.info?.tokens ?? []).find((t) => t.name === $("sw-want-token").value);
  const raw = (value, token) => {
    if (!token) return "?";
    const m = /^(\d*)(?:\.(\d*))?$/.exec(String(value ?? "").trim());
    if (!m) return "not a number";
    const frac = (m[2] ?? "");
    if (frac.length > token.decimals) return `too many decimals (${token.name} has ${token.decimals})`;
    return `${(m[1] || "0") + frac.padEnd(token.decimals, "0")} base units`;
  };
  el.textContent = `give ${$("sw-give").value} ${g?.name ?? "?"} = ${raw($("sw-give").value, g)}  ·  `
    + `want ${$("sw-want").value} ${w?.name ?? "?"} = ${raw($("sw-want").value, w)}`;
}
for (const id of ["sw-give", "sw-want", "sw-give-token", "sw-want-token"]) {
  const el = $(id);
  if (el) el.addEventListener("input", renderSwapLegs);
  if (el) el.addEventListener("change", renderSwapLegs);
}

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
    // The DECIMAL value is what a reader can check; the base units stay in the tooltip,
    // because they are what the circuits take and what an error message will quote.
    const raw = (acct.balances ?? {})[t.name] ?? "0";
    amt.textContent = (acct.balancesDecimal ?? {})[t.name] ?? fromRaw(raw, t.decimals);
    amt.title = `${raw} base units (${t.decimals} decimals)`;
    row.append(tok, chip, amt); list.append(row);
  }
  $("wl-nonce").textContent = acct.nonce;
  // FR-011's "while open": the RELAY's poller is what notices an external take, so the page
  // only has to show what it found. This runs on the 15 s accounts poll, which is why step 7
  // of the story needs no click at all.
  renderReconcile(acct.lastReconcile ?? null);
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
// ⚠ REFRESH IS NOT A RE-READ ANY MORE (spec FR-011, the owner's Q7 addition). It runs the
// console's reconcile against the chain: if this account's offer was taken by somebody else —
// in the offer-files frontend, by the solver, by anyone — the settlement nullified a coin this
// store still lists, and the page would keep showing it until the account's next call failed
// inside proving. The poller does this every AA_OFFER_POLL_MS anyway; the button is for the
// operator who has just clicked "take" in another tab and does not want to wait.
$("wl-refresh").onclick = busy(async () => {
  const el = $("wl-reconcile");
  if (el) { el.style.display = ""; el.textContent = "reconciling this account against the chain…"; }
  try {
    const r = await api("/api/refresh", state.signer ? { owner: state.signer } : {});
    renderReconcile((r.reports ?? [])[0] ?? null);
  } catch (e) {
    if (el) el.textContent = `reconcile failed: ${e?.message ?? e}`;
  }
  await loadAccounts();
  await renderReads();
});

/** The reconcile's own words, under the balances. `changes` is the same list the job log and
 *  the console's stdout carry, so three surfaces never disagree about what happened. */
function renderReconcile(report) {
  const el = $("wl-reconcile");
  if (!el) return;
  if (!report) { el.style.display = "none"; return; }
  el.style.display = "";
  el.innerHTML = "";
  const head = document.createElement("div");
  head.innerHTML = report.settled
    ? "<b>the offer was taken by somebody else</b> — the account has been reconciled:"
    : (report.error ? "<b>reconcile failed</b>:" : "reconcile:");
  el.append(head);
  const ul = document.createElement("ul");
  ul.style.cssText = "margin:4px 0 0 16px;padding:0";
  for (const line of report.changes ?? []) {
    const li = document.createElement("li"); li.textContent = line; ul.append(li);
  }
  if (report.error) { const li = document.createElement("li"); li.textContent = report.error; ul.append(li); }
  el.append(ul);
  if (report.settleTx) {
    const p = document.createElement("div");
    p.style.marginTop = "4px";
    p.textContent = `settling transaction ${report.settleTx.txHash} (block ${report.settleTx.blockHeight})`;
    el.append(p);
  }
}
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
