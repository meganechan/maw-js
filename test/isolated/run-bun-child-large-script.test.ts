/**
 * runBunChild used to hand the child script to `import()` as a
 * data:text/javascript;base64 URL. Bun rejects an import specifier longer than
 * 1536 bytes with "ResolveMessage: NameTooLong", so a script whose base64 ran
 * past 1508 chars made the child exit 1 with the failure buried in its own
 * captured stderr — the caller only saw `result.code === 1`.
 *
 * That ceiling was reachable by accident, not by writing a big test: every
 * caller interpolates process.cwd() into its script several times, so the same
 * script fit at /Users/tony/maw-js and blew the limit from a deep worktree.
 * This asserts a script well past the old limit still runs.
 */
import { describe, expect, test } from "bun:test";
import { runBunChild } from "./helpers/run-bun-child";

describe("runBunChild — script size", () => {
  test("a script far past the old 1536-byte data-URL ceiling still runs", () => {
    const padding = "x".repeat(8000);
    const script = `console.log("RESULT:ok");// ${padding}`;
    expect(Buffer.from(script, "utf8").toString("base64").length).toBeGreaterThan(1536);

    const result = runBunChild({ script, env: { MAW_TEST_MODE: "1" } });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("RESULT:ok");
  });
});
