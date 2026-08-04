import { describe, test, expect } from "bun:test";
import { checkSessionRepoDrift } from "../src/commands/shared/fleet-doctor-checks-session-repo";

/**
 * kobo-799 — fleet-repo mismatch detector.
 *
 * checkSessionRepoDrift is pure (no tmux, no fs), so these tests build the
 * live-session and fleet-entry shapes directly instead of spawning a real
 * tmux session — per this repo's convention (fleet-doctor.test.ts) and the
 * card's own AC #3: the probe must catch drift "โดยไม่ต้องรู้ล่วงหน้าว่า
 * caller ไหนเป็นคนทำ" — it only ever looks at cwd vs. declared repo, never at
 * which command produced the session.
 */

const ghqRoot = "/opt/Code";

describe("checkSessionRepoDrift — anchor vs. fleet ground truth", () => {
  test("AC1: anchor pointing at the wrong repo → error, names both the anchor found and the repo expected", () => {
    // Shape of the real bug: `tmux new-session -d -s` with no -c falls back
    // to wherever the maw process's cwd was — maw-js itself — while the
    // fleet says this session's window belongs to a different oracle's repo.
    const liveSessions = [
      { name: "pulse", windows: [{ name: "pulse", cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js" }] },
    ];
    const fleetEntries = [
      { session: { name: "pulse", windows: [{ name: "pulse", repo: "acme/pulse-oracle" }] } },
    ];

    const out = checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot);

    expect(out).toHaveLength(1);
    expect(out[0].check).toBe("session-repo-drift");
    expect(out[0].level).toBe("error");
    expect(out[0].detail).toMatchObject({
      session: "pulse",
      window: "pulse",
      anchorRepo: "github.com/Soul-Brews-Studio/maw-js",
      expectedRepo: "acme/pulse-oracle",
    });
    // message names both what was found and what was expected
    expect(out[0].message).toContain("github.com/Soul-Brews-Studio/maw-js");
    expect(out[0].message).toContain("acme/pulse-oracle");
  });

  test("AC2: anchor pointing at the cell's own repo → green (no finding)", () => {
    const liveSessions = [
      { name: "pulse", windows: [{ name: "pulse", cwd: "/opt/Code/github.com/acme/pulse-oracle" }] },
    ];
    const fleetEntries = [
      { session: { name: "pulse", windows: [{ name: "pulse", repo: "acme/pulse-oracle" }] } },
    ];

    expect(checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot)).toEqual([]);
  });

  test("normalizes the github.com/ prefix inconsistency seen in live fleet files — no false positive", () => {
    // Real ~/.maw/fleet/*.json entries mix `org/repo` and `github.com/org/repo`
    // for the same shape of data. repoFromCwdResult always returns the
    // 3-segment form for a cwd rooted at the bare ghqRoot, so a fleet entry
    // stored in the 2-segment form must not read as drift.
    const liveSessions = [
      { name: "thawanban", windows: [{ name: "thawanban", cwd: "/opt/Code/github.com/meganechan/thawanban-oracle" }] },
    ];
    const fleetEntries = [
      { session: { name: "thawanban", windows: [{ name: "thawanban", repo: "meganechan/thawanban-oracle" }] } },
    ];

    expect(checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot)).toEqual([]);
  });

  test("missing live cwd → session-repo-unknown (warn), distinguishable from both drift and a clean pass", () => {
    const liveSessions = [
      { name: "pulse", windows: [{ name: "pulse" }] }, // no cwd observed
    ];
    const fleetEntries = [
      { session: { name: "pulse", windows: [{ name: "pulse", repo: "acme/pulse-oracle" }] } },
    ];

    const out = checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot);
    expect(out).toHaveLength(1);
    expect(out[0].check).toBe("session-repo-unknown");
    expect(out[0].level).toBe("warn");
    expect(out[0].check).not.toBe("session-repo-drift");
  });

  test("live cwd outside ghq root → session-repo-unknown, not a silent pass", () => {
    const liveSessions = [
      { name: "pulse", windows: [{ name: "pulse", cwd: "/home/someone/scratch" }] },
    ];
    const fleetEntries = [
      { session: { name: "pulse", windows: [{ name: "pulse", repo: "acme/pulse-oracle" }] } },
    ];

    const out = checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot);
    expect(out).toHaveLength(1);
    expect(out[0].check).toBe("session-repo-unknown");
  });

  test("fleet entry for a session that isn't live right now → nothing to compare, no finding", () => {
    const liveSessions: Array<{ name: string; windows: Array<{ name: string; cwd?: string }> }> = [];
    const fleetEntries = [
      { session: { name: "ghost", windows: [{ name: "ghost", repo: "acme/ghost-oracle" }] } },
    ];

    expect(checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot)).toEqual([]);
  });

  test("fleet window with no declared repo → nothing to drift from, skipped", () => {
    const liveSessions = [
      { name: "pulse", windows: [{ name: "pulse", cwd: "/opt/Code/github.com/anything/anything" }] },
    ];
    const fleetEntries = [
      { session: { name: "pulse", windows: [{ name: "pulse" }] } },
    ];

    expect(checkSessionRepoDrift(liveSessions, fleetEntries, ghqRoot)).toEqual([]);
  });

  test("AC3: caller-agnostic — a split session created without -c (take's shape) is caught the same way a promote-created one would be", () => {
    // Neither take/impl.ts nor promote-cmd.ts appears anywhere here — the
    // check only ever sees the resulting (session, window, cwd) triple.
    const takeShaped = [
      { name: "neo-skills", windows: [{ name: "neo-skills", cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js" }] },
    ];
    const promoteShaped = [
      { name: "promoted-oracle", windows: [{ name: "main", cwd: "/opt/Code/github.com/Soul-Brews-Studio/maw-js" }] },
    ];
    const fleetFor = (session: string, window: string, repo: string) => [
      { session: { name: session, windows: [{ name: window, repo }] } },
    ];

    const takeOut = checkSessionRepoDrift(takeShaped, fleetFor("neo-skills", "neo-skills", "acme/neo-oracle"), ghqRoot);
    const promoteOut = checkSessionRepoDrift(promoteShaped, fleetFor("promoted-oracle", "main", "acme/promoted-oracle"), ghqRoot);

    expect(takeOut).toHaveLength(1);
    expect(takeOut[0].check).toBe("session-repo-drift");
    expect(promoteOut).toHaveLength(1);
    expect(promoteOut[0].check).toBe("session-repo-drift");
  });
});
