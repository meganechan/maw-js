#!/bin/bash
# Runs both phases and reports both, rather than stopping at the first failure —
# a v1 failure means something different depending on whether v0 was green.
set -uo pipefail

/home/maw/e2e/tests/v0-image.sh; v0=$?
echo
/home/maw/e2e/tests/v1-flow.sh;  v1=$?

echo
if [ $v0 -eq 0 ] && [ $v1 -eq 0 ]; then
  echo "e2e: PASS (v0 + v1)"
  exit 0
fi
echo "e2e: FAIL (v0=$v0 v1=$v1) — state in $E2E_STATE"
exit 1
