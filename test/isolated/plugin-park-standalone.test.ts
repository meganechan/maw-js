/**
 * park plugin standalone boundary (#2316 gate) + the pane-identity discipline
 * (tmux-selfcheck-footgun).
 *
 * park writes a state file KEYED by session+window. Reading those two values with
 * a bare tmux query resolves $TMUX → session → the session's CURRENT WINDOW →
 * that window's ACTIVE PANE, so a caller that was not the active pane parked its
 * work under a neighbour's window name — and unpark restored it there.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const implSrc = () => readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/park/src/impl.ts"), "utf8");

describe("park plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "park",
      // PRE-EXISTING, pinned rather than endorsed: park reaches into core/xdg for
      // the state-file location instead of taking it from the SDK. Recorded here
      // so the next person to touch this plugin sees it is a known exception, not
      // a pattern to copy.
      allowRelative: [/^(?:\.\.\/){4}core\/xdg$/],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("the state-file key comes from the caller's own pane, or park refuses", () => {
    const src = implSrc();
    expect(src).toContain('const self = process.env.TMUX_PANE;');
    expect(src).toContain('tmuxRun("display-message", "-p", "-t", self, "#S")');
    expect(src).toContain('tmuxRun("display-message", "-p", "-t", self, "#W")');
    // A bare read here is what parked work under the wrong window name.
    expect(src).not.toMatch(/tmuxRun\("display-message", "-p", "#[SW]"\)/);
    expect(src).toContain("refusing to park under another window's name");
  });
});
