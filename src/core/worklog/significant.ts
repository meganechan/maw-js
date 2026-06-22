/**
 * Significance filter (filter "b" — significant only).
 *
 * Maps a raw CC feed event → a worklog entry, keeping ONLY state-changing
 * tool calls and dropping read-only chatter (Read/Grep/Glob/...). PR lifecycle
 * events are NOT handled here — they are written directly by ./pr-watch.ts, so
 * this filter returns null for them to avoid double-writing.
 */

import type { FeedEvent } from "../../lib/feed";
import type { WorklogEntry } from "./types";

/** Tools that never change state — never logged even if a hook forwards them. */
const READONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "WebFetch", "WebSearch",
]);

const MAX_SUMMARY = 120;

function clip(s: string): string {
  s = s.trim().replace(/\s+/g, " ");
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + "…" : s;
}

/** Build a one-line summary for a significant tool, or null if not significant. */
export function toolSummary(toolName: string, input: any): string | null {
  if (toolName === "Bash") {
    const cmd = String(input?.command ?? "").trim();
    if (!cmd) return null;
    // only git / gh shell counts as significant fleet activity
    if (!/\b(git|gh)\b/.test(cmd)) return null;
    return clip(cmd);
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    const fp = String(input?.file_path ?? input?.filePath ?? "").trim();
    return clip(`${toolName} ${fp}`);
  }
  return null;
}

/** Convert a tool-call feed event into a worklog entry, or null to skip. */
export function eventToWorklog(event: FeedEvent): WorklogEntry | null {
  if (event.event !== "PostToolUse" && event.event !== "PreToolUse") return null;
  const data: any = event.data;
  const toolName = String(data?.tool_name ?? data?.toolName ?? "");
  if (!toolName || READONLY_TOOLS.has(toolName)) return null;
  const summary = toolSummary(toolName, data?.tool_input ?? data?.toolInput);
  if (!summary) return null;
  return {
    ts: event.ts || Date.now(),
    iso: event.timestamp || new Date().toISOString(),
    oracle: event.oracle || "unknown",
    kind: "tool",
    summary,
  };
}
