/**
 * maw company cell — uniform Cell v2 spawn.
 *
 *   maw company cell spawn <company>
 *
 * Creates the shape Tony asked for directly: page1/main + page2 review|worker.
 */
import { cellSpawn, type CellSpawnResult } from "./spawn";

export async function runCell(
  args: string[],
  emit: (line: string) => void,
): Promise<CellSpawnResult> {
  const subcmd = args[0]?.toLowerCase();

  if (subcmd === "spawn") {
    return await cellSpawn(args[1], emit);
  }

  return { ok: false, error: "usage: maw company cell spawn <company>" };
}
