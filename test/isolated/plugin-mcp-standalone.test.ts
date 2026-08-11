import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const mcpDir = join(root, "src/vendor/mpr-plugins/mcp");

describe("mcp plugin Room retirement", () => {
  test("does not ship a Room HTTP client or maw_room tools", () => {
    const server = readFileSync(join(mcpDir, "server.ts"), "utf8");
    expect(existsSync(join(mcpDir, "room-client.ts"))).toBe(false);
    expect(server).not.toContain("maw_room_");
    expect(server).not.toContain("room-client");
  });

  test("retains the supported message and company tools", () => {
    const server = readFileSync(join(mcpDir, "server.ts"), "utf8");
    for (const name of ["maw_hey", "maw_reply", "maw_inbox", "maw_ls", "maw_company", "maw_dept", "maw_inline_images"]) {
      expect(server).toContain('"' + name + '"');
    }
  });
});
