/**
 * src/core/agent-panes.ts — ISOLATED SUITE.
 *
 * Inherited from the retired crew plugin's suite (kobo-358): these are the
 * kill-path guards, which relocated with the helper. The crewSpawn cases went
 * away with the plugin; the teardown predicate + fail-closed sweep did NOT —
 * this is a destructive tmux path, so it keeps its coverage.
 *
 * Why isolated: teardown shells through @maw-js/sdk/hostExec for tmux and
 * Bun's mock.module is process-global (mirrors tile.test.ts's hostExec-mock
 * pattern — no test in this repo spins up a real tmux session).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

let commands: string[] = [];
let paneListForSession = "";
let throwOnListPanes = false;

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux display-message") && cmd.includes("#{session_name}")) return "sess\n";
    if (throwOnListPanes && cmd.includes("tmux list-panes")) throw new Error("no server running on socket");
    if (cmd.includes("tmux list-panes")) return paneListForSession;
    return "";
  },
}));

const { isCrewOwnedPane, teardownCrewWindows } = await import("../../src/core/agent-panes");

beforeEach(() => {
  commands = [];
  paneListForSession = "";
  throwOnListPanes = false;
});

describe("crew teardown predicate (kobo-358)", () => {
  test("crew role tags (conductor/worker/worker-N/reviewer) are kill-eligible", () => {
    expect(isCrewOwnedPane("🎼 conductor", "some-window")).toBe(true);
    expect(isCrewOwnedPane("⚒ worker", "some-window")).toBe(true);
    expect(isCrewOwnedPane("⚒ worker-2", "some-window")).toBe(true);
    expect(isCrewOwnedPane("🔎 reviewer", "some-window")).toBe(true);
  });

  test("crew-workers window is kill-eligible even without a role tag", () => {
    expect(isCrewOwnedPane("", "crew-workers")).toBe(true);
  });

  test("front/coord tag is NEVER kill-eligible — front is the invoker, not crew-spawned", () => {
    expect(isCrewOwnedPane("🧭 coord", "some-window")).toBe(false);
  });

  test("unknown/untagged/non-crew panes default to protected (fail-closed)", () => {
    expect(isCrewOwnedPane("", "bash")).toBe(false);
    expect(isCrewOwnedPane("some-other-tool", "main")).toBe(false);
  });
});

describe("teardownCrewWindows (kobo-358)", () => {
  test("no leftover panes → ok, nothing killed", async () => {
    paneListForSession = "%front|||🧭 coord|||main\n";
    const r = await teardownCrewWindows({ protectPaneId: "%front" });
    expect(r.ok).toBe(true);
    expect(r.killed).toEqual([]);
  });

  test("kills leftover crew-tagged panes but protects the invoker + non-crew panes", async () => {
    paneListForSession = [
      "%front|||🧭 coord|||main",
      "%oldcond|||🎼 conductor|||main",
      "%oldworker|||⚒ worker|||crew-workers",
      "%bash|||||main",
    ].join("\n");
    const r = await teardownCrewWindows({ protectPaneId: "%front" });
    expect(r.ok).toBe(true);
    expect(r.killed.sort()).toEqual(["%oldcond", "%oldworker"].sort());
    expect(commands.some((c) => c.includes("kill-pane -t '%front'"))).toBe(false);
    expect(commands.some((c) => c.includes("kill-pane -t '%bash'"))).toBe(false);
  });

  test("fail-closed: list-panes throwing → refuses (does not proceed to kill anything)", async () => {
    throwOnListPanes = true;
    const r = await teardownCrewWindows({ protectPaneId: "%front" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(commands.some((c) => c.includes("kill-pane"))).toBe(false);
  });

  test("fail-closed: empty protectPaneId refuses BEFORE any tmux call (kobo-362 — an empty target resolves to the caller's own session)", async () => {
    const r = await teardownCrewWindows({ protectPaneId: "  " });
    expect(r.ok).toBe(false);
    expect(commands).toEqual([]);
  });
});
