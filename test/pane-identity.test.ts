/**
 * Pane identity helper (kobo-759) — `@oracle_pane = "{name}:{role}"`.
 *
 * The whole point of the option is that a consumer can trust it, so the guard
 * branches matter more than the happy path: an unknown oracle must produce NO
 * write (absent = "unknown", a fact), and a blank target must never be handed to
 * tmux (an empty tmux target silently means "the caller's own active pane").
 */
import { describe, expect, test } from "bun:test";
import { ORACLE_PANE_OPTION, paneIdentity, stampPaneIdentity } from "../src/core/pane-identity";

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
