/**
 * cell spawn: the launch line, RUN — ISOLATED SUITE (kobo-765 B5/B7, kobo-822).
 *
 * B5: a pane launched with `--append-system-prompt "$(cat <contract>)"` where the
 * contract is missing or empty boots with an EMPTY system prompt — alive, and
 * behaving like a stranger. Nothing in the old flow could see it. The launch line
 * gates on `test -s` so there is no path to it.
 *
 * B7: no `exec`. `exec claude` REPLACED the pane's shell, so a boot failure (a
 * model the plan cannot use) killed the pane outright — nothing to fall back to.
 * Plain `claude` keeps the shell underneath and the `||` climbs to the fallback
 * model. Since kobo-822 that `||` IS the whole model ladder: the old
 * capture-pane boot poll, kill-window and respawn are gone.
 *
 * kobo-822 moved these guarantees from the HEAD launch line to the worker and
 * reviewer ones. The head has no launch line any more — cell never starts it.
 *
 * How they are tested: the line is RUN, by a real /bin/sh, with a fake `claude`
 * first on PATH. A `toContain` on the string cannot tell you whether the shell
 * chain even parses, which model actually starts, or what the system prompt
 * expands to — and the empty prompt was exactly a shell-expansion fact.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server — every
 * tmux call below is the mock (these are LIVE fleet panes in production). The fake
 * `claude` never runs an agent.
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
/** what a re-used pane still exports from its previous life as a cell */
const staleStateDir = join(dir, "previous-cell-state");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevPane = process.env.TMUX_PANE;
const prevStateDir = process.env.CREW_STATE_DIR;
const prevCwd = process.cwd();

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["worker", "reviewer"]) {
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

const stateDir = join(dir, "ψ", "active", "cell");
let commands: string[] = [];
/** `id|||@role|||window|||@oracle_pane|||path|||window_index` — the head starts
 *  alone and UNSTAMPED, which is the fleet's real steady state. */
let paneRows: string[] = [];

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("new-window")) {
      paneRows.push("%worker|||⚒ worker|||cell-workers|||patchwork:worker|||/tmp|||1");
      return "%worker\n";
    }
    if (cmd.includes("split-window")) {
      paneRows.push("%reviewer|||🔎 reviewer|||cell-workers|||patchwork:reviewer|||/tmp|||1");
      return "%reviewer\n";
    }
    if (cmd.includes("list-panes")) return paneRows.join("\n") + "\n";
    // kobo-780 — the anchor. `dir` stands in for the oracle's own repo, which is
    // what `tmux new-session -c <repoPath>` puts here and what no later `cd` moves.
    if (cmd.includes("session_path")) return `${dir}\n`;
    return "";
  },
  listSessions: async () => [],
  // `session:INDEX` — the shape `find-window.ts` actually returns (kobo-822 F1)
  findWindow: () => "sess:0",
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { BRAIN_MODEL, DEFAULT_WORKER_MODEL } = await import("../../src/core/agent-panes");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  process.chdir(prevCwd);
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  if (prevStateDir === undefined) delete process.env.CREW_STATE_DIR; else process.env.CREW_STATE_DIR = prevStateDir;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  paneRows = [["%head", "", "patchwork-oracle", "", "/tmp", "0"].join("|||")];
  // THE ENVIRONMENT UNDER TEST: this process does NOT sit in the oracle's repo —
  // `~/bin/maw` cd's to maw-js before exec, and spawn now runs from outside every
  // oracle besides. CREW_STATE_DIR is the STALE export left by a pane's previous
  // life as a cell, set on every test on purpose: nothing may read it.
  process.chdir(home);
  rmSync(join(dir, "ψ"), { recursive: true, force: true });
  process.env.CREW_STATE_DIR = staleStateDir;
  process.env.TMUX_PANE = "%invoker";
});

/** the launch line as tmux receives it for a created pane, un-shell-escaped */
async function launchLine(role: "worker" | "reviewer"): Promise<string> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  const verb = role === "worker" ? "new-window" : "split-window";
  const cmd = commands.find((c) => c.includes(verb)) ?? "";
  const m = /-F '#\{pane_id\}' '(.*)'$/s.exec(cmd);
  if (!m) throw new Error(`no ${role} launch line was passed to tmux: ${cmd}`);
  return m[1]!.replaceAll("'\\''", "'");
}

function runLaunch(launch: string, failModel = ""): string {
  return execFileSync("/bin/sh", ["-c", launch], {
    cwd: home,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAIL_MODEL: failModel, CREW_STATE_DIR: staleStateDir },
  });
}

const promptOf = (stdout: string) => /<<<PROMPT\n([\s\S]*)\nPROMPT>>>/.exec(stdout)?.[1] ?? "";

describe("the state dir is resolved ONCE, from the anchor, never from env or cwd (kobo-765 B5, kobo-780)", () => {
  test("stale CREW_STATE_DIR is ignored; the pane boots on the contract spawn actually wrote", async () => {
    const launch = await launchLine("worker");

    // The writer ignored the stale export and this process's cwd...
    expect(existsSync(join(staleStateDir, "worker-contract.md"))).toBe(false);
    expect(existsSync(join(stateDir, "worker-contract.md"))).toBe(true);

    // ...and the launch line reads THAT file. Proven by running the line: the
    // system prompt below is what the process is really handed, after the shell
    // expanded `$(cat ...)` — the B5 failure was an empty expansion here.
    const stdout = runLaunch(launch);
    expect(stdout).toContain(`BOOTED model=${BRAIN_MODEL}`);
    const prompt = promptOf(stdout);
    expect(prompt.trim().length).toBeGreaterThan(0);
    expect(prompt).toContain("worker contract");
    expect(prompt).toContain("company=testco");
    expect(prompt).toBe(readFileSync(join(stateDir, "worker-contract.md"), "utf8").trim());
  });

  test("the exported CREW_STATE_DIR (the seat/Stop hooks read it) is the resolved dir, not the inherited one", async () => {
    const launch = await launchLine("worker");
    expect(launch).toContain(`CREW_STATE_DIR='${stateDir}'`);
    expect(launch).not.toContain(staleStateDir);
  });

  test("NEGATIVE: contract empty → the pane is NOT started at all (no path to an empty system prompt)", async () => {
    const launch = await launchLine("worker");
    writeFileSync(join(stateDir, "worker-contract.md"), "");

    const stdout = runLaunch(launch);
    expect(stdout).not.toContain("BOOTED");
    expect(stdout).toContain("missing or empty");
  });

  test("NEGATIVE: contract missing → refused, not booted blank", async () => {
    const launch = await launchLine("worker");
    rmSync(join(stateDir, "worker-contract.md"));

    const stdout = runLaunch(launch);
    expect(stdout).not.toContain("BOOTED");
    expect(stdout).toContain("missing or empty");
  });

  test("the reviewer gets its OWN contract, not the worker's", async () => {
    const stdout = runLaunch(await launchLine("reviewer"));
    expect(promptOf(stdout)).toContain("reviewer contract");
  });
});

describe("the model ladder lives in the pane's own shell (kobo-765 B7, kobo-822)", () => {
  test("first model refuses → the fallback comes up in the same pane, on the same contract", async () => {
    const launch = await launchLine("worker");
    const stdout = runLaunch(launch, BRAIN_MODEL);

    expect(stdout).toContain("not available for your account");
    expect(stdout).toContain(`BOOTED model=${DEFAULT_WORKER_MODEL}`);
    expect(promptOf(stdout)).toContain("worker contract");
  });

  test("a boot failure does not take the pane's shell with it — no `exec` anywhere in the line", async () => {
    const launch = await launchLine("worker");
    expect(launch).not.toContain("exec ");
    // both models refuse: the chain still exits without killing anything, which
    // is what leaves a pane to inspect instead of a hole where one was
    expect(() => runLaunch(launch, `${BRAIN_MODEL}|${DEFAULT_WORKER_MODEL}`)).toThrow();
  });

  test("there is no maw-side boot poll left: no capture-pane, no kill-window, no respawn", async () => {
    await companyCellSpawn("testco", () => {}, true);
    expect(commands.some((c) => c.includes("capture-pane"))).toBe(false);
    expect(commands.some((c) => c.includes("kill-window"))).toBe(false);
    expect(commands.filter((c) => c.includes("new-window"))).toHaveLength(1);
  });
});
