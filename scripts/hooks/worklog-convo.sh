#!/bin/bash
# Claude Code UserPromptSubmit hook → maw worklog.
#   capture: record the decision/instruction ("Tony→oracle: X")
#   inject:  read-before-act — push company state + open claims back into context
# Provisioned by `maw watch setup-hooks`.

MAW_PORT="${MAW_PORT:-3456}"
BASE="http://localhost:${MAW_PORT}"
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty')

ORACLE="${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && ORACLE="unknown"
PROJECT=$(basename "${PWD}" 2>/dev/null)

# capture (fire-and-forget)
if [ -n "$PROMPT" ]; then
  CAP=$(jq -n --arg o "$ORACLE" --arg p "$PROJECT" --arg pr "$PROMPT" \
    '{oracle:$o, event:"UserPromptSubmit", project:$p, host:"local", message:"prompt", data:{prompt:$pr}}')
  curl -s -X POST "$BASE/api/feed" -H 'Content-Type: application/json' -d "$CAP" >/dev/null 2>&1 &
fi

# inject (read-before-act) — short timeout so a slow/absent server never blocks the agent
INJECT=$(curl -s --max-time 2 "$BASE/api/worklog?oracle=${ORACLE}" 2>/dev/null | jq -r '.inject // empty')
[ -z "$INJECT" ] && exit 0
jq -n --arg ctx "$INJECT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$ctx}}'
exit 0
