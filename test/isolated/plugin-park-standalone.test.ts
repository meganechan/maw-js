/**
 * park plugin standalone boundary (#2316 gate) + the pane-identity discipline
 * (tmux-selfcheck-footgun).
 *
 * park writes a state file KEYED by session+window. Reading those two values with
 * a bare tmux query resolves $TMUX → session → the session's CURRENT WINDOW →
 * that window's ACTIVE PANE, so a caller that was not the active pane parked its
 * work under a neighbour's window name — and unpark restored it there.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realChild from "node:child_process";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const implSrc = () => readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/park/src/impl.ts"), "utf8");

let spawnSyncCalls: Array<{ cmd: string; args: string[] }> = [];

function mockSpawnSync(cmd: string, args: string[] = []) {
  spawnSyncCalls.push({ cmd, args });
  if (cmd === "tmux") {
    const sub = args[0];
    if (sub === "display-message" && args.includes("#S")) return { status: 0, stdout: "standalone-sess\n", stderr: "" };
    if (sub === "display-message" && args.includes("#W")) return { status: 0, stdout: "standalone-win\n", stderr: "" };
    if (sub === "display-message" && args.includes("#{pane_current_path}")) return { status: 0, stdout: "/tmp/maw-park-standalone-cwd\n", stderr: "" };
    if (sub === "list-windows") return { status: 0, stdout: "0:standalone-win\n", stderr: "" };
  }
  // git (and anything else) — tolerate as "not a repo" like git.ts expects.
  return { status: 1, stdout: "", stderr: "" };
}

mock.module("node:child_process", () => ({ ...realChild, spawnSync: mockSpawnSync }));

const stateDir = mkdtempSync(join(tmpdir(), "maw-park-standalone-state-"));
process.env.MAW_STATE_DIR = stateDir;
process.env.MAW_CONFIG_DIR = join(stateDir, "config");

const { cmdPark } = await import("../../src/vendor/mpr-plugins/park/src/impl.ts?plugin-park-standalone");

const originalTmuxPane = process.env.TMUX_PANE;

beforeEach(() => {
  spawnSyncCalls = [];
});

afterEach(() => {
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
});

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

describe("park plugin: state-file key comes from the caller's own pane at runtime", () => {
  test("cmdPark's session/window self-check calls carry -t '<pane>'", async () => {
    process.env.TMUX_PANE = "%706";
    await cmdPark();

    const selfChecks = spawnSyncCalls.filter(
      (call) => call.cmd === "tmux" && call.args[0] === "display-message" && (call.args.includes("#S") || call.args.includes("#W")),
    );
    expect(selfChecks).toHaveLength(2);
    for (const call of selfChecks) {
      expect(call.args).toContain("-t");
      expect(call.args).toContain("%706");
    }
  });
});
