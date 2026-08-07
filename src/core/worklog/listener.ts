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
import { appendWorklogAsync } from "./store";

// Keyed on the SET, not a module-global boolean. The boolean was idempotent in the
// wrong dimension: it made the FIRST set win forever, so once anything registered
// into one Set, a later call carrying the host's real Set was silently skipped —
// turning a wiring fix into a no-op. Per-set keeps the original promise (no double
// registration across serve-hook reloads) without deciding which Set is the one.
const registered = new WeakSet<Set<(event: FeedEvent) => void>>();

export function registerWorklogListener(
  feedListeners: Set<(event: FeedEvent) => void>,
): void {
  if (registered.has(feedListeners)) return; // idempotent — survive serve-hook reloads
  registered.add(feedListeners);
  feedListeners.add((event) => {
    try {
      const entry = eventToWorklog(event);
      if (entry) appendWorklogAsync(entry); // non-blocking on the feed hot path
    } catch {
      /* never break the feed pipeline because of the worklog */
    }
  });
}

/** @internal — tests */
export function _resetWorklogListener(set?: Set<(event: FeedEvent) => void>): void {
  if (set) registered.delete(set);
}
