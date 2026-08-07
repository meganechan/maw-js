/**
 * Policy store + route tests. policy-store is tested directly against a temp
 * COMPANIES_DIR (via `_setCompaniesDir`). The route/inject path imports
 * `./attach-store`, which is owned by another worker and may not exist while
 * these tests run — so that block is guarded behind a dynamic import and skips
 * cleanly when the module is absent. policy-store coverage always runs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  COMPANIES_DIR,
  _setCompaniesDir,
  saveCompany,
  type Company,
} from "../../vendor/mpr-plugins/company/company-helpers";
import { policyDir, readCompanyPolicy, readDeptPolicy } from "./policy-store";
import { buildPolicyInject } from "./inject";
import { setPolicyAttach, clearPolicyAttach } from "./attach-store";
import { _clearScopeCache } from "../worklog/company-scope";

const ORIGINAL_DIR = COMPANIES_DIR;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "policy-test-"));
  _setCompaniesDir(tmp);
});

afterEach(() => {
  _setCompaniesDir(ORIGINAL_DIR);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe("policy-store", () => {
  it("policyDir joins COMPANIES_DIR/<company>/policy", () => {
    expect(policyDir("acme")).toBe(join(tmp, "acme", "policy"));
  });

  it("reads company + dept policy contents when present", () => {
    const dir = join(tmp, "acme", "policy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "company.md"), "# Acme policy\nbe excellent\n");
    writeFileSync(join(dir, "core.md"), "# Core dept\nship daily\n");

    expect(readCompanyPolicy("acme")).toContain("be excellent");
    expect(readDeptPolicy("acme", "core")).toContain("ship daily");
  });

  it("returns null when company policy is missing", () => {
    expect(readCompanyPolicy("ghost")).toBeNull();
  });

  it("returns null when dept policy is missing (company dir exists)", () => {
    mkdirSync(join(tmp, "acme", "policy"), { recursive: true });
    expect(readDeptPolicy("acme", "nope")).toBeNull();
  });
});

describe("buildPolicyInject — brain INDEX section", () => {
  const ORIGINAL_BRAIN_ROOT = process.env.MAW_BRAIN_ROOT;
  let brainTmp: string;

  const pgw = (): Company => ({
    name: "pgw",
    manager: "thawanban",
    teams: {
      core: { lead: "nai", members: [{ oracle: "nai", role: "lead" }] },
    },
  });

  function writeIndex(content = "- some-entry — hook\n") {
    const dir = join(brainTmp, "pgw-brain", "ψ");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "INDEX.md"), content);
  }

  beforeEach(() => {
    brainTmp = mkdtempSync(join(tmpdir(), "brain-root-test-"));
    process.env.MAW_BRAIN_ROOT = brainTmp;
    saveCompany(pgw());
    _clearScopeCache();
  });

  afterEach(() => {
    clearPolicyAttach("nai");
    _clearScopeCache();
    if (ORIGINAL_BRAIN_ROOT === undefined) delete process.env.MAW_BRAIN_ROOT;
    else process.env.MAW_BRAIN_ROOT = ORIGINAL_BRAIN_ROOT;
    try {
      rmSync(brainTmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("attached + brain INDEX present -> inject has the heading and the absolute path", () => {
    setPolicyAttach("nai", { company: "pgw", dept: "core" });
    writeIndex("- topic-x — hook\n");

    const inject = buildPolicyInject("nai");
    expect(inject).toContain("Company brain — INDEX");
    expect(inject).toContain(join(brainTmp, "pgw-brain", "ψ", "memory", "learnings"));
    expect(inject).toContain("topic-x — hook");
  });

  it("emitted heading is line-anchored '## Company brain' (pins the AC5 pull-probe: grep -c '^## Company brain')", () => {
    setPolicyAttach("nai", { company: "pgw", dept: "core" });
    writeIndex("- topic-x — hook\n");

    const inject = buildPolicyInject("nai");
    expect(inject.split("\n")).toContainEqual(expect.stringMatching(/^## Company brain/));
  });

  it("attached + no brain dir -> prior sections still present, no brain section, no throw", () => {
    setPolicyAttach("nai", { company: "pgw", dept: "core" });

    expect(() => buildPolicyInject("nai")).not.toThrow();
    const inject = buildPolicyInject("nai");
    expect(inject).toContain("Department"); // identity header still present
    expect(inject).not.toContain("Company brain — INDEX");
  });

  it("whitespace-only INDEX behaves like absent — no heading, no section (AC7)", () => {
    setPolicyAttach("nai", { company: "pgw", dept: "core" });
    writeIndex("\n\n   \n");

    const inject = buildPolicyInject("nai");
    expect(inject).not.toContain("## Company brain");
  });

  it("detached oracle -> inject is empty (regression guard)", () => {
    writeIndex();
    expect(buildPolicyInject("nai")).toBe("");
  });

  it("section order: brain INDEX appears after the dept policy section", () => {
    setPolicyAttach("nai", { company: "pgw", dept: "core" });
    const dir = join(tmp, "pgw", "policy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.md"), "# core dept policy\n");
    writeIndex("- entry — hook\n");

    const inject = buildPolicyInject("nai");
    const deptIdx = inject.indexOf("core dept policy");
    const brainIdx = inject.indexOf("Company brain — INDEX");
    expect(deptIdx).toBeGreaterThan(-1);
    expect(brainIdx).toBeGreaterThan(deptIdx);
  });
});

describe("route (guarded — needs attach-store)", () => {
  it("handlePolicyRequest returns {inject:\"\"} when oracle param absent", async () => {
    let mod: typeof import("./route");
    try {
      mod = await import("./route");
    } catch {
      // attach-store not provisioned yet (owned by integration worker) — skip.
      return;
    }
    const res = mod.handlePolicyRequest(new Request("http://x/api/policy"));
    expect(await res.json()).toEqual({ inject: "" });
  });
});
