/**
 * The well-behaved shape: `MAW_DATA_DIR` is set in `beforeAll`, the mutator runs
 * inside a test. Driven as a child `bun test` process by
 * test/isolated/store-guard-real-home.test.ts to prove the guard leaves normal
 * test files untouched.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendWorklog, worklogPath } from "../../../src/core/worklog/store";

describe("store mutator under a beforeAll redirect", () => {
  beforeAll(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "store-guard-ok-"));
  });

  test("writes into the redirected data dir", () => {
    appendWorklog({
      ts: Date.now(),
      iso: new Date().toISOString(),
      oracle: "store-guard-fixture",
      company: "store-guard-fixture",
      kind: "tool",
      summary: "redirected write — allowed",
    });
    const p = worklogPath("store-guard-fixture");
    expect(p.startsWith(process.env.MAW_DATA_DIR!)).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});
