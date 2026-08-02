#!/bin/bash
# crew worker Stop hook — deterministic completion signal (kobo-91 TEST2 deadlock fix)
# Fires on every turn end, but ONLY in panes spawned with CREW_ROLE=worker
# or CREW_ROLE=reviewer (kobo-204: reviewer pane needs the same deterministic
# idle signal so front records the verdict + tears it down without polling).
# (env gate = local-first: non-crew panes exit instantly, coord/lead unaffected).
# glob `worker*` matches bare "worker" (kobo-319 single-pane) AND any historical
# worker-N pane still running mid-migration — both must keep signaling idle.
case "$CREW_ROLE" in worker*|reviewer) ;; *) exit 0 ;; esac
[ -n "$CREW_COORD_PANE" ] || [ -n "$TMUX_PANE" ] || exit 0
# resolve notify target fresh from a stable pane-id (index shifts, pane-id doesn't).
# Cell v2 overrides @idle_notify_pane so worker/reviewer notify each other and do
# not spam head; legacy crew falls back to CREW_COORD_PANE (front/conductor).
TARGET_PANE=""
if [ -n "$TMUX_PANE" ]; then
  TARGET_PANE=$(tmux show-option -p -q -v -t "$TMUX_PANE" @idle_notify_pane 2>/dev/null || true)
fi
[ -n "$TARGET_PANE" ] || TARGET_PANE="$CREW_COORD_PANE"
[ -n "$TARGET_PANE" ] || exit 0
ADDR=$(tmux display-message -t "$TARGET_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
[ -z "$ADDR" ] && exit 0
# kobo-356's next-ready queue attachment (maw company task next-ready) was
# removed with the task system — the CLI verb no longer exists (taskd cutover).
MSG="[hook] $CREW_ROLE idle (turn end) — state: ${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md"
maw hey "$ADDR" "$MSG" >/dev/null 2>&1 &
exit 0
