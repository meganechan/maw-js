import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  startServePrWatch,
} from "../../src/vendor-plugins/serve-pr-watch/index.ts?plugin-serve-pr-watch-standalone";

const root = join(import.meta.dir, "../..");

describe("serve-pr-watch plugin standalone boundary", () => {
  // kobo-633 — the plugin no longer declares a `serve` lifecycle hook at
  // all: polling moved OUT of `maw-server`'s process into its own daemon
  // (`daemon.ts`, its own pm2 app — see `ecosystem.config.cjs`), invoked
  // directly by pm2, never through the plugin lifecycle. A hook that stayed
  // registered but did nothing would leave `ensures: ["serve:pr:watch"]` as
  // an unenforced, now-false claim in the manifest — removed outright
  // instead of left as an inert stub (replaces the old "declares fail-fast
  // serve hook" test, which pinned the hook this card removes).
  test("declares no lifecycle hooks — polling runs via daemon.ts, outside the plugin system entirely", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.json"), "utf8"));
    expect(manifest.hooks).toBeUndefined();
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toEqual(["startServePrWatch"]);
  });

  test("plugin.ts and plugin.json stay in sync", () => {
    const jsonManifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.json"), "utf8"));
    const tsSource = readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.ts"), "utf8");
    expect(tsSource).toContain('"name": "serve-pr-watch"');
    expect(tsSource).not.toContain('"hooks"'); // kobo-633: no hooks block in either file
    expect(jsonManifest.name).toBe("serve-pr-watch");
    expect(jsonManifest.hooks).toBeUndefined();
  });

  // kobo-633 — front caught this: the manifest still declared
  // `capabilities: ["serve:worklog", ...]` and `capabilityNamespaces:
  // ["serve", ...]` after `hooks.serve` was removed — a machine-readable
  // claim that this plugin provides something through the `serve` lifecycle,
  // which stopped being true the moment the hook was deleted. Only
  // `module.exports` had a pinning test before this; a manifest field with no
  // pin can drift silently with nothing going red. Both `capabilities` AND
  // `capabilityNamespaces` are pinned together deliberately — dropping the
  // "serve" namespace while leaving "serve:worklog" in capabilities would
  // fail `parseCapabilities`'s namespace validation (manifest-validate.ts).
  test("capabilities/capabilityNamespaces no longer claim anything about `serve` — worklog:pr-watch only", async () => {
    // plugin.json is pure JSON (no comments) — the raw-text checks below are
    // safe there. plugin.ts's doc comments legitimately still MENTION
    // "serve:worklog" as the removed value (explaining why it's gone), so
    // this test checks the PARSED manifest values there instead of raw text.
    const jsonRaw = readFileSync(join(root, "src/vendor-plugins/serve-pr-watch/plugin.json"), "utf8");
    const jsonManifest = JSON.parse(jsonRaw);
    const tsManifest = (await import("../../src/vendor-plugins/serve-pr-watch/plugin.ts")).default;

    expect(jsonManifest.capabilities).toEqual(["worklog:pr-watch"]);
    expect(jsonManifest.capabilityNamespaces).toEqual(["worklog"]);
    expect(jsonRaw).not.toContain("serve:worklog");
    expect(jsonRaw).not.toMatch(/"capabilityNamespaces":\s*\[\s*"serve"/);

    expect(tsManifest.capabilities).toEqual(["worklog:pr-watch"]);
    expect(tsManifest.capabilityNamespaces).toEqual(["worklog"]);
  });

  test("boundary drift is explicit — pr-watch is the only allowed core reach", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-pr-watch",
      pluginDir: "src/vendor-plugins/serve-pr-watch",
      requireSdk: false,
      // kobo-633 — NOT widened for daemon.test.ts. An earlier draft imported
      // `core/xdg` from that test and would have needed widening this list —
      // reviewer should confirm: that widening would have applied to the
      // WHOLE directory (the boundary helper can't scope by file), silently
      // permitting PRODUCTION code (`daemon.ts`/`index.ts`) to reach
      // `core/xdg` too, with nothing left to catch it — the same
      // "narrowed/widened a check while under review by it" shape as
      // kobo-594's invariant tonight. Fixed by removing the `xdg` need from
      // the test instead (it was redundant given the test already forces
      // exact write paths via override seams) — boundary stays exactly as
      // strong as before, zero widening.
      allowRelative: [/^\.\.\/\.\.\/core\/worklog\/pr-watch$/],
    });
  });

  // kobo-633 — `startServePrWatch` no longer unrefs its own timer: the ONLY
  // caller now is `daemon.ts`, a dedicated OS process with nothing else
  // keeping its event loop open (unlike the removed `serve()` caller, which
  // ran inside `maw-server` — already alive for other reasons). An unref'd
  // timer here would let the daemon process exit before its first tick.
  test("startServePrWatch schedules pollPrsOnce on the configured interval, does NOT unref its timer, and returns a stop handle", () => {
    const calls: string[] = [];
    let tick: (() => void) | null = null;
    const fakeTimer = { unref: () => calls.push("unref") };
    const result = startServePrWatch({
      pollPrsOnce: (async () => { calls.push("poll"); return []; }) as any,
      setInterval: ((handler: () => void, ms: number) => { calls.push(`every:${ms}`); tick = handler; return fakeTimer; }) as any,
      clearInterval: ((t: unknown) => { calls.push("clear"); expect(t).toBe(fakeTimer); }) as any,
      intervalMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["every:5000"]); // NOT ["every:5000", "unref"] — no unref call
    expect(calls).not.toContain("unref");

    tick!(); // fire one tick → pollPrsOnce runs
    expect(calls).toContain("poll");

    result.stop();
    expect(calls).toContain("clear");
  });
});
