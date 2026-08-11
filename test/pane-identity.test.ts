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
  conflictingIdentityError,
  duplicateIdentityWarning,
  paneIdentity,
  parsePaneIdentity,
  pickIdentifiedPane,
  readTargetPanes,
  routeOracleByIdentity,
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

/**
 * kobo-830 — resolving an oracle to its pane by the STAMP.
 *
 * The live failure this fixture reproduces (measured 2026-08-05): three oracles
 * sat in windows a torn-down cell had renamed to `cell-head`, so every
 * name-based resolver missed them and `maw hey utils-pm` answered "offline"
 * while the agent was running. The stamp was on the pane the whole time.
 */
describe("routeOracleByIdentity (kobo-830)", () => {
  const heyRun = (lines: string[]) => async () => lines.join("\n");

  test("a live oracle in a window renamed `cell-head` is still found by its own name", async () => {
    const routed = await routeOracleByIdentity("utils-pm", "head", heyRun([
      paneLine("%39", "utils-pm:head", "cell-head", "14-utils-pm", 0),
      paneLine("%41", "", "cell-workers", "14-utils-pm", 1),
    ]));
    expect(routed.via).toBe("identity");
    expect(routed.via === "identity" && routed.pane.paneId).toBe("%39");
  });

  test("the window name is decoration — rename it to anything and delivery still resolves", async () => {
    for (const windowName of ["cell-head", "utils-pm-oracle", "banana", ""]) {
      const routed = await routeOracleByIdentity("utils-pm", "head", heyRun([
        paneLine("%39", "utils-pm:head", windowName, "14-utils-pm", 0),
      ]));
      expect(routed.via === "identity" && routed.pane.paneId).toBe("%39");
    }
  });

  test("the same oracle under every name form it is addressed by", async () => {
    const run = heyRun([paneLine("%39", "utils-pm:head", "cell-head", "14-utils-pm", 0)]);
    for (const query of ["utils-pm", "utils-pm-oracle", "14-utils-pm", "UTILS-PM", " utils-pm "]) {
      expect((await routeOracleByIdentity(query, "head", run)).via).toBe("identity");
    }
  });

  /**
   * The load-bearing guard. Two panes claim `worker1:head` today (a wake that
   * could not find the renamed window built a second head beside the first).
   * Both are live agents; picking either delivers someone's work to the wrong
   * pane with a success message on top of it.
   */
  test("two panes claiming one identity → REFUSE, and name both — never pick", async () => {
    const routed = await routeOracleByIdentity("worker1", "head", heyRun([
      paneLine("%88", "worker1:head", "cell-head", "23-worker1", 0),
      paneLine("%91", "worker1:head", "worker1-oracle", "23-worker1", 2),
    ]));
    expect(routed.via).toBe("conflict");
    expect(routed.via === "conflict" && routed.candidates.map((p) => p.paneId)).toEqual(["%88", "%91"]);
    expect(routed).not.toHaveProperty("pane");
  });

  test("nobody claims the name → `none`, so the caller keeps its legacy name resolution", async () => {
    expect((await routeOracleByIdentity("utils-pm", "head", heyRun([
      paneLine("%12", "mawjs:head", "mawjs-oracle", "54-mawjs", 0),
      paneLine("%40", "", "a-human-split", "54-mawjs", 1),
    ]))).via).toBe("none");
  });

  test("a worker pane does not answer for its oracle's head", async () => {
    expect((await routeOracleByIdentity("mawjs", "head", heyRun([
      paneLine("%13", "mawjs:worker", "cell-workers", "54-mawjs", 1),
    ]))).via).toBe("none");
  });

  test("a blank query never matches a blank-ish stamp", async () => {
    expect((await routeOracleByIdentity("  ", "head", heyRun([paneLine("%1", "x:head")]))).via).toBe("none");
  });

  test("a tmux error is no evidence — fall back, never throw", async () => {
    expect((await routeOracleByIdentity("utils-pm", "head", async () => { throw new Error("no server"); })).via).toBe("none");
  });
});

describe("conflictingIdentityError (kobo-830)", () => {
  const candidates = [
    { paneId: "%88", session: "23-worker1", windowIndex: "0", windowName: "cell-head", oracle: "worker1", role: "head" },
    { paneId: "%91", session: "23-worker1", windowIndex: "2", windowName: "worker1-oracle", oracle: "worker1", role: "head" },
  ];

  test("names both claimants, refuses to guess, and hands over the exact clear command", () => {
    const msg = conflictingIdentityError("worker1", "head", candidates);
    expect(msg).toContain("2 panes claim @oracle_pane=worker1:head");
    expect(msg).toContain("%88 (23-worker1:cell-head)");
    expect(msg).toContain("%91 (23-worker1:worker1-oracle)");
    expect(msg).toContain("Refusing to guess");
    expect(msg).toContain("tmux set-option -pu -t %91 @oracle_pane");
  });

  test("asks the oracle rather than proposing to kill a live pane", () => {
    const msg = conflictingIdentityError("worker1", "head", candidates);
    expect(msg).toContain("Ask worker1");
    expect(msg).not.toContain("kill");
  });
});

/**
 * kobo-777 — reading ONE target's panes, unstamped ones included. That is the
 * opposite filter from scanIdentifiedPanes, and deliberately so: an in-place
 * stamp exists precisely for the panes that carry no identity yet.
 */
describe("readTargetPanes (kobo-777)", () => {
  test("keeps unstamped panes — they are the ones a stamp is for", async () => {
    const out = ["%12|||", "%13|||mawjs:worker"].join("\n");
    expect(await readTargetPanes(async () => out, "54-mawjs:mawjs-oracle")).toEqual([
      { paneId: "%12", identity: "" },
      { paneId: "%13", identity: "mawjs:worker" },
    ]);
  });

  test("scopes with -t, so it never reports the whole server", async () => {
    const args: string[][] = [];
    await readTargetPanes(async (...a) => { args.push(a); return ""; }, "54-mawjs:mawjs-oracle");
    expect(args[0]).toEqual([
      "list-panes", "-t", "54-mawjs:mawjs-oracle", "-F", `#{pane_id}${"|||"}#{${ORACLE_PANE_OPTION}}`,
    ]);
    expect(args[0]).not.toContain("-a");
  });

  test("a blank target is never sent to tmux — an empty -t is the caller's own active pane", async () => {
    let called = false;
    expect(await readTargetPanes(async () => { called = true; return "%9|||"; }, "  ")).toEqual([]);
    expect(called).toBe(false);
  });

  test("a tmux error reads as no pane, not as a pane with no identity", async () => {
    expect(await readTargetPanes(async () => { throw new Error("no server"); }, "s:w")).toEqual([]);
  });
});
