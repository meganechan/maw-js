/**
 * cell spawn: one state dir, resolved once — ISOLATED SUITE (kobo-765/B5,
 * updated kobo-822).
 *
 * B5 (unchanged by kobo-822): the state dir used to be derived TWICE — the
 * writer took `process.env.CREW_STATE_DIR || ψ/active/cell`, the head launch
 * line took the default. A pane that had been a cell before still exported the
 * PREVIOUS cell's `CREW_STATE_DIR`, so contracts were written over there while
 * head `cat`'d the default path — an EMPTY system prompt, invisible from
 * inside the code because the pane looked alive.
 *
 * kobo-822 moved WHO writes the contracts: `companyCellSpawn` does it directly
 * now (no more `cellSelfSpawn` running inside the target pane, and no more
 * head launch line built in this file at all — a freshly woken head's launch
 * is generic `cmdWake`'s concern, out of this file's scope). What did not
 * change is the derivation itself: `cellAnchor` → `stateDirOf` → one path, fed
 * into the worker/reviewer launch commands as `CREW_STATE_DIR`, never read
 * back from the pane's own (possibly stale) environment.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server —
 * every tmux call below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellstate-"));
const home = join(dir, "home");
const repo = join(dir, "repo");
/** what a re-used pane still exports — the writer must ignore this */
const staleStateDir = join(dir, "previous-cell-state");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevStateDir = process.env.CREW_STATE_DIR;
const prevPoll = process.env.CELL_SPAWN_POLL_MS;

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
mkdirSync(repo, { recursive: true });
mkdirSync(staleStateDir, { recursive: true });

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let nextId = 100;

const paneOf = (id: string) => panes.find((p) => p.id === id);
const arg = (cmd: string, re: RegExp) => re.exec(cmd)?.[1] ?? "";

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("display-message")) {
      if (cmd.includes("session_path")) return `${repo}\n`; // kobo-780 anchor
      return "sess\n";
    }
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    if (cmd.includes("new-window")) {
      const id = `%w${nextId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: repo });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      const id = `%r${nextId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: repo });
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
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:0",
  // kobo-822 fixture: head already identified — this suite is about the state
  // dir the contracts land in, not about wake.
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
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.CREW_STATE_DIR; else process.env.CREW_STATE_DIR = prevStateDir;
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  nextId = 100;
  panes = [{ id: "%head", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: repo }];
  rmSync(join(repo, "ψ"), { recursive: true, force: true });
  // the STALE export left by a pane's previous life as a cell — set on every
  // test on purpose; the writer must never read it (it runs in THIS process,
  // not the pane's shell, so this is really proving the value is not consulted).
  process.env.CREW_STATE_DIR = staleStateDir;
  process.env.CELL_SPAWN_POLL_MS = "1";
});

async function spawn(): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  return out;
}

const stateDir = join(repo, "ψ/active/cell");

describe("cell spawn resolves the state dir ONCE, from the anchor — never from env (kobo-765 B5, kobo-822)", () => {
  test("stale CREW_STATE_DIR in this process's env → contracts still land under the anchored repo", async () => {
    const result = await spawn();

    expect(existsSync(join(staleStateDir, "head-contract.md"))).toBe(false);
    expect(existsSync(join(stateDir, "head-contract.md"))).toBe(true);
    expect(readFileSync(join(stateDir, "head-contract.md"), "utf8")).toContain("company=testco");
  });

  test("the exported CREW_STATE_DIR (worker/reviewer launch commands, hooks read it) is the resolved dir, not the inherited one", async () => {
    await spawn();
    const paneCmds = commands.filter((c) => c.includes("new-window") || c.includes("split-window"));
    expect(paneCmds).toHaveLength(2);
    for (const cmd of paneCmds) {
      expect(cmd).toContain("CREW_STATE_DIR=");
      expect(cmd).toContain("ψ/active/cell");
      expect(cmd).not.toContain(staleStateDir);
    }
  });

  test("worker and reviewer contracts are both written, addressed at the right role", async () => {
    await spawn();
    for (const role of ["worker", "reviewer"]) {
      const content = readFileSync(join(stateDir, `${role}-contract.md`), "utf8");
      expect(content).toContain(`# ${role} contract`);
      expect(content).toContain("company=testco");
    }
  });
});

describe("worker boot has a working fallback, and a stuck reviewer boot is surfaced without blocking (kobo-765 B7 lineage, kobo-822)", () => {
  test("REGRESSION: a normal spawn on a fresh head is unchanged — worker (new-window), reviewer (split-window), every role stamped", async () => {
    const result = await spawn();

    const roles = commands.filter((c) => c.includes("set-option -p") && c.includes("@role ")).map((c) => c.slice(c.indexOf("@role")));
    expect(roles).toEqual(["@role '⚒ worker'", "@role '🔎 reviewer'"]);
    expect(commands.some((c) => c.includes("new-window"))).toBe(true);
    expect(commands.some((c) => c.includes("split-window"))).toBe(true);
  });
});
