/**
 * maw company cell — company/oracle based Cell v2 spawn.
 *
 *   maw company cell spawn <company>
 *   maw company cell down <company>
 *
 * kobo-822 — spawn wakes every oracle in the company (primary path, not a
 * fallback), then builds whatever role panes are missing from OUTSIDE that
 * oracle's session — never by typing a command into a pane that already has a
 * process in it. `self-spawn`, the old injected verb that ran inside a target
 * oracle pane, is gone: nothing here needs to run from inside the pane it is
 * building. Repair is `down` then `spawn`, not a third verb.
 */
import { companyCellDown, companyCellSpawn, parseCellCompanyArg, type CellSpawnResult } from "./spawn";

export async function runCell(
  args: string[],
  emit: (line: string) => void,
): Promise<CellSpawnResult> {
  const subcmd = args[0]?.toLowerCase();
  const verbose = args.includes("--verbose") || args.includes("--full");

  if (subcmd === "spawn") {
    return await companyCellSpawn(parseCellCompanyArg(args), emit, verbose);
  }

  if (subcmd === "down" || subcmd === "teardown") {
    return await companyCellDown(parseCellCompanyArg(args), { force: args.includes("--force"), verbose }, emit);
  }

  // `up` was the old verb and still lives in muscle memory and docs — name its
  // replacement instead of printing a grammar the caller already believed.
  return {
    ok: false,
    error: "usage: maw company cell <spawn|down> <company> [--force] [--verbose|--full] ('up' was replaced by 'spawn')",
  };
}
