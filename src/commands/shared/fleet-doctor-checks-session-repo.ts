/**
 * fleet-doctor-checks-session-repo — kobo-799: is a live session's anchor the
 * RIGHT repo, not merely "where does this cell think it lives".
 *
 * kobo-780 anchors cell state (ψ/active/cell/head.md, a relative path) on
 * whatever cwd the session's shell starts in. That cwd is set once, by `-c` on
 * `tmux new-session` — and two callers create sessions without it
 * (take/impl.ts, promote-cmd.ts), so the shell falls back to the tmux
 * server's default-path, which inside a maw process is maw-js itself. A
 * mis-anchored session then writes cell state into the wrong repo's
 * worktree, and `cat head.md` there reports a perfectly self-consistent —
 * but wrong — answer (Board Truth rule 19).
 *
 * This check answers the question head.md cannot: it compares the LIVE tmux
 * window cwd (observed reality) against what the fleet registry (ground
 * truth for "which repo does this session/window belong to") declares. It is
 * intentionally caller-agnostic — it does not care whether take, promote, or
 * some future command produced the drift, only whether the anchor and the
 * fleet's record of it now disagree.
 *
 * Ground-truth choice: the fleet registry (`~/.maw/fleet/*.json`,
 * `windows[].repo`), because it is the only durable, session-independent
 * record of "what repo was this window provisioned for" — session_path
 * itself has no such record once poisoned. If the fleet entry itself is
 * wrong (e.g. hand-edited, or written by a caller that itself omitted -c),
 * this check inherits that error — it cannot distinguish "fleet is wrong"
 * from "live session is wrong". That is the ceiling of a cheap check: fixing
 * it requires a second independent source of truth, which does not exist
 * today.
 *
 * `windows[].repo` in the wild is inconsistent: some entries store
 * `org/repo` (2-segment), others `github.com/org/repo` (3-segment) —
 * verified against live fleet files at ~/.maw/fleet/*.json. Both sides of
 * the comparison are normalized to strip an optional leading `github.com/`
 * before comparing, so that drift alone never produces a false positive.
 *
 * Pure — takes already-fetched live tmux + fleet data, does no I/O itself,
 * so it is unit-testable without touching a real tmux socket (per this
 * repo's mocking convention — several suites break that rule and pay for it
 * against live panes).
 */

import type { DoctorFinding } from "./fleet-doctor-checks";
import { repoFromCwdResult } from "./fleet-ensure";

export interface LiveWindowLike {
  name: string;
  cwd?: string;
}

export interface LiveSessionLike {
  name: string;
  windows: LiveWindowLike[];
}

export interface FleetWindowLike {
  name: string;
  repo?: string;
}

export interface FleetSessionEntryLike {
  session: { name: string; windows: FleetWindowLike[] };
}

function normalizeRepoRef(repo: string): string {
  return repo.trim().replace(/^github\.com\//i, "").toLowerCase();
}

/**
 * Check — live session anchor vs. fleet-declared repo.
 *
 * Three distinguishable outcomes per (session, window):
 *   - fleet and live agree, or fleet declares nothing → no finding (green)
 *   - live cwd missing/unresolvable → "session-repo-unknown" (warn) —
 *     cannot verify, must not read as a silent pass
 *   - live cwd resolves to a different repo than fleet declares →
 *     "session-repo-drift" (error) — names both the anchor found and the
 *     repo the fleet expected
 *
 * Only fleet sessions that are currently live are checked — a fleet entry
 * for a session that no longer exists has nothing to compare against.
 */
export function checkSessionRepoDrift(
  liveSessions: LiveSessionLike[],
  fleetEntries: FleetSessionEntryLike[],
  ghqRoot: string,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const liveByName = new Map(liveSessions.map((s) => [s.name, s]));

  for (const entry of fleetEntries) {
    const liveSession = liveByName.get(entry.session.name);
    if (!liveSession) continue; // not live right now — nothing to check

    const liveWindowsByName = new Map(liveSession.windows.map((w) => [w.name, w]));

    for (const fw of entry.session.windows) {
      const declaredRepo = fw.repo;
      if (!declaredRepo) continue; // fleet declares nothing — nothing to drift from

      const lw = liveWindowsByName.get(fw.name);
      const cwd = lw?.cwd;
      if (!cwd) {
        findings.push({
          level: "warn",
          check: "session-repo-unknown",
          fixable: false,
          message: `session '${entry.session.name}' window '${fw.name}' — cannot verify anchor (no live cwd observed); fleet declares repo '${declaredRepo}'`,
          detail: { session: entry.session.name, window: fw.name, declaredRepo },
        });
        continue;
      }

      const liveResult = repoFromCwdResult(cwd, ghqRoot);
      if (!liveResult.repo) {
        findings.push({
          level: "warn",
          check: "session-repo-unknown",
          fixable: false,
          message: `session '${entry.session.name}' window '${fw.name}' — anchor cwd '${cwd}' is outside ghq, cannot verify against fleet repo '${declaredRepo}'`,
          detail: { session: entry.session.name, window: fw.name, cwd, declaredRepo },
        });
        continue;
      }

      if (normalizeRepoRef(liveResult.repo) !== normalizeRepoRef(declaredRepo)) {
        findings.push({
          level: "error",
          check: "session-repo-drift",
          fixable: false,
          message: `session '${entry.session.name}' window '${fw.name}' is anchored at repo '${liveResult.repo}' but fleet says it should be '${declaredRepo}' (kobo-799 — a session created without -c inherits the wrong cwd)`,
          detail: { session: entry.session.name, window: fw.name, cwd, anchorRepo: liveResult.repo, expectedRepo: declaredRepo },
        });
      }
    }
  }

  return findings;
}
