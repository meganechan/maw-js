# e2e sandbox — maw + kobo in one throwaway container

Runs the card → dispatch → pane → board-verb flow inside a container so a maw or
kobo change can be exercised end to end without touching the host's `~/.maw`,
`~/.claude`, tmux server, or any live service.

This is separate from `docker/compose.yml`, which is the 2-node federation
harness. Different harness, different purpose, deliberately not merged.

## Run it

```sh
docker/e2e/run.sh                                  # v0 + v1
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
| runtime DB outside the mount | the repo ships a committed `kobo-board.db`, the real board |
| the kobo mount really is the runtime | `bin/kobo`, `src/runtime/main.ts` and the `dispatch-run` verb are asserted present — a wrong ref fails loudly here instead of quietly reshaping what the suite proves |

**v1 — the flow** (`tests/v1-flow.sh`), every step through code that ships:

```
kobo task add          card on the real board, through taskd's socket
  task dispatch        writes an outbox row (state=queued)
  task dispatch-run    drains it, shells out to `maw hey` (kobo cli.ts:201)
    maw                real target resolution, real idle gate, real send-keys
      stub pane        parses the dispatch JSON, runs `kobo task start`
        assert         BOTH halves: card lane AND outbox row state
```

Both halves come from one `task show --json`: `.lane` is `doing`, and
`.dispatches[0].state` is `delivered` — the latter set only on a zero-status
`maw hey`. The `queued` state is asserted *before* the drain so that `delivered`
cannot pass by having never been anything else.

kobo picks the dispatch target itself, from the card's bare assignee name, so
`maw hey stub` must resolve against the fleet naming convention the entrypoint
sets up (session `01-stub`, window `stub-oracle`). The test surfaces the drain's
own reason string on failure, because an unresolved target is the likeliest way
this breaks.

The stub runs `task start`, not a bare lane write: taskd refuses `start` unless
the actor is the card's assignee (`runtime/server.ts:284-291`), so the ownership
gate is under test too. Nothing is mocked except the agent's judgement.

The stub (`bin/stub-oracle.sh`) is a shell showing a real `❯ ` prompt, which is
all the boot gate (`cell/spawn.ts:35`) and the delivery gate
(`comm-send.ts:761-803`) actually inspect. No `claude` binary is involved.

## Deviations from the design spec

The spec is `eq3-oracle ψ/writing/e2e-sandbox-design.md` @ `8279d3a`.

The kobo half is built exactly as specified — `task add → dispatch → dispatch-run
→ maw hey`, against taskd over its unix socket. What remains:

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

v2 the `dispatch-run` scheduler — v1 calls the drain by hand, and a queued-outbox
drainer should never make its first automated run against the live board · v3 cell
topology with three stub panes (needs the `claude` shim) · v4 kobo's `pr-watch`
behind a `gh` shim, which is what closes PR → review → done.

## A note on refs

Every "that code does not exist" claim in this directory is scoped to a **ref**,
not to a checkout. The first version of this sandbox concluded kobo had no taskd
at all; it had read a working checkout that happened to be parked on a stale
feature branch, and every conclusion drawn from it was wrong. `run.sh` pins the
ref and `tests/v0-image.sh` asserts the mounted tree really is the runtime, so
that particular mistake now fails the suite instead of quietly rewriting what it
appears to prove.
