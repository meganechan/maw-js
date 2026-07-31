import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

describe("cell command plugin standalone boundary", () => {
  test("cell keeps explicit import boundaries (SDK + maw-js/config + core/worklog/company-scope)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "cell",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [/^(?:\.\.\/){3}core\/worklog\//, /^\.\.\/crew\/teardown$/, /^\.\.\/crew\/spawn$/],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
    expect(imports).toContain("maw-js/config");
  });

  test("module surface only — no top-level cli.command", () => {
    const pluginSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/plugin.ts"), "utf8");
    expect(pluginSrc).not.toContain("cli:");
    expect(pluginSrc).toContain('"exports": ["runCell"]');
  });

  test("index.ts exports runCell(args, emit), public spawn, and hidden self-spawn", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/index.ts"), "utf8");
    expect(indexSrc).toContain("export async function runCell");
    expect(indexSrc).toContain('subcmd === "spawn"');
    expect(indexSrc).toContain('subcmd === "self-spawn"');
    expect(indexSrc).toContain("companyCellSpawn");
    expect(indexSrc).toContain("cellSelfSpawn");
  });

  test("spawn.ts implements company/oracle Cell v2: wake roster, then local head|reviewer/worker", () => {
    const spawnSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/cell/spawn.ts"), "utf8");
    expect(spawnSrc).toContain('CELL_WORKERS_WINDOW = "cell-workers"');
    expect(spawnSrc).toContain("cmdWake");
    expect(spawnSrc).toContain("listSessions");
    expect(spawnSrc).toContain("findWindow");
    expect(spawnSrc).toContain("companyRoster");
    expect(spawnSrc).toContain("maw company cell self-spawn");
    expect(spawnSrc).toContain('tmux set-option -p -t ${shellArg(head)} @role ${shellArg("👤 head")}');
    expect(spawnSrc).toContain("tmux new-window");
    expect(spawnSrc).toContain("split-window -h -p 50 -t ${shellArg(worker.paneId)}");
    expect(spawnSrc).toContain('CREW_STATE_DIR=${shellArg(stateDir)}');
    expect(spawnSrc).toContain('emit(`✓ cell spawned — head=${head} worker=${worker.paneId} (${worker.model}) reviewer=${reviewer}`)');
  });

  test("company/index.ts wires `cell` to runCell", () => {
    const companyIndexSrc = readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"), "utf8");
    expect(companyIndexSrc).toContain('from "../cell/index"');
    expect(companyIndexSrc).toContain("runCell");
    expect(companyIndexSrc).toContain('=== "cell"');
    expect(companyIndexSrc).toContain("|cell|");
  });
});
