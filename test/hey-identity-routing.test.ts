/**
 * kobo-830 — `maw hey <bare-name>` resolves the pane by its `@oracle_pane`
 * stamp before it falls back to window/session NAMES.
 *
 * The measured failure: `maw hey utils-pm` printed
 *   `offline: 'utils-pm' found at …/utils-pm-oracle but no active session`
 * while the agent was alive in `14-utils-pm:cell-head`. Nothing about that pane
 * had changed except its window NAME, which is all the resolvers downstream of
 * here read (routing.ts `findNamedFleetWindow`, find-window.ts `oracleWindowOf`).
 *
 * Both assertions below are about EVIDENCE, not just the target: the resolution
 * must also SAY which evidence it used, because the fallback is permanent (most
 * of the fleet is unstamped) and a fallback nobody can see is a fallback nobody
 * fixes.
 */
import { describe, expect, test } from "bun:test";
import { resolveBareLocalTarget } from "../src/commands/shared/comm-send";

const config = { node: "local" } as any;
const noStamps = async () => "";
const stampedPanes = (...lines: string[]) => async () => lines.join("\n");

/** `#{pane_id}|||#{session_name}|||#{window_index}|||#{window_name}|||#{@oracle_pane}` */
function pane(paneId: string, session: string, windowIndex: number, windowName: string, identity: string) {
  return [paneId, session, windowIndex, windowName, identity].join("|||");
}

describe("bare hey resolution reads the stamp first (kobo-830)", () => {
  test("the renamed window that made a live oracle 'offline' now resolves to its pane", async () => {
    const resolved = await resolveBareLocalTarget("utils-pm", config, [], undefined, {
      tmuxRun: stampedPanes(
        pane("%39", "14-utils-pm", 0, "cell-head", "utils-pm:head"),
        pane("%41", "14-utils-pm", 1, "cell-workers", ""),
      ),
    });
    expect(resolved.result).toEqual({ type: "local", target: "%39" });
    expect(resolved.routing).toBe("identity");
  });

  /**
   * The commitment this card was opened on: rename the window of an awake
   * oracle to ANYTHING and hey still reaches it. `sessions` is empty here on
   * purpose — every name-based resolver has nothing to work with, so a pass
   * can only come from the stamp.
   */
  test("no session list at all — the stamp alone is enough to deliver", async () => {
    for (const windowName of ["cell-head", "banana", "3", ""]) {
      const resolved = await resolveBareLocalTarget("utils-worker", config, [], undefined, {
        tmuxRun: stampedPanes(pane("%55", "15-utils-worker", 0, windowName, "utils-worker:head")),
      });
      expect(resolved.result).toEqual({ type: "local", target: "%55" });
    }
  });

  test("an unstamped fleet keeps the legacy name path — and says so", async () => {
    const sessions = [{ name: "zzz-nowhere", windows: [{ index: 0, name: "zzznotanoracle-oracle", active: true }] }];
    const resolved = await resolveBareLocalTarget("zzznotanoracle", config, sessions as any, undefined, {
      tmuxRun: noStamps,
    });
    expect(resolved.result).toEqual({ type: "local", target: "zzz-nowhere:0" });
    expect(resolved.routing).toBe("name");
  });

  test("another oracle's stamp never answers for this one", async () => {
    const sessions = [{ name: "zzz-nowhere", windows: [{ index: 0, name: "zzznotanoracle-oracle", active: true }] }];
    const resolved = await resolveBareLocalTarget("zzznotanoracle", config, sessions as any, undefined, {
      tmuxRun: stampedPanes(pane("%39", "14-utils-pm", 0, "cell-head", "utils-pm:head")),
    });
    expect(resolved.result).toEqual({ type: "local", target: "zzz-nowhere:0" });
    expect(resolved.routing).toBe("name");
  });

  test("an explicit session:window target is left alone — the operator named the pane", async () => {
    let asked = false;
    const resolved = await resolveBareLocalTarget("14-utils-pm:cell-head", config, [], undefined, {
      tmuxRun: async () => { asked = true; return ""; },
    });
    // kobo-835 added `by` (the resolution layer, for the audit row); a declined
    // query has no layer to name, so it is null alongside the rest.
    expect(resolved).toEqual({ result: null, locate: null, routing: null, by: null });
    expect(asked).toBe(false);
  });
});
