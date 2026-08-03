/**
 * Pane identity helper (kobo-759) — `@oracle_pane = "{name}:{role}"`.
 *
 * The whole point of the option is that a consumer can trust it, so the guard
 * branches matter more than the happy path: an unknown oracle must produce NO
 * write (absent = "unknown", a fact), and a blank target must never be handed to
 * tmux (an empty tmux target silently means "the caller's own active pane").
 */
import { describe, expect, test } from "bun:test";
import {
  ORACLE_PANE_OPTION,
  duplicateIdentityWarning,
  paneIdentity,
  parsePaneIdentity,
  pickIdentifiedPane,
  scanIdentifiedPanes,
  stampPaneIdentity,
} from "../src/core/pane-identity";

function recorder() {
  const cmds: string[] = [];
  return { cmds, exec: async (cmd: string) => { cmds.push(cmd); return ""; } };
}

describe("paneIdentity", () => {
  test("formats {name}:{role} for every role", () => {
    expect(paneIdentity("patchwork", "head")).toBe("patchwork:head");
    expect(paneIdentity("patchwork", "worker")).toBe("patchwork:worker");
    expect(paneIdentity("patchwork", "reviewer")).toBe("patchwork:reviewer");
  });

  test("solo oracle is {name}:head", () => {
    expect(paneIdentity(" eq3 ", "head")).toBe("eq3:head");
  });

  test("refuses an unusable name instead of inventing one", () => {
    expect(paneIdentity("", "head")).toBeNull();
    expect(paneIdentity("   ", "head")).toBeNull();
    // a `:` in the name would make the value ambiguous to split
    expect(paneIdentity("a:b", "worker")).toBeNull();
  });
});

describe("stampPaneIdentity", () => {
  test("writes the option on the exact target", async () => {
    const { cmds, exec } = recorder();
    expect(await stampPaneIdentity("%42", "patchwork", "worker", exec)).toBe(true);
    expect(cmds).toEqual([`tmux set-option -p -t '%42' ${ORACLE_PANE_OPTION} 'patchwork:worker'`]);
  });

  test("overwrites unconditionally — an adopted pane keeps no stale name", async () => {
    const { cmds, exec } = recorder();
    await stampPaneIdentity("%7", "old", "head", exec);
    await stampPaneIdentity("%7", "new", "head", exec);
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).toContain("'new:head'");
  });

  test("unknown oracle → no tmux write at all (never guesses an identity)", async () => {
    const { cmds, exec } = recorder();
    expect(await stampPaneIdentity("%42", "", "head", exec)).toBe(false);
    expect(cmds).toEqual([]);
  });

  test("blank target → no tmux write (an empty tmux target is the ACTIVE pane, not 'none')", async () => {
    const { cmds, exec } = recorder();
    expect(await stampPaneIdentity("", "patchwork", "head", exec)).toBe(false);
    expect(await stampPaneIdentity("   ", "patchwork", "head", exec)).toBe(false);
    expect(cmds).toEqual([]);
  });

  test("tmux failure reports false rather than claiming the stamp landed", async () => {
    expect(await stampPaneIdentity("%42", "patchwork", "head", async () => { throw new Error("no server"); })).toBe(false);
  });

  test("quotes are escaped, so a hostile name cannot break out of the tmux command", async () => {
    const { cmds, exec } = recorder();
    await stampPaneIdentity("%42", "o'x; rm -rf /", "head", exec);
    expect(cmds[0]).toContain(`'o'\\''x; rm -rf /:head'`);
  });
});

/**
 * kobo-782 — reading identity back, so "does this oracle have a pane?" stops
 * being answered by a window NAME. A cell renames its head window to
 * `cell-head`, which made the name lookup miss and mint a duplicate head pane
 * on every dispatch.
 */
function paneLine(paneId: string, identity: string, windowName = "cell-head", session = "54-mawjs", windowIndex = 0) {
  return [paneId, session, windowIndex, windowName, identity].join("|||");
}

const runReturning = (out: string) => async () => out;

describe("parsePaneIdentity (kobo-782)", () => {
  test("reverses paneIdentity", () => {
    expect(parsePaneIdentity(paneIdentity("mawjs", "head"))).toEqual({ oracle: "mawjs", role: "head" });
  });

  test("a pane maw never birthed reads as unknown, not as a guess", () => {
    expect(parsePaneIdentity("")).toBeNull();
    expect(parsePaneIdentity("   ")).toBeNull();
    expect(parsePaneIdentity(undefined)).toBeNull();
    expect(parsePaneIdentity("mawjs")).toBeNull();      // no role half
    expect(parsePaneIdentity(":head")).toBeNull();      // no oracle half
    expect(parsePaneIdentity("a:b:c")).toBeNull();      // ambiguous to split
  });
});

describe("scanIdentifiedPanes (kobo-782)", () => {
  test("keeps only panes that carry an identity, with where they live", async () => {
    const out = [
      paneLine("%12", "mawjs:head"),
      paneLine("%13", "mawjs:worker"),
      paneLine("%40", "", "a-human-split"), // no option → not evidence
      "",
    ].join("\n");

    expect(await scanIdentifiedPanes(runReturning(out))).toEqual([
      { paneId: "%12", session: "54-mawjs", windowIndex: "0", windowName: "cell-head", oracle: "mawjs", role: "head" },
      { paneId: "%13", session: "54-mawjs", windowIndex: "0", windowName: "cell-head", oracle: "mawjs", role: "worker" },
    ]);
  });

  test("scans the whole server, not one session — the oracle may not be where the name says", async () => {
    const args: string[][] = [];
    await scanIdentifiedPanes(async (...a) => { args.push(a); return ""; });
    expect(args[0]).toContain("-a");
  });

  test("a tmux error is no evidence, not an empty fleet — callers fall back to their legacy path", async () => {
    expect(await scanIdentifiedPanes(async () => { throw new Error("no server"); })).toEqual([]);
  });
});

describe("pickIdentifiedPane (kobo-782)", () => {
  const panes = [
    { paneId: "%77", session: "s", windowIndex: "0", windowName: "w", oracle: "mawjs", role: "head" },
    { paneId: "%12", session: "s", windowIndex: "1", windowName: "cell-head", oracle: "mawjs", role: "head" },
    { paneId: "%13", session: "s", windowIndex: "1", windowName: "cell-head", oracle: "mawjs", role: "worker" },
    { paneId: "%9", session: "s", windowIndex: "2", windowName: "w", oracle: "thawanban", role: "head" },
  ];

  test("lowest pane id wins — the oldest pane, not tmux's listing order", () => {
    const { pane, duplicates } = pickIdentifiedPane(panes, "mawjs", "head");
    expect(pane?.paneId).toBe("%12");
    expect(duplicates.map((p) => p.paneId)).toEqual(["%77"]);
  });

  test("role omitted asks presence (any pane), not delivery (the head)", () => {
    expect(pickIdentifiedPane(panes, "mawjs").pane?.paneId).toBe("%12");
    expect(pickIdentifiedPane(panes, "mawjs").duplicates.map((p) => p.paneId)).toEqual(["%13", "%77"]);
  });

  test("another oracle's pane is not this oracle's presence", () => {
    expect(pickIdentifiedPane(panes, "nobody").pane).toBeUndefined();
    expect(pickIdentifiedPane(panes, "thawanban", "head").pane?.paneId).toBe("%9");
  });

  test("an unparseable pane id sorts last rather than winning by accident", () => {
    const odd = [
      { paneId: "weird", session: "s", windowIndex: "0", windowName: "w", oracle: "mawjs", role: "head" },
      { paneId: "%3", session: "s", windowIndex: "0", windowName: "w", oracle: "mawjs", role: "head" },
    ];
    expect(pickIdentifiedPane(odd, "mawjs", "head").pane?.paneId).toBe("%3");
  });
});

describe("duplicateIdentityWarning (kobo-782)", () => {
  const winner = { paneId: "%12", session: "54-mawjs", windowIndex: "1", windowName: "cell-head", oracle: "mawjs", role: "head" };
  const loser = { paneId: "%77", session: "54-mawjs", windowIndex: "3", windowName: "mawjs-oracle", oracle: "mawjs", role: "head" };

  test("names every claimant, the winner's reason, and the exact clear command for the losers", () => {
    const w = duplicateIdentityWarning("mawjs", "head", winner, [loser]);
    expect(w).toContain("2 panes claim @oracle_pane=mawjs:head");
    expect(w).toContain("%12 (54-mawjs:cell-head)");
    expect(w).toContain("%77 (54-mawjs:mawjs-oracle)");
    expect(w).toContain("using %12 (lowest pane id = oldest)");
    expect(w).toContain("tmux set-option -pu -t %77 @oracle_pane");
  });

  test("guidance only — it never proposes killing a live pane", () => {
    const w = duplicateIdentityWarning("mawjs", "head", winner, [loser]);
    expect(w).not.toContain("kill");
  });
});
