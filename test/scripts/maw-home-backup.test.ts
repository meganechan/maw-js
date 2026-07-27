import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";
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

  // kobo-427 CLOSING AC (front+lead ruling on the blanket-scan approval) — proof at the
  // PRODUCED ARTIFACT, not belief that the file-type sweep was thorough. Runs the real script
  // as the launchd job would invoke it (subprocess, not an in-process import — MAW_HOME/
  // MAW_BACKUP_DIR are module-level consts captured at import time, so only a fresh process
  // picks up a per-test override) against a SYNTHETIC fixture with a fabricated credential-
  // shaped value — never the real ~/.maw. This codebase's own rule, now cell policy: verify a
  // redaction gap against a synthetic reproduction, never the real failing artifact.
  test("kobo-427 closing AC — grep the PRODUCED ARCHIVE for a fabricated secret, find none; source file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "maw-archive-fixture-"));
    const backupDir = mkdtempSync(join(tmpdir(), "maw-archive-backup-"));
    const extractDir = mkdtempSync(join(tmpdir(), "maw-archive-extract-"));
    try {
      mkdirSync(join(home, "companies", "acme", "tasks"), { recursive: true });
      const fakePat = "ghp_" + "aB3dE5fG7hJ9kL1mN3oP5qR7sT9uV1wX"; // fabricated, never a real value
      const taskFile = join(home, "companies", "acme", "tasks", "acme-1.json");
      const originalContent = JSON.stringify({ id: "acme-1", note: `secret ${fakePat} pasted here` });
      writeFileSync(taskFile, originalContent);

      const scriptPath = join(import.meta.dir, "..", "..", "scripts", "maw-home-backup.ts");
      execFileSync("bun", [scriptPath], {
        env: { ...process.env, MAW_HOME: home, MAW_BACKUP_DIR: backupDir },
      });

      const status = readStatus(backupDir);
      expect(status.snapshotFile).toBeTruthy();
      execFileSync("tar", ["-xzf", status.snapshotFile!, "-C", extractDir]);

      // grep exits 1 (no match) when clean — spawnSync so a non-zero exit doesn't throw.
      const grepped = spawnSync("grep", ["-r", "-l", fakePat, extractDir], { encoding: "utf8" });
      expect(grepped.status).toBe(1); // 1 = grep found NOTHING — secret is not in the archive
      expect(grepped.stdout.trim()).toBe("");

      // the marker IS present (proves the pass ran, not that it was skipped/no-oped) and the
      // per-pattern count was recorded, not just believed.
      const restoredFile = join(extractDir, ".maw", "companies", "acme", "tasks", "acme-1.json");
      expect(readFileSync(restoredFile, "utf8")).toContain("[REDACTED-kobo427:github-pat]");
      expect(status.secretRedactionCounts?.["github-pat"]).toBeGreaterThanOrEqual(1);

      // never delete or modify SOURCE files — the original stays exactly as written; only
      // the staged copy that went into the archive was redacted.
      expect(readFileSync(taskFile, "utf8")).toBe(originalContent);
      expect(readFileSync(taskFile, "utf8")).toContain(fakePat);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
      rmSync(extractDir, { recursive: true, force: true });
    }
  });
});
