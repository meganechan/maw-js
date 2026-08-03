/**
 * cell spawn: the supported route for a pane that is already running claude —
 * ISOLATED SUITE (kobo-776).
 *
 * Every oracle's steady state is a pane running claude, and 5371b28e (correctly)
 * forbids typing a shell line into one. That left no sanctioned route at all, so
 * bringing up a roster meant a human relaying `maw company cell self-spawn` by
 * hand, eleven times.
 *
 * Such a pane is not unreachable — it is reachable on a different channel. Spawn
 * now ASKS it, over `maw hey`, and counts that as its own outcome: handed-off,
 * never `repaired` (nothing has observed a cell come up) and never `refused`
 * (something was delivered).
 *
 * The prompt content is asserted verbatim, not by keyword: the reader is an agent
 * that will copy the command into its own Bash. An instruction that does not run
 * as written is not an instruction.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec and Bun's mock.module is
 * process-global. No test here touches a real tmux server or sends a real `maw
 * hey` — every call below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellhandoff-"));
const prevDataDir = process.env.MAW_DATA_DIR;
const prevPoll = process.env.CELL_SPAWN_POLL_MS;

process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));

let commands: string[] = [];
/** what the mocked `#{pane_current_command}` probe answers */
let paneCommand = "claude";
/** the pane's `session:window.pane` address, or "" for a pane tmux cannot address */
let paneAddr = "42-patchwork:0.1";
let heyThrows = false;

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.startsWith("maw hey")) {
      if (heyThrows) throw new Error("no route to target");
      return "";
    }
    if (cmd.includes("pane_current_command")) return `${paneCommand}\n`;
    if (cmd.includes("session_name")) return `${paneAddr}\n`;
    if (cmd.includes("capture-pane")) return "bypass permissions\n";
    if (cmd.includes("tmux list-panes")) return "%head|||👤 head|||cell-head|||patchwork:head|||/tmp\n";
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "42-patchwork:0",
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
  if (prevPoll === undefined) delete process.env.CELL_SPAWN_POLL_MS; else process.env.CELL_SPAWN_POLL_MS = prevPoll;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  commands = [];
  paneCommand = "claude";
  paneAddr = "42-patchwork:0.1";
  heyThrows = false;
  process.env.CELL_SPAWN_POLL_MS = "1";
});

async function spawn(verbose = true): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), verbose);
  return out;
}

const heyCall = () => commands.find((c) => c.startsWith("maw hey")) ?? "";
/** the message as the receiving agent will read it, un-shell-escaped */
const heyMessage = () => {
  const m = /^maw hey '[^']*' '(.*)'$/s.exec(heyCall());
  if (!m) throw new Error(`no hey was sent: ${heyCall() || "(none)"}`);
  return m[1]!.replaceAll("'\\''", "'");
};

describe("a claude-occupied pane is asked, not abandoned (kobo-776)", () => {
  test("handed-off is counted, refused is not, and the pane is named", async () => {
    const out = await spawn();

    const summary = out.at(-1) ?? "";
    expect(summary).toContain("1 handed-off");
    expect(summary).toContain("0 refused/failed");
    expect(summary).toContain("0 repaired");
    expect(out.some((l) => l.includes("HANDED OFF") && l.includes("%head"))).toBe(true);
  });

  test("the handoff line is not hidden behind --verbose", async () => {
    const out = await spawn(false);
    expect(out.some((l) => l.includes("HANDED OFF"))).toBe(true);
  });

  test("delivery is a federation message to the pane's own address — not a keystroke", async () => {
    await spawn();
    expect(heyCall()).toStartWith("maw hey '42-patchwork:0.1' ");
    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);
  });

  test("the message carries the self-spawn command EXACTLY as it must be run", async () => {
    await spawn();
    // Not a keyword check: this substring is what the agent copies into Bash.
    expect(heyMessage()).toContain("maw company cell self-spawn testco");
    // and no shell chaining leaked in from the inject path — the agent runs one
    // command, it does not launch a second claude on top of itself
    expect(heyMessage()).not.toContain("--append-system-prompt \"$(cat");
    expect(heyMessage()).not.toContain("&&");
  });

  test("the message says to read the contract FILE, with the path spelled out", async () => {
    await spawn();
    expect(heyMessage()).toContain("ψ/active/cell/head-contract.md");
  });

  test("the message states WHY the file is the only channel — the caveat, not just the instruction", async () => {
    await spawn();
    const msg = heyMessage();
    expect(msg).toContain("CAVEAT");
    expect(msg).toContain("already running");
    expect(msg).toContain("could NOT be appended to your system prompt");
  });

  test("the message forbids the two things an agent might otherwise do to itself", async () => {
    await spawn();
    expect(heyMessage()).toContain("Do not restart yourself");
    expect(heyMessage()).toContain("do not kill this pane");
  });

  test("it is ONE line — a multi-line send reads as a paste and can arrive mangled", async () => {
    await spawn();
    expect(heyMessage()).not.toContain("\n");
  });
});

describe("handed-off is not a synonym for refused, and not for done (kobo-776)", () => {
  test("no head-boot poll runs for a handoff — nothing here observed a cell come up", async () => {
    await spawn();
    expect(commands.some((c) => c.includes("capture-pane"))).toBe(false);
  });

  test("tmux cannot address the pane → refused, and no message is sent blind", async () => {
    paneAddr = "";
    const out = await spawn();

    expect(commands.some((c) => c.startsWith("maw hey"))).toBe(false);
    expect(out.at(-1)).toContain("1 refused/failed");
    expect(out.at(-1)).toContain("0 handed-off");
    expect(out.some((l) => l.includes("cannot resolve a hey address"))).toBe(true);
  });

  test("the send itself fails → refused, and the reason names the address it tried", async () => {
    heyThrows = true;
    const out = await spawn();

    expect(out.at(-1)).toContain("1 refused/failed");
    expect(out.at(-1)).toContain("0 handed-off");
    expect(out.some((l) => l.includes("handoff") && l.includes("FAILED") && l.includes("42-patchwork:0.1"))).toBe(true);
  });

  test("REGRESSION: a shell pane still gets the typed repair, not a message", async () => {
    paneCommand = "zsh";
    const out = await spawn();

    expect(commands.some((c) => c.startsWith("maw hey"))).toBe(false);
    expect(commands.some((c) => c.includes("send-keys") && c.includes("cell self-spawn testco"))).toBe(true);
    expect(out.at(-1)).toContain("1 repaired");
    expect(out.at(-1)).toContain("0 handed-off");
  });
});
