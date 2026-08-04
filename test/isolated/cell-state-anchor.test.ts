/**
 * cell state is anchored to the ORACLE's repo, not this process's cwd —
 * ISOLATED SUITE (kobo-780, updated kobo-822).
 *
 * The bug is environmental and invisible from inside the code: `~/bin/maw`
 * does `cd /Users/tony/maw-js` before exec, so `process.cwd()` is maw-js in
 * EVERY maw invocation no matter where it was typed. Everything the cell
 * derived from cwd therefore named the same directory for every oracle in the
 * fleet — two oracles' contracts overwrote each other, and worker/reviewer
 * panes opened in the wrong tree.
 *
 * The anchor is `#{session_path}` — set once by `tmux new-session -c
 * <repoPath>` (wake-cmd) and unmovable by any later process, read from
 * OUTSIDE the pane (`cellAnchor`, unchanged by kobo-822 — it already worked
 * this way). What kobo-822 changed is WHO calls it: `companyCellSpawn` now
 * does the writing directly (no more `cellSelfSpawn` running inside the
 * target pane), and `companyCellDown` still does the cleaning — same
 * resolver, same two callers, still agreeing.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec and Bun's
 * mock.module is process-global. No test here touches a real tmux server —
 * the anchor is whatever the mock says `#{session_path}` is, which is how two
 * oracles get two repos.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellanchor-"));
const home = join(dir, "home");
/** two oracles, two repos — the whole point */
const repoA = join(dir, "repos", "patchwork-oracle");
const repoB = join(dir, "repos", "stitch-oracle");
/** where the buggy behaviour landed everything: one shared dir, and this process's cwd */
const wrapperRepo = join(dir, "maw-js");

const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevPoll = process.env.CELL_SPAWN_POLL_MS;
const prevCwd = process.cwd();

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }, { oracle: "stitch" }] } } }));
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["head", "worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`),
    `# ${role} contract\ncompany={{COMPANY}} dept={{DEPT}}\n`);
}
for (const p of [repoA, repoB, wrapperRepo]) mkdirSync(p, { recursive: true });

const STATE_FILES = ["head.md", "head-contract.md", "worker-contract.md", "reviewer-contract.md"];

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let nextId = 100;
/** what `#{session_path}` answers, per pane id — "" means tmux could not tell us */
let sessionPath: Record<string, string> = {};

const paneOf = (id: string) => panes.find((p) => p.id === id);
const arg = (cmd: string, re: RegExp) => re.exec(cmd)?.[1] ?? "";

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("display-message")) {
      if (cmd.includes("session_path")) {
        const pane = /-t '([^']+)'/.exec(cmd)?.[1] ?? "";
        return `${sessionPath[pane] ?? ""}\n`;
      }
      return "sess\n";
    }
    if (cmd.includes("pane_current_command")) return "zsh\n";
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    if (cmd.includes("new-window")) {
      const id = `%w${nextId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: wrapperRepo });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      const id = `%r${nextId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: wrapperRepo });
      return `${id}\n`;
    }
    if (cmd.includes("set-option")) {
      const p = paneOf(arg(cmd, /set-option -p-?u? -t '([^']+)'/));
      if (!p) return "";
      const unset = cmd.includes("set-option -pu");
      if (cmd.includes("@role")) p.role = unset ? "" : arg(cmd, /@role '([^']*)'/);
      else if (cmd.includes("@oracle_pane")) p.identity = unset ? "" : arg(cmd, /@oracle_pane '([^']*)'/);
      return "";
    }
    if (cmd.includes("kill-pane")) {
      panes = panes.filter((p) => p.id !== arg(cmd, /kill-pane -t '([^']+)'/));
      return "";
    }
    if (cmd.includes("has-session")) return "";
    return "";
  },
  listSessions: async () => [],
  // Both oracles' heads live in this test's single flat `panes` array; the
  // fixture is oracle-agnostic on purpose — the assertions are what pin each
  // oracle's writes to ITS OWN pane's anchor, not the session-lookup itself.
  findWindow: () => "sess:0",
  // kobo-822 fixture: the head pane already exists+is identified, exactly what
  // wake leaves behind — this suite is about the ANCHOR, not wake.
  cmdWake: async () => {},
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellSpawn, companyCellDown } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  process.chdir(prevCwd);
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  nextId = 100;
  // patchwork's head lives at %headA (anchored on repoA), stitch's at %headB
  // (anchored on repoB) — both already identified, both in the SAME fake
  // "session" (this fixture does not model tmux sessions, only pane identity).
  panes = [
    { id: "%headA", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: wrapperRepo },
    { id: "%headB", role: "👤 head", window: "cell-head", identity: "stitch:head", path: wrapperRepo },
  ];
  sessionPath = { "%headA": repoA, "%headB": repoB };
  // THE ENVIRONMENT UNDER TEST: this process sits in the wrapper's repo, exactly
  // as `~/bin/maw`'s `cd` leaves it. Nothing correct may come from here.
  process.chdir(wrapperRepo);
  for (const p of [repoA, repoB, wrapperRepo]) rmSync(join(p, "ψ"), { recursive: true, force: true });
  process.env.CELL_SPAWN_POLL_MS = "1";
});

const stateDirOf = (repo: string) => join(repo, "ψ", "active", "cell");
const spawnCmds = () => commands.filter((c) => c.includes("new-window") || c.includes("split-window"));

async function spawn(): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  return out;
}

async function down(): Promise<string[]> {
  const out: string[] = [];
  await companyCellDown("testco", { verbose: true }, (line) => out.push(line));
  return out;
}

describe("two oracles, two state dirs (kobo-780)", () => {
  test("neither spawn overwrites the other — both sets of contracts exist", async () => {
    const out = await spawn();
    expect(out.at(-1)).toContain("2 repaired");

    for (const f of STATE_FILES) {
      expect(existsSync(join(stateDirOf(repoA), f))).toBe(true);
      expect(existsSync(join(stateDirOf(repoB), f))).toBe(true);
    }
    // and nothing landed in the wrapper's repo, which is where BOTH used to go
    expect(existsSync(join(stateDirOf(wrapperRepo), "head.md"))).toBe(false);
  });

  test("each head.md records its own dir — not the last writer's", async () => {
    await spawn();
    expect(readFileSync(join(stateDirOf(repoA), "head.md"), "utf8")).toContain(`state-dir=${stateDirOf(repoA)}`);
    expect(readFileSync(join(stateDirOf(repoB), "head.md"), "utf8")).toContain(`state-dir=${stateDirOf(repoB)}`);
  });

  // kobo-822 regression guard: companyCellSpawn loops over the WHOLE roster in
  // one call from one process — worker/reviewer identity must come from the
  // member being processed, not from an ambient "who am I" lookup (that would
  // stamp every member's panes with the SAME identity: whoever's env the
  // orchestrator process happened to be running under).
  test("each oracle's worker+reviewer are stamped with ITS OWN identity, not the invoker's or each other's", async () => {
    await spawn();
    const workerReviewer = panes.filter((p) => p.window === "cell-workers");
    expect(workerReviewer.filter((p) => p.identity.startsWith("patchwork:")).map((p) => p.identity).sort())
      .toEqual(["patchwork:reviewer", "patchwork:worker"]);
    expect(workerReviewer.filter((p) => p.identity.startsWith("stitch:")).map((p) => p.identity).sort())
      .toEqual(["stitch:reviewer", "stitch:worker"]);
  });

  test("worker and reviewer panes are opened in the ORACLE's repo, not this process's cwd", async () => {
    await spawn();
    expect(spawnCmds()).toHaveLength(4); // 2 oracles x (worker + reviewer)
    for (const cmd of spawnCmds()) {
      const launch = cmd.replaceAll("'\\''", "'");
      expect(launch).toMatch(new RegExp(`cd '(${repoA}|${repoB})'`));
      expect(launch).not.toContain(wrapperRepo);
    }
  });

  test("process.cwd() is NOT the anchor — proven by moving it and getting the same answer", async () => {
    process.chdir(dir); // somewhere else entirely
    await spawn();
    expect(existsSync(join(stateDirOf(repoA), "head-contract.md"))).toBe(true);
    expect(existsSync(join(dir, "ψ", "active", "cell", "head-contract.md"))).toBe(false);
  });
});

describe("write and clean resolve the same directory (kobo-780, kobo-822)", () => {
  test("down removes the files spawn wrote — one resolver, both callers", async () => {
    await spawn();
    expect(existsSync(join(stateDirOf(repoA), "head-contract.md"))).toBe(true);

    const out = await down();

    for (const f of STATE_FILES) expect(existsSync(join(stateDirOf(repoA), f))).toBe(false);
    expect(out.some((l) => l.includes(`cell state removed from ${stateDirOf(repoA)}`))).toBe(true);
  });

  test("down does NOT read the pane's own cwd — the listing says the wrapper repo and it is ignored", async () => {
    await spawn();
    // the mocked pane listing reports pane_current_path = wrapperRepo (that is
    // what the old code used); the state is in repoA and must still be found
    await down();
    expect(existsSync(join(stateDirOf(repoA), "head.md"))).toBe(false);
  });
});

describe("an unresolvable anchor fails loudly (kobo-780, kobo-822)", () => {
  test("spawn refuses that oracle rather than writing into the wrapper's repo", async () => {
    sessionPath = {}; // tmux answers nothing for any pane
    const out = await spawn();

    expect(out.some((l) => l.includes("REFUSED") && l.includes("#{session_path}") && l.includes("%headA"))).toBe(true);
    expect(existsSync(join(stateDirOf(wrapperRepo), "head.md"))).toBe(false);
    expect(existsSync(join(stateDirOf(repoA), "head.md"))).toBe(false);
  });

  test("down leaves the state alone rather than deleting from a guessed directory", async () => {
    await spawn();
    sessionPath = {}; // the answer is gone by the time down runs

    const out = await down();

    expect(existsSync(join(stateDirOf(repoA), "head-contract.md"))).toBe(true);
    expect(out.some((l) => l.includes("LEFT IN PLACE") && l.includes("refusing to guess"))).toBe(true);
  });
});
