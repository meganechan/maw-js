# Throwaway e2e sandbox for the maw + kobo flow.
#
# Deliberately NOT merged with docker/compose.yml — that is the 2-node
# federation harness, a different harness with a different purpose. This one
# exists so a maw/kobo change can be exercised end to end without any of it
# touching the host's ~/.maw, ~/.claude, tmux server or live services.
#
# debian-slim, not alpine: busybox `script` rejects -qfc (src/core/transport/pty.ts)
# and busybox `ps` rejects -eo (src/core/fleet/claude-sessions.ts). The alpine base
# used by docker/Dockerfile silently breaks both Linux paths.
FROM oven/bun:1.3.11-slim

# tmux     — the control plane; every pane op shells out to it
# procps   — `ps -eo` process scan
# bsdutils — `script -qfc` PTY streaming
# jq       — the statusline hook that writes presence files needs it
# git      — plugin bootstrap and the ghq-shaped layout
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux procps bsdutils util-linux jq git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Non-root is a hard blocker, not hygiene: command-logic.ts:247 strips
# --dangerously-skip-permissions when getuid() === 0, so under root every agent
# launch silently becomes interactive-permission mode and hangs. uid 1001
# because the base image already owns 1000 (user `bun`).
RUN useradd -m -u 1001 -s /bin/bash maw

# HOME must be set before the first `USER maw` step: Docker's USER does not set it,
# and a bun install with HOME still pointing at /root writes its cache nowhere.
ENV HOME=/home/maw

# ghq-shaped layout — ghq root is shelled out for and ~/ghq/github.com/meganechan
# is hardcoded as the default fleet repo root (cli/plugin-bootstrap.ts:280-284).
# Recreating the layout is cheaper than fighting it.
ENV MAW_CHECKOUT=/home/maw/ghq/github.com/meganechan/maw-js
# WORKDIR creates missing dirs as root; `bun install` then runs as maw and needs to
# create node_modules inside one. chown before, not after.
RUN mkdir -p "$MAW_CHECKOUT" && chown -R maw:maw /home/maw
WORKDIR $MAW_CHECKOUT

# No tsconfig.json and no bunfig.toml on purpose: the repo root has no tsconfig
# (bun runs the TS entry point directly), and bunfig.toml is test-only config
# whose `preload` points into test/, which this image does not ship.
COPY --chown=maw:maw package.json bun.lock* ./
COPY --chown=maw:maw packages/sdk/package.json packages/sdk/
USER maw
RUN bun install --frozen-lockfile

# Explicit copies rather than `COPY . .`: the build context is the repo root and
# there is no .dockerignore there, so a bulk copy would drag in .git and a
# macOS-built node_modules on top of the Linux one just installed above.
COPY --chown=maw:maw src/ src/
COPY --chown=maw:maw packages/ packages/
COPY --chown=maw:maw scripts/ scripts/

USER root
RUN chmod +x "$MAW_CHECKOUT/src/cli.ts" \
  && ln -sf "$MAW_CHECKOUT/src/cli.ts" /usr/local/bin/maw

COPY docker/e2e/bin/ /home/maw/e2e/bin/
COPY docker/e2e/tests/ /home/maw/e2e/tests/
COPY docker/e2e/entrypoint.sh /home/maw/e2e/entrypoint.sh
RUN chmod +x /home/maw/e2e/bin/* /home/maw/e2e/tests/* /home/maw/e2e/entrypoint.sh \
  && chown -R maw:maw /home/maw/e2e

USER maw

# MAW_HOME is the ONE knob — every xdg.ts resolver checks it first (core/xdg.ts:32-61).
# Setting a per-kind var instead (MAW_DATA_DIR/MAW_STATE_DIR/...) is the documented
# trap: it leaks pr-watch writes to the real ~/.maw/watch-pr-state.json
# (pr-watch.ts:43-58). Set MAW_HOME, never the per-kind vars. tests/v0-image.sh
# asserts the per-kind vars stay unset.
#
# Under $HOME on purpose: the plugin-bootstrap nonCanonicalRoot guard fails OPEN
# outside $HOME (plugin-bootstrap.ts:189), so parking state anywhere else would
# bypass the very guard this sandbox exists to exercise.
ENV MAW_HOME=/home/maw/.maw

# Both names: bootstrap reads MAW_PLUGINS_DIR (cli.ts:47) while install/profile/
# create read MAW_PLUGIN_HOME (commands/shared/plugins-install.ts:25). Setting one
# gives you a split brain where the dir you populated is not the dir that is read.
ENV MAW_PLUGINS_DIR=/home/maw/.maw/plugins \
    MAW_PLUGIN_HOME=/home/maw/.maw/plugins

# Speed knobs. Without these a single spawn assertion costs 20s (10 polls x 2000ms,
# cell/spawn.ts:31) and a pr-watch assertion costs 2 minutes
# (vendor-plugins/serve-pr-watch/index.ts:3-4).
ENV CELL_SPAWN_POLL_MS=200 \
    MAW_PR_WATCH_INTERVAL_MS=2000

# The `ps -eo` escape hatch (fleet/claude-sessions.ts:59). procps is installed so
# the scan works, but the sandbox runs stub panes rather than real Claude Code
# processes, so scanning for them only costs time.
ENV MAW_CLAUDE_SKIP_PID_SCAN=1

ENV MAW_PORT=3456 \
    E2E_NODE=e2e \
    E2E_SESSION=01-stub \
    E2E_ORACLE=stub \
    E2E_STATE=/home/maw/e2e/state

# Only the mount path is left (kobo-971): the runtime dir/socket/DB vars and the
# board session actor went with the kobo phases, because nothing in this sandbox
# starts a kobo daemon or runs a kobo verb any more. KOBO_REPO stays because
# compose mounts to it and v3 names it when proving no OTHER host path is mounted.
ENV KOBO_REPO=/home/maw/kobo-board-runtime

# dispatch-run shells out to `maw hey` with no --from (kobo cli.ts:201), so maw
# has to resolve a sender identity on its own or it exits 1 before sending
# (comm-send.ts:1474-1478). Outside a tmux pane, CLAUDE_AGENT_NAME is that seam.
ENV CLAUDE_AGENT_NAME=harness

# The kobo mount is owned by the host uid, not by `maw`, so git refuses to read it
# as "dubious ownership" — and bin/kobo dies on the SHA lookup before doing
# anything. Container-only; nothing here is shared with a host git config.
RUN git config --global --add safe.directory '*'

# Prepend, never replace: the base image puts bun on PATH and a literal list would
# silently drop it. The kobo launcher's bin dir is deliberately NOT on PATH any
# more (kobo-971) — a `kobo` that resolves is a `kobo` someone will run here.
ENV PATH=/home/maw/e2e/bin:$PATH

# Cell contracts must exist on disk or self-spawn hard-fails before any pane is
# created (cell/spawn.ts:280-282). Installs into $HOME/.claude — an image prereq,
# so a run never depends on network or on the host's ~/.claude.
RUN maw crew-skills sync

ENTRYPOINT ["/home/maw/e2e/entrypoint.sh"]
CMD ["/home/maw/e2e/tests/run-all.sh"]
