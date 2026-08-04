/**
 * `cell spawn` on a LIVE fleet: an oracle whose only pane is already running
 * claude, unstamped — ISOLATED SUITE (kobo-822).
 *
 * The bug this proves fixed: the old spawn loop only called `cmdWake` when
 * `resolveMemberSession` found NO session at all. An oracle that is already
 * awake — every oracle in a live fleet, by definition — skipped wake entirely,
 * fell through to the injection path, and 5371b28e's guard (correctly) refused
 * to type into a pane running claude. The guard was never wrong; nothing
 * upstream of it ever gave the pane a `@oracle_pane` identity, so the cell
 * could never be completed without a human relaying a command by hand.
 *
 * kobo-822's fix: `cmdWake` is now the PRIMARY path, called for every roster
 * member unconditionally. In production that is what lets kobo-777's
 * `stampLiveSoloPane` name an already-live pane `{oracle}:head` in place (a
 * `tmux set-option` issued from OUTSIDE the pane). This suite's fake `cmdWake`
 * mocks exactly that effect — it stamps the sole unidentified pane in the
 * oracle's session, mirroring what the real wake does — so the assertions
 * below are about what `companyCellSpawn` does AFTER identity exists, which is
 * the part this ticket owns: build the missing worker+reviewer from OUTSIDE,
 * never by typing into the (still running) claude pane.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec and Bun's mock.module
 * is process-global. No test here touches a real tmux server — every tmux call
 * below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-celllivepane-"));
const home = join(dir, "home");
const repo = join(dir, "repos", "patchwork-oracle");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
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
mkdirSync(repo, { recursive: true });

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

const SESSION = "42-patchwork";
let panes: FakePane[] = [];
let commands: string[] = [];
let nextPaneId = 100;

const paneOf = (id: string) => panes.find((p) => p.id === id);
const arg = (cmd: string, re: RegExp) => re.exec(cmd)?.[1] ?? "";

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);

    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("new-window")) {
      const id = `%worker${nextPaneId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: repo });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      const id = `%reviewer${nextPaneId++}`;
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
    if (cmd.includes("rename-window")) {
      const p = paneOf(arg(cmd, /rename-window -t '([^']+)'/));
      if (p) p.window = arg(cmd, /rename-window -t '[^']+' '([^']*)'/);
      return "";
    }
    if (cmd.includes("display-message")) {
      if (cmd.includes("session_path")) return `${repo}\n`;
      if (cmd.includes("pane_current_command")) return "claude\n";
      return `${SESSION}\n`;
    }
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    return "";
  },
  listSessions: async () => [],
  findWindow: () => `${SESSION}:0`,
  // kobo-822 fixture: mirrors kobo-777's `stampLiveSoloPane` — the SOLE
  // unidentified pane in the oracle's session gets stamped `{oracle}:head`,
  // from outside, no keystroke sent. This is the behaviour spawn now depends
  // on cmdWake for; this suite is not re-testing wake itself (that lives in
  // wake-cmd's own suites), only that spawn calls it unconditionally and
  // builds on top of what it leaves behind.
  cmdWake: async (oracle: string) => {
    const unidentified = panes.filter((p) => !p.identity);
    if (unidentified.length === 1) unidentified[0]!.identity = `${oracle}:head`;
  },
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
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  nextPaneId = 100;
  // The exact shape that was stuck on the live fleet: one pane, running claude,
  // never stamped. No @role either — this was never adopted by the old
  // self-spawn, it is just the oracle's own steady-state pane.
  panes = [{ id: "%live", role: "", window: "patchwork", identity: "", path: repo }];
  process.env.CELL_SPAWN_POLL_MS = "1";
});

async function spawn(): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  return out;
}

describe("cell spawn completes a live, already-awake oracle's cell (kobo-822)", () => {
  test("head gets identified via wake, worker+reviewer are built from outside, and NOTHING is typed into the live pane", async () => {
    const out = await spawn();

    // The guard this ticket must never weaken: no send-keys to ANY pane, ever.
    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);

    // Wake gave %live its identity (the fixture's stand-in for kobo-777) —
    // spawn built on top of that instead of trying to adopt/inject.
    expect(paneOf("%live")!.identity).toBe("patchwork:head");

    // Worker + reviewer exist now, created from OUTSIDE (new-window / split-window
    // carry the launch command as their own argument, never a follow-up send-keys).
    expect(commands.some((c) => c.includes("tmux new-window") && c.includes("cell-workers"))).toBe(true);
    expect(commands.some((c) => c.includes("split-window"))).toBe(true);
    expect(panes.filter((p) => p.identity.endsWith(":worker"))).toHaveLength(1);
    expect(panes.filter((p) => p.identity.endsWith(":reviewer"))).toHaveLength(1);

    const summary = out.at(-1) ?? "";
    expect(summary).toContain("1 repaired");
    expect(summary).toContain("0 refused/failed");
  });

  test("a second spawn is a no-op — cell reads ready, nothing new is built", async () => {
    await spawn();
    commands = [];
    const out = await spawn();

    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
    expect(out.at(-1)).toContain("1 ready, 0 repaired");
  });
});
