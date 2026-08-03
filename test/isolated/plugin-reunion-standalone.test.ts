/**
 * reunion plugin standalone boundary (#2316 gate) + the pane-identity discipline
 * (tmux-selfcheck-footgun).
 *
 * With no explicit target, reunion takes the cwd of "the current pane". Bare, that
 * resolves $TMUX → session → the session's CURRENT WINDOW → that window's ACTIVE
 * PANE, so a reunion launched from any non-active pane copied files relative to a
 * neighbour's directory.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const implSrc = () => readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/reunion/impl.ts"), "utf8");

describe("reunion plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({ plugin: "reunion" }).map((record) => record.spec);
    expect(imports).toContain("maw-js/sdk");
  });

  test("the no-target path reads the CALLER's cwd, not whichever pane is active", () => {
    const src = implSrc();
    expect(src).toContain('const self = process.env.TMUX_PANE ?? "";');
    expect(src).toContain("display-message -p -t '${self}' '#{pane_current_path}'");
    expect(src).not.toContain("display-message -p '#{pane_current_path}'");
    // No pane id → the existing "cannot determine cwd" path, never a guess.
    expect(src).toContain('throw new Error("TMUX_PANE unset")');
  });
});
