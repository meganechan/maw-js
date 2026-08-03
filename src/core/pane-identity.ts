/**
 * Pane identity — the tmux user option `@oracle_pane = "{name}:{role}"` (kobo-759).
 *
 * WHY an option and not the pane title: the title is decoration — any program in
 * the pane can overwrite it (and several do). The user option is only writable by
 * a deliberate `tmux set-option`, so it is the source of truth; the title stays a
 * human-readable bonus.
 *
 * Set at every pane BIRTH path that maw itself owns (cell head/worker/reviewer,
 * `maw wake`). A pane maw did not birth — a human `tmux split-window`, a `maw
 * bring` attach pane — carries NO option, and every consumer must read that as
 * "unknown", never guess. That is why every helper here refuses (returns
 * null/false/"") instead of inventing a value.
 *
 * Dependency-free by design: the tmux runner is injected, so this module can be
 * imported into any graph (plugin, core, hook) without dragging the sdk barrel
 * in — the barrel import is what breaks widely-mocked isolated suites.
 */

/** tmux user option that carries pane identity. */
export const ORACLE_PANE_OPTION = "@oracle_pane";

/**
 * head     — the oracle itself (solo wake, or the cell's coordinator pane)
 * worker   — cell worker pane
 * reviewer — cell reviewer pane
 */
export type PaneRole = "head" | "worker" | "reviewer";

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * `{name}:{role}`, or null when the name is unusable — blank (identity unknown)
 * or containing `:` (would make the value ambiguous to split). Never substitutes
 * a placeholder: no identity is a fact consumers can act on, a guessed one is not.
 */
export function paneIdentity(name: string, role: PaneRole): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed || trimmed.includes(":")) return null;
  return `${trimmed}:${role}`;
}

/**
 * Stamp a pane. `target` is either an exact pane id (`%42`, captured from `-P -F
 * '#{pane_id}'` or `$TMUX_PANE`) or a `session:window` whose ACTIVE pane is the
 * one being born — which is what wake uses, because that is the same pane tmux
 * types the launch line into.
 *
 * Always writes — an adopted/reused pane must lose its previous identity in the
 * same breath, never keep a stale name.
 *
 * Returns false (and writes nothing) on an unusable name or a BLANK target — an
 * empty tmux target does not mean "no pane", it silently resolves to the caller's
 * own active pane (the trap agent-panes.ts guards) — and false when tmux rejects
 * the write, so callers can surface it instead of assuming the stamp landed.
 */
export async function stampPaneIdentity(
  target: string,
  name: string,
  role: PaneRole,
  exec: (cmd: string) => Promise<unknown>,
): Promise<boolean> {
  const value = paneIdentity(name, role);
  if (!value || !(target ?? "").trim()) return false;
  try {
    await exec(`tmux set-option -p -t ${shellArg(target)} ${ORACLE_PANE_OPTION} ${shellArg(value)}`);
    return true;
  } catch {
    return false;
  }
}

/** A pane that carries an `@oracle_pane` identity, plus where it lives. */
export interface IdentifiedPane {
  /** tmux pane id (`%42`) — a valid send-keys/select-window target on its own. */
  paneId: string;
  session: string;
  windowIndex: string;
  windowName: string;
  oracle: string;
  role: string;
}

/**
 * Reverse of `paneIdentity`. Blank option (the pane maw never birthed), or a
 * value missing either half, reads as "unknown" — null, never a guess.
 */
export function parsePaneIdentity(value: string | null | undefined): { oracle: string; role: string } | null {
  const parts = (value ?? "").trim().split(":");
  if (parts.length !== 2) return null;
  const [oracle = "", role = ""] = parts;
  return oracle && role ? { oracle, role } : null;
}

const SCAN_SEP = "|||";
const SCAN_FORMAT =
  `#{pane_id}${SCAN_SEP}#{session_name}${SCAN_SEP}#{window_index}${SCAN_SEP}#{window_name}${SCAN_SEP}#{${ORACLE_PANE_OPTION}}`;

/**
 * Every identity-carrying pane on the tmux SERVER (`list-panes -a`), not just one
 * session (kobo-782). The whole point of asking identity instead of a window name
 * is that the oracle may not be where the name says — scoping the scan to the
 * session we already guessed would reintroduce the guess.
 *
 * `run` is injected (`Tmux#run` / sdk `tmux.run` shape) to keep this module free
 * of the sdk barrel. tmux errors → empty list: "cannot see any pane" must read as
 * no evidence, which leaves callers on their legacy path.
 */
export async function scanIdentifiedPanes(
  run: (...args: string[]) => Promise<string>,
): Promise<IdentifiedPane[]> {
  let raw = "";
  try {
    raw = await run("list-panes", "-a", "-F", SCAN_FORMAT);
  } catch {
    return [];
  }
  const panes: IdentifiedPane[] = [];
  for (const line of raw.split("\n")) {
    const [paneId = "", session = "", windowIndex = "", windowName = "", identity = ""] = line.trim().split(SCAN_SEP);
    const parsed = parsePaneIdentity(identity);
    if (!paneId || !parsed) continue;
    panes.push({ paneId, session, windowIndex, windowName, ...parsed });
  }
  return panes;
}

/** `%42` → 42, for ordering. Unparseable ids sort last rather than first. */
function paneIdNum(paneId: string): number {
  const n = Number(paneId.replace(/^%/, ""));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * The oracle's panes, and which one is "the" pane for `role`.
 *
 * Two panes CAN claim the same identity (a stamp landed on a newly adopted pane
 * while the old one still carried its own). Both look equally valid, so the
 * winner is a STATED rule rather than tmux's listing order: LOWEST PANE ID = the
 * oldest pane = the one the oracle has been living in (tmux hands out `%N`
 * monotonically). This is the same rule cell down/spawn's `findHeadPane` uses
 * (kobo-775 / PR #432) — mirrored rather than imported because that helper is
 * private to the cell plugin, which must stay out of this module's graph. If the
 * two ever disagree, they are one rule with two copies: fix both.
 *
 * `role` omitted → any role, which is the presence question ("does this oracle
 * live anywhere?") as opposed to the delivery question ("which pane is its head?").
 */
export function pickIdentifiedPane(
  panes: IdentifiedPane[],
  oracle: string,
  role?: PaneRole,
): { pane?: IdentifiedPane; duplicates: IdentifiedPane[] } {
  const claimants = panes
    .filter((p) => p.oracle === oracle && (!role || p.role === role))
    .sort((a, b) => paneIdNum(a.paneId) - paneIdNum(b.paneId) || a.paneId.localeCompare(b.paneId));
  return { pane: claimants[0], duplicates: claimants.slice(1) };
}

/**
 * kobo-782 — guidance, never an action. Duplicate heads are LIVE panes with a
 * live agent in them; killing one or clearing its stamp automatically would
 * destroy work to tidy a label. Name every claimant and hand the operator the
 * exact clear command for the losers.
 */
export function duplicateIdentityWarning(
  oracle: string,
  role: PaneRole,
  winner: IdentifiedPane,
  duplicates: IdentifiedPane[],
): string {
  const all = [winner, ...duplicates];
  const clears = duplicates.map((p) => `tmux set-option -pu -t ${p.paneId} ${ORACLE_PANE_OPTION}`).join("; ");
  return `⚠ ${oracle}: ${all.length} panes claim ${ORACLE_PANE_OPTION}=${oracle}:${role} — ${all.map((p) => `${p.paneId} (${p.session}:${p.windowName})`).join(", ")}; using ${winner.paneId} (lowest pane id = oldest). Clear the stale one(s) with: ${clears}`;
}
