/**
 * `maw company cell spawn` as an ADD-ON — ISOLATED SUITE (kobo-822, kobo-759).
 *
 * The bug this replaces: spawn "repaired" an oracle by typing
 * `maw company cell self-spawn …` into that oracle's existing pane. Every working
 * oracle runs `claude`, where a typed line lands as PROMPT TEXT, so the verb only
 * ever worked on idle shell panes — which a live fleet does not have. `cell spawn
 * pgw` reported `1 ready · 0 repaired · 10 refused` and changed nothing: unstamped
 * panes 9 → 9, panes 15 → 15, and the feeder then reported
 * `routing=legacy panes=head:0/worker:0/reviewer:0` for every oracle.
 *
 * The design under test: the oracle's own pane IS the head, and cell does not
 * touch it AT ALL — `wake` stamps it when it launches the agent (`stampWakePane`
 * in wake-cmd.ts), cell only READS that stamp to find it. Spawn adds a worker and
 * a reviewer beside it. It never wakes, adopts, renames, relaunches or kills a
 * head, and it never sends a keystroke anywhere.
 *
 * An unstamped head is REFUSED, not resolved. Spawn used to guess ("the one
 * unclaimed pane in the oracle's window") and got it wrong for every oracle for a
 * whole round of review; the guess is deleted rather than corrected, because a
 * guess that lands wrong hands one oracle's pane to another and nothing
 * downstream questions it. `maw wake <oracle>` is the answer, and spawn says so.
 *
 * Why isolated: spawn shells through maw-js/sdk hostExec for tmux and Bun's
 * mock.module is process-global. No test here touches a real tmux server — every
 * tmux call below is the mock (these are LIVE fleet panes in production).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "maw-cellidentity-"));
const home = join(dir, "home");
/** the oracle's repo — what `#{session_path}` answers, never this process's cwd */
const anchor = join(dir, "oracle-repo");
const stateDir = join(anchor, "ψ", "active", "cell");
const prevDataDir = process.env.MAW_DATA_DIR;
const prevHome = process.env.HOME;
const prevPane = process.env.TMUX_PANE;

process.env.MAW_DATA_DIR = dir;
process.env.HOME = home;
mkdirSync(join(dir, "companies"), { recursive: true });
// patchwork sits in dept `core`; the roster is what spawn loops over.
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));
mkdirSync(join(home, ".claude", "skills", "cell", "contracts"), { recursive: true });
for (const role of ["worker", "reviewer"]) {
  writeFileSync(join(home, ".claude", "skills", "cell", "contracts", `${role}.md`), `# ${role} {{COMPANY}} dept={{DEPT}}\n`);
}

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let nextPaneId = 0;
/** the oracle is not running — findWindow resolves nothing */
let noSession = false;
/** the creation call returns, but no pane appears (the kobo-822 failure itself) */
let creationVanishes = false;

// ONE mock.module for the whole file, steered by the flags above. Re-registering
// it inside a test is process-global and silently poisons every test after it.
mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("session_path")) return `${anchor}\n`;
    // Creation calls carry the launch line as their ARGUMENT — the pane is born
    // running it. Register the pane so the post-run verification can see it.
    if (cmd.includes("new-window")) {
      if (creationVanishes) return "";
      const id = `%new-worker-${nextPaneId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: anchor });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      if (creationVanishes) return "";
      const id = `%new-reviewer-${nextPaneId++}`;
      panes.push({ id, role: "", window: "cell-workers", identity: "", path: anchor });
      return `${id}\n`;
    }
    // The stamp is what makes a pane findable by role afterwards.
    const stamp = cmd.match(/set-option -p -t '([^']+)' @oracle_pane '([^']+)'/);
    if (stamp) {
      const pane = panes.find((p) => p.id === stamp[1]);
      if (pane) pane.identity = stamp[2]!;
      return "";
    }
    return "";
  },
  listSessions: async () => [],
  // `session:INDEX` — the shape `find-window.ts` returns. Spawn reads only the
  // session part of it now; the window half is nothing's business here.
  findWindow: () => { if (noSession) throw new Error("no window for oracle"); return "sess:0"; },
  checkBusyGuard: async () => ({ busy: false }),
}));

const { companyCellSpawn, resolveOracleDept } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  _setCompaniesDir(prevCompaniesDir);
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  rmSync(dir, { recursive: true, force: true });
});

/** A woken oracle: its own pane, carrying the stamp `wake` put there. */
function liveSoloOracle(): void {
  panes = [{ id: "%head", role: "", window: "patchwork-oracle", identity: "patchwork:head", path: anchor }];
}

beforeEach(() => {
  commands = [];
  nextPaneId = 0;
  noSession = false;
  creationVanishes = false;
  process.env.TMUX_PANE = "%invoker";
  liveSoloOracle();
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(anchor, { recursive: true });
});

async function spawn(verbose = true): Promise<string[]> {
  const out: string[] = [];
  await companyCellSpawn("testco", (line) => out.push(line), verbose);
  return out;
}

/** stamps only — the `list-panes` FORMAT string also mentions `@oracle_pane`. */
const identityCmds = () => commands.filter((c) => c.includes("set-option") && c.includes("@oracle_pane"));
const identityOf = (id: string) => panes.find((p) => p.id === id)?.identity;

describe("cell spawn adds the two panes it owns, beside a head wake stamped (kobo-822)", () => {
  test("a woken oracle gains a worker and a reviewer; the head's stamp is only READ", async () => {
    const out = await spawn();

    expect(identityOf("%new-worker-0")).toBe("patchwork:worker");
    expect(identityOf("%new-reviewer-1")).toBe("patchwork:reviewer");
    expect(identityCmds().some((c) => c.includes("%head"))).toBe(false);
    expect(out.at(-1)).toContain("1 ready, 0 incomplete, 0 not-running, 0 refused");
  });

  test("identity is a pane OPTION written from outside, never a typed line", async () => {
    await spawn();
    for (const cmd of identityCmds()) expect(cmd).toContain("set-option -p -t");
  });
});

/**
 * The forbidden list, asserted rather than described. Each of these is a way the
 * old spawn reached into a pane that had a live agent in it.
 */
describe("cell spawn never touches the running process in the head pane (kobo-822)", () => {
  test("no send-keys is issued, to any target, ever", async () => {
    await spawn();
    expect(commands.some((c) => c.includes("send-keys"))).toBe(false);
  });

  test("the head's window is not renamed and the head pane is not killed", async () => {
    await spawn();
    expect(commands.some((c) => c.includes("rename-window"))).toBe(false);
    expect(commands.some((c) => c.includes("kill-pane") || c.includes("kill-window"))).toBe(false);
  });

  test("NO write targets the head pane at all — not even its identity stamp", async () => {
    await spawn();
    // `-t '%head'` — the tmux TARGET, not every command that merely mentions the
    // pane id (the worker's launch line carries CREW_COORD_PANE='%head', and the
    // reviewer's @idle_notify_pane points at it; neither writes to the head).
    const headWrites = commands.filter((c) => c.includes("-t '%head'") && !c.includes("display-message"));
    expect(headWrites).toEqual([]);
  });

  test("no head contract is written — the feeder routes by role, nothing goes through the head", async () => {
    await spawn();
    expect(existsSync(join(stateDir, "head-contract.md"))).toBe(false);
    expect(existsSync(join(stateDir, "head.md"))).toBe(false);
    expect(commands.some((c) => c.includes("CREW_ROLE=head"))).toBe(false);
  });
});

describe("cell spawn does not wake (kobo-822)", () => {
  test("an oracle with no session is reported, not woken", async () => {
    noSession = true;
    const out = await spawn();

    expect(out.some((l) => l.includes("never wakes one") && l.includes("maw wake patchwork"))).toBe(true);
    expect(out.at(-1)).toContain("0 ready, 0 incomplete, 1 not-running");
    // and no pane was created anywhere while the oracle was down
    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
  });
});

describe("cell spawn is idempotent and per-role (kobo-822)", () => {
  test("a cell already up creates nothing — no all-three-or-rebuild", async () => {
    panes = [
      { id: "%head", role: "", window: "patchwork-oracle", identity: "patchwork:head", path: anchor },
      { id: "%w", role: "", window: "cell-workers", identity: "patchwork:worker", path: anchor },
      { id: "%r", role: "", window: "cell-workers", identity: "patchwork:reviewer", path: anchor },
    ];
    const out = await spawn();

    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
    expect(out.at(-1)).toContain("1 ready");
  });

  test("worker present, reviewer missing → only the reviewer is created, split off the EXISTING worker", async () => {
    panes = [
      { id: "%head", role: "", window: "patchwork-oracle", identity: "patchwork:head", path: anchor },
      { id: "%w", role: "", window: "cell-workers", identity: "patchwork:worker", path: anchor },
    ];
    await spawn();

    expect(commands.some((c) => c.includes("new-window"))).toBe(false);
    expect(commands.some((c) => c.includes("split-window") && c.includes("-t '%w'"))).toBe(true);
  });
});

/**
 * Spawn does not decide which pane an oracle is. `wake` stamps the head when it
 * launches the agent; an unstamped head means the oracle has been running since
 * before kobo-759, and the fix is to re-wake it — which the refusal says, because
 * a message that leaves the reader to work that out is a message that gets
 * ignored. The guess this replaces ("the one unclaimed pane in its window") never
 * matched a single oracle.
 */
describe("cell spawn refuses an unstamped head instead of picking one (kobo-822)", () => {
  test("no {oracle}:head anywhere → REFUSED, nothing stamped, and it names `maw wake`", async () => {
    panes = [{ id: "%maybe", role: "", window: "patchwork-oracle", identity: "", path: anchor }];
    const out = await spawn();

    expect(identityCmds()).toEqual([]);
    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
    expect(out.some((l) => l.includes("REFUSED") && l.includes("maw wake patchwork"))).toBe(true);
    expect(out.at(-1)).toContain("1 refused");
  });

  test("a lone unstamped pane is not promoted just because it is the only candidate", async () => {
    panes = [{ id: "%solo", role: "", window: "patchwork-oracle", identity: "", path: anchor }];
    await spawn();

    expect(identityOf("%solo")).toBe("");
  });

  test("another oracle's head in this session is neither used nor overwritten", async () => {
    panes = [{ id: "%other", role: "", window: "patchwork-oracle", identity: "stitch:head", path: anchor }];
    const out = await spawn();

    expect(identityCmds()).toEqual([]);
    expect(identityOf("%other")).toBe("stitch:head");
    expect(out.some((l) => l.includes("REFUSED"))).toBe(true);
  });

  /**
   * kobo-782 — there is a real one of these on the fleet (`23-worker1` has two
   * panes both stamped `worker1:head`). A duplicate is a LIVE agent in someone
   * else's session: name it, use the oldest, touch nothing.
   */
  /**
   * `%9` and `%10` on purpose: lowest pane id means NUMERICALLY lowest, and tmux
   * hands out `%N` monotonically, so `%9` is the older pane. Compared as strings
   * `"%10" < "%9"`, and the winner flips to the newer pane — which is why
   * `paneIdNum` exists. This is the assertion that pins it (the pair it had,
   * `%3`/`%9`, sorts the same either way and pinned nothing).
   */
  test("duplicate {oracle}:head → lowest pane id wins NUMERICALLY, the other is named and left alone", async () => {
    panes = [
      { id: "%10", role: "", window: "patchwork-oracle", identity: "patchwork:head", path: anchor },
      { id: "%9", role: "", window: "other", identity: "patchwork:head", path: anchor },
    ];
    const out = await spawn();

    expect(out.some((l) => l.includes("2 panes claim") && l.includes("LEFT ALONE") && l.includes("using %9"))).toBe(true);
    expect(commands.some((c) => c.includes("-t '%9'"))).toBe(true);
    expect(commands.some((c) => c.includes("'%10'") && !c.includes("list-panes"))).toBe(false);
  });
});

/**
 * kobo-822 F2 — a pane cell created whose stamp never landed is invisible to
 * `rolePanesOf` and `isTeardownTarget` alike (both key on `@oracle_pane` only),
 * so spawn builds a second worker beside it and down never removes it. Real ones:
 * `09-repo-architect` `%367`/`%370`.
 */
describe("cell spawn names panes whose stamp never landed (kobo-822)", () => {
  test("an unstamped pane in a cell window is reported by pane id, with the tmux line that fixes it", async () => {
    panes = [
      { id: "%head", role: "", window: "patchwork-oracle", identity: "patchwork:head", path: anchor },
      { id: "%367", role: "", window: "cell-worker", identity: "", path: anchor },
    ];
    const out = await spawn();

    expect(out.some((l) => l.includes("%367") && l.includes("cell-worker") && l.includes("set-option -p -t"))).toBe(true);
    // it is named, never adopted: cell still keys on the option alone
    expect(identityOf("%367")).toBe("");
    expect(commands.some((c) => c.includes("new-window"))).toBe(true);
  });

  test("silent when every cell pane carries its identity", async () => {
    const out = await spawn();
    expect(out.some((l) => l.includes("carry no @oracle_pane"))).toBe(false);
  });
});

describe("cell spawn anchors every oracle on ITS OWN repo and dept (kobo-780, kobo-822)", () => {
  test("contracts are written under #{session_path}, not this process's cwd", async () => {
    await spawn();
    expect(existsSync(join(stateDir, "worker-contract.md"))).toBe(true);
    expect(existsSync(join(stateDir, "reviewer-contract.md"))).toBe(true);
  });

  test("the launch line cd's into the oracle's repo and gates on a non-empty contract", async () => {
    await spawn();
    const launch = commands.find((c) => c.includes("new-window")) ?? "";
    expect(launch).toContain("cd ");
    expect(launch).toContain(anchor);
    expect(launch).toContain("if test -s ");
    expect(launch).toContain(join(stateDir, "worker-contract.md"));
    expect(launch).toContain("--append-system-prompt");
    // the model ladder is the pane's own `||`, not a maw-side boot poll + respawn
    expect(launch).toContain("|| MAW_ROOM_COMPANY");
  });

  /**
   * The bug a from-outside spawn invents if `-t` is left off: `new-window` lands
   * in the CALLER's session, so eleven oracles' panes get built in whichever
   * session the human happened to be sitting in.
   */
  test("the worker window is created in the ORACLE's session, never the caller's", async () => {
    await spawn();
    expect(commands.some((c) => c.includes("new-window") && c.includes("-t 'sess:'"))).toBe(true);
  });

  /**
   * The `self = selfOracleId()` bug in miniature: one process looping the roster
   * resolved the CALLER's dept and rendered it into every oracle's contract.
   */
  test("the contract carries the ROSTER member's dept, not the caller's identity", async () => {
    delete process.env.CLAUDE_AGENT_NAME;
    await spawn();
    expect(readFileSync(join(stateDir, "worker-contract.md"), "utf8")).toContain("dept=core");
  });

  test("resolveOracleDept answers per oracle, and never blank", () => {
    expect(resolveOracleDept("patchwork")).toBe("core");
    expect(resolveOracleDept("some-unknown-oracle")).toBe("(none)");
    expect(resolveOracleDept("")).toBe("(none)");
  });
});

describe("the summary counts panes tmux actually has (kobo-822)", () => {
  test("creation that produces no pane → INCOMPLETE, never 'ready'", async () => {
    // The failure that started kobo-822: the call returns, nothing appears, and
    // the summary said `1 ready` anyway. The count comes from re-reading tmux.
    creationVanishes = true;
    const out = await spawn();

    expect(out.some((l) => l.includes("INCOMPLETE") && l.includes("patchwork:worker"))).toBe(true);
    expect(out.at(-1)).toContain("0 ready, 1 incomplete");
  });
});
