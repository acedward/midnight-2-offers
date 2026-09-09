// aa-console-mint.ts — drive the AA console's OWN HTTP API for one shielded and one
// unshielded mint THROUGH THE LOCAL mint-test-tokens ISSUERS, and assert the Manager's
// ledger balances that result.
//
//   docker exec <aa-console container> bun /aa/runner/aa-console-mint.ts
//
// (scripts/verify-aa.sh --mint does exactly that; ./verify.sh --aa-mint runs it, and
// scripts/ci-check.sh passes --aa-mint by default.)
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// PR-B (00017 P5.5) replaced the console's three DERIVED offer-files colours with a read of
// the faucet registry: the console's mint buttons now call the six LOCAL issuers' `mint`
// circuits. Until this file, that claim was checked in exactly two ways — `/api/info` says
// `tokensSource: "mint-test-tokens"` and lists six names with the right decimals — and both
// are CONFIGURATION. Neither proves a mint through those issuers ever succeeds. The only
// end-to-end evidence was a human clicking the buttons once (recorded in the plan's P6/P8).
//
// So this drives the exact path the page drives, over the same HTTP surface, in the same
// order:
//
//   POST /api/prepare  {kind:"register", owner}   -> prepId + the eth_signTypedData_v4 request
//   (sign)                                        -> what MetaMask does, with a throwaway key
//   POST /api/submit   {prepId, signature}        -> jobId; the relay recovers the signer,
//                                                    proves `execute` and submits
//   POST /api/fund          {accountId, amount, token}  -> MINT unshielded via the issuer,
//                                                          then depositUnshielded
//   POST /api/fund-shielded {accountId, amount, token}  -> MINT shielded via the issuer,
//                                                          then depositShielded
//   POST /api/pure {fn:"unshieldedBalance"|"shieldedBalance"} -> the MANAGER'S LEDGER
//
// The last step is the assertion that matters: `/api/fund*` returning a job that says "done"
// proves the relay did not throw; only the ledger read proves the value landed, on the right
// account, under the right colour, at the right scale.
//
// ── WHY IT SIGNS INSTEAD OF USING THE CONSOLE'S DEV SIGNER ──────────────────
// `AA_CONSOLE_DEV_SIGNER` is off by default and stays off: enabling a built-in signer with a
// well-known key by default would change what the demo ships to make a test easier. Signing
// here costs four lines and is a MORE faithful reproduction of the browser anyway — it signs
// `request.params[1]`, the typed-data JSON the console handed out, exactly as MetaMask would,
// rather than re-deriving the action.
//
// ── WHY THE REGISTER STEP IS NOT OPTIONAL ──────────────────────────────────
// The Manager refuses a deposit to an unknown account: `assert(accounts.member(acct), "credit
// account is not registered")` guards both depositShielded and depositUnshielded. So the
// account has to exist, and creating it is one EVM-signed `execute` — which is also the
// cheapest possible proof that the relay's whole prepare/recover/prove/submit chain works.

// ── issue 00020: NEVER let bun auto-install a pinned dependency ─────────────
// `await import("<pkg>")` in a bun process with network access SUCCEEDS on a package that is
// not installed — bun fetches it from npm at run time, at whatever version the registry
// resolves, into ~/.bun/install/cache. For a signing library that would mean signing with an
// unpinned implementation and calling the result a verified path. Resolve first, and require
// the answer to come from the image's own tree.
for (const pkg of ["@metamask/eth-sig-util"]) {
  const where = Bun.resolveSync(pkg, "/aa");
  if (!where.startsWith("/aa/node_modules/")) {
    console.error(`[aa-console-mint] ${pkg} resolved to ${where}, not /aa/node_modules — ` +
      `refusing to run against a package this image did not install (infra issue 00020)`);
    process.exit(2);
  }
}

const { signTypedData, SignTypedDataVersion } = await import("@metamask/eth-sig-util");

const TAG = "[aa-console-mint]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
const fail = (msg: string): never => { console.error(`${TAG} FAIL ${msg}`); process.exit(1); };

const BASE = (process.env["AA_CONSOLE_MINT_URL"] ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
// A throwaway EVM key used for nothing else in this stack. Public by design, like every seed
// here; it owns one AA account on a devnet that is wiped by `./down.sh -v`.
// (`a11ce0de` x8 = 64 hex chars; distinct from the console's own env-gated dev key.)
const OWNER_KEY = (process.env["AA_CONSOLE_MINT_KEY"]
  ?? "0x" + "a11ce0de".repeat(8)) as `0x${string}`;
const AMOUNT = BigInt(process.env["AA_CONSOLE_MINT_AMOUNT"] ?? "1000");
const JOB_TIMEOUT_MS = Number(process.env["AA_CONSOLE_MINT_JOB_TIMEOUT_MS"] ?? 900_000);

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) fail(`${path} answered ${res.status}: ${text.slice(0, 400)}`);
  return parsed as T;
}

/** Poll a console job to completion. Its `log` is echoed, because when a mint fails the
 *  reason is in there and nowhere else. */
async function awaitJob(jobId: string, what: string): Promise<any> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let printed = 0;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    for (const line of (job.log ?? []).slice(printed)) log(`  ${what}: ${line}`);
    printed = (job.log ?? []).length;
    if (job.state === "done") return job;
    if (job.state === "error") fail(`${what} failed: ${job.error ?? "no error given"}`);
    if (Date.now() > deadline) fail(`${what} did not finish within ${JOB_TIMEOUT_MS / 1000}s (state=${job.state})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ── 0. the console's own view of the token set ──────────────────────────────
const info = await api("/api/info");
if (info.tokensSource !== "mint-test-tokens") {
  fail(`/api/info reports tokensSource=${JSON.stringify(info.tokensSource)}, expected "mint-test-tokens" ` +
    `— this console is not reading the local faucet registry, so there is nothing to mint through`);
}
if (info.tokensError) fail(`the console could not resolve its token set: ${info.tokensError}`);
const tokens: Array<{ name: string; family: string; color: string; decimals: number; issuer?: string }> =
  info.tokens ?? [];
if (tokens.length < 2) fail(`/api/info lists ${tokens.length} token(s); the local registry has six`);

const pick = (family: string, wanted?: string) => {
  const t = wanted ? tokens.find((x) => x.name === wanted) : tokens.find((x) => x.family === family);
  if (!t) fail(`no ${family} token named ${wanted ?? "(any)"} in the console's token set`);
  if (t!.family !== family) fail(`${t!.name} is ${t!.family}, expected ${family}`);
  if (!t!.issuer) fail(`${t!.name} carries no issuer address — it did not come from the faucet registry`);
  return t!;
};
const SH = pick("shielded", process.env["AA_CONSOLE_MINT_SHIELDED"] ?? "twUSDC");
const UN = pick("unshielded", process.env["AA_CONSOLE_MINT_UNSHIELDED"] ?? "utwUSDC");
log(`registry revision ${String(info.tokensRegistryRevision ?? "?").slice(0, 16)}…`);
log(`shielded  ${SH.name} colour ${SH.color.slice(0, 16)}… decimals ${SH.decimals} issuer ${String(SH.issuer).slice(0, 16)}…`);
log(`unshielded ${UN.name} colour ${UN.color.slice(0, 16)}… decimals ${UN.decimals} issuer ${String(UN.issuer).slice(0, 16)}…`);

// ── 1. register an account: prepare -> sign -> submit ───────────────────────
// The owner address is derived by the SAME helper the console uses, out of the image's aalib,
// so the address this signs with and the address the relay recovers cannot drift.
const { addressForPrivateKey } = await import("/aa/aalib/signature.js");
const OWNER = String(addressForPrivateKey(OWNER_KEY)).toLowerCase();
log(`owner EOA ${OWNER}`);

const prep = await api("/api/prepare", { kind: "register", owner: OWNER });
const accountId: string = prep.summary?.accountId ?? prep.action?.accountId;
if (!/^0x[0-9a-f]{64}$/i.test(accountId ?? "")) fail(`/api/prepare returned no account id (${JSON.stringify(prep.summary)})`);
log(`account ${accountId}`);

// EXACTLY what MetaMask signs: the JSON string the console put in params[1]. Not a
// re-derivation of the action — the console verifies against its own in-memory prep, and a
// signature over anything but that digest is refused with "recovered signer is not the owner".
const typedData = JSON.parse(prep.request.params[1]);
if (String(prep.request.params[0]).toLowerCase() !== OWNER) {
  fail(`the console addressed the signing request to ${prep.request.params[0]}, not ${OWNER}`);
}
const signature = signTypedData({
  privateKey: Buffer.from(OWNER_KEY.slice(2), "hex"),
  data: typedData,
  version: SignTypedDataVersion.V4,
});
log(`signed ${typedData.primaryType} (${signature.slice(0, 18)}…)`);

const reg = await api("/api/submit", { prepId: prep.prepId, signature });
await awaitJob(reg.jobId, "register");

const registered = await api("/api/pure", { fn: "isRegistered", args: [accountId] });
if (registered.result?.registered !== true) fail(`the account is not in the Manager's accounts set after register`);
log(`register OK — the Manager's accounts set contains ${accountId.slice(0, 18)}…`);

// ── 2. the two mints, each followed by its deposit ──────────────────────────
// `/api/fund` and `/api/fund-shielded` are ONE console operation each: mint the token from
// its LOCAL ISSUER into the funder wallet, then deposit it into the AA account. That is the
// pair of buttons the page's Fund panel drives, and the reason both are exercised is that
// they take different circuits on both halves (mintShieldedTo/depositShielded vs
// mintUnshieldedTo/depositUnshielded), and the shielded half is the one that needs the
// recipient's encryption key to be right.
const before = {
  un: BigInt((await api("/api/pure", { fn: "unshieldedBalance", args: [accountId, UN.color] })).result.balance),
  sh: BigInt((await api("/api/pure", { fn: "shieldedBalance", args: [accountId, SH.color] })).result.balance),
};
log(`manager balances before: ${UN.name}=${before.un} ${SH.name}=${before.sh}`);

const fundUn = await api("/api/fund", { accountId, amount: String(AMOUNT), token: UN.name });
const jUn = await awaitJob(fundUn.jobId, `fund ${UN.name}`);

const fundSh = await api("/api/fund-shielded", { accountId, amount: String(AMOUNT), token: SH.name });
const jSh = await awaitJob(fundSh.jobId, `fund-shielded ${SH.name}`);

// ── 3. the assertion: the MANAGER'S LEDGER moved by exactly the deposited amounts ──
const after = {
  un: BigInt((await api("/api/pure", { fn: "unshieldedBalance", args: [accountId, UN.color] })).result.balance),
  sh: BigInt((await api("/api/pure", { fn: "shieldedBalance", args: [accountId, SH.color] })).result.balance),
};
log(`manager balances after:  ${UN.name}=${after.un} ${SH.name}=${after.sh}`);

const problems: string[] = [];
if (after.un - before.un !== AMOUNT) {
  problems.push(`${UN.name}: unshieldedBalances moved by ${after.un - before.un}, expected ${AMOUNT}`);
}
if (after.sh - before.sh !== AMOUNT) {
  problems.push(`${SH.name}: shieldedBalances moved by ${after.sh - before.sh}, expected ${AMOUNT}`);
}
// The pooled coin is the shielded half's other half: the Manager custodies one coin per
// colour, and a credited balance with no pool entry would mean the ledger and the custody
// disagree.
const pooled = await api("/api/pure", { fn: "poolHasColour", args: [SH.color] });
if (pooled.result?.pooled !== true) problems.push(`${SH.name}: the Manager custodies no pooled coin of this colour`);

if (problems.length) fail(problems.join("; "));

log(`tx ids: ${UN.name} ${jUn.txId ?? "?"} · ${SH.name} ${jSh.txId ?? "?"}`);
log(`OK: ${AMOUNT} ${SH.name} (shielded) and ${AMOUNT} ${UN.name} (unshielded) minted through the ` +
    `local mint-test-tokens issuers and deposited into ${accountId.slice(0, 18)}… — Manager balances agree`);
// A single machine-readable line the shell gate greps for.
console.log(`${TAG} RESULT account=${accountId} shielded=${SH.name}:${after.sh - before.sh} ` +
            `unshielded=${UN.name}:${after.un - before.un}`);
