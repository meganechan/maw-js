#!/usr/bin/env bash
# test-src.sh — kobo-472: runs the src/ test set through the known-red
# allowlist gate. Discovery + the git-ls-files/find completeness guard live
# INSIDE test-default-safe.sh (--src mode) — kobo-499's own guard extended to
# watch src/ the same way it already watches test/, not a second copy of that
# logic here (AC's own instruction: extend the guard, don't just widen a glob
# next to it).
#
# Known-red (Tony-approved direction, kobo-472 "path 3"): a small NAMED set
# of already-known-broken tests (scripts/test-src-known-red.json, each entry
# owned by a card) doesn't block this job on every one of them being fixed
# first. The gate is checked in BOTH directions (scripts/test-src-known-red-check.mjs):
# a NEW unlisted failure fails loudly, and a listed test that now PASSES
# fails loudly too ("remove this line", not "investigate a phantom
# regression") — a one-directional allowlist only ever grows, which is the
# exact silent-graveyard failure class this whole card exists to close.
set -eo pipefail
cd "$(dirname "$0")/.."

RUN_LOG="$(mktemp)"
trap 'rm -f "$RUN_LOG"' EXIT
set +e
bash scripts/test-default-safe.sh --src 2>&1 | tee "$RUN_LOG"
set -e

bun scripts/test-src-known-red-check.mjs "$RUN_LOG" scripts/test-src-known-red.json
