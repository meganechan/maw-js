/**
 * cell spawn: one state dir + head boot gate — ISOLATED SUITE (kobo-765, B5/B7).
 *
 * B5: the state dir was derived TWICE — the writer (`cellSelfSpawn`) took
 * `process.env.CREW_STATE_DIR || ψ/active/cell`, the head launch line took the
 * default. A pane that had been a cell before still exported the PREVIOUS cell's
 * CREW_STATE_DIR, so the contracts were written over there while head `cat`'d the
 * default path — `$(cat missing)` is empty, and head booted with an EMPTY system
 * prompt. Nothing in the old flow could see it: the pane looked alive.
 *
 * B7: `repaired++` sat right after the send-keys, so a head that never booted (bad
 * model) was counted — and reported — as a repair.
 *
 * How the head launch line is tested: it is RUN, by a real /bin/sh, with a fake
 * `claude` first on PATH. A `toContain` on the string cannot tell you whether the
 * shell chain even parses, which model actually starts, or what the system prompt
 * expands to — and the empty prompt was exactly a shell-expansion fact.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server — every
 * tmux call below is the mock (these are LIVE fleet panes in production). The fake
 * `claude` never runs an agent; `maw` is never executed (the injected line's
 * self-spawn prefix is sliced off before the shell sees it).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellstate-"));
const home = join(dir, "home");
const bin = join(dir, "bin");
const staleStateDir = join(dir, "previous-cell-state"); // what a re-used pane still exports
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
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["head", "worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`),
    `# ${role} contract\ncompany={{COMPANY}} dept={{DEPT}} board={{BOARD}}\n`);
}
mkdirSync(staleStateDir, { recursive: true });

// Fake `claude`: reports the model it was asked for and echoes the system prompt
// it actually received, and fails the model named in $FAIL_MODEL (that is how a
// model a plan cannot use behaves — a message and a non-zero exit).
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "claude"), `#!/bin/sh
model=""; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift 2 ;;
    --append-system-prompt) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "|\${FAIL_MODEL:-}|" in
  *"|$model|"*) echo "not available for your account"; exit 1 ;;
esac
printf 'BOOTED model=%s\\n<<<PROMPT\\n%s\\nPROMPT>>>\\n' "$model" "$prompt"
`);
chmodSync(join(bin, "claude"), 0o755);

let commands: string[] = [];
/** what the mocked `tmux capture-pane` shows for the head pane, poll by poll */
let captures: string[] = ["bypass permissions\n"];
let captureIdx = 0;

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("pane_current_command")) return "zsh\n";
    if (cmd.includes("capture-pane")) {
      const out = captures[Math.min(captureIdx, captures.length - 1)] ?? "";
      captureIdx++;
      return out;
    }
    if (cmd.includes("new-window")) return "%worker\n";
    if (cmd.includes("split-window")) return "%reviewer\n";
    if (cmd.includes("list-panes")) return "%head|||👤 head|||cell-head|||patchwork:head|||/tmp\n";
    if (cmd.includes("display-message")) return "sess\n";
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:win",
  cmdWake: async () => {},
  checkBusyGuard: async () => ({ busy: false }),
}));

const { cellSelfSpawn, companyCellSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { BRAIN_MODEL, DEFAULT_WORKER_MODEL } = await import("../../src/core/agent-panes");
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
  captures = ["bypass permissions\n"];
  captureIdx = 0;
  // The pane is the sandbox: the state dir is `ψ/active/cell` relative to the
  // pane's cwd. CREW_STATE_DIR is the STALE export left by the pane's previous
  // life as a cell — set on every test on purpose.
  process.chdir(dir);
  rmSync(join(dir, "ψ"), { recursive: true, force: true });
  process.env.CREW_STATE_DIR = staleStateDir;
  process.env.TMUX_PANE = "%head";
  process.env.CLAUDE_AGENT_NAME = "patchwork";
  process.env.CELL_SPAWN_POLL_MS = "1";
});

/** the repair line as `cell spawn` types it into the pane, un-shell-escaped */
async function injectedRepairLine(): Promise<string> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  const sent = commands.find((c) => c.includes("send-keys") && c.includes("head-contract")) ?? "";
  const m = /^tmux send-keys -t '[^']*' '(.*)'$/s.exec(sent);
  if (!m) throw new Error(`no repair line was typed: ${sent}`);
  return m[1]!.replaceAll("'\\''", "'");
}

/** just the head launch part — never let the `maw ... self-spawn` prefix execute */
function headLaunchOf(repairLine: string): string {
  const at = repairLine.indexOf("if test -s");
  expect(at).toBeGreaterThan(-1);
  return repairLine.slice(at);
}

function runHeadLaunch(launch: string, failModel = ""): string {
  return execFileSync("/bin/sh", ["-c", launch], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAIL_MODEL: failModel, CREW_STATE_DIR: staleStateDir },
  });
}

const promptOf = (stdout: string) => /<<<PROMPT\n([\s\S]*)\nPROMPT>>>/.exec(stdout)?.[1] ?? "";

describe("cell spawn resolves the state dir ONCE and never from the pane's env (kobo-765 B5)", () => {
  test("stale CREW_STATE_DIR in the pane env → head boots on the contract self-spawn actually wrote (non-empty system prompt)", async () => {
    const spawned = await cellSelfSpawn("testco", () => {});
    expect(spawned.ok).toBe(true);

    // The writer ignored the stale export...
    expect(existsSync(join(staleStateDir, "head-contract.md"))).toBe(false);
    expect(existsSync(join(dir, "ψ/active/cell/head-contract.md"))).toBe(true);

    // ...and the launch line reads THAT file. Proven by running the line: the
    // system prompt below is what the head process is really handed, after the
    // shell expanded `$(cat ...)` — the B5 failure was an empty expansion here.
    const stdout = runHeadLaunch(headLaunchOf(await injectedRepairLine()));
    expect(stdout).toContain(`BOOTED model=${BRAIN_MODEL}`);
    const prompt = promptOf(stdout);
    expect(prompt.trim().length).toBeGreaterThan(0);
    expect(prompt).toContain("head contract");
    expect(prompt).toContain("company=testco");
    expect(prompt).toBe(readFileSync(join(dir, "ψ/active/cell/head-contract.md"), "utf8").trim());
  });

  test("NEGATIVE: contract empty → head is NOT started at all (no path to an empty system prompt)", async () => {
    await cellSelfSpawn("testco", () => {});
    const launch = headLaunchOf(await injectedRepairLine());
    writeFileSync(join(dir, "ψ/active/cell/head-contract.md"), "");

    const stdout = runHeadLaunch(launch);
    expect(stdout).not.toContain("BOOTED");
    expect(stdout).toContain("missing or empty");
  });

  test("NEGATIVE: contract missing (state written elsewhere) → refused, not booted blank", async () => {
    await cellSelfSpawn("testco", () => {});
    const launch = headLaunchOf(await injectedRepairLine());
    rmSync(join(dir, "ψ/active/cell/head-contract.md"));

    const stdout = runHeadLaunch(launch);
    expect(stdout).not.toContain("BOOTED");
    expect(stdout).toContain("missing or empty");
  });

  test("the exported CREW_STATE_DIR (hooks read it) is the resolved dir, not the inherited one", async () => {
    await cellSelfSpawn("testco", () => {});
    const launch = headLaunchOf(await injectedRepairLine());
    expect(launch).toContain("CREW_STATE_DIR='ψ/active/cell'");
    expect(launch).not.toContain(staleStateDir);
    // same for the panes self-spawn opens
    const paneCmds = commands.filter((c) => c.includes("new-window") || c.includes("split-window"));
    expect(paneCmds).toHaveLength(2);
    for (const cmd of paneCmds) {
      expect(cmd).toContain("CREW_STATE_DIR="); // (nested-quoted inside the tmux command)
      expect(cmd).toContain("ψ/active/cell");
      expect(cmd).not.toContain(staleStateDir);
    }
  });
});

describe("head boot is its own outcome, with a working fallback (kobo-765 B7)", () => {
  test("head never boots → summary reports head-boot-failed, NOT repaired", async () => {
    captures = [""]; // pane shows nothing, ever
    const out: string[] = [];
    await companyCellSpawn("testco", (line) => out.push(line), true);

    const summary = out.at(-1) ?? "";
    expect(summary).toContain("0 repaired");
    expect(summary).toContain("1 head-boot-failed");
    expect(out.some((l) => l.includes("head boot FAILED") && l.includes(DEFAULT_WORKER_MODEL))).toBe(true);
  });

  test("first model refuses, fallback comes up → counted repaired (the fail text on screen is not the verdict)", async () => {
    captures = ["not available for your account\n", "not available for your account\n", "not available for your account\nbypass permissions\n"];
    const out: string[] = [];
    await companyCellSpawn("testco", (line) => out.push(line), true);

    const summary = out.at(-1) ?? "";
    expect(summary).toContain("1 repaired");
    expect(summary).toContain("0 head-boot-failed");
  });

  test("the fallback is IN the launch line: BRAIN_MODEL refused → DEFAULT_WORKER_MODEL boots, same contract", async () => {
    await cellSelfSpawn("testco", () => {});
    const stdout = runHeadLaunch(headLaunchOf(await injectedRepairLine()), BRAIN_MODEL);

    expect(stdout).toContain("not available for your account");
    expect(stdout).toContain(`BOOTED model=${DEFAULT_WORKER_MODEL}`);
    expect(promptOf(stdout)).toContain("company=testco");
  });

  test("head boot failure does not take the pane's shell with it (no `exec`) — the pane survives for the next repair", async () => {
    await cellSelfSpawn("testco", () => {});
    const launch = headLaunchOf(await injectedRepairLine());
    expect(launch).not.toContain("exec claude");
    // both models refuse → the shell is still there to run the next command
    const stdout = execFileSync("/bin/sh", ["-c", `${launch}; echo STILL_ALIVE`], {
      cwd: dir, encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAIL_MODEL: `${BRAIN_MODEL}|${DEFAULT_WORKER_MODEL}`, CREW_STATE_DIR: staleStateDir },
    });
    expect(stdout).toContain("STILL_ALIVE");
  });
});

describe("self-spawn parks the head window's name before overwriting it (kobo-775)", () => {
  test("the old name is stored on the pane, and stored BEFORE the rename that destroys it", async () => {
    await cellSelfSpawn("testco", () => {});

    const parkAt = commands.findIndex((c) => c.includes("@cell_prev_window") && c.includes("set-option -p "));
    const renameAt = commands.findIndex((c) => c.includes("rename-window") && c.includes("cell-head"));
    expect(parkAt).toBeGreaterThan(-1);
    expect(renameAt).toBeGreaterThan(parkAt);
    // the value is whatever the window was called ("sess", per this mock) — read
    // from tmux, not invented
    expect(commands[parkAt]).toContain("@cell_prev_window 'sess'");
  });
});

describe("REGRESSION: a normal self-spawn is unchanged (kobo-765 AC3)", () => {
  test("3 panes, every role still set: head adopted, worker new-window, reviewer split", async () => {
    const result = await cellSelfSpawn("testco", () => {});
    expect(result).toMatchObject({ ok: true, head: "%head", worker: "%worker", reviewer: "%reviewer" });

    const roles = commands.filter((c) => c.includes("set-option -p") && c.includes("@role ")).map((c) => c.slice(c.indexOf("@role")));
    expect(roles).toEqual(["@role '👤 head'", "@role '⚒ worker'", "@role '🔎 reviewer'"]);
    for (const role of ["head", "worker", "reviewer"]) {
      expect(readFileSync(join(dir, "ψ/active/cell", `${role}-contract.md`), "utf8")).toContain("company=testco");
    }
  });
});
