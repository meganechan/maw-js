#!/usr/bin/env bash
# scripts/test-default-safe-selftest.sh — kobo-531: prove test-default-safe.sh
# runs every declared case even when an earlier one fails, instead of
# `set -e` bailing out right after the first red file and silently skipping
# whatever was still queued.
#
# Before the fix: the shared sweep failing hard-exits the script via `set -e`
#                  — the mock-isolated cases queued after it never execute at
#                  all (only reported as "NEVER RAN" by the kobo-476 EXIT
#                  trap, which only reports the skip, never prevents it).
#                  This script FAILS.
# After the fix:   every case still runs to completion regardless of an
#                  earlier case's outcome, and the script's own exit code
#                  still reflects the failure. This script PASSES.
#
# Isolation: synthetic *.test.ts fixtures are written to a private tmpdir
# and passed as explicit file args (REQUESTED_FILES mode) — nothing here
# touches the real test suite.

set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURES="$(mktemp -d)"
OUT="$(mktemp)"
cleanup() { rm -rf "$FIXTURES" "$OUT"; }
trap cleanup EXIT

cat > "$FIXTURES/plain-fail.test.ts" <<'EOF'
import { test, expect } from "bun:test";
// kobo-531 selftest fixture — deliberately red, so the shared sweep has a
// real failure to trip on (AC1: "make the first file red for real").
test("kobo-531 selftest: deliberate failure", () => {
  expect(1).toBe(2);
});
EOF

cat > "$FIXTURES/mock-a.test.ts" <<'EOF'
import { test, expect, mock } from "bun:test";
mock.module("node:os", () => ({ hostname: () => "kobo-531-selftest-a" }));
test("kobo-531 selftest: mock-isolated file a still runs", () => {
  expect(true).toBe(true);
});
EOF

cat > "$FIXTURES/mock-b.test.ts" <<'EOF'
import { test, expect, mock } from "bun:test";
mock.module("node:os", () => ({ hostname: () => "kobo-531-selftest-b" }));
test("kobo-531 selftest: mock-isolated file b still runs", () => {
  expect(true).toBe(true);
});
EOF

set +e
bash scripts/test-default-safe.sh \
  "$FIXTURES/plain-fail.test.ts" \
  "$FIXTURES/mock-a.test.ts" \
  "$FIXTURES/mock-b.test.ts" \
  > "$OUT" 2>&1
RC=$?
set -e

echo "--- captured test-default-safe.sh output (exit $RC) ---"
cat "$OUT"
echo "--- end captured output ---"

FAIL=0

# AC1: the shared sweep (containing plain-fail.test.ts) must actually fail —
# a zero exit here means the deliberate failure above didn't even run.
if [[ "$RC" -eq 0 ]]; then
  echo "FAIL: expected a non-zero exit (plain-fail.test.ts should fail the shared sweep), got 0" >&2
  FAIL=1
fi

# AC2: both mock-isolated files must have ACTUALLY STARTED (not just been
# reported as skipped) — look for each one's own "--- <path> ---" marker,
# which test-default-safe.sh only prints right before it invokes that case.
if ! grep -q -- "--- $FIXTURES/mock-a.test.ts ---" "$OUT"; then
  echo "FAIL: mock-a.test.ts case never started — a later case is still being skipped after an earlier failure" >&2
  FAIL=1
fi
if ! grep -q -- "--- $FIXTURES/mock-b.test.ts ---" "$OUT"; then
  echo "FAIL: mock-b.test.ts case never started" >&2
  FAIL=1
fi
if grep -q "NEVER RAN" "$OUT"; then
  echo "FAIL: output still reports cases as NEVER RAN — the early-exit-and-report behavior is still active, not fixed" >&2
  FAIL=1
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "" >&2
  echo "FAIL: kobo-531 selftest — test-default-safe.sh still stops at the first red case" >&2
  exit 1
fi

echo "PASS: shared-sweep failure surfaced (exit $RC) AND both mock-isolated cases still ran to completion"
