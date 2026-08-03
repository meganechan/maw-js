/**
 * PR watcher — poll-based (snapshot diff, each transition logs once).
 *
 * Triggered by: `maw done` (on-signal), `maw company worklog log` (on-read),
 * `maw company worklog sync`, AND — on a running server — the `serve-pr-watch`
 * plugin's periodic tick (kobo-33).
 * `gh pr list` is ground truth for open/merged/closed; we diff against a snapshot
 * so each transition logs exactly once. On merge we ping the author's dept lead
 * (carrying content), so the log gets read.
 *
 * An out-of-band github.com web merge is picked up within one server tick (or on
 * the next on-demand trigger when no server runs). In-pane `gh pr merge` is
 * caught immediately by the PostToolUse hook.
 *
 * Board side retired: driving a linked card to review/done, healing its repo, and
 * stamping its mergeable state all went with the task subsystem. What is left is
 * the activity log (worklog entries per transition) + the merge ping.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";
import { mawStatePath } from "../xdg";
import { scanWorktrees } from "../fleet/worktrees";
import { loadConfig } from "../../config";
import { appendWorklog } from "./store";
import { listCompanies } from "../../vendor/mpr-plugins/company/company-helpers";
import { pingOnMerge } from "./ping";
import { companyOfOracleStrict, scopeOfOracle } from "./company-scope";
import type { WorklogEntry } from "./types";

type PrState = "OPEN" | "MERGED" | "CLOSED";

interface SnapEntry { state: PrState; repo: string; number: number; title: string; author?: string }
type PrSnapshot = Record<string, SnapEntry>; // key = `${repo}#${number}`

interface GhPr {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  author?: { login?: string };
}

// kobo-631 — injectable override for the snapshot's own path, on top of (not
// instead of) correct env-var isolation. Real incident, this round: a test
// set MAW_DATA_DIR believing it isolated every file `pollPrsOnce` touches —
// it does NOT: `mawStatePath()` (what this file actually uses) checks
// MAW_HOME/MAW_STATE_DIR, a DIFFERENT var than MAW_DATA_DIR (which only
// governs mawDataPath(), used by the task/worklog stores) — see xdg.ts's 5
// separate dir-kind resolvers (config/runtimeHome/data/state/cache), each
// gated on its OWN env var after a shared MAW_HOME override (checked FIRST in
// every one, so MAW_HOME always wins over a stray real-env MAW_STATE_DIR/etc
// left set — reviewer-verified). That test's writes landed in
// the REAL machine's ~/.maw/watch-pr-state.json. Env-var isolation depends on
// remembering every var a code path touches, every time — this seam removes
// that dependency for the snapshot path specifically: a test overrides the
// PATH directly, so it can never reach the real file regardless of which env
// vars it did or didn't set correctly.
let snapshotPathOverride: (() => string) | null = null;

function snapshotPath(): string {
  return snapshotPathOverride ? snapshotPathOverride() : mawStatePath("watch-pr-state.json");
}

/** TEST-ONLY seam — override the snapshot file's path. Caller MUST call
 *  `__resetSnapshotPathForTest()` in its own `afterEach`/`afterAll`. */
export function __setSnapshotPathForTest(fn: () => string): void {
  snapshotPathOverride = fn;
}

/** Companion to `__setSnapshotPathForTest` — restores real path resolution. */
export function __resetSnapshotPathForTest(): void {
  snapshotPathOverride = null;
}

function loadSnapshot(): { snap: PrSnapshot; firstRun: boolean } {
  const p = snapshotPath();
  if (!existsSync(p)) return { snap: {}, firstRun: true };
  try {
    return { snap: JSON.parse(readFileSync(p, "utf-8")) as PrSnapshot, firstRun: false };
  } catch {
    return { snap: {}, firstRun: false };
  }
}

/**
 * kobo-631 — atomic write: temp file + rename, same-filesystem rename being
 * atomic at the OS level so a kill mid-write can never leave a half-written
 * `watch-pr-state.json` on disk. The tmp filename is PID-suffixed, NOT the
 * plain `${path}.tmp` lock.ts's `writeLock` uses — that pattern is only safe
 * with exactly one writer. `pollPrsOnce` has THREE real, non-hypothetical
 * concurrent-writer paths, all human/oracle-triggerable at any moment:
 *   - `maw watch log` (vendor/mpr-plugins/watch/index.ts) — polls on every
 *     invocation unless `--no-poll` is passed
 *   - `maw watch sync` (same file)
 *   - `maw done` (any oracle, any time) — fires `triggerPrPollNow()` below
 * A shared, non-PID-suffixed tmp name means two concurrent writers race on
 * the SAME tmp file, interleaving bytes, and `renameSync` then atomically
 * promotes that CORRUPTED file into place — atomicity without correctness,
 * which is worse than today's bug: it looks like it succeeded. PID-suffixing
 * gives each writer its own tmp file; whichever rename lands last wins
 * (acceptable — the next poll re-converges from live `gh` state regardless).
 *
 * PID alone does NOT protect against two overlapping poll passes IN THE SAME
 * process: `serve-pr-watch/index.ts`'s `setInterval` calls `void
 * d.pollPrsOnce().catch(...)` — `setInterval` does NOT wait for an async
 * callback to finish before scheduling the next tick, and there was no guard
 * against that until `pollPrsOnce`'s reentrancy check (below). Without it, two
 * overlapping passes in the SAME pid would both write `${p}.${pid}.tmp` and
 * race the SAME rename.
 *
 * ⚠️ Atomicity makes this WORSE, not better, if the tmp name collides —
 * do not read "atomic write" as "therefore safe" on its own. A non-atomic
 * collision leaves a half-written, truncated file: `JSON.parse` throws, the
 * corruption is obvious and loud. An ATOMIC collision (two writers, same tmp
 * name, `renameSync` promoting whichever finishes last) produces a
 * COMPLETE, validly-parsing JSON file that is quietly WRONG — a clean mix of
 * two different in-memory `snap` states, indistinguishable from a correct
 * write. Atomicity guarantees the corrupted result looks official; it does
 * nothing to guarantee the result is correct. The reentrancy guard in
 * `pollPrsOnce` (below) is the actual fix — it prevents two passes from ever
 * existing at once, so there is nothing left to race. This random suffix is
 * defense-in-depth only, for whatever that guard doesn't cover (e.g. a future
 * caller this file doesn't anticipate) — never the primary safety argument.
 */
function saveSnapshotAtomic(snap: PrSnapshot): void {
  const p = snapshotPath();
  const tmp = `${p}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n");
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort — nothing to clean up if the write itself never landed */ }
    throw e;
  }
}

// kobo-631 — `signal` is threaded all the way down from the poll pass's own
// timeout (see `pollPrsOnce` below): on timeout, the abandoned pass's
// AbortController fires, Bun.spawn kills the actual `gh` subprocess, and this
// call rejects promptly instead of running forever as an orphaned ("zombie")
// promise. Each zombie would otherwise hold its own full in-memory copy of
// `snap` (958 keys / ~216KB today) for as long as `gh` kept hanging, with NO
// cap — one per tick, accumulating without bound if `gh` stays wedged across
// many polls. That is a direct memory-growth mechanism, and kobo-630's own
// open investigation is specifically about unexplained memory growth — a
// timeout that only stops WAITING (without also killing the real work) would
// leave that mechanism fully intact. Real cancellation, not a discard-cap
// added after the fact, is what actually removes it.
async function realGh(args: string[], signal?: AbortSignal): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", signal });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh exited ${code}`);
  return out;
}

// kobo-631 — injectable seam (same shape as task/index.ts's
// __setPrDiffFetcherForTest): default is the real `gh` subprocess call; a
// test overrides it so pollRepoOnce's failure-handling can be exercised
// without shelling to a real `gh` binary. No MAW_TEST_MODE branch in the
// runtime path (kobo-546's own lesson). `signal` is optional so existing
// test stubs that ignore it keep working unmodified.
let ghFetcher: (args: string[], signal?: AbortSignal) => Promise<string> = realGh;

/** TEST-ONLY seam — override the `gh` CLI call. Caller MUST call
 *  `__resetGhForTest()` in its own `afterAll`, or the override leaks into
 *  every other test file sharing the same bun test process. */
export function __setGhForTest(fn: (args: string[], signal?: AbortSignal) => Promise<string>): void {
  ghFetcher = fn;
}

/** Companion to `__setGhForTest` — restores the real `gh` subprocess call. */
export function __resetGhForTest(): void {
  ghFetcher = realGh;
}

/** Repos to poll = the distinct main repos of this machine's local worktrees. */
async function realRepos(): Promise<string[]> {
  const wts = await scanWorktrees();
  return [...new Set(wts.map(w => w.mainRepo).filter(Boolean))];
}

// kobo-733 — injectable seam, same shape/contract as `__setGhForTest` above.
// `scanWorktrees()` shells out to `find` + `git` + tmux against the REAL
// machine, so a test that leaves it live polls whatever worktrees this box
// happens to have: slow, machine-dependent, and — on a scrubbed HOME with no
// worktrees at all — it returns ZERO repos, which makes `pollPrsOnce` early-out
// and every assertion after it pass vacuously. That is not a hypothetical: the
// pre-rewrite version of pr-watch-resilience.test.ts tuned its own timeouts
// around the real scan's ~286ms and was excluded from CI partly for it.
let repoFetcher: () => Promise<string[]> = realRepos;

/** TEST-ONLY seam — state the repo list instead of scanning the real machine.
 *  Caller MUST call `__resetReposForTest()` unless it imported this module
 *  under its own `?query` suffix (fresh, unshared instance). */
export function __setReposForTest(fn: () => Promise<string[]>): void {
  repoFetcher = fn;
}

/** Companion to `__setReposForTest` — restores the real worktree scan. */
export function __resetReposForTest(): void {
  repoFetcher = realRepos;
}

/** Company names on this machine — the fleet-wide fan-out target for a loud
 *  failure. Was the task store's own company enumeration before the board left. */
function companyNames(): string[] {
  return listCompanies().map((c) => c.name);
}

function prStateOf(pr: GhPr): PrState {
  if (pr.mergedAt) return "MERGED";
  return pr.state === "CLOSED" ? "CLOSED" : "OPEN";
}

/** Best-effort: forward to the live feed (browsers). Never throws. */
function postLive(entry: WorklogEntry): void {
  const port = process.env.MAW_PORT || "3456";
  fetch(`http://localhost:${port}/api/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      oracle: entry.oracle, event: "Notification", project: entry.repo ?? "", host: "local",
      message: entry.summary, ts: entry.ts,
      data: { kind: entry.kind, pr: entry.pr, repo: entry.repo, by: entry.by, summary: entry.summary },
    }),
  }).catch(() => {});
}

function record(entry: WorklogEntry): void {
  appendWorklog(entry);
  postLive(entry);
}

async function mergedBy(repo: string, num: number, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const out = await ghFetcher(["pr", "view", String(num), "--repo", repo, "--json", "mergedBy"], signal);
    return JSON.parse(out || "{}")?.mergedBy?.login || undefined;
  } catch {
    return undefined;
  }
}

/**
 * kobo-631 — a repo-level failure must be LOUD, not swallowed. Routed to EVERY
 * company on this machine, mirroring `recordStuckPoll`: the card→repo link that
 * used to narrow this to "companies that care about this repo" retired with the
 * task subsystem, and a single fallback company would silently blind the others.
 * Falls back to a company-less entry (still recorded, never dropped) when there
 * are no companies at all.
 */
function recordFailure(repo: string, message: string): void {
  const companies = companyNames();
  const base = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    oracle: "pr-watch",
    kind: "error" as const,
    summary: `poll failed for ${repo}: ${message}`,
    repo,
  };
  if (!companies.length) {
    record(base);
    return;
  }
  for (const company of companies) record({ ...base, company });
}

/**
 * One repo's worth of a poll pass. Never throws — a failure (the `gh pr
 * list` call itself, or anything inside the per-PR loop that isn't already
 * one of the existing inner try/catches) is captured and returned as
 * `failed`, together with whatever PRs in this repo WERE fully committed
 * before it happened. The caller persists `entries` regardless, so a
 * mid-repo failure costs at most this one repo's remaining unprocessed PRs
 * for this poll — not the whole fleet's pass (kobo-631).
 *
 * Ordering discipline that closes the gap review round 1 found: a PR's
 * entry is committed to `entries` (the thing that eventually gets persisted)
 * ONLY after any real side effect for it has already happened — never
 * before. The OLD code (and an earlier draft of this fix) committed the new
 * state unconditionally, before the firstRun/prev===cur early-outs — once
 * persistence becomes incremental, that ordering means a kill between
 * "state committed" and "worklog written" silently drops the worklog entry
 * forever while the snapshot claims the transition was already handled —
 * the exact failure class this card exists to close, just moved to a finer
 * grain. firstRun/no-op PRs have no side effect to wait for, so they commit
 * immediately; a real transition commits only once its `record()` call has
 * actually returned.
 */
async function pollRepoOnce(
  repo: string,
  snap: PrSnapshot,
  firstRun: boolean,
  fallbackCompany: string | undefined,
  signal?: AbortSignal,
): Promise<{ entries: PrSnapshot; recorded: WorklogEntry[]; failed?: string; changed: boolean; abortedMidLoop?: number }> {
  const entries: PrSnapshot = {};
  const recorded: WorklogEntry[] = [];
  let sawTransition = false;
  let prs: GhPr[];
  try {
    const out = await ghFetcher([
      "pr", "list", "--repo", repo, "--state", "all", "--limit", "30",
      "--json", "number,title,state,mergedAt,author",
    ], signal);
    prs = JSON.parse(out || "[]") as GhPr[];
  } catch (e) {
    // kobo-738 — on a first run, `firstRun` alone used to make `changed` true
    // even here, persisting this repo's EMPTY `entries` (the gh call failed
    // before a single PR was read) as if it had been seeded. The file's mere
    // existence is the ONLY first-run signal `loadSnapshot()` has — writing it
    // now would make the NEXT poll believe this repo is already seeded, so its
    // still-unseen, still-open PRs would replay as `pr-opened`. A failed first
    // run must stay unseeded and unpersisted so the next poll is still a first
    // run and seeds silently once `gh` works.
    return { entries, recorded, failed: e instanceof Error ? e.message : String(e), changed: firstRun ? false : sawTransition };
  }

  try {
    for (const [i, pr] of prs.entries()) {
      // kobo-631 (reviewer-escalated: the generation check before
      // saveSnapshotAtomic alone was NOT enough) — by the time a stale,
      // timed-out pass would reach that check, it has ALREADY performed
      // every OTHER PR's real side effect for this repo: `record()`
      // (appendWorklog — could re-log a "pr-opened" for a PR a NEWER pass
      // already saw MERGED). Checking here, before EACH PR's side effects
      // (not just once at the end), bounds — doesn't eliminate, PRs already
      // processed earlier in this same loop can't be undone — how much stale
      // work a superseded pass can still do after being aborted.
      if (signal?.aborted) {
        return { entries, recorded, changed: firstRun || sawTransition, abortedMidLoop: prs.length - i };
      }
      const key = `${repo}#${pr.number}`;
      const cur = prStateOf(pr);
      const prev = snap[key]?.state;
      const author = pr.author?.login;

      if (firstRun || prev === cur) {
        // seed baseline only, or genuinely no-op — nothing else to wait for,
        // safe to commit immediately.
        entries[key] = { state: cur, repo, number: pr.number, title: pr.title, author };
        continue;
      }

      sawTransition = true; // a real OPEN/MERGED/CLOSED edge, not a no-op — this repo's write is now earned.

      // kobo-216 — resolve the author's company via the STRICT resolver: no silent
      // first-match (the AC gap). This is a background daemon with no --company to
      // supply, so an ambiguous (multi-company) author can't be prompted — catch the
      // throw and fall to the configured fallbackCompany rather than aborting the whole
      // poll cycle (matches this file's "never let X break PR-watch" contract). This
      // used to sit behind the linked card's own company; with the board gone the
      // author's company IS the primary path.
      let authorCompany: string | null = null;
      if (author) {
        try { authorCompany = companyOfOracleStrict(author); }
        catch { authorCompany = null; } // ambiguous → fallbackCompany, never guess a board
      }
      const company = authorCompany ?? fallbackCompany;
      const base = { ts: Date.now(), iso: new Date().toISOString(), oracle: author || "unknown", company, repo, pr: pr.number };

      if (cur === "MERGED") {
        const by = await mergedBy(repo, pr.number, signal);
        const entry: WorklogEntry = { ...base, kind: "pr-merged", summary: `merged #${pr.number} ${pr.title}`, by };
        record(entry);
        recorded.push(entry);
        // kobo-631 resolved this from the linked card's assignee, because every PR
        // merges under ONE shared fleet-wide github account (kobo-217) that is never
        // itself a registered oracle. With the board gone that assignee no longer
        // exists, so we fall back to the author's dept lead — which resolves to a
        // real oracle only when the PR author IS one, and to nobody otherwise
        // (deliver() skips empty targets). Merge notification is therefore
        // best-effort now; the worklog entry above is the durable record.
        pingOnMerge({ lead: author ? scopeOfOracle(author)?.lead ?? null : null, author: null, pr: pr.number, repo, by });
      } else if (cur === "CLOSED") {
        const entry: WorklogEntry = { ...base, kind: "pr-closed", summary: `closed #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      } else if (cur === "OPEN" && prev == null) {
        const entry: WorklogEntry = { ...base, kind: "pr-opened", summary: `opened #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      }

      // Committed only now — after this PR's real side effect has already
      // landed (`record()` above already returned).
      entries[key] = { state: cur, repo, number: pr.number, title: pr.title, author };
    }
  } catch (e) {
    // kobo-738 — same guard as the `gh pr list` catch above.
    return { entries, recorded, failed: e instanceof Error ? e.message : String(e), changed: firstRun ? false : sawTransition };
  }
  return { entries, recorded, changed: firstRun || sawTransition };
}

/**
 * One poll pass over the fleet's repos. Returns the entries recorded.
 *
 * kobo-631: persists the snapshot after each repo that actually produced a
 * TRANSITION (not unconditionally after every repo — Tony's original wording
 * was "write after each repo finishes"; this is a deliberate narrowing of
 * that, explained below, not a silent deviation). A repo's own PR list is
 * capped at 30 and processed as one atomic unit; a kill mid-repo loses at
 * most that one repo's not-yet-committed transitions for this poll, retried
 * next cycle — the durability intent Tony asked for is fully preserved,
 * because a repo with NO transition has nothing to lose in the first place.
 * The OLD code's single end-of-pass `saveSnapshot` meant ANY failure
 * anywhere — even in the very first repo — lost the whole pass's snapshot
 * state, every repo, every poll, forever (the actual root cause behind
 * kobo-630's 86-minute incident). A per-repo failure is recorded loudly
 * (`recordFailure`) rather than silently absorbed — the empty top-level
 * catch at `serve-pr-watch/index.ts:36` still exists as a last-resort safety
 * net for something even more unexpected than a single repo's own processing
 * (e.g. `scanWorktrees()`/`loadSnapshot()` itself failing before any repo is
 * even reached), not as the primary failure-reporting path anymore.
 *
 * ⚠️ THE `if (outcome.changed)` GATE BELOW IS NOT A PERFORMANCE OPTIMIZATION
 * — DO NOT DELETE IT DURING A REFACTOR. The live snapshot has no pruning
 * (nothing in this file ever removes a key — see `Object.assign` below,
 * which only adds/overwrites) and only grows: 958 keys / 215986 bytes
 * measured live on 2026-07-30. Writing it unconditionally after EVERY repo,
 * every poll, means serializing that whole ~216KB blob once per repo instead
 * of once per poll — with ~29 repos that's ~6MB written+serialized per poll
 * instead of ~216KB (~30x), or roughly 179MB/hour at the 2-minute poll
 * interval instead of ~6.5MB/hour. kobo-630's leading hypothesis is a
 * `max_memory_restart`-triggered kill correlated with pr-watch's own polling
 * activity (UNVERIFIED — not proven which operation) — multiplying the one
 * expensive serialize+write by the repo count is exactly the kind of change
 * that could accelerate the very symptom that investigation is still open
 * on. Removing this gate "to simplify" would reintroduce that risk.
 */
// kobo-631 — reentrancy guard: `serve-pr-watch`'s timer can fire again before
// a slow/interrupted pass finishes (the exact scenario this whole card exists
// for — assuming polls are always fast would beg the question). Two
// overlapping passes in the SAME process would both build their own `snap`
// from the same on-disk baseline and race `saveSnapshotAtomic` — whichever
// finishes last silently wins, discarding the other's transitions. Dedupe by
// returning the SAME in-flight promise instead of starting a second pass.
//
// ⚠️ A dedupe-only guard is ITSELF a silent-forever bug: if one pass hangs
// (gh wedged, network gone — never throws, never resolves) `inFlightPoll`
// never clears, so EVERY future tick skips forever — the exact same visible
// symptom this whole card exists to fix (process alive, board stops moving),
// just via a hang instead of a memory-kill. Tony's own original instruction
// ("skip if the previous round isn't done") reproduces the root bug in a new
// shape if left at just that — closed with TWO independent signals (either
// alone can still go silent):
//   (a) a hard per-pass timeout, grounded in the REAL measured 17-repo sweep
//       (19.19s, measured live this round) with generous headroom, still
//       comfortably under the 120s tick interval — releases the guard AND
//       reports LOUDLY the first time it happens, not after N repeats.
//   (b) a consecutive-skip counter as a backstop for (a) itself somehow
//       failing to fire — independently loud once a threshold is crossed.
// Deliberately self-contained: does NOT lean on kobo-633's future mtime-based
// liveness signal (still blocked) — this card must be safe standalone on the
// day IT merges, not on the day some other card eventually ships.
const POLL_TIMEOUT_MS = 90_000;
const STUCK_POLL_SKIP_THRESHOLD = 3;

let pollTimeoutMsOverride: number | null = null;
function pollTimeoutMs(): number {
  return pollTimeoutMsOverride ?? POLL_TIMEOUT_MS;
}
/** TEST-ONLY seam — a real 90s wait has no place in a test suite. */
export function __setPollTimeoutMsForTest(ms: number): void {
  pollTimeoutMsOverride = ms;
}
export function __resetPollTimeoutMsForTest(): void {
  pollTimeoutMsOverride = null;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); reject(new Error(`poll pass exceeded ${ms}ms timeout`)); }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Not repo-scoped (unlike `recordFailure`) — a stuck/hung pass is a systemic
 *  fleet-wide symptom, not one repo's problem, so every company on this
 *  machine gets told, mirroring `recordFailure`'s no-match fallback shape. */
function recordStuckPoll(message: string): void {
  const companies = companyNames();
  const base = {
    ts: Date.now(), iso: new Date().toISOString(), oracle: "pr-watch",
    kind: "error" as const, summary: `pr-watch poll pass stuck: ${message}`,
  };
  if (!companies.length) { record(base); return; }
  for (const company of companies) record({ ...base, company });
}

let inFlightPoll: Promise<WorklogEntry[]> | null = null;
let consecutiveSkips = 0;
// kobo-631 — bumped on every FRESH pass (never on a deduped skip). A pass
// checks this against the generation it was born with before persisting: if
// a newer pass has since started (meaning THIS pass was abandoned by the
// timeout below), its own generation no longer matches and its write is
// DISCARDED, LOUDLY, instead of clobbering whatever the newer pass already
// wrote — belt-and-suspenders alongside the abort below, for whatever sliver
// of time exists between "timeout fired" and "the killed subprocess actually
// stops."
let currentGeneration = 0;
// kobo-631 — count of passes that timed out (abort requested) but have NOT
// yet been confirmed to have actually stopped. See `pollPrsOnce` below.
let zombiesInFlight = 0;

export function pollPrsOnce(): Promise<WorklogEntry[]> {
  if (inFlightPoll) {
    consecutiveSkips++;
    if (consecutiveSkips >= STUCK_POLL_SKIP_THRESHOLD) {
      recordStuckPoll(`${consecutiveSkips} consecutive ticks skipped waiting on one in-flight pass`);
    }
    return inFlightPoll;
  }
  consecutiveSkips = 0;
  const generation = ++currentGeneration;
  const controller = new AbortController();
  const rawPass = runPollPrsOnce(generation, controller.signal);
  let timedOut = false;
  // kobo-631 — settles whenever the REAL pass actually finishes, independent
  // of the raced/timeout-facing promise below. This is the only way to know
  // "has this generation actually stopped yet," since `controller.abort()`
  // REQUESTS cancellation but doesn't guarantee it: if the stale pass isn't
  // blocked on a `gh` subprocess at the exact moment of abort (e.g. it's
  // doing local per-PR work), it only stops at its NEXT `signal.aborted`
  // check (pollRepoOnce's per-PR loop, or runPollPrsOnce's repo loop) — not
  // instantly. `zombiesInFlight` counts passes that timed out and have NOT
  // yet been confirmed stopped, so the log line itself shows accumulation
  // directly, without needing to open source to know it's happening.
  rawPass.finally(() => { if (timedOut) zombiesInFlight--; });
  inFlightPoll = withTimeout(
    rawPass,
    pollTimeoutMs(),
    () => {
      // kobo-631 — actually REQUEST cancellation of the hung gh subprocess
      // (Bun.spawn's own `signal` option), not just stop waiting on it. A
      // timeout that only releases the reentrancy flag without also trying
      // to cancel the real work leaves an orphaned ("zombie") pass running
      // for as long as `gh` stays wedged, each one holding its own full
      // in-memory `snap` copy (958 keys / ~216KB today) PLUS an un-killed
      // `gh` child process, with no cap — one per tick, accumulating without
      // bound if `gh` stays wedged across many polls. This PR does not
      // CREATE that risk (the pre-existing code had NO reentrancy guard at
      // all, so overlapping passes could already accumulate AND race-write
      // the snapshot with zero dedup — arguably worse); it inherits a
      // narrowed version and closes most of it with real cancellation
      // instead of a cap added after the fact. NOT fully eliminated: see
      // `zombiesInFlight` above for the still-honest "not yet confirmed
      // stopped" residual — tracked in kobo-635 (dep on kobo-630; a
      // candidate contributor to that investigation, not a new mechanism
      // this PR introduces).
      timedOut = true;
      zombiesInFlight++;
      controller.abort();
      recordStuckPoll(`exceeded ${pollTimeoutMs()}ms — abort REQUESTED (gh subprocess + remaining PRs in the current repo), NOT yet confirmed stopped — ${zombiesInFlight} pass(es) fleet-wide currently in this not-yet-confirmed-stopped state`);
    },
  ).finally(() => { inFlightPoll = null; });
  return inFlightPoll;
}

/** Not repo-scoped, fleet-wide like `recordStuckPoll` — a stale pass writing
 *  over a newer one's state is a systemic correctness issue, not one repo's. */
function recordSuperseded(generation: number, repo: string): void {
  recordStuckPoll(`generation ${generation} discarded a stale write for ${repo} — superseded by generation ${currentGeneration}`);
}

async function runPollPrsOnce(generation: number, signal: AbortSignal): Promise<WorklogEntry[]> {
  const cfg = loadConfig() as any;
  const fallbackCompany: string | undefined = cfg.company;

  // Repos to poll = local worktree repos. This used to be union'd with the repos
  // referenced by open PR-linked cards (the board's own source of truth for which
  // repos mattered); that half retired with the task subsystem, so a repo with no
  // local worktree on this host is no longer polled.
  let repos: string[];
  try {
    repos = await repoFetcher();
  } catch {
    return [];
  }
  if (!repos.length) return [];

  const { snap, firstRun } = loadSnapshot();
  const recorded: WorklogEntry[] = [];

  for (const repo of repos) {
    if (signal.aborted) {
      recordStuckPoll(`generation ${generation} aborted — stopping before repo ${repo}`);
      break;
    }
    const outcome = await pollRepoOnce(repo, snap, firstRun, fallbackCompany, signal);
    Object.assign(snap, outcome.entries); // merge this repo's committed entries into the running view
    recorded.push(...outcome.recorded);
    if (outcome.failed) recordFailure(repo, outcome.failed);
    if (outcome.abortedMidLoop) {
      recordStuckPoll(`generation ${generation} aborted mid-repo ${repo} — ${outcome.abortedMidLoop} PR(s) left unprocessed, earlier PRs in this repo's list already had their side effects (worklog writes) applied from a stale view`);
    }
    if (outcome.changed) {
      // kobo-631 — reviewer-verified block: a stale (timed-out, abandoned)
      // pass could still reach this line after a NEWER pass has already
      // started and begun persisting — the abort above narrows that window
      // but doesn't guarantee it's zero. Without this check, the stale
      // pass's write would race the newer pass's and whichever finishes last
      // wins SILENTLY (this file's own original saveSnapshotAtomic doc
      // comment already describes exactly this race for two overlapping
      // writers — the reentrancy guard's timeout is what could reopen it).
      // Discarding a stale generation's write must itself be LOUD, never a
      // silent no-op, or this fix reintroduces the same silence it closes.
      if (generation === currentGeneration) saveSnapshotAtomic(snap);
      else recordSuperseded(generation, repo);
    }
    if (outcome.abortedMidLoop) break; // this generation is done — no point starting another repo
  }

  return recorded;
}

/** Fire-and-forget single poll (used by `maw done`). Never throws. */
export function triggerPrPollNow(): Promise<WorklogEntry[]> {
  return pollPrsOnce().catch(() => []);
}
