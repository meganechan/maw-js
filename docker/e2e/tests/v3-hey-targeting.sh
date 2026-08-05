#!/bin/bash
# v3 — hey target resolution, on a topology built to collide (kobo-835).
#
# Every other phase asks "does the flow work". This one asks the opposite: when
# names collide, does the system say so, or does it pick one and report success?
# It fires REAL `maw hey` at REAL tmux panes, which is why it can only run in
# here — maw does not control the tmux socket (no TMUX_TMPDIR anywhere in the
# tree), so the same test on the host types into whichever live oracle happens to
# match. The container has its own tmux server and its own MAW_HOME; step 0
# checks that rather than assuming it.
#
# Topology (all built below, all deliberate):
#
#   13-patchwork      :0 helm-notes        2 panes: .0 sh (not an agent), .1 node (agent)
#                     :1 patchwork-oracle
#   20-twin           :0 twin-oracle       ← two windows, same name
#                     :1 twin-oracle
#   patchwork-oracle  :0 notes             ← session name == 13-patchwork:1's window name
#
# The replay: `m5:helm` resolves to no session or window called helm, falls to
# findWindow's cross-session SUBSTRING pass, and the only thing on the machine
# containing "helm" is patchwork's notes window. Delivered, reported green,
# landed on someone else's pane — which is what happened on m5 on 27 Jul.
set -uo pipefail

fails=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

STATE="$E2E_STATE/v3"
mkdir -p "$STATE"
AUDIT="$MAW_HOME/audit.jsonl"

echo "v3 — hey target resolution under deliberate name collisions"

# ─── 0. isolation ────────────────────────────────────────────────────────────
# Asserted, not assumed. A test that fires send-keys is only safe while these
# hold, so they are checked before anything is sent, and a failure here should
# read as "do not run the rest", not as one failed assertion among many.
case "$MAW_HOME" in
  /home/maw/*) ok "MAW_HOME is the container's ($MAW_HOME)" ;;
  *) bad "MAW_HOME is '$MAW_HOME' — refusing to send"; echo "v3: $fails failure(s)"; exit 1 ;;
esac

# maw writes audit through mawStatePath(), which honours MAW_HOME first
# (core/xdg.ts). Ask maw itself rather than trusting the env var twice.
resolved_audit="$(maw audit --since 1970-01-01 >/dev/null 2>&1; echo "$AUDIT")"
case "$resolved_audit" in
  /home/maw/*) ok "audit path under MAW_HOME ($AUDIT)" ;;
  *) bad "audit path escaped MAW_HOME: $resolved_audit" ;;
esac

# Nothing of the host's is mounted where maw or tmux would find it. The kobo
# clone is the one mount this sandbox has, and it is a throwaway clone made by
# run.sh, not a working checkout.
stray="$(awk '$2 ~ "^/home/maw" && $2 != "/home/maw/kobo-board-runtime" {print $2}' /proc/mounts)"
[ -z "$stray" ] \
  && ok "no host bind-mounts under /home/maw" \
  || bad "host paths mounted into the sandbox: $stray"

# tmux on the container's own default socket. A mounted host socket would put
# every send below into a live oracle's pane.
sock="$(tmux display-message -p '#{socket_path}' 2>/dev/null)"
case "$sock" in
  /tmp/tmux-*) ok "tmux server is the container's ($sock)" ;;
  *) bad "unexpected tmux socket '$sock' — refusing to send"; echo "v3: $fails failure(s)"; exit 1 ;;
esac

# ─── 1. node identity ────────────────────────────────────────────────────────
# `m5:helm` only reaches the self-node branch of resolveTarget when this node IS
# m5; otherwise it is an unknown-node error and the misroute never happens. On the
# machine where this happened, m5 was the node — so set the node, not an alias.
#
# Two traps, both hit while writing this phase, both left recorded here:
#   `maw init --non-interactive --node m5 --force` rewrites the config and leaves
#   `node` at its previous value, so it looks like it worked and does nothing.
#   The config dir holds a legacy `maw.config.json` AND weighted
#   `maw.config.NN.json` files; the weighted one wins, so editing the legacy file
#   puts the value on disk and not in loadConfig().
CONF="$(ls "$MAW_HOME"/config/maw.config.*.json 2>/dev/null | sort | tail -1)"
[ -n "$CONF" ] || CONF="$MAW_HOME/config/maw.config.json"
jq '.node = "m5"' "$CONF" >"$STATE/conf.json" && mv "$STATE/conf.json" "$CONF"

# Assert the LOADED value, not the written one: this fixture is the precondition
# for everything below, and a fixture that silently did not apply turns the whole
# phase into a green run that tested nothing.
loaded="$(cd "$MAW_CHECKOUT" && bun -e 'const {loadConfig} = await import("./src/config"); console.log(JSON.stringify(loadConfig().node ?? null))' 2>/dev/null | tail -1)"
[ "$loaded" = '"m5"' ] \
  && ok "node = m5 (loaded, from $(basename "$CONF"))" \
  || bad "node did not reach loadConfig() — got $loaded from $CONF"

# ─── 2. topology ─────────────────────────────────────────────────────────────
PANE=/home/maw/e2e/bin/idle-pane.sh
# A shim whose BASENAME is what tmux reports as pane_current_command: exec'ing
# /path/node sets the process comm to "node" regardless of what it links to.
# This is how pane .1 becomes the agent pane and .0 does not.
ln -sf /bin/sh "$STATE/node"

tmux new-session -d -s 13-patchwork -n helm-notes "sh $PANE $STATE/helm-notes.log"
tmux split-window -t 13-patchwork:0 "$STATE/node $PANE $STATE/helm-notes-p1.log"
tmux new-window  -t 13-patchwork -n patchwork-oracle "sh $PANE $STATE/patchwork-oracle-win.log"
tmux new-session -d -s 20-twin -n twin-oracle "sh $PANE $STATE/twin0.log"
tmux new-window  -t 20-twin -n twin-oracle "sh $PANE $STATE/twin1.log"
tmux new-session -d -s patchwork-oracle -n notes "sh $PANE $STATE/decoy.log"

# Panes must be painting their prompt before anything is sent: an unpainted pane
# fails the idle gate and the message defers, which would read as a routing
# failure rather than a race.
for _ in $(seq 1 50); do
  [ "$(tmux capture-pane -t 13-patchwork:0.1 -p 2>/dev/null | grep -c '❯')" -gt 0 ] && break
  sleep 0.1
done

twins="$(tmux list-windows -t 20-twin -F '#{window_name}' | grep -c '^twin-oracle$')"
[ "$twins" = "2" ] \
  && ok "two windows share the name twin-oracle" \
  || bad "two windows share the name twin-oracle (got $twins)"

tmux has-session -t patchwork-oracle 2>/dev/null \
  && tmux list-windows -t 13-patchwork -F '#{window_name}' | grep -qx 'patchwork-oracle' \
  && ok "session 'patchwork-oracle' collides with window '13-patchwork:1'" \
  || bad "session/window name collision not set up"

panes="$(tmux list-panes -t 13-patchwork:0 -F '#{pane_index} #{pane_current_command}' | tr '\n' ' ')"
case "$panes" in
  *"1 node"*) ok "13-patchwork:0 has an agent pane at .1 ($panes)" ;;
  *) bad "13-patchwork:0 pane layout wrong: $panes" ;;
esac

# ─── 3. the replay ───────────────────────────────────────────────────────────
audit_before="$(wc -l <"$AUDIT" 2>/dev/null || echo 0)"

maw hey m5:helm "kobo-835 replay" >"$STATE/hey-helm.log" 2>&1
helm_status=$?
if [ $helm_status -eq 0 ]; then
  ok "maw hey m5:helm reported success"
else
  # The container is --rm; a log file nobody can open is not evidence.
  bad "maw hey m5:helm exited $helm_status:"
  sed 's/^/          /' "$STATE/hey-helm.log"
fi

# The pane that should never have seen it, saw it. This is the misroute itself,
# not a proxy for it.
grep -q 'kobo-835 replay' "$STATE/helm-notes-p1.log" 2>/dev/null \
  && ok "message landed in 13-patchwork:0.1 — the misroute is reproduced" \
  || bad "message did not land in 13-patchwork:0.1 (nothing to measure)"

# The existing #1980 guard is silent here on purpose: it only fires for
# `-oracle`-suffixed intents (routing.ts detectWindowMismatch), and `m5:helm` is
# not one. Pinned, because "the warning did not fire" is the reason this card
# exists and a future change that makes it fire should have to notice this line.
grep -q 'may have landed on the' "$STATE/hey-helm.log" \
  && bad "detectWindowMismatch fired — this replay no longer demonstrates the silent case" \
  || ok "detectWindowMismatch stayed silent (the gap kobo-835 measures)"

# ─── 4. the audit row ────────────────────────────────────────────────────────
row="$(grep '"kind":"hey-route"' "$AUDIT" 2>/dev/null | tail -1)"
[ -n "$row" ] \
  && ok "a hey-route row was written" \
  || bad "no hey-route row in $AUDIT (audit had $audit_before lines before)"

check_field() {
  got="$(printf '%s' "$row" | jq -r ".$1 // \"\"" 2>/dev/null)"
  [ "$got" = "$2" ] && ok "row.$1 = $2" || bad "row.$1 = '$got' (want '$2')"
}
check_field query          "m5:helm"
check_field resolvedTarget "13-patchwork:0.1"
check_field resolvedWhere  "13-patchwork:helm-notes"
check_field resolvedBy     "node-prefix-self"
check_field route          "self-node"

# ─── 5. the instrument goes RED ──────────────────────────────────────────────
# The point of the phase. A verb that has only ever printed zero is a verb
# nobody has seen work.
maw hey-audit --since 1h --mismatch --json >"$STATE/mismatch.json" 2>&1
n="$(jq -r '.mismatches | length' "$STATE/mismatch.json" 2>/dev/null || echo 0)"
[ "$n" -ge 1 ] \
  && ok "hey-audit --mismatch is RED ($n)" \
  || bad "hey-audit --mismatch found nothing (see v3/mismatch.json)"
jq -e '.mismatches[] | select(.query == "m5:helm" and .resolvedTarget == "13-patchwork:0.1")' \
  "$STATE/mismatch.json" >/dev/null 2>&1 \
  && ok "the replayed send is the one it names" \
  || bad "hey-audit did not name the m5:helm row"

# ─── 6. negative control ─────────────────────────────────────────────────────
# A red light that is always on is a broken light. `stub` resolves to the oracle
# it names, through the same code path and the same audit row, and must come back
# green — otherwise step 5 proves nothing about mismatches specifically.
maw hey stub "kobo-835 control" >"$STATE/hey-stub.log" 2>&1 \
  && ok "maw hey stub reported success" \
  || bad "maw hey stub failed (see v3/hey-stub.log)"

ctrl="$(grep '"kind":"hey-route"' "$AUDIT" | tail -1)"
[ "$(printf '%s' "$ctrl" | jq -r '.query')" = "stub" ] \
  && ok "control wrote its own row" \
  || bad "control row missing"
maw hey-audit --since 1h --mismatch --json >"$STATE/mismatch2.json" 2>&1
jq -e '[.mismatches[] | select(.query == "stub")] | length == 0' \
  "$STATE/mismatch2.json" >/dev/null 2>&1 \
  && ok "the correct send is NOT flagged" \
  || bad "hey-audit flagged a correctly-routed send — the check is over-eager"

# ─── 7. duplicate names must not be picked silently ──────────────────────────
# Two windows named twin-oracle. The requirement is a refusal, not a choice:
# findWindow raises AmbiguousMatchError and cmdSend turns it into an exit.
maw hey twin-oracle "kobo-835 ambiguous" >"$STATE/hey-twin.log" 2>&1
twin_status=$?
[ $twin_status -ne 0 ] \
  && ok "duplicate window name refused (exit $twin_status)" \
  || bad "duplicate window name was resolved silently — a message went somewhere"
grep -qi 'ambiguous' "$STATE/hey-twin.log" \
  && ok "the refusal says which names collided" \
  || bad "refusal did not mention the ambiguity (see v3/hey-twin.log)"

# ─── 8. session name shadowing a window name ─────────────────────────────────
# `patchwork-oracle` names BOTH a session and 13-patchwork's oracle window. The
# session wins (findWindow Pass 1a beats Pass 1b), so a message meant for
# patchwork lands in the decoy. Recorded here as observed behaviour: the audit
# row now shows the destination, but hey-audit does NOT call this a mismatch —
# the decoy session's own name normalizes to "patchwork" too. See the PR body.
maw hey patchwork-oracle "kobo-835 shadow" >"$STATE/hey-shadow.log" 2>&1
grep -q 'kobo-835 shadow' "$STATE/decoy.log" 2>/dev/null \
  && ok "session name shadows the window of the same name (landed in the decoy)" \
  || bad "expected the decoy session to win; it did not"
shadow="$(grep '"kind":"hey-route"' "$AUDIT" | tail -1)"
[ "$(printf '%s' "$shadow" | jq -r '.resolvedWhere')" = "patchwork-oracle:notes" ] \
  && ok "the audit row shows where it really went" \
  || bad "row.resolvedWhere = '$(printf '%s' "$shadow" | jq -r '.resolvedWhere')'"

echo "v3: $fails failure(s)"
exit $((fails > 0))
