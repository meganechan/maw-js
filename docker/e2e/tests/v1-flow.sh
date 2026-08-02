#!/bin/bash
# v1 — the flow that actually exists end to end today:
#
#   kobo add            create a card on a real SQLite board
#     -> maw hey        real target resolution, real idle gate, real tmux send-keys
#       -> stub pane    receives the payload and runs real board verbs
#         -> assert     the card's lane and holder moved in the store
#
# Nothing is mocked except the agent's judgement. What is NOT here is the kobo-side
# dispatch producer: `kobo task dispatch` / `dispatch-run` do not exist on
# kobo-board main, so this drives the send directly. See README.md, "Deviations".
set -uo pipefail

CARD="e2e-flow-1"
RECEIVED="$E2E_STATE/received.log"
fails=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

lane_of()   { kobo show "$CARD" 2>/dev/null | tail -n +2 | jq -r '.lane'; }
holder_of() { kobo show "$CARD" 2>/dev/null | tail -n +2 | jq -r '.holder'; }

echo "v1 — card -> dispatch -> pane -> board verb -> lane"

kobo add "$CARD" --title "e2e sandbox flow" --assignee "$E2E_ORACLE" --lane todo \
  >"$E2E_STATE/add.log" 2>&1 \
  && ok "card created" || bad "card created"

[ "$(lane_of)" = "todo" ] && ok "starts in todo" || bad "starts in todo (got '$(lane_of)')"

# Two target forms. The name form is the realistic dispatch path and depends on the
# fleet naming convention; the exact tmux address needs no convention at all
# (routing.ts:85) and only requires the session to exist. Trying the name first
# and recording which one worked keeps a convention change visible instead of
# turning it into a silent fallback.
PAYLOAD="E2E-DISPATCH $CARD"
SENDER="$E2E_NODE:harness"
if maw hey "$E2E_ORACLE" "$PAYLOAD" --from "$SENDER" >"$E2E_STATE/hey.log" 2>&1; then
  ok "dispatched by oracle name ('$E2E_ORACLE')"
elif maw hey "$E2E_SESSION:${E2E_ORACLE}-oracle.0" "$PAYLOAD" --from "$SENDER" \
     >>"$E2E_STATE/hey.log" 2>&1; then
  ok "dispatched by exact tmux address (name form did NOT resolve)"
else
  bad "dispatch — neither target form resolved (see hey.log)"
fi

# Poll the stub's marker, not the board: the marker is written only after both
# board verbs return, so it separates "the pane never got the message" from "the
# pane got it and the verbs failed" — two failures that look identical if you
# only ever look at the lane.
for _ in $(seq 1 60); do
  grep -q "HANDLED $CARD" "$RECEIVED" 2>/dev/null && break
  sleep 0.5
done

if grep -q "$CARD" "$RECEIVED" 2>/dev/null; then
  ok "pane received the payload"
else
  bad "pane received the payload (received.log empty — delivery, not the verbs)"
fi
grep -q "HANDLED $CARD" "$RECEIVED" 2>/dev/null \
  && ok "pane ran its board verbs" \
  || bad "pane ran its board verbs (see stub-kobo.log)"

[ "$(holder_of)" = "$E2E_ORACLE" ] \
  && ok "claimed by $E2E_ORACLE" \
  || bad "claimed by $E2E_ORACLE (holder='$(holder_of)')"
[ "$(lane_of)" = "doing" ] \
  && ok "lane moved to doing" \
  || bad "lane moved to doing (lane='$(lane_of)')"

echo "v1: $fails failure(s)"
exit $((fails > 0))
