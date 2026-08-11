/**
 * kobo-835 — the measuring instrument's own checks.
 *
 * The docker sandbox (docker/e2e/tests/v3-hey-targeting.sh) proves the whole
 * chain against real tmux; these cover the decisions inside it that a sandbox
 * run would only exercise in one direction.
 */
import { describe, expect, test } from "bun:test";
import {
  heyRouteMismatch,
  parseSince,
  summarizeHeyAudit,
  targetShape,
  typedTarget,
} from "../src/commands/shared/hey-audit";
import {
  classifyDirectResolution,
  deferredPaneReason,
  describeTargetLocation,
} from "../src/commands/shared/comm-send";

describe("heyRouteMismatch", () => {
  test("the m5:helm misroute is a mismatch even though the window name contains 'helm'", () => {
    // The whole reason this is an exact match against the destination's names and
    // not a substring test. `13-patchwork:helm-notes` CONTAINS "helm"; a substring
    // check agrees with the bug and reports the misroute as a correct delivery.
    expect(heyRouteMismatch({
      query: "m5:helm",
      resolvedTarget: "13-patchwork:0.1",
      resolvedWhere: "13-patchwork:helm-notes",
      resolvedBy: "node-prefix-self",
    })).toBe(true);
  });

  test("a send that reached the oracle it named is not a mismatch", () => {
    expect(heyRouteMismatch({
      query: "eq3",
      resolvedTarget: "05-eq3:0",
      resolvedWhere: "05-eq3:eq3-oracle",
      resolvedBy: "name-resolver",
    })).toBe(false);
  });

  test("the NN- prefix and the -oracle suffix are decoration, not a different name", () => {
    expect(heyRouteMismatch({
      query: "patchwork-oracle",
      resolvedTarget: "13-patchwork:1",
      resolvedWhere: "13-patchwork:patchwork-oracle",
      resolvedBy: "name-resolver",
    })).toBe(false);
  });

  test("a pane the operator named themselves is not judged", () => {
    for (const row of [
      { query: "13-patchwork:0.1", resolvedTarget: "13-patchwork:0.1", resolvedBy: "exact-pane-address" },
      { query: "13-patchwork:2", resolvedTarget: "13-patchwork:2", resolvedBy: "name-resolver" },
    ]) expect(heyRouteMismatch(row)).toBeUndefined();
  });

  test("a bare pane id names nobody, so it is unjudgeable rather than wrong", () => {
    // Without this, every kobo-830 identity route (%N, no session/window in the
    // target) would report as a mismatch and the count would be noise.
    expect(heyRouteMismatch({
      query: "utils-pm",
      resolvedTarget: "%37",
      resolvedBy: "pane-identity",
    })).toBeUndefined();
    // ...and WITH the pane's own session/window carried alongside, it is judgeable
    // in both directions. kobo-830's whole point is that a pane whose WINDOW was
    // renamed (`cell-head`) is still the right pane — its session still names the
    // oracle, so this is a match, not a mismatch.
    expect(heyRouteMismatch({
      query: "utils-pm",
      resolvedTarget: "%37",
      resolvedWhere: "14-utils-pm:cell-head",
      resolvedBy: "pane-identity",
    })).toBe(false);
    expect(heyRouteMismatch({
      query: "utils-pm",
      resolvedTarget: "%37",
      resolvedWhere: "13-patchwork:cell-head",
      resolvedBy: "pane-identity",
    })).toBe(true);
  });

  test("a peer send is judged against the node:target it was addressed to", () => {
    expect(heyRouteMismatch({
      query: "mba:homekeeper",
      resolvedTarget: "homekeeper",
      resolvedWhere: "mba:homekeeper",
      resolvedBy: "node-prefix-peer",
      route: "peer",
    })).toBe(false);
  });
});

describe("typedTarget / targetShape", () => {
  test("flags and their values are not the target", () => {
    expect(typedTarget(["hey", "eq3", "hello"])).toBe("eq3");
    expect(typedTarget(["hey", "--from", "m5:patchwork", "eq3", "hello"])).toBe("eq3");
    expect(typedTarget(["hey", "--verbose", "m5:helm", "hi"])).toBe("m5:helm");
    expect(typedTarget(["hey"])).toBeNull();
  });

  test("the three ways of naming a target are told apart", () => {
    expect(targetShape("eq3")).toBe("short-name");
    expect(targetShape("m5:helm")).toBe("node-prefixed");
    expect(targetShape("13-patchwork:0.1")).toBe("pane-address");
    expect(targetShape("13-patchwork:0")).toBe("pane-address");
    expect(targetShape("%37")).toBe("pane-address");
  });
});

describe("parseSince", () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");
  test("relative windows", () => {
    expect(parseSince("24h", now)).toBe(Date.parse("2026-08-04T12:00:00.000Z"));
    expect(parseSince("7d", now)).toBe(Date.parse("2026-07-29T12:00:00.000Z"));
    expect(parseSince("90m", now)).toBe(Date.parse("2026-08-05T10:30:00.000Z"));
  });
  test("an absolute timestamp, and a refusal for anything else", () => {
    expect(parseSince("2026-08-01T00:00:00Z", now)).toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(parseSince("last tuesday", now)).toBeNull();
  });
});

describe("summarizeHeyAudit", () => {
  const since = Date.parse("2026-08-05T00:00:00.000Z");

  test("counts both row kinds and keeps them separate", () => {
    const s = summarizeHeyAudit([
      { ts: "2026-08-04T23:00:00Z", cmd: "hey", args: ["hey", "eq3", "old"] }, // outside the window
      { ts: "2026-08-05T01:00:00Z", cmd: "hey", args: ["hey", "eq3", "hi"] },
      { ts: "2026-08-05T01:00:01Z", cmd: "hey", args: ["hey", "m5:helm", "hi"] },
      { ts: "2026-08-05T01:00:02Z", cmd: "hey", args: ["hey", "13-patchwork:0.1", "hi"] },
      {
        ts: "2026-08-05T01:00:03Z", kind: "hey-route", query: "m5:helm",
        resolvedTarget: "13-patchwork:0.1", resolvedWhere: "13-patchwork:helm-notes",
        resolvedBy: "node-prefix-self",
      },
    ], since);

    expect(s.typed).toBe(3);
    expect(s.byShape).toEqual({ "short-name": 1, "node-prefixed": 1, "pane-address": 1 });
    expect(s.routed).toBe(1);
    expect(s.mismatched).toBe(1);
    expect(s.mismatches[0]!.query).toBe("m5:helm");
  });

  test("hey with no route row is uncounted, not counted as correct", () => {
    // The failure this instrument must not have: 200 sends, no instrumentation,
    // and a report that reads "0 mismatches".
    const s = summarizeHeyAudit(
      [{ ts: "2026-08-05T01:00:00Z", cmd: "hey", args: ["hey", "eq3", "hi"] }],
      since,
    );
    expect(s.typed).toBe(1);
    expect(s.routed).toBe(0);
    expect(s.matched).toBe(0);
    expect(s.mismatched).toBe(0);
  });
});

describe("classifyDirectResolution", () => {
  test("the layer is read off the query shape and the answer shape", () => {
    expect(classifyDirectResolution("m5:helm", { type: "self-node", target: "13-patchwork:0" }))
      .toBe("node-prefix-self");
    expect(classifyDirectResolution("mba:homekeeper", { type: "peer", target: "homekeeper" }))
      .toBe("node-prefix-peer");
    expect(classifyDirectResolution("world-mawjs", { type: "peer", target: "mawjs" }))
      .toBe("peer-route");
    expect(classifyDirectResolution("13-patchwork:0.1", { type: "local", target: "13-patchwork:0.1" }))
      .toBe("exact-pane-address");
  });

  test("a pane-shaped query the alias layer rewrote is not the exact-pane layer", () => {
    // resolveSessionWindowAliasTarget canonicalizes the session name, so a
    // different target means a name resolver answered — claiming otherwise would
    // attribute the send to a layer that never ran.
    expect(classifyDirectResolution("patchwork:0.1", { type: "local", target: "13-patchwork:0.1" }))
      .toBe("name-resolver");
  });
});

describe("describeTargetLocation", () => {
  const sessions = [{ name: "13-patchwork", windows: [
    { index: 0, name: "helm-notes", active: false },
    { index: 1, name: "patchwork-oracle", active: true },
  ] }] as any;

  test("names the window a session:index(.pane) target landed in", () => {
    expect(describeTargetLocation("13-patchwork:0.1", sessions)).toBe("13-patchwork:helm-notes");
    expect(describeTargetLocation("13-patchwork:1", sessions)).toBe("13-patchwork:patchwork-oracle");
  });

  test("says nothing rather than guessing when there is nothing to read", () => {
    expect(describeTargetLocation("%37", sessions)).toBeUndefined();
    expect(describeTargetLocation("13-patchwork:9", sessions)).toBeUndefined();
    expect(describeTargetLocation("99-gone:0", sessions)).toBeUndefined();
  });
});

describe("deferredPaneReason", () => {
  test("never blames a permission — the only 'permission' left is the denial", () => {
    for (const reason of ["menu", "typing"] as const) {
      const msg = deferredPaneReason("13-patchwork:0.1", "patchwork", reason);
      // The two strings this card was opened to delete.
      expect(msg).not.toContain("a permission/confirm menu is open");
      expect(msg).not.toContain("has a permission menu open");
      // Any surviving occurrence must be the sentence saying there is no such check.
      const occurrences = msg.toLowerCase().split("permission").length - 1;
      expect(occurrences).toBe(1);
      expect(msg).toContain("no permission check is involved");
    }
  });

  test("says what was on screen", () => {
    expect(deferredPaneReason("13-patchwork:0.1", "patchwork", "menu"))
      .toContain("showing a menu that is waiting for an answer");
    expect(deferredPaneReason("13-patchwork:0.1", "patchwork", "typing"))
      .toContain("unsent line sitting in its input box");
  });

  test("tells the two symptoms apart, with the opposite action for each", () => {
    for (const reason of ["menu", "typing"] as const) {
      const msg = deferredPaneReason("13-patchwork:0.1", "patchwork", reason);
      expect(msg).toContain("re-sending will not help");           // stuck screen
      expect(msg).toContain("session:window.pane");                // wrong pane
      expect(msg).toContain("that screen is not 'patchwork'");
    }
  });

  test("an unknown oracle name does not produce 'undefined' in the receipt", () => {
    expect(deferredPaneReason("%37", undefined, "menu")).toContain("the intended oracle");
  });
});
