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

`run.sh` defaults `KOBO_REPO` to `~/ghq/github.com/meganechan/kobo-board`; set it
if your checkout is elsewhere. The container is removed on exit.

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
| kobo DB ≠ mounted checkout | the checkout ships a committed `kobo-board.db`, the real board |

**v1 — the flow** (`tests/v1-flow.sh`): create a card on a real SQLite board →
`maw hey` (real target resolution, real idle gate, real `tmux send-keys`) → the
stub pane runs real board verbs → assert lane and holder moved in the store.
Nothing is mocked except the agent's judgement.

The stub (`bin/stub-oracle.sh`) is a shell showing a real `❯ ` prompt, which is
all the boot gate (`cell/spawn.ts:35`) and the delivery gate
(`comm-send.ts:761-803`) actually inspect. No `claude` binary is involved.

## Deviations from the design spec

The spec is `eq3-oracle ψ/writing/e2e-sandbox-design.md` @ `8279d3a`.

1. **The kobo half of the spec describes code that is not on `kobo-board` `main`.**
   The spec's v1 flow is `kobo task add → task dispatch → dispatch-run →
   spawnSync("maw", ["hey", …])`, citing `bin/kobo`, `src/runtime/main.ts`,
   `src/db-path.ts` and `src/cli.ts:196,235,937,949,967`. At `main` (`ab79c17`)
   **none of those exist**: there is no `bin/`, no `src/runtime/`, no
   `KOBO_RUNTIME_SOCKET` anywhere in the repo, no unix-socket daemon, and no
   `dispatch` verb. The CLI is `add · ls · show · move · export · claim` against a
   plain SQLite file. The taskd work is unlanded — it lives on `feat/kobo-taskd-*`
   branches. (`src/supervisor/wake.ts:102`, which the spec also cites, *does*
   exist and does shell out to `maw hey`.)

   So v1 drives the send directly instead of through a kobo dispatch producer.
   Everything downstream of the send — resolution, gates, tmux, the pane, the
   board verbs, the store — is real. When taskd lands, replacing the one `maw hey`
   line in `tests/v1-flow.sh` with `kobo task dispatch-run` is the whole change.

2. **No `taskd` process.** Follows from (1) — there is no daemon to start.

3. **No tmpfs mounts.** The spec puts `$MAW_HOME` and the kobo runtime dir on
   tmpfs so state cannot survive a run. `run --rm` gives the same guarantee via
   the container's own layer, without the tmpfs uid/gid ownership problem that a
   non-root user creates. The property the spec wanted — no state carried between
   runs — holds; named volumes remain the thing to avoid.

4. **`MAW_HOST` is not set.** The spec's sketch sets `0.0.0.0`, which the existing
   federation entrypoint needs because its two containers must reach each other.
   Here everything lives in one container, so the default loopback bind is both
   sufficient and tighter — and it avoids the overload the spec itself flags
   (`MAW_HOST` also switches `hostExec` from `bash -c` to `ssh`,
   `core/transport/ssh.ts:86`).

5. **No `gh` shim and no `claude` shim.** Both are real needs, neither is v0/v1:
   the `gh` shim exists for pr-watch (spec phase v4) and the `claude` shim exists
   because `cell` hardcodes the literal binary when spawning panes (phase v3). v1
   launches its one stub pane with `tmux new-window` directly, so nothing looks up
   a `claude` on `PATH`.

## Not covered — by construction, not by omission

- **PR → review → done.** Unimplemented, not untested: maw's task subsystem is
  retired and `pr-watch` drives no card state (`pr-watch.ts:14-17`).
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

v2 the `dispatch-run` scheduler (nothing calls it on a timer today — a queued
outbox drainer should never make its first run against the live board) · v3 cell
topology with three stub panes · v4 pr-watch behind a `gh` shim.
