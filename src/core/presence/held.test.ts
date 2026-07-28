import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { heldWorkByOracle, pendingTasksByOracle } from "./held";
import { appendWorklog } from "../worklog/store";
import { addTask, claimTask, completeTask, moveTask, rejectTask } from "../tasks/store";

const dir = mkdtempSync(join(tmpdir(), "maw-held-"));
const prev = process.env.MAW_DATA_DIR;

function claim(company: string, oracle: string, task: string) {
  appendWorklog({ ts: 1, iso: "x", oracle, company, kind: "claim", summary: `claim: ${task}`, task });
}
function release(company: string, oracle: string, task: string) {
  appendWorklog({ ts: 2, iso: "x", oracle, company, kind: "claim-release", summary: `release: ${task}`, task });
}

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  // in-progress card held by patchwork
  const t = addTask({ company: "kobo", title: "wire route", by: "eq3", repo: "meganechan/maw-js" });
  claimTask("kobo", t.id, "patchwork"); // → in-progress, assignee=patchwork
  // a done card must NOT count as held
  const done = addTask({ company: "kobo", title: "old thing", by: "eq3" });
  claimTask("kobo", done.id, "somsri");
  completeTask("kobo", done.id, "somsri");
  // a todo card (assignee, not started) must NOT count — only in-progress
  addTask({ company: "kobo", title: "future", by: "eq3", assignee: "neo", state: "todo" });
  // open worklog claim held by eq3
  claim("kobo", "eq3", "kobo-200");
  // a released claim must NOT count
  claim("kobo", "neo", "kobo-201");
  release("kobo", "neo", "kobo-201");
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("heldWorkByOracle", () => {
  test("folds in-progress cards + open claims per oracle, ignoring done/todo/released", () => {
    const held = heldWorkByOracle("kobo");

    // patchwork: one in-progress card
    expect(held.patchwork).toBeDefined();
    expect(held.patchwork.length).toBe(1);
    expect(held.patchwork[0].kind).toBe("card");
    expect(held.patchwork[0].title).toBe("wire route");

    // eq3: one open claim (no card)
    expect(held.eq3.length).toBe(1);
    expect(held.eq3[0].kind).toBe("claim");
    expect(held.eq3[0].id).toBe("kobo-200");

    // somsri completed their card → not held; neo's card is todo + claim released → not held
    expect(held.somsri).toBeUndefined();
    expect(held.neo).toBeUndefined();
  });

  test("a card and a claim for the SAME id fold to one entry (card wins, keeps title)", () => {
    const koboTasks = heldWorkByOracle("kobo");
    const cardId = koboTasks.patchwork[0].id;
    claim("kobo", "patchwork", cardId); // patchwork also has a raw claim on its own card
    const after = heldWorkByOracle("kobo");
    expect(after.patchwork.length).toBe(1); // still one — deduped by id
    expect(after.patchwork[0].kind).toBe("card"); // card pushed first, claim skipped
    expect(after.patchwork[0].title).toBe("wire route");
  });

  test("null / empty company → empty map, never throws", () => {
    expect(heldWorkByOracle(null)).toEqual({});
    expect(heldWorkByOracle("no-such-company")).toEqual({});
  });
});

describe("pendingTasksByOracle", () => {
  let reviewCardId: string;
  let rejectedCardId: string;

  beforeAll(() => {
    // kobo-445: pending is the FULLER set — todo counts here (heldWorkByOracle
    // excludes it), and a rejected card must NOT count (terminal, like done).
    const review = addTask({ company: "kobo", title: "in review", by: "eq3", assignee: "patchwork", state: "review" });
    reviewCardId = review.id;
    const rejected = addTask({ company: "kobo", title: "rejected thing", by: "eq3", assignee: "neo", state: "todo" });
    rejectedCardId = rejected.id;
    moveTask("kobo", rejectedCardId, "in-progress", "neo");
    rejectTask("kobo", rejectedCardId, "eq3", "not needed");
  });

  test("includes every non-terminal state (todo/in-progress/review/…), not just in-progress", () => {
    const pending = pendingTasksByOracle("kobo");

    // neo: the outer-scope todo card ("future") — heldWorkByOracle excludes this, pending includes it
    expect(pending.neo?.some((p) => p.title === "future" && p.state === "todo")).toBe(true);

    // patchwork: both the in-progress card AND the review card
    expect(pending.patchwork?.some((p) => p.id === reviewCardId && p.state === "review")).toBe(true);
    expect(pending.patchwork?.some((p) => p.title === "wire route" && p.state === "in-progress")).toBe(true);
  });

  test("done and rejected are excluded — a closed card drops off the list", () => {
    const pending = pendingTasksByOracle("kobo");

    expect(pending.somsri).toBeUndefined(); // done card from the outer fixture
    expect(pending.neo?.some((p) => p.id === rejectedCardId)).toBe(false); // rejected in this describe
  });

  test("unassigned tasks are never surfaced (no owner to attribute pending work to)", () => {
    addTask({ company: "kobo", title: "nobody's yet", by: "eq3" }); // no assignee, state defaults to todo
    const pending = pendingTasksByOracle("kobo");
    for (const arr of Object.values(pending)) {
      expect(arr.some((p) => p.title === "nobody's yet")).toBe(false);
    }
  });

  test("sorted newest-first per oracle by updatedTs", () => {
    const pending = pendingTasksByOracle("kobo");
    const patchworkTs = pending.patchwork!.map((p) => p.updatedTs);
    expect(patchworkTs).toEqual([...patchworkTs].sort((a, b) => b - a));
  });

  test("null / empty company → empty map, never throws", () => {
    expect(pendingTasksByOracle(null)).toEqual({});
    expect(pendingTasksByOracle("no-such-company")).toEqual({});
  });
});
