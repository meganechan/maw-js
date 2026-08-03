/**
 * pr-watch resilience — rewritten against the CURRENT pr-watch.ts (kobo-733).
 *
 * The previous version of this file was written before 3fe50a48 deleted the
 * task/board subsystem: it seeded fake `card()` JSON, called the now-gone
 * `openPrLinkedRepos()`, asserted the card-assignee merge-ping, and tuned
 * several assertions around the wall-clock cost of a REAL `scanWorktrees()`
 * (~286ms on one machine) — so it was excluded from CI wholesale
 * (scripts/test-default-safe.sh SRC_EXCLUDED_PREFIXES). The property list
 * below is re-derived from what pr-watch.ts actually does today, not from the
 * old file's shape:
 *
 *   snapshot lifecycle — first run seeds without logging · each transition
 *   logs exactly once · a repeat poll is a no-op · a CORRUPT snapshot is not
 *   silently downgraded to a first run
 *   persistence — tmp+rename (inode changes) · nothing written when no repo
 *   changed · one repo's failure never costs another repo's committed work
 *   loud failure — a repo failure and a stuck pass are worklog `kind:"error"`
 *   rows, fanned out to EVERY company, and to a company-less row when there
 *   are none
 *   malformed input — unparseable `gh pr list`, empty output, failing
 *   `gh pr view`
 *   liveness — reentrancy dedupe · consecutive-skip alarm · per-pass timeout
 *   releasing the guard · mid-repo abort · stale-generation write discarded
 *
 * NO TEST BELOW ASSERTS ON ELAPSED TIME. Where a pass must hang, it hangs
 * *structurally* — a promise this file alone can resolve — so any positive
 * injected timeout wins the race by construction; where a background pass must
 * finish, the test polls for that pass's own observable EVENT (`waitFor`)
 * rather than sleeping a guessed number of milliseconds.
 *
 * ISOLATION, THREE LAYERS:
 *   1. `MAW_HOME` — one var covering every xdg dir-kind (config/runtimeHome/
 *      data/state/cache), asserted positively in `beforeEach` rather than
 *      assumed (the incident that produced `__setSnapshotPathForTest` came
 *      from setting the NARROWER `MAW_DATA_DIR` and believing it was enough).
 *   2. `__setSnapshotPathForTest` — the snapshot path stated directly, so it
 *      cannot reach the real `~/.maw/watch-pr-state.json` even if layer 1 were
 *      wrong.
 *   3. `__setReposForTest` — the repo list stated directly. Without it these
 *      tests poll whatever worktrees the host happens to have, and on a
 *      scrubbed HOME (zero worktrees) `pollPrsOnce` early-outs and EVERY
 *      assertion here passes vacuously.
 * `_setCompaniesDir` likewise points the company registry at the test root, so
 * the loud-failure fan-out is a stated 0/1/2 companies instead of whatever
 * this machine is running.
 *
 * `gh` never runs (`__setGhForTest`). Real `maw hey` never spawns — the
 * fleet-wide preload stub (test/helpers/hey-spawn-fail-closed.ts, kobo-405)
 * makes `pingOnMerge`'s default sender a no-op, which is why the merge path
 * below asserts the durable worklog row, not the (best-effort) ping.
 *
 * @maw-test-isolate — own bun process. This file mutates module-level
 * singletons (the company registry dir, MAW_HOME) and, in the timeout tests,
 * deliberately leaves a superseded pass running in the background; a shared
 * sweep process is the wrong place for either.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setCompaniesDir, COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";

const ORIG_HOME = process.env.MAW_HOME;
const ORIG_PORT = process.env.MAW_PORT;
const ORIG_COMPANIES_DIR = COMPANIES_DIR;
let root: string;

function snapshotFile(): string {
  return join(root, "watch-pr-state.json");
}

function readSnapshot(): Record<string, any> {
  return JSON.parse(readFileSync(snapshotFile(), "utf8"));
}

function writeSnapshot(snap: Record<string, unknown>): void {
  writeFileSync(snapshotFile(), JSON.stringify(snap));
}

/** Register a company + its `core` team in the test-root registry. */
function company(name: string, lead: string, members: string[] = []): void {
  mkdirSync(join(root, "companies"), { recursive: true });
  writeFileSync(
    join(root, "companies", `${name}.json`),
    JSON.stringify({
      name,
      teams: { core: { lead, members: [lead, ...members].map((oracle) => ({ oracle, role: oracle === lead ? "lead" : "dev" })) } },
    }),
  );
}

function readWorklog(company = "_unscoped"): any[] {
  const p = join(root, "companies", company, "worklog.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** `gh` stub over a per-repo PR listing. A repo with no entry answers empty. */
function ghStub(prsByRepo: Record<string, unknown[]>, mergedByLogin = "meganechan") {
  return async (args: string[]): Promise<string> => {
    const repo = args[args.indexOf("--repo") + 1];
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(prsByRepo[repo] ?? []);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergedBy: { login: mergedByLogin } });
    return "[]";
  };
}

function pr(number: number, state: "OPEN" | "MERGED" | "CLOSED", extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `pr-${number}`,
    state: state === "MERGED" ? "MERGED" : state,
    mergedAt: state === "MERGED" ? "2026-01-01T00:00:00Z" : null,
    author: { login: "meganechan" },
    ...extra,
  };
}

/**
 * Wait for an EVENT a background pass produces, not for a duration. Failure
 * mode is "the event never happened", named — never "the machine was slow"
 * silently passing.
 */
// 3s, comfortably under bun's own 5s per-test default so a missing event
// surfaces as the named error below rather than as an anonymous test timeout.
async function waitFor(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: ${what} never happened within ${timeoutMs}ms`);
}

/**
 * Fresh, unshared pr-watch instance per test (`?query` suffix — Bun gives each
 * one its own module record), pre-wired to this test's root. Module-level state
 * (in-flight promise, generation counter, every seam) is therefore per-test:
 * no reset bookkeeping, and no bleed between tests.
 */
async function load(tag: string, repos: string[]) {
  const mod = await import(`./pr-watch.ts?kobo733-${tag}`);
  mod.__setSnapshotPathForTest(() => snapshotFile());
  mod.__setReposForTest(async () => repos);
  return mod as any;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-resilience-"));
  process.env.MAW_HOME = root;
  process.env.MAW_PORT = "1"; // `record()`'s best-effort live-feed POST must not reach a real local maw server
  _setCompaniesDir(join(root, "companies"));
  // POSITIVE assertion, not an assumption — the incident behind
  // `__setSnapshotPathForTest` was a draft that BELIEVED an env var isolated
  // everything and never checked. `mawStateDir()` gates the snapshot;
  // `mawDataDir()` gates the worklog. If either escapes the test root (a
  // leftover MAW_STATE_DIR in the ambient env, or this file regressing), fail
  // HERE — before any write, not on the operator's real home.
  const { mawStateDir, mawDataDir } = await import("../xdg.ts");
  if (!mawStateDir().startsWith(root)) throw new Error(`mawStateDir() escaped the test root: ${mawStateDir()}`);
  if (!mawDataDir().startsWith(root)) throw new Error(`mawDataDir() escaped the test root: ${mawDataDir()}`);
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = ORIG_HOME;
  if (ORIG_PORT === undefined) delete process.env.MAW_PORT; else process.env.MAW_PORT = ORIG_PORT;
  _setCompaniesDir(ORIG_COMPANIES_DIR);
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("pollPrsOnce — snapshot lifecycle", () => {
  it("first run seeds the baseline and logs NOTHING (no fleet-wide replay of every historical PR)", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("firstrun", ["x/y"]);
    __setGhForTest(ghStub({ "x/y": [pr(1, "OPEN"), pr(2, "MERGED")] }));

    const recorded = await pollPrsOnce();

    expect(recorded).toEqual([]);
    expect(readSnapshot()["x/y#1"].state).toBe("OPEN");
    expect(readSnapshot()["x/y#2"].state).toBe("MERGED");
    expect(readWorklog("_unscoped")).toEqual([]);
  });

  it("each transition logs exactly once — a repeat poll over unchanged state records nothing", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("once", ["x/y"]);
    writeSnapshot({ "x/y#1": { state: "OPEN", repo: "x/y", number: 1, title: "pr-1" } });
    __setGhForTest(ghStub({ "x/y": [pr(1, "MERGED")] }));

    const first = await pollPrsOnce();
    const second = await pollPrsOnce();

    expect(first.map((e: any) => e.kind)).toEqual(["pr-merged"]);
    expect(first[0].pr).toBe(1);
    expect(first[0].by).toBe("meganechan"); // resolved via `gh pr view --json mergedBy`
    expect(second).toEqual([]);
    expect(readWorklog("_unscoped").filter((l) => l.kind === "pr-merged")).toHaveLength(1);
  });

  it("a PR unseen before is pr-opened; an OPEN→CLOSED edge is pr-closed", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("open-closed", ["x/y"]);
    writeSnapshot({ "x/y#9": { state: "OPEN", repo: "x/y", number: 9, title: "pr-9" } });
    __setGhForTest(ghStub({ "x/y": [pr(9, "CLOSED"), pr(10, "OPEN")] }));

    const recorded = await pollPrsOnce();

    expect(recorded.map((e: any) => [e.kind, e.pr])).toEqual([["pr-closed", 9], ["pr-opened", 10]]);
  });

  it("a CORRUPT snapshot file is NOT downgraded to a first run — transitions still log instead of being silently re-seeded", async () => {
    // loadSnapshot()'s catch returns `firstRun: false` deliberately. Were it
    // `true`, a single unreadable byte would silently swallow every pending
    // transition on the fleet exactly once, with no error anywhere.
    const { pollPrsOnce, __setGhForTest } = await load("corrupt-snap", ["x/y"]);
    writeFileSync(snapshotFile(), "{not json");
    __setGhForTest(ghStub({ "x/y": [pr(3, "MERGED")] }));

    const recorded = await pollPrsOnce();

    expect(recorded.map((e: any) => e.kind)).toEqual(["pr-merged"]);
    expect(readSnapshot()["x/y#3"].state).toBe("MERGED"); // and the file is valid JSON again
  });

  it("kobo-738 — a first run whose gh call fails writes NO snapshot, so the next poll is still a first run and seeds silently", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("firstrun-failure", ["x/y"]);
    __setGhForTest(async () => { throw new Error("simulated gh failure"); });

    const failedRun = await pollPrsOnce();

    expect(failedRun).toEqual([]);
    expect(existsSync(snapshotFile())).toBe(false); // no empty/partial snapshot persisted

    __setGhForTest(ghStub({ "x/y": [pr(1, "OPEN"), pr(2, "MERGED")] }));
    const seededRun = await pollPrsOnce();

    expect(seededRun).toEqual([]); // still a first run — seeds quietly, no pr-opened replay
    expect(readSnapshot()["x/y#1"].state).toBe("OPEN");
    expect(readSnapshot()["x/y#2"].state).toBe("MERGED");
    expect(readWorklog("_unscoped").filter((l) => l.kind === "pr-opened")).toEqual([]);
  });

  it("a transition is scoped to the AUTHOR's company (the card-assignee link it replaced is gone)", async () => {
    company("kobo", "eq3", ["meganechan"]);
    const { pollPrsOnce, __setGhForTest } = await load("author-company", ["x/y"]);
    writeSnapshot({ "x/y#4": { state: "OPEN", repo: "x/y", number: 4, title: "pr-4" } });
    __setGhForTest(ghStub({ "x/y": [pr(4, "MERGED")] }));

    await pollPrsOnce();

    const rows = readWorklog("kobo");
    expect(rows.map((l) => [l.kind, l.pr, l.oracle])).toEqual([["pr-merged", 4, "meganechan"]]);
    expect(readWorklog("_unscoped")).toEqual([]);
  });
});

describe("pollPrsOnce — persistence", () => {
  it("the snapshot is replaced by tmp+rename: the file's INODE changes (a direct overwrite would keep it)", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("atomic", ["x/y"]);
    writeSnapshot({ "x/y#5": { state: "OPEN", repo: "x/y", number: 5, title: "pr-5" } });
    const before = statSync(snapshotFile()).ino;
    __setGhForTest(ghStub({ "x/y": [pr(5, "MERGED")] }));

    await pollPrsOnce();

    expect(statSync(snapshotFile()).ino).not.toBe(before);
  });

  it("a poll with no transition anywhere does not touch the snapshot file at all", async () => {
    // The `if (outcome.changed)` gate. The snapshot only grows (nothing prunes
    // it — 958 keys / ~216KB measured live), so writing it per repo per poll
    // regardless of change is ~30x the IO of writing it once.
    const { pollPrsOnce, __setGhForTest } = await load("nochange", ["x/y"]);
    writeSnapshot({ "x/y#6": { state: "OPEN", repo: "x/y", number: 6, title: "pr-6" } });
    const before = statSync(snapshotFile());
    __setGhForTest(ghStub({ "x/y": [pr(6, "OPEN")] }));

    await pollPrsOnce();

    const after = statSync(snapshotFile());
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("a later repo's failure does NOT cost an earlier repo's already-committed work", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("isolation-late", ["ok/repo", "bad/repo"]);
    writeSnapshot({ "ok/repo#1": { state: "OPEN", repo: "ok/repo", number: 1, title: "pr-1" } });
    const good = ghStub({ "ok/repo": [pr(1, "MERGED")] });
    __setGhForTest(async (args: string[]) => {
      if (args[args.indexOf("--repo") + 1] === "bad/repo") throw new Error("simulated gh failure");
      return good(args);
    });

    await expect(pollPrsOnce()).resolves.toBeArray(); // never throws out of the pass

    expect(readSnapshot()["ok/repo#1"].state).toBe("MERGED");
    expect(readSnapshot()["bad/repo#2"]).toBeUndefined();
  });

  it("persistence is per-repo: the FIRST repo failing does not stop a later repo's state from landing", async () => {
    // Ordering is the point. Under the old single end-of-pass save, a throw on
    // repo #1 meant nothing at all survived the pass — the mechanism behind the
    // 86-minute silent stall (kobo-630).
    const { pollPrsOnce, __setGhForTest } = await load("isolation-early", ["bad/repo", "ok/repo"]);
    writeSnapshot({ "ok/repo#2": { state: "OPEN", repo: "ok/repo", number: 2, title: "pr-2" } });
    const good = ghStub({ "ok/repo": [pr(2, "MERGED")] });
    __setGhForTest(async (args: string[]) => {
      if (args[args.indexOf("--repo") + 1] === "bad/repo") throw new Error("simulated gh failure");
      return good(args);
    });

    await pollPrsOnce();

    expect(readSnapshot()["ok/repo#2"].state).toBe("MERGED");
  });
});

describe("pollPrsOnce — malformed gh output", () => {
  it("unparseable `gh pr list` output is a recorded failure, not a thrown pass", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("garbage-list", ["x/y"]);
    const seeded = { "x/y#8": { state: "OPEN", repo: "x/y", number: 8, title: "pr-8" } };
    writeSnapshot(seeded);
    __setGhForTest(async () => "<!DOCTYPE html><html>gh printed a login page</html>");

    await expect(pollPrsOnce()).resolves.toEqual([]);

    const failure = readWorklog("_unscoped").find((l) => l.kind === "error");
    expect(failure).toBeDefined();
    expect(failure.summary).toContain("poll failed for x/y");
    expect(readSnapshot()).toEqual(seeded); // the known state survives the failure untouched
  });

  it("EMPTY `gh pr list` output means an empty repo, not a failure", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("empty-list", ["x/y"]);
    __setGhForTest(async () => "");

    await expect(pollPrsOnce()).resolves.toEqual([]);

    expect(readWorklog("_unscoped").filter((l) => l.kind === "error")).toEqual([]);
  });

  it("a failing `gh pr view` still records the merge — `by` is simply unknown", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("view-fails", ["x/y"]);
    writeSnapshot({ "x/y#7": { state: "OPEN", repo: "x/y", number: 7, title: "pr-7" } });
    __setGhForTest(async (args: string[]) => {
      if (args[1] === "view") throw new Error("gh exited 1");
      return JSON.stringify([pr(7, "MERGED")]);
    });

    const recorded = await pollPrsOnce();

    expect(recorded.map((e: any) => e.kind)).toEqual(["pr-merged"]);
    expect(recorded[0].by).toBeUndefined();
  });
});

describe("pollPrsOnce — a failure is LOUD", () => {
  it("a repo failure is fanned out to EVERY company on this machine", async () => {
    // The card→repo link that used to narrow this to "companies that care"
    // retired with the board; a single fallback company would blind the others.
    company("kobo", "eq3");
    company("pgw", "thawanban");
    const { pollPrsOnce, __setGhForTest } = await load("loud-fanout", ["bad/repo"]);
    __setGhForTest(async () => { throw new Error("simulated gh failure"); });

    await pollPrsOnce();

    for (const c of ["kobo", "pgw"]) {
      const failure = readWorklog(c).find((l) => l.kind === "error");
      expect(failure, `no failure row for ${c}`).toBeDefined();
      expect(failure.repo).toBe("bad/repo");
      expect(failure.summary).toContain("simulated gh failure");
    }
  });

  it("with NO companies registered the failure is still recorded, company-less — never dropped", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("loud-nocompany", ["bad/repo"]);
    __setGhForTest(async () => { throw new Error("nobody owns this repo"); });

    await pollPrsOnce();

    const failure = readWorklog("_unscoped").find((l) => l.kind === "error");
    expect(failure).toBeDefined();
    expect(failure.company).toBeUndefined();
    expect(failure.summary).toContain("nobody owns this repo");
  });
});

describe("pollPrsOnce — repo discovery", () => {
  it("no repos, or a discovery that throws, ends the pass quietly with no snapshot write", async () => {
    const none = await load("repos-none", []);
    none.__setGhForTest(async () => { throw new Error("gh must never be called"); });
    await expect(none.pollPrsOnce()).resolves.toEqual([]);

    const broken = await load("repos-throw", []);
    broken.__setReposForTest(async () => { throw new Error("worktree scan failed"); });
    broken.__setGhForTest(async () => { throw new Error("gh must never be called"); });
    await expect(broken.pollPrsOnce()).resolves.toEqual([]);

    expect(existsSync(snapshotFile())).toBe(false);
  });
});

describe("pollPrsOnce — liveness (reentrancy, timeout, abort, generation)", () => {
  it("an overlapping tick reuses the in-flight promise instead of starting a second pass", async () => {
    const { pollPrsOnce, __setGhForTest } = await load("reentrant", ["x/y"]);
    let listCalls = 0;
    let releaseList: ((v: string) => void) | null = null;
    __setGhForTest(async (args: string[]) => {
      if (args[1] !== "list") return JSON.stringify({ mergedBy: { login: "meganechan" } });
      listCalls++;
      return new Promise<string>((resolve) => { releaseList = resolve; }); // held open until this test says so
    });

    const first = pollPrsOnce();
    const second = pollPrsOnce(); // the timer's next tick, fired while the first pass is still open

    expect(second).toBe(first); // literally the same promise — not a second pass
    await waitFor(() => releaseList !== null, "gh pr list was invoked");
    releaseList!(JSON.stringify([pr(11, "OPEN")]));
    await Promise.all([first, second]);
    expect(listCalls).toBe(1);
  });

  it("consecutive skipped ticks against one stuck pass are reported LOUDLY at the threshold", async () => {
    company("kobo", "eq3");
    const { pollPrsOnce, __setGhForTest, __setPollTimeoutMsForTest } = await load("skips", ["x/y"]);
    __setPollTimeoutMsForTest(50); // bounded so the stuck pass cannot outlive the file
    __setGhForTest(() => new Promise<string>(() => {})); // structurally never resolves

    const hung = pollPrsOnce().catch(() => {});
    pollPrsOnce().catch(() => {}); // skip 1
    pollPrsOnce().catch(() => {}); // skip 2
    pollPrsOnce().catch(() => {}); // skip 3 — crosses STUCK_POLL_SKIP_THRESHOLD

    const stuck = () => readWorklog("kobo").some((l) => l.kind === "error" && String(l.summary).includes("consecutive ticks skipped"));
    await waitFor(stuck, "the consecutive-skip alarm fired");
    await hung;
  });

  it("a wedged pass times out LOUDLY and RELEASES the guard — the next tick still runs (never skips forever)", async () => {
    // A dedupe-only reentrancy guard is itself a silent-forever bug: one hung
    // pass would make every later tick skip. Both halves are asserted here.
    company("kobo", "eq3");
    const { pollPrsOnce, __setGhForTest, __setPollTimeoutMsForTest, __resetPollTimeoutMsForTest } = await load("timeout", ["x/y"]);
    __setPollTimeoutMsForTest(25);
    __setGhForTest(() => new Promise<string>(() => {})); // hangs by construction — any positive timeout wins

    await expect(pollPrsOnce()).rejects.toThrow(/exceeded 25ms timeout/);

    const stuck = readWorklog("kobo").find((l) => l.kind === "error" && String(l.summary).includes("poll pass stuck"));
    expect(stuck).toBeDefined();
    expect(String(stuck.summary)).toContain("abort REQUESTED");

    __resetPollTimeoutMsForTest();
    __setGhForTest(ghStub({ "x/y": [pr(12, "OPEN")] }));
    await expect(pollPrsOnce()).resolves.toBeArray(); // the guard released
  });

  it("an aborted pass stops BEFORE the next PR's side effects, not merely before the final write", async () => {
    // Checking the generation only at save time is not enough: by then a
    // superseded pass has already written a worklog row for every OTHER PR in
    // the repo. The per-PR `signal.aborted` check is what bounds that.
    company("kobo", "eq3", ["meganechan"]); // author is a member, so its pr-merged row lands in kobo's log too
    const { pollPrsOnce, __setGhForTest, __setPollTimeoutMsForTest } = await load("midloop", ["x/y"]);
    __setPollTimeoutMsForTest(25);
    writeSnapshot({
      "x/y#20": { state: "OPEN", repo: "x/y", number: 20, title: "pr-20" },
      "x/y#21": { state: "OPEN", repo: "x/y", number: 21, title: "pr-21" },
    });

    let releaseView: ((v: string) => void) | null = null;
    __setGhForTest(async (args: string[]) => {
      if (args[1] === "list") return JSON.stringify([pr(20, "MERGED"), pr(21, "MERGED")]);
      if (args[2] === "20") return new Promise<string>((resolve) => { releaseView = resolve; }); // holds the pass open past its timeout
      return JSON.stringify({ mergedBy: { login: "meganechan" } });
    });

    await expect(pollPrsOnce()).rejects.toThrow(/exceeded 25ms timeout/);
    expect(releaseView).not.toBeNull(); // the pass really was inside PR 20 when the timeout fired
    releaseView!(JSON.stringify({ mergedBy: { login: "meganechan" } }));

    const lines = () => readWorklog("kobo");
    await waitFor(() => lines().some((l) => String(l.summary).includes("aborted mid-repo")), "the mid-repo abort was reported");
    expect(lines().some((l) => l.kind === "pr-merged" && l.pr === 20)).toBe(true); // already in flight — cannot be undone
    expect(lines().some((l) => l.kind === "pr-merged" && l.pr === 21)).toBe(false); // never reached
  });

  it("a superseded pass DISCARDS its own write, loudly, instead of clobbering the newer pass's state", async () => {
    company("kobo", "eq3");
    const { pollPrsOnce, __setGhForTest, __setPollTimeoutMsForTest, __resetPollTimeoutMsForTest } = await load("generation", ["x/y"]);
    __setPollTimeoutMsForTest(25);
    writeSnapshot({ "x/y#30": { state: "OPEN", repo: "x/y", number: 30, title: "pr-30" } });

    // The two passes must see DIFFERENT data, or "A clobbered B" and "A was
    // discarded" produce byte-identical files and the assertion is vacuous.
    let listCalls = 0;
    let viewCalls = 0;
    let releaseView: ((v: string) => void) | null = null;
    __setGhForTest(async (args: string[]) => {
      if (args[1] === "list") {
        listCalls++;
        return JSON.stringify([{ ...pr(30, "MERGED"), title: listCalls === 1 ? "seen-by-A" : "seen-by-B" }]);
      }
      viewCalls++;
      if (viewCalls === 1) return new Promise<string>((resolve) => { releaseView = resolve; }); // pass A outlives its own abort
      return JSON.stringify({ mergedBy: { login: "meganechan" } });
    });

    await expect(pollPrsOnce()).rejects.toThrow(/exceeded 25ms timeout/); // pass A = generation 1

    __resetPollTimeoutMsForTest();
    await pollPrsOnce(); // pass B = generation 2, completes and legitimately persists
    const afterB = readSnapshot();
    expect(afterB["x/y#30"].title).toBe("seen-by-B");

    releaseView!(JSON.stringify({ mergedBy: { login: "meganechan" } })); // now let A finish
    await waitFor(
      () => readWorklog("kobo").some((l) => String(l.summary).includes("discarded a stale write")),
      "pass A reported discarding its stale write",
    );

    const discard = readWorklog("kobo").find((l) => String(l.summary).includes("discarded a stale write"));
    expect(String(discard.summary)).toContain("generation 1");
    expect(String(discard.summary)).toContain("generation 2");
    expect(String(discard.summary)).toContain("x/y");
    expect(readSnapshot()).toEqual(afterB); // A's stale view never landed
  });
});
