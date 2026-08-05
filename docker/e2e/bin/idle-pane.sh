#!/bin/sh
# kobo-835 — a pane that only does the two things v3 needs: show an idle prompt so
# the delivery gate lets a message through (comm-send.ts checkPaneIdle: the
# bottom-most line must match /^\s*[>❯›»]\s?(.*)$/ with an EMPTY capture), and
# write down what it received.
#
# NOT bin/stub-oracle.sh, which is the right tool for v1 and the wrong one here for
# two reasons: it truncates a single shared $E2E_STATE/received.log at startup, so
# the six panes v3 opens would erase each other's evidence (and v1's), and it runs
# kobo board verbs this phase has nothing to say about.
#
# POSIX sh on purpose — v3 launches one pane under `sh` and one under a shim named
# `node`, because resolveOraclePane picks the lowest AGENT pane index and the
# misroute being replayed landed on pane .1. `sh` is not an agent command; `node`
# is (core/agent-detect.ts GENERIC_AGENT_PROCESS_NAMES).
#
#   idle-pane.sh <received-log>

set -u
LOG="${1:?usage: idle-pane.sh <received-log>}"
: >"$LOG"

while :; do
  printf '❯ '
  IFS= read -r line || break
  case "$line" in
    *[!\ ]*) printf '%s\n' "$line" >>"$LOG" ;;
    *) : ;;
  esac
done
