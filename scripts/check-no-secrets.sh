#!/usr/bin/env bash
#
# Refuse to ship a secret. An OFFLINE grep over what this repository would publish.
#
#   ./scripts/check-no-secrets.sh                 # the tracked tree
#   ./scripts/check-no-secrets.sh --self-test     # …and prove every pattern still bites
#   ./scripts/check-no-secrets.sh --stdin         # scan stdin instead (for logs, compose config)
#   ./scripts/check-no-secrets.sh --path <file>   # scan one file or directory
#
# WHY IT EXISTS. Project 00035 gives this stack two operator secrets it never had before — a
# keyed Sepolia RPC URL and a personal Midnight wallet's seed — plus one it GENERATES, the
# per-stack MPC root key. All three are supposed to live only in an uncommitted `.env`, in
# `~/.config/`, or on a Docker volume. "Supposed to" is not a check. The cost of being wrong is
# not a failed build: it is a key in git history, which cannot be taken back.
#
# WHAT IT LOOKS FOR, and why each pattern is the shape a leak actually takes:
#
#   assigned key material   `MPC_ROOT_KEY=`, `..._SEED=`, `..._PRIVATE_KEY=`, `..._MNEMONIC=`
#                           and friends followed by a real value. A secret rarely appears bare;
#                           it appears assigned, because that is how it was copied out of a
#                           shell or a compose file. The stack's OWN published dev seeds are
#                           allow-listed by value (wallets/wallets.json documents every one of
#                           them as public), so the check is about NEW material.
#   provider keys           `alch_`, `alchemy.com/v2/<key>`, `infura.io/v3/<key>`,
#                           `quiknode`/`drpc`/`ankr` URLs with a path segment that looks like a
#                           token. A keyed RPC URL is a bearer credential.
#   the operator's wallet   the FIRST THREE WORDS of the mnemonic in
#                           ~/.config/aa-00034/owner-midnight-wallet.env, when that file exists
#                           on the machine running the check. The words never appear in this
#                           script, in its output, or in any log: they are read at run time and
#                           held in a variable. A hit prints the FILE AND LINE NUMBER only.
#   EVM private keys        a bare 0x + 64 hex that is not one of the repo's documented dev
#                           values.
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not scan `.env`, `.env.*` (other than
# `.env.example`), `.ci-logs/`, `evidence/` or anything git ignores: those are where secrets are
# SUPPOSED to be, and flagging them would train everyone to pass `--force`. It greps the tracked
# tree, which is exactly what a push publishes.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

MODE=tree
SCAN_PATH=""
SELF_TEST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test) SELF_TEST=1; shift ;;
    --stdin)     MODE=stdin; shift ;;
    --path)      MODE=path; SCAN_PATH="${2:?--path needs a file or directory}"; shift 2 ;;
    -h|--help)   sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── the allow-list: values this repository publishes ON PURPOSE ──────────────
#
# Every seed in wallets/wallets.json is documented there as a PUBLIC dev value that controls
# nothing but a throwaway `undeployed` chain, so the list is READ FROM THAT FILE rather than
# copied: adding a stack wallet cannot make this check start failing, and — more importantly —
# removing one cannot silently leave its value exempt. The handful that belong to no wallet
# facade are listed below, each with what it is.
#
# NOTE: ONE LINE, space separated. awk's -v does not accept a newline inside a value on BSD awk
# (macOS), and this script has to run on the same hosts the stack does.
WALLET_SEEDS="$(grep -oE '"seed"[[:space:]]*:[[:space:]]*"[0-9a-f]+"' "$REPO_ROOT/wallets/wallets.json" 2>/dev/null \
  | grep -oE '[0-9a-f]{64,128}' | tr '\n' ' ')"
EXTRA_ALLOWED="\
0000000000000000000000000000000000000000000000000000000000000021 \
303132333435363738393031323334353637383930313233343536373839303132"
# …the COW solver's observation-mode seed (deliberately unfunded, .env.example) and the
# indexer's demo HMAC secret (compose/core.yml). Both are published defaults.
ALLOWED_VALUES="${WALLET_SEEDS} ${EXTRA_ALLOWED}"
[[ -n "${WALLET_SEEDS// /}" ]] || die "could not read any seed out of wallets/wallets.json — the allow-list would be empty and every dev seed would be reported"

# The owner's mnemonic, if this machine holds it. Read at run time into a variable; the words
# are never printed and never written anywhere. Absent on a CI machine, which is correct —
# there is nothing there to leak.
OWNER_PREFIX=""
OWNER_ENV="${OWNER_MIDNIGHT_WALLET_ENV:-$HOME/.config/aa-00034/owner-midnight-wallet.env}"
if [[ -r "$OWNER_ENV" ]]; then
  OWNER_PREFIX="$(grep -E '^OWNER_MIDNIGHT_MNEMONIC=' "$OWNER_ENV" 2>/dev/null \
    | cut -d= -f2- | tr -d '"' | awk '{print $1" "$2" "$3}')"
  [[ "${#OWNER_PREFIX}" -lt 8 ]] && OWNER_PREFIX=""
fi

FAILURES=0
HITS=0

# scan <label> — read the candidate lines on stdin as `<file>:<line>:<text>` and report.
# Everything is decided in ONE awk pass so the patterns live in one readable place.
scan() {
  awk -v allowed="$ALLOWED_VALUES" -v ownerprefix="$OWNER_PREFIX" '
    BEGIN {
      n = split(allowed, a, /[ \t\n]+/);
      for (i = 1; i <= n; i++) if (length(a[i]) > 8) ok[tolower(a[i])] = 1;
      hits = 0;
    }
    # `file:line:text` from grep -n -r; the text may itself contain colons.
    {
      p1 = index($0, ":"); file = substr($0, 1, p1 - 1); rest = substr($0, p1 + 1);
      p2 = index(rest, ":"); lno = substr(rest, 1, p2 - 1); text = substr(rest, p2 + 1);
      low = tolower(text);

      # 1. assigned key material with a value that is not an allow-listed dev constant.
      if (match(low, /(root_key|_seed|private_key|privatekey|secret_key|mnemonic|_key)[ \t]*[=:][ \t]*"?'"'"'?(0x)?[0-9a-f]{64,128}/)) {
        m = substr(low, RSTART, RLENGTH);
        if (match(m, /[0-9a-f]{64,128}$/)) {
          val = substr(m, RSTART, RLENGTH);
          if (!(val in ok)) { print "assigned key material: " file ":" lno; hits++; next }
        }
      }
      # 2. keyed RPC endpoints. A provider URL with a token path segment is a credential.
      if (match(low, /alch_[0-9a-z_-]{10,}/) ||
          match(low, /(alchemy\.com|infura\.io|quiknode\.pro|drpc\.org|ankr\.com)[a-z0-9\/._-]*\/(v2|v3)\/[0-9a-z_-]{12,}/)) {
        print "keyed RPC endpoint: " file ":" lno; hits++; next
      }
      # 3. a bare EVM private key that is not an allow-listed dev constant.
      if (match(low, /0x[0-9a-f]{64}([^0-9a-f]|$)/)) {
        m = substr(low, RSTART + 2, 64);
        if (!(m in ok) && match(low, /(key|secret|seed|priv)/)) {
          print "possible private key: " file ":" lno; hits++; next
        }
      }
      # 4. the operator wallet mnemonic. Matched on its first three words; the words are never
      #    echoed, and the report names only the file and line.
      if (ownerprefix != "" && index(low, tolower(ownerprefix)) > 0) {
        print "the operator wallet mnemonic: " file ":" lno; hits++; next
      }
    }
    END { exit (hits > 0 ? 1 : 0) }
  '
}

run_scan() {
  local label="$1" out
  out="$(cat)" || true
  if [[ -z "$out" ]]; then
    ok "${label}: nothing to inspect"
    return 0
  fi
  local report
  report="$(printf '%s\n' "$out" | scan)"
  local rc=$?
  if (( rc == 0 )); then
    ok "${label}: no secret-shaped content"
    return 0
  fi
  err "${label}: SECRET-SHAPED CONTENT FOUND"
  printf '%s\n' "$report" | sed 's/^/      /' >&2
  dim "      (only the location is printed — the value is deliberately not echoed)"
  return 1
}

case "$MODE" in
  tree)
    log "secret hygiene: the tracked tree"
    # THIS FILE IS EXCLUDED FROM ITS OWN SCAN, for the same reason
    # scripts/verify-pin-defaults.sh excludes itself: the --self-test fixtures below are
    # deliberately secret-SHAPED — a fake Alchemy URL, a fake root key — and would otherwise
    # report the checker as the leak. They are literals in a test harness that nothing reads but
    # this script, and every one of them is a value that exists nowhere else. It is not
    # self-blindness: no image, container or service is built from this file.
    if ! git -C "$REPO_ROOT" ls-files -z \
        | xargs -0 grep -InE '(0x)?[0-9a-f]{64}|alch_|alchemy\.com|infura\.io|quiknode|drpc\.org|ankr\.com|MNEMONIC' 2>/dev/null \
        | grep -v '^scripts/check-no-secrets\.sh:' \
        | run_scan "tracked files"; then
      FAILURES=$(( FAILURES + 1 ))
    fi
    ;;
  stdin)
    # For a log or a `docker compose config` rendering. Synthesised file:line so the awk pass
    # reads the same shape either way.
    if ! awk '{ printf "(stdin):%d:%s\n", NR, $0 }' | run_scan "stdin"; then
      FAILURES=$(( FAILURES + 1 ))
    fi
    ;;
  path)
    [[ -e "$SCAN_PATH" ]] || die "no such path: $SCAN_PATH"
    if ! grep -InrE '(0x)?[0-9a-f]{64}|alch_|alchemy\.com|infura\.io|quiknode|drpc\.org|ankr\.com|MNEMONIC' "$SCAN_PATH" 2>/dev/null \
        | run_scan "$SCAN_PATH"; then
      FAILURES=$(( FAILURES + 1 ))
    fi
    ;;
esac

# ── the self-test: prove every pattern still bites ───────────────────────────
#
# A hygiene check that stopped matching passes silently and forever, which is the worst possible
# failure mode for this particular script. Each fixture is fed through the SAME awk pass the real
# scan uses and must be rejected; the last one must be ACCEPTED, so a pattern that matches
# everything is caught too.
if (( SELF_TEST )); then
  echo
  log "negative fixtures"
  st_fail=0
  st_case() {
    local name="$1" line="$2" want="$3" got
    printf '(fixture):1:%s\n' "$line" | scan >/dev/null 2>&1 && got=accept || got=reject
    if [[ "$got" == "$want" ]]; then
      ok "  ${want}ed as expected: ${name}"
    else
      err "  ${name}: expected ${want}, got ${got}"
      st_fail=1
    fi
  }
  st_case "a generated MPC root key"      'MPC_ROOT_KEY=0x9f2c41b7e8a35d06c1743fb920e85adc63701fe248b5c9d0a6e3f81724bd5c9e' reject
  st_case "an Alchemy key in a URL"       'EVM_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/Ab3xY9_qLmNoPqRsTuVw' reject
  st_case "an alch_ token"                'SOME_URL=https://x/alch_0123456789abcdef' reject
  st_case "a wallet seed assignment"      'FRONTEND_WALLET_SEED=4f1c9e2b7a58d63041fbe95c28a7d106b3f48e5c90d217ae6b4c83f105927dae' reject
  st_case "a bare private key near 'key'" 'const key = "0x1122334455667788990011223344556677889900112233445566778899001122";' reject
  st_case "the repo's published dev seed" 'AA_CONSOLE_SEED=aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0aac0' accept
  st_case "a genesis seed"                'WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001' accept
  st_case "an ordinary 64-hex colour"     'const colour = "28a1d3787fb1e036a9eab78719caa2d7c13e285632677b9f4a08bf90e37d5102";' accept
  st_case "a contract address"            'vault 78b71111b66239f8ff7754e47c52ba308c4e75e819a3a60de93b5ffefb2b33a2' accept
  if [[ -n "$OWNER_PREFIX" ]]; then
    st_case "the operator mnemonic prefix" "a note that starts ${OWNER_PREFIX} and goes on" reject
  else
    info "  (the operator mnemonic fixture is skipped: ${OWNER_ENV} is not readable here)"
  fi
  (( st_fail )) && FAILURES=$(( FAILURES + 1 ))
fi

if (( FAILURES == 0 )); then
  ok "secret hygiene: clean"
  exit 0
fi
err "secret hygiene: ${FAILURES} check(s) failed"
exit 1
