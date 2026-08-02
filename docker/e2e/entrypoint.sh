#!/bin/bash
# PID 1 for the e2e sandbox. Dumb and sequential on purpose — each step is a
# precondition for the next, so a failure must stop the run rather than race it.
set -euo pipefail

log() { printf '[e2e] %s\n' "$*" >&2; }

mkdir -p "$E2E_STATE" "$KOBO_BOARD_ROOT"

# 1. maw config. `node` has no default and cmdSend throws without it
#    (comm-send.ts:1813) — after the message has already landed, so a missing
#    node looks like "delivered but failed". --force makes this idempotent.
log "maw init (node=$E2E_NODE)"
maw init --non-interactive --node "$E2E_NODE" --force >"$E2E_STATE/init.log" 2>&1

# 2. tmux server, inside the container, on the default socket.
#    NOT a bind-mount of the host socket: tmux enforces socket-dir ownership, and
#    mounting the host's socket would recreate the exact blast radius this sandbox
#    removes. -f /dev/null so no user tmux.conf can change pane behaviour.
#
#    Session/window are named to the fleet convention (01-<oracle> / <oracle>-oracle)
#    so `maw hey <oracle>` has a chance to resolve by name; tests/v1-flow.sh falls
#    back to the exact tmux address, which needs no naming convention at all.
log "tmux session $E2E_SESSION (window ${E2E_ORACLE}-oracle)"
tmux -f /dev/null new-session -d -s "$E2E_SESSION" -n "${E2E_ORACLE}-oracle" \
  /home/maw/e2e/bin/stub-oracle.sh

# Give the stub time to paint its first prompt. The send path gates on seeing an
# idle prompt (comm-send.ts:761-803); an empty pane defers the message instead of
# delivering it, which would read as a flow failure rather than a race.
for _ in $(seq 1 50); do
  tmux capture-pane -t "$E2E_SESSION" -p 2>/dev/null | grep -q '❯' && break
  sleep 0.1
done

# 3. maw serve. Port goes positionally AND in the env: the CLI passes a literal
#    3456 when there is no positional arg (cli/route-tools.ts:405), while
#    pr-watch's feed POST reads MAW_PORT. A mismatch is silent, not an error.
#    Left on the default loopback bind — everything that talks to it lives in this
#    container. MAW_HOST is deliberately NOT set: the same var also switches
#    hostExec from `bash -c` to `ssh` (core/transport/ssh.ts:86).
log "maw serve $MAW_PORT"
maw serve "$MAW_PORT" >"$E2E_STATE/serve.log" 2>&1 &

for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:$MAW_PORT/api/plugins" >/dev/null 2>&1 && break
  sleep 0.2
done

log "ready — handing off to: $*"
exec "$@"
