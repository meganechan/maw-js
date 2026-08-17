# e2e sandbox — maw in one throwaway container

Exercises maw's pane/delivery machinery inside a container, without touching the
host's `~/.maw`, `~/.claude`, tmux server, or any live service.

This is separate from `docker/compose.yml`, which is the 2-node federation
harness. Different harness, different purpose, deliberately not merged.

## kobo is NOT tested here any more (kobo-971, 2026-08-17)

`tests/v1-flow.sh` and `tests/v2-dispatchd.sh` drove kobo cards through
`task add → dispatch → dispatch-run → hey → pane → task start`. They are deleted,
along with the taskd boot and the kobo asserts in v0.

Why deleted rather than repaired: they had been failing at their FIRST command
for as long as kobo has required `--kind` on `task add`, and the suite still
printed phase names and read like a run that passed. That is worse than having no
harness — the output is shaped like a test result and proves nothing. It rotted
because it lived in a repo where no kobo change could ever break it.

kobo's e2e now lives in kobo's own repo, where a kobo contract change breaks it on
the commit that makes it:

    meganechan/kobo-board   scripts/e2e.sh        (merged in #246)

Known cost, recorded rather than hidden: that harness has no maw and no tmux, so
**the dispatch DELIVERY path is currently covered by nothing**. A card's outbox row
can be minted and observed there, but not delivered into a pane. If that coverage
is wanted back, it belongs next to the code that owns delivery — with a maw-born
pane, not a hand-stamped one.

## Run it

```sh
docker/e2e/run.sh                                  # v0 + v3
docker/e2e/run.sh /home/maw/e2e/tests/v0-image.sh  # one phase
docker/e2e/run.sh bash                             # poke around inside
```

`run.sh` clones kobo at a pinned ref (`KOBO_REF`, default `origin/main`) from
`KOBO_SRC` (default `~/ghq/github.com/meganechan/kobo-board`) and mounts that
clone read-only. It never mounts your working checkout — a checkout sits on
whatever branch it was last left on, and that silently changes what the suite
appears to prove. The container and the clone are removed on exit.

## What each phase asserts

**v0 — image prerequisites** (`tests/v0-image.sh`). These are blockers, not
hygiene, and each is asserted by running the thing rather than by inspecting
config:

| Check | Breaks what |
|---|---|
| non-root uid | `command-logic.ts:247` strips `--dangerously-skip-permissions` under root, so every agent launch silently hangs on an interactive permission prompt |
| `script -qfc`, `ps -eo` | busybox rejects both; this is why the base is debian-slim and not the alpine that `docker/Dockerfile` uses |
| `MAW_HOME` under `$HOME` | the `nonCanonicalRoot` bootstrap guard fails *open* outside `$HOME` (`plugin-bootstrap.ts:189`) — parked elsewhere, the sandbox exercises nothing |
| `MAW_PLUGINS_DIR` == `MAW_PLUGIN_HOME` | bootstrap reads the first (`cli.ts:47`), install/profile/create read the second (`plugins-install.ts:25`); set one and the dir you populate is not the dir that is read |
| per-kind `MAW_*_DIR` vars **unset** | setting one instead of `MAW_HOME` leaks pr-watch writes to the real `~/.maw/watch-pr-state.json` (`pr-watch.ts:43-58`) |
| cell contracts on disk | `self-spawn` hard-fails before any pane exists (`cell/spawn.ts:280-282`) |
| the kobo mount is read-only | the clone must not be writable from in here; this is the one kobo assert that outlived the kobo phases, because it is about isolation, not about kobo |

**v1 / v2 — removed.** See the note at the top of this file: the kobo flow and
kobo-dispatchd phases now live in `meganechan/kobo-board scripts/e2e.sh`.

## Deviations from the design spec

The spec is `eq3-oracle ψ/writing/e2e-sandbox-design.md` @ `8279d3a`.

The kobo half the spec describes (`task add → dispatch → dispatch-run → hey`) was
built as specified and has since been REMOVED from here — see the top of this
file. The spec is kept as the record of what was built, not as a description of
what this suite runs today. What remains:

1. **No tmpfs mounts.** The spec puts `$MAW_HOME` and the kobo runtime dir on
   tmpfs so state cannot survive a run. `run --rm` gives the same guarantee via
   the container's own layer, without the tmpfs uid/gid ownership problem that a
   non-root user creates. The property the spec wanted — no state carried between
   runs — holds; named volumes remain the thing to avoid.

2. **`MAW_HOST` is not set.** The spec's sketch sets `0.0.0.0`, which the existing
   federation entrypoint needs because its two containers must reach each other.
   Here everything lives in one container, so the default loopback bind is both
   sufficient and tighter — and it avoids the overload the spec itself flags
   (`MAW_HOST` also switches `hostExec` from `bash -c` to `ssh`,
   `core/transport/ssh.ts:86`).

3. **No `gh` shim and no `claude` shim.** Both are real needs, neither is v0/v1:
   the `gh` shim exists for pr-watch (spec phase v4) and the `claude` shim exists
   because `cell` hardcodes the literal binary when spawning panes (phase v3). v1
   launches its one stub pane with `tmux new-window` directly, so nothing looks up
   a `claude` on `PATH`.

**v3 — hey target resolution under name collisions** (`tests/v3-hey-targeting.sh`,
kobo-835). The only phase whose job is to make the system get something WRONG. It
builds a topology that collides on purpose — two windows sharing a name, and a
session named after another session's window — then replays the misroute from m5
on 27 Jul: `m5:helm` matches no session or window called helm, falls through to
`findWindow`'s cross-session substring pass, and lands on `13-patchwork:0.1`
because patchwork has a window called `helm-notes`. `hey` reports success,
`detectWindowMismatch` stays silent (it only fires for `-oracle`-suffixed
intents), and the new `hey-route` audit row is the only thing that notices.

It runs last: it sets `node = m5` and opens sessions the earlier phases would
otherwise resolve against. It asserts its own isolation before it sends anything —
`MAW_HOME`, the audit path, `/proc/mounts`, and the tmux socket — because a phase
that drives `send-keys` is only safe while those hold, and the same test on the
host has no socket to be isolated by (maw never sets `TMUX_TMPDIR`).

Two traps it records rather than works around: `maw init --node X --force`
rewrites the config and leaves `node` at its previous value, and the config dir's
weighted `maw.config.NN.json` wins over the legacy `maw.config.json`, so editing
the latter puts a value on disk that `loadConfig()` never returns.

## Not covered — by construction, not by omission

- **PR → review → done.** Implemented but **not exercised here** — deferred to v4.
  maw's own task subsystem is retired and maw's `pr-watch` drives no card state
  (`maw pr-watch.ts:14-17`), but kobo has since taken the job over: its
  `src/runtime/pr-watch.ts` moves cards out of `doing`/`review` on PR transitions
  (`:60,86`). Testing it needs the `gh` shim, which is phase v4.
- **Agent judgement.** The stub decides nothing.
- **Slash-command delivery.** `maw hey` types `/`-prefixed bodies character by
  character into a TUI (`ssh.ts:241-252`); a `read` loop cannot tell that from a
  paste.
- **macOS paths.** The container is Linux, so every darwin branch is untested by
  definition. A green run here says nothing about those.
- **Federation multicast.** UDP 31746 does not cross a default docker bridge.
- **Loopback trust.** `federation-auth.ts:108-110` treats loopback as trusted;
  behind container NAT everything can look like `127.0.0.1`. The sandbox will not
  surface this and may mask it.

## Next phases

Cell topology with three stub panes (needs the `claude` shim) · kobo's `pr-watch`
behind a `gh` shim, which is what closes PR → review → done.

## A note on refs

Every "that code does not exist" claim in this directory is scoped to a **ref**,
not to a checkout. The first version of this sandbox concluded kobo had no taskd
at all; it had read a working checkout that happened to be parked on a stale
feature branch, and every conclusion drawn from it was wrong. `run.sh` pins the
ref and `tests/v0-image.sh` asserts the mounted tree really is the runtime, so
that particular mistake now fails the suite instead of quietly rewriting what it
appears to prove.
