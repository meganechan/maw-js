/**
 * `maw company cell down` selection + counters — ISOLATED SUITE (kobo-764).
 *
 * The bug (kobo-750): down picked its kill list by cell EMOJI in `@role` and by
 * WINDOW NAME (`cell-head`/`cell-workers`). Both are shared namespaces — one tmux
 * session can hold several oracles' cells plus human splits — so `down A` reached
 * panes that were not A's, and a human pane merely sitting in a cell-named window
 * was killed. Every kill attempt was also counted as a success (the catch block
 * did `killed++`), so a cell still standing reported as torn down.
 *
 * Selection is now the `@oracle_pane` identity and nothing else, and `killed`
 * comes from re-reading the pane list, not from what kill-pane returned.
 *
 * Why isolated: spawn.ts shells through maw-js/sdk hostExec and Bun's mock.module
 * is process-global. No test here touches a real tmux server — every tmux call
 * below is the mock (the live socket runs the production fleet).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-celldown-"));
const prevDataDir = process.env.MAW_DATA_DIR;
const prevPane = process.env.TMUX_PANE;

process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));

/** where the head pane's shell is — down reads cell state relative to THAT, not to itself */
const headCwd = join(dir, "headcwd");
const stateDir = join(headCwd, "ψ", "active", "cell");
const STATE_FILES = ["head.md", "worker.md", "reviewer.md", "head-contract.md", "worker-contract.md", "reviewer-contract.md"];

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let killAttempts: string[] = [];
/** kill-pane throws AND the pane stays (tmux refused) */
let killThrows = new Set<string>();
/** kill-pane returns cleanly but the pane is still there (the silent failure) */
let killLies = new Set<string>();
/** list-panes throws from this call index onward */
let listFailsAfter = Number.POSITIVE_INFINITY;
let listCalls = 0;

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux list-panes")) {
      if (listCalls++ >= listFailsAfter) throw new Error("no server running on socket");
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    // kobo-780 — down resolves the state dir from the head pane's SESSION path,
    // the same field self-spawn writes against (it used to read the pane's own
    // cwd, which self-spawn cannot see the same way).
    if (cmd.includes("session_path")) return `${headCwd}\n`;
    if (cmd.includes("kill-pane")) {
      const target = cmd.match(/kill-pane -t '([^']+)'/)?.[1] ?? "";
      killAttempts.push(target);
      if (killThrows.has(target)) throw new Error("can't find pane");
      if (!killLies.has(target)) panes = panes.filter((p) => p.id !== target);
      return "";
    }
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:win",
  cmdWake: async () => {},
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellDown } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { runCell } = await import("../../src/vendor/mpr-plugins/cell/index");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One tmux session, three tenants: oracle A's cell (patchwork), a human split,
 * and oracle B's cell (stitch). The human pane wears a cell emoji `@role` and
 * sits in the cell-workers window on purpose — the old selector matched both.
 */
function mixedSession(): void {
  panes = [
    { id: "%a-head", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: headCwd },
    { id: "%a-worker", role: "⚒ worker", window: "cell-workers", identity: "patchwork:worker", path: headCwd },
    { id: "%a-reviewer", role: "🔎 reviewer", window: "cell-workers", identity: "patchwork:reviewer", path: headCwd },
    { id: "%human", role: "⚒ worker", window: "cell-workers", identity: "", path: headCwd },
    { id: "%b-head", role: "👤 head", window: "cell-head", identity: "stitch:head", path: headCwd },
    { id: "%b-worker", role: "⚒ worker", window: "cell-workers", identity: "stitch:worker", path: headCwd },
  ];
}

beforeEach(() => {
  commands = [];
  killAttempts = [];
  killThrows = new Set();
  killLies = new Set();
  listFailsAfter = Number.POSITIVE_INFINITY;
  listCalls = 0;
  process.env.TMUX_PANE = "%invoker";
  mixedSession();
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) writeFileSync(join(stateDir, f), "state\n");
});

async function down(verbose = true): Promise<string[]> {
  const out: string[] = [];
  await companyCellDown("testco", { verbose }, (line) => out.push(line));
  return out;
}

const alive = () => panes.map((p) => p.id).sort();

describe("cell down selects panes by @oracle_pane identity (kobo-764)", () => {
  test("mixed session — down A kills ONLY A's worker+reviewer; B's cell and the human pane survive", async () => {
    const out = await down();

    expect(killAttempts.sort()).toEqual(["%a-reviewer", "%a-worker"]);
    expect(alive()).toEqual(["%a-head", "%b-head", "%b-worker", "%human"]);
    expect(out.at(-1)).toContain("1 torn, 0 partial, 0 skipped, 0 refused");
  });

  test("a pane with NO identity inside the cell-workers window survives — emoji @role and window name are not selectors", async () => {
    await down();
    expect(killAttempts).not.toContain("%human");
    expect(panes.some((p) => p.id === "%human")).toBe(true);
    // and nothing was selected off a pane title
    expect(commands.some((c) => c.includes("pane_title"))).toBe(false);
  });

  test("another oracle's worker is never killed even in the same session and window", async () => {
    await down();
    expect(killAttempts).not.toContain("%b-worker");
    expect(killAttempts).not.toContain("%b-head");
  });

  test("head is the last pane standing → never killed, and said out loud without --verbose", async () => {
    panes = panes.filter((p) => p.identity.startsWith("patchwork:"));
    const out = await down(false);

    expect(killAttempts.sort()).toEqual(["%a-reviewer", "%a-worker"]);
    expect(alive()).toEqual(["%a-head"]);
    expect(out.some((l) => l.includes("%a-head") && l.includes("kept"))).toBe(true);
  });

  test("no pane carries {oracle}:head → fail closed, nothing is killed", async () => {
    panes = panes.map((p) => (p.id === "%a-head" ? { ...p, identity: "" } : p));
    const out = await down();

    expect(killAttempts).toEqual([]);
    expect(out.at(-1)).toContain("1 skipped");
  });
});

describe("cell down cleans up after itself (kobo-764)", () => {
  test("cell state files under the HEAD pane's cwd are removed", async () => {
    expect(existsSync(join(stateDir, "head.md"))).toBe(true);
    await down();
    for (const f of STATE_FILES) expect(existsSync(join(stateDir, f))).toBe(false);
  });

  test("the head's cell @role is cleared but its {oracle}:head identity is kept — the oracle is still there", async () => {
    await down();
    expect(commands).toContain("tmux set-option -pu -t '%a-head' @role");
    expect(commands.some((c) => c.includes("@oracle_pane") && c.includes("-u"))).toBe(false);
  });
});

describe("cell down counters report what actually happened (kobo-764)", () => {
  test("kill that tmux refuses → NOT counted killed, summary says partial, state left in place", async () => {
    killThrows.add("%a-reviewer");
    const out = await down();

    expect(out.at(-1)).toContain("0 torn, 1 partial");
    expect(out.some((l) => l.includes("PARTIAL") && l.includes("killed 1/2") && l.includes("%a-reviewer"))).toBe(true);
    expect(existsSync(join(stateDir, "head.md"))).toBe(true);
  });

  test("kill returns cleanly but the pane is still there → still a failure (killed means gone)", async () => {
    killLies.add("%a-worker");
    const out = await down();

    expect(out.at(-1)).toContain("0 torn, 1 partial");
    expect(out.some((l) => l.includes("PARTIAL") && l.includes("%a-worker"))).toBe(true);
  });

  test("the verifying pane list fails → nothing is claimed killed (unverifiable, not success)", async () => {
    listFailsAfter = 1; // first list builds the kill set, the verifying one throws
    const out = await down();

    expect(out.some((l) => l.includes("unverifiable"))).toBe(true);
    expect(out.at(-1)).toContain("0 torn, 1 partial");
  });

  test("nothing left to kill → idempotent: head stood down, counted torn, not partial", async () => {
    panes = panes.filter((p) => !["%a-worker", "%a-reviewer"].includes(p.id));
    const out = await down();

    expect(killAttempts).toEqual([]);
    expect(out.at(-1)).toContain("1 torn, 0 partial");
    expect(existsSync(join(stateDir, "head.md"))).toBe(false);
  });
});

describe("cell usage names the verb that replaced 'up' (kobo-764)", () => {
  test("unknown verb 'up' → usage points at spawn", async () => {
    const result = await runCell(["up", "testco"], () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'up' was replaced by 'spawn'");
  });
});
