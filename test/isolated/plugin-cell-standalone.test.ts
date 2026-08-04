import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const spawnPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts");
const indexPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/index.ts");

/**
 * Source with comments removed. The forbidden-list pins below are about what the
 * code DOES, and the comments explaining why `send-keys` is gone naturally
 * contain the word `send-keys` — grepping the raw file makes the explanation
 * fail the rule it explains, which is how a pin ends up deleted instead of fixed.
 */
function codeOnly(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("cell command plugin standalone boundary", () => {
  test("cell keeps explicit import boundaries (SDK + core/worklog/company-scope)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "cell",
      // core/pane-identity (kobo-759) is dependency-free by design — the whole
      // reason it exists as its own module is that plugins/hooks can reach the
      // `@oracle_pane` contract without dragging the sdk barrel into their graph.
      allowRelative: [/^(?:\.\.\/){3}core\/worklog\//, /^(?:\.\.\/){3}core\/agent-panes$/, /^(?:\.\.\/){3}core\/pane-identity$/],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("module surface only — no top-level cli.command", () => {
    const pluginSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/plugin.ts"), "utf8");
    expect(pluginSrc).not.toContain("cli:");
    expect(pluginSrc).toContain('"exports": ["runCell"]');
  });

  test("index.ts exports runCell(args, emit) and the two public verbs — self-spawn is gone", () => {
    const indexSrc = readFileSync(indexPath, "utf8");
    expect(indexSrc).toContain("export async function runCell");
    expect(indexSrc).toContain('subcmd === "spawn"');
    expect(indexSrc).toContain('subcmd === "down" || subcmd === "teardown"');
    expect(indexSrc).toContain("companyCellSpawn");
    expect(indexSrc).toContain("companyCellDown");
    // kobo-822 — the verb is retired, but it stays NAMED so an operator running it
    // from muscle memory is told what replaced it instead of getting bare usage.
    expect(indexSrc).not.toContain("cellSelfSpawn");
    expect(indexSrc).toContain("no longer types anything into a pane");
  });

  /**
   * kobo-822 — the FORBIDDEN list, pinned at the source.
   *
   * `cell spawn pgw` reported `1 ready · 0 repaired · 10 refused` and changed
   * nothing, because "repair" meant typing `maw company cell self-spawn …` into
   * the oracle's own pane — and every working oracle runs `claude`, where a typed
   * line lands as prompt text. The guard is not a better classifier for that send;
   * it is that there is no send. These greps fail the moment one comes back.
   */
  test("nothing in the cell plugin can type into, rename, relaunch or kill a head pane", () => {
    const spawnCode = codeOnly(spawnPath);
    const indexCode = codeOnly(indexPath);
    for (const code of [spawnCode, indexCode]) {
      expect(code).not.toContain("send-keys");
      expect(code).not.toContain("injectCommand");
      expect(code).not.toContain("cellSelfSpawn");
      expect(code).not.toContain("rename-window");
      expect(code).not.toContain("headLaunchCommand");
      expect(code).not.toContain("standDownHead");
      expect(code).not.toContain("head-contract");
      expect(code).not.toContain("CREW_ROLE=head");
      expect(code).not.toContain("teardownCrewWindows");
    }
    // and wake is not reachable from here at all — bringing an oracle up is
    // `wake`'s job, and spawn calling it is how this verb could relaunch an
    // oracle out from under itself.
    expect(spawnCode).not.toContain("cmdWake");
    const sdkImport = /import \{([^}]*)\} from "maw-js\/sdk"/.exec(spawnCode)?.[1] ?? "";
    expect(sdkImport).not.toBe("");
    expect(sdkImport).not.toContain("cmdWake");
  });

  test("spawn adds worker+reviewer to a running oracle and stamps all three by identity", () => {
    const spawnSrc = readFileSync(spawnPath, "utf8");
    expect(spawnSrc).toContain("export async function companyCellSpawn");
    expect(spawnSrc).toContain('CELL_WORKERS_WINDOW = "cell-workers"');
    expect(spawnSrc).toContain('const CELL_ROLES = ["worker", "reviewer"] as const');
    expect(spawnSrc).toContain("companyRoster");
    expect(spawnSrc).toContain("listSessions");
    expect(spawnSrc).toContain("findWindow");
    // kobo-759 — every pane carries `@oracle_pane`, head included: without the
    // head stamp the feeder resolves nothing and reports
    // `routing=legacy panes=head:0/worker:0/reviewer:0` for the oracle.
    // (Behaviour proven in test/isolated/cell-pane-identity.test.ts.)
    expect(spawnSrc).toContain('stampCellPane(headPane, member.oracle, "head", emit)');
    expect(spawnSrc).toContain("stampPaneIdentity");
    expect(spawnSrc).toContain("export function resolveOracleDept(oracle: string)");
    // the -t is what keeps eleven oracles' panes out of the caller's session
    expect(spawnSrc).toContain("tmux new-window -d -t ${shellArg(`${sessionName}:`)}");
    expect(spawnSrc).toContain("split-window -h -p 50 -t ${shellArg(workerPaneId)}");
    expect(spawnSrc).toContain("-P -F '#{pane_id}'");
    // kobo-780 — one anchor resolver, from #{session_path}, never process.cwd()
    expect(spawnSrc).toContain("'#{session_path}'");

    // Negatives read the CODE: the comments explaining why each of these is gone
    // name them, and a pin that its own rationale fails gets deleted, not fixed.
    // PR #443's bug: `selfOracleId()` reads the CALLER's identity, so one process
    // looping the roster stamps everyone's panes with the caller's name — and on a
    // machine with no tmux it returns "" and nothing is stamped at all.
    const spawnCode = codeOnly(spawnPath);
    expect(spawnCode).not.toContain("selfOracleId");
    expect(spawnCode).not.toContain("resolveSelfDept");
    expect(spawnCode).not.toContain("process.cwd()");
    expect(spawnCode).not.toContain("process.env.CREW_STATE_DIR");
  });

  /**
   * kobo-822 — presence is per ROLE, not all-three-or-rebuild. The old
   * `isReady = head && worker && reviewer` meant one missing pane rebuilt the
   * whole cell, which is what made "repair" reach for the head at all.
   */
  test("spawn adds only the roles that are missing, and counts from a fresh tmux read", () => {
    const spawnSrc = readFileSync(spawnPath, "utf8");
    expect(spawnSrc).toContain("const have = rolePanesOf(panes, member.oracle);");
    expect(spawnSrc).toContain("if (!worker) {");
    expect(spawnSrc).toContain("if (!reviewer) {");
    // the summary is read back off the server, never assembled from intentions
    expect(spawnSrc).toContain("const after = rolePanesOf(await listSessionPanes(sessionName), member.oracle);");
    expect(spawnSrc).toContain("const missing = CELL_ROLES.filter((r) => !after.has(r));");
    expect(spawnSrc).toContain("${ready} ready, ${partial} incomplete, ${asleep} not-running, ${refused} refused");
  });

  test("spawn refuses rather than guessing which pane is the oracle", () => {
    const spawnSrc = readFileSync(spawnPath, "utf8");
    expect(spawnSrc).toContain("function resolveHeadPane(");
    expect(spawnSrc).toContain("if (unclaimed.length === 1) return { pane: unclaimed[0], duplicates: [] };");
    expect(spawnSrc).toContain("refusing to overwrite one");
    expect(spawnSrc).toContain("cannot say which one is the oracle");
  });

  test("down kills this oracle's worker+reviewer by identity and leaves every head alive", () => {
    const spawnSrc = readFileSync(spawnPath, "utf8");
    expect(spawnSrc).toContain("export async function companyCellDown");
    expect(spawnSrc).toContain("usage: maw company cell down <company> [--force] [--verbose|--full]");
    expect(spawnSrc).toContain("checkBusyGuard");
    expect(spawnSrc).toContain("refusing cell teardown");
    expect(spawnSrc).toContain("tmux kill-pane -t ${shellArg(pane.paneId)}");
    expect(spawnSrc).toContain("✓ cell down");
    // kobo-764 — teardown selects on the @oracle_pane identity ONLY: no emoji
    // @role, no window name (behaviour proven in cell-down-identity.test.ts).
    expect(spawnSrc).toContain("isTeardownTarget(p, member.oracle)");
    expect(spawnSrc).toContain("(CELL_ROLES as readonly string[]).includes(id.role)");
    // kobo-782 — a duplicate `{oracle}:head` can be a live agent in someone else's
    // session. Only the pane findHeadPane RESOLVES is ever acted on; the losers
    // are named and left completely alone.
    expect(spawnSrc).toContain("const { pane: headPane, duplicates } = findHeadPane(panes, member.oracle);");
    expect(spawnSrc).toContain("LEFT ALONE");
    expect(spawnSrc).toContain("cell teardown PARTIAL");
    expect(spawnSrc).toContain("ALIVE and still stamped");
  });

  test("company/index.ts wires `cell` to runCell", () => {
    const companyIndexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"), "utf8");
    expect(companyIndexSrc).toContain('from "../cell/index"');
    expect(companyIndexSrc).toContain("runCell");
    expect(companyIndexSrc).toContain('=== "cell"');
    expect(companyIndexSrc).toContain("|cell|");
  });
});
