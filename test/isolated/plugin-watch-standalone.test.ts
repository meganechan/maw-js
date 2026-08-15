import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

describe("watch plugin Room retirement", () => {
  test("keeps only worklog/company runtime imports", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "watch",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [
        /^(?:\.\.\/){3}core\/worklog\//,
        /^(?:\.\.\/){3}core\/state-doc\//,
        /^(?:\.\.\/){3}core\/roster\//,
        /^(?:\.\.\/){3}core\/presence\//,
        /^(?:\.\.\/){3}core\/policy\//,
        /^(?:\.\.\/){3}api\/feed$/,
      ],
    }).map((record) => record.spec);
    expect(imports).toContain("maw-js/sdk");
    expect(imports).not.toContain("../../../core/room/route");
  });

  test("does not register or advertise Room routes", () => {
    const serve = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/serve.ts"), "utf8");
    const plugin = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/plugin.ts"), "utf8");
    expect(serve).toContain("registerWorklogListener");
    expect(serve).toContain("/api/worklog");
    expect(serve).not.toContain("/api/room");
    expect(serve).not.toContain("handleRoom");
    expect(serve).not.toContain("registerRoomListener");
    expect(plugin).not.toContain("/api/room");
  });

  /**
   * The capture outage of 2026-08-02 → 2026-08-07.
   *
   * A lifecycle hook is loaded with a runtime `import()` of an absolute path
   * (plugin/lifecycle.ts). Under a compiled bundle that import is not bundled, so
   * the hook evaluates a SECOND copy of every module it imports — including
   * `api/feed`. `serve()` therefore added its capture listeners to a Set the
   * server never pushed to. Nothing was red: the plugin's own routes answered 200
   * throughout, because `ctx.http` arrives as a live object rather than an import.
   *
   * The contract this pins is "register into the Set you are HANDED", which is the
   * only part a test can see without building a bundle. Asserted behaviourally —
   * grepping for `ctx.feedListeners` would pass on a file that reads the field and
   * then registers into the import anyway, which is exactly the bug.
   */
  test("serve registers capture into the Set it is handed, not the one it imported", async () => {
    const { serve } = await import("../../src/vendor/mpr-plugins/watch/serve");
    const { feedListeners: moduleGlobal } = await import("../../src/api/feed");
    // No `http`/`ws`: serve() reaches every route through `ctx.http?.`, so a minimal
    // context exercises the capture wiring without standing up a server.
    const ctx = (listeners: Set<(event: any) => void>) =>
      ({ phase: "serve", plugin: { name: "watch", dir: "." }, feedListeners: listeners }) as any;

    // First serve of this process: the capture listener lands in the handed Set.
    // This was 2 until the Room subsystem was removed — worklog and room were
    // registered together and went dark together. Worklog is now the only one.
    const first = new Set<(event: any) => void>();
    serve(ctx(first));
    expect(first.size).toBe(1);

    // A DIFFERENT Set still gets the worklog listener. The old guard was a
    // module-global boolean, idempotent in the wrong dimension: the first Set won
    // permanently, so a later call carrying the host's real Set was skipped and the
    // wiring fix would have been a silent no-op. Per-Set keys fix that — under the
    // old boolean guard this Set would be empty, so this assertion is what carries
    // the contract now that there is only one listener to count.
    const second = new Set<(event: any) => void>();
    serve(ctx(second));
    expect(second.size).toBe(1);

    // Same Set twice is still a no-op — the reload promise the boolean was there for.
    serve(ctx(first));
    expect(first.size).toBe(1);

    // And the module-global Set — the wrong one under a bundle — is never touched.
    expect(moduleGlobal.size).toBe(0);
  });

  /**
   * kobo-949 turned buildInjectSlice() into an async fetch of the kobo board.
   * `maw company worklog inject` renders it as `emit(slice || "(nothing…)")` —
   * a Promise is always truthy, so a dropped `await` does not throw, does not
   * fail a type check at runtime, and does not lose the fallback: it quietly
   * prints "[object Promise]" to whoever asked what their next prompt will say.
   * Asserted on the emitted OUTPUT rather than by grepping for "await", because
   * the grep passes on a file that awaits somewhere else.
   *
   * Hermetic: MAW_KOBO_API points at a closed port, so the slice takes its
   * documented degraded path instead of this machine's real board.
   */
  test("worklog inject emits the resolved slice text, never a pending Promise", async () => {
    const { runWorklog } = await import("../../src/vendor/mpr-plugins/watch/index");
    const orig = process.env.MAW_KOBO_API;
    process.env.MAW_KOBO_API = "http://127.0.0.1:1"; // connection refused → one-line degrade
    try {
      const lines: unknown[] = [];
      const res = await runWorklog(["inject"], (line) => lines.push(line));
      expect(res.ok).toBe(true);
      expect(lines).toHaveLength(1);
      expect(typeof lines[0]).toBe("string");
      expect(String(lines[0])).not.toContain("[object Promise]");
    } finally {
      if (orig === undefined) delete process.env.MAW_KOBO_API; else process.env.MAW_KOBO_API = orig;
    }
  });
});
