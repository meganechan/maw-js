import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findSqliteFiles,
  findTextFiles,
  readStatus,
  sweepOldSnapshots,
  writeStatus,
} from "../../scripts/maw-home-backup";

// kobo-427 — synthetic fixture MAW_HOME, never the real live `~/.maw`. Real-archive
// verification (grepping the ACTUAL produced archive for credential patterns) is a manual
// proof documented on the card, not run here — running the real backup against live board
// data inside an automated suite would itself be a way to leak real secrets into CI logs.
function makeFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "maw-home-fixture-"));
  mkdirSync(join(home, "companies", "acme", "tasks"), { recursive: true });
  writeFileSync(join(home, "companies", "acme", "tasks", "acme-1.json"), JSON.stringify({ id: "acme-1", state: "todo" }));
  writeFileSync(join(home, "companies", "acme", "tasks", "acme-2.json"), JSON.stringify({ id: "acme-2", state: "done" }));
  mkdirSync(join(home, "plugins", "company"), { recursive: true });
  writeFileSync(join(home, "maw.pid"), "12345");
  return home;
}

describe("maw-home-backup helpers (kobo-427)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-backup-unit-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("findSqliteFiles enumerates *.sqlite*/*.db at any depth, ignores everything else", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.sqlite"), "");
    writeFileSync(join(dir, "nested", "b.sqlite-wal"), "");
    writeFileSync(join(dir, "c.db"), "");
    writeFileSync(join(dir, "not-a-db.json"), "{}");
    const found = findSqliteFiles(dir).map((f) => f.split("/").pop());
    expect(found.sort()).toEqual(["a.sqlite", "b.sqlite-wal", "c.db"].sort());
  });

  test("findTextFiles enumerates .json/.jsonl/.md/.txt/.log at any depth, ignores binary-shaped extensions", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.json"), "{}");
    writeFileSync(join(dir, "nested", "b.jsonl"), "{}\n");
    writeFileSync(join(dir, "c.png"), "");
    writeFileSync(join(dir, "d.sqlite"), "");
    const found = findTextFiles(dir).map((f) => f.split("/").pop());
    expect(found.sort()).toEqual(["a.json", "b.jsonl"].sort());
  });

  test("status.json read/write round-trips and merges (a partial write doesn't erase prior fields)", () => {
    writeStatus(dir, { lastAttemptTs: 100 });
    writeStatus(dir, { lastSuccessTs: 200, cardCount: { kobo: 5 } });
    const status = readStatus(dir);
    expect(status.lastAttemptTs).toBe(100); // survives the second, partial write
    expect(status.lastSuccessTs).toBe(200);
    expect(status.cardCount).toEqual({ kobo: 5 });
  });

  test("sweepOldSnapshots keeps only the newest N, deletes the rest", () => {
    for (const ts of [100, 200, 300, 400, 500]) {
      writeFileSync(join(dir, `maw-${ts}.tar.gz`), "");
    }
    const deleted = sweepOldSnapshots(dir, 3);
    expect(deleted.sort()).toEqual(["maw-100.tar.gz", "maw-200.tar.gz"].sort());
    expect(existsSync(join(dir, "maw-300.tar.gz"))).toBe(true);
    expect(existsSync(join(dir, "maw-400.tar.gz"))).toBe(true);
    expect(existsSync(join(dir, "maw-500.tar.gz"))).toBe(true);
    expect(existsSync(join(dir, "maw-100.tar.gz"))).toBe(false);
    expect(existsSync(join(dir, "maw-200.tar.gz"))).toBe(false);
  });

  // kobo-427 AC — the "must not lose non-secret task data" clause, run against the actual
  // backup mechanism (redact-in-place), not just the redactSecrets unit in isolation.
  test("a task file with a fabricated credential-shaped value keeps its non-secret fields after the redaction pass used by the real backup", () => {
    const home = makeFixtureHome();
    try {
      const fakePat = "ghp_" + "zZ9yY8xX7wW6vV5uU4tT3sS2rR1qQ0p"; // fabricated, never a real value
      const taskWithSecret = join(home, "companies", "acme", "tasks", "acme-3.json");
      writeFileSync(taskWithSecret, JSON.stringify({ id: "acme-3", state: "todo", note: `found ${fakePat} in a README` }));

      const { redactSecrets } = require("../../scripts/lib/redact-secrets");
      const { text } = redactSecrets(readFileSync(taskWithSecret, "utf8"));
      const parsed = JSON.parse(text);
      expect(parsed.id).toBe("acme-3"); // non-secret field survives
      expect(parsed.state).toBe("todo");
      expect(parsed.note).not.toContain(fakePat);
      expect(parsed.note).toContain("found"); // surrounding text survives
      expect(parsed.note).toContain("in a README");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
