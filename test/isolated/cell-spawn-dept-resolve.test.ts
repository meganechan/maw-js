import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// kobo cell-spawn-dept-resolve: cellSelfSpawn's Dept resolution read
// loadConfig().oracle — a generic maw-js family identity, never the specific
// oracle instance a company roster keys members on — so the lookup always
// missed and head-contract.md rendered a blank Dept line. Fixed by resolving
// the pane's own identity via selfOracleId() (CLAUDE_AGENT_NAME here —
// hermetic, no live tmux). Sandbox pattern mirrors company-scope-dispatch.test.ts.

const dir = mkdtempSync(join(tmpdir(), "maw-cell-dept-"));
const prevDataDir = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
// MUST set BEFORE importing — company-helpers caches COMPANIES_DIR at module load.
process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
// kobo: manager=eq3 (above depts, no dept), dept "utils" has utils-worker.
writeFileSync(join(dir, "companies", "kobo.json"),
  JSON.stringify({ name: "kobo", manager: "eq3", teams: { utils: { members: [{ oracle: "utils-worker" }], lead: "utils-worker" } } }));

const { resolveSelfDept } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;

beforeAll(() => {
  _setCompaniesDir(join(dir, "companies"));
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  _setCompaniesDir(prevCompaniesDir);
  rmSync(dir, { recursive: true, force: true });
});

describe("cell-spawn-dept-resolve resolveSelfDept (unit)", () => {
  test("oracle in a roster dept → contract carries that dept", () => {
    process.env.CLAUDE_AGENT_NAME = "utils-worker";
    expect(resolveSelfDept()).toBe("utils");
  });

  test("company-level manager (genuinely no dept) → explicit '(none)', not blank", () => {
    process.env.CLAUDE_AGENT_NAME = "eq3";
    expect(resolveSelfDept()).toBe("(none)");
  });

  test("unresolvable identity (not in any roster, no crash) → explicit '(none)'", () => {
    process.env.CLAUDE_AGENT_NAME = "some-unknown-oracle";
    expect(() => resolveSelfDept()).not.toThrow();
    expect(resolveSelfDept()).toBe("(none)");
  });
});
