#!/usr/bin/env bash
# test-src.sh — kobo-472: test-default-safe.sh only discovers test/*.ts, and
# test:plugin only src/commands/plugins/. Every OTHER *.test.ts under src/ was
# never wired into CI. This discovers that set and reuses
# test-default-safe.sh's existing per-file mock.module() isolation on it
# (explicit file args, see its REQUESTED_FILES mode) instead of duplicating
# that logic.
set -eo pipefail
cd "$(dirname "$0")/.."

FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && FILES+=("$f")
done < <(git ls-files -- 'src/**/*.test.ts' ':!:src/commands/plugins/**' | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "error: no src/ test files matched (kobo-472 discovery glob broke?)" >&2
  exit 2
fi

# kobo-472 "path 3" (Tony-approved): src/ carries a small, NAMED set of
# already-known-broken tests (each with its own owning card — see
# test-src-known-red.json). Without this, this job can never go green until
# every one of those is individually fixed, which is not how Tony wants CI
# red communicated. Requires test-default-safe.sh to run every file
# regardless of an earlier failure (kobo-531) — otherwise a shared-sweep
# failure would hide the mock-isolated files behind `set -e` and this gate
# would be judging on incomplete results.
RUN_LOG="$(mktemp)"
trap 'rm -f "$RUN_LOG"' EXIT
set +e
bash scripts/test-default-safe.sh "${FILES[@]}" 2>&1 | tee "$RUN_LOG"
set -e

bun scripts/test-src-known-red-check.mjs "$RUN_LOG" scripts/test-src-known-red.json
