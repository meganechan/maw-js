/**
 * maw company cell — the add-on that gives a RUNNING oracle its worker pane.
 *
 *   maw company cell spawn <company>
 *   maw company cell down  <company> [--force]
 *
 * `spawn` adds a worker pane beside each roster oracle's own pane and stamps
 * `@oracle_pane` on both; `down` removes the worker. The oracle's native pane
 * is the head and is never adopted, renamed, relaunched or killed. There is
 * no `self-spawn`: nothing is injected into a pane any more. (kobo-859: cell
 * used to also add a reviewer pane — removed, review-requests already land
 * on the worker pane.)
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

  // `up` was the old verb and still lives in muscle memory and docs; `self-spawn`
  // was the injected internal one and is gone with the injection. Name the
  // replacement instead of printing a grammar the caller already believed.
  if (subcmd === "self-spawn") {
    return {
      ok: false,
      error: "`self-spawn` was removed: cell no longer types anything into a pane. Run `maw company cell spawn <company>` from anywhere — it adds the worker pane from outside and leaves the oracle's own pane alone.",
    };
  }

  return {
    ok: false,
    error: "usage: maw company cell <spawn|down> <company> [--force] [--verbose|--full] ('up' and 'self-spawn' were both replaced by 'spawn')",
  };
}
