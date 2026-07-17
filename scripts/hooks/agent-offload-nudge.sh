#!/bin/bash
# Claude Code PostToolUse(Agent) hook — nudge to offload a LONG foreground sub-agent.
# kobo-337: a foreground (blocking) Agent call ties up the pane for its whole run; the
# offload guidance (kobo-317/320/321) says heavy/long/parallel work should pass
# run_in_background:true. This is the structural reminder. `duration_ms` is in the
# PostToolUse payload (real elapsed for a fg call; ~detach-time for a bg call), so a
# foreground Agent that blocked past THRESHOLD gets nudged. bg calls self-exclude twice:
# the run_in_background flag AND a tiny detach duration. Reactive by design — duration is
# only knowable after the call (no pre-run signal exists); the nudge teaches the next call.
# Provisioned to $HOME/.config/maw/hooks/agent-offload-nudge.sh by `maw company worklog setup-hooks`.

command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat)

# Only the sub-agent tool (renamed Agent, was Task). The matcher already narrows; re-check.
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Agent" ] || [ "$TOOL" = "Task" ] || exit 0

# Already offloaded → nothing to nudge.
BG=$(printf '%s' "$INPUT" | jq -r '.tool_input.run_in_background // false')
[ "$BG" = "true" ] && exit 0

# duration_ms is provided by CC 2.1.x. Missing / non-numeric → no nudge, never crash.
DUR=$(printf '%s' "$INPUT" | jq -r '.duration_ms // 0')
case "$DUR" in '' | *[!0-9]*) exit 0 ;; esac

THRESHOLD_MS="${MAW_AGENT_NUDGE_MS:-45000}" # knob (default 45s)
[ "$DUR" -le "$THRESHOLD_MS" ] && exit 0

SECS=$((DUR / 1000))
MSG="offload nudge: that foreground Agent blocked this pane ~${SECS}s. For heavy/long/parallel sub-agent work, pass run_in_background:true — you keep working while it runs and get a completion notification (kobo-317/320/321)."
jq -n --arg m "$MSG" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$m}}'
exit 0
