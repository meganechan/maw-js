/**
 * Worklog — the P1 "desync-killer" activity log.
 *
 * A single durable, append-only stream of *significant* fleet activity:
 *   - tool calls that change state (git/gh, Edit/Write)
 *   - PR lifecycle (opened / merged / closed) discovered by the headless poller
 *
 * The card-less log that lets a lead/pm trust the log instead of memory:
 * every state-changing action surfaces here regardless of who did it.
 *
 * See ψ proposal thread `eq3-lead-dispatch-lock` (re-scoped to log layer).
 */

export type WorklogKind =
  | "tool" // significant tool call (git/gh Bash, Edit/Write)
  | "pr-opened"
  | "pr-merged"
  | "pr-closed"
  | "interrupt"; // reserved — heuristic, deferred (no clean CC hook). See thread.

export interface WorklogEntry {
  ts: number; // epoch ms (sort key)
  iso: string; // ISO-8601 timestamp
  oracle: string; // who/what produced the event
  kind: WorklogKind;
  summary: string; // human one-liner, e.g. "git push origin feat/x" or "merged #123"
  repo?: string; // org/repo (PR events)
  pr?: number; // PR number (PR events)
  by?: string; // actor for pr-merged/closed (who merged — may differ from author)
}
