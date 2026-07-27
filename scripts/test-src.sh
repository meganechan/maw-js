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
bash scripts/test-default-safe.sh "${FILES[@]}"
