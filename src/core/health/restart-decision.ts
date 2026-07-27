/**
 * kobo-458 — pure decision logic, deliberately separated from any pm2/process
 * side effect: this only decides WHETHER to restart from a probe history, and
 * says WHY, so a caller can log the decision before ever touching pm2.
 *
 * Restart triggers on N *consecutive* `dead` results only — one blip must not
 * restart (the card's own evidence: one incident recovered on its own after
 * ~1 minute with no intervention). `slow` and `probe-error` both BREAK the
 * dead streak and never themselves count toward it:
 *   - `slow` is a real answer (kobo-453's territory — a hung/slow call must
 *     never be conflated with a refused one).
 *   - `probe-error` means the WATCHER couldn't even attempt the check — it
 *     must never be misread as either "the server confirmed dead" (would
 *     restart a server nobody actually asked) or "everything's fine" (would
 *     hide the watcher's own failure by absence, kobo-446's family).
 */

import type { ProbeResult } from "./probe";

export interface RestartDecision {
  restart: boolean;
  reason: string;
}

export interface RestartDecisionOpts {
  consecutiveDeadThreshold?: number;
}

const DEFAULT_CONSECUTIVE_DEAD_THRESHOLD = 3;

function trailingRunLength(history: ProbeResult[], status: ProbeResult["status"]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status !== status) break;
    n++;
  }
  return n;
}

export function shouldRestart(history: ProbeResult[], opts: RestartDecisionOpts = {}): RestartDecision {
  const threshold = opts.consecutiveDeadThreshold ?? DEFAULT_CONSECUTIVE_DEAD_THRESHOLD;

  const consecutiveDead = trailingRunLength(history, "dead");
  if (consecutiveDead >= threshold) {
    return { restart: true, reason: `${consecutiveDead} consecutive dead probes (threshold ${threshold})` };
  }

  // A trailing run of probe-error must be surfaced distinctly — it says
  // "the check is failing", not "the server is healthy" and not "the server
  // is dead." Checked AFTER the dead-streak (a genuine dead-streak is the
  // stronger, actionable signal) but BEFORE falling through to "healthy",
  // since the most recent evidence here is neither ok nor slow.
  const consecutiveProbeErrors = trailingRunLength(history, "probe-error");
  if (consecutiveProbeErrors > 0) {
    return {
      restart: false,
      reason: `WATCHER ERROR: ${consecutiveProbeErrors} consecutive probe-error result(s) — the check itself is failing, this does not confirm server health`,
    };
  }

  if (consecutiveDead > 0) {
    return { restart: false, reason: `${consecutiveDead} consecutive dead probe(s), below threshold ${threshold}` };
  }

  return { restart: false, reason: "healthy" };
}
