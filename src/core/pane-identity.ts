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
