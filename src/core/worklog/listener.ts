/**
 * Passive feed listener — persists significant tool-call events to the worklog.
 *
 * Wired once in src/core/server.ts next to the existing feed listeners. This is
 * NOT a background loop / interval — it only reacts to feed events that already
 * arrive (CC PostToolUse hooks → POST /api/feed → feedListeners). PR lifecycle
 * is handled separately by the on-demand poller, so this listener ignores it.
 */

import type { FeedEvent } from "../../lib/feed";
import { eventToWorklog } from "./significant";
import { appendWorklog } from "./store";

export function registerWorklogListener(
  feedListeners: Set<(event: FeedEvent) => void>,
): void {
  feedListeners.add((event) => {
    try {
      const entry = eventToWorklog(event);
      if (entry) appendWorklog(entry);
    } catch {
      /* never break the feed pipeline because of the worklog */
    }
  });
}
