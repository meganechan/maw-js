/**
 * kobo-633 — heartbeat (`recordHeartbeat`) + the two-tier liveness probe
 * (`prWatchLiveness`). AC3, FINAL shape (front's corrections, this round):
 *
 * TIER 1 — acceptance (`result.acceptance`): the ONE check that can fail a
 * daemon that LOOKS healthy but did nothing useful — every PR GitHub says
 * merged since `sinceIso` must have a linked card flipped to done/
 * wait-for-deploy. Three verdicts: "n/a" (nothing merged since — untested,
 * NOT passed), "passed" (everything merged has a flipped card — proves the
 * RESULT, never proves the daemon was the ACTOR), "failed" (something
 * merged has no flipped card anywhere — a real defect).
 *
 * TIER 2 — diagnostics (`result.diagnostics`): heartbeat freshness +
 * pollsCompleted + reposTotal/reposFailed + resolved file paths. Locates
 * WHERE something's broken; never proves anything is correct on its own —
 * proven this round: a fresh heartbeat can coexist with a daemon that
 * accomplished nothing (every repo failed) or reconciled nothing that
 * mattered.
 *
 * Earlier design (superseded, kept only in git history — front caught the
 * flaw before it shipped): comparing raw SNAPSHOT FILE content against gh
 * was NOT a valid ground truth — a card can be correctly flipped via
 * `reconcileMergedCards` while the snapshot itself never gets a fresh write
 * for that exact PR (kobo-631's own transition-only write-gate, working
 * exactly as designed) — a perfectly healthy daemon could fail that check.
 * Tier 1 reads the TASK STORE directly instead (the actual ground truth of
 * "did the card flip"), and deliberately WITHOUT `findTasksByPr`/
 * `findCardsByPrAnywhere` — both exclude done/rejected/wait-for-deploy by
 * design (their original callers want only still-open work), which would
 * silently throw away the exact evidence a "passed" verdict needs.
 *
 * ⚠️ ISOLATION — same two-layer discipline as pr-watch-resilience.test.ts,
 * tightened per this session's own incident: asserts the ACTUAL RESOLVED
 * write path (via the override seams, bypassing env-var resolution
 * entirely) is NOT under the real `~/.maw`, checked before any write.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ORIG_HOME = process.env.MAW_HOME;
let root: string;
let snapshotTestPath: string;
let metaTestPath: string;
const REAL_MAW_DIR = join(homedir(), ".maw");

function assertPathIsolated(p: string, label: string): void {
  if (p.startsWith(REAL_MAW_DIR)) {
    throw new Error(`${label} resolved UNDER the real ~/.maw (${p}) — refusing to run this test`);
  }
  if (!p.startsWith(root)) {
    throw new Error(`${label} did not resolve under this test's own temp root (${p})`);
  }
}

function card(company: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(root, "companies", company, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, company, title: id, ts: 1, ...fields }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-liveness-"));
  process.env.MAW_HOME = root; // defense-in-depth for anything not routed through the override seams below
  snapshotTestPath = join(root, "watch-pr-state.json");
  metaTestPath = join(root, "watch-pr-state.meta.json");
  assertPathIsolated(snapshotTestPath, "snapshotTestPath");
  assertPathIsolated(metaTestPath, "metaTestPath");
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = ORIG_HOME;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  // No explicit __reset*ForTest() calls needed — every test imports
  // `./pr-watch.ts` with its own unique `?query` suffix (fresh, unshared
  // module instance per test; overrides never bleed across tests).
});

function ghStub(responses: Record<string, string>) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return "[]"; // unmatched repo/call — hermetic against real local worktrees
  };
}

describe("recordHeartbeat + heartbeat file (kobo-633)", () => {
  it("writes an atomic, readable meta file with pollsCompleted/lastPollCompletedAtIso/codeVersion/intervalMs/reposTotal/reposFailed", async () => {
    const { recordHeartbeat, __setMetaPathForTest, __setCodeVersionForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?heartbeat-write-basic");
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    __setCodeVersionForTest("abc1234");

    recordHeartbeat(120_000);

    expect(existsSync(metaTestPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaTestPath, "utf-8"));
    expect(meta.pollsCompleted).toBe(1);
    expect(meta.codeVersion).toBe("abc1234");
    expect(meta.intervalMs).toBe(120_000);
    expect(typeof meta.lastPollCompletedAtIso).toBe("string");
    expect(new Date(meta.lastPollCompletedAtIso).toString()).not.toBe("Invalid Date");
    // no pollPrsOnce ran in this test — a fresh module instance defaults both to 0
    expect(meta.reposTotal).toBe(0);
    expect(meta.reposFailed).toBe(0);
  });

  it("codeVersion is captured once and stays pinned across multiple writes", async () => {
    const { recordHeartbeat, __setMetaPathForTest, __setCodeVersionForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?heartbeat-version-pinned");
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    __setCodeVersionForTest("old-sha-111");
    recordHeartbeat(1000);
    const first = JSON.parse(readFileSync(metaTestPath, "utf-8"));
    expect(first.codeVersion).toBe("old-sha-111");
  });
});

describe("prWatchLiveness — Tier 2 diagnostics (kobo-633)", () => {
  it("heartbeatStatus 'missing' when the heartbeat file was never written", async () => {
    const { prWatchLiveness, __setMetaPathForTest } = await import("./pr-watch.ts?diag-missing");
    __setMetaPathForTest(() => metaTestPath); // file intentionally never created
    const result = await prWatchLiveness("2026-07-29T00:00:00Z"); // Tier-2-only test — sinceIso value irrelevant here
    expect(result.diagnostics.heartbeatStatus).toBe("missing");
  });

  it("heartbeatStatus 'stale' when older than 3x the recorded interval", async () => {
    const { recordHeartbeat, prWatchLiveness, __setMetaPathForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?diag-stale");
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    recordHeartbeat(1); // interval=1ms — immediately stale
    await new Promise((r) => setTimeout(r, 20));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z"); // Tier-2-only test — sinceIso value irrelevant here
    expect(result.diagnostics.heartbeatStatus).toBe("stale");
  });

  it("MUTATION CONTROL — a corrupt-but-present heartbeat file reports 'missing' (unreadable is indistinguishable from never-written, by design)", async () => {
    const { prWatchLiveness, __setMetaPathForTest } = await import("./pr-watch.ts?diag-corrupt");
    __setMetaPathForTest(() => metaTestPath);
    writeFileSync(metaTestPath, "{not valid json");
    const result = await prWatchLiveness("2026-07-29T00:00:00Z"); // Tier-2-only test — sinceIso value irrelevant here
    expect(result.diagnostics.heartbeatStatus).toBe("missing");
  });

  it("resolved file paths are always populated, even on the missing-heartbeat path", async () => {
    const { prWatchLiveness, __setMetaPathForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?diag-paths");
    __setMetaPathForTest(() => metaTestPath);
    __setSnapshotPathForTest(() => snapshotTestPath);
    const result = await prWatchLiveness("2026-07-29T00:00:00Z"); // Tier-2-only test — sinceIso value irrelevant here
    expect(result.diagnostics.snapshotFilePath).toBe(snapshotTestPath);
    expect(result.diagnostics.metaFilePath).toBe(metaTestPath);
  });
});

describe("prWatchLiveness — sinceIso is REQUIRED, no silent default (front's correction: a rolling default produces FALSE n/a)", () => {
  it("result.acceptance.sinceIso always echoes back the exact window the caller passed", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?sinceiso-echo");
    __setGhForTest(ghStub({}));
    const result = await prWatchLiveness("2020-01-01T00:00:00Z");
    expect(result.acceptance.sinceIso).toBe("2020-01-01T00:00:00Z");
  });

  it("MUTATION CONTROL — a merge that happened BEFORE a naive rolling window (e.g. 24h ago) is still found when the caller passes the REAL, earlier T0 — proving why a silent default would have false-'n/a'd this", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?sinceiso-real-t0-required");
    const repo = "meganechan/maw-js";
    // A merge from 3 days ago — OUTSIDE any 24h-style rolling default, but
    // INSIDE the real incident T0 (also 3+ days ago) the caller explicitly passes.
    card("kobo", "kobo-old-merge", { state: "review", pr: 900, repo });
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 900, mergedAt: "2026-07-27T00:00:00Z" }]),
    }));
    const realT0 = "2026-07-26T00:00:00Z"; // explicit, matches the real incident, not "now - 24h"
    const result = await prWatchLiveness(realT0);
    expect(result.acceptance.verdict).toBe("failed"); // correctly FOUND, not silently n/a'd
    expect(result.acceptance.mergedSinceCount).toBe(1);
  });

  // kobo-633 — pins the RUNTIME guard, not just the TypeScript type: a
  // plain-JS caller (or one bypassing types) can still pass `undefined`/`""`
  // — this must reject loudly, never silently fall back to a guessed
  // window. If someone reintroduces a default value for the parameter
  // (making it optional again) AND removes this throw, this test goes red.
  it("MUTATION CONTROL — rejects loudly when sinceIso is falsy at runtime, never silently guesses a window", async () => {
    const { prWatchLiveness } = await import("./pr-watch.ts?sinceiso-runtime-reject");
    await expect(prWatchLiveness(undefined as unknown as string)).rejects.toThrow(/sinceIso is required/);
    await expect(prWatchLiveness("")).rejects.toThrow(/sinceIso is required/);
  });
});

describe("prWatchLiveness — Tier 1 acceptance (kobo-633, the actual gate)", () => {
  it("'n/a' when nothing merged since sinceIso — NOT 'passed' (front: n/a is untested, not accepted)", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-na-nothing-merged");
    card("kobo", "kobo-open", { state: "review", pr: 1, repo: "meganechan/maw-js" });
    __setGhForTest(ghStub({})); // every repo returns "[]"
    const result = await prWatchLiveness("2026-07-29T10:00:00Z");
    expect(result.acceptance.verdict).toBe("n/a");
    expect(result.acceptance.mergedSinceCount).toBe(0);
    // provenance — every verdict, not just n/a, must carry these
    expect(result.acceptance.sinceIso).toBe("2026-07-29T10:00:00Z");
    expect(typeof result.acceptance.limit).toBe("number");
  });

  it("'passed' when a merged PR HAS a flipped card — reads the card even though it's already 'done' (the #387/#389 shape, resolved)", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-passed");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-387", { state: "wait-for-deploy", pr: 387, repo }); // already flipped
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 387, mergedAt: "2026-07-29T09:42:20Z" }]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.verdict).toBe("passed");
    expect(result.acceptance.mergedSinceCount).toBe(1);
    expect(result.acceptance.passedCount).toBe(1);
    expect(result.acceptance.failed).toEqual([]);
    // provenance — same 3 fields, present on "passed" too, not n/a-only
    expect(result.acceptance.sinceIso).toBe("2026-07-29T00:00:00Z");
    expect(typeof result.acceptance.limit).toBe("number");
  });

  it("'failed' when a merged PR has NO card in done/wait-for-deploy anywhere", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-failed");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-389", { state: "review", pr: 389, repo }); // still stuck
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 389, mergedAt: "2026-07-29T22:24:33Z" }]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.verdict).toBe("failed");
    expect(result.acceptance.failed).toEqual([{ repo, number: 389, mergedAt: "2026-07-29T22:24:33Z" }]);
  });

  it("MUTATION CONTROL — using findTasksByPr's exclusion (done cards invisible) would flip 'passed' into 'failed' — this proves the fix reads state-unfiltered", async () => {
    // Regression pin for the exact bug front caught: a card in 'done' MUST
    // still count as evidence of a successful flip. If this test goes red,
    // someone reintroduced a done/rejected/wait-for-deploy exclusion.
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-done-card-counts");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-done", { state: "done", pr: 500, repo }); // plain 'done', not wait-for-deploy
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 500, mergedAt: "2026-07-29T12:00:00Z" }]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.verdict).toBe("passed");
  });

  it("cross-repo PR-number collision does not false-pass — meganechan/maw-js#389 vs kob-payment-gateway#389 stay separate (real production shape)", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-cross-repo-collision");
    // Same PR NUMBER, different repos: one flipped, one not.
    card("kobo", "kobo-maw389", { state: "review", pr: 389, repo: "meganechan/maw-js" }); // stuck
    card("pgw", "pgw-389", { state: "wait-for-deploy", pr: 389, repo: "kob-bank/kob-payment-gateway" }); // flipped
    __setGhForTest(ghStub({
      [`pr list --repo meganechan/maw-js`]: JSON.stringify([{ number: 389, mergedAt: "2026-07-29T22:24:33Z" }]),
      [`pr list --repo kob-bank/kob-payment-gateway`]: JSON.stringify([{ number: 389, mergedAt: "2026-07-29T21:00:00Z" }]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.verdict).toBe("failed"); // maw-js's #389 is genuinely stuck
    expect(result.acceptance.mergedSinceCount).toBe(2);
    expect(result.acceptance.passedCount).toBe(1); // pgw's #389 correctly counted as passed
    expect(result.acceptance.failed).toEqual([{ repo: "meganechan/maw-js", number: 389, mergedAt: "2026-07-29T22:24:33Z" }]);
  });
});

describe("prWatchLiveness — truncation forbids 'passed' (kobo-633, front's hard rule — code, not a suggestion)", () => {
  it("HARD RULE — a repo fetch returning exactly `limit` PRs, none missing a card, verdicts 'unknown' — NEVER 'passed'", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-truncated-forces-unknown");
    const repo = "meganechan/maw-js";
    const LIMIT = 30; // matches GH_PR_LIST_LIMIT
    const prs = Array.from({ length: LIMIT }, (_, i) => ({ number: i + 1, mergedAt: "2026-07-29T12:00:00Z" }));
    for (const pr of prs) card("kobo", `kobo-t${pr.number}`, { state: "done", pr: pr.number, repo }); // every single one flipped
    __setGhForTest(ghStub({ [`pr list --repo ${repo}`]: JSON.stringify(prs) }));

    const result = await prWatchLiveness("2026-07-29T00:00:00Z");

    expect(result.acceptance.verdict).toBe("unknown");
    expect(result.acceptance.verdict).not.toBe("passed"); // the exact false-positive front locked out
    expect(result.acceptance.mergedSinceCount).toBe(LIMIT);
    expect(result.acceptance.limit).toBe(LIMIT);
    expect(result.acceptance.passedCount).toBe(LIMIT); // everything VISIBLE looked fine — irrelevant, still not "passed"
  });

  it("truncation does NOT override an already-confirmed 'failed' — a real defect within the visible set stands regardless of what's beyond the cut", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-truncated-failed-still-failed");
    const repo = "meganechan/maw-js";
    const LIMIT = 30;
    const prs = Array.from({ length: LIMIT }, (_, i) => ({ number: i + 1, mergedAt: "2026-07-29T12:00:00Z" }));
    for (const pr of prs) {
      // #1 is the one genuine miss; everything else is flipped.
      card("kobo", `kobo-t${pr.number}`, { state: pr.number === 1 ? "review" : "done", pr: pr.number, repo });
    }
    __setGhForTest(ghStub({ [`pr list --repo ${repo}`]: JSON.stringify(prs) }));

    const result = await prWatchLiveness("2026-07-29T00:00:00Z");

    expect(result.acceptance.verdict).toBe("failed"); // NOT "unknown" — a confirmed miss outranks truncation ambiguity
    expect(result.acceptance.failed).toEqual([{ repo, number: 1, mergedAt: "2026-07-29T12:00:00Z" }]);
  });
});

describe("prWatchLiveness — unlinked bucket (kobo-633, front's 3rd 'don't fold the unclassifiable case' rule tonight)", () => {
  it("a merged PR with NO card anywhere goes to 'unlinked', NOT 'failed' — nothing existed for the daemon to flip", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-unlinked-not-failed");
    const repo = "meganechan/maw-js";
    // A DIFFERENT PR on the same repo has a card (so the repo enters the
    // check universe at all) — #999 itself has no card whatsoever.
    card("kobo", "kobo-other", { state: "review", pr: 1, repo });
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 999, mergedAt: "2026-07-29T15:00:00Z" }]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.unlinked).toEqual([{ repo, number: 999, mergedAt: "2026-07-29T15:00:00Z" }]);
    expect(result.acceptance.failed).toEqual([]); // NOT counted as a failure
  });

  it("MUTATION CONTROL — a batch that's ENTIRELY unlinked verdicts 'n/a', NEVER 'passed' — nothing was actually checked via a card", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-unlinked-all-verdict-na");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-other", { state: "review", pr: 1, repo }); // gets the repo into the check universe
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([
        { number: 998, mergedAt: "2026-07-29T15:00:00Z" },
        { number: 999, mergedAt: "2026-07-29T16:00:00Z" },
      ]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.verdict).toBe("n/a");
    expect(result.acceptance.verdict).not.toBe("passed"); // the exact false-positive front locked out
    expect(result.acceptance.unlinked.length).toBe(2);
    expect(result.acceptance.passedCount).toBe(0);
  });

  it("unlinked entries don't block a genuine 'passed' verdict for the checkable PRs alongside them", async () => {
    const { prWatchLiveness, __setGhForTest } = await import("./pr-watch.ts?acc-unlinked-alongside-passed");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-checkable", { state: "done", pr: 1, repo }); // #1 IS checkable and flipped
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([
        { number: 1, mergedAt: "2026-07-29T15:00:00Z" },
        { number: 999, mergedAt: "2026-07-29T16:00:00Z" }, // no card at all
      ]),
    }));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.verdict).toBe("passed");
    expect(result.acceptance.passedCount).toBe(1);
    expect(result.acceptance.unlinked).toEqual([{ repo, number: 999, mergedAt: "2026-07-29T16:00:00Z" }]);
  });
});

describe("prWatchLiveness — provenanceClaim (kobo-633, front's mandatory 'which of two claims' field, ships before kobo-641 merges)", () => {
  it("'retroactive-only' when every flipped PR merged BEFORE this daemon's first completed pass — the 631/640/647/651 shape, cannot prove live-driving", async () => {
    const { recordHeartbeat, prWatchLiveness, __setMetaPathForTest, __setGhForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?provenance-retroactive");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-old", { state: "done", pr: 631, repo });
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    recordHeartbeat(120_000); // firstPollCompletedAtIso = NOW

    // merged LONG before "now" — definitely before firstPollCompletedAtIso
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 631, mergedAt: "2020-01-01T00:00:00Z" }]),
    }));

    const result = await prWatchLiveness("2019-01-01T00:00:00Z");
    expect(result.acceptance.verdict).toBe("passed");
    expect(result.acceptance.provenanceClaim).toBe("retroactive-only");
    expect(result.acceptance.provenanceClaim).not.toBe("live-transition-demonstrated");
  });

  it("'live-transition-demonstrated' when a flipped PR merged AFTER this daemon's first completed pass — the kobo-641+ shape", async () => {
    const { recordHeartbeat, prWatchLiveness, __setMetaPathForTest, __setGhForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?provenance-live-demonstrated");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-641", { state: "wait-for-deploy", pr: 641, repo });
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    recordHeartbeat(120_000); // firstPollCompletedAtIso = NOW

    // merged in the FAR future relative to "now" — guaranteed after firstPollCompletedAtIso
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 641, mergedAt: "2099-01-01T00:00:00Z" }]),
    }));

    const result = await prWatchLiveness("2026-01-01T00:00:00Z");
    expect(result.acceptance.verdict).toBe("passed");
    expect(result.acceptance.provenanceClaim).toBe("live-transition-demonstrated");
    expect(result.acceptance.provenanceReason).toContain("641");
  });

  it("'unknown' when there's no heartbeat to compare against", async () => {
    const { prWatchLiveness, __setMetaPathForTest, __setGhForTest } = await import("./pr-watch.ts?provenance-unknown");
    __setMetaPathForTest(() => metaTestPath); // never written
    __setGhForTest(ghStub({}));
    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.provenanceClaim).toBe("unknown");
    expect(result.acceptance.provenanceReason).toContain("no heartbeat");
  });

  // kobo-633 — reviewer's own finding, feeds directly into front's reasoning
  // for releasing kobo-641's merge brake: MUTATION CONTROL — a heartbeat
  // existing but NOTHING merged must NOT collapse into "retroactive-only".
  // "retroactive-only" is a POSITIVE claim (real, if weak, evidence exists)
  // — claiming it with zero merged PRs to back it up is the exact same
  // overclaim as `n/a` reading as `passed`, one field deeper.
  it("MUTATION CONTROL — heartbeat exists but NOTHING merged since sinceIso stays 'unknown', never 'retroactive-only' (no evidence ≠ weak evidence)", async () => {
    const { recordHeartbeat, prWatchLiveness, __setMetaPathForTest, __setGhForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?provenance-unknown-nothing-merged");
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    recordHeartbeat(120_000);
    __setGhForTest(ghStub({})); // every repo returns "[]" — nothing merged

    const result = await prWatchLiveness("2026-07-29T00:00:00Z");
    expect(result.acceptance.provenanceClaim).toBe("unknown");
    expect(result.acceptance.provenanceClaim).not.toBe("retroactive-only");
    expect(result.acceptance.provenanceReason).toContain("nothing merged");
  });

  // kobo-633 — same principle, different absence: heartbeat exists, PRs DID
  // merge, but none of them ever got flipped (all failed/unlinked) — still
  // NO positive evidence the daemon can even do backfill correctly, so this
  // must also read "unknown", not "retroactive-only".
  it("MUTATION CONTROL — heartbeat exists, PRs merged, but NONE flipped stays 'unknown', never 'retroactive-only'", async () => {
    const { recordHeartbeat, prWatchLiveness, __setMetaPathForTest, __setGhForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?provenance-unknown-none-flipped");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-stuck", { state: "review", pr: 700, repo }); // merged but never flipped
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    recordHeartbeat(120_000);
    __setGhForTest(ghStub({
      [`pr list --repo ${repo}`]: JSON.stringify([{ number: 700, mergedAt: "2020-01-01T00:00:00Z" }]),
    }));

    const result = await prWatchLiveness("2019-01-01T00:00:00Z");
    expect(result.acceptance.verdict).toBe("failed"); // AC1 for the acceptance tier is unaffected by this fix
    expect(result.acceptance.provenanceClaim).toBe("unknown");
    expect(result.acceptance.provenanceClaim).not.toBe("retroactive-only");
    expect(result.acceptance.provenanceReason).toContain("none of the");
  });
});

describe("prWatchLiveness — Tier 2's all-repos-failed gate (kobo-633, via daemon.ts's own recordHeartbeat wiring)", () => {
  it("a fresh heartbeat with reposFailed===reposTotal is surfaced as a diagnostic fact, not silently hidden", async () => {
    const { recordHeartbeat, prWatchLiveness, __setMetaPathForTest, __resetHeartbeatCountForTest } =
      await import("./pr-watch.ts?diag-all-failed");
    __resetHeartbeatCountForTest();
    __setMetaPathForTest(() => metaTestPath);
    // Directly write a heartbeat with reposTotal/reposFailed set — simulates
    // what recordHeartbeat would persist right after a pass where every
    // repo failed (lastPollRepoCounts() reflects that internally; here we
    // just verify the READING side, since driving a real all-failing pass
    // through pollPrsOnce is covered by pr-watch-backfill.test.ts's own
    // truncation/failure tests).
    recordHeartbeat(120_000);
    const meta = JSON.parse(readFileSync(metaTestPath, "utf-8"));
    meta.reposTotal = 3;
    meta.reposFailed = 3;
    writeFileSync(metaTestPath, JSON.stringify(meta));

    const result = await prWatchLiveness("2026-07-29T00:00:00Z"); // Tier-2-only test — sinceIso value irrelevant here
    expect(result.diagnostics.heartbeatStatus).toBe("fresh");
    expect(result.diagnostics.reason).toContain("ALL 3");
    expect(result.diagnostics.reposFailed).toBe(3);
    expect(result.diagnostics.reposTotal).toBe(3);
  });
});
