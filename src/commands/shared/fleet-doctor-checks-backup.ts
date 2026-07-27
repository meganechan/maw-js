/**
 * fleet-doctor-checks-backup — kobo-427 check 8: `~/.maw` backup staleness.
 *
 * A dead/never-run backup job looks identical to a healthy one until the day
 * you need it — "silent failure looks healthy" (the same shape checkStalePeers
 * and checkMissingRepos exist to catch for other subsystems). `maw fleet
 * doctor` is already something a human runs/checks, so surfacing staleness
 * here makes it ACTIVE rather than needing a new dashboard nobody opens.
 *
 * Uses existsSync/readFileSync (fs I/O) — separated from the in-memory checks
 * in fleet-doctor-checks.ts for the same reason checkMissingRepos is.
 */

import { existsSync, readFileSync } from "fs";
import type { DoctorFinding } from "./fleet-doctor-checks";

const GRACE_HOURS = 26; // daily job + 2h grace, per kobo-427's own reasoning

interface BackupStatus {
  lastAttemptTs?: number;
  lastSuccessTs?: number;
  lastError?: string;
}

function readBackupStatus(statusPath: string): BackupStatus | null {
  if (!existsSync(statusPath)) return null;
  try { return JSON.parse(readFileSync(statusPath, "utf8")); } catch { return null; }
}

/**
 * Check 8 — `~/.maw` backup staleness (kobo-427).
 * `statusPath` is `<backupDir>/status.json` (caller resolves the backup dir —
 * this function doesn't hardcode `~/.maw-backups` so tests can point it
 * anywhere). `nowMs` is injected so tests don't depend on the real clock.
 */
export function checkBackupStaleness(statusPath: string, nowMs: number): DoctorFinding[] {
  const status = readBackupStatus(statusPath);
  if (!status || (status.lastAttemptTs === undefined && status.lastSuccessTs === undefined)) {
    return [{
      level: "error",
      check: "backup-staleness",
      fixable: false,
      message: `no ~/.maw backup has ever run (${statusPath} missing or empty) — a disk failure today loses every task card and room with no snapshot to recover from`,
      detail: { statusPath },
    }];
  }
  if (status.lastSuccessTs === undefined) {
    return [{
      level: "error",
      check: "backup-staleness",
      fixable: false,
      message: `~/.maw backup has never succeeded (last attempt ${new Date(status.lastAttemptTs!).toISOString()}${status.lastError ? `, error: ${status.lastError}` : ""})`,
      detail: { statusPath, lastAttemptTs: status.lastAttemptTs, lastError: status.lastError },
    }];
  }
  const hoursSinceSuccess = (nowMs - status.lastSuccessTs) / (1000 * 60 * 60);
  if (hoursSinceSuccess > GRACE_HOURS) {
    return [{
      level: "error",
      check: "backup-staleness",
      fixable: false,
      message: `~/.maw backup last succeeded ${hoursSinceSuccess.toFixed(1)}h ago (> ${GRACE_HOURS}h grace) — the daily job may be dead, not just running late`,
      detail: { statusPath, lastSuccessTs: status.lastSuccessTs, hoursSinceSuccess },
    }];
  }
  // a MORE RECENT attempt than the last success, with an error, means the job is failing
  // again even though an old success is still within the grace window — surface it now
  // rather than waiting for the grace window to also expire.
  if (status.lastAttemptTs !== undefined && status.lastAttemptTs > status.lastSuccessTs && status.lastError) {
    return [{
      level: "warn",
      check: "backup-staleness",
      fixable: false,
      message: `~/.maw backup's most recent attempt failed (${status.lastError}) — last known-good snapshot is still within the ${GRACE_HOURS}h grace window, but the job needs attention`,
      detail: { statusPath, lastAttemptTs: status.lastAttemptTs, lastSuccessTs: status.lastSuccessTs, lastError: status.lastError },
    }];
  }
  return [];
}
