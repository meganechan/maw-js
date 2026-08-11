#!/bin/bash
# Runs every phase and reports all of them, rather than stopping at the first
# failure — a later failure means something different depending on whether the
# phases before it were green.
set -uo pipefail

/home/maw/e2e/tests/v0-image.sh; v0=$?
echo
/home/maw/e2e/tests/v1-flow.sh;  v1=$?
echo
/home/maw/e2e/tests/v2-dispatchd.sh; v2=$?
echo
# Last on purpose: v3 renames this node to m5 and opens colliding sessions, both
# of which would change what the phases above are testing.
/home/maw/e2e/tests/v3-hey-targeting.sh; v3=$?

echo
if [ $v0 -eq 0 ] && [ $v1 -eq 0 ] && [ $v2 -eq 0 ] && [ $v3 -eq 0 ]; then
  echo "e2e: PASS (v0 + v1 + v2 + v3)"
  exit 0
fi
echo "e2e: FAIL (v0=$v0 v1=$v1 v2=$v2 v3=$v3) — state in $E2E_STATE"
exit 1
