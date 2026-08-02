/**
 * maw company cell — company/oracle based Cell v2 spawn.
 *
 *   maw company cell spawn <company>
 *
 * Public spawn wakes every oracle in the company and repairs each oracle's tmux
 * shape to `head | reviewer/worker`. `self-spawn` is an internal injected verb
 * that runs inside a target oracle pane and owns only that local tmux layout.
 */
import { companyCellDown, companyCellSpawn, cellSelfSpawn, parseCellCompanyArg, type CellSpawnResult } from "./spawn";

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

  if (subcmd === "self-spawn") {
    return await cellSelfSpawn(parseCellCompanyArg(args), emit);
  }

  return { ok: false, error: "usage: maw company cell <spawn|down> <company> [--force] [--verbose|--full]" };
}
