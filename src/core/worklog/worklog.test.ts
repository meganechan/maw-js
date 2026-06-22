import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { toolSummary, eventToWorklog } from "./significant";
import { renderTimeline } from "./render";
import { pingOnMerge } from "./ping";
import { appendWorklog, readWorklog } from "./store";
import type { FeedEvent } from "../../lib/feed";
import type { WorklogEntry } from "./types";

function feed(partial: Partial<FeedEvent>): FeedEvent {
  return {
    timestamp: "2026-06-22T10:05:00.000Z",
    oracle: "worker",
    host: "local",
    event: "PostToolUse",
    project: "repo",
    sessionId: "s1",
    message: "",
    ts: 1_000,
    ...partial,
  } as FeedEvent;
}

describe("significant filter (filter b)", () => {
  it("keeps git/gh Bash, drops other shell", () => {
    expect(toolSummary("Bash", { command: "git push origin feat/x" })).toBe("git push origin feat/x");
    expect(toolSummary("Bash", { command: "gh pr merge 123" })).toBe("gh pr merge 123");
    expect(toolSummary("Bash", { command: "ls -la" })).toBeNull();
    expect(toolSummary("Bash", { command: "" })).toBeNull();
  });

  it("keeps Edit/Write/MultiEdit with file path", () => {
    expect(toolSummary("Edit", { file_path: "/a/b.ts" })).toBe("Edit /a/b.ts");
    expect(toolSummary("Write", { file_path: "/a/c.ts" })).toBe("Write /a/c.ts");
  });

  it("drops read-only tools entirely", () => {
    expect(eventToWorklog(feed({ data: { tool_name: "Read", tool_input: { file_path: "/x" } } }))).toBeNull();
    expect(eventToWorklog(feed({ data: { tool_name: "Grep", tool_input: { pattern: "x" } } }))).toBeNull();
  });

  it("maps a significant PostToolUse into a tool entry", () => {
    const e = eventToWorklog(feed({ data: { tool_name: "Bash", tool_input: { command: "git commit -m x" } } }));
    expect(e).toEqual({ ts: 1_000, iso: "2026-06-22T10:05:00.000Z", oracle: "worker", kind: "tool", summary: "git commit -m x" });
  });

  it("ignores non tool-use events (PR events handled by the poller, not here)", () => {
    expect(eventToWorklog(feed({ event: "Notification", data: { kind: "pr-merged", pr: 1 } }))).toBeNull();
  });
});

describe("timeline render", () => {
  it("renders a narrative with merge attribution", () => {
    const entries: WorklogEntry[] = [
      { ts: 1, iso: "2026-06-22T10:05:00.000Z", oracle: "worker", kind: "tool", summary: "gh pr create" },
      { ts: 2, iso: "2026-06-22T10:15:00.000Z", oracle: "worker", kind: "pr-merged", summary: "merged #123 fix", pr: 123, by: "tony" },
    ];
    const out = renderTimeline(entries);
    expect(out).toContain("gh pr create");
    expect(out).toContain("merged #123 fix (by tony)");
    expect(out.split("\n").length).toBe(2);
  });

  it("handles empty log", () => {
    expect(renderTimeline([])).toContain("ว่าง");
  });
});

describe("pingOnMerge", () => {
  it("pings the author when present", () => {
    const sent: Array<[string, string]> = [];
    const pinged = pingOnMerge(
      { author: "worker", pr: 7, repo: "org/repo", by: "tony" },
      { send: (t, m) => sent.push([t, m]) },
    );
    expect(pinged).toEqual(["worker"]);
    expect(sent[0][0]).toBe("worker");
    expect(sent[0][1]).toContain("#7");
    expect(sent[0][1]).toContain("merged by tony");
  });

  it("returns nothing when there is no target", () => {
    const pinged = pingOnMerge({ author: null, pr: 1, repo: "org/repo" }, { send: () => {} });
    expect(pinged).toEqual([]);
  });
});

describe("store roundtrip", () => {
  beforeAll(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "worklog-test-"));
  });

  it("appends and reads back, honoring limit + oracle filter", () => {
    appendWorklog({ ts: 1, iso: "i1", oracle: "a", kind: "tool", summary: "git x" });
    appendWorklog({ ts: 2, iso: "i2", oracle: "b", kind: "tool", summary: "git y" });
    appendWorklog({ ts: 3, iso: "i3", oracle: "a", kind: "pr-merged", summary: "merged #1", pr: 1 });

    expect(readWorklog().length).toBe(3);
    expect(readWorklog({ limit: 1 })[0].summary).toBe("merged #1");
    expect(readWorklog({ oracle: "a" }).map(e => e.summary)).toEqual(["git x", "merged #1"]);
    expect(readWorklog({ since: 3 }).length).toBe(1);
  });
});

describe("server wiring — feed listener persists tool-calls (as in server.ts)", () => {
  beforeAll(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "worklog-wire-"));
  });

  it("a PostToolUse git event POSTed to the feed lands in the worklog; reads are dropped", async () => {
    // Mirror server.ts: registerWorklogListener(feedListeners), then drive the
    // real feed pipeline used by POST /api/feed.
    const { feedListeners, pushFeedEvent } = await import("../../api/feed");
    const { registerWorklogListener } = await import("./listener");
    registerWorklogListener(feedListeners);

    const before = readWorklog().length;
    pushFeedEvent({
      timestamp: "2026-06-22T10:05:00.000Z", oracle: "worker", host: "local",
      event: "PostToolUse", project: "repo", sessionId: "s1",
      message: "tool:Bash", ts: 5_000,
      data: { tool_name: "Bash", tool_input: { command: "git push origin feat/x" } },
    });
    pushFeedEvent({
      timestamp: "2026-06-22T10:06:00.000Z", oracle: "worker", host: "local",
      event: "PostToolUse", project: "repo", sessionId: "s1",
      message: "tool:Read", ts: 6_000,
      data: { tool_name: "Read", tool_input: { file_path: "/x" } },
    });

    const entries = readWorklog();
    // exactly one new entry — the git push; the Read event is filtered out
    expect(entries.length - before).toBe(1);
    expect(entries[entries.length - 1].summary).toBe("git push origin feat/x");
  });
});
