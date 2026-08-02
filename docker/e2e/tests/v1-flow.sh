#!/bin/bash
# v1 — the real flow, every step through code that ships:
#
#   kobo task add          card on the real board, through taskd's socket
#     -> task dispatch     writes an outbox row (state=queued)
#       -> task dispatch-run   drains it and shells out to `maw hey` (cli.ts:201)
#         -> maw           real target resolution, real idle gate, real send-keys
#           -> stub pane   parses the dispatch JSON, runs `kobo task start`
#             -> assert    BOTH halves: the card's lane AND the outbox row state
#
# Nothing is mocked except the agent's judgement.
set -uo pipefail

CARD="e2e-flow-1"
RECEIVED="$E2E_STATE/received.log"
fails=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

# One read answers both halves: `task show --json` returns the card row with its
# outbox rows attached under .dispatches (kobo cli.ts:441-447).
show()        { kobo task show "$CARD" --json 2>/dev/null; }
lane_of()     { show | jq -r '.lane'; }
dispatch_of() { show | jq -r '.dispatches[0].state // "none"'; }

echo "v1 — add -> dispatch -> dispatch-run -> maw hey -> pane -> start"

kobo task add "$CARD" --title "e2e sandbox flow" --assignee "$E2E_ORACLE" \
  >"$E2E_STATE/add.log" 2>&1 \
  && ok "card created" || bad "card created (see add.log)"

# dispatch refuses anything but lane=todo with an assignee (db.ts:835-836), so this
# doubles as the precondition check for the step after it.
[ "$(lane_of)" = "todo" ] && ok "starts in todo" || bad "starts in todo (got '$(lane_of)')"

kobo task dispatch "$CARD" --json >"$E2E_STATE/dispatch.json" 2>&1 \
  && ok "dispatch intent written" || bad "dispatch intent written (see dispatch.json)"

# Queued before the drain — the negative half of the delivered assert below. Without
# it, "delivered" could just mean the row was never anything else.
q="$(jq -r '.state // "none"' "$E2E_STATE/dispatch.json" 2>/dev/null)"
[ "$q" = "queued" ] && ok "outbox row starts queued" || bad "outbox row starts queued (got '$q')"

kobo task dispatch-run --json >"$E2E_STATE/dispatch-run.json" 2>&1 \
  && ok "dispatch-run drained" || bad "dispatch-run drained (see dispatch-run.json)"

# kobo picks the target itself — the card's bare assignee name (cli.ts:150,201), not
# anything this test controls. So `maw hey stub` has to resolve against the fleet
# naming convention the entrypoint sets up (session 01-stub, window stub-oracle).
# That makes an unresolved target the most likely failure here, which is why the
# drain's own reason string is surfaced rather than just the mode.
r="$(jq -r --arg c "$CARD" '[.results[] | select(.cardId == $c)] | first
       | if .mode == "dispatched" then .mode else "\(.mode // "none"): \(.reason // "?")" end' \
      "$E2E_STATE/dispatch-run.json" 2>/dev/null)"
[ "$r" = "dispatched" ] \
  && ok "drain reports dispatched" \
  || bad "drain reports dispatched (got '$r')"

# Poll the stub's marker, not the board: the marker is written only after the board
# verb returns, so it separates "the pane never got the message" from "the pane got
# it and the verb failed" — two failures that look identical from the lane alone.
for _ in $(seq 1 60); do
  grep -q "HANDLED $CARD" "$RECEIVED" 2>/dev/null && break
  sleep 0.5
done

grep -q "$CARD" "$RECEIVED" 2>/dev/null \
  && ok "pane received the dispatch payload" \
  || bad "pane received the dispatch payload (no card id in received.log — delivery, not the verb)"
grep -q "HANDLED $CARD" "$RECEIVED" 2>/dev/null \
  && ok "pane ran its board verb" \
  || bad "pane ran its board verb (see stub-kobo.log)"

# Half 1 — the card moved, and only its assignee could have moved it: taskd rejects
# `start` unless actor == assignee (runtime/server.ts:284-287).
[ "$(lane_of)" = "doing" ] \
  && ok "card lane -> doing" \
  || bad "card lane -> doing (lane='$(lane_of)')"

# Half 2 — the outbox row reached delivered, which is set only on a zero-status
# `maw hey` (kobo cli.ts:202-204).
[ "$(dispatch_of)" = "delivered" ] \
  && ok "outbox row -> delivered" \
  || bad "outbox row -> delivered (state='$(dispatch_of)')"

echo "v1: $fails failure(s)"
exit $((fails > 0))
