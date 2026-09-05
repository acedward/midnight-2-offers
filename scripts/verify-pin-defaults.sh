#!/usr/bin/env bash
# verify-pin-defaults.sh — OFFLINE. Every default of one source pin, everywhere
# in the repository, must be the SAME value — and of the right SHAPE for what that
# pin identifies (a 40-hex commit, a 64-hex SHA-256, or a vX.Y.Z release tag).
#
# ─── the defect this exists to catch ────────────────────────────────────────
# Until 00010 the kernel pin was internally inconsistent: `compose/offerfiles.yml`
# defaulted KERNEL_REF to `706301e…` while `compose/aa.yml`, both Dockerfiles,
# `.env.example` and `scripts/verify-source-pins.sh` said `b1420c4…`. Nothing
# noticed, because every check in this repo compares the RUNNING image against
# ONE of those copies — so `verify-source-pins.sh` compared the kernel image
# (built from 706301e) against its own expectation (b1420c4) and would only have
# failed once the offerfiles profile was actually up, with a message that reads
# like a stale image rather than a split pin. A pin with two values is not a pin.
#
# ─── what "a default" means here ────────────────────────────────────────────
# Three spellings, and all three are build inputs or expectations:
#   * `${NAME:-<value>}`    compose build args, and the `NAME_EXPECTED=` lines
#                           in scripts/ — the value used when `.env` is silent
#   * `ARG NAME=<value>`    the Dockerfile default, used by a direct
#                           `docker build` with no --build-arg
#   * `NAME=<value>` in .env.example, commented or not — what an operator copies
#
# An OVERRIDE in a real `.env` is none of this script's business: overriding a
# pin on purpose is legitimate, and `verify-source-pins.sh` is what proves the
# running bytes match whatever ended up configured. This script asserts the
# repository's own story is single-valued.
#
# ─── usage ──────────────────────────────────────────────────────────────────
#   scripts/verify-pin-defaults.sh              check this tree
#   scripts/verify-pin-defaults.sh --self-test  prove the check can FAIL:
#       copy the tree, change ONE default, assert a non-zero exit, then check
#       the untouched copy passes. Needs no Docker and no network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"

# The pins this repository builds from source. `config/artifact-decisions.json`
# holds the DIGEST-pinned runtime images instead, and verify-artifact-decisions.sh
# owns those — a commit and an image digest are different kinds of identity and
# are deliberately not mixed here.
#
# Three SHAPES, because the AA image's MinoCrab pins are three different kinds of
# thing and pretending they are all commits is how a check stops checking:
#
#   COMMIT_PINS  a 40-hex git commit
#   HASH_PINS    a 64-hex SHA-256 — MINOCRAB_SUMS_SHA256 is the IDENTITY of the
#                port's release (the hash of its SHA256SUMS), not a commit
#   TAG_PINS     a release tag, which is only a LOCATOR. It still has to be
#                single-valued: two files naming different tags would download
#                two different releases and verify neither.
COMMIT_PINS=(KERNEL_REF SOLVER_REF FRONTEND_REF AA_REF UMBRA_REF SHIELDED_NIGHT_REF MINOCRAB_REF)
HASH_PINS=(MINOCRAB_SUMS_SHA256)
TAG_PINS=(MINOCRAB_RELEASE)

COMMIT_RE='[0-9a-fA-F]{40}'
HASH_RE='[0-9a-fA-F]{64}'
TAG_RE='v[0-9]+\.[0-9]+\.[0-9]+'

# shape_of <NAME> -> the regex this pin's value must match. A `case` rather than a
# loop-and-`&&`: this runs inside $( ) under `set -e`, where a loop body whose last
# command is a failed test kills the subshell and yields an EMPTY pattern — which
# would silently match nothing and report every pin as undeclared.
shape_of() {
  case " ${HASH_PINS[*]} " in *" $1 "*) printf '%s' "$HASH_RE"; return ;; esac
  case " ${TAG_PINS[*]} "  in *" $1 "*) printf '%s' "$TAG_RE";  return ;; esac
  printf '%s' "$COMMIT_RE"
}

PIN_NAMES=("${COMMIT_PINS[@]}" "${HASH_PINS[@]}" "${TAG_PINS[@]}")

# Where a default may live. Kept explicit rather than "the whole repo": prose in
# README/docs legitimately names a SHA in the past tense, and a historical note
# must not be able to fail a build gate. Docs are covered by ci-check.sh's grep.
scan_files() { # <root>
  local root="$1"
  {
    [[ -f "$root/.env.example" ]] && printf '%s\n' "$root/.env.example"
    find "$root/compose" "$root/images" "$root/scripts" \
      -type f \( -name '*.yml' -o -name '*.yaml' -o -name 'Dockerfile' -o -name 'Dockerfile.*' -o -name '*.sh' \) \
      2>/dev/null
  } | sort -u \
    | grep -v "/scripts/verify-pin-defaults\.sh$"
  # THIS FILE IS EXCLUDED FROM ITS OWN SCAN. --self-test writes a deliberately
  # wrong `${KERNEL_REF:-0123…}` into a COPY of the tree, and that literal also
  # appears here, in the perl one-liner that writes it — so without this line the
  # checker reports itself as a second KERNEL_REF default and can never pass.
  # (It is not self-blindness: nothing builds from this script.)
}

# collect <root> <NAME> — every default of NAME, one "value<TAB>file:line" per line.
# The accepted VALUE SHAPE comes from shape_of, so a 64-hex release identity and a
# `vX.Y.Z` tag are collected as faithfully as a 40-hex commit. A pin collected with
# the wrong shape reads as "no default found anywhere", which is why the shape is a
# parameter rather than three copies of the same three greps.
collect() {
  local root="$1" name="$2" file re
  re="$(shape_of "$name")"
  while IFS= read -r file; do
    # 1. ${NAME:-<value>} — compose build args and NAME_EXPECTED= in scripts/
    grep -nE "\\\$\{${name}:-${re}\}" "$file" 2>/dev/null \
      | sed -E "s/^([0-9]+):.*\\\$\{${name}:-(${re})\}.*/\\2\t${file//\//\\/}:\\1/" || true
    # 2. ARG NAME=<value>
    grep -nE "^[[:space:]]*ARG[[:space:]]+${name}=${re}[[:space:]]*$" "$file" 2>/dev/null \
      | sed -E "s/^([0-9]+):[[:space:]]*ARG[[:space:]]+${name}=(${re}).*/\\2\t${file//\//\\/}:\\1/" || true
    # 3. NAME=<value> in .env.example, commented or not
    if [[ "$file" == *".env.example" ]]; then
      grep -nE "^[[:space:]]*#?[[:space:]]*${name}=${re}[[:space:]]*$" "$file" 2>/dev/null \
        | sed -E "s/^([0-9]+):[[:space:]]*#?[[:space:]]*${name}=(${re}).*/\\2\t${file//\//\\/}:\\1/" || true
    fi
  done < <(scan_files "$root")
}

check_tree() { # <root> — 0 when every pin is single-valued and well-formed
  local root="$1" name failures=0 rows shas count sha re
  for name in "${PIN_NAMES[@]}"; do
    re="$(shape_of "$name")"
    rows="$(collect "$root" "$name" || true)"
    if [[ -z "$rows" ]]; then
      err "${name}: no default found anywhere — a pin nothing declares cannot be verified"
      failures=$(( failures + 1 ))
      continue
    fi
    shas="$(printf '%s\n' "$rows" | cut -f1 | tr 'A-F' 'a-f' | sort -u)"
    count="$(printf '%s\n' "$shas" | grep -c . || true)"
    if (( count != 1 )); then
      err "${name}: ${count} DIFFERENT defaults in one repository — a pin with two values is not a pin"
      while IFS=$'\t' read -r sha where; do
        [[ -n "$sha" ]] && info "  ${sha}  ${where#"$root"/}"
      done < <(printf '%s\n' "$rows" | sort)
      failures=$(( failures + 1 ))
      continue
    fi
    sha="$shas"
    if [[ ! "$sha" =~ ^${re}$ ]]; then
      err "${name}: default '${sha}' does not match this pin's shape (${re})"
      failures=$(( failures + 1 ))
      continue
    fi
    # Upper-case hex is the same commit to git but a different string to every
    # `[[ "$a" == "$b" ]]` in this repo, so it is a failure, not a nit. Tags are
    # not hex and are exempt.
    if [[ "$re" != "$TAG_RE" ]] && printf '%s\n' "$rows" | cut -f1 | grep -qE '[A-F]'; then
      err "${name}: at least one default is upper-case hex; identities are compared as strings here"
      failures=$(( failures + 1 ))
      continue
    fi
    ok "${name} = ${sha} in $(printf '%s\n' "$rows" | grep -c .) place(s)"
  done
  return "$failures"
}

self_test() {
  local tmp victim
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  log "self-test: copying the tree to ${tmp}/tree"
  mkdir -p "$tmp/tree"
  ( cd "$REPO_ROOT" && tar --exclude=.git -cf - . ) | ( cd "$tmp/tree" && tar -xf - )

  log "self-test 1/3: the untouched copy must PASS"
  if ! check_tree "$tmp/tree" >/dev/null 2>&1; then
    err "self-test: the untouched copy FAILED — run the plain check to see why"
    check_tree "$tmp/tree" || true
    return 1
  fi
  ok "untouched copy passes"

  log "self-test 2/3: changing ONE KERNEL_REF default must FAIL"
  victim="$tmp/tree/compose/aa.yml"
  [[ -f "$victim" ]] || { err "self-test: ${victim} is missing"; return 1; }
  # A valid-looking but different SHA: the check must object to the DISAGREEMENT,
  # not to the shape.
  # The `\$\{` on BOTH sides is required: perl would otherwise read `${KERNEL_REF…}`
  # in the replacement as one of its own variables and die at compile time.
  perl -0pi -e 's/\$\{KERNEL_REF:-[0-9a-f]{40}\}/\$\{KERNEL_REF:-0123456789abcdef0123456789abcdef01234567\}/' "$victim"
  if check_tree "$tmp/tree" >/dev/null 2>&1; then
    err "self-test: a deliberately split KERNEL_REF still PASSED — the check does not work"
    return 1
  fi
  ok "a single-file edit is caught"

  # The MinoCrab release identity is a 64-hex SHA-256, not a commit — a shape the
  # original checker could not even see. Splitting it must fail just as loudly, or
  # the image would take bytes from one release while the repository documents
  # another.
  log "self-test 3/3: splitting the 64-hex MINOCRAB_SUMS_SHA256 must FAIL"
  ( cd "$tmp" && rm -rf tree && mkdir -p tree )
  ( cd "$REPO_ROOT" && tar --exclude=.git -cf - . ) | ( cd "$tmp/tree" && tar -xf - )
  victim="$tmp/tree/compose/aa.yml"
  perl -0pi -e 's/\$\{MINOCRAB_SUMS_SHA256:-[0-9a-f]{64}\}/\$\{MINOCRAB_SUMS_SHA256:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\}/' "$victim"
  if check_tree "$tmp/tree" >/dev/null 2>&1; then
    err "self-test: a deliberately split MINOCRAB_SUMS_SHA256 still PASSED — the hash-shaped pin is not checked"
    return 1
  fi
  ok "a split 64-hex release identity is caught"
  return 0
}

case "${1:-}" in
  --self-test)
    log "verify-pin-defaults --self-test"
    if self_test; then
      ok "self-test passed"
      exit 0
    fi
    err "self-test failed"
    exit 1
    ;;
  --help|-h)
    sed -n '2,40p' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  "") : ;;
  *) die "unknown argument '${1}' (try --self-test)" ;;
esac

log "source-pin defaults (offline)"
if check_tree "$REPO_ROOT"; then
  ok "every source pin has exactly one well-shaped default across compose/, images/, scripts/ and .env.example"
  exit 0
fi
err "source-pin defaults disagree — fix every copy, or the built image will not be the one the verifier expects"
exit 1
