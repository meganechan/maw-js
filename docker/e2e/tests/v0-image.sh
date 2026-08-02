#!/bin/bash
# v0 — image prerequisites. Nothing else works until every one of these holds,
# so they are asserted rather than assumed. Each check names the code that breaks
# when it fails; a green line here is a claim about that specific code path.
set -uo pipefail

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo "v0 — image prerequisites"

# The blocker: command-logic.ts:247-250 strips --dangerously-skip-permissions
# when getuid() === 0, so under root every agent launch silently loses its
# autonomy flag and hangs waiting for an interactive permission answer.
check "runs as non-root (command-logic.ts:247)" '[ "$(id -u)" -ne 0 ]'

# The two Linux paths alpine's busybox breaks. Asserted by running them, not by
# checking which base image is in the FROM line — the FROM line is not what the
# code calls.
check "script -qfc works (pty.ts:258-268)" \
  'script -qfc "echo probe" /dev/null | grep -q probe'
check "ps -eo works (claude-sessions.ts:64,96)" \
  'ps -eo pid,args | grep -q .'

check "tmux present" 'tmux -V'
check "jq present (statusline presence hook)" 'jq --version'
check "git present (plugin bootstrap)" 'git --version'

check "maw runs" 'maw --version'
check "kobo runs" 'kobo ls'

# Cell contracts must exist on disk or self-spawn hard-fails before a single pane
# is created (cell/spawn.ts:280-282).
for role in head worker reviewer; do
  check "cell contract $role.md (spawn.ts:280)" \
    "[ -s \"\$HOME/.claude/skills/cell/contracts/$role.md\" ]"
done

# MAW_HOME must sit under $HOME or the nonCanonicalRoot bootstrap guard fails
# OPEN (plugin-bootstrap.ts:189) and the sandbox exercises nothing.
check "MAW_HOME under \$HOME (plugin-bootstrap.ts:189)" \
  'case "$MAW_HOME" in "$HOME"/*) true ;; *) false ;; esac'

# Both env names, or the dir that gets populated is not the dir that gets read:
# bootstrap reads MAW_PLUGINS_DIR (cli.ts:47), install/profile/create read
# MAW_PLUGIN_HOME (plugins-install.ts:25).
check "MAW_PLUGINS_DIR == MAW_PLUGIN_HOME, both set" \
  '[ -n "$MAW_PLUGINS_DIR" ] && [ "$MAW_PLUGINS_DIR" = "$MAW_PLUGIN_HOME" ]'

# The documented trap: setting a per-kind var instead of MAW_HOME leaks pr-watch
# writes to the real ~/.maw/watch-pr-state.json (pr-watch.ts:43-58). Asserted as
# absence so that adding one later fails here instead of on someone's host.
for v in MAW_DATA_DIR MAW_STATE_DIR MAW_CONFIG_DIR MAW_CACHE_DIR; do
  check "$v unset (pr-watch.ts:43-58)" "[ -z \"\${$v:-}\" ]"
done

# The mounted checkout ships a committed kobo-board.db — the real board. The DB
# under test must not be that file.
check "kobo DB is not the mounted checkout's" \
  '[ "$KOBO_BOARD_ROOT" != "$KOBO_CHECKOUT" ] && [ -w "$KOBO_BOARD_ROOT" ]'
# Asserted by reading the mount flags, NOT by attempting a write. A write probe
# that unexpectedly SUCCEEDS leaves a file in the host's real checkout — the probe
# would cause the exact contamination it is meant to rule out.
check "kobo checkout mounted read-only" \
  'awk -v d="$KOBO_CHECKOUT" '"'"'$2 == d { print $4 }'"'"' /proc/mounts | grep -qw ro'

check "maw serve answers /api/plugins" \
  'curl -fsS "http://127.0.0.1:$MAW_PORT/api/plugins"'

check "stub pane is alive" \
  'tmux list-panes -t "$E2E_SESSION" | grep -q .'

echo "v0: $fails failure(s)"
exit $((fails > 0))
