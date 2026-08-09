import { describe, test, expect } from "bun:test";
import { annotatePane, paneAwayJudge } from "../../src/commands/plugins/tmux/impl";

// Pure unit tests for the annotation logic used by `maw tmux ls` (#395).
// No mocks — just deterministic inputs → deterministic outputs.

describe("annotatePane — #395 pure annotation logic", () => {
  const fleet = new Set(["101-mawjs", "112-fusion", "114-mawjs-no2"]);

  test("fleet pane → 'fleet: <stem>' (strips NN- prefix)", () => {
    const p = { id: "%100", target: "101-mawjs:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("fleet: mawjs");
  });

  test("fleet pane with NN prefix stripped even for multi-word stems", () => {
    const p = { id: "%101", target: "114-mawjs-no2:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("fleet: mawjs-no2");
  });

  test("legacy maw-view literal → 'view: maw-view'", () => {
    const p = { id: "%200", target: "maw-view:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("view: maw-view");
  });

  test("per-oracle '*-view' session → 'view: <session>'", () => {
    const p = { id: "%201", target: "mawjs-view:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("view: mawjs-view");
  });

  test("team-agent pane (in team map) → 'team: agent @ team-name'", () => {
    const teamMap = new Map([["%300", "scout @ iter-triage"]]);
    const p = { id: "%300", target: "101-mawjs:0.1", command: "bun" };
    expect(annotatePane(p, fleet, teamMap)).toBe("team: scout @ iter-triage");
  });

  test("team annotation wins over fleet (team is a more-specific view)", () => {
    const teamMap = new Map([["%300", "scout @ iter"]]);
    const p = { id: "%300", target: "101-mawjs:0.1", command: "claude" };
    // Even though session is fleet, the specific pane is a team agent
    expect(annotatePane(p, fleet, teamMap)).toBe("team: scout @ iter");
  });

  test("claude pane in unknown session → 'orphan'", () => {
    const p = { id: "%400", target: "random-session:0.0", command: "claude" };
    expect(annotatePane(p, fleet, new Map())).toBe("orphan");
  });

  test("bash-running pane → '' (never marked orphan)", () => {
    const p = { id: "%500", target: "random-session:0.0", command: "bash" };
    expect(annotatePane(p, fleet, new Map())).toBe("");
  });

  test("missing command field → '' (not orphan)", () => {
    const p = { id: "%501", target: "random-session:0.0" };
    expect(annotatePane(p, fleet, new Map())).toBe("");
  });

  test("view-prefixed session is NOT a view (suffix-only semantic, safety)", () => {
    const p = { id: "%600", target: "view-foo:0.0", command: "claude" };
    // "view-foo" doesn't match /-view$/ — it's a legit session name.
    // Treated as potential orphan (claude + not fleet/view/team).
    expect(annotatePane(p, fleet, new Map())).toBe("orphan");
  });

  test("empty fleet + empty team + bash → '' (nothing to say)", () => {
    const p = { id: "%700", target: "any:0.0", command: "bash" };
    expect(annotatePane(p, new Set(), new Map())).toBe("");
  });

  test("empty fleet + empty team + claude → 'orphan' (can't verify not-fleet in vacuum)", () => {
    const p = { id: "%701", target: "any:0.0", command: "claude" };
    expect(annotatePane(p, new Set(), new Map())).toBe("orphan");
  });
});

// kobo-868 — pure twin of isPaneAway (presence-away.ts) that also names the
// deciding marker, feeding the AWAY column in `maw ls -v`. No mocks, no IO —
// same style as annotatePane above.
describe("paneAwayJudge — kobo-868 ls -v AWAY column", () => {
  test("no events at all → away:false, judge:none (AC4)", () => {
    expect(paneAwayJudge([], "%40")).toEqual({ away: false, judge: null });
  });

  test("newest marker is a paneless (ALL-PANES) away → away:true, judge has no paneId", () => {
    const events = [{ kind: "away" as const, ts: 100 }];
    const result = paneAwayJudge(events, "%40");
    expect(result.away).toBe(true);
    expect(result.judge).toEqual({ paneId: undefined, ts: 100, kind: "away" });
  });

  test("per-pane back clears an OWN away marker", () => {
    const events = [
      { kind: "away" as const, ts: 1, paneId: "%40" },
      { kind: "back" as const, ts: 2, paneId: "%40" },
    ];
    expect(paneAwayJudge(events, "%40")).toEqual({
      away: false,
      judge: { paneId: "%40", ts: 2, kind: "back" },
    });
  });

  test("per-pane back does NOT clear a paneless ALL-PANES away (the exact kobo-856 poison)", () => {
    const events = [
      { kind: "away" as const, ts: 1 }, // paneless — decides for every pane
      { kind: "back" as const, ts: 2, paneId: "%373" }, // only clears %373
    ];
    expect(paneAwayJudge(events, "%40").away).toBe(true); // %40 still stuck
    expect(paneAwayJudge(events, "%373").away).toBe(false); // %373's own back clears it
  });

  test("a marker with TMUX_PANE set (AC3 negative control) scopes normally, unaffected panes stay clear", () => {
    const events = [{ kind: "away" as const, ts: 1, paneId: "%40" }];
    expect(paneAwayJudge(events, "%40").away).toBe(true);
    expect(paneAwayJudge(events, "%41").away).toBe(false);
  });
});
