# `~/.maw` backup + restore runbook (kobo-427)

Written from an actual end-to-end walk (2026-07-27), not from memory or the design proposal.
Every command below is the exact command run; every count is the exact number observed.

## What gets backed up

`scripts/maw-home-backup.ts` (run daily via `com.mawjs.backup.plist`, see below) snapshots
`$MAW_HOME` (default `~/.maw`) into `$MAW_BACKUP_DIR` (default `~/.maw-backups`, a **sibling**
of `~/.maw` — a disaster that takes `~/.maw` doesn't take the backups with it).

- Excluded: `plugins/` (133 symlinks into the live source checkout — data-free, and a tar that
  includes or dereferences them restores a dangling symlink that resolves back to whatever
  checkout happens to be on the restore box), `maw.pid` (the live server's runtime lock — a
  carried-over PID makes a restored `maw serve` refuse to start), `ui/dist` (build output).
- SQLite files (`message-ledger.sqlite`, `review-desk.sqlite`, any future one — enumerated by
  glob at run time, not a fixed list) are `sqlite3 .dump`'d, filtered, and rebuilt — never
  raw-copied (a live-written db copied mid-transaction can be genuinely corrupt).
- Every text file (`.json`/`.jsonl`/`.md`/`.txt`/`.log`) is scanned for credential-shaped
  values (GitHub PAT, JWT) and redacted in place — see `scripts/lib/redact-secrets.ts`. **This
  method (blanket scan) is a change from the original pinned-file-list design and is under
  review by front/lead as of this writing — see kobo-427 card notes.**

## Restoring — the walk that was actually run

```bash
# 1. get a snapshot onto the restore box (scp/USB/whatever — not covered here)

# 2. extract to a FRESH directory — never reuse one that's already been run against
#    (the first `maw` invocation against any MAW_HOME bootstraps plugin symlinks etc.,
#    so a reused dir is no longer a pristine copy of the archive)
mkdir -p /tmp/maw-restore
tar -xzf maw-<timestamp>.tar.gz -C /tmp/maw-restore
# → /tmp/maw-restore/.maw/companies/<company> should exist

# 3. confirm plugins/ is ABSENT, not a dangling symlink (the exact trap this card names)
ls /tmp/maw-restore/.maw/plugins   # must fail: "No such file or directory"

# 4. run the CLI from OUTSIDE $HOME — this is load-bearing, not optional.
#    Plugin resolution walks UP from the current working directory looking for a
#    `.maw/plugins` dir before it ever consults MAW_HOME. Since `~/.maw` is an ancestor
#    of nearly every directory under $HOME, running from anywhere under $HOME can pick up
#    the LIVE plugin dir and silently borrow live code while still reading the correct
#    restored DATA — which looks like a clean restore but hasn't actually proven the
#    restored copy is self-sufficient.
cd /tmp
MAW_HOME=/tmp/maw-restore/.maw bun /path/to/maw-js/src/cli.ts company task ls --company <company>
# first run bootstraps ~133 plugin symlinks fresh FROM THIS CHECKOUT (not shadowed) — expect
# "[maw] bootstrapped 133 plugins → /tmp/maw-restore/.maw/plugins" then the board line:
#   ▌ kobo board (N tasks)
# NEVER add --full to this command — that render has no aggregate total at all.
```

**Real numbers from the 2026-07-27 walk:** `status.json.cardCount.kobo` recorded **136** at
backup time. The command above printed `(136 tasks)` — exact match. `status.json.taskFileCount.kobo`
recorded **345**.

## The two integrity lines — never cross-compare them

```bash
# route 1 — "readable" (needs the maw binary + a source checkout or the standalone release
# asset with plugins installed): the CLI's own (N tasks) header, compared against
# status.json.cardCount recorded AT BACKUP TIME (not against "whatever the board says now").

# route 2 — "present" (no maw binary needed at all, works on a genuinely dead box with
# nothing but the tarball and standard Unix tools):
tar -tzf maw-<timestamp>.tar.gz | grep -cE '^\.maw/companies/<company>/tasks/[^/]+\.json$'
# compared against status.json.taskFileCount, recorded the same way.
```

**Why these are NOT the same number, verified live:** the CLI's count applies `isOnBoard()`
(`src/core/tasks/store.ts`), which drops `done`/`rejected` cards older than `DEFAULT_ARCHIVE_DAYS`
(7 days) from the *displayed* total — even though the file is still on disk, not yet swept to
`archive/`. On 2026-07-27, kobo had 345 raw task files on disk while the CLI displayed 133-136
depending on exactly when it was run. **Both numbers are correct — they answer different
questions.** Cross-comparing them fails on every perfectly healthy backup, which is the exact
false-green shape this rule exists to prevent.

Both counts also carry a `> 0` floor: a snapshot that recorded zero of either kind is not
evidence the mechanism works — it's the two-broken-sides-agree-on-zero failure this card was
opened to close in the first place.

## Content, not just counts

A count matching doesn't prove the restored file is *usable* — a structurally-intact-but-empty
restore would also match a count. Spot-check actual content after restoring:

```bash
python3 -c "
import json
d = json.load(open('/tmp/maw-restore/.maw/companies/<company>/tasks/<some-card>.json'))
print(d.get('id'), bool(d.get('title')), len(d.get('notes', [])))
"
```

Real check from the walk: `kobo-415`'s own card came back with all 150 notes intact; a real
room (`auto-seat.json`) came back with all 41 messages, text intact — confirming the redaction
pass filters credential-shaped substrings without destroying surrounding task/room data.

## Known limitation — code recovery, not data recovery

This runbook proves the **data** side of disaster recovery: the tarball restores task cards
and rooms, verified end-to-end above. It does **not** prove code recovery on a machine with
zero `maw-js` checkout — the CLI route above needs a source checkout (or the standalone
release asset with `plugin install --standard`, which itself pulls plugins from a local
checkout as tested during the original design proposal). That gap is **kobo-429's territory**,
not this card's, and is named here so nobody reads this runbook as full disaster recovery on a
genuinely blank machine.

## Reading a stale/dead backup

`maw fleet doctor` check 8 (`checkBackupStaleness`) reads `status.json` and flags:
- **error** — no backup has ever run at all
- **error** — an attempt exists but no success ever recorded
- **error** — last success is older than 26h (daily job + 2h grace)
- **warn** — the most recent attempt failed, even though an older success is still
  technically within the grace window (the job is failing again right now)

## Installing the daily job (launchd) — what it is, how to remove it

`scripts/com.mawjs.backup.plist` installs a **user LaunchAgent** (runs as `tony`, no root/sudo)
that fires `runBackup()` once a day at 03:00 local time. This is the ONE thing on this card
that changes the real machine rather than a project file — Tony's explicit go-ahead required
before loading, per kobo-427 card notes.

**What gets installed:**
- Label `com.mawjs.backup`, a copy of `scripts/com.mawjs.backup.plist` placed at
  `~/Library/LaunchAgents/com.mawjs.backup.plist` (launchd only reads plists from this
  directory for user agents — the copy in `maw-js/scripts/` is the source template, not itself
  read by launchd).
- Runs `/Users/tony/.bun/bin/bun /Users/tony/maw-js/scripts/maw-home-backup.ts` daily at 3:00am
  — **this path is the LIVE checkout, not any worktree** (same convention as every other
  deploy in this repo, see `reference_maw_dev_in_worktree_not_live` — a worktree is dev-only,
  `~/maw-js` on `alpha` is what actually runs).
- Writes stdout/stderr to `~/.maw-backups/launchd-out.log` / `launchd-err.log` (sibling of the
  backup snapshots themselves, per the "never inside `~/.maw`" rule above).
- No network access, no new listening port, no elevated privileges — it does exactly what
  running `bun scripts/maw-home-backup.ts` by hand does, on a timer.

**PREREQUISITE — do not load yet:** as of this writing (2026-07-27) the live checkout
(`/Users/tony/maw-js` on `alpha`) does **not** have `scripts/maw-home-backup.ts` — kobo-427
hasn't merged. Loading the plist before deploy schedules a job against a path that doesn't
exist yet; it will fail silently every night into `launchd-err.log` until someone notices.
Load it only **after** this branch has merged to `alpha` and the live checkout has pulled it
(`ls /Users/tony/maw-js/scripts/maw-home-backup.ts` must exist first).

**Install (run once, after the prerequisite above is met):**
```bash
plutil -lint /Users/tony/maw-js/scripts/com.mawjs.backup.plist   # validate before touching launchd
cp /Users/tony/maw-js/scripts/com.mawjs.backup.plist ~/Library/LaunchAgents/com.mawjs.backup.plist
launchctl load ~/Library/LaunchAgents/com.mawjs.backup.plist
launchctl list | grep com.mawjs.backup   # confirm it's loaded — should print a PID or "-" and the label
```

**Remove (exact reverse, safe at any time, does not touch `~/.maw` or `~/.maw-backups`):**
```bash
launchctl unload ~/Library/LaunchAgents/com.mawjs.backup.plist
rm ~/Library/LaunchAgents/com.mawjs.backup.plist
launchctl list | grep com.mawjs.backup   # confirm gone — should print nothing
```

Removing the job does **not** delete any existing snapshots in `~/.maw-backups/` — it only
stops future runs. To also remove past snapshots, `rm -rf ~/.maw-backups` separately (not part
of job removal, a deliberate separate step).
