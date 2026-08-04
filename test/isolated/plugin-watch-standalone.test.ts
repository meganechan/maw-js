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
});
