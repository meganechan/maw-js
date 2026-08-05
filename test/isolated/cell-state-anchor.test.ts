/**
 * Every oracle gets ITS OWN repo, dept and panes — ISOLATED SUITE (kobo-780, kobo-822).
 *
 * kobo-780's bug was environmental and invisible from inside the code: `~/bin/maw`
 * does `cd /Users/tony/maw-js` before exec, so `process.cwd()` is maw-js in EVERY
 * maw invocation. Everything the cell derived from cwd named the same directory
 * for every oracle in the fleet. The anchor is now `#{session_path}` — set once by
 * `tmux new-session -c <repoPath>` (wake-cmd) and unmovable by any later process.
 *
 * kobo-822 makes this the file's main subject rather than a side one, because the
 * spawner no longer runs inside the target pane: ONE process now loops the whole
 * roster from outside. Every value that used to come from "wherever I am" is now a
 * per-member lookup, and getting one of them wrong stamps eleven oracles with the
 * caller's answer. PR #443 shipped exactly that bug with `self = selfOracleId()`;
 * `resolveSelfDept()` was the same bug in the contract renderer.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec and Bun's mock.module is
 * process-global. No test here touches a real tmux server — the anchor is whatever
 * the mock says `#{session_path}` is, which is how two oracles get two repos.
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
/** where the buggy behaviour landed everything: one shared dir, this process's cwd */
const wrapperRepo = join(dir, "maw-js");

const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevPane = process.env.TMUX_PANE;
const prevCwd = process.cwd();

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
// patchwork is in dept `core`, stitch in dept `utils` — two answers the caller
// cannot supply for both.
writeFileSync(join(dir, "companies", "testco.json"), JSON.stringify({
  name: "testco",
  teams: {
    core: { members: [{ oracle: "patchwork" }] },
    utils: { members: [{ oracle: "stitch" }] },
  },
}));
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`),
    `# ${role} contract\ncompany={{COMPANY}} dept={{DEPT}}\n`);
}
for (const p of [repoA, repoB, wrapperRepo]) mkdirSync(p, { recursive: true });

interface FakePane { id: string; window: string; index: string; identity: string }

let commands: string[] = [];
/** panes per session — two sessions, one per oracle */
let sessions: Record<string, FakePane[]> = {};
/** what `#{session_path}` answers, per pane — "" means tmux could not tell us */
let sessionPath: Record<string, string> = {};
let nextPane = 0;

/** which session a `-t` target names, for list-panes and new-window alike */
function sessionOfTarget(cmd: string): string {
  const t = /-t '([^']+)'/.exec(cmd)?.[1] ?? "";
  return t.replace(/:.*$/, "");
}

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("session_path")) {
      const pane = /-t '([^']+)'/.exec(cmd)?.[1] ?? "";
      return `${sessionPath[pane] ?? ""}\n`;
    }
    if (cmd.includes("list-panes")) {
      const panes = sessions[sessionOfTarget(cmd)] ?? [];
      // `#{pane_id}|||#{@role}|||#{window_name}|||#{@oracle_pane}|||#{pane_current_path}|||#{window_index}`
      return panes.map((p) => [p.id, "", p.window, p.identity, "/tmp", p.index].join("|||")).join("\n") + "\n";
    }
    if (cmd.includes("new-window")) {
      const sess = sessionOfTarget(cmd);
      const id = `%w${nextPane++}`;
      (sessions[sess] ??= []).push({ id, window: "cell-workers", index: "1", identity: "" });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      const target = /-t '([^']+)'/.exec(cmd)?.[1] ?? "";
      const sess = Object.keys(sessions).find((s) => sessions[s]!.some((p) => p.id === target)) ?? "";
      const id = `%r${nextPane++}`;
      (sessions[sess] ??= []).push({ id, window: "cell-workers", index: "1", identity: "" });
      return `${id}\n`;
    }
    const stamp = /set-option -p -t '([^']+)' @oracle_pane '([^']+)'/.exec(cmd);
    if (stamp) {
      for (const panes of Object.values(sessions)) {
        const pane = panes.find((p) => p.id === stamp[1]);
        if (pane) pane.identity = stamp[2]!;
      }
      return "";
    }
    return "";
  },
  listSessions: async () => [],
  // `session:INDEX`, the shape `find-window.ts` returns — never a window name
  findWindow: (_s: unknown, oracle: string) => {
    const map: Record<string, string> = { patchwork: "sessA:0", stitch: "sessB:0" };
    const found = map[oracle];
    if (!found) throw new Error(`no window for ${oracle}`);
    return found;
  },
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
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
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  nextPane = 0;
  sessions = {
    sessA: [{ id: "%headA", window: "patchwork-oracle", index: "0", identity: "" }],
    sessB: [{ id: "%headB", window: "stitch-oracle", index: "0", identity: "" }],
  };
  sessionPath = { "%headA": repoA, "%headB": repoB };
  // THE ENVIRONMENT UNDER TEST: this process sits in the wrapper's repo, exactly
  // as `~/bin/maw`'s `cd` leaves it, and claims to be a THIRD oracle entirely.
  // Nothing correct may come from either.
  process.chdir(wrapperRepo);
  process.env.CLAUDE_AGENT_NAME = "eq3";
  process.env.TMUX_PANE = "%invoker";
  for (const p of [repoA, repoB, wrapperRepo]) rmSync(join(p, "ψ"), { recursive: true, force: true });
});

const stateDirOf = (repo: string) => join(repo, "ψ", "active", "cell");
const creationCmds = () => commands.filter((c) => c.includes("new-window") || c.includes("split-window"));

async function spawnAll(): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  return out;
}

describe("one process, one roster pass, two separate cells (kobo-780, kobo-822)", () => {
  test("each oracle's contracts land in ITS OWN repo — the second pass does not overwrite the first", async () => {
    const out = await spawnAll();

    for (const f of ["worker-contract.md", "reviewer-contract.md"]) {
      expect(existsSync(join(stateDirOf(repoA), f))).toBe(true);
      expect(existsSync(join(stateDirOf(repoB), f))).toBe(true);
    }
    // and nothing landed in the wrapper's repo, which is where BOTH used to go
    expect(existsSync(join(stateDirOf(wrapperRepo), "worker-contract.md"))).toBe(false);
    expect(out.at(-1)).toContain("2 ready");
  });

  /**
   * The `self = selfOracleId()` bug from PR #443, and `resolveSelfDept()` before
   * it: one process rendering two contracts wrote the CALLER's answer into both.
   * The caller here is `eq3`, which is in neither dept.
   */
  test("each contract carries the ROSTER member's dept — never the caller's", async () => {
    await spawnAll();

    expect(readFileSync(join(stateDirOf(repoA), "worker-contract.md"), "utf8")).toContain("dept=core");
    expect(readFileSync(join(stateDirOf(repoB), "worker-contract.md"), "utf8")).toContain("dept=utils");
  });

  test("each pane is stamped with the oracle it belongs to — never the caller's name", async () => {
    await spawnAll();

    const stamped = Object.values(sessions).flat().map((p) => p.identity).sort();
    expect(stamped).toEqual([
      "patchwork:head", "patchwork:reviewer", "patchwork:worker",
      "stitch:head", "stitch:reviewer", "stitch:worker",
    ].sort());
    expect(commands.some((c) => c.includes("@oracle_pane") && c.includes("eq3"))).toBe(false);
  });

  test("panes are created in each oracle's OWN session, not the caller's", async () => {
    await spawnAll();

    expect(sessions.sessA!.map((p) => p.id)).toEqual(["%headA", "%w0", "%r1"]);
    expect(sessions.sessB!.map((p) => p.id)).toEqual(["%headB", "%w2", "%r3"]);
    expect(commands.some((c) => c.includes("new-window") && c.includes("-t 'sessA:'"))).toBe(true);
    expect(commands.some((c) => c.includes("new-window") && c.includes("-t 'sessB:'"))).toBe(true);
  });

  test("each launch line cd's into that oracle's repo and exports that oracle's state dir", async () => {
    await spawnAll();

    expect(creationCmds()).toHaveLength(4);
    for (const cmd of creationCmds()) {
      // the launch line is nested inside the tmux argument — read it as the
      // pane's shell will, not as the tmux command string
      const launch = cmd.replaceAll("'\\''", "'");
      const repo = launch.includes(repoA) ? repoA : repoB;
      expect(launch).toContain(`cd '${repo}'`);
      expect(launch).toContain(`CREW_STATE_DIR='${stateDirOf(repo)}'`);
      expect(launch).not.toContain(wrapperRepo);
    }
  });

  test("process.cwd() is NOT the anchor — proven by moving it and getting the same answer", async () => {
    process.chdir(dir); // somewhere else entirely
    await spawnAll();

    expect(existsSync(join(stateDirOf(repoA), "worker-contract.md"))).toBe(true);
    expect(existsSync(join(dir, "ψ", "active", "cell", "worker-contract.md"))).toBe(false);
  });
});

describe("an unresolvable anchor fails loudly (kobo-780)", () => {
  test("no session_path → REFUSED, and nothing is written into the wrapper's repo", async () => {
    sessionPath = {}; // tmux cannot tell us where either oracle lives
    const out = await spawnAll();

    expect(out.filter((l) => l.includes("REFUSED") && l.includes("session_path"))).toHaveLength(2);
    expect(out.at(-1)).toContain("0 ready, 0 incomplete, 0 not-running, 2 refused");
    expect(existsSync(join(stateDirOf(wrapperRepo), "worker-contract.md"))).toBe(false);
    expect(creationCmds()).toEqual([]);
  });

  test("one oracle's anchor is unreadable → the OTHER still gets its cell", async () => {
    sessionPath = { "%headB": repoB };
    const out = await spawnAll();

    expect(existsSync(join(stateDirOf(repoB), "worker-contract.md"))).toBe(true);
    expect(existsSync(join(stateDirOf(repoA), "worker-contract.md"))).toBe(false);
    expect(out.at(-1)).toContain("1 ready, 0 incomplete, 0 not-running, 1 refused");
  });
});
