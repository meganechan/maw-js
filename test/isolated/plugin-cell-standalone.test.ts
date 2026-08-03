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
    expect(spawnSrc).toContain("exec claude");
    expect(spawnSrc).toContain("CREW_ROLE=head");
    expect(spawnSrc).toContain('tmux set-option -p -t ${shellArg(head)} @role ${shellArg("👤 head")}');
    expect(spawnSrc).toContain('tmux select-pane -t ${shellArg(head)} -T ${shellArg("👤 head")}');
    expect(spawnSrc).toContain('tmux rename-window -t ${shellArg(head)} ${shellArg("cell-head")}');
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
    expect(spawnSrc).toContain("no cell head pane found");
    expect(spawnSrc).toContain("BUSY — refusing cell teardown");
    expect(spawnSrc).toContain("tmux kill-pane -t ${shellArg(pane.paneId)}");
    expect(spawnSrc).toContain("✓ cell down");
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

  test("company/index.ts wires `cell` to runCell", () => {
    const companyIndexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"), "utf8");
    expect(companyIndexSrc).toContain('from "../cell/index"');
    expect(companyIndexSrc).toContain("runCell");
    expect(companyIndexSrc).toContain('=== "cell"');
    expect(companyIndexSrc).toContain("|cell|");
  });
});
