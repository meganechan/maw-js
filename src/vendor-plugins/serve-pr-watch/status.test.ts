/**
 * kobo-633 Slice 5 — CLI status readout. `cmdPrWatchStatus`'s default-sinceIso
 * behavior mirrors `route.test.ts`'s coverage of the same on-purpose rolling
 * window (see `status.ts`'s own doc comment). `formatPrWatchStatus` is a pure
 * function — plain-object fixtures, no filesystem/gh involved at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ORIG_HOME = process.env.MAW_HOME;
let root: string;
const REAL_MAW_DIR = join(homedir(), ".maw");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-status-"));
  if (root.startsWith(REAL_MAW_DIR)) throw new Error(`test root resolved UNDER the real ~/.maw: ${root}`);
  process.env.MAW_HOME = root;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = ORIG_HOME;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("cmdPrWatchStatus", () => {
  it("no sinceIso opt ⇒ rolling DEFAULT_ACCEPTANCE_LOOKBACK_MS window", async () => {
    const { cmdPrWatchStatus } = await import("./status.ts?status-default-since");
    const before = Date.now();
    const result = await cmdPrWatchStatus();
    const after = Date.now();
    const sinceMs = new Date(result.acceptance.sinceIso).getTime();
    expect(sinceMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 1000);
  });

  it("explicit sinceIso opt is honored verbatim", async () => {
    const { cmdPrWatchStatus } = await import("./status.ts?status-explicit-since");
    const explicit = "2020-06-15T00:00:00.000Z";
    const result = await cmdPrWatchStatus({ sinceIso: explicit });
    expect(result.acceptance.sinceIso).toBe(explicit);
  });
});

describe("formatPrWatchStatus", () => {
  it("renders acceptance + heartbeat + provenance lines from a passed/fresh fixture", async () => {
    const { formatPrWatchStatus } = await import("./status.ts?status-format-passed");
    const out = formatPrWatchStatus({
      acceptance: {
        verdict: "passed", reason: "all merged PRs flipped", sinceIso: "2026-01-01T00:00:00.000Z",
        mergedSinceCount: 2, limit: 30, passedCount: 2, failed: [], unlinked: [],
        provenanceClaim: "retroactive-only", provenanceReason: "backfill only, no live pass after",
      },
      diagnostics: {
        heartbeatStatus: "fresh", reason: "last pass 5s ago", snapshotFilePath: "/x/watch-pr-state.json",
        metaFilePath: "/x/watch-pr-state.meta.json", pollsCompleted: 42, lastPollCompletedAtIso: "2026-01-01T00:00:05.000Z",
        firstPollCompletedAtIso: "2026-01-01T00:00:00.000Z", ageSeconds: 5, codeVersion: "abc1234", reposTotal: 3, reposFailed: 0,
      },
    } as any);
    expect(out).toContain("acceptance: passed — all merged PRs flipped");
    expect(out).toContain("provenance: retroactive-only");
    expect(out).toContain("heartbeat: fresh — last pass 5s ago");
    expect(out).toContain("polls completed 42");
    expect(out).not.toContain("failed:"); // empty bucket must not print a label with nothing after it
    expect(out).not.toContain("unlinked:");
  });

  it("prints failed/unlinked repo#number lists when those buckets are non-empty", async () => {
    const { formatPrWatchStatus } = await import("./status.ts?status-format-failed");
    const out = formatPrWatchStatus({
      acceptance: {
        verdict: "failed", reason: "1 merged PR never flipped", sinceIso: "2026-01-01T00:00:00.000Z",
        mergedSinceCount: 2, limit: 30, passedCount: 1,
        failed: [{ repo: "x/y", number: 42, mergedAt: "2026-01-01T00:00:01.000Z" }],
        unlinked: [{ repo: "x/y", number: 43, mergedAt: "2026-01-01T00:00:02.000Z" }],
        provenanceClaim: "unknown", provenanceReason: "no heartbeat yet",
      },
      diagnostics: { heartbeatStatus: "missing", reason: "no completed pass ever recorded", snapshotFilePath: "/x/y", metaFilePath: "/x/z" },
    } as any);
    expect(out).toContain("failed: x/y#42");
    expect(out).toContain("unlinked: x/y#43");
    expect(out).not.toContain("polls completed"); // diagnostics has no pollsCompleted here
  });
});
