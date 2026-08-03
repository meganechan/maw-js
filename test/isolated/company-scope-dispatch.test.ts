import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// kobo-341: cross-company dispatch guard. A dispatch target must be reachable WITHIN
// the company — a member (dept oracle or the company manager) or a human — else the
// notify path pings a cross-company fleet pane (kobo-334). Hermetic: sandbox
// MAW_DATA_DIR + MAW_TEST_MODE (no live delivery) + CLAUDE_AGENT_NAME=eq3.
//
// The write-time half of this file drove the guard through a real task WRITE verb
// (`runTask`); that verb retired with the task subsystem, so only the unit contract
// remains here. companyScopeViolation itself is unchanged and still enforced by
// crossCompanyDeliveryRefusal on the hey delivery path.

const dir = mkdtempSync(join(tmpdir(), "maw-coscope-"));
const prev = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevTest = process.env.MAW_TEST_MODE;
// MUST set BEFORE importing — company-helpers caches COMPANIES_DIR at module load, so the
// scope guard's loadCompany reads THIS sandbox, not the real ~/.maw/companies.
process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
// pgw: manager=eq3 (above depts), dept core members thawanban + somsri. patchwork NOT a member.
writeFileSync(join(dir, "companies", "pgw.json"),
  JSON.stringify({ name: "pgw", manager: "eq3", teams: { core: { members: [{ oracle: "thawanban" }, { oracle: "somsri" }], lead: "thawanban" } } }));

const { companyScopeViolation } = await import("../../src/core/worklog/company-scope");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;

// CLAUDE_AGENT_NAME + MAW_TEST_MODE read at call-time → beforeAll (no top-level bleed, kobo-335).
// COMPANIES_DIR is shared module state cached by the FIRST importer in a batch, so top-level
// MAW_DATA_DIR-before-import isn't enough — point it at THIS sandbox explicitly + restore.
beforeAll(() => {
  process.env.CLAUDE_AGENT_NAME = "eq3";
  process.env.MAW_TEST_MODE = "1";
  _setCompaniesDir(join(dir, "companies"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE; else process.env.MAW_TEST_MODE = prevTest;
  _setCompaniesDir(prevCompaniesDir);
  rmSync(dir, { recursive: true, force: true });
});
describe("kobo-341 companyScopeViolation (unit)", () => {
  test("dept member → allowed (null)", () => expect(companyScopeViolation("pgw", "thawanban")).toBeNull());
  test("company manager (above depts) → allowed", () => expect(companyScopeViolation("pgw", "eq3")).toBeNull());
  test("human / tony / any → allowed", () => {
    expect(companyScopeViolation("pgw", "human")).toBeNull();
    expect(companyScopeViolation("pgw", "tony")).toBeNull();
    expect(companyScopeViolation("pgw", "any")).toBeNull();
  });
  test("empty / undefined → allowed (nothing to guard)", () => {
    expect(companyScopeViolation("pgw", "")).toBeNull();
    expect(companyScopeViolation("pgw", undefined)).toBeNull();
  });
  test("oracle fully outside company → REFUSE with clear error", () => {
    const v = companyScopeViolation("pgw", "patchwork");
    expect(v).not.toBeNull();
    expect(v).toContain("patchwork");
    expect(v).toContain("pgw");
    expect(v).toContain("cross-company");
  });
});
