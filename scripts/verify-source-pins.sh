#!/usr/bin/env bash
# Verify that running optional profiles were built from the exact configured
# external source commits, rather than a stale shared :local image.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "$REPO_ROOT/scripts/lib/common.sh"
load_env

FAILURES=0

present() {
  [[ -n "$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1" 2>/dev/null)" ]]
}

assert_pin() { # label image path expected
  local label="$1" image="$2" path="$3" expected="$4" actual
  if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
    err "${label}: configured ref is not a full commit SHA (${expected})"
    FAILURES=$(( FAILURES + 1 ))
    return
  fi
  actual=$(docker run --rm --entrypoint cat "$image" "$path" 2>/dev/null | tr -d '\r\n') || actual=""
  if [[ "$actual" == "$expected" ]]; then
    ok "${label} source pin ${actual:0:12}…"
  else
    err "${label}: image ${image} baked ${actual:-unreadable}, expected ${expected}"
    FAILURES=$(( FAILURES + 1 ))
  fi
}

KERNEL_EXPECTED="${KERNEL_REF:-b1420c4af6ed8b2510140418e5138d282365f9c6}"
INDEXER_EXPECTED="${INDEXER_REF:-56561b2f5cf5c6839f678257fc69bed1a8b9ba2c}"
SOLVER_EXPECTED="${SOLVER_REF:-b1420c4af6ed8b2510140418e5138d282365f9c6}"
AA_EXPECTED="${AA_REF:-713a20215f33e02904ea5bd699b7de7f76562e1b}"
UMBRA_EXPECTED="${UMBRA_REF:-5a46348585ae23994cc408a06f6ef18a78b06273}"
FRONTEND_EXPECTED="${FRONTEND_REF:-332503c8f9216143a8c805f2a0acbcfd39e5a21d}"

if present indexer; then
  assert_pin indexer "${INDEXER_IMAGE:-midnight-2-offers/indexer:local}" /opt/indexer-standalone/.indexer-commit "$INDEXER_EXPECTED"
fi

if present kernel; then
  assert_pin kernel "${KERNEL_IMAGE:-midnight-2-offers/offerfiles-kernel:local}" /app/.kernel-commit "$KERNEL_EXPECTED"
fi
if present solver; then
  assert_pin solver "${SOLVER_IMAGE:-midnight-2-offers/cow-solver:local}" /app/.solver-commit "$SOLVER_EXPECTED"
  assert_pin solver-kernel-base "${SOLVER_IMAGE:-midnight-2-offers/cow-solver:local}" /app/.kernel-commit "$KERNEL_EXPECTED"
fi
if present aa-deploy; then
  assert_pin aa "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" /aa/.aa-commit "$AA_EXPECTED"
  assert_pin aa-offerfiles-contract "${AA_IMAGE:-midnight-2-offers/aa-contracts:local}" /aa/.kernel-commit "$KERNEL_EXPECTED"
fi
if present aa-console; then
  assert_pin aa-console "${AA_CONSOLE_IMAGE:-midnight-2-offers/aa-contracts:console}" /aa/.aa-commit "$AA_EXPECTED"
fi
if present evm-rpc; then
  assert_pin umbra-evm "${EVM_IMAGE:-midnight-2-offers/umbra-evm:local}" /app/.umbra-commit "$UMBRA_EXPECTED"
fi
if present frontend; then
  assert_pin zswap-da "${FRONTEND_IMAGE:-midnight-2-offers/zswap-da:local}" /.zswap-da-commit "$FRONTEND_EXPECTED"
fi

if (( FAILURES == 0 )); then
  ok "source provenance assertions passed"
  exit 0
fi
err "${FAILURES} source provenance assertion(s) failed"
exit 1
