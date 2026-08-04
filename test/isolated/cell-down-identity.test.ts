/**
 * `cell down` + `cell spawn` read the fleet per-oracle by identity, and down
 * now tears down the head too — ISOLATED SUITE (kobo-775, updated kobo-822).
 *
 * kobo-775's original bug: down cleared the head's `@role` but left the window
 * named `cell-head`, and readiness asked a question about the whole SESSION
 * ("is there a 👤 pane, a ⚒ pane and a 🔎 pane anywhere in here?") instead of
 * the oracle. Readiness is still the `@oracle_pane` identity, scoped to the
 * oracle asked about — that part is unchanged and still covered below.
 *
 * kobo-822 changed what down DOES with the head: it used to stand it down and
 * keep it alive (the oracle's own pane, adopted at self-spawn, was never
 * killed) with a window-name park/restore dance so a later self-spawn could
 * find and re-adopt it. That adoption path is gone — down now kills head too,
 * and spawn always builds from nothing via `cmdWake` (never a re-adopt). The
 * window-name park/restore tests this file used to carry are retired along
 * with the code they proved.
 *
 * Why isolated: spawn.ts shells through maw-js/sdk hostExec and Bun's
 * mock.module is process-global. No test here touches a real tmux server —
 * every tmux call below is the mock, and the fake server MUTATES on
 * set-option/new-window/split-window/kill-pane so a down→spawn cycle is one
 * continuous state, not two fixtures.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellidentity2-"));
const home = join(dir, "home");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevPane = process.env.TMUX_PANE;
const prevPoll = process.env.CELL_SPAWN_POLL_MS;

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["head", "worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`), `# ${role} {{COMPANY}}\n`);
}

const headCwd = join(dir, "headcwd");

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let nextId = 100;

const paneOf = (id: string) => panes.find((p) => p.id === id);
const arg = (cmd: string, re: RegExp) => re.exec(cmd)?.[1] ?? "";

/** A fake tmux server: it answers, and it CHANGES. */
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
    if (cmd.includes("has-session")) {
      if (panes.length === 0) throw new Error("session not found");
      return "";
    }
    if (cmd.includes("new-window")) {
      const id = `%w${nextId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: headCwd });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      const id = `%r${nextId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: headCwd });
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
    if (cmd.includes("display-message")) {
      if (cmd.includes("session_path")) return `${headCwd}\n`;
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
  // kobo-822 fixture: mirrors what wake actually does now — genuinely asleep
  // (no panes at all) gets a fresh head pane; a SOLE unidentified live pane
  // gets stamped in place (kobo-777); two or more unidentified panes name
  // nobody, so nothing is touched (never guessed).
  cmdWake: async (oracle: string) => {
    if (panes.length === 0) {
      panes.push({ id: `%wake${nextId++}`, role: "", window: oracle, identity: `${oracle}:head`, path: headCwd });
      return;
    }
    const unidentified = panes.filter((p) => !p.identity);
    if (unidentified.length === 1) unidentified[0]!.identity = `${oracle}:head`;
  },
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellDown, companyCellSpawn } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

/** a full cell for `patchwork` */
function liveCell(): FakePane[] {
  return [
    { id: "%10", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: headCwd },
    { id: "%11", role: "⚒ worker", window: "cell-workers", identity: "patchwork:worker", path: headCwd },
    { id: "%12", role: "🔎 reviewer", window: "cell-workers", identity: "patchwork:reviewer", path: headCwd },
  ];
}

beforeEach(() => {
  commands = [];
  nextId = 100;
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

describe("down tears down head too (kobo-822)", () => {
  test("head is killed along with worker+reviewer — nothing survives", async () => {
    const out = await down();
    expect(panes).toEqual([]);
    expect(out.at(-1)).toContain("1 torn, 0 partial, 0 skipped, 0 refused");
  });

  test("the invoker's OWN pane is never killed, even as head", async () => {
    // a solo head, no worker/reviewer to kill first — isolates the "toKill is
    // empty because head IS the invoker" branch from the ordinary partial case
    panes = [{ id: "%10", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: headCwd }];
    process.env.TMUX_PANE = "%10"; // running `cell down` from its own head
    const out = await down();
    expect(panes.map((p) => p.id)).toEqual(["%10"]);
    expect(out.some((l) => l.includes("%10") && l.includes("invoker's OWN pane"))).toBe(true);
  });
});

describe("readiness reads identity, scoped to the oracle asked about (kobo-775)", () => {
  test("down then spawn: not reported ready, and a FRESH cell is built — nothing is typed into the old pane", async () => {
    await down();
    expect(panes).toEqual([]);
    commands = [];
    const out = await spawn();

    // wake builds a new head from nothing, spawn fills in the rest — no
    // keystroke anywhere in the cycle
    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);
    expect(commands.some((c) => c.includes("new-window"))).toBe(true);
    expect(commands.some((c) => c.includes("split-window"))).toBe(true);
    expect(out.at(-1)).toContain("1 repaired");
    // exact identity — proves the member being processed, not an ambient env lookup
    expect(panes.filter((p) => p.identity === "patchwork:head")).toHaveLength(1);
    expect(panes.filter((p) => p.identity === "patchwork:worker")).toHaveLength(1);
    expect(panes.filter((p) => p.identity === "patchwork:reviewer")).toHaveLength(1);
  });

  test("a complete cell is still skipped as ready — spawn does not repair twice", async () => {
    const out = await spawn();
    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
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
    expect(out.at(-1)).toContain("1 repaired");
    // patchwork's own worker+reviewer were built beside %10, stitch untouched
    expect(panes.some((p) => p.id === "%20" && p.identity === "stitch:head")).toBe(true);
    expect(panes.filter((p) => p.identity === "patchwork:worker")).toHaveLength(1);
    expect(panes.filter((p) => p.identity === "patchwork:reviewer")).toHaveLength(1);
  });

  test("a SOLE unidentified head-shaped pane gets identified by wake and completed — no fallback guess needed", async () => {
    panes = [{ id: "%30", role: "👤 head", window: "cell-head", identity: "", path: headCwd }];
    const out = await spawn();

    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);
    expect(paneOf("%30")!.identity).toBe("patchwork:head");
    expect(out.at(-1)).toContain("1 repaired");
  });

  test("...but two unidentified 👤 panes name nobody → REFUSED, never guessed", async () => {
    panes = [
      { id: "%30", role: "👤 head", window: "cell-head", identity: "", path: headCwd },
      { id: "%31", role: "👤 head", window: "cell-head", identity: "", path: headCwd },
    ];
    const out = await spawn();

    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);
    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
    expect(out.at(-1)).toContain("1 refused/failed");
  });
});

describe("two panes claiming {oracle}:head resolve by rule, out loud — and only the winner is torn down (kobo-775, kobo-822)", () => {
  const dualHead = (): FakePane[] => [
    { id: "%40", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd },
    { id: "%9", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd },
  ];

  test("spawn: the lowest pane id wins and BOTH claimants are named, but only the winner gets worker+reviewer", async () => {
    panes = dualHead();
    const out = await spawn();

    const warn = out.find((l) => l.includes("claim @oracle_pane=patchwork:head")) ?? "";
    expect(warn).toContain("%9");
    expect(warn).toContain("%40");
    expect(warn).toContain("using %9");
    expect(out.at(-1)).toContain("1 repaired");
  });

  test("down: only the WINNER (%9, lowest id) is killed — the duplicate is a live pane, left alone", async () => {
    panes = dualHead();
    const out = await down();

    expect(panes.map((p) => p.id)).toEqual(["%40"]); // %9 gone, %40 (the loser) survives
    expect(out.some((l) => l.includes("using %9"))).toBe(true);
  });

  test("ordering is the id NUMBER, not the string ('%9' < '%40' lexically is a coincidence)", async () => {
    panes = [
      { id: "%400", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd },
      { id: "%100", role: "", window: "cell-head", identity: "patchwork:head", path: headCwd },
    ];
    const out = await down();
    expect(panes.map((p) => p.id)).toEqual(["%400"]);
  });
});

describe("cell usage names the verb that replaced 'up'", () => {
  test("unknown verb 'up' → usage points at spawn", async () => {
    const { runCell } = await import("../../src/vendor/mpr-plugins/cell/index");
    const result = await runCell(["up", "testco"], () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'up' was replaced by 'spawn'");
  });
});
