#!/bin/bash
# RETIRED — this hook is NOT wired. It was dropped from HOOKS[] in
# src/core/worklog/hook-setup.ts, so `maw watch setup-hooks` no longer provisions it
# and no base64 copy of this file is embedded anywhere. That also means the
# byte-identity sync test in worklog.test.ts no longer covers this file: editing it
# changes nothing and is checked by nothing. Kept as the source of record so the hook
# can be revived by restoring the HOOKS entry — do not "fix" the missing sync test.
#
# Claude Code UserPromptSubmit hook → maw policy: inject company + dept policy
# back into context, but ONLY while the oracle is attached (server decides;
# detached → empty → nothing injected). Inject-only — no capture.

MAW_PORT="${MAW_PORT:-3456}"
BASE="http://localhost:${MAW_PORT}"
command -v jq >/dev/null 2>&1 || exit 0

ORACLE="${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && exit 0

INJECT=$(curl -s --max-time 2 "$BASE/api/policy?oracle=${ORACLE}" 2>/dev/null | jq -r '.inject // empty')
[ -z "$INJECT" ] && exit 0
jq -n --arg ctx "$INJECT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$ctx}}'
exit 0
