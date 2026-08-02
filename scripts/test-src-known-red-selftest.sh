#!/usr/bin/env bash
# scripts/test-src-known-red-selftest.sh — kobo-472: proves
# test-src-known-red-check.mjs's BEHAVIOR against constructed fixtures, never
# reading the checker's own source — a mutant that keeps the guard's text
# intact but neutralizes its effect (kobo-445's exact shape) wouldn't be
# caught by a check that reads source text; this only trusts the real exit
# code + stderr the script actually produces.
#
# Design ported from kobo-472's earlier PR (#326, stitch) — this exact
# fixture set already covers the required behaviors (exact match, new
# failure, expired entry, missing owner); no reason to redesign it.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
assert_exit() {
  local desc="$1" expect_rc="$2" log="$3" allow="$4"
  set +e
  OUT="$(bun scripts/test-src-known-red-check.mjs "$log" "$allow" 2>&1)"
  RC=$?
  set -e
  echo "--- $desc (exit $RC) ---"
  echo "$OUT"
  if [[ "$RC" -ne "$expect_rc" ]]; then
    echo "FAIL: $desc — expected exit $expect_rc, got $RC" >&2
    FAIL=1
  fi
}

assert_stderr_contains() {
  local desc="$1" needle="$2" log="$3" allow="$4"
  set +e
  OUT="$(bun scripts/test-src-known-red-check.mjs "$log" "$allow" 2>&1)"
  set -e
  if [[ "$OUT" != *"$needle"* ]]; then
    echo "FAIL: $desc — expected output to contain: $needle" >&2
    FAIL=1
  fi
}

# fixture: a captured bun-test-output log with exactly one failing test,
# shaped like bun's REAL raw output — an inline "(fail) ..." line
# interleaved with passes, not a synthesized end-of-run recap block (that
# recap doesn't exist in bun's own stdout).
cat > "$WORK/log-one-fail.txt" <<'EOF'
some earlier output
(pass) an unrelated passing test
(fail) known flaky thing (kobo-999) > it breaks [12.00ms]
(pass) another unrelated passing test

 40 pass
 1 fail
Ran 41 tests across 3 files. [1.00s]
EOF

cat > "$WORK/log-all-green.txt" <<'EOF'
some earlier output

 41 pass
 0 fail
Ran 41 tests across 3 files. [1.00s]
EOF

cat > "$WORK/allow-exact.json" <<'EOF'
[{"test": "known flaky thing (kobo-999) > it breaks", "card": "kobo-999", "owner": "someone"}]
EOF
assert_exit "exact match (1 known fail, allowlist has exactly that 1)" 0 "$WORK/log-one-fail.txt" "$WORK/allow-exact.json"

cat > "$WORK/allow-empty.json" <<'EOF'
[]
EOF
assert_exit "unexpected new failure, empty allowlist" 1 "$WORK/log-one-fail.txt" "$WORK/allow-empty.json"
assert_stderr_contains "unexpected new failure names itself NEW FAILURE" "NEW FAILURE" "$WORK/log-one-fail.txt" "$WORK/allow-empty.json"

# the bidirectional half — an allowlisted test that now PASSES must fail the
# gate too, not silently stay green (a one-directional list only ever grows).
assert_exit "allowlisted test now passes (all green run)" 1 "$WORK/log-all-green.txt" "$WORK/allow-exact.json"
assert_stderr_contains "expired entry names itself EXPIRED, not a regression" "EXPIRED" "$WORK/log-all-green.txt" "$WORK/allow-exact.json"

cat > "$WORK/allow-no-owner.json" <<'EOF'
[{"test": "known flaky thing (kobo-999) > it breaks", "card": "kobo-999"}]
EOF
assert_exit "allowlist entry missing owner is rejected outright" 2 "$WORK/log-one-fail.txt" "$WORK/allow-no-owner.json"

if [[ "$FAIL" -ne 0 ]]; then
  echo "" >&2
  echo "FAIL: kobo-472 known-red-check selftest" >&2
  exit 1
fi
echo "PASS: test-src-known-red-check behaves correctly on exact-match, new-failure, expired-entry, and missing-owner fixtures"
