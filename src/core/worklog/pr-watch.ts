/**
 * PR watcher — poll-based (snapshot diff, each transition logs once).
 *
 * Triggered by: `maw done` (on-signal), `maw company worklog log` (on-read),
 * `maw company worklog sync`, AND — via the standalone `pr-watch` daemon
 * (`vendor-plugins/serve-pr-watch/daemon.ts`, its own `pm2` process, kobo-33
 * originally / kobo-633 moved it out of `maw-server`'s own process) — its
 * periodic tick, so a plain github.com web-merge drives the linked card to
 * done with NO human `maw` command.
 * `gh pr list` is ground truth for open/merged/closed; we diff against a snapshot
 * so each transition logs exactly once. On merge we ping the author's dept lead +
 * the author (carrying content), so the log gets read.
 *
 * An out-of-band github.com web merge is picked up within one daemon tick (or
 * on the next on-demand trigger when the daemon isn't running). In-pane
 * `gh pr merge` is caught immediately by the PostToolUse hook.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";
import { mawStatePath } from "../xdg";
import { scanWorktrees } from "../fleet/worktrees";
import { loadConfig } from "../../config";
import { appendWorklog } from "./store";
import { completeOrParkMergedTask, findTasksByPr, prOpenedReview, setTaskRepoIfMissing, setTaskPrMergeState, listTasks, listCompanies } from "../tasks/store";
import { notifyReviewer } from "../tasks/notify";
import { pingOnMerge } from "./ping";
import { companyOfOracleStrict } from "./company-scope";
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
  // kobo-594: riding the SAME `gh pr list` call this file already makes for
  // open/merged/closed detection — zero extra `gh` calls, same poll cadence.
  // "UNKNOWN" is GitHub's own lazy-compute-pending value, distinct from this
  // repo never having checked at all (an absent TaskRecord.prMergeable).
  mergeable?: string; // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  mergeStateStatus?: string; // "CLEAN" | "DIRTY" | "BLOCKED" | "BEHIND" | "UNSTABLE" | "UNKNOWN" | "DRAFT"
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
 * process: `startServePrWatch`'s (called by `daemon.ts`, kobo-633) `setInterval`
 * calls `void d.pollPrsOnce().catch(...)` — `setInterval` does NOT wait for an
 * async callback to finish before scheduling the next tick, and there was no guard
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

// ---------------------------------------------------------------------------
// kobo-633 — heartbeat: a small file SEPARATE from the 216KB snapshot above,
// written on EVERY completed poll pass (not gated by transitions the way
// `saveSnapshotAtomic` deliberately is — see that function's own doc comment
// for why the snapshot's gate must NOT be removed). Two independent reasons
// it has to be its own file rather than a field bolted onto the snapshot:
//   (a) cost — writing the whole ~216KB snapshot unconditionally on every
//       pass (to record ~30 bytes of heartbeat) would reintroduce exactly the
//       ~30x write-amplification `saveSnapshotAtomic`'s gate exists to avoid;
//       this file is ~110 bytes and IS written unconditionally, so the actual
//       added cost is negligible instead of ~216KB/pass.
//   (b) survival — this lives once `pr-watch` becomes its own daemon process
//       (kobo-633's AC1): if the heartbeat lived only in daemon memory, a
//       dead daemon would take its own liveness signal down with it — silence
//       reporting on silence. A file survives the process that wrote it.
// ---------------------------------------------------------------------------

interface HeartbeatMeta {
  pollsCompleted: number;
  lastPollCompletedAtIso: string;
  // kobo-633 — stamped ONCE, the first time this process completes a pass,
  // then carried forward unchanged on every later write (same cache-once
  // shape as `codeVersion`). Exists so the acceptance check can tell "this
  // PR merged BEFORE the daemon ever ran" (retroactive visibility only, a
  // backfill) apart from "this PR merged AFTER the daemon was already
  // alive" (real evidence the daemon can drive a NEW transition, not just
  // see an old one) — front's exact distinction, and the reason kobo-641+
  // matters: 631/640/647/651 all merged and settled BEFORE this daemon
  // existed, so none of them can prove the second half.
  firstPollCompletedAtIso: string;
  codeVersion: string;
  intervalMs: number;
  // kobo-633 — front's correction: "the loop completed" is not "the loop did
  // anything useful." If `gh` is unreachable for EVERY watched repo, the pass
  // still finishes and `pollsCompleted` still advances — a heartbeat that's
  // fresh under that condition is a real signal pointing at the wrong
  // conclusion. Stamped from `lastPollRepoCounts()` right after the pass that
  // produced this heartbeat.
  reposTotal: number;
  reposFailed: number;
}

let metaPathOverride: (() => string) | null = null;

function metaPath(): string {
  return metaPathOverride ? metaPathOverride() : mawStatePath("watch-pr-state.meta.json");
}

/** TEST-ONLY seam — override the heartbeat file's path, same shape as
 *  `__setSnapshotPathForTest`. Caller MUST call `__resetMetaPathForTest()`. */
export function __setMetaPathForTest(fn: () => string): void {
  metaPathOverride = fn;
}

export function __resetMetaPathForTest(): void {
  metaPathOverride = null;
}

// kobo-633 — captured ONCE, lazily, on first use, then cached forever for the
// life of this process. A re-read on every heartbeat write would stamp
// whatever SHA happens to be on disk at write time, not the SHA the running
// process actually loaded at start — if someone `git pull`s without
// restarting the daemon, a live re-read would stamp a NEWER sha than the code
// that's actually executing: a version lie, which defeats the entire purpose
// of the stamp (telling apart a 631-era symptom from a 633-era one the first
// time this code runs in production — see the card's own UNKNOWN section).
let cachedCodeVersion: string | null = null;

function codeVersion(): string {
  if (cachedCodeVersion !== null) return cachedCodeVersion;
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir });
    cachedCodeVersion = proc.success ? proc.stdout.toString().trim() || "unknown" : "unknown";
  } catch {
    cachedCodeVersion = "unknown";
  }
  return cachedCodeVersion;
}

/** TEST-ONLY seam. */
export function __setCodeVersionForTest(v: string): void {
  cachedCodeVersion = v;
}
export function __resetCodeVersionForTest(): void {
  cachedCodeVersion = null;
}

let pollsCompletedCount = 0;
let firstPollCompletedAtIsoCache: string | null = null;

/** TEST-ONLY seam — reset the in-memory completed-pass counter AND the
 *  cached first-pass timestamp together (they share the same "since this
 *  process started" lifetime). */
export function __resetHeartbeatCountForTest(): void {
  pollsCompletedCount = 0;
  firstPollCompletedAtIsoCache = null;
}

/**
 * kobo-633 — call this from the standalone daemon (never from one-shot
 * triggers like `maw watch log`/`maw done` — those aren't the long-running
 * process this heartbeat exists to attest to) immediately after a poll pass
 * completes WITHOUT throwing. `pollsCompleted` therefore only advances on a
 * pass that ran cleanly through to the end (including any `saveSnapshotAtomic`
 * calls it needed) — a pass that throws partway never reaches this call, so
 * the counter already distinguishes "completed" from "died mid-pass" with no
 * extra bookkeeping beyond where this function is called from.
 *
 * Written atomically (tmp + rename), same pattern as `saveSnapshotAtomic`,
 * despite being tiny — this file is written on every single completed pass,
 * making it the most-frequently-written file in the whole system. A
 * non-atomic write torn by a kill mid-write would leave `JSON.parse` failing
 * on read, and the reader (`prWatchLiveness`, below) would then have no way
 * to tell "daemon never ran" apart from "caught it mid-write this instant" —
 * exactly the false-dead report this file exists to prevent.
 */
export function recordHeartbeat(intervalMs: number): void {
  pollsCompletedCount += 1;
  const nowIso = new Date().toISOString();
  if (firstPollCompletedAtIsoCache === null) firstPollCompletedAtIsoCache = nowIso;
  const { total, failed } = lastPollRepoCounts();
  const meta: HeartbeatMeta = {
    pollsCompleted: pollsCompletedCount,
    lastPollCompletedAtIso: nowIso,
    firstPollCompletedAtIso: firstPollCompletedAtIsoCache,
    codeVersion: codeVersion(),
    intervalMs,
    reposTotal: total,
    reposFailed: failed,
  };
  const p = metaPath();
  const tmp = `${p}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort — nothing to clean up if the write itself never landed */ }
    throw e;
  }
}

function loadHeartbeat(): HeartbeatMeta | null {
  const p = metaPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as HeartbeatMeta;
  } catch {
    return null;
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
 * Repos referenced by open (non-done) PR-linked cards, across every company on
 * this machine. The board's card→PR link is the source of truth for which repos
 * matter, independent of what worktrees/fleet windows happen to exist locally.
 */
export function openPrLinkedRepos(): string[] {
  return listCompanies().flatMap(company =>
    listTasks(company)
      .filter(t => typeof t.pr === "number" && t.state !== "done" && Boolean(t.repo))
      .map(t => t.repo as string),
  );
}

/**
 * kobo-631 — every company with at least one open PR-linked card for `repo`.
 * Used to route a REPO-LEVEL failure (the `gh pr list` call itself throwing,
 * before any specific PR/card is even known) — a single fallback company
 * would silently blind every OTHER company whose repo this also is. A repo
 * can legitimately matter to more than one company at once.
 */
function companiesForRepo(repo: string): string[] {
  return listCompanies().filter(company =>
    listTasks(company).some(t => typeof t.pr === "number" && t.state !== "done" && t.repo === repo),
  );
}

/**
 * Locate EVERY card linked to a PR across every company on this machine. The
 * card→PR link (task.pr) is globally unique per (company, card) but a single PR
 * can bind SEVERAL cards (kobo-43: PR #85 = kobo-38 + kobo-42) — so return all,
 * not the first, or merge→done strands every card past the first. Deliberately
 * does NOT map the PR author to a company: a github merge login often maps to
 * none, which previously stranded the flip.
 */
export function findCardsByPrAnywhere(pr: number, repo?: string): { company: string; taskId: string; assignee: string | null }[] {
  const hits: { company: string; taskId: string; assignee: string | null }[] = [];
  for (const company of listCompanies()) {
    for (const task of findTasksByPr(company, pr, repo)) hits.push({ company, taskId: task.id, assignee: task.assignee ?? null });
  }
  return hits;
}

export function findCardByPrAnywhere(pr: number, repo?: string): { company: string; taskId: string; assignee: string | null } | null {
  return findCardsByPrAnywhere(pr, repo)[0] ?? null;
}

/**
 * Merge = approval → flip EVERY card this PR binds (kobo-43), idempotently. A
 * deploy-required card parks in wait-for-deploy (kobo-274, merged≠live); the rest
 * go to done. This is the single flip primitive shared by (a) the OPEN→MERGED
 * transition and (b)
 * the kobo-228 reconcile pass. Idempotent by construction: findTasksByPr already
 * excludes done+rejected, so a re-run flips nothing that's already closed (no
 * resurrection — kobo-99/101). Heals a repo-less card on the way (kobo-80). Returns
 * the ids it actually flipped (empty = everything already closed → no churn).
 *
 * kobo-228: pr-watch is a single-fire snapshot transition-diff — the merge→done
 * flip only fires on the OPEN→MERGED edge. That edge is SWALLOWED when the snapshot
 * is reseeded across a server restart (firstRun baselines the current MERGED state
 * without acting) or when a card is linked/routed into review/approve AFTER the edge
 * already passed. An approve-lane card is the most exposed: it waits on a human gate,
 * so a reseed easily lands between merge and blessing → the card strands until a
 * manual `task done`. Calling this on EVERY poll for a MERGED pr closes that gap.
 */
export function reconcileMergedCards(pr: number, repo: string, by: string): string[] {
  const flipped: string[] = [];
  for (const hit of findCardsByPrAnywhere(pr, repo)) {
    setTaskRepoIfMissing(hit.company, hit.taskId, repo); // kobo-80: heal repo-less card
    // kobo-274: a deploy-required card parks in wait-for-deploy (merged≠live) instead
    // of done; non-deploy cards still flip straight to done.
    if (completeOrParkMergedTask(hit.company, hit.taskId, by)) flipped.push(hit.taskId);
  }
  return flipped;
}

/**
 * kobo-631 — a repo-level failure must be LOUD, not swallowed. Routes to
 * EVERY company with an open PR-linked card for `repo` (a repo can matter to
 * more than one company at once — a single fallback company would silently
 * blind the others, measured via `companiesForRepo`, not assumed). Falls
 * back to a company-less entry (still recorded, never dropped) only when no
 * company currently references this repo at all — e.g. a bare local
 * worktree scan hit with no linked card anywhere.
 */
function recordFailure(repo: string, message: string): void {
  const companies = companiesForRepo(repo);
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

// kobo-633 — `gh pr list --limit N` truncates SILENTLY: a repo with exactly
// N rows back is indistinguishable, from the response alone, from a repo
// truncated AT N — the count that matters (per-PR list length) cannot tell
// you which happened. This is the SAME bug class as the truncation trap this
// card's own AC5 verification script guards against — one lives in the
// script that CHECKS this code, this one lives in the code BEING checked;
// both found the same day.
//
// Deliberately NOT fixed by raising the limit or adding pagination here:
// raising the limit means fetching more per repo, every poll, forever, to
// guard against a case that (so far) only matters ONCE — the very first poll
// after a long outage. That is a permanent cost paid to cover a temporary
// condition, and it runs directly against kobo-631's own point of this file
// (the transition-gate exists specifically to keep per-poll cost down).
// Pagination is a real fix but a different-sized change, out of THIS card's
// scope. Instead: make the possible-truncation LOUD, with the repo and the
// exact count, the same shape as `recordFailure` above — if this line never
// fires, nobody needed pagination; if it does, there's a real number to act
// on instead of a guess.
const GH_PR_LIST_LIMIT = 30;

function recordPossibleTruncation(repo: string, count: number): void {
  const companies = companiesForRepo(repo);
  const base = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    oracle: "pr-watch",
    kind: "error" as const,
    summary: `poll for ${repo} returned ${count} PRs — EXACTLY the --limit (${GH_PR_LIST_LIMIT}), result may be truncated; older PRs could be silently missing from this pass`,
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
      "pr", "list", "--repo", repo, "--state", "all", "--limit", String(GH_PR_LIST_LIMIT),
      "--json", "number,title,state,mergedAt,author,mergeable,mergeStateStatus",
    ], signal);
    prs = JSON.parse(out || "[]") as GhPr[];
  } catch (e) {
    return { entries, recorded, failed: e instanceof Error ? e.message : String(e), changed: firstRun || sawTransition };
  }
  // kobo-633 — see recordPossibleTruncation's own doc comment above for why
  // this is loud-not-fixed: exactly GH_PR_LIST_LIMIT rows back means this
  // repo's list may have been cut off, not that there genuinely were only
  // this many. Checked here, before any per-PR processing, so it fires even
  // if the loop below finds nothing else worth reporting.
  if (prs.length === GH_PR_LIST_LIMIT) recordPossibleTruncation(repo, prs.length);

  try {
    for (const [i, pr] of prs.entries()) {
      // kobo-631 (reviewer-escalated: the generation check before
      // saveSnapshotAtomic alone was NOT enough) — by the time a stale,
      // timed-out pass would reach that check, it has ALREADY performed
      // every OTHER PR's real side effects for this repo: `record()`
      // (appendWorklog — could re-log a "pr-opened" for a PR a NEWER pass
      // already saw MERGED) and `reconcileMergedCards`/
      // `completeOrParkMergedTask` (mutate REAL CARDS on the board from a
      // stale view — worse blast radius than the snapshot file, same class
      // of risk this file's own `beforeEach` isolation assert already
      // treats `mawDataDir` as more dangerous than `mawStateDir` for).
      // Checking here, before EACH PR's side effects (not just once at the
      // end), bounds — doesn't eliminate, PRs already processed earlier in
      // this same loop can't be undone — how much stale work a superseded
      // pass can still do after being aborted.
      if (signal?.aborted) {
        return { entries, recorded, changed: firstRun || sawTransition, abortedMidLoop: prs.length - i };
      }
      const key = `${repo}#${pr.number}`;
      const cur = prStateOf(pr);
      const prev = snap[key]?.state;
      const author = pr.author?.login;

      // kobo-228 reconcile pass — a MERGED pr must leave NO linked card behind, even
      // when the merge→done EDGE was swallowed: a restart reseeds the snapshot
      // (firstRun baselines the current MERGED state without acting), or a card was
      // linked/routed into review/approve AFTER the edge already passed. Run it
      // exactly when the transition handler below WON'T (firstRun or no state change)
      // so a fresh OPEN→MERGED edge stays the transition handler's job (worklog +
      // ping + merger-resolved `by`). Idempotent: reconcileMergedCards flips only
      // still-open cards (done/rejected excluded) → no churn, no double-flip, no spam.
      if (cur === "MERGED" && (firstRun || prev === cur)) {
        try { reconcileMergedCards(pr.number, repo, author || "pr-watch"); }
        catch { /* never let task auto-done break PR-watch */ }
      }

      // kobo-594: runs on EVERY poll (before the firstRun/prev===cur early-outs
      // below, same placement reasoning as the reconcile pass above) — an OPEN PR
      // that never changes OPEN/MERGED/CLOSED state (the only thing `prev`/`cur`
      // track) can still flip mergeable→conflicting from a SIBLING PR merging
      // underneath it, with zero snapshot transition of its own. Gating this behind
      // `prev === cur` would mean it only ever updates on a PR's own open/merge/close
      // edge — exactly the gap this card exists to close. `pr.mergeable` is only
      // absent/undefined when `gh` itself failed upstream (JSON.parse threw or the
      // whole `gh` call errored, caught above) — the unhappy-path AC requires that
      // failure leave the card's prior value untouched, never write a guess.
      if (cur === "OPEN" && pr.mergeable && pr.mergeStateStatus) {
        for (const hit of findCardsByPrAnywhere(pr.number, repo)) {
          try { setTaskPrMergeState(hit.company, hit.taskId, pr.mergeable, pr.mergeStateStatus); }
          catch { /* never let this break PR-watch's other work */ }
        }
      }

      if (firstRun || prev === cur) {
        // seed baseline only, or genuinely no-op — nothing else to wait for,
        // safe to commit immediately.
        entries[key] = { state: cur, repo, number: pr.number, title: pr.title, author };
        continue;
      }

      sawTransition = true; // a real OPEN/MERGED/CLOSED edge, not a no-op — this repo's write is now earned.

      // The card→PR link is globally unique, so locate the card by PR number
      // across ALL companies rather than mapping the PR author to a company: a
      // github web-merge's author is the merging login (often a bot/human that
      // belongs to no company), which stranded the merge→done flip in _unscoped
      // and never reached the card (kobo-33 e2e). Prefer the card's own company
      // for the worklog entry too, so the event lands on that board's timeline.
      // Scope the card lookup to THIS repo — a PR number is unique only within a
      // repo, so merged owner/a#5 must not flip a card bound to owner/b#5 (kobo-99).
      const cardHits = findCardsByPrAnywhere(pr.number, repo);
      // kobo-216 — resolve the author's company via the STRICT resolver: no silent
      // first-match (the AC gap). This is a background daemon with no --company to
      // supply, so an ambiguous (multi-company) author can't be prompted — catch the
      // throw and fall to the configured fallbackCompany rather than aborting the whole
      // poll cycle (matches this file's "never let X break PR-watch" contract). The
      // primary path (cardHits[0].company) is unaffected; a single-company author
      // resolves byte-for-byte as before, so no worklog entry shifts company.
      let authorCompany: string | null = null;
      if (author) {
        try { authorCompany = companyOfOracleStrict(author); }
        catch { authorCompany = null; } // ambiguous → fallbackCompany, never guess a board
      }
      const company = cardHits[0]?.company ?? authorCompany ?? fallbackCompany;
      const base = { ts: Date.now(), iso: new Date().toISOString(), oracle: author || "unknown", company, repo, pr: pr.number };

      if (cur === "MERGED") {
        const by = await mergedBy(repo, pr.number, signal);
        const entry: WorklogEntry = { ...base, kind: "pr-merged", summary: `merged #${pr.number} ${pr.title}`, by };
        record(entry);
        recorded.push(entry);
        // kobo-631: `lead` used to be derived from the GitHub `author` login via
        // scopeOfOracle(author) — but every PR merges under ONE shared, fleet-wide
        // github account (kobo-217), which is never itself a registered oracle, so
        // that lookup always resolved to null. Use the linked card's own assignee
        // instead — a real oracle name, already on the card (Board Truth rule 3:
        // the shared PR-author is meaningless as owner).
        const assignee = cardHits[0]?.assignee ?? null;
        pingOnMerge({ lead: assignee, author: null, pr: pr.number, repo, by });
        // Track 4 — merge = approval → auto-done EVERY card that owns this PR
        // (kobo-43: one PR can bind several cards; flip them all, not just the
        // first, or the rest strand in review until a human hand-flips). Shares the
        // idempotent flip primitive with the kobo-228 reconcile pass — merger `by`
        // resolved here (fresh edge); a re-poll's reconcile no-ops (card already done).
        try { reconcileMergedCards(pr.number, repo, by || author || "pr-watch"); }
        catch { /* never let task auto-done break PR-watch */ }
      } else if (cur === "CLOSED") {
        const entry: WorklogEntry = { ...base, kind: "pr-closed", summary: `closed #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      } else if (cur === "OPEN" && prev == null) {
        const entry: WorklogEntry = { ...base, kind: "pr-opened", summary: `opened #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
        // eq3-011 kobo-13: PR open = truth → drive the linked card(s) to review,
        // reviewer resolved via the chain. kobo-217: the doer (assignee) is KEPT —
        // the shared-github PR author is never stamped as owner (Board Truth rule 9).
        // Mirrors the merge→done path; acts off the card.pr link, fires once on this
        // OPEN transition. kobo-43: flip every card the PR binds, not just the first.
        try {
          if (author) for (const hit of cardHits) {
            setTaskRepoIfMissing(hit.company, hit.taskId, repo); // kobo-80: bind repo on the open→review flip → merge poll is guaranteed later
            const reviewed = prOpenedReview(hit.company, hit.taskId, author);
            if (reviewed) notifyReviewer(reviewed, author); // kobo-144: poke the resolved reviewer that a PR is up
          }
        } catch { /* never let task lifecycle break PR-watch */ }
      }

      // Committed only now — after this PR's real side effect has already
      // landed (`record()` above already returned).
      entries[key] = { state: cur, repo, number: pr.number, title: pr.title, author };
    }
  } catch (e) {
    return { entries, recorded, failed: e instanceof Error ? e.message : String(e), changed: firstRun || sawTransition };
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
  const companies = listCompanies();
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

// kobo-633 — set at the end of the MOST RECENT completed `runPollPrsOnce`
// pass. Exists because "the poll loop completed" and "the poll loop did
// anything useful" are DIFFERENT facts — if `gh` is unreachable for EVERY
// watched repo, the loop still finishes normally (`pollRepoOnce` catches the
// failure and returns `failed`, the outer loop just moves to the next repo),
// so a heartbeat/`pollsCompleted` advancing on its own is a real but
// MISLEADING signal: it proves the daemon PROCESS is alive, not that it
// accomplished anything. Front's framing: this is the exact same "metric is
// true while the real thing is broken" shape as the snapshot-content gap
// found the same round — that one lived in what the snapshot could prove,
// this one lives in what a bare completion counter can prove.
let lastPassRepoTotal = 0;
let lastPassRepoFailed = 0;

/** Read after `pollPrsOnce()` resolves — how many repos this pass attempted
 *  vs how many of them failed (their own `gh` call or processing threw). */
export function lastPollRepoCounts(): { total: number; failed: number } {
  return { total: lastPassRepoTotal, failed: lastPassRepoFailed };
}

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

  // Repos to poll = local worktree repos ∪ repos referenced by open PR-linked
  // cards. Worktree scan alone misses a repo whose PRs drive the board when no
  // .wt-*/agents worktree or fleet window exists for it on this host (e.g. a
  // served maw-server on a box that only has its own repo checked out) — the
  // card→PR link is the board's own source of truth, so poll exactly what the
  // board points at. Generic on task.repo (any company/repo), never hardcoded.
  let repos: string[];
  try {
    const wts = await scanWorktrees();
    const worktreeRepos = wts.map(w => w.mainRepo).filter(Boolean);
    repos = [...new Set([...worktreeRepos, ...openPrLinkedRepos()])];
  } catch {
    lastPassRepoTotal = 0;
    lastPassRepoFailed = 0;
    return [];
  }
  if (!repos.length) {
    lastPassRepoTotal = 0;
    lastPassRepoFailed = 0;
    return [];
  }

  const { snap, firstRun } = loadSnapshot();
  const recorded: WorklogEntry[] = [];
  // kobo-633 — repos ATTEMPTED this pass (pollRepoOnce actually called for
  // them) vs how many failed. NOT the same as `repos.length` if the pass
  // aborts partway — only count what was actually tried.
  let repoTotal = 0;
  let repoFailed = 0;

  for (const repo of repos) {
    if (signal.aborted) {
      recordStuckPoll(`generation ${generation} aborted — stopping before repo ${repo}`);
      break;
    }
    repoTotal++;
    const outcome = await pollRepoOnce(repo, snap, firstRun, fallbackCompany, signal);
    Object.assign(snap, outcome.entries); // merge this repo's committed entries into the running view
    recorded.push(...outcome.recorded);
    if (outcome.failed) { recordFailure(repo, outcome.failed); repoFailed++; }
    if (outcome.abortedMidLoop) {
      recordStuckPoll(`generation ${generation} aborted mid-repo ${repo} — ${outcome.abortedMidLoop} PR(s) left unprocessed, earlier PRs in this repo's list already had their side effects (worklog/card writes) applied from a stale view`);
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

  lastPassRepoTotal = repoTotal;
  lastPassRepoFailed = repoFailed;
  return recorded;
}

/** Fire-and-forget single poll (used by `maw done`). Never throws. */
export function triggerPrPollNow(): Promise<WorklogEntry[]> {
  return pollPrsOnce().catch(() => []);
}

// ---------------------------------------------------------------------------
// kobo-633 AC3 — TWO SEPARATE TIERS, never rendered as one flat list (front's
// explicit lock, this round): a nice-looking Tier 2 counter must never read
// as satisfying Tier 1, or the next person who reads this stops at "counters
// are fine" and never notices the daemon accomplished nothing.
//
// TIER 1 — ACCEPTANCE (`PrWatchAcceptanceResult`): the ONE check that can
// fail a daemon that LOOKS healthy but is USELESS — does every PR GitHub
// says merged (since `sinceIso`) have at least one linked card correctly
// flipped to done/wait-for-deploy. THREE verdicts, not two:
//   - "n/a"    — no PR merged since `sinceIso` among any repo with a linked
//                card. NOT a pass — a quiet night vacuously satisfies
//                `merged − flipped = ∅` without ever exercising anything.
//                Front: "n/a ไม่ใช่การยอมรับ มันคือการยังไม่ได้ทดสอบ."
//   - "passed" — at least one PR merged, and EVERY one has a flipped card.
//                Proves the RESULT happened — does NOT prove the DAEMON did
//                it (pollPrsOnce is CLI-reachable too — `maw watch
//                log/sync`, `maw done`; kobo-640 tonight is a real instance
//                of a CLI trigger doing the flip). Attributing the ACTOR
//                needs Tier 2's heartbeat/codeVersion, never this tier alone.
//   - "failed" — at least one merged PR has NO flipped card anywhere. A real,
//                unambiguous defect.
// Deliberately reads cards WITHOUT `findTasksByPr`/`findCardsByPrAnywhere` —
// both exclude done/rejected/wait-for-deploy by design (their original
// caller wants only STILL-OPEN work). Reused here, that exclusion silently
// removes the exact evidence a "passed" verdict needs (a DONE card IS the
// proof) — the same "tool answers a narrower question than the one asked"
// shape chased all night. This tier reads the task store directly, matching
// repo+number, no state excluded.
//
// TIER 2 — DIAGNOSTICS (`PrWatchDiagnostics`): heartbeat freshness +
// pollsCompleted + reposTotal/reposFailed + resolved file paths. These
// LOCATE where something is broken — they never PROVE nothing is. A fresh
// heartbeat with reposFailed < reposTotal only means "the loop ran and did
// SOME work" — it says nothing about whether the work was correct, which is
// exactly what Tier 1 is for. The two tiers are complementary, not
// redundant: Tier 1 is always correct when it fires but not always
// applicable (silent on a quiet night); Tier 2 is always applicable but
// never sufficient alone (proven this round — a fresh heartbeat coexisted
// with a daemon that reconciled nothing, see the all-repos-failed gate
// below).
// ---------------------------------------------------------------------------

// kobo-633 — "unknown" added per front's hard rule: if any repo's fetch hit
// exactly `limit` (truncation suspected), a "passed" verdict is FORBIDDEN,
// not merely discouraged — a false "passed" is worse than a false "n/a"
// (front: "n-a ที่โดนตัด... คนอ่านรู้ว่าต้องไปดูต่อ · passed ที่โดนตัด...
// คนอ่านจะปิดเรื่อง"). "failed" is UNAFFECTED by truncation — a confirmed
// defect within the visible set stays confirmed regardless of what a
// truncated tail might also contain.
export type PrWatchAcceptanceVerdict = "passed" | "failed" | "n/a" | "unknown";

export interface PrWatchAcceptanceResult {
  verdict: PrWatchAcceptanceVerdict;
  reason: string;
  sinceIso: string;
  mergedSinceCount: number;
  // kobo-633 — front: EVERY verdict must print the inputs that produced it,
  // "n/a" most of all. A "n/a" with only the window stated still can't be
  // told apart from a DIFFERENT failure: real merges existed but a repo's
  // `gh pr list` result got cut off at `limit` and filtered down to nothing
  // — that's a truncation bug, not an empty incident, and it needs a
  // completely different fix. Stamping `limit` alongside `mergedSinceCount`
  // lets a reader tell "genuinely nothing merged" apart from "got truncated
  // to nothing" without re-deriving it — same principle as this file's own
  // `recordPossibleTruncation` guard, applied to THIS check's own gh calls.
  limit: number;
  passedCount: number;
  failed: { repo: string; number: number; mergedAt: string }[];
  // kobo-633 — front's 3rd instance of the same rule tonight ("a case that
  // can't be classified must not be swallowed into either the good or the
  // bad bucket" — 1st: `unknown` for truncation, 2nd: `n/a` for nothing
  // merged, 3rd: this): a merged PR with NO linked card anywhere is neither
  // a daemon failure (there was nothing FOR it to flip) nor silently fine
  // (a merged PR with no card is a real board gap — either work landed
  // without ever being tracked, or a card exists but was never stamped with
  // its PR number; different problems, different fixes, both invisible if
  // this list doesn't exist). Reported ALWAYS, never folded into `failed`,
  // and never allowed to produce a false "passed" either — see
  // `computeAcceptance`'s verdict logic: `passedCount` only counts CHECKABLE
  // (has ≥1 card) PRs, so a batch that's entirely unlinked reports "n/a",
  // not "passed" (nothing was actually verified).
  unlinked: { repo: string; number: number; mergedAt: string }[];
  // kobo-633 — front, mandatory: the report must ALWAYS state which of two
  // DIFFERENT claims it's making, never left for a human caption (people
  // forget to write it down; a report field can't). "retroactive-only" —
  // every checked PR merged BEFORE this daemon process ever completed a
  // pass, so a "passed" verdict proves the daemon can SEE a past merge
  // (backfill), never that it can DRIVE a brand-new transition live.
  // "live-transition-demonstrated" — at least one checkable, correctly
  // flipped PR merged AFTER this daemon had already completed its first
  // pass — real evidence of the stronger claim. "unknown" — no heartbeat to
  // compare against. This distinction is exactly why 631/640/647/651 (all
  // merged and settled before this daemon ever existed) can only ever prove
  // the first claim — kobo-641 onward, merged while the daemon is already
  // confirmed alive, is what can prove the second.
  provenanceClaim: "retroactive-only" | "live-transition-demonstrated" | "unknown";
  provenanceReason: string;
}

export type PrWatchHeartbeatStatus = "fresh" | "stale" | "missing";

export interface PrWatchDiagnostics {
  heartbeatStatus: PrWatchHeartbeatStatus;
  reason: string;
  // kobo-633 — front's own live incident: a snapshot with 335 keys for
  // `meganechan/maw-js` (proving the repo WAS watched, historically) yet no
  // `#389`/`#390` at all — took multiple rounds of manual hunting across
  // `~/.maw`/`/tmp`/Application Support/`.local/share` to even confirm which
  // file the running code actually reads/writes, because nothing said so on
  // its own. Always populated — the actual RESOLVED path (via
  // `snapshotPath()`/`metaPath()`), never the env var that's supposed to
  // produce it (same principle as this session's own test-isolation rule:
  // assert the resolved path, not that a variable is set — this is the
  // production-runtime version of that rule).
  snapshotFilePath: string;
  metaFilePath: string;
  pollsCompleted?: number;
  lastPollCompletedAtIso?: string;
  firstPollCompletedAtIso?: string;
  // kobo-633 — front: a "fresh"/"stale" verdict must print the age it was
  // computed from, not just the verdict word — the same input the code
  // itself compared against `STALE_HEARTBEAT_MULTIPLIER * intervalMs` to
  // decide fresh vs stale. Populated whenever a heartbeat file exists at
  // all (fresh OR stale); absent only when `heartbeatStatus === "missing"`.
  ageSeconds?: number;
  codeVersion?: string;
  reposTotal?: number;
  reposFailed?: number;
}

export interface PrWatchLivenessResult {
  acceptance: PrWatchAcceptanceResult;
  diagnostics: PrWatchDiagnostics;
}

// kobo-633 — 3 missed intervals, not 1: tolerates one slow/retried tick
// (pr-watch's own `pollTimeoutMs` above is already up to 90s) without crying
// wolf on a daemon that's merely running a hair behind schedule.
const STALE_HEARTBEAT_MULTIPLIER = 3;

// kobo-633 — front's correction: a SILENT default here is a trap, not a
// convenience. The real acceptance window is T0 — a FIXED point in time
// (when pr-watch was actually turned off) — never "24h before whenever this
// happened to run." A floating default drifts with the caller's clock: run
// it tomorrow with no `sinceIso` and you get an entirely different universe
// than the incident's own AC means, and the moment the real T0 falls
// outside a rolling 24h window, this would return `"n/a"` while real,
// unreconciled merges sit right there — a FALSE "n/a", the exact same
// false-comfort-metric shape this whole card spent the night hunting, just
// with a different metric. `prWatchLiveness` therefore takes `sinceIso` as a
// REQUIRED parameter — no default, cannot be silently omitted. This
// constant stays EXPORTED only so a caller that explicitly wants a rolling
// "daily status" window (not an acceptance verdict) can opt into it on
// purpose: `prWatchLiveness(new Date(Date.now() -
// DEFAULT_ACCEPTANCE_LOOKBACK_MS).toISOString())`. Whichever window a caller
// picks, `PrWatchAcceptanceResult.sinceIso` always echoes it back — an
// answer that doesn't state which window it measured gets reused outside
// that window every time (proven live this round: the merged-PR set itself
// changed within under 90 seconds).
export const DEFAULT_ACCEPTANCE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * kobo-633 — reads the task store DIRECTLY, no state excluded (see the tier
 * comment block above for why `findTasksByPr`/`findCardsByPrAnywhere` are
 * wrong for this specific question).
 */
function findAllCardsByPrUnfiltered(repo: string, number: number): { company: string; taskId: string; state: string }[] {
  const hits: { company: string; taskId: string; state: string }[] = [];
  for (const company of listCompanies()) {
    for (const task of listTasks(company)) {
      if (task.pr === number && task.repo === repo) hits.push({ company, taskId: task.id, state: task.state });
    }
  }
  return hits;
}

async function computeAcceptance(sinceIso: string): Promise<PrWatchAcceptanceResult> {
  // Every repo that has EVER had a PR-linked card, any state — deliberately
  // not `openPrLinkedRepos()` (excludes done, same class of gap as above).
  const repos = [...new Set(
    listCompanies().flatMap(c => listTasks(c).filter(t => typeof t.pr === "number" && t.repo).map(t => t.repo as string)),
  )].sort();

  const mergedSince: { repo: string; number: number; mergedAt: string }[] = [];
  const truncatedRepos: string[] = [];
  for (const repo of repos) {
    try {
      const out = await ghFetcher([
        "pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${sinceIso}`,
        "--limit", String(GH_PR_LIST_LIMIT), "--json", "number,mergedAt",
      ]);
      const list = JSON.parse(out || "[]") as { number: number; mergedAt: string }[];
      // Same truncation trap as the main poll's own gh pr list, same guard —
      // AND, unlike the main poll, this ALSO changes the verdict below, not
      // just a loud log line: a truncated fetch can never justify "passed".
      if (list.length === GH_PR_LIST_LIMIT) {
        recordPossibleTruncation(repo, list.length);
        truncatedRepos.push(repo);
      }
      for (const pr of list) mergedSince.push({ repo, number: pr.number, mergedAt: pr.mergedAt });
    } catch {
      // A single repo's gh failure doesn't invalidate the whole acceptance
      // check — the other repos' evidence still stands; this repo's own
      // absence from the result is itself visible via `repos.length` vs
      // how many contributed to `mergedSince`, not hidden.
    }
  }

  // kobo-633 — front: these 3 fields (sinceIso, mergedSinceCount, limit) are
  // PROVENANCE of the verdict, not a property of any one state — every
  // return below carries the exact same shape so a reader can always tell
  // which data set produced this answer, regardless of which verdict it is.
  const provenance = { sinceIso, mergedSinceCount: mergedSince.length, limit: GH_PR_LIST_LIMIT };

  // kobo-633 — front, mandatory: the report must ALWAYS state which of TWO
  // claims it's making — "saw a merge that predates this daemon" (backfill/
  // retroactive — 631/640/647/651 all merged and settled before this daemon
  // ever existed, so they can only ever prove this) vs "saw a merge that
  // happened AFTER the daemon was already alive and correctly flipped it"
  // (real evidence the daemon can drive a NEW transition, not just see an
  // old one — kobo-641 onward is what can prove this). Computed inline
  // below, alongside the failed/unlinked classification, to avoid a second
  // pass over `findAllCardsByPrUnfiltered`.
  const heartbeatForProvenance = loadHeartbeat();
  let provenanceClaim: PrWatchAcceptanceResult["provenanceClaim"] = "unknown";
  let provenanceReason = "no heartbeat recorded yet — cannot compare merge times against daemon uptime";

  const failed: { repo: string; number: number; mergedAt: string }[] = [];
  const unlinked: { repo: string; number: number; mergedAt: string }[] = [];
  let passedCount = 0;
  for (const pr of mergedSince) {
    const cards = findAllCardsByPrUnfiltered(pr.repo, pr.number);
    // kobo-633 — a merged PR with ZERO linked cards is neither a daemon
    // failure (nothing existed for it to flip) nor evidence of success —
    // it's a THIRD, unclassifiable case (front's 3rd instance of "don't
    // fold the can't-classify case into good or bad" tonight). Reported in
    // `unlinked`, never in `failed`, never counted toward `passedCount`.
    if (!cards.length) { unlinked.push(pr); continue; }
    const anyFlipped = cards.some(c => c.state === "done" || c.state === "wait-for-deploy");
    if (anyFlipped) {
      passedCount++;
      if (
        provenanceClaim !== "live-transition-demonstrated" &&
        heartbeatForProvenance &&
        new Date(pr.mergedAt).getTime() > new Date(heartbeatForProvenance.firstPollCompletedAtIso).getTime()
      ) {
        provenanceClaim = "live-transition-demonstrated";
        provenanceReason = `${pr.repo}#${pr.number} merged ${pr.mergedAt}, AFTER this daemon's first completed pass (${heartbeatForProvenance.firstPollCompletedAtIso}), and is correctly flipped — real evidence the daemon can drive a NEW transition, not just see an old one`;
      }
    } else {
      failed.push(pr);
    }
  }
  // kobo-633 — reviewer caught this (feeds directly into front's own
  // reasoning for releasing kobo-641's merge brake — this field IS that
  // reasoning, so it can't be allowed to blur): the ORIGINAL fallback here
  // collapsed two genuinely different situations into the same
  // `"retroactive-only"` value — (a) real evidence exists: at least one
  // flipped PR was found, all of it merged before the daemon's first pass
  // (a true, if weak, positive claim) vs (b) NO evidence exists at all —
  // nothing merged, or nothing that merged ever got flipped — which is not
  // "weak evidence," it's NO evidence, and claiming `"retroactive-only"`
  // there overclaims exactly the same way a bare `n/a` overclaiming
  // `"passed"` would (front's own earlier rule, not yet applied to THIS
  // field until now — the same probe-collapsing-3-states-into-2 trap, one
  // level deeper). Fixed: `"retroactive-only"` now REQUIRES `passedCount >
  // 0` (genuine flipped-PR evidence, just capped at the weaker claim);
  // anything else with a heartbeat but no such evidence is `"unknown"`,
  // with a reason naming WHICH absence it is (no heartbeat vs nothing
  // merged vs nothing flipped) — different absences need different next
  // steps, so collapsing them back into one shrug-bucket would recreate the
  // exact "unknown-without-a-reason" trap already fixed for `acceptance`.
  if (provenanceClaim !== "live-transition-demonstrated") {
    if (!heartbeatForProvenance) {
      provenanceClaim = "unknown";
      provenanceReason = "no heartbeat recorded yet — cannot compare merge times against daemon uptime";
    } else if (passedCount === 0) {
      provenanceClaim = "unknown";
      provenanceReason = mergedSince.length
        ? `heartbeat exists (first completed pass: ${heartbeatForProvenance.firstPollCompletedAtIso}) but none of the ${mergedSince.length} merged PR(s) found have a flipped card — never observed a genuine transition to judge provenance from`
        : `heartbeat exists (first completed pass: ${heartbeatForProvenance.firstPollCompletedAtIso}) but nothing merged since ${sinceIso} to compare — never observed ANY transition, live or retroactive, to measure`;
    } else {
      provenanceClaim = "retroactive-only";
      provenanceReason = `${passedCount} flipped PR(s) found, all merged before or without a confirmed daemon pass after them (first completed pass: ${heartbeatForProvenance.firstPollCompletedAtIso}) — proves the daemon CAN see a past merge (backfill), not that it can drive a new one live`;
    }
  }
  const provenanceClaimFields = { provenanceClaim, provenanceReason };

  // A confirmed defect stands regardless of truncation elsewhere — more
  // (unseen) data could only ADD failures, never retract this one.
  if (failed.length > 0) {
    return {
      verdict: "failed",
      reason: `${failed.length} of ${mergedSince.length} PR(s) merged since ${sinceIso} have a linked card that's NOT done/wait-for-deploy${unlinked.length ? ` (${unlinked.length} other merged PR(s) are unlinked — see acceptance.unlinked, not counted here)` : ""}`,
      ...provenance, ...provenanceClaimFields, passedCount, failed, unlinked,
    };
  }

  // kobo-633 — HARD RULE, not a suggestion: truncation suspected means we
  // cannot claim to have seen everything, so "passed" is forbidden even
  // though nothing FOUND failed — "found nothing wrong in a set we know is
  // incomplete" must never render the same as "checked everything, all
  // clear." A false "passed" here is worse than a false "n/a" (front: "n-a
  // ที่โดนตัด... คนอ่านรู้ว่าต้องไปดูต่อ · passed ที่โดนตัด...
  // คนอ่านจะปิดเรื่อง").
  if (truncatedRepos.length > 0) {
    return {
      verdict: "unknown",
      reason: `${truncatedRepos.join(", ")} returned exactly ${GH_PR_LIST_LIMIT} (the limit) — cannot confirm the full merged set was seen, so "passed" cannot be claimed even though nothing found among the ${mergedSince.length} PR(s) actually fetched was missing a flipped card`,
      ...provenance, ...provenanceClaimFields, passedCount, failed: [], unlinked,
    };
  }

  // kobo-633 — `passedCount === 0` here covers BOTH "nothing merged at all"
  // AND "things merged but every single one is unlinked" — in either case
  // NOTHING was actually verified via a card, so "passed" would be a false
  // claim of having checked something. Reason string distinguishes the two
  // for a human reader; the verdict itself is the same "untested" word on
  // purpose (front: n/a means untested, not a special case of failure).
  if (passedCount === 0) {
    return {
      verdict: "n/a",
      reason: !mergedSince.length
        ? `no PR merged since ${sinceIso} among any repo with a linked card (fetched 0, limit ${GH_PR_LIST_LIMIT}/repo, no repo truncated) — untested, not passed (front: "n/a ไม่ใช่การยอมรับ")`
        : `${mergedSince.length} PR(s) merged since ${sinceIso}, but ALL are unlinked to any card (see acceptance.unlinked) — nothing was actually checkable, so this is untested, not passed`,
      ...provenance, ...provenanceClaimFields, passedCount: 0, failed: [], unlinked,
    };
  }

  return {
    verdict: "passed",
    reason: `all ${passedCount} checkable PR(s) merged since ${sinceIso} have a linked card correctly flipped, and no repo's fetch was truncated${unlinked.length ? ` (${unlinked.length} other merged PR(s) are unlinked — see acceptance.unlinked, not counted toward this verdict)` : ""} — this proves the RESULT happened, NOT that the daemon specifically did it (pollPrsOnce is CLI-reachable too); see diagnostics.heartbeatStatus/codeVersion to attribute the actor`,
    ...provenance, ...provenanceClaimFields, passedCount, failed: [], unlinked,
  };
}

function computeDiagnostics(): PrWatchDiagnostics {
  const paths = { snapshotFilePath: snapshotPath(), metaFilePath: metaPath() };
  const heartbeat = loadHeartbeat();
  if (!heartbeat) {
    return { heartbeatStatus: "missing", reason: "no completed pass ever recorded (heartbeat file missing or unreadable)", ...paths };
  }
  const ageMs = Date.now() - new Date(heartbeat.lastPollCompletedAtIso).getTime();
  const staleAfterMs = heartbeat.intervalMs * STALE_HEARTBEAT_MULTIPLIER;
  const base = {
    ...paths,
    pollsCompleted: heartbeat.pollsCompleted,
    lastPollCompletedAtIso: heartbeat.lastPollCompletedAtIso,
    firstPollCompletedAtIso: heartbeat.firstPollCompletedAtIso,
    ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : undefined,
    codeVersion: heartbeat.codeVersion,
    reposTotal: heartbeat.reposTotal,
    reposFailed: heartbeat.reposFailed,
  };
  if (!Number.isFinite(ageMs) || ageMs > staleAfterMs) {
    return {
      heartbeatStatus: "stale",
      reason: `last completed pass was ${Math.round(ageMs / 1000)}s ago — exceeds ${STALE_HEARTBEAT_MULTIPLIER}x the configured ${heartbeat.intervalMs}ms interval`,
      ...base,
    };
  }
  // kobo-633 — "the loop completed" is not "the loop did anything useful."
  // Surfaced here as a DIAGNOSTIC fact (fresh but reposFailed===reposTotal),
  // not as a verdict of its own — Tier 1's acceptance check is what actually
  // judges usefulness; this tier only ever locates.
  if (heartbeat.reposTotal > 0 && heartbeat.reposFailed === heartbeat.reposTotal) {
    return {
      heartbeatStatus: "fresh",
      reason: `heartbeat is fresh (pass completed) but ALL ${heartbeat.reposTotal} watched repo(s) failed this pass — the loop ran, nothing it did succeeded`,
      ...base,
    };
  }
  return { heartbeatStatus: "fresh", reason: `heartbeat fresh, ${heartbeat.reposTotal - heartbeat.reposFailed}/${heartbeat.reposTotal} repo(s) succeeded last pass`, ...base };
}

/**
 * kobo-633 — pull-probe (Board Truth rule 19): answerable at any moment.
 * `sinceIso` REQUIRED, no default — bounds Tier 1's acceptance check. Front's
 * correction: a silent rolling default is a trap here specifically, because
 * the acceptance window is T0, a FIXED point in time, not "N hours before
 * whenever this happens to run" — see `DEFAULT_ACCEPTANCE_LOOKBACK_MS`'s own
 * doc comment for the false-"n/a" failure mode a silent default produces.
 * Callers who genuinely want a rolling "daily status" window (not an
 * acceptance verdict) opt in explicitly:
 * `prWatchLiveness(new Date(Date.now() -
 * DEFAULT_ACCEPTANCE_LOOKBACK_MS).toISOString())`. Whichever window is
 * chosen, `result.acceptance.sinceIso` always echoes it back. Tier 2
 * (diagnostics) is unaffected by `sinceIso`.
 */
export async function prWatchLiveness(sinceIso: string): Promise<PrWatchLivenessResult> {
  // kobo-633 — TypeScript's required-param check is a compile-time guard
  // only; a plain-JS caller (or one that bypasses types) can still pass
  // `undefined`/`""`. Front: reject loudly, never guess a window and return
  // a fake "n/a" — 48h/72h defaults are the same trap as 24h, just slower to
  // drift; the real problem is answering a question nobody specified, not
  // the specific length chosen.
  if (!sinceIso) {
    throw new Error(
      "prWatchLiveness: sinceIso is required — refusing to guess a window. " +
      "Use the incident's real T0 (see kobo-633's card, e.g. 2026-07-29T10:08:53Z) " +
      "or explicitly compute a rolling window yourself if that's genuinely what you want.",
    );
  }
  const [acceptance, diagnostics] = await Promise.all([
    computeAcceptance(sinceIso),
    Promise.resolve(computeDiagnostics()),
  ]);
  return { acceptance, diagnostics };
}
