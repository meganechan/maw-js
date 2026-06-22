/**
 * PR watcher — on-demand (NO background loop, per re-scope).
 *
 * Poll is triggered three ways, each a single pass:
 *   1. `maw done`        — on-signal (worker finished)
 *   2. `maw watch log`   — on-read (someone opens the log)
 *   3. `maw watch sync`  — manual
 *
 * gh PR state is the ground truth for open/merged/closed. We diff against a
 * snapshot so each transition is logged exactly once. On a merge transition we
 * also ping the dept lead + author (see ./ping.ts).
 *
 * Tradeoff (accepted): a merge made on github.com while nobody triggers a poll
 * is only picked up on the next trigger. PostToolUse hooks catch in-pane
 * `gh pr merge` immediately, so this gap only affects out-of-band web merges.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { mawStatePath } from "../xdg";
import { scanWorktrees } from "../fleet/worktrees";
import { loadConfig } from "../../config";
import { appendWorklog } from "./store";
import { pingOnMerge } from "./ping";
import type { WorklogEntry } from "./types";

type PrState = "OPEN" | "MERGED" | "CLOSED";

interface SnapEntry {
  state: PrState;
  repo: string;
  number: number;
  title: string;
  author?: string;
}
type PrSnapshot = Record<string, SnapEntry>; // key = `${repo}#${number}`

interface GhPr {
  number: number;
  title: string;
  state: string; // OPEN | CLOSED | MERGED
  mergedAt: string | null;
  author?: { login?: string };
}

function snapshotPath(): string {
  return mawStatePath("watch-pr-state.json");
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

function saveSnapshot(snap: PrSnapshot): void {
  const p = snapshotPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(snap, null, 2) + "\n");
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh exited ${code}`);
  return out;
}

function prStateOf(pr: GhPr): PrState {
  if (pr.mergedAt) return "MERGED";
  return pr.state === "CLOSED" ? "CLOSED" : "OPEN";
}

/** Best-effort: forward the entry to the live feed (browsers) — never throws. */
function postLive(entry: WorklogEntry): void {
  const port = process.env.MAW_PORT || "3456";
  const body = JSON.stringify({
    oracle: entry.oracle,
    event: "Notification",
    project: entry.repo ?? "",
    host: "local",
    message: entry.summary,
    ts: entry.ts,
    data: { kind: entry.kind, pr: entry.pr, repo: entry.repo, by: entry.by, summary: entry.summary },
  });
  fetch(`http://localhost:${port}/api/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => {});
}

function record(entry: WorklogEntry): void {
  appendWorklog(entry);
  postLive(entry);
}

async function mergedBy(repo: string, num: number): Promise<string | undefined> {
  try {
    const out = await gh(["pr", "view", String(num), "--repo", repo, "--json", "mergedBy"]);
    return JSON.parse(out || "{}")?.mergedBy?.login || undefined;
  } catch {
    return undefined;
  }
}

export interface PollOpts {
  company?: string;
  dept?: string;
}

/** One poll pass over the fleet's repos. Returns the entries it recorded. */
export async function pollPrsOnce(opts: PollOpts = {}): Promise<WorklogEntry[]> {
  const cfg = loadConfig() as any;
  const company = opts.company ?? cfg.company;
  const dept = opts.dept ?? cfg.department;

  let repos: string[];
  try {
    const wts = await scanWorktrees();
    repos = [...new Set(wts.map(w => w.mainRepo).filter(Boolean))];
  } catch {
    return [];
  }
  if (!repos.length) return [];

  const { snap, firstRun } = loadSnapshot();
  const recorded: WorklogEntry[] = [];

  for (const repo of repos) {
    let prs: GhPr[];
    try {
      const out = await gh([
        "pr", "list", "--repo", repo, "--state", "all", "--limit", "30",
        "--json", "number,title,state,mergedAt,author",
      ]);
      prs = JSON.parse(out || "[]") as GhPr[];
    } catch {
      continue; // repo unreachable / no gh auth — skip, don't fail the pass
    }

    for (const pr of prs) {
      const key = `${repo}#${pr.number}`;
      const cur = prStateOf(pr);
      const prev = snap[key]?.state;
      const author = pr.author?.login;

      snap[key] = { state: cur, repo, number: pr.number, title: pr.title, author };

      // First ever run only seeds the baseline — no retroactive event spam.
      if (firstRun) continue;
      if (prev === cur) continue;

      const base = { ts: Date.now(), iso: new Date().toISOString(), oracle: author || "unknown", repo, pr: pr.number };
      if (cur === "MERGED") {
        const by = await mergedBy(repo, pr.number);
        const entry: WorklogEntry = { ...base, kind: "pr-merged", summary: `merged #${pr.number} ${pr.title}`, by };
        record(entry);
        recorded.push(entry);
        pingOnMerge({ company, dept, author: author ?? null, pr: pr.number, repo, by });
      } else if (cur === "CLOSED") {
        const entry: WorklogEntry = { ...base, kind: "pr-closed", summary: `closed #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      } else if (cur === "OPEN" && prev == null) {
        const entry: WorklogEntry = { ...base, kind: "pr-opened", summary: `opened #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      }
    }
  }

  saveSnapshot(snap);
  return recorded;
}

/** Fire-and-forget single poll (used by `maw done`). Never throws. */
export function triggerPrPollNow(opts: PollOpts = {}): Promise<WorklogEntry[]> {
  return pollPrsOnce(opts).catch(() => []);
}
