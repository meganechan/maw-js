import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";

// #2316 plugin-coverage-gate: the worklog engine lives in src/core/worklog/* +
// the feed singleton (src/api/feed). The `watch` plugin is its thin CLI + serve
// shell, so those deep imports are the EXPLICIT, intended coupling — this test
// pins exactly which boundary the shell is allowed to cross, so extraction drift
// is visible instead of silently breaking implementation-coverage mocks.

describe("watch command plugin standalone boundary", () => {
  test("watch keeps explicit import boundaries (SDK + the core/worklog engine it shells)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "watch",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [
        /^(?:\.\.\/){3}core\/worklog\//,
        /^(?:\.\.\/){3}core\/state-doc\//, // company-ui coordination markdown panel
        /^(?:\.\.\/){3}core\/roster\//, // company-ui presence roster (kobo-50)
        /^(?:\.\.\/){3}core\/presence\//, // company-ui presence detail — per-pane model + ctx% (kobo-104)
        /^(?:\.\.\/){3}core\/policy\//, // policy inject route — on-attach context
        /^(?:\.\.\/){3}core\/room\//, // kobo-245 Brainstorm Room send route (shells hey)
        /^(?:\.\.\/){3}api\/feed$/,
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("serve hook wires the engine (route + capture listener) so it toggles with the plugin", () => {
    // Static read — NOT a dynamic import — so a sibling test's mock.module of
    // maw-js/sdk (which api/feed pulls in) can't bleed in and break evaluation.
    const serveSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/serve.ts"),
      "utf8",
    );
    expect(serveSrc).toContain("registerWorklogListener");
    expect(serveSrc).toContain("/api/worklog");
    expect(serveSrc).toContain("/api/policy");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["']/);
  });

  test("serve hook also wires the company-ui read-only routes (feed timeline + state)", () => {
    const serveSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/serve.ts"),
      "utf8",
    );
    // company-ui (spec §6) reads these from the same plugin so they toggle with
    // the worklog engine.
    expect(serveSrc).toContain("/api/worklog/feed");
    expect(serveSrc).toContain("/api/state");
    expect(serveSrc).toContain("handleWorklogFeedRequest");
    expect(serveSrc).toContain("handleStateDocRequest");
    // The task subsystem retired: NO /api/tasks route (read, detail, SSE or write)
    // may come back through this hook. Asserted as a class, not per-handler — the
    // per-handler list this replaces could only catch the handlers it enumerated.
    expect(serveSrc).not.toContain("/api/tasks");
    expect(serveSrc).not.toMatch(/handleTask\w+Request/);
    // …and neither may the room→card distill route (its card side is gone).
    expect(serveSrc).not.toContain("/api/room/distill");
    expect(serveSrc).not.toContain("handleRoomDistillRequest");
    // kobo-245: Brainstorm Room core wire — web input → hey to lead (delivery + MessageSend feed event).
    expect(serveSrc).toContain("handleRoomSendRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/send["']/);
    // kobo-241: off-card room artifact — open/close/reopen + thread read + the feed listener that persists turns.
    expect(serveSrc).toContain("registerRoomListener");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/open["']/);
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/close["']/);
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/reopen["']/);
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/room\/thread["']/);
    // kobo-243: lead-driven merge — consolidate same-problem rooms (confirm-gated).
    expect(serveSrc).toContain("handleRoomMergeRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/merge["']/);
    // kobo-242: room participant activity — CC-style "doing X" (worklog + presence join).
    expect(serveSrc).toContain("handleRoomActivityRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/room\/activity["']/);
    // kobo-258: company-scoped room list — topic pane + company selector + default lead.
    expect(serveSrc).toContain("handleRoomsListRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/rooms["']/);
    // kobo-260: room-target reply primitive + teammate invite (write-in + one-shot notify).
    expect(serveSrc).toContain("handleRoomReplyRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/reply["']/);
    expect(serveSrc).toContain("handleRoomInviteRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']POST["'],\s*["']\/api\/room\/invite["']/);
    expect(serveSrc).toContain("handleRosterRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/roster["']/);
    // kobo-104: per-pane presence detail GET (model + context%).
    expect(serveSrc).toContain("handlePresenceRequest");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/presence["']/);
    // kobo-57: cache-bust version GET — the company page polls it to detect a new
    // deploy and offer a reload. Served from companyVersion() (content hash).
    expect(serveSrc).toContain("companyVersion");
    expect(serveSrc).toMatch(/ctx\.http\??\.route\(\s*["']GET["'],\s*["']\/api\/version["']/);
  });

  // cli-reorg kobo-26: `maw watch` is HARD-REMOVED (no cli command). The plugin
  // keeps its serve hook (HTTP routes) — hooks make it non-dispatchable as a
  // command — and exposes `runWorklog` as a module for `maw company worklog`.
  // Authoritative manifest via loadManifestFromDir (plugin.ts-first) — guards
  // against plugin.ts/json drift hiding a still-registered `maw watch` (kobo-26).
  test("no cli command (maw watch → unknown), serve hook + module surface intact", () => {
    const manifest = loadManifestFromDir(join(import.meta.dir, "../../src/vendor/mpr-plugins/watch"))!.manifest;
    expect(manifest.cli).toBeUndefined(); // hard-removed — not dispatchable as `maw watch`
    expect(manifest.module?.exports).toContain("runWorklog"); // company imports this
    // serve hook untouched — the worklog/room HTTP routes still toggle with the plugin.
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/worklog/feed");
    // task subsystem retired — the manifest must not advertise a route the hook no
    // longer registers (a stale `ensures` is a promise the plugin can't keep).
    expect(manifest.hooks!.serve!.ensures.filter((e) => e.includes("/api/tasks"))).toEqual([]);
    expect(manifest.hooks!.serve!.ensures).not.toContain("http:route:/api/room/distill");
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/send"); // kobo-245 Brainstorm Room wire
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/open"); // kobo-241 artifact lifecycle
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/thread"); // kobo-241 persisted thread
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/merge"); // kobo-243 lead-driven merge
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/rooms"); // kobo-258 company-scoped room list
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/reply"); // kobo-260 reply primitive
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/invite"); // kobo-260 teammate invite
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/room/activity"); // kobo-242 participant activity
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/roster"); // kobo-50
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/presence"); // kobo-104
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/state");
    expect(manifest.hooks!.serve!.ensures).toContain("http:route:/api/version"); // kobo-57 cache-bust
  });

  // cli-reorg kobo-26: exports the shared `runWorklog` runner (all verbs, OQ2 —
  // no cull), imported by the company plugin. No default handler / no shim.
  test("exports runWorklog (all verbs) with no shim handler / no default export", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/index.ts"),
      "utf8",
    );
    expect(src).toContain("export async function runWorklog");
    expect(src).not.toContain("export default"); // no top-level command handler
    expect(src).not.toContain("moved →"); // no deprecation shim notice
    for (const verb of ['subcmd === "log"', 'subcmd === "inject"', 'subcmd === "claim"', 'subcmd === "release"', 'subcmd === "sync"', 'subcmd === "setup-hooks"']) {
      expect(src).toContain(verb);
    }
  });

  // kobo-216 — `watch log` resolves its company through the STRICT resolver: --company
  // wins, else a multi-company oracle throws "ambiguous … specify --company" (option-a).
  test("company resolution uses companyOfOracleStrict (kobo-216 option-a)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/watch/index.ts"),
      "utf8",
    );
    expect(src).toContain("companyOfOracleStrict");
  });
});
