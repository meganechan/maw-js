/**
 * Timeline render — the worklog as a story, not raw JSON.
 *
 *   10:05  ·  worker  → git push origin feat/x
 *   10:08  →  worker  → opened #123 fix foo
 *   10:15  ✓  worker  → merged #123 (by tony) → ping pm
 */

import type { WorklogEntry } from "./types";

const ICON: Record<WorklogEntry["kind"], string> = {
  tool: "·",
  "pr-opened": "→",
  "pr-merged": "✓",
  "pr-closed": "✗",
  interrupt: "⚠",
};

function hhmm(e: WorklogEntry): string {
  const d = e.iso ? new Date(e.iso) : new Date(e.ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Render entries (already chronological) into a narrative timeline. */
export function renderTimeline(entries: WorklogEntry[]): string {
  if (!entries.length) return "worklog ว่าง — ยังไม่มี activity บันทึก";
  const lines: string[] = [];
  for (const e of entries) {
    const icon = ICON[e.kind] ?? "·";
    let text = `${hhmm(e)}  ${icon}  ${e.oracle}  → ${e.summary}`;
    if (e.kind === "pr-merged" && e.by) text += ` (by ${e.by})`;
    lines.push(text);
  }
  return lines.join("\n");
}
