import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

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

  test("index.ts exports runCell(args, emit), public spawn/down, and hidden self-spawn", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/index.ts"), "utf8");
    expect(indexSrc).toContain("export async function runCell");
    expect(indexSrc).toContain('subcmd === "spawn"');
    expect(indexSrc).toContain('subcmd === "down" || subcmd === "teardown"');
    expect(indexSrc).toContain('subcmd === "self-spawn"');
    expect(indexSrc).toContain("companyCellSpawn");
    expect(indexSrc).toContain("companyCellDown");
    expect(indexSrc).toContain("cellSelfSpawn");
  });

  test("spawn.ts implements company/oracle Cell v2: wake roster, then local head|reviewer/worker", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("checkBusyGuard");
    expect(spawnSrc).toContain('CELL_WORKERS_WINDOW = "cell-workers"');
    expect(spawnSrc).toContain("cmdWake");
    expect(spawnSrc).toContain("noAttach: true");
    expect(spawnSrc).toContain("noRehydrate: true");
    expect(spawnSrc).toContain("listSessions");
    expect(spawnSrc).toContain("findWindow");
    expect(spawnSrc).toContain("companyRoster");
    expect(spawnSrc).toContain("maw company cell self-spawn");
    expect(spawnSrc).toContain("headLaunchCommand(company)");
    expect(spawnSrc).toContain("head-contract.md");
    expect(spawnSrc).toContain("CREW_ROLE=head");
    // kobo-765 — the head launch line is a guarded shell chain, no longer `exec
    // claude`: `exec` replaced the pane's shell, so a boot failure killed the pane
    // outright and no fallback could ever land. B5: it will not start head at all
    // unless the contract file is non-empty. B7: BRAIN_MODEL → DEFAULT_WORKER_MODEL
    // in-pane. (Behaviour — including the expanded system prompt — is proven by
    // RUNNING the line in test/isolated/cell-spawn-state-dir.test.ts.)
    expect(spawnSrc).toContain("if test -s ${shellArg(contract)}; then");
    expect(spawnSrc).toContain("${claude(BRAIN_MODEL)} || ${claude(DEFAULT_WORKER_MODEL)}");
    // kobo-765/B5 — ONE derivation point for the state dir: the pane's inherited
    // env is never read, in either the writer or the launch line.
    expect(spawnSrc).toContain("const stateDir = DEFAULT_STATE_DIR;");
    expect(spawnSrc).not.toContain("process.env.CREW_STATE_DIR");
    // kobo-765/B7 — a landed injection is not a repair until head boots
    expect(spawnSrc).toContain("if (await pollHeadReady(injectTarget)) { repaired++; continue; }");
    expect(spawnSrc).toContain("head boot FAILED");
    expect(spawnSrc).toContain("${bootFailed} head-boot-failed");
    expect(spawnSrc).toContain('tmux set-option -p -t ${shellArg(head)} @role ${shellArg("👤 head")}');
    expect(spawnSrc).toContain('tmux select-pane -t ${shellArg(head)} -T ${shellArg("👤 head")}');
    expect(spawnSrc).toContain('CELL_HEAD_WINDOW = "cell-head"');
    expect(spawnSrc).toContain("tmux rename-window -t ${shellArg(head)} ${shellArg(CELL_HEAD_WINDOW)}");
    // kobo-775 — down leaves no trap: the head window's name is parked before the
    // rename and restored on stand-down (behaviour in cell-down-residue.test.ts).
    expect(spawnSrc).toContain("await rememberWindowName(head);");
    expect(spawnSrc).toContain("await restoreHeadWindowName(head, oracle);");
    expect(spawnSrc).toContain("pane-border-status top");
    expect(spawnSrc).toContain("pane-border-format");
    expect(spawnSrc).toContain("let model = BRAIN_MODEL");
    expect(spawnSrc).toContain("model = DEFAULT_WORKER_MODEL");
    expect(spawnSrc).toContain("tmux new-window");
    expect(spawnSrc).toContain("split-window -h -p 50 -t ${shellArg(worker.paneId)}");
    expect(spawnSrc).toContain('tmux select-pane -t ${shellArg(worker.paneId)} -T ${shellArg("⚒ worker")}');
    expect(spawnSrc).toContain('tmux select-pane -t ${shellArg(reviewer)} -T ${shellArg("🔎 reviewer")}');
    expect(spawnSrc).toContain('tmux set-option -p -t ${shellArg(worker.paneId)} @idle_notify_pane ${shellArg(reviewer)}');
    expect(spawnSrc).toContain('tmux set-option -p -t ${shellArg(reviewer)} @idle_notify_pane ${shellArg(head)}');
    // kobo-759 — all three panes are births; each carries `@oracle_pane` (behaviour
    // proven in test/isolated/cell-pane-identity.test.ts, this is the boundary pin)
    expect(spawnSrc).toContain('stampCellPane(head, self, "head", emit)');
    expect(spawnSrc).toContain('stampCellPane(worker.paneId, self, "worker", emit)');
    expect(spawnSrc).toContain('stampCellPane(reviewer, self, "reviewer", emit)');
    expect(spawnSrc).toContain('CREW_STATE_DIR=${shellArg(stateDir)}');
    expect(spawnSrc).toContain('emit(`✓ cell spawned — head=${head} worker=${worker.paneId} (${worker.model}) reviewer=${reviewer}`)');
    expect(spawnSrc).toContain("export async function companyCellDown");
    expect(spawnSrc).toContain("usage: maw company cell down <company> [--force] [--verbose|--full]");
    // kobo-778 — the busy guard fails CLOSED here and the refusal carries the
    // reason it could not see (behaviour proven in cell-down-busy-guard.test.ts,
    // this is the boundary pin). `--force` skips the guard and says so.
    expect(spawnSrc).toContain("checkBusyGuard(member.oracle, { failClosed: true })");
    expect(spawnSrc).toContain("refusing cell teardown");
    expect(spawnSrc).toContain("busy guard SKIPPED");
    expect(spawnSrc).toContain("tmux kill-pane -t ${shellArg(pane.paneId)}");
    expect(spawnSrc).toContain("✓ cell down");
    // kobo-764 — teardown selects on the @oracle_pane identity ONLY: no emoji
    // @role, no window name (behaviour proven in cell-down-identity.test.ts).
    expect(spawnSrc).toContain("isTeardownTarget(p, member.oracle)");
    expect(spawnSrc).toContain('id.role === "worker" || id.role === "reviewer"');
    expect(spawnSrc).toContain("findHeadPane(panes, member.oracle)");
    expect(spawnSrc).toContain("standDownHead(headPane, member.oracle");
    expect(spawnSrc).toContain("cell teardown PARTIAL");
  });

  test("spawn repair classifies the pane before typing into it — allowlist + fail closed (cell-spawn-inject-blind)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    // Allowlist of shells, NOT a denylist of agents: an unnameable command must
    // read as "cannot execute", the same as a REPL. Behaviour is proven in
    // test/isolated/cell-spawn-inject-guard.test.ts; this is the boundary pin.
    expect(spawnSrc).toContain("const SHELL_CMDS = new Set([");
    expect(spawnSrc).toContain("pane_current_command");
    expect(spawnSrc).toContain("if (!SHELL_CMDS.has(paneCommandBasename(current)))");
    expect(spawnSrc).toContain("if (current === null) return { ok: false");
    expect(spawnSrc).toContain("REFUSED repair injection");
    // the probe must sit INSIDE injectCommand, ahead of the first send-keys
    const inject = spawnSrc.slice(spawnSrc.indexOf("async function injectCommand"));
    expect(inject.indexOf("paneCurrentCommand(target)")).toBeLessThan(inject.indexOf("send-keys"));
  });

  test("an agent-occupied pane is asked over `maw hey`, and only AFTER the guard refused to type (kobo-776)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    // Second allowlist, same fail-closed shape: neither shell nor agent → refused.
    expect(spawnSrc).toContain('const AGENT_CMDS = new Set(["claude", "node", "bun"])');
    // Delivery reuses the sanctioned path spawn already shells out to, rather
    // than importing cmdSend through the sdk barrel (which link-breaks every
    // isolated suite that mocks maw-js/sdk with a partial object).
    expect(spawnSrc).toContain("await hostExec(`maw hey ${shellArg(addr)} ${shellArg(handoffPrompt(company))}`)");
    const sdkImport = /import \{([^}]*)\} from "maw-js\/sdk"/.exec(spawnSrc)?.[1] ?? "";
    expect(sdkImport).not.toBe("");
    expect(sdkImport).not.toContain("cmdSend");
    // ORDER is the guard: the handoff branch reads injectCommand's verdict, so no
    // keystroke can precede it. Behaviour in cell-spawn-prompt-handoff.test.ts.
    const loop = spawnSrc.slice(spawnSrc.indexOf("export async function companyCellSpawn"));
    expect(loop.indexOf("const injected = await injectCommand(")).toBeLessThan(loop.indexOf("AGENT_CMDS.has("));
    expect(spawnSrc).toContain("${handed} handed-off");
  });

  test("company/index.ts wires `cell` to runCell", () => {
    const companyIndexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"), "utf8");
    expect(companyIndexSrc).toContain('from "../cell/index"');
    expect(companyIndexSrc).toContain("runCell");
    expect(companyIndexSrc).toContain('=== "cell"');
    expect(companyIndexSrc).toContain("|cell|");
  });
});
