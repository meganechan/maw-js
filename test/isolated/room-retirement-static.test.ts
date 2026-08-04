import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Maw Room retirement boundaries", () => {
  test("removes the Room view, routes, auth branch, and core module", () => {
    expect(existsSync(join(root, "src/core/room/store.ts"))).toBe(false);
    expect(existsSync(join(root, "src/views/room.ts"))).toBe(false);
    expect(source("src/views/index.ts")).not.toContain("/room");
    const auth = source("src/lib/elysia-auth.ts");
    expect(auth).not.toContain("path.startsWith(\"/room/\")");
    expect(auth).not.toContain("path === \"/rooms\"");
  });

  test("preserves the locate, wake, and hey command paths", () => {
    expect(source("src/cli/route-comm.ts")).toContain("await cmdSend(");
    expect(source("src/cli/top-aliases.ts")).toContain("wake: { kind: \"direct\", handler: \"../commands/shared/wake-cmd:cmdWake\" }");
    expect(source("src/vendor/mpr-plugins/locate/index.ts")).toContain("locate");
  });
});
