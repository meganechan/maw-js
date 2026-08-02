/**
 * cell spawn repair injection guard — ISOLATED SUITE (cell-spawn-inject-blind).
 *
 * The bug: `maw company cell spawn <co>` typed the repair line into whatever the
 * target pane was running. A pane running a Claude REPL took it as PROMPT TEXT
 * (never executed it), yet spawn counted `repaired++` and the summary reported
 * success — the counter said the opposite of what happened, and every oracle in
 * the roster got the shell command delivered as chat.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server —
 * every tmux call below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellspawn-"));
const prevDataDir = process.env.MAW_DATA_DIR;
process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));

let commands: string[] = [];
/** what the mocked `#{pane_current_command}` probe answers */
let paneCommand = "zsh";
let probeThrows = false;

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("pane_current_command")) {
      if (probeThrows) throw new Error("no server running on socket");
      return `${paneCommand}\n`;
    }
    if (cmd.includes("tmux list-panes")) return "%head|||👤 head|||cell-head\n";
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:win",
  cmdWake: async () => {},
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  paneCommand = "zsh";
  probeThrows = false;
});

async function spawn(): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  return out;
}

const sentKeys = () => commands.filter((c) => c.includes("send-keys"));

describe("cell spawn repair injection is classified before it types (cell-spawn-inject-blind)", () => {
  test("NEGATIVE: pane running a Claude REPL — nothing is typed and it is NOT counted repaired", async () => {
    paneCommand = "claude";
    const out = await spawn();

    // Not one keystroke: not the command, not the Enter, not even the C-u that
    // would edit the REPL's prompt box.
    expect(sentKeys()).toEqual([]);
    expect(commands.some((c) => c.includes("cell self-spawn"))).toBe(false);

    // ...and the summary reflects the failure instead of claiming a repair.
    const summary = out.at(-1) ?? "";
    expect(summary).toContain("0 repaired");
    expect(summary).toContain("1 refused/failed");
    expect(out.some((l) => l.includes("REFUSED repair injection") && l.includes("'claude'"))).toBe(true);
  });

  test("NEGATIVE: agent pane reported as a node wrapper is refused the same way", async () => {
    paneCommand = "node";
    const out = await spawn();
    expect(sentKeys()).toEqual([]);
    expect(out.at(-1)).toContain("0 repaired");
  });

  test("fail closed: pane command unreadable (probe throws) → refuse, never blind-send", async () => {
    probeThrows = true;
    const out = await spawn();
    expect(sentKeys()).toEqual([]);
    expect(out.some((l) => l.includes("cannot read pane_current_command"))).toBe(true);
    expect(out.at(-1)).toContain("1 refused/failed");
  });

  test("fail closed: empty pane command is unclassified, not 'probably a shell'", async () => {
    paneCommand = "";
    const out = await spawn();
    expect(sentKeys()).toEqual([]);
    expect(out.at(-1)).toContain("0 repaired");
  });

  test("classification happens in the same call as the keystrokes, not from the earlier pane listing", async () => {
    paneCommand = "zsh";
    await spawn();
    const probeAt = commands.findIndex((c) => c.includes("pane_current_command"));
    const firstKeyAt = commands.findIndex((c) => c.includes("send-keys"));
    expect(probeAt).toBeGreaterThan(-1);
    expect(firstKeyAt).toBeGreaterThan(probeAt);
    // nothing between the verdict and the first keystroke that could re-stale it
    expect(firstKeyAt).toBe(probeAt + 1);
  });

  test("REGRESSION: pane sitting at a shell prompt still gets the repair and is counted", async () => {
    paneCommand = "zsh";
    const out = await spawn();
    expect(sentKeys().some((c) => c.includes("cell self-spawn testco"))).toBe(true);
    expect(sentKeys().at(-1)).toContain("Enter");
    expect(out.at(-1)).toContain("1 repaired");
    expect(out.at(-1)).toContain("0 refused/failed");
  });

  test("REGRESSION: login-shell and path forms still classify as a shell", async () => {
    for (const cmd of ["-zsh", "/bin/bash", "fish"]) {
      commands = [];
      paneCommand = cmd;
      const out = await spawn();
      expect(out.at(-1)).toContain("1 repaired");
    }
  });
});
