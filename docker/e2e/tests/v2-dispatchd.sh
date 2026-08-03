#!/bin/bash
# v2 — kobo-dispatchd (kobo-743). Same flow as v1 with one thing removed:
#
#   kobo task add --assignee     card + queued outbox row, through taskd's socket
#     -> kobo-dispatchd          the scheduler drains it on its own timer
#       -> maw hey               real target resolution, real idle gate, real send-keys
#         -> stub pane           parses the dispatch JSON, runs `kobo task start`
#           -> assert            lane AND outbox row state
#
# The removed thing is the point: `dispatch-run` appears nowhere below. If the
# scheduler is not draining, nothing in this file can hide it — the row stays
# queued and every assert after it fails.
#
# The daemon is started here rather than in entrypoint.sh on purpose: a
# scheduler running during v1 would drain v1's row before its manual
# dispatch-run got there, turning a green v1 into a false red.
set -uo pipefail

CARD="e2e-dispatchd-1"
RECEIVED="$E2E_STATE/received.log"
INTERVAL_MS=1000
fails=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

show()        { kobo task show "$CARD" --json 2>/dev/null; }
lane_of()     { show | jq -r '.lane'; }
dispatch_of() { show | jq -r '.dispatches[0].state // "none"'; }

echo "v2 — add --assignee -> kobo-dispatchd -> maw hey -> pane -> start (no dispatch-run)"

# The pm2 app's script, not dispatchd.ts: the entry file is guard-free because
# PM2's ProcessContainerFork makes `import.meta.main` false, and a guard there
# would leave the process "online" while draining nothing.
KOBO_DISPATCH_INTERVAL_MS="$INTERVAL_MS" \
  bun "$KOBO_REPO/src/runtime/dispatch-main.ts" >"$E2E_STATE/dispatchd.log" 2>&1 &
dispatchd_pid=$!
trap 'kill "$dispatchd_pid" 2>/dev/null' EXIT

for _ in $(seq 1 50); do
  grep -q kobo-dispatchd-started "$E2E_STATE/dispatchd.log" 2>/dev/null && break
  sleep 0.1
done
grep -q kobo-dispatchd-started "$E2E_STATE/dispatchd.log" \
  && ok "daemon started (guard-free entry printed its line)" \
  || bad "daemon started (see dispatchd.log)"

# Honoring the override matters here beyond speed: a daemon silently falling
# back to the 30s default would still pass the delivery assert below, just
# slower — and the sandbox would be proving the default, not the knob.
i="$(jq -r '.intervalMs // "none"' <"$E2E_STATE/dispatchd.log" 2>/dev/null | head -1)"
[ "$i" = "$INTERVAL_MS" ] && ok "interval override honored ($i ms)" || bad "interval override honored (got '$i')"

# --assignee is the whole trigger: it enqueues the outbox row at add time.
kobo task add "$CARD" --title "e2e dispatchd flow" --assignee "$E2E_ORACLE" \
  >"$E2E_STATE/v2-add.log" 2>&1 \
  && ok "card created" || bad "card created (see v2-add.log)"

[ "$(lane_of)" = "todo" ] && ok "starts in todo" || bad "starts in todo (got '$(lane_of)')"

# Poll the outbox row, not the clock: at a 1s interval this is normally one or
# two passes, and a fixed sleep would either flake or waste 30s.
for _ in $(seq 1 60); do
  case "$(dispatch_of)" in delivered|failed) break ;; esac
  sleep 0.5
done

[ "$(dispatch_of)" = "delivered" ] \
  && ok "outbox row -> delivered with no dispatch-run" \
  || bad "outbox row -> delivered with no dispatch-run (state='$(dispatch_of)', see dispatchd.log)"

for _ in $(seq 1 60); do
  grep -q "HANDLED $CARD" "$RECEIVED" 2>/dev/null && break
  sleep 0.5
done

grep -q "$CARD" "$RECEIVED" 2>/dev/null \
  && ok "pane received the dispatch payload" \
  || bad "pane received the dispatch payload (no card id in received.log — delivery, not the verb)"

[ "$(lane_of)" = "doing" ] \
  && ok "card lane -> doing" \
  || bad "card lane -> doing (lane='$(lane_of)')"

echo "v2: $fails failure(s)"
exit $((fails > 0))
