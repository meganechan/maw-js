/**
 * Worklog durable store — append-only JSONL, one file per company at
 * `<mawData>/worklog/<company>.jsonl`.
 *
 * Single writer (`appendWorklog`); sources are the feed listener (tool +
 * conversation events), the PR poller, and claim announce/release. JSONL keeps
 * the log greppable + crash-safe and honours "Nothing is Deleted".
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { mawDataPath } from "../xdg";
import type { WorklogEntry } from "./types";

const DEFAULT_COMPANY = "_unscoped";

function safeCompany(company?: string | null): string {
  const c = (company ?? DEFAULT_COMPANY).trim() || DEFAULT_COMPANY;
  return c.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function worklogPath(company?: string | null): string {
  return mawDataPath("worklog", `${safeCompany(company)}.jsonl`);
}

/** Append one entry, routed to its company's log. Single-line writes are atomic. */
export function appendWorklog(entry: WorklogEntry): void {
  const p = worklogPath(entry.company);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

export interface ReadWorklogOpts {
  limit?: number; // keep only the most recent N
  since?: number; // epoch ms — drop entries older than this
  oracle?: string; // filter by oracle
  kinds?: WorklogEntry["kind"][]; // filter by kind
}

export function readWorklog(company: string | null | undefined, opts: ReadWorklogOpts = {}): WorklogEntry[] {
  const p = worklogPath(company);
  if (!existsSync(p)) return [];
  let entries: WorklogEntry[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WorklogEntry);
    } catch {
      /* skip malformed line */
    }
  }
  if (opts.since != null) entries = entries.filter(e => e.ts >= opts.since!);
  if (opts.oracle) entries = entries.filter(e => e.oracle === opts.oracle);
  if (opts.kinds) entries = entries.filter(e => opts.kinds!.includes(e.kind));
  if (opts.limit != null && entries.length > opts.limit) entries = entries.slice(-opts.limit);
  return entries;
}

/**
 * Open claims for a company — claims with no later matching claim-release.
 * A release matches a claim by (oracle, task).
 */
export function openClaims(company: string | null | undefined): WorklogEntry[] {
  const all = readWorklog(company, { kinds: ["claim", "claim-release"] });
  const released = new Set<string>();
  // walk newest→oldest, a release cancels the most recent prior claim
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.kind === "claim-release") released.add(`${e.oracle}::${e.task ?? e.summary}`);
  }
  const open: WorklogEntry[] = [];
  const seen = new Set<string>();
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.kind !== "claim") continue;
    const key = `${e.oracle}::${e.task ?? e.summary}`;
    if (seen.has(key) || released.has(key)) continue;
    seen.add(key);
    open.push(e);
  }
  return open.reverse();
}
