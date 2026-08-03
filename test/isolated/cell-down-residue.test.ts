/**
 * `cell down` leaves no trap state, and `cell spawn` reads the fleet per-oracle —
 * ISOLATED SUITE (kobo-775).
 *
 * The bug: down cleared the head's `@role` but left the window named `cell-head`,
 * while readiness asked a question about the whole SESSION ("is there a 👤 pane, a
 * ⚒ pane and a 🔎 pane anywhere in here?"). Two consequences, both of them the
 * fleet being misread rather than a cell being broken:
 *   - a session holding oracle A (cell down) and oracle B (cell up) reported A as
 *     READY off B's panes, so A was never repaired;
 *   - the repair target fell back to the session's first window, which after a
 *     down is the leftover `cell-head` — the repair line went to the wrong pane.
 *
 * Readiness is now the same authority teardown already used: the `@oracle_pane`
 * identity, scoped to the oracle being asked about. Down restores the window name
 * it overwrote, so nothing that decides readiness keys on residue down leaves.
 *
 * Why isolated: spawn.ts shells through maw-js/sdk hostExec and Bun's mock.module
 * is process-global. No test here touches a real tmux server — every tmux call
 * below is the mock, and the fake server MUTATES on set-option/rename-window/
 * kill-pane so a down→spawn cycle is one continuous state, not two fixtures.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellresidue-"));
const prevDataDir = process.env.MAW_DATA_DIR;
const prevPane = process.env.TMUX_PANE;
const prevPoll = process.env.CELL_SPAWN_POLL_MS;

process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));

const headCwd = join(dir, "headcwd");

interface FakePane {
  id: string;
  role: string;
  window: string;
  identity: string;
  path: string;
  /** the tmux user option `@cell_prev_window` */
  prevWindow?: string;
}

let panes: FakePane[] = [];
let commands: string[] = [];

const paneOf = (id: string) => panes.find((p) => p.id === id);
const arg = (cmd: string, re: RegExp) => re.exec(cmd)?.[1] ?? "";

/** A fake tmux server: it answers, and it CHANGES — down's writes are what the
 *  spawn half of a cycle test then reads back. */
mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);

    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("kill-pane")) {
      panes = panes.filter((p) => p.id !== arg(cmd, /kill-pane -t '([^']+)'/));
      return "";
    }
    if (cmd.includes("rename-window")) {
      const p = paneOf(arg(cmd, /rename-window -t '([^']+)'/));
      if (p) p.window = arg(cmd, /rename-window -t '[^']+' '([^']*)'/);
      return "";
    }
    if (cmd.includes("set-option")) {
      const p = paneOf(arg(cmd, /set-option -p-?u? -t '([^']+)'/));
      if (!p) return "";
      const unset = cmd.includes("set-option -pu");
      if (cmd.includes("@cell_prev_window")) p.prevWindow = unset ? undefined : arg(cmd, /@cell_prev_window '([^']*)'/);
      else if (cmd.includes("@role")) p.role = unset ? "" : arg(cmd, /@role '([^']*)'/);
      else if (cmd.includes("@oracle_pane")) p.identity = unset ? "" : arg(cmd, /@oracle_pane '([^']*)'/);
      return "";
    }
    if (cmd.includes("display-message")) {
      if (cmd.includes("session_path")) return `${headCwd}\n`; // kobo-780 anchor
      const p = paneOf(arg(cmd, /display-message -p -t '([^']+)'/));
      if (cmd.includes("@cell_prev_window")) return `${p?.prevWindow ?? ""}\n`;
      if (cmd.includes("window_name")) return `${p?.window ?? ""}\n`;
      if (cmd.includes("pane_current_command")) return "zsh\n";
      return "sess\n";
    }
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    return "";
  },
  listSessions: async () => [],
  // What findWindow answers for a bare oracle name: a session:window, never a
  // pane id — the positional fallback this card is about.
  findWindow: () => "42-patchwork:0",
  cmdWake: async () => {},
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellDown, companyCellSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

/** a full cell for `patchwork`, head adopted in a window that had its own name */
function liveCell(): FakePane[] {
  return [
    { id: "%10", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: headCwd, prevWindow: "patchwork" },
    { id: "%11", role: "⚒ worker", window: "cell-workers", identity: "patchwork:worker", path: headCwd },
    { id: "%12", role: "🔎 reviewer", window: "cell-workers", identity: "patchwork:reviewer", path: headCwd },
  ];
}

beforeEach(() => {
  commands = [];
  panes = liveCell();
  process.env.TMUX_PANE = "%invoker";
  process.env.CELL_SPAWN_POLL_MS = "1";
});

async function down(verbose = true): Promise<string[]> {
  const out: string[] = [];
  await companyCellDown("testco", { verbose }, (line) => out.push(line));
  return out;
}

async function spawn(verbose = true): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), verbose);
  return out;
}

const sentTo = () => commands.filter((c) => c.includes("send-keys")).map((c) => arg(c, /send-keys -t '([^']+)'/));

describe("down leaves no window-name residue (kobo-775)", () => {
  test("the head window goes back to the name self-spawn overwrote", async () => {
    await down();
    expect(paneOf("%10")!.window).toBe("patchwork");
    expect(paneOf("%10")!.prevWindow).toBeUndefined(); // the parking slot is emptied too
  });

  test("a cell spawned before this fix parked nothing → the window takes the oracle's own name", async () => {
    panes[0]!.prevWindow = undefined;
    await down();
    expect(paneOf("%10")!.window).toBe("patchwork");
  });

  test("a window someone has since renamed is theirs — down does not touch it", async () => {
    panes[0]!.window = "deploy";
    await down();
    expect(paneOf("%10")!.window).toBe("deploy");
    expect(commands.some((c) => c.includes("rename-window"))).toBe(false);
  });

  test("identity is kept (it is not readiness) while @role and the window name go", async () => {
    await down();
    expect(paneOf("%10")!.identity).toBe("patchwork:head");
    expect(paneOf("%10")!.role).toBe("");
  });
});

describe("readiness reads identity, scoped to the oracle asked about (kobo-775)", () => {
  test("down then spawn: not reported ready, and the repair goes to the HEAD pane, not the first window", async () => {
    await down();
    commands = [];
    const out = await spawn();

    expect(sentTo()).toEqual(["%10", "%10", "%10"]); // C-u, the line, Enter
    expect(sentTo()).not.toContain("42-patchwork:0"); // the positional fallback
    expect(out.at(-1)).toContain("1 repaired");
    expect(out.some((l) => l.includes("cell incomplete") && l.includes("%10"))).toBe(true);
  });

  test("a complete cell is still skipped as ready — spawn after down does not repair twice", async () => {
    const out = await spawn();
    expect(sentTo()).toEqual([]);
    expect(out.at(-1)).toContain("1 ready, 0 repaired");
  });

  test("ANOTHER oracle's live cell in the same session no longer answers for this one", async () => {
    // patchwork is down to its head; stitch is fully up in the same session. The
    // session has a 👤, a ⚒ and a 🔎 — the old predicate called patchwork ready.
    panes = [
      { id: "%10", role: "", window: "patchwork", identity: "patchwork:head", path: headCwd },
      { id: "%20", role: "👤 head", window: "cell-head", identity: "stitch:head", path: headCwd },
      { id: "%21", role: "⚒ worker", window: "cell-workers", identity: "stitch:worker", path: headCwd },
      { id: "%22", role: "🔎 reviewer", window: "cell-workers", identity: "stitch:reviewer", path: headCwd },
    ];
    const out = await spawn();

    expect(out.at(-1)).toContain("0 ready");
    expect(sentTo()).toEqual(["%10", "%10", "%10"]); // patchwork's own pane, not stitch's head
  });

  test("pre-759 orphan: head @role with no identity, alone in the session → still the repair target", async () => {
    panes = [{ id: "%30", role: "👤 head", window: "cell-head", identity: "", path: headCwd }];
    await spawn();
    expect(sentTo()).toEqual(["%30", "%30", "%30"]);
  });

  test("...but two unidentified 👤 panes name nobody → fall back, never guess between them", async () => {
    panes = [
      { id: "%30", role: "👤 head", window: "cell-head", identity: "", path: headCwd },
      { id: "%31", role: "👤 head", window: "cell-head", identity: "", path: headCwd },
    ];
    await spawn();
    expect(sentTo()).toEqual(["42-patchwork:0", "42-patchwork:0", "42-patchwork:0"]);
  });
});

describe("two panes claiming {oracle}:head resolve by rule, out loud (kobo-775)", () => {
  const dualHead = (): FakePane[] => [
    { id: "%40", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd, prevWindow: "patchwork" },
    { id: "%9", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd, prevWindow: "patchwork-old" },
  ];

  test("spawn: the lowest pane id wins and BOTH claimants are named", async () => {
    panes = dualHead();
    const out = await spawn();

    expect(sentTo()).toEqual(["%9", "%9", "%9"]);
    const warn = out.find((l) => l.includes("claim @oracle_pane=patchwork:head")) ?? "";
    expect(warn).toContain("%9");
    expect(warn).toContain("%40");
    expect(warn).toContain("using %9");
  });

  test("the warning is not hidden behind --verbose (it decides where keys get typed)", async () => {
    panes = dualHead();
    const out = await spawn(false);
    expect(out.some((l) => l.includes("claim @oracle_pane=patchwork:head"))).toBe(true);
  });

  test("down stands the SAME pane down — one rule, both verbs", async () => {
    panes = dualHead();
    const out = await down();

    expect(paneOf("%9")!.window).toBe("patchwork-old");
    expect(paneOf("%40")!.window).toBe("cell-head"); // untouched: it did not win
    expect(out.some((l) => l.includes("head %9") && l.includes("kept"))).toBe(true);
  });

  test("ordering is the id NUMBER, not the string ('%9' < '%40' lexically is a coincidence)", async () => {
    panes = [
      { id: "%400", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd },
      { id: "%100", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd },
    ];
    await spawn();
    expect(sentTo()).toEqual(["%100", "%100", "%100"]);
  });
});
