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
 * The design under test: the oracle's own pane IS the head. Spawn stamps it from
 * OUTSIDE (`set-option -p`, which no process in the pane can even observe) and
 * adds a worker + reviewer beside it. It never wakes, adopts, renames, relaunches
 * or kills a head, and it never sends a keystroke anywhere.
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

/**
 * `window` is the tmux window NAME and `index` its window_index — kept apart on
 * purpose. Conflating them is kobo-822 F1: spawn matched the head's window by
 * name against `findWindow`'s answer, which is `session:INDEX` on every path, so
 * it compared `'patchwork-oracle' === '0'` and refused every unstamped oracle.
 * The mock returned `sess:patchwork` — a value the real resolver cannot produce —
 * so the suite was green on a contract that does not exist. Fixture names below
 * are the fleet's real shape: window `<oracle>-oracle` at index 0.
 */
interface FakePane { id: string; role: string; window: string; index: string; identity: string; path: string }

let panes: FakePane[] = [];
let commands: string[] = [];
let nextPaneId = 0;
/** the oracle is not running — findWindow resolves nothing */
let noSession = false;
/** what `findWindow` resolves the oracle to, as a window_index */
let headWindowIndex = "0";
/** the creation call returns, but no pane appears (the kobo-822 failure itself) */
let creationVanishes = false;

// ONE mock.module for the whole file, steered by the flags above. Re-registering
// it inside a test is process-global and silently poisons every test after it.
mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);
    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}|||${p.index}`).join("\n") + "\n";
    }
    if (cmd.includes("session_path")) return `${anchor}\n`;
    // Creation calls carry the launch line as their ARGUMENT — the pane is born
    // running it. Register the pane so the post-run verification can see it.
    if (cmd.includes("new-window")) {
      if (creationVanishes) return "";
      const id = `%new-worker-${nextPaneId++}`;
      panes.push({ id, role: "", window: "cell-workers", index: "1", identity: "", path: anchor });
      return `${id}\n`;
    }
    if (cmd.includes("split-window")) {
      if (creationVanishes) return "";
      const id = `%new-reviewer-${nextPaneId++}`;
      panes.push({ id, role: "", window: "cell-workers", index: "1", identity: "", path: anchor });
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
  // The real `findWindow` answers `session:INDEX` — `find-window.ts` returns
  // `w.index` (a number) on every return path. Anything else here is a contract
  // the production resolver cannot honour.
  findWindow: () => { if (noSession) throw new Error("no window for oracle"); return `sess:${headWindowIndex}`; },
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

/** The steady state this had to work against: a live oracle pane, unstamped. */
function liveSoloOracle(): void {
  panes = [{ id: "%head", role: "", window: "patchwork-oracle", index: "0", identity: "", path: anchor }];
}

beforeEach(() => {
  commands = [];
  nextPaneId = 0;
  noSession = false;
  headWindowIndex = "0";
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

describe("cell spawn adds worker + reviewer and stamps all three (kobo-822)", () => {
  test("a live unstamped oracle pane becomes {oracle}:head, and gains a worker and a reviewer", async () => {
    const out = await spawn();

    expect(identityOf("%head")).toBe("patchwork:head");
    expect(identityOf("%new-worker-0")).toBe("patchwork:worker");
    expect(identityOf("%new-reviewer-1")).toBe("patchwork:reviewer");
    expect(out.at(-1)).toContain("1 ready, 0 incomplete, 0 not-running, 0 refused");
  });

  test("identity is a pane OPTION written from outside, never a typed line", async () => {
    await spawn();
    for (const cmd of identityCmds()) expect(cmd).toContain("set-option -p -t");
  });

  test("the head is stamped BEFORE the panes that hang off it — a nameless head routes nothing", async () => {
    await spawn();
    const headAt = commands.findIndex((c) => c.includes("@oracle_pane") && c.includes("%head"));
    const createAt = commands.findIndex((c) => c.includes("new-window"));
    expect(headAt).toBeGreaterThan(-1);
    expect(headAt).toBeLessThan(createAt);
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

  test("the ONLY write TARGETING the head pane is its identity stamp", async () => {
    await spawn();
    // `-t '%head'` — the tmux TARGET, not every command that merely mentions the
    // pane id (the worker's launch line carries CREW_COORD_PANE='%head', and the
    // reviewer's @idle_notify_pane points at it; neither writes to the head).
    const headWrites = commands.filter((c) => c.includes("-t '%head'") && !c.includes("display-message"));
    expect(headWrites).toEqual(["tmux set-option -p -t '%head' @oracle_pane 'patchwork:head'"]);
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
      { id: "%head", role: "", window: "patchwork-oracle", index: "0", identity: "patchwork:head", path: anchor },
      { id: "%w", role: "", window: "cell-workers", index: "1", identity: "patchwork:worker", path: anchor },
      { id: "%r", role: "", window: "cell-workers", index: "1", identity: "patchwork:reviewer", path: anchor },
    ];
    const out = await spawn();

    expect(commands.some((c) => c.includes("new-window") || c.includes("split-window"))).toBe(false);
    expect(out.at(-1)).toContain("1 ready");
  });

  test("worker present, reviewer missing → only the reviewer is created, split off the EXISTING worker", async () => {
    panes = [
      { id: "%head", role: "", window: "patchwork-oracle", index: "0", identity: "patchwork:head", path: anchor },
      { id: "%w", role: "", window: "cell-workers", index: "1", identity: "patchwork:worker", path: anchor },
    ];
    await spawn();

    expect(commands.some((c) => c.includes("new-window"))).toBe(false);
    expect(commands.some((c) => c.includes("split-window") && c.includes("-t '%w'"))).toBe(true);
  });
});

describe("cell spawn refuses rather than guessing which pane is the oracle (kobo-822)", () => {
  test("two unstamped panes in the oracle's window → refused, both named, nothing stamped", async () => {
    panes = [
      { id: "%a", role: "", window: "patchwork-oracle", index: "0", identity: "", path: anchor },
      { id: "%b", role: "", window: "patchwork-oracle", index: "0", identity: "", path: anchor },
    ];
    const out = await spawn();

    expect(identityCmds()).toEqual([]);
    expect(out.some((l) => l.includes("REFUSED") && l.includes("%a") && l.includes("%b"))).toBe(true);
    expect(out.at(-1)).toContain("1 refused");
  });

  test("the only pane already belongs to another oracle → never overwritten", async () => {
    panes = [{ id: "%other", role: "", window: "patchwork-oracle", index: "0", identity: "stitch:head", path: anchor }];
    const out = await spawn();

    expect(identityCmds()).toEqual([]);
    expect(out.some((l) => l.includes("REFUSED") && l.includes("stitch:head"))).toBe(true);
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
      { id: "%10", role: "", window: "patchwork-oracle", index: "0", identity: "patchwork:head", path: anchor },
      { id: "%9", role: "", window: "other", index: "3", identity: "patchwork:head", path: anchor },
    ];
    const out = await spawn();

    expect(out.some((l) => l.includes("2 panes claim") && l.includes("LEFT ALONE") && l.includes("using %9"))).toBe(true);
    expect(commands.some((c) => c.includes("-t '%9'"))).toBe(true);
    expect(commands.some((c) => c.includes("'%10'") && !c.includes("list-panes"))).toBe(false);
  });
});

/**
 * kobo-822 F1 — `findWindow` answers `session:INDEX`, so the head's window is
 * selected by window_index. The whole file exercises this now (every fixture
 * carries a realistic `<oracle>-oracle` window name that is never equal to the
 * index), and these are the cases that only this shape can express.
 */
describe("cell spawn finds the head by window INDEX, not window name (kobo-822)", () => {
  test("the oracle's window name never equals the resolved index — matching on it stamps nothing", async () => {
    // The pre-fix comparison was `'patchwork-oracle' === '0'`. The stamp landing
    // at all is the regression assertion; `%elsewhere` proves the index actually
    // narrows rather than the single-candidate case carrying it.
    panes = [
      { id: "%head", role: "", window: "patchwork-oracle", index: "0", identity: "", path: anchor },
      { id: "%elsewhere", role: "", window: "notes", index: "4", identity: "", path: anchor },
    ];
    await spawn();

    expect(identityOf("%head")).toBe("patchwork:head");
    expect(identityOf("%elsewhere")).toBe("");
  });

  test("a pane in a DIFFERENT window index is not a head candidate → refused, nothing stamped", async () => {
    headWindowIndex = "2"; // the oracle's window; the only unstamped pane is in 0
    const out = await spawn();

    expect(identityCmds()).toEqual([]);
    expect(out.some((l) => l.includes("REFUSED") && l.includes("window index 2"))).toBe(true);
  });

  /**
   * `findWindow` falls back to the session's FIRST window when no window name
   * matches the oracle, and on this fleet that can be a `cell-workers` window
   * (`14-utils-pm`, `28-bob` resolve to index 0 = a cell window). A head is never
   * in one, so the fallback must not hand it the stamp.
   */
  test("the resolved window is one cell BUILT → refused rather than stamping a worker pane as head", async () => {
    panes = [{ id: "%orphan", role: "", window: "cell-workers", index: "0", identity: "", path: anchor }];
    const out = await spawn();

    expect(identityCmds()).toEqual([]);
    expect(out.some((l) => l.includes("REFUSED") && l.includes("cell-workers"))).toBe(true);
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
      { id: "%head", role: "", window: "patchwork-oracle", index: "0", identity: "", path: anchor },
      { id: "%367", role: "", window: "cell-worker", index: "1", identity: "", path: anchor },
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
