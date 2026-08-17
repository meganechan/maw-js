#!/bin/bash
# A tmux pane that behaves like an idle agent. Not a mock of Claude Code — a real
# shell showing a real prompt, which is all the two gates in front of delivery
# actually look at:
#
#   boot gate     cell/spawn.ts:35,53-62 — BOOT_READY_RE = /^❯\s*$/m
#   delivery gate comm-send.ts:761-803  — bottom-most line matching
#                 /^\s*[>❯›»]\s?(.*)$/ with an EMPTY capture means idle
#
# The prompt is printed without a trailing newline so typed input lands on the
# prompt line, exactly like a real shell: mid-typing the capture group is
# non-empty and the send defers, which is the behaviour under test.
#
# What this stub does NOT stand in for is agent judgement — it decides nothing.
# And because it reads with `read`, it cannot tell a char-by-char slash-command
# delivery from a buffered paste (core/transport/ssh.ts:241-252), so slash
# commands are out of scope here. See docker/e2e/README.md.
set -uo pipefail

# kobo dispatches a JSON payload — {dispatchId,cardId,kind,recipient,target,title,
# story,lane} built at kobo cli.ts:157-168 — and maw prefixes ordinary bodies with
# "[node:oracle] " (comm-send.ts:644-657). So recover the payload from the first
# brace rather than treating the line as JSON, then read the field with jq.
# `--self-check` exercises both without a container.
payload_of() { local s="${1#*\{}"; [ "$s" = "$1" ] && return 1; printf '{%s' "$s"; }
card_id()    { payload_of "$1" | jq -er '.cardId' 2>/dev/null; }
request_id() { local s="${1#*\[request:}"; printf '%s' "${s%%]*}"; }

if [ "${1:-}" = "--self-check" ]; then
  f=0
  t() { [ "$2" = "$3" ] || { printf 'FAIL %s: got %q want %q\n' "$1" "$2" "$3"; f=1; }; }
  P='{"dispatchId":"dispatch-abc","cardId":"card-1","kind":"assigned","lane":"todo"}'
  t "bare json"   "$(card_id "$P")"                  "card-1"
  t "maw-signed"  "$(card_id "[e2e:harness] $P")"    "card-1"
  t "title brace" "$(card_id "[e2e:h] {\"cardId\":\"card-2\",\"title\":\"fix {x}\"}")" "card-2"
  t "not json"    "$(card_id 'hello there' || echo NONE)" "NONE"
  t "request"     "$(request_id '[request:req-1-abc] do it')" "req-1-abc"
  [ $f -eq 0 ] && echo "stub-oracle self-check: ok"
  exit $f
fi

RECEIVED="$E2E_STATE/received.log"
KOBO_LOG="$E2E_STATE/stub-kobo.log"
: >"$RECEIVED"
: >"$KOBO_LOG"

# No `set -e`: a failing board verb must be recorded and the pane must keep
# serving, the way a real agent would. A dead pane looks identical to an
# undelivered message from the outside, and that ambiguity is what makes
# harness failures unreadable.
while :; do
  printf '❯ '
  IFS= read -r line || break

  case "$line" in
    *[!\ ]*) : ;;
    *) continue ;;
  esac

  printf '%s\n' "$line" >>"$RECEIVED"

  if id="$(card_id "$line")" && [ -n "$id" ]; then
    {
      printf '=== dispatch %s ===\n' "$id"
      # It used to run `kobo task start "$id" --actor "$E2E_ORACLE"` here, which was
      # the point of v1: taskd refuses `start` unless actor == assignee, so the
      # ownership gate was under test. That phase moved to kobo's own repo
      # (kobo-971) and there is no kobo on PATH in this image any more, so the pane
      # records what it received and stops there. Do not "restore" this with a
      # `command -v kobo` fallback: a board verb that runs only when a binary
      # happens to be present is the silent half-test this card removed.
      printf 'received (no board verb: kobo e2e lives in meganechan/kobo-board)\n'
    } >>"$KOBO_LOG"
    # Written last and only after the verb returns, so the tests can poll one file
    # instead of racing the board.
    printf 'HANDLED %s\n' "$id" >>"$RECEIVED"
  fi

  # The shape kobo's supervisor sends today and confirms against — it watches for
  # the DESTINATION pane to run `maw reply`, so a send succeeding proves nothing
  # on its own (kobo src/supervisor/wake.ts:96,116-124). v1 asserts nothing about
  # this path; it is here so the stub is not silently wrong against the one
  # kobo->maw producer that exists.
  case "$line" in
    *"[request:"*)
      cid="$(request_id "$line")"
      maw reply "$cid" "stub ack" >>"$KOBO_LOG" 2>&1
      printf 'REPLIED %s\n' "$cid" >>"$RECEIVED"
      ;;
  esac
done
