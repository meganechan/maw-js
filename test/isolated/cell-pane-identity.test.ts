/**
 * Cell pane identity — ISOLATED SUITE (kobo-759, updated kobo-822).
 *
 * `maw company cell spawn <company>` is three pane births, but no longer one
 * call running inside the target pane: head identity now comes from `cmdWake`
 * (kobo-777's in-place stamp on an already-live pane, or a fresh pane when the
 * oracle was genuinely asleep — this suite's fixture stands in for that, wake
 * itself is tested in wake-cmd's own suites). Worker is a fresh `new-window`,
 * reviewer a fresh `split-window`, both issued from OUTSIDE by `spawn` itself.
 * Each pane born this way must carry `@oracle_pane = "{name}:{role}"` — the
 * option, not the pane title, because the title is decoration anything can
 * overwrite.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server —
 * every tmux call below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellidentity-"));
const home = join(dir, "home");
const repo = join(dir, "repo");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevPoll = process.env.CELL_SPAWN_POLL_MS;

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));
// contract assets spawn refuses to run without
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["head", "worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`), `# ${role} {{COMPANY}}\n`);
}
mkdirSync(repo, { recursive: true });

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let nextId = 100;
/** unset to prove an unresolvable oracle name writes no option, ever */
let agentName: string | undefined = "patchwork";

const paneOf = (id: string) => panes.find((p) => p.id === id);
const arg = (cmd: string, re: RegExp) => re.exec(cmd)?.[1] ?? "";

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("new-window")) {
      const id = "%worker";
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: repo });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      const id = "%reviewer";
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
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    if (cmd.includes("display-message")) return `${repo}\n`; // session_path anchor
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:win",
  // kobo-822 fixture: the head pane already exists (adopted, live) and already
  // carries its identity by the time spawn asks — this suite is about what
  // spawn stamps on the panes IT creates (worker, reviewer), not about wake.
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
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  nextId = 100;
  agentName = "patchwork";
  if (agentName) process.env.CLAUDE_AGENT_NAME = agentName; else delete process.env.CLAUDE_AGENT_NAME;
  process.env.TMUX = ""; // no fallback via a live tmux session name
  process.env.CELL_SPAWN_POLL_MS = "1";
  // head already adopted+identified, exactly what wake leaves behind
  panes = [{ id: "%head", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: repo }];
});

async function spawn(): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), true);
  return out;
}

// "set-option", not just "@oracle_pane": the list-panes format string also
// mentions the option name (`#{@oracle_pane}`), which is a READ, not a write.
const identityCmds = () => commands.filter((c) => c.includes("set-option") && c.includes("@oracle_pane"));

describe("cell spawn stamps @oracle_pane on every pane it births (kobo-759, kobo-822)", () => {
  test("worker (new-window) and reviewer (split-window) each get {name}:{role}", async () => {
    const out = await spawn();
    expect(out.at(-1)).toContain("1 repaired");

    expect(identityCmds()).toEqual([
      `tmux set-option -p -t '%worker' @oracle_pane 'patchwork:worker'`,
      `tmux set-option -p -t '%reviewer' @oracle_pane 'patchwork:reviewer'`,
    ]);
  });

  test("stamped BEFORE the pane is handed its title", async () => {
    await spawn();
    const stampAt = commands.findIndex((c) => c.includes("@oracle_pane") && c.includes("%worker"));
    const titleAt = commands.findIndex((c) => c.includes("select-pane") && c.includes("worker"));
    expect(stampAt).toBeGreaterThan(-1);
    expect(stampAt).toBeLessThan(titleAt);
  });

  test("identity is a pane OPTION, never inferred from the pane title", async () => {
    await spawn();
    expect(commands.some((c) => c.includes("select-pane") && c.includes("-T"))).toBe(true);
    for (const cmd of identityCmds()) expect(cmd).toContain("set-option -p -t");
  });

  test("unresolvable oracle name → NO option is written for the new panes, and the gap is announced (never guessed)", async () => {
    delete process.env.CLAUDE_AGENT_NAME;
    const out = await spawn();
    expect(identityCmds()).toEqual([]);
    expect(out.filter((l) => l.includes("pane identity not set"))).toHaveLength(2);
  });

  test("never a keystroke: identity, contracts and worker/reviewer are all built from outside", async () => {
    await spawn();
    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);
  });
});
