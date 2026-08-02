/**
 * Held-work cross-reference (kobo-105) — the structured "this oracle is holding
 * work" signal behind the Presence tab's idle-with-work (⚠️) state.
 *
 * The plain idle badge (no worklog activity for ACTIVE_MS) can lie: a deadlocked
 * or wedged agent stops emitting worklog events, so it LOOKS idle while it is
 * actually stuck on work. To surface that we read the ONE structured ownership
 * signal maw still owns: open worklog claims — `openClaims(company)` (the ⛏
 * registry). Not status-text regex, which is weak.
 *
 * The second signal used to be in-progress board cards folded onto their
 * assignee; that half retired with the task subsystem (the board lives in kobo
 * taskd now), along with `pendingTasksByOracle`.
 *
 * Per ORACLE, not per pane: a claim belongs to an oracle and maw has no idea
 * which pane holds it. The Presence tab shows the warning on the oracle card
 * header; per-pane model/context sub-rows (kobo-104) are unchanged.
 */

import { openClaims } from "../worklog/store";

export interface HeldWork {
  id: string;
  kind: "claim";
  title?: string;
}

/** { oracle → held work }. An oracle with no open claim is simply absent from
 *  the map (→ a truly-idle oracle stays grey). Duplicate ids fold to one entry. */
export function heldWorkByOracle(company: string | null | undefined): Record<string, HeldWork[]> {
  const out: Record<string, HeldWork[]> = {};
  for (const c of openClaims(company)) {
    const oracle = c.oracle;
    const id = c.task ?? c.summary;
    if (!oracle || !id) continue;
    let arr = out[oracle];
    if (!arr) { arr = []; out[oracle] = arr; }
    if (!arr.some((h) => h.id === id)) arr.push({ id, kind: "claim" });
  }
  return out;
}
