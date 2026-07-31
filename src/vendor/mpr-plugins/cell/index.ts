/**
 * maw company cell — company/oracle based Cell v2 spawn.
 *
 *   maw company cell spawn <company>
 *
 * Public spawn wakes every oracle in the company and repairs each oracle's tmux
 * shape to `head | reviewer/worker`. `self-spawn` is an internal injected verb
 * that runs inside a target oracle pane and owns only that local tmux layout.
 */
import { companyCellSpawn, cellSelfSpawn, type CellSpawnResult } from "./spawn";

export async function runCell(
  args: string[],
  emit: (line: string) => void,
): Promise<CellSpawnResult> {
  const subcmd = args[0]?.toLowerCase();
  const verbose = args.includes("--verbose") || args.includes("--full");

  if (subcmd === "spawn") {
    return await companyCellSpawn(args.find((a, i) => i > 0 && !a.startsWith("--")), emit, verbose);
  }

  if (subcmd === "self-spawn") {
    return await cellSelfSpawn(args.find((a, i) => i > 0 && !a.startsWith("--")), emit);
  }

  return { ok: false, error: "usage: maw company cell spawn <company> [--verbose|--full]" };
}
