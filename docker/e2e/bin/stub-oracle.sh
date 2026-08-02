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

# maw signs ordinary bodies with a "[node:oracle] " prefix (comm-send.ts:644-657),
# so both parsers match on a substring and never on a line prefix. `--self-check`
# exercises them without a container — the only non-trivial logic in this file.
dispatch_id() { local s="${1##*E2E-DISPATCH }"; printf '%s' "${s%% *}"; }
request_id()  { local s="${1#*\[request:}";     printf '%s' "${s%%]*}"; }

if [ "${1:-}" = "--self-check" ]; then
  f=0
  t() { [ "$2" = "$3" ] || { printf 'FAIL %s: got %q want %q\n' "$1" "$2" "$3"; f=1; }; }
  t "bare"       "$(dispatch_id 'E2E-DISPATCH card-1')"              "card-1"
  t "signed"     "$(dispatch_id '[e2e:harness] E2E-DISPATCH card-1')" "card-1"
  t "trailing"   "$(dispatch_id '[e2e:harness] E2E-DISPATCH card-1 please')" "card-1"
  t "request"    "$(request_id  '[request:req-1-abc] do the thing')" "req-1-abc"
  t "req+signed" "$(request_id  '[e2e:x] [request:req-9] hi')"       "req-9"
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

  case "$line" in
    *E2E-DISPATCH*)
      id="$(dispatch_id "$line")"
      {
        printf '=== dispatch %s ===\n' "$id"
        kobo claim "$id" --holder "$E2E_ORACLE" 2>&1
        kobo move "$id" doing 2>&1
      } >>"$KOBO_LOG"
      # Written last and only after the verbs return, so the tests can poll one
      # file instead of racing the board.
      printf 'HANDLED %s\n' "$id" >>"$RECEIVED"
      ;;
  esac

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
