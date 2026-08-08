/**
 * probe.ts tests (kobo-853).
 *
 * One test per silent exit of company-policy.sh — the point of the card is that
 * "did not arrive" must name WHICH exit, so each stage gets its own assertion on
 * `stage`, not just on `ok`. Plus fresh / behind / unknown for the on-disk brain
 * clone, including the case a plain entry-count probe cannot see (behind clone,
 * unchanged entry count).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  probePolicyInject,
  brainFreshnessAt,
  countBrainEntries,
  type PolicyProbeDeps,
  type BrainFreshness,
} from "./probe";
import { BRAIN_SECTION_HEADING } from "./inject";

const INJECT_OK = [
  "## Department (company policy — active while attached)",
  "- Company: kobo",
  "",
  `${BRAIN_SECTION_HEADING} (อ่าน entry เต็มจาก /x/kobo-brain/ψ/memory/learnings เมื่อต้องใช้)`,
  "",
  "- `alpha` — hook one",
  "- `beta` — hook two",
].join("\n");

/** Policy arrived, brain section did not — and the policy half uses the same bullet shape. */
const INJECT_NO_BRAIN = [
  "## Department (company policy — active while attached)",
  "- Company: kobo",
  "",
  "# นโยบายบริษัท",
  "- `sign-gate` — a policy bullet, not a brain entry",
].join("\n");

function deps(over: Partial<PolicyProbeDeps> = {}): PolicyProbeDeps {
  return {
    hookInstalled: () => true,
    hasJq: () => true,
    resolveOracle: () => "eq3",
    fetchInject: async () => ({ ok: true, inject: INJECT_OK }),
    attachOf: () => ({ company: "kobo", dept: "core" }),
    brainFreshness: () => ({ state: "fresh", upstream: "origin/main" }) as BrainFreshness,
    brainPathOf: (c: string) => `/x/${c}-brain`,
    ...over,
  };
}

describe("probePolicyInject — the four silent exits, each named", () => {
  it("hook not installed → stage 'hook'", async () => {
    const r = await probePolicyInject(deps({ hookInstalled: () => false }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("hook");
    expect(r.fix).toContain("setup-hooks");
  });

  it("jq missing → stage 'jq' (the hook's first line)", async () => {
    const r = await probePolicyInject(deps({ hasJq: () => false }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("jq");
    expect(r.reason).toContain("jq");
  });

  it("oracle name unresolved → stage 'oracle'", async () => {
    const r = await probePolicyInject(deps({ resolveOracle: () => "  " }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("oracle");
    expect(r.oracle).toBeNull();
  });

  it("server unreachable / slower than 2s → stage 'server', and the oracle is still reported", async () => {
    const r = await probePolicyInject(deps({
      fetchInject: async () => ({ ok: false, inject: "", error: "timed out" }),
    }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("server");
    expect(r.oracle).toBe("eq3");
    expect(r.reason).toContain("timed out");
  });

  it("empty inject + no attach marker → stage 'inject', says NOT ATTACHED", async () => {
    const r = await probePolicyInject(deps({
      fetchInject: async () => ({ ok: true, inject: "" }),
      attachOf: () => null,
    }));
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("inject");
    expect(r.reason).toContain("no attach marker");
  });

  it("empty inject WITH an attach marker → stage 'inject', distinct diagnosis (registry/policy files)", async () => {
    const r = await probePolicyInject(deps({
      fetchInject: async () => ({ ok: true, inject: "   \n  " }),
    }));
    expect(r.stage).toBe("inject");
    expect(r.reason).toContain("EMPTY inject");
    expect(r.company).toBe("kobo");
    expect(r.fix).toContain("maw company sync kobo");
  });

  it("never consults the network/git once an earlier stage already failed", async () => {
    let fetched = 0, freshnessChecked = 0;
    const r = await probePolicyInject(deps({
      hasJq: () => false,
      fetchInject: async () => { fetched++; return { ok: true, inject: INJECT_OK }; },
      brainFreshness: () => { freshnessChecked++; return { state: "fresh", upstream: "origin/main" }; },
    }));
    expect(r.stage).toBe("jq");
    expect(fetched).toBe(0);
    expect(freshnessChecked).toBe(0);
  });
});

describe("probePolicyInject — arrival + brain staleness", () => {
  it("inject arrives with a fresh clone → ok, stage null, entries counted", async () => {
    const r = await probePolicyInject(deps());
    expect(r.ok).toBe(true);
    expect(r.stage).toBeNull();
    expect(r.entries).toBe(2);
    expect(r.brain).toEqual({ state: "fresh", upstream: "origin/main" });
  });

  it("AC3: clone BEHIND origin → not ok, even though the inject arrived with the SAME entry count", async () => {
    const fresh = await probePolicyInject(deps());
    const stale = await probePolicyInject(deps({
      brainFreshness: () => ({ state: "behind", behind: 44, upstream: "origin/main" }),
    }));

    // The failure this catches: entry count is identical, content is not.
    expect(stale.entries).toBe(fresh.entries);
    expect(stale.ok).toBe(false);
    expect(stale.stage).toBeNull(); // arrived — it is stale, not missing
    expect(stale.reason).toContain("44 commits behind");
    expect(stale.fix).toContain("pull --ff-only");
  });

  it("inject arrives with NO brain section → NOT ok, stage 'brain', entries 0 (the false green this PR fixes)", async () => {
    const r = await probePolicyInject(deps({ fetchInject: async () => ({ ok: true, inject: INJECT_NO_BRAIN }) }));
    expect(r.entries).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("brain");
    expect(r.reason).toContain("NO brain INDEX section");
    expect(r.company).toBe("kobo");
  });

  it("a missing brain section short-circuits BEFORE the freshness check — nothing to compare", async () => {
    let checked = 0;
    const r = await probePolicyInject(deps({
      fetchInject: async () => ({ ok: true, inject: INJECT_NO_BRAIN }),
      brainFreshness: () => { checked++; return { state: "fresh", upstream: "origin/main" }; },
    }));
    expect(r.stage).toBe("brain");
    expect(checked).toBe(0);
  });

  it("freshness unmeasurable → stays ok but is reported as unknown, NEVER as fresh", async () => {
    const r = await probePolicyInject(deps({
      brainFreshness: () => ({ state: "unknown", reason: "git fetch failed (offline)" }),
    }));
    expect(r.ok).toBe(true);
    expect(r.brain?.state).toBe("unknown");
    expect(JSON.stringify(r.brain)).not.toContain("fresh");
  });

  it("inject arrives for an oracle with no attach marker company → no brain comparison attempted", async () => {
    let checked = 0;
    const r = await probePolicyInject(deps({
      attachOf: () => null,
      brainFreshness: () => { checked++; return { state: "fresh", upstream: "origin/main" }; },
    }));
    expect(r.ok).toBe(true);
    expect(r.brain).toBeNull();
    expect(checked).toBe(0);
  });
});

describe("brainFreshnessAt", () => {
  let tmp: string;
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "brain-probe-")); });
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  const gitOk = (out: Record<string, string>) => (_d: string, args: string[]): string | null => {
    if (args[0] === "rev-parse") return out.upstream ?? "origin/main";
    if (args[0] === "fetch") return out.fetch === "fail" ? null : "";
    if (args[0] === "rev-list") return out.behind ?? "0";
    return null;
  };

  it("missing clone → unknown, naming the path", () => {
    const r = brainFreshnessAt(join(tmp, "nope"), gitOk({}));
    expect(r.state).toBe("unknown");
    expect((r as { reason: string }).reason).toContain("no brain clone on disk");
  });

  it("up to date → fresh", () => {
    expect(brainFreshnessAt(tmp, gitOk({ behind: "0" }))).toEqual({ state: "fresh", upstream: "origin/main" });
  });

  it("trailing the remote → behind, with the count", () => {
    expect(brainFreshnessAt(tmp, gitOk({ behind: "44" }))).toEqual({ state: "behind", behind: 44, upstream: "origin/main" });
  });

  it("fetch fails (offline) → unknown, and explicitly says it was not measured", () => {
    const r = brainFreshnessAt(tmp, gitOk({ fetch: "fail" }));
    expect(r.state).toBe("unknown");
    expect((r as { reason: string }).reason).toContain("NOT measured");
  });

  it("no upstream branch → unknown before any fetch is attempted", () => {
    let fetched = 0;
    const r = brainFreshnessAt(tmp, (_d, args) => {
      if (args[0] === "rev-parse") return null;
      if (args[0] === "fetch") fetched++;
      return "";
    });
    expect(r.state).toBe("unknown");
    expect(fetched).toBe(0);
  });

  it("rev-list unparseable → unknown, not a silent 0/fresh", () => {
    const r = brainFreshnessAt(tmp, (_d, args) => (args[0] === "rev-list" ? "not-a-number" : args[0] === "rev-parse" ? "origin/main" : ""));
    expect(r.state).toBe("unknown");
  });

});

describe("countBrainEntries", () => {
  it("counts the INDEX entry lines inside the brain section", () => {
    expect(countBrainEntries(INJECT_OK)).toBe(2);
  });

  it("ignores headings, prose and plain bullets inside the section", () => {
    expect(countBrainEntries(`${BRAIN_SECTION_HEADING} (x)\n# INDEX\n- plain bullet\ntext \`x\`\n- \`real\` — hook`)).toBe(1);
  });

  it("does NOT count policy bullets that sit ABOVE the brain heading", () => {
    const inject = [
      "## Department (company policy — active while attached)",
      "- `sign-gate` — policy prose that happens to use the same bullet shape",
      `${BRAIN_SECTION_HEADING} (อ่าน entry เต็มจาก /x เมื่อต้องใช้)`,
      "- `only-this-one` — hook",
    ].join("\n");
    expect(countBrainEntries(inject)).toBe(1);
  });

  it("no brain heading at all → 0, however many policy bullets there are", () => {
    // The live shape this fixes: pgw's company.md carries one `- \`x\`` bullet, so a
    // whole-inject grep reported "brain INDEX: 1 entries" for a company with no brain repo.
    expect(countBrainEntries("## Company (policy)\n- `a` — x\n- `b` — y")).toBe(0);
  });

  it("empty inject → 0", () => {
    expect(countBrainEntries("")).toBe(0);
  });
});
