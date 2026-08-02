/**
 * The ORIGINAL leak shape, reproduced (maw-test-store-guard).
 *
 * `appendWorklog` runs in the `describe` body — per-file COLLECTION time, which
 * executes BEFORE `beforeAll`. So the redirect below is set too late and the
 * write lands in the real maw home. Six days of this put 28 real cards, worklog
 * rows and ledger fixtures into live state.
 *
 * Not named `*.test.ts` on purpose: it is a fixture driven by
 * test/isolated/store-guard-real-home.test.ts as a child `bun test` process,
 * never collected by the suite itself.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendWorklog } from "../../../src/core/worklog/store";

describe("store mutator at collection time", () => {
  appendWorklog({
    ts: Date.now(),
    iso: new Date().toISOString(),
    oracle: "store-guard-fixture",
    company: "store-guard-fixture",
    kind: "tool",
    summary: "leak fixture — must never reach the real maw home",
  });

  beforeAll(() => {
    // Too late: the describe body already ran.
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "store-guard-late-"));
  });

  test("collection already wrote", () => {
    expect(1).toBe(1);
  });
});
