import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addTask,
  claimTask,
  completeTask,
  findTaskByPr,
  parsePrNumber,
  reviewTask,
  setTaskPr,
  taskNextAction,
  type TaskRecord,
} from "./store";

const dir = mkdtempSync(join(tmpdir(), "maw-review-"));
const prev = process.env.MAW_DATA_DIR;
beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

const mk = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "pgw-1", title: "t", company: "pgw", state: "todo", by: "eq3", assignee: null, ts: 1, ...over,
});

describe("review flow (Track 4)", () => {
  test("reviewTask → review state + reviewer/reason", () => {
    addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork" });
    const t = reviewTask("pgw", "pgw-1", "patchwork", { to: "eq3", reason: "check logic" })!;
    expect(t.state).toBe("review");
    expect(t.reviewer).toBe("eq3");
    expect(t.reviewReason).toBe("check logic");
  });

  test("reviewTask with no --to → anyone can review (reviewer unset)", () => {
    addTask({ company: "pgw", title: "x", by: "eq3" });
    const t = reviewTask("pgw", "pgw-1", "eq3")!;
    expect(t.state).toBe("review");
    expect(t.reviewer).toBeUndefined();
  });

  test("claim from review = hand-off → in-progress, clears reviewer (ADR exit)", () => {
    addTask({ company: "pgw", title: "x", by: "eq3" });
    reviewTask("pgw", "pgw-1", "eq3", { to: "patchwork" });
    const t = claimTask("pgw", "pgw-1", "patchwork")!;
    expect(t.state).toBe("in-progress");
    expect(t.assignee).toBe("patchwork");
    expect(t.reviewer).toBeUndefined();
  });

  test("setTaskPr → attaches PR + moves to review", () => {
    addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork" });
    const t = setTaskPr("pgw", "pgw-1", 53, "patchwork")!;
    expect(t.pr).toBe(53);
    expect(t.state).toBe("review");
  });

  test("findTaskByPr finds the non-done task carrying a PR (PR-watch auto-done)", () => {
    addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", "pgw-1", 53, "patchwork");
    expect(findTaskByPr("pgw", 53)?.id).toBe("pgw-1");
    completeTask("pgw", "pgw-1", "tony");
    expect(findTaskByPr("pgw", 53)).toBeNull(); // done tasks excluded
  });

  test("parsePrNumber extracts the PR number from a reply with a GH url", () => {
    expect(parsePrNumber("done → https://github.com/meganechan/maw-js/pull/53 ✅")).toBe(53);
    expect(parsePrNumber("no link here")).toBeNull();
    expect(parsePrNumber("just #53 mentioned")).toBeNull(); // only real PR urls
  });
});

describe("taskNextAction — every state answers 'what next + who'", () => {
  test("never empty across all states", () => {
    for (const s of ["backlog", "todo", "in-progress", "review", "done", "blocked"] as const) {
      expect(taskNextAction(mk({ state: s })).length).toBeGreaterThan(0);
    }
  });
  test("in-progress: wait-for vs working", () => {
    expect(taskNextAction(mk({ state: "in-progress", by: "eq3", assignee: "patchwork" }))).toBe("eq3 รอ patchwork");
    expect(taskNextAction(mk({ state: "in-progress", by: "eq3", assignee: "eq3" }))).toBe("eq3 กำลังทำ");
    expect(taskNextAction(mk({ state: "in-progress", assignee: null }))).toBe("รอคนหยิบ");
  });
  test("review: reviewer vs PR", () => {
    expect(taskNextAction(mk({ state: "review", reviewer: "eq3" }))).toBe("รอ eq3 ตรวจ");
    expect(taskNextAction(mk({ state: "review" }))).toBe("รอ ใครก็ได้ ตรวจ");
  });

  // kobo-594 — a card with all signs in + a PR link used to read as "just needs a
  // merge click" with NOTHING checking whether the PR was actually mergeable on
  // GitHub. Proven live: alpha absorbing sibling PRs flipped #371/#375 CONFLICTING
  // in the same minute while their cards still said "รอ merge" — no field on the
  // board represented real PR state at all.
  describe("review + PR: mergeable state must be checked, never assumed (kobo-594)", () => {
    test("prMergeable never set (never successfully checked) → must NOT read as ready", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53 }));
      expect(next).toContain("PR #53");
      expect(next).toContain("ยังไม่เคยเช็ค"); // explicit "not confirmed" caveat
      expect(next).not.toBe("รอ merge PR #53 → done"); // the OLD bare claim must not survive unqualified
    });

    test("GitHub's own UNKNOWN (lazy-compute-pending) gets the same not-confirmed treatment as never-checked", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "UNKNOWN", prMergeStateStatus: "UNKNOWN", prMergeCheckedTs: Date.now() }));
      expect(next).toContain("ยังไม่เคยเช็ค");
    });

    // kobo-594 — live evidence eq3 measured while merging this batch of PRs
    // (not a hypothetical): the SAME UNKNOWN value resolved to BOTH real states
    // on re-check — #375/#371 UNKNOWN → CONFLICTING after merging 576, #588
    // UNKNOWN → MERGEABLE after merging 592. UNKNOWN alone carries zero
    // direction — defaulting it to "ready" (the old bug) would have merged
    // straight over a real conflict.
    test("UNKNOWN resolves EITHER direction on re-check — proves it can never be treated as ready by default", () => {
      const stillUnknown = mk({ state: "review", pr: 371, prMergeable: "UNKNOWN", prMergeStateStatus: "UNKNOWN", prMergeCheckedTs: Date.now() });
      expect(taskNextAction(stillUnknown)).toContain("ยังไม่เคยเช็ค");

      const resolvedConflicting = { ...stillUnknown, prMergeable: "CONFLICTING", prMergeStateStatus: "DIRTY" };
      expect(taskNextAction(resolvedConflicting)).toContain("conflict");

      const resolvedMergeable = { ...stillUnknown, pr: 377, prMergeable: "MERGEABLE", prMergeStateStatus: "CLEAN" };
      expect(taskNextAction(resolvedMergeable)).toContain("รอ merge PR #377 → done");
    });

    test("prMergeable CONFLICTING → explicit conflict warning, distinct from ready", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "CONFLICTING", prMergeStateStatus: "DIRTY", prMergeCheckedTs: Date.now() }));
      expect(next).toContain("conflict");
      expect(next).toContain("PR #53");
      expect(next).not.toContain("รอ merge PR #53 → done");
    });

    test("prMergeable MERGEABLE → reads as ready, the original message", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "MERGEABLE", prMergeStateStatus: "CLEAN", prMergeCheckedTs: Date.now() }));
      expect(next).toContain("รอ merge PR #53 → done");
      expect(next).not.toContain("conflict");
      expect(next).not.toContain("ยังไม่เคยเช็ค");
    });

    test("checked timestamp is readable in the message when present — staleness must not be silent", () => {
      const tenMinAgo = Date.now() - 10 * 60_000;
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "MERGEABLE", prMergeStateStatus: "CLEAN", prMergeCheckedTs: tenMinAgo }));
      expect(next).toContain("10 นาทีที่แล้ว");
    });
  });
  test("blocked surfaces the kind + who-clears + why", () => {
    expect(taskNextAction(mk({ state: "blocked", block: { kind: "needs_input", for: "tony", reason: "approve" } }))).toBe("⚑ [needs_input] รอ tony: approve");
    expect(taskNextAction(mk({ state: "blocked", block: { kind: "transient" } }))).toBe("⚑ [transient]");
  });
});
