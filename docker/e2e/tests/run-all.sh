#!/bin/bash
# Runs every phase and reports all of them, rather than stopping at the first
# failure — a later failure means something different depending on whether the
# phases before it were green.
#
# v1 (kobo flow) and v2 (kobo-dispatchd) USED TO RUN HERE and are gone — kobo-971,
# 2026-08-17. They had been failing at their first command for as long as kobo has
# required `--kind` on `task add`, while still printing phase names and reading
# like a suite that ran. A measuring tool that fails silently is worse than no
# tool: whoever ran this got output shaped like a test result that tested nothing.
#
# They are not repaired here, on purpose. kobo's e2e now lives in kobo's own repo,
# where a kobo contract change breaks it in kobo's own CI on the same commit:
#
#     meganechan/kobo-board  scripts/e2e.sh      (merged in #246, kobo-971)
#
# What this sandbox still owns is maw's half — the image contract (v0) and hey
# target resolution (v3). Do not add a kobo flow phase back here; add it there.
set -uo pipefail

/home/maw/e2e/tests/v0-image.sh; v0=$?
echo
# Last on purpose: v3 renames this node to m5 and opens colliding sessions, both
# of which would change what any phase above it is testing.
/home/maw/e2e/tests/v3-hey-targeting.sh; v3=$?

echo
echo "kobo flow coverage is NOT in this suite — meganechan/kobo-board scripts/e2e.sh (kobo-971)"
if [ $v0 -eq 0 ] && [ $v3 -eq 0 ]; then
  echo "e2e: PASS (v0 + v3)"
  exit 0
fi
echo "e2e: FAIL (v0=$v0 v3=$v3) — state in $E2E_STATE"
exit 1
