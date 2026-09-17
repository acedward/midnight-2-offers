// aa-console-mint.ts — drive the AA console's OWN HTTP API to REGISTER an account and fund
// it through the LOCAL mint-test-tokens issuers, then assert the result from chain state.
//
//   docker exec <aa-console container> bun /aa/runner/aa-console-mint.ts
//
// (scripts/verify-aa.sh --mint does exactly that; ./verify.sh --aa-mint runs it, and
// scripts/ci-check.sh passes --aa-mint by default.)
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Everything else verify-aa.sh checks is CONFIGURATION: the deploy receipt says what was
// deployed and `/api/info` says what the console believes about its token set. Neither
// proves that a register or a mint through those issuers ever succeeds. This drives the
// exact path the page drives, over the same HTTP surface, in the same order.
//
// ── ⚠ WHAT PROJECT 00034 CHANGED HERE ───────────────────────────────────────
// `register` no longer mints an id inside a shared Manager. It DEPLOYS a contract, and that
// changes this driver in three visible ways:
//
//   1. THE FIRST SIGNATURE IS NOT AN AUTHORISATION. An account's initial device is enrolled
//      by revealing its public POINT, which no EVM wallet exposes and which
//      `activate_initial_device_with_evm` carries as an argument — so the console asks for
//      an EIP-191 `personal_sign` over a fixed sentence that names no operation and moves
//      no funds (Q30). `/api/prepare` answers with `message` instead of `typedData`, and
//      this driver signs it with `personalSign`, which is what a wallet would do.
//   2. THE ACCOUNT ID EXISTS ONLY AFTERWARDS. It is the contract address, derived from the
//      deploy transaction, so there is nothing to sign over in advance (Q40). The driver
//      reads it out of the finished job.
//   3. THE SHIELDED HALF IS NOT ON THE LEDGER. A Passport account's shielded coins live in
//      the owner's private state and the chain carries only an encrypted inbox entry, so
//      the assertion for the shielded deposit is the console's own coin store plus the
//      account's `inbox_count` — both read back over the API, neither taken on trust from
//      the job's own "done".
//
// ── WHY IT SIGNS WITH @metamask/eth-sig-util ───────────────────────────────
// `AA_CONSOLE_DEV_SIGNER` is off by default and stays off: enabling a built-in signer with a
// well-known key would change what the demo ships to make a test easier. Signing here with
// the library a real MetaMask uses also makes this a CROSS-CHECK of the frozen byte contract
// (spec SC-006) rather than a re-derivation of it: if this project's EIP-712 codec and
// MetaMask's ever disagreed, the point the console recovers would belong to another address
// and the submit would be refused by name.

// ── issue 00020: NEVER let bun auto-install a pinned dependency ─────────────
// `await import("<pkg>")` in a bun process with network access SUCCEEDS on a package that is
// not installed — bun fetches it from npm at run time, at whatever version the registry
// resolves. For a signing library that would mean signing with an unpinned implementation
// and calling the result a verified path. Resolve first, and require the answer to come from
// the image's own tree.
for (const pkg of ["@metamask/eth-sig-util"]) {
  const where = Bun.resolveSync(pkg, "/aa");
  if (!where.startsWith("/aa/node_modules/")) {
    console.error(`[aa-console-mint] ${pkg} resolved to ${where}, not /aa/node_modules — ` +
      `refusing to run against a package this image did not install (infra issue 00020)`);
    process.exit(2);
  }
}

const { personalSign } = await import("@metamask/eth-sig-util");

const TAG = "[aa-console-mint]";
const log = (...a: unknown[]) => console.log(TAG, ...a);
const fail = (msg: string): never => { console.error(`${TAG} FAIL ${msg}`); process.exit(1); };

const BASE = (process.env["AA_CONSOLE_MINT_URL"] ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
// A throwaway EVM key used for nothing else in this stack. Public by design, like every seed
// here; it owns one account on a devnet that `./down.sh -v` wipes.
const OWNER_KEY = (process.env["AA_CONSOLE_MINT_KEY"]
  ?? `0x${"a11ce0de".repeat(8)}`) as `0x${string}`;
const AMOUNT = BigInt(process.env["AA_CONSOLE_MINT_AMOUNT"] ?? "1000");
// A two-wave account deploy on a cold devnet is minutes, and the k=18 activation proof is
// the slowest single step in this stack.
const JOB_TIMEOUT_MS = Number(process.env["AA_CONSOLE_MINT_JOB_TIMEOUT_MS"] ?? 1_800_000);

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

/** Poll a console job to completion. Its `log` is echoed, because when a step fails the
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

// ── 0. the console's own view ───────────────────────────────────────────────
const info = await api("/api/info");
if (info.model !== "passport-per-user-account") {
  fail(`/api/info reports model=${JSON.stringify(info.model)} — this driver is for the Passport account model`);
}
if (info.tokensSource !== "mint-test-tokens") {
  fail(`/api/info reports tokensSource=${JSON.stringify(info.tokensSource)}, expected "mint-test-tokens"`);
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
log(`vault ${String(info.vault?.address ?? "?").slice(0, 20)}… — sealed into every account this console registers`);
log(`shielded   ${SH.name} colour ${SH.color.slice(0, 16)}… decimals ${SH.decimals}`);
log(`unshielded ${UN.name} colour ${UN.color.slice(0, 16)}… decimals ${UN.decimals}`);

// ── 1. register: prepare -> personal_sign -> submit ─────────────────────────
const keyBuf = Buffer.from(OWNER_KEY.slice(2), "hex");
// The address the console will be told to expect. Derived with the PROJECT's own client
// rather than with an Ethereum utility library, because the two must agree by construction:
// the console recovers a point from the signature and hashes it to an address, and if this
// driver named a different one the submit would be refused by name rather than silently.
// `addressHex` already carries the `0x`.
const { EvmDevice } = await import("../passport/src/wallet/signer.js");
const OWNER = EvmDevice.fromPrivateKey(new Uint8Array(keyBuf)).addressHex.toLowerCase();
log(`owner EOA ${OWNER}`);

const prep = await api("/api/prepare", { kind: "register", owner: OWNER });
if (typeof prep.message !== "string" || !prep.message) {
  fail(`/api/prepare(register) returned no personal_sign message — the enrolment step is missing (Q30)`);
}
if (prep.typedData) fail("/api/prepare(register) returned typed data; enrolment must be EIP-191, not EIP-712");
log(`enrolment message (authorises nothing): ${JSON.stringify(prep.message.split("\n")[0])}`);

// EXACTLY what a wallet's personal_sign does: EIP-191 over the message the console handed
// out. The console recovers the public point from it and checks the derived address.
const signature = personalSign({ privateKey: keyBuf, data: prep.message });
log(`signed (${signature.slice(0, 18)}…)`);

const reg = await api("/api/submit", { prepId: prep.prepId, signature });
const regJob = await awaitJob(reg.jobId, "register");
const address: string = regJob.data?.address ?? regJob.txId;
if (!/^[0-9a-f]{64}$/i.test(String(address).replace(/^0x/, ""))) {
  fail(`register finished without an account address (${JSON.stringify(regJob.data)})`);
}
log(`account ${address} — ${regJob.data?.circuits ?? "?"} circuits deployed across two waves`);

const findAccount = async () => {
  const list = await api(`/api/accounts?owner=${OWNER}`);
  const row = (list.accounts ?? []).find((a: any) => a.address === address);
  if (!row) fail(`the console's registry does not list ${address} for ${OWNER}`);
  return row;
};
const registered = await findAccount();
if (registered.booted !== true) fail("the account's ledger says booted=false — activation did not land");
log(`register OK — booted, authNonce ${registered.authNonce}, inbox ${registered.inboxCount}`);

// ── 2. the two fundings, each a mint through the issuer plus a deposit ──────
// They take different circuits on both halves (mint + deposit_unshielded vs mint +
// deposit_shielded), and the shielded half is the one that also has to seal an inbox entry
// to the account's advertised key and capture the coin's Merkle position afterwards.
const before = await findAccount();
log(`before: ${UN.name} (ledger) = ${before.unshielded?.[UN.name] ?? "0"}; ` +
    `${SH.name} (coin store) = ${before.shielded?.[SH.name] ?? "0"}; inbox ${before.inboxCount}`);

const fundUn = await api("/api/fund", { accountId: address, amount: String(AMOUNT), token: UN.name });
const jUn = await awaitJob(fundUn.jobId, `fund ${UN.name}`);

const fundSh = await api("/api/fund-shielded", { accountId: address, amount: String(AMOUNT), token: SH.name });
const jSh = await awaitJob(fundSh.jobId, `fund-shielded ${SH.name}`);

// ── 3. the assertion: chain state and custody both moved ───────────────────
const after = await findAccount();
log(`after:  ${UN.name} (ledger) = ${after.unshielded?.[UN.name] ?? "0"}; ` +
    `${SH.name} (coin store) = ${after.shielded?.[SH.name] ?? "0"}; inbox ${after.inboxCount}`);

const problems: string[] = [];
const un = BigInt(after.unshielded?.[UN.name] ?? "0") - BigInt(before.unshielded?.[UN.name] ?? "0");
if (un !== AMOUNT) problems.push(`${UN.name}: unshielded_balances moved by ${un}, expected ${AMOUNT}`);

const sh = BigInt(after.shielded?.[SH.name] ?? "0") - BigInt(before.shielded?.[SH.name] ?? "0");
if (sh !== AMOUNT) problems.push(`${SH.name}: the coin store moved by ${sh}, expected ${AMOUNT}`);

// The inbox entry is what makes a shielded deposit DISCOVERABLE: without it the coin still
// belongs to the account and nobody, including its owner, can ever find it (S3). A deposit
// that did not advance inbox_count is the exact silent failure this checks for.
if (BigInt(after.inboxCount) - BigInt(before.inboxCount) < 1n) {
  problems.push(`inbox_count did not advance — the shielded deposit filed no entry, so the coin is undiscoverable`);
}

if (problems.length) fail(problems.join("; "));

log(`tx ids: ${UN.name} ${jUn.txId ?? "?"} · ${SH.name} ${jSh.txId ?? "?"}`);
log(`OK: an account was deployed for ${OWNER}, and ${AMOUNT} ${SH.name} (shielded, with its inbox ` +
    `entry) and ${AMOUNT} ${UN.name} (unshielded) were minted through the local issuers and deposited`);
// A single machine-readable line the shell gate greps for.
console.log(`${TAG} RESULT account=${address} owner=${OWNER} shielded=${SH.name}:${sh} unshielded=${UN.name}:${un}`);
