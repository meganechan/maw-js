import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-pr-watch",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "tier": "core",
  // kobo-633 — no longer "during serve lifecycle": polling runs in
  // `daemon.ts`, its own `pm2` process, independent of `maw-server`.
  "description": "Periodically polls open/merged PRs via its own standalone daemon process so a github web-merge drives card lifecycle without a manual maw command.",
  "author": "Soul-Brews-Studio",
  // kobo-633 — no `hooks.serve` anymore: polling moved OUT of the plugin
  // lifecycle entirely, into `daemon.ts`, run as its own `pm2` app (see
  // `ecosystem.config.cjs`), independent of `maw-server`. A hook that's kept
  // registered but does nothing would leave `ensures: ["serve:pr:watch"]` as
  // an unenforced, now-false claim — removed outright instead.
  "module": {
    "path": "./index.ts",
    "exports": [
      "startServePrWatch"
    ]
  },
  // kobo-633 — `"serve:worklog"`/`"serve"` namespace REMOVED along with
  // `hooks.serve`: this plugin doesn't provide anything through the `serve`
  // lifecycle anymore (nothing here runs when `maw serve` starts). Keeping
  // the capability string would be the same class of false machine-readable
  // claim as the removed `ensures` field — a promise nothing backs anymore.
  // `"worklog:pr-watch"` stays: the daemon still provides pr-watch capability
  // to the worklog system, just not via `serve`. Changed BOTH fields
  // together deliberately — `capabilities` entries are validated against
  // `capabilityNamespaces` (plus the global known set); dropping "serve"
  // from namespaces while leaving "serve:worklog" in capabilities would fail
  // that validation.
  "capabilities": [
    "worklog:pr-watch"
  ],
  "capabilityNamespaces": [
    "worklog"
  ],
  "weight": 3,
  "license": "MIT",
  "schemaVersion": 1
} as const);
