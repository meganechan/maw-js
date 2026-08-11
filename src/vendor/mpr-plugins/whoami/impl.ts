import { hostExec } from "maw-js/sdk";
import { UserError } from "maw-js/core/util/user-error";

/**
 * maw whoami — show the caller's current tmux address.
 *
 * #1916 LOW-2 — Default human output now includes session, window name,
 * window id, pane name (title), and pane id, so the user has all the
 * context they need to copy a target into another verb. The single-line
 * --short form (just `#S`) is preserved for scripting via `--short`.
 */
export async function cmdWhoami(argv: string[] = []): Promise<void> {
  if (!process.env.TMUX) {
    throw new UserError("maw whoami requires an active tmux session — run 'maw wake <oracle>' or attach to tmux first");
  }
  // tmux-selfcheck-footgun: -t $TMUX_PANE. This verb's whole job is "which pane
  // am I", and bare it answered for the ACTIVE PANE of this session's current
  // window — a neighbour, whenever this pane is not the active one. Every field below (pane id, pane title, window) was
  // then copied into other verbs as a target.
  const self = process.env.TMUX_PANE;
  if (!self) {
    throw new UserError("maw whoami: TMUX_PANE is unset, so this process cannot identify its own pane — refusing to report another pane's address");
  }
  const short = argv.includes("--short") || argv.includes("-s");
  const json = argv.includes("--json");

  if (short) {
    const raw = await hostExec(`tmux display-message -p -t '${self}' '#S'`);
    console.log(raw.trim());
    return;
  }

  // #{session_name}\t#{window_name}\t#{window_id}\t#{pane_title}\t#{pane_id}
  const raw = await hostExec(`tmux display-message -p -t '${self}' '#S\t#W\t#{window_id}\t#{pane_title}\t#{pane_id}'`);
  const [session, window, windowId, paneTitle, paneId] = raw.trim().split("\t");

  if (json) {
    console.log(JSON.stringify({
      session: session || "",
      window: window || "",
      window_id: windowId || "",
      pane_title: paneTitle || "",
      pane_id: paneId || "",
      target: `${session}:${window}.${(paneId ?? "").replace(/^%/, "")}`,
    }));
    return;
  }

  console.log(`session  ${session}`);
  console.log(`window   ${window}  \x1b[90m(${windowId})\x1b[0m`);
  console.log(`pane     ${paneTitle}  \x1b[90m(${paneId})\x1b[0m`);
  console.log(`target   \x1b[36m${session}:${window}\x1b[0m  (or ${paneId} for the exact pane)`);
}
