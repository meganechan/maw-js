import { describe, expect, test } from "bun:test";
import { orderCommentTree, foldableResolvedIds, newestVisibleCommentId, waitingForTony, companyHtml } from "./company";

// A comment factory — id, replyTo, ts, author. ts drives sibling order.
const c = (id: string, replyTo: string | null, ts: number, by = "sapan") => ({ id, replyTo, ts, by, text: id + " body" });
const ids = (nodes: { c: { id: string } }[]) => nodes.map((n) => n.c.id);
const indentOf = (nodes: { c: { id: string }; indent: number }[], id: string) => nodes.find((n) => n.c.id === id)!.indent;
const depthOf = (nodes: { c: { id: string }; depth: number }[], id: string) => nodes.find((n) => n.c.id === id)!.depth;

describe("orderCommentTree (kobo-171)", () => {
  test("linear depth-4 thread: all 4 present, DFS order, indent clamps at 2", () => {
    const out = orderCommentTree([c("c1", null, 1), c("c2", "c1", 2), c("c3", "c2", 3), c("c4", "c3", 4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]); // NONE dropped (the bug)
    expect([depthOf(out, "c1"), depthOf(out, "c2"), depthOf(out, "c3"), depthOf(out, "c4")]).toEqual([0, 1, 2, 3]);
    expect([indentOf(out, "c1"), indentOf(out, "c2"), indentOf(out, "c3"), indentOf(out, "c4")]).toEqual([0, 1, 2, 2]); // clamp
  });

  test("sibling branch (c2↳c1, c3↳c1, c4↳c2): DFS keeps c2's subtree contiguous", () => {
    // c1 root; c2,c3 reply c1; c4 replies c2 → order c1, c2, c4, c3
    const out = orderCommentTree([c("c1", null, 1), c("c2", "c1", 2), c("c3", "c1", 3), c("c4", "c2", 4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c4", "c3"]);
    expect(indentOf(out, "c4")).toBe(2);
  });

  test("siblings ordered by ts, not input order", () => {
    const out = orderCommentTree([c("c3", "c1", 30), c("c1", null, 10), c("c2", "c1", 20)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3"]);
  });

  test("dangling replyTo (parent missing) is surfaced as a root — never dropped", () => {
    const out = orderCommentTree([c("c1", null, 1), c("c9", "cGONE", 2)]);
    expect(ids(out).sort()).toEqual(["c1", "c9"]);
    expect(depthOf(out, "c9")).toBe(0);
  });

  test("cycle in replyTo does not hang and drops nothing", () => {
    // a↔b reference each other — neither is a natural root; sweep must still surface both
    const out = orderCommentTree([c("a", "b", 1), c("b", "a", 2)]);
    expect(ids(out).sort()).toEqual(["a", "b"]);
  });

  test("multi-root threads render each root's subtree in a block", () => {
    const out = orderCommentTree([c("c1", null, 1), c("c2", "c1", 2), c("c3", null, 3), c("c4", "c3", 4)]);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("every comment appears exactly once (drop + dup guard)", () => {
    const input = [c("c1", null, 1), c("c2", "c1", 2), c("c3", "c2", 3), c("c4", "c1", 4), c("c5", "c3", 5)];
    const out = orderCommentTree(input);
    expect(out.length).toBe(input.length);
    expect(new Set(ids(out)).size).toBe(input.length);
  });
});

// r = a resolved comment; u = unresolved. ts drives sibling order.
const r = (id: string, replyTo: string | null, ts: number) => ({ id, replyTo, ts, by: "sapan", text: id, resolved: true });
const u = (id: string, replyTo: string | null, ts: number) => ({ id, replyTo, ts, by: "sapan", text: id, resolved: false });
const has = (set: Set<string>) => [...set].sort();

describe("foldableResolvedIds (kobo-176)", () => {
  test("a resolved leaf folds", () => {
    expect(has(foldableResolvedIds([u("c1", null, 1), r("c2", "c1", 2)]))).toEqual(["c2"]);
  });
  test("an unresolved comment never folds", () => {
    expect(foldableResolvedIds([u("c1", null, 1)]).size).toBe(0);
  });
  test("a resolved comment with an unresolved descendant stays visible (no orphan)", () => {
    // c1 resolved → c2 resolved → c3 UNRESOLVED. c1,c2 must NOT fold (ancestors of active reply)
    const set = foldableResolvedIds([r("c1", null, 1), r("c2", "c1", 2), u("c3", "c2", 3)]);
    expect(set.size).toBe(0);
  });
  test("a fully-resolved branch folds entirely; a sibling active branch keeps its resolved ancestor shown", () => {
    // c1 resolved root; c2 resolved-leaf (folds); c3 resolved but has unresolved child c4 (c3 shown)
    const set = foldableResolvedIds([r("c1", null, 1), r("c2", "c1", 2), r("c3", "c1", 3), u("c4", "c3", 4)]);
    // c1 has unresolved descendant c4 → shown; c3 shown; only c2 folds
    expect(has(set)).toEqual(["c2"]);
  });
  test("all-resolved thread folds every node", () => {
    expect(has(foldableResolvedIds([r("c1", null, 1), r("c2", "c1", 2), r("c3", "c2", 3)]))).toEqual(["c1", "c2", "c3"]);
  });
});

describe("companyHtml injection (kobo-171 + kobo-176)", () => {
  test("the served client script contains the walker + fold fns and calls them (single source)", () => {
    const html = companyHtml();
    expect(html).toContain("function orderCommentTree"); // injected verbatim
    expect(html).toContain("orderCommentTree(comments)"); // and consumed by the renderer
    expect(html).toContain("function foldableResolvedIds"); // kobo-176 injected
    expect(html).toContain("foldableResolvedIds(comments)"); // and consumed
    expect(html).toContain("function newestVisibleCommentId"); // kobo-180 injected
    expect(html).toContain("scrollToNewestComment(task)"); // and called on open
    expect(html).toContain("function waitingForTony"); // kobo-187 injected
    expect(html).toContain("renderApprovalQueue(tasks)"); // and rendered on the board
    expect(html).toContain("'✅ Tony approved'"); // approve = mark-only comment
    expect(html).not.toContain("/api/tasks/merge"); // golden rule: never auto-merge
  });
});

describe("waitingForTony (kobo-187)", () => {
  const t = (o: Record<string, unknown>) => ({ id: "k-1", state: "review", by: "eq3", assignee: "patchwork", ...o });
  const q = (tasks: unknown[]) => waitingForTony(tasks).map((x: { id: string }) => x.id);
  test("review + explicit reviewer=tony → in queue", () => {
    expect(q([t({ id: "a", reviewer: "tony" })])).toEqual(["a"]);
  });
  test("review + reviewer resolves to human (creator IS the doer) → in queue", () => {
    expect(q([t({ id: "b", by: "patchwork", assignee: "patchwork" })])).toEqual(["b"]); // reviewerOf → human
  });
  test("review + another reviewer (eq3) → NOT in queue", () => {
    expect(q([t({ id: "c", reviewer: "eq3" })])).toEqual([]);
    expect(q([t({ id: "d", by: "eq3", assignee: "patchwork" })])).toEqual([]); // reviewerOf → eq3
  });
  test("ready state → in queue (bug-report / decision gate)", () => {
    expect(q([t({ id: "e", state: "ready" })])).toEqual(["e"]);
  });
  test("blocked for tony/human/lead → in; blocked for a peer → out", () => {
    expect(q([t({ id: "f", state: "blocked", block: { for: "tony", kind: "needs_input" } })])).toEqual(["f"]);
    expect(q([t({ id: "g", state: "blocked", block: { for: "eq3", kind: "dependency" } })])).toEqual([]);
  });
  test("done / in-progress / todo → never in queue", () => {
    expect(q([t({ id: "h", state: "done", reviewer: "tony" }), t({ id: "i", state: "in-progress" }), t({ id: "j", state: "todo" })])).toEqual([]);
  });
  test("empty / null → empty", () => {
    expect(waitingForTony([])).toEqual([]);
    expect(waitingForTony(null)).toEqual([]);
  });
});

describe("newestVisibleCommentId (kobo-180)", () => {
  const r = (id: string, ts: number) => ({ id, replyTo: null, ts, by: "sapan", text: id, resolved: true });
  const u = (id: string, ts: number) => ({ id, replyTo: null, ts, by: "sapan", text: id, resolved: false });
  test("picks the newest comment by ts", () => {
    expect(newestVisibleCommentId([u("c1", 1), u("c2", 3), u("c3", 2)], new Set())).toBe("c2");
  });
  test("newest is folded → falls back to the newest VISIBLE one", () => {
    // c3 is newest but resolved-leaf (folded) → target c2 (newest unresolved)
    const comments = [u("c1", 1), u("c2", 2), r("c3", 3)];
    const folded = foldableResolvedIds(comments); // {c3}
    expect(newestVisibleCommentId(comments, folded)).toBe("c2");
  });
  test("all comments folded → null (nothing visible to scroll to)", () => {
    const comments = [r("c1", 1), r("c2", 2)];
    expect(newestVisibleCommentId(comments, foldableResolvedIds(comments))).toBeNull();
  });
  test("tie on ts → later in creation order wins", () => {
    expect(newestVisibleCommentId([u("c1", 5), u("c2", 5)], new Set())).toBe("c2");
  });
  test("empty → null", () => {
    expect(newestVisibleCommentId([], new Set())).toBeNull();
  });
});
