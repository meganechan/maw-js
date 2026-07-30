module.exports = {
  apps: [
    {
      name: 'maw',
      script: 'src/core/server.ts',
      interpreter: 'bun',                // PATH lookup — works on any host
      watch: false,                       // production: restart manual after deploy only
      max_restarts: 5,                    // fail-fast — no silent 542-restart loops
      restart_delay: 3000,
      env: {
        MAW_HOST: 'local',
        MAW_PORT: '3456',
      },
    },
    {
      name: 'maw-boot',
      // Launcher shim: PM2 wraps spawned processes with require-in-the-middle,
      // which sync-require()s the entry file. src/cli.ts is an ESM async module
      // (top-level await) → require() throws on Windows and some Linux setups:
      //
      //   TypeError: require() async module "...src/cli.ts" is unsupported.
      //   use "await import()" instead.
      //
      // The .cjs shim is require-safe and spawns bun via child_process,
      // bypassing the PM2 require hook entirely.
      // See scripts/maw-boot.launcher.cjs.
      script: 'scripts/maw-boot.launcher.cjs',
      // #1811 — `wake all --resume` is deprecated; `fleet restore --all`
      // reads the latest snapshot and re-wakes every oracle in it.
      args: ['fleet', 'restore', '--all'],
      interpreter: 'node',
      // One-shot: spawn fleet after server starts, don't restart
      autorestart: false,
      // Give maw server time to come up
      restart_delay: 5000,
    },
    {
      // kobo-633 — pr-watch's own process, independent of `maw`: killing this
      // must never affect `maw` and vice versa (AC1). NOT started
      // automatically by this change landing — adding an app here does not
      // register/start it with a running pm2 daemon; that needs an explicit
      // `pm2 start ecosystem.config.cjs --only maw-pr-watch`, a deliberate
      // action, same as any other pm2 app addition.
      name: 'maw-pr-watch',
      script: 'src/vendor-plugins/serve-pr-watch/daemon.ts',
      interpreter: 'bun',
      watch: false,
      max_restarts: 5,
      restart_delay: 3000,
      // kobo-633 — recorded decision (lead asked this be a decision, not a
      // gap): this daemon does NOT keep any internal restart/exit log of its
      // own. It relies entirely on pm2's own per-app tracking instead —
      // `pm2 describe maw-pr-watch` already carries `restart_time`/uptime
      // (the exact field AC1 measures), and pm2 writes separate
      // `maw-pr-watch-out.log`/`-error.log` files for this app, distinct
      // from `maw`'s. `log_date_format` is set explicitly HERE because
      // `maw`'s own entry above does not set it — its live `out.log` has no
      // timestamps at all, and restart history genuinely cannot be
      // reconstructed from it (lead's own finding, this round). Not
      // reproducing that gap for the new app rather than inventing bespoke
      // daemon-internal logging on top of what pm2 already provides.
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        // kobo-633/636/637 — defaults to the site-wide OFF sentinel, matching
        // `maw`'s own current `MAW_PR_WATCH_INTERVAL_MS`. Turning pr-watch
        // back on is a DELIBERATE, separate decision (needs lead's say-so —
        // see kobo-631's dump.pm2 note) — this app must not come up already
        // polling just because someone ran a blanket `pm2 start` on this
        // file. Whoever flips it on must update BOTH this env AND
        // `~/.pm2/dump.pm2` together, or repeat the exact drift kobo-631
        // found and fixed for `maw`'s entry.
        MAW_PR_WATCH_INTERVAL_MS: '2147483647',
      },
    },
    // maw-dev moved to Soul-Brews-Studio/maw-ui (bun run dev)
    // maw-broker removed — MQTT layer deleted in 3b71daa (WebSocket handles broadcast)
  ],
};
