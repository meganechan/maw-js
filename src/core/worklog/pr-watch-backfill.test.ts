/**
 * kobo-633 AC5 (added by front, 2026-07-30) — "merge now, let 633 backfill":
 * pr-watch has been OFF (`MAW_PR_WATCH_INTERVAL_MS=2147483647`) tonight,
 * so PRs merged during the outage never flipped their linked cards — the
 * decision was to keep merging and let this daemon's FIRST poll catch up on
 * the backlog, not to freeze every merge until it's back. This file proves
 * that catch-up is NOT new logic this card has to write — it already exists,
 * unmodified, in kobo-631's `pollRepoOnce`: comparing a STALE snapshot's
 * `prev` state against `gh`'s live `cur` state treats "our record is wrong
 * because we were off for hours" exactly the same as "a transition just
 * happened" — the transition-diff mechanism doesn't know or care how long
 * ago the real merge occurred, only that `prev !== cur`. Real production
 * shapes proven here (both cited on kobo-633's own card, evidence gathered
 * this session): `meganechan/maw-js#387` — snapshot stuck on stale `"OPEN"`
 * while gh says `MERGED` (13+ hours stale). `meganechan/maw-js#389` — no key
 * in the snapshot AT ALL (merged after the snapshot was last written).
 *
 * ⚠️ ISOLATION — same two-layer discipline as pr-watch-resilience.test.ts:
 * `MAW_HOME` (covers config/runtimeHome/data/state/cache at once) PLUS a
 * positive assertion that `mawStateDir()`/`mawDataDir()` actually resolve
 * under this test's own temp root, checked BEFORE any write.
 *
 * ⚠️ TWO THINGS front traced and flagged after this file was first written —
 * both change how the backfill CLAIM must be read, not the code:
 *
 * (1) PR NUMBERS COLLIDE ACROSS REPOS, AND ALREADY DO IN THE REAL SNAPSHOT —
 * the live `~/.maw/watch-pr-state.json` has BOTH `meganechan/maw-js#389` AND
 * `kob-bank/kob-payment-gateway#389` (kobo-99's own reason for scoping
 * `findTasksByPr`/`findCardsByPrAnywhere` by repo, not just PR number).
 * Every test/assertion in this file keys by CARD ID or by the full
 * `repo#number` snapshot key — NEVER by a bare PR number — deliberately, to
 * avoid a false pass where a check matches the WRONG repo's card/PR sharing
 * the same number.
 *
 * (2) `pollPrsOnce` CAN ALSO BE TRIGGERED VIA CLI, NOT ONLY THE DAEMON'S OWN
 * INTERVAL — `src/vendor/mpr-plugins/watch/index.ts` (lines 42/80, `maw
 * watch log`/`maw watch sync`) call it too, and `maw done` fires
 * `triggerPrPollNow()`. So by the time the daemon's OWN first poll runs,
 * some cards may already be flipped by an ad-hoc CLI trigger someone ran in
 * the meantime — the "idempotent, second poll is a no-op" test below proves
 * that's SAFE, not that it's a bug. But it also means a live post-deploy
 * check of "merged − flipped = ∅" can be satisfied ENTIRELY by CLI activity,
 * with the daemon never having run a single successful pass — an empty
 * missing-set is NOT proof the daemon specifically did the backfill, only
 * that the board converged by SOME mechanism. Attributing which mechanism
 * did it needs the liveness heartbeat (Slice 3), not this check.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIG_HOME = process.env.MAW_HOME;
let root: string;

function card(company: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(root, "companies", company, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, company, title: id, ts: 1, ...fields }));
}

function readCard(company: string, id: string): any {
  return JSON.parse(readFileSync(join(root, "companies", company, "tasks", `${id}.json`), "utf8"));
}

function snapshotFile(): string {
  return join(root, "watch-pr-state.json");
}

function readWorklogLines(company: string): any[] {
  const p = join(root, "companies", company, "worklog.jsonl");
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-backfill-"));
  process.env.MAW_HOME = root;
  const { mawStateDir, mawDataDir } = await import("../xdg.ts");
  if (!mawStateDir().startsWith(root)) throw new Error(`mawStateDir() escaped the test root: ${mawStateDir()}`);
  if (!mawDataDir().startsWith(root)) throw new Error(`mawDataDir() escaped the test root: ${mawDataDir()}`);
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = ORIG_HOME;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

function ghStub(prsByRepo: Record<string, any[]>) {
  return async (args: string[]): Promise<string> => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify((repo && prsByRepo[repo]) || []);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergedBy: { login: "someone" } });
    return "[]";
  };
}

describe("pollPrsOnce backfills merges that happened while polling was off (kobo-633 AC5)", () => {
  it("flips a card whose repo has a STALE snapshot entry (recorded OPEN, actually MERGED) — the #387 shape", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?backfill-stale-entry");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-387", { state: "review", pr: 387, repo });
    mkdirSync(root, { recursive: true });
    writeFileSync(snapshotFile(), JSON.stringify({
      [`${repo}#387`]: { state: "OPEN", repo, number: 387, title: "old title" },
    }));
    __setSnapshotPathForTest(() => snapshotFile());
    __setGhForTest(ghStub({
      [repo]: [{ number: 387, title: "old title", state: "MERGED", mergedAt: "2026-07-29T09:42:20Z", author: { login: "someone" } }],
    }));

    await pollPrsOnce();

    expect(readCard("kobo", "kobo-387").state).toBe("wait-for-deploy"); // kobo-274: has-a-PR defaults deployRequired=true
    const snap = JSON.parse(readFileSync(snapshotFile(), "utf8"));
    expect(snap[`${repo}#387`].state).toBe("MERGED");
  });

  it("flips a card whose PR has NO key at all in the snapshot (merged after the last write) — the #389 shape", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?backfill-absent-entry");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-389", { state: "review", pr: 389, repo });
    mkdirSync(root, { recursive: true });
    writeFileSync(snapshotFile(), JSON.stringify({})); // snapshot exists (not firstRun) but has nothing for this PR
    __setSnapshotPathForTest(() => snapshotFile());
    __setGhForTest(ghStub({
      [repo]: [{ number: 389, title: "new title", state: "MERGED", mergedAt: "2026-07-29T22:24:33Z", author: { login: "someone" } }],
    }));

    await pollPrsOnce();

    expect(readCard("kobo", "kobo-389").state).toBe("wait-for-deploy"); // kobo-274: has-a-PR defaults deployRequired=true
  });

  it("a SINGLE poll pass backfills MULTIPLE stale/absent PRs across multiple cards at once — no special 'catch-up mode' needed, ordinary diff logic handles it", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?backfill-multiple");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-a", { state: "review", pr: 501, repo });
    card("kobo", "kobo-b", { state: "review", pr: 502, repo });
    card("kobo", "kobo-c", { state: "review", pr: 503, repo });
    mkdirSync(root, { recursive: true });
    writeFileSync(snapshotFile(), JSON.stringify({
      [`${repo}#501`]: { state: "OPEN", repo, number: 501, title: "a" }, // stale
      // 502 absent entirely
      [`${repo}#503`]: { state: "OPEN", repo, number: 503, title: "c" }, // stale
    }));
    __setSnapshotPathForTest(() => snapshotFile());
    __setGhForTest(ghStub({
      [repo]: [
        { number: 501, title: "a", state: "MERGED", mergedAt: "2026-07-29T20:00:00Z", author: { login: "x" } },
        { number: 502, title: "b", state: "MERGED", mergedAt: "2026-07-29T20:05:00Z", author: { login: "x" } },
        { number: 503, title: "c", state: "MERGED", mergedAt: "2026-07-29T20:10:00Z", author: { login: "x" } },
      ],
    }));

    await pollPrsOnce();

    expect(readCard("kobo", "kobo-a").state).toBe("wait-for-deploy");
    expect(readCard("kobo", "kobo-b").state).toBe("wait-for-deploy");
    expect(readCard("kobo", "kobo-c").state).toBe("wait-for-deploy"); // kobo-274: has-a-PR defaults deployRequired=true
  });

  // kobo-633 — front traced this: pollPrsOnce is reachable from CLI too
  // (`maw watch log`/`maw watch sync`, `maw done` → triggerPrPollNow), not
  // only the daemon's own interval. So by the time the daemon's FIRST poll
  // runs, a card may ALREADY be correctly flipped by an ad-hoc CLI trigger
  // someone ran during the outage. The daemon's own poll seeing that same
  // state must be a safe no-op, not a re-process/re-notify/error — this is
  // exactly reconcileMergedCards's own documented guarantee
  // ("idempotent by construction... no resurrection — kobo-99/101"),
  // exercised here at the pollPrsOnce level, not just asserted from its
  // doc comment.
  it("a card already flipped (by an earlier CLI-triggered poll, simulating a race with the daemon's first run) is a safe no-op on re-poll — no resurrection, no duplicate side effect", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?backfill-idempotent-cli-race");
    const repo = "meganechan/maw-js";
    // Card already correctly parked by an earlier (CLI-triggered) poll —
    // snapshot ALREADY agrees with gh (both say MERGED), matching what a
    // real prior successful poll would have left behind.
    card("kobo", "kobo-already-flipped", { state: "wait-for-deploy", pr: 601, repo });
    mkdirSync(root, { recursive: true });
    writeFileSync(snapshotFile(), JSON.stringify({
      [`${repo}#601`]: { state: "MERGED", repo, number: 601, title: "already handled" },
    }));
    __setSnapshotPathForTest(() => snapshotFile());
    __setGhForTest(ghStub({
      [repo]: [{ number: 601, title: "already handled", state: "MERGED", mergedAt: "2026-07-29T20:00:00Z", author: { login: "x" } }],
    }));

    await pollPrsOnce();

    // Still parked, not resurrected/re-processed into some other state.
    expect(readCard("kobo", "kobo-already-flipped").state).toBe("wait-for-deploy");
  });
});

// kobo-633 — front's decision on the `--limit 30` risk flagged above: not
// raised, not paginated (permanent cost for a one-time condition, and
// against kobo-631's own point of keeping per-poll cost down) — made LOUD
// instead, same shape as `recordFailure`. This is the SAME truncation-trap
// class as the one guarded against in AC5's own live verification script
// (gh's own --limit truncates silently either way) — one lives in the code
// being checked (here), the other in the script that checks it; found the
// same day.
describe("gh pr list possible-truncation guard (kobo-633)", () => {
  it("fires loudly when a repo's poll returns EXACTLY the --limit (30) rows — cannot tell 'genuinely 30' from 'cut off at 30'", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?truncation-exactly-limit");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-t1", { state: "review", pr: 1, repo });
    mkdirSync(root, { recursive: true });
    writeFileSync(snapshotFile(), JSON.stringify({}));
    __setSnapshotPathForTest(() => snapshotFile());
    const thirtyPrs = Array.from({ length: 30 }, (_, i) => ({
      number: i + 1, title: `pr ${i + 1}`, state: "OPEN", mergedAt: null, author: { login: "x" },
    }));
    __setGhForTest(ghStub({ [repo]: thirtyPrs }));

    await pollPrsOnce();

    const lines = readWorklogLines("kobo");
    const truncationEntry = lines.find((l) => typeof l.summary === "string" && l.summary.includes("EXACTLY the --limit"));
    expect(truncationEntry).toBeDefined();
    expect(truncationEntry.repo).toBe(repo);
    expect(truncationEntry.summary).toContain("30");
  });

  it("MUTATION CONTROL — does NOT fire when a repo returns one fewer than the limit (29) — proves this is a boundary check, not a 'ran' check", async () => {
    const { pollPrsOnce, __setGhForTest, __setSnapshotPathForTest } = await import("./pr-watch.ts?truncation-below-limit");
    const repo = "meganechan/maw-js";
    card("kobo", "kobo-t2", { state: "review", pr: 1, repo });
    mkdirSync(root, { recursive: true });
    writeFileSync(snapshotFile(), JSON.stringify({}));
    __setSnapshotPathForTest(() => snapshotFile());
    const twentyNinePrs = Array.from({ length: 29 }, (_, i) => ({
      number: i + 1, title: `pr ${i + 1}`, state: "OPEN", mergedAt: null, author: { login: "x" },
    }));
    __setGhForTest(ghStub({ [repo]: twentyNinePrs }));

    await pollPrsOnce();

    const lines = readWorklogLines("kobo");
    const truncationEntry = lines.find((l) => typeof l.summary === "string" && l.summary.includes("EXACTLY the --limit"));
    expect(truncationEntry).toBeUndefined();
  });
});
