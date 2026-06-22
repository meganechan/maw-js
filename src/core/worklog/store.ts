/**
 * Worklog durable store — append-only JSONL at `<mawData>/worklog.jsonl`.
 *
 * One writer (`appendWorklog`), two sources:
 *   - tool-call feed events (server-side listener, see ./listener.ts)
 *   - PR lifecycle events (the on-demand poller, see ./pr-watch.ts)
 *
 * JSONL (one entry per line) keeps the log greppable + crash-safe and honours
 * "Nothing is Deleted" — entries are only ever appended.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { mawDataPath } from "../xdg";
import type { WorklogEntry } from "./types";

export function worklogPath(): string {
  return mawDataPath("worklog.jsonl");
}

/** Append one entry. Single-line writes (<4 KB) are atomic under O_APPEND. */
export function appendWorklog(entry: WorklogEntry): void {
  const p = worklogPath();
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

export interface ReadWorklogOpts {
  limit?: number; // keep only the most recent N
  since?: number; // epoch ms — drop entries older than this
  oracle?: string; // filter by oracle
}

export function readWorklog(opts: ReadWorklogOpts = {}): WorklogEntry[] {
  const p = worklogPath();
  if (!existsSync(p)) return [];
  let entries: WorklogEntry[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WorklogEntry);
    } catch {
      /* skip malformed line — never let one bad line break the log */
    }
  }
  if (opts.since != null) entries = entries.filter(e => e.ts >= opts.since!);
  if (opts.oracle) entries = entries.filter(e => e.oracle === opts.oracle);
  if (opts.limit != null && entries.length > opts.limit) entries = entries.slice(-opts.limit);
  return entries;
}
