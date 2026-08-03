/**
 * Cell pane identity — ISOLATED SUITE (kobo-759).
 *
 * `maw company cell self-spawn` is three pane births in one call: the head pane is
 * ADOPTED (this very pane, previously something else), the worker is a fresh
 * `new-window`, the reviewer a fresh `split-window`. Each must come out carrying
 * `@oracle_pane = "{name}:{role}"` — the option, not the pane title, because the
 * title is decoration anything can overwrite.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server — every
 * tmux call below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellidentity-"));
const home = join(dir, "home");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevPane = process.env.TMUX_PANE;
const prevStateDir = process.env.CREW_STATE_DIR;
const prevCwd = process.cwd();

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));
// contract assets self-spawn refuses to run without
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["head", "worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`), `# ${role} {{COMPANY}}\n`);
}

let commands: string[] = [];

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    // pane ids for the two fresh panes; boot poll sees a ready prompt immediately
    if (cmd.includes("new-window")) return "%worker\n";
    if (cmd.includes("split-window")) return "%reviewer\n";
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    if (cmd.includes("display-message")) return "sess\n"; // teardown's session probe
    if (cmd.includes("list-panes")) return "";
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:win",
  cmdWake: async () => {},
  checkBusyGuard: async () => ({ busy: false }),
}));

const { cellSelfSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  process.chdir(prevCwd);
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  if (prevStateDir === undefined) delete process.env.CREW_STATE_DIR; else process.env.CREW_STATE_DIR = prevStateDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  // kobo-765: the state dir is `ψ/active/cell` RELATIVE to the pane's cwd and no
  // longer reads CREW_STATE_DIR — so the sandbox is the cwd, not that env var
  // (still set here as the stale value self-spawn must ignore).
  process.chdir(dir);
  process.env.TMUX_PANE = "%head";
  process.env.CLAUDE_AGENT_NAME = "patchwork";
  process.env.CREW_STATE_DIR = join(dir, "state");
  process.env.CELL_SPAWN_POLL_MS = "1";
});

async function selfSpawn(): Promise<string[]> {
  const out: string[] = [];
  await cellSelfSpawn("testco", (line) => out.push(line));
  return out;
}

const identityCmds = () => commands.filter((c) => c.includes("@oracle_pane"));

describe("cell self-spawn stamps @oracle_pane at every pane birth (kobo-759)", () => {
  test("head (ADOPTED pane), worker (new-window), reviewer (split-window) each get {name}:{role}", async () => {
    const result = await cellSelfSpawn("testco", () => {});
    expect(result.ok).toBe(true);

    expect(identityCmds()).toEqual([
      `tmux set-option -p -t '%head' @oracle_pane 'patchwork:head'`,
      `tmux set-option -p -t '%worker' @oracle_pane 'patchwork:worker'`,
      `tmux set-option -p -t '%reviewer' @oracle_pane 'patchwork:reviewer'`,
    ]);
  });

  test("the adopted head is stamped even though the pane already existed — no stale occupant name", async () => {
    await selfSpawn();
    // stamped by pane id, and BEFORE the pane is handed the head contract/title
    const stampAt = commands.findIndex((c) => c.includes("@oracle_pane") && c.includes("%head"));
    const titleAt = commands.findIndex((c) => c.includes("select-pane") && c.includes("head"));
    expect(stampAt).toBeGreaterThan(-1);
    expect(stampAt).toBeLessThan(titleAt);
  });

  test("identity is a pane OPTION, never inferred from the pane title", async () => {
    await selfSpawn();
    // titles are still set (human-readable bonus) but carry no identity value
    expect(commands.some((c) => c.includes("select-pane") && c.includes("-T"))).toBe(true);
    for (const cmd of identityCmds()) expect(cmd).toContain("set-option -p -t");
  });

  test("unresolvable oracle name → NO option is written and the gap is announced (never guessed)", async () => {
    delete process.env.CLAUDE_AGENT_NAME;
    process.env.TMUX = ""; // selfOracleId cannot fall back to a tmux session name
    const out = await selfSpawn();
    expect(identityCmds()).toEqual([]);
    expect(out.filter((l) => l.includes("pane identity not set"))).toHaveLength(3);
  });
});
