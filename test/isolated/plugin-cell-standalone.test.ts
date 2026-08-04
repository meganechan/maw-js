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

  test("index.ts exports runCell(args, emit) and the public spawn/down verbs — self-spawn is gone (kobo-822)", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/index.ts"), "utf8");
    expect(indexSrc).toContain("export async function runCell");
    expect(indexSrc).toContain('subcmd === "spawn"');
    expect(indexSrc).toContain('subcmd === "down" || subcmd === "teardown"');
    expect(indexSrc).toContain("companyCellSpawn");
    expect(indexSrc).toContain("companyCellDown");
    // kobo-822 — self-spawn ran INSIDE a target pane via an injected command;
    // spawn now builds worker/reviewer from outside, so there is nothing left
    // for a pane to run on itself. The name may still appear in prose
    // explaining the change; the CALL/IMPORT must not.
    expect(indexSrc).not.toContain("cellSelfSpawn");
    expect(indexSrc).not.toContain('subcmd === "self-spawn"');
  });

  test("spawn.ts: wake is the PRIMARY path for every roster member, not a fallback (kobo-822)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("checkBusyGuard");
    expect(spawnSrc).toContain('CELL_WORKERS_WINDOW = "cell-workers"');
    expect(spawnSrc).toContain("companyRoster");
    // the call sits directly in the roster loop, unconditional — not gated on
    // "no session found" the way it used to be (behaviour: cell-spawn-live-pane
    // and cell-down-identity test suites)
    const spawnFn = spawnSrc.slice(spawnSrc.indexOf("export async function companyCellSpawn"), spawnSrc.indexOf("export async function companyCellDown"));
    expect(spawnFn).toContain('await cmdWake(member.oracle, { noAttach: true, noRehydrate: true });');
    expect(spawnFn).toContain("findHeadPane(panes, member.oracle)");
    expect(spawnFn).toContain("const anchor = await cellAnchor(headId);");
    expect(spawnFn).toContain("const stateDir = stateDirOf(anchor);");
    expect(spawnFn).toContain("#{session_path}");
    // kobo-822 — no `self-spawn`, no injection, no handoff: spawn builds the
    // missing panes itself, from outside
    expect(spawnFn).not.toContain("injectCommand(");
    // the actual call sites are gone; the phrase may still appear in prose
    // explaining why (as it does, right above this slice's own comments)
    expect(spawnFn).not.toContain('maw company cell self-spawn');
    expect(spawnFn).not.toContain("cellSelfSpawn(");
    expect(spawnFn).not.toContain("handOffToAgent(");
    // worker's own `tmux new-window` lives in the shared spawnWorkerSelfHeal
    // helper (called from companyCellSpawn, defined after companyCellDown in
    // the file — outside this slice), reviewer's split-window is inline here.
    expect(spawnSrc).toContain("tmux new-window");
    expect(spawnFn).toContain("split-window -h -p 50 -t ${shellArg(worker.paneId)}");
    expect(spawnFn).toContain('stampCellPane(worker.paneId, self, "worker", emit)');
    expect(spawnFn).toContain('stampCellPane(reviewer, self, "reviewer", emit)');
    expect(spawnFn).toContain('CREW_STATE_DIR=${shellArg(stateDir)}');
    expect(spawnFn).toContain('@idle_notify_pane');
  });

  test("spawn.ts: never a keystroke into an occupied pane — the injection guard exists but has no caller left in this file (kobo-822)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    // The kobo-776 guard (SHELL_CMDS allowlist, classify-then-type) is
    // preserved verbatim on purpose — it stays correct even though nothing in
    // this file calls it any more, because the new path was built to need no
    // injection at all rather than to route around the guard.
    expect(spawnSrc).toContain("const SHELL_CMDS = new Set([");
    expect(spawnSrc).toContain("async function injectCommand(");
    expect(spawnSrc).toContain("pane_current_command");
    // and neither companyCellSpawn nor companyCellDown call it or send-keys
    const verbs = spawnSrc.slice(spawnSrc.indexOf("export async function companyCellSpawn"));
    expect(verbs).not.toContain("send-keys");
    expect(verbs).not.toContain("injectCommand(");
  });

  test("spawn.ts: down tears down the whole cell — head included, but only the RESOLVED winner (kobo-822, kobo-782 duplicate-head safety preserved)", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    expect(spawnSrc).toContain("export async function companyCellDown");
    expect(spawnSrc).toContain("usage: maw company cell down <company> [--force] [--verbose|--full]");
    expect(spawnSrc).toContain("checkBusyGuard(member.oracle, { failClosed: true })");
    expect(spawnSrc).toContain("refusing cell teardown");
    expect(spawnSrc).toContain("busy guard SKIPPED");
    expect(spawnSrc).toContain("tmux kill-pane -t ${shellArg(pane.paneId)}");
    expect(spawnSrc).toContain("✓ cell down");
    // kobo-764 — worker/reviewer selection is still identity-only.
    expect(spawnSrc).toContain("isTeardownTarget(p, member.oracle)");
    expect(spawnSrc).toContain('id.role === "worker" || id.role === "reviewer"');
    // kobo-822 — head joins the kill list explicitly, as the single resolved
    // winner, never every pane merely claiming the identity (kobo-782).
    const downFn = spawnSrc.slice(spawnSrc.indexOf("export async function companyCellDown"));
    expect(downFn).toContain("if (headPane.paneId !== invokerPane) toKill.push(headPane);");
    expect(downFn).not.toContain("standDownHead");
    expect(downFn).toContain("tmux has-session -t");
    expect(downFn).toContain("cell teardown PARTIAL");
  });

  test("company/index.ts wires `cell` to runCell", () => {
    const companyIndexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"), "utf8");
    expect(companyIndexSrc).toContain('from "../cell/index"');
    expect(companyIndexSrc).toContain("runCell");
    expect(companyIndexSrc).toContain('=== "cell"');
    expect(companyIndexSrc).toContain("|cell|");
  });
});
