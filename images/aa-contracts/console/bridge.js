// bridge.js — the Bridge tab (project 00035, spec User Story 1).
//
// It reuses app.js's `$`, `api`, `state`, `watchJob` and `signPrepared`, and adds nothing to the
// page's trust model: the browser still holds no Midnight key and no prover, and it still signs
// exactly two shapes of thing — an EIP-712 authorisation for the two DEVICE-GATED starts, and
// nothing at all for the rest.
//
// ── THE TWO RECIPIENTS ARE TWO DIFFERENT PROTOCOLS, not a radio button ──────
//   my account            → `bridge_deposit_start_with_evm`, signed here, the account claims the
//                           mint in `bridge_deposit_complete`. Same prepare/sign/submit path as
//                           every other action on this page.
//   a shielded address    → the console's relay wallet calls the vault at its ROOT. There is no
//                           signature to give: what protects the funds is the DERIVATION — the
//                           deposit address is a function of the recipient, so tokens sent there
//                           can only ever be minted to that recipient, whoever submits.
// The page says which is happening rather than hiding the difference behind one button.
//
// ── AMOUNTS ARE DECIMAL, EVERYWHERE ─────────────────────────────────────────
// Every field and every label on this tab is in the token's own units: "10 WEENUS", never
// 10000000000000000000. The relay does the bigint conversion and hands back both, and this file
// never multiplies or divides an amount — one `Number(10^19)` would silently lose the low digits.
"use strict";

(() => {
  const bridge = {
    info: null,       // /api/info.bridge
    tokens: [],       // /api/bridge/tokens
    quote: null,
    wquote: null,
    activePane: "deposit",
  };

  const brToken = () => {
    const custom = $("br-token-custom").value.trim();
    if (custom) return { erc20: custom, symbol: custom.slice(0, 10), decimals: null, custom: true };
    return bridge.tokens.find((t) => t.erc20 === $("br-token").value) ?? null;
  };
  const myAccount = () => {
    const mine = (state.accounts ?? []).filter((a) => state.signer && a.owner.toLowerCase() === state.signer);
    const picked = $("wl-account")?.value;
    return mine.find((a) => a.accountId === picked) ?? mine[0] ?? null;
  };

  function renderJob3(job) {
    const el = $("joblog3");
    el.innerHTML = "";
    const span = document.createElement("span");
    span.style.color = "var(--ink)";
    span.textContent = `[${job.kind}] ${job.state}${job.txId ? ` tx=${job.txId}` : ""}${job.error ? `\n${job.error}` : ""}\n`;
    el.append(span, (job.log ?? []).join("\n"));
    el.scrollTop = el.scrollHeight;
    const st = $("job-state3");
    st.innerHTML = "";
    const pill = document.createElement("span");
    pill.className = `pill ${job.state === "done" ? "ok" : job.state === "error" ? "err" : "warn"}`;
    pill.textContent = job.state;
    st.append(pill);
  }

  /** Poll a job here rather than through app.js's watcher: the bridge's Activity panel is its
   *  own, and a relay that waits minutes for the MPC must show its progress on this tab. */
  async function watchBridgeJob(jobId) {
    state.activeJob = jobId;
    try {
      for (;;) {
        const job = await api(`/api/jobs/${jobId}`);
        renderJob3(job);
        if (job.state === "done" || job.state === "error") return job;
        await new Promise((r) => setTimeout(r, 2500));
      }
    } finally {
      state.activeJob = null;
      loadAccounts().catch(() => {});
      loadRequests().catch(() => {});
    }
  }

  const guard = (fn) => async (ev) => {
    ev?.preventDefault?.();
    try { await fn(); } catch (e) {
      $("joblog3").textContent = `ERROR: ${e?.message ?? e}`;
      $("job-state3").innerHTML = '<span class="pill err">error</span>';
    }
  };

  // ── availability and the token list ───────────────────────────────────────

  async function loadBridge() {
    const info = state.info ?? (await api("/api/info"));
    bridge.info = info.bridge ?? { available: false, reasons: ["/api/info carries no bridge section"] };
    $("tab-bridge").style.display = bridge.info.available ? "" : "none";
    $("bridge-unavailable").style.display = bridge.info.available ? "none" : "";
    $("bridge-main").style.display = bridge.info.available ? "" : "none";
    if (!bridge.info.available) {
      const ul = $("bridge-reasons");
      ul.innerHTML = "";
      for (const r of bridge.info.reasons ?? []) {
        const li = document.createElement("li");
        li.textContent = r;
        ul.append(li);
      }
      return;
    }
    $("bridge-chain").textContent = `EVM chain ${bridge.info.chainId}`;
    // The attestation caveat is shown wherever an attestation is shown (owner's Q3): this
    // stack recovers the Ethereum output by an eth_call REPLAY when the RPC has no debug
    // namespace, which is demo-grade and must never look like a traced one.
    $("bridge-attestation").textContent = /replay/i.test(bridge.info.attestation ?? "")
      ? "attestation: replayed (demo-grade)" : "attestation: traced";
    $("bridge-vault-note").textContent =
      `vault ${String(bridge.info.vault?.address ?? "?").slice(0, 20)}… — its own EVM account holds every `
      + `bridged token and pays every withdrawal's gas. The stack holds BOTH halves of the MPC root key, `
      + `so this bridge proves the protocol end to end; it is not a signer nobody here controls.`;

    const list = await api("/api/bridge/tokens");
    bridge.tokens = list.tokens ?? [];
    bridge.vaultEvmAddress = list.vaultEvmAddress ?? null;
    const sel = $("br-token");
    const prev = sel.value;
    sel.innerHTML = "";
    for (const t of bridge.tokens) sel.append(new Option(`${t.symbol} (${t.decimals}d)`, t.erc20));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    renderWithdrawTokens();
    if (!$("brw-dest").value && state.signer) $("brw-dest").value = state.signer;
    if (bridge.info.frontendWallet) $("br-use-frontend").style.display = "";
    else $("br-use-frontend").style.display = "none";
  }

  /** The withdraw selector lists only colours the connected account ACTUALLY HOLDS: a
   *  withdrawal surrenders one held coin, and offering a colour with none behind it is an
   *  invitation to a refusal two clicks later. */
  function renderWithdrawTokens() {
    const acct = myAccount();
    const sel = $("brw-token");
    const prev = sel.value;
    sel.innerHTML = "";
    const held = bridge.tokens.filter((t) => BigInt((acct?.shielded ?? {})[t.symbol] ?? "0") > 0n);
    if (!held.length) sel.append(new Option("no bridged coin in this account yet", "", true, true));
    for (const t of held) sel.append(new Option(`${t.symbol} (${t.decimals}d)`, t.erc20));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  // ── the deposit quote ─────────────────────────────────────────────────────

  function recipientBody() {
    if ($("br-rec-wallet").checked) {
      const a = $("br-rec-address").value.trim();
      if (!a) throw new Error("paste a mn_shield-addr… address, or press “use the frontend wallet”");
      return { shieldedAddress: a };
    }
    const acct = myAccount();
    if (!acct) throw new Error("connect a wallet and register an account, or bridge to a shielded address instead");
    return { account: acct.accountId };
  }

  async function quote() {
    const t = brToken();
    if (!t) throw new Error("pick a token");
    const q = await api("/api/bridge/quote", {
      direction: "deposit", token: t.erc20, amount: $("br-amount").value.trim(), recipient: recipientBody(),
    });
    bridge.quote = q;
    $("bridge-quote-holder")?.remove();
    $("bridge-deposit").querySelector("#br-quote").style.display = "";
    $("br-deposit-address").textContent = q.depositAddress;
    $("br-required").textContent = `${q.requiredToken} ${q.token.symbol} · ${q.requiredEth} ETH (gas budget ${q.gasBudgetEth})`;
    $("br-holds").textContent = `${q.balances.token} ${q.token.symbol} · ${q.balances.eth} ETH`;
    $("br-cap").textContent =
      `${q.cap.headroomDecimal} ${q.cap.symbol} left of ${q.cap.capDecimal} · ${q.cap.ethHeadroom} ETH left of ${q.cap.ethCap}`;
    const ready = $("br-ready");
    ready.textContent = q.ready
      ? "ready — the address holds the tokens and the gas; Start deposit asks the MPC to sweep it"
      : `not ready — send ${q.shortfall.token} ${q.token.symbol} and ${q.shortfall.eth} ETH to that address`;
    ready.style.color = q.ready ? "var(--ok)" : "var(--warn)";
    $("br-start").disabled = !q.ready;
  }

  $("br-token").onchange = guard(quote);
  $("br-amount").onchange = guard(quote);
  $("br-token-custom").onchange = guard(quote);
  $("br-rec-address").onchange = guard(quote);
  $("br-refresh").onclick = guard(quote);
  for (const id of ["br-rec-account", "br-rec-wallet"]) {
    $(id).onchange = guard(async () => {
      $("br-rec-address").disabled = !$("br-rec-wallet").checked;
      await quote();
    });
  }
  $("br-use-frontend").onclick = guard(async () => {
    if (!bridge.info?.frontendWallet) throw new Error("this stack published no frontend wallet address");
    $("br-rec-wallet").checked = true;
    $("br-rec-address").disabled = false;
    $("br-rec-address").value = bridge.info.frontendWallet;
    await quote();
  });
  $("br-copy").onclick = () => navigator.clipboard?.writeText($("br-deposit-address").textContent);

  $("br-start").onclick = guard(async () => {
    const q = bridge.quote;
    if (!q) throw new Error("get a quote first");
    $("br-start").disabled = true;
    try {
      if (q.recipient.kind === "wallet") {
        // No signature: the relay wallet calls the vault at root. See the header.
        $("joblog3").textContent = "starting a deposit to a Midnight wallet (no signature — the "
          + "recipient is pinned by the derivation)…";
        const { jobId } = await api("/api/bridge/deposit/start", {
          token: q.token.erc20, amount: q.requiredToken, recipient: { shieldedAddress: q.recipient.shieldedAddress },
        });
        await watchBridgeJob(jobId);
      } else {
        const prep = await api("/api/prepare", {
          kind: "bridge-deposit-start", owner: state.signer,
          accountId: q.recipient.accountId, token: q.token.erc20, amount: q.requiredToken,
        });
        $("joblog3").textContent = "waiting for the wallet to sign the deposit start…";
        const signature = await signPrepared(prep);
        const { jobId } = await api("/api/submit", { prepId: prep.prepId, signature });
        await watchBridgeJob(jobId);
      }
      await quote();
    } finally {
      $("br-start").disabled = false;
    }
  });

  // ── the withdraw quote ────────────────────────────────────────────────────

  async function wquote() {
    const erc20 = $("brw-token").value;
    if (!erc20) throw new Error("this account holds no bridged coin yet");
    const q = await api("/api/bridge/quote", {
      direction: "withdraw", token: erc20, amount: $("brw-amount").value.trim(),
    });
    bridge.wquote = q;
    $("brw-quote").style.display = "";
    $("brw-vault").textContent = q.vaultEvmAddress;
    $("brw-holds").textContent = `${q.balances.token} ${q.token.symbol} · ${q.balances.eth} ETH`;
    $("brw-gas").textContent = `${q.requiredEth} ETH (budget ${q.gasBudgetEth})`;
    const acct = myAccount();
    const held = (acct?.shielded ?? {})[q.token.symbol] ?? "0";
    $("brw-account-holds").textContent = `${held} (raw) of ${q.token.symbol}`;
    const ready = $("brw-ready");
    ready.textContent = q.ready
      ? "ready — the vault's EVM account has the tokens and the gas"
      : "not ready — the vault's own EVM account needs the gas above before the MPC's transfer can be included";
    ready.style.color = q.ready ? "var(--ok)" : "var(--warn)";
    $("brw-start").disabled = !q.ready || !acct;
  }
  $("brw-token").onchange = guard(wquote);
  $("brw-amount").onchange = guard(wquote);
  $("brw-refresh").onclick = guard(wquote);
  $("brw-start").onclick = guard(async () => {
    const q = bridge.wquote;
    const acct = myAccount();
    if (!q || !acct) throw new Error("get a quote first");
    $("brw-start").disabled = true;
    try {
      const prep = await api("/api/prepare", {
        kind: "bridge-withdraw-start", owner: state.signer, accountId: acct.accountId,
        token: q.token.erc20, amount: $("brw-amount").value.trim(), dest: $("brw-dest").value.trim(),
      });
      $("joblog3").textContent = "waiting for the wallet to sign the withdrawal…";
      const signature = await signPrepared(prep);
      const { jobId } = await api("/api/submit", { prepId: prep.prepId, signature });
      await watchBridgeJob(jobId);
      await wquote();
    } finally {
      $("brw-start").disabled = false;
    }
  });

  // ── the request list ──────────────────────────────────────────────────────

  async function loadRequests() {
    if (!bridge.info?.available) return;
    const r = await api("/api/bridge/requests");
    const body = $("br-requests");
    body.innerHTML = "";
    for (const req of [...(r.requests ?? [])].reverse()) {
      const tr = document.createElement("tr");
      const cells = [
        req.requestId.slice(0, 14) + "…",
        req.direction,
        `${req.amountRaw} raw ${req.symbol}`,
        req.recipient?.kind === "account"
          ? `account ${String(req.accountId ?? "").slice(0, 12)}…`
          : `wallet ${String(req.recipient?.coinPublicKey ?? "").slice(0, 12)}…`,
        req.evmTxHash ? req.evmTxHash.slice(0, 14) + "…" : "—",
        req.attestationLabel ?? "—",
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = String(text);
        tr.append(td);
      }
      const st = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `pill ${req.state === "completed" ? "ok" : req.state === "error" ? "err" : "warn"}`;
      pill.textContent = req.state;
      st.append(pill);
      if (req.error) st.title = req.error;
      tr.append(st);
      const act = document.createElement("td");
      if (req.state !== "completed") {
        const b = document.createElement("button");
        b.className = "ghost";
        b.style.cssText = "padding:2px 10px;font-size:12px";
        b.textContent = "Resume";
        b.onclick = guard(async () => {
          const { jobId } = await api(`/api/bridge/relay/${req.requestId}`, {});
          await watchBridgeJob(jobId);
        });
        act.append(b);
      }
      tr.append(act);
      body.append(tr);
    }
    const spent = r.spent ?? { tokens: {}, ethWei: "0" };
    const tokenSpend = Object.entries(spent.tokens ?? {})
      .map(([sym, raw]) => {
        const t = bridge.tokens.find((x) => x.symbol.toUpperCase() === sym);
        return `${sym} ${raw} raw${t ? ` (cap ${t.cap.capDecimal})` : ""}`;
      }).join(" · ");
    $("br-spent").textContent = `bridged so far on this stack: ${tokenSpend || "nothing"}`;
  }

  // ── the pane toggle, and the tab's own poll ───────────────────────────────

  $("bridge-seg").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-bridge]");
    if (!b) return;
    bridge.activePane = b.dataset.bridge;
    for (const x of document.querySelectorAll("#bridge-seg button")) x.classList.toggle("active", x === b);
    for (const p of document.querySelectorAll(".brpane")) p.classList.toggle("active", p.id === `bridge-${b.dataset.bridge}`);
    if (b.dataset.bridge === "requests") loadRequests().catch(() => {});
    if (b.dataset.bridge === "withdraw") { renderWithdrawTokens(); wquote().catch(() => {}); }
  });

  // The page boots app.js first; this runs after /api/info has landed, and again whenever the
  // accounts poll refreshes (a new account changes what the withdraw selector may offer).
  const boot = async () => {
    try {
      await loadBridge();
      if (bridge.info?.available) await loadRequests();
    } catch (e) {
      console.error("bridge tab", e);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else setTimeout(boot, 300);
  setInterval(() => {
    if (state.activeJob) return;
    if (!document.getElementById("view-bridge").classList.contains("active")) return;
    loadRequests().catch(() => {});
    renderWithdrawTokens();
  }, 15000);

  window.bridgeTab = { reload: boot, quote, loadRequests };
})();
