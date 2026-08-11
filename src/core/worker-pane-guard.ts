/**
 * Worker-pane injection guard (D-E, eq3 dispatcher/worker-pane spec 2026-08-08).
 *
 * Rule: a target whose `@oracle_pane` role is `worker`/`reviewer` may be
 * injected into ONLY when the caller carries `MAW_WORKER_PANE_OK=1` —
 * no env => refuse, regardless of who is calling. Fail-closed on the target
 * role, fail-OPEN on unknown identity: a pane maw never stamped (most of the
 * fleet, or a tmux lookup that errored) is not proven to be a worker, so it
 * is not gated — same "unknown != guessed" posture as pane-identity.ts.
 *
 * Deliberately NOT gated on `$TMUX_PANE` presence/absence — measured on this
 * machine, pm2 daemons inherit whatever pane happened to start them
 * (`maw-server` carries a dead `%0`, `kobo-threadsd` a live-but-unstamped
 * `%325`), so "no $TMUX_PANE" is an accident of process history, not a
 * property of who is calling, and `env -u TMUX_PANE` would bypass it in one
 * word. The dispatcher instead sets this env var for itself before shelling
 * out to `maw run`/`maw send`.
 */

import { ORACLE_PANE_OPTION, parsePaneIdentity, type PaneRole } from "./pane-identity";
import { UserError } from "./util/user-error";

/** Opt-in env var the dispatcher (or a human acting deliberately) sets. */
export const WORKER_PANE_INJECT_ENV = "MAW_WORKER_PANE_OK";

/**
 * A UserError (not a bare Error): the CLI's top-level handler prints a
 * UserError's message alone, no stack trace — this is a deliberate refusal
 * with a clear remedy, not an unexpected failure worth debugging.
 */
export class WorkerPaneAccessError extends UserError {}

function isInjectOptedIn(): boolean {
  return process.env[WORKER_PANE_INJECT_ENV] === "1";
}

/** The refusal text — names the pane, and gives the two allowed alternatives. */
export function workerPaneRefusal(target: string, oracle: string, role: PaneRole): string {
  return (
    `${target} is a ${role} pane — ${role}s take orders from the board\n` +
    `  talk to the oracle:  maw hey ${oracle} "..."\n` +
    `  give it work:        create a card for ${oracle}`
  );
}

/**
 * Throws WorkerPaneAccessError when `identity` names a worker/reviewer pane
 * and the caller has not opted in. `identity` is the raw `@oracle_pane`
 * option value (or null/blank/unparseable, which reads as "unknown, not
 * gated" — same convention as `parsePaneIdentity`). Pure — no I/O, so every
 * caller can reuse identity it already fetched instead of paying for a
 * second tmux round trip.
 */
export function assertPaneInjectAllowed(target: string, identity: string | null | undefined): void {
  if (isInjectOptedIn()) return;
  const parsed = parsePaneIdentity(identity);
  if (parsed && (parsed.role === "worker" || parsed.role === "reviewer")) {
    throw new WorkerPaneAccessError(workerPaneRefusal(target, parsed.oracle, parsed.role as PaneRole));
  }
}

/**
 * Looks up the `@oracle_pane` identity of an ALREADY-EXACT target (a `%N`
 * pane id, or a `session:window.N`) via `display-message`, which — unlike
 * `list-panes` — resolves `-t` to the one named pane rather than every pane
 * in its window. Never throws: a tmux error here means "cannot tell", which
 * `assertPaneInjectAllowed` already treats as unknown/not-gated.
 */
export async function identityOfExactTarget(
  run: (...args: string[]) => Promise<string>,
  target: string,
): Promise<string | null> {
  try {
    const raw = await run("display-message", "-p", "-t", target, `#{${ORACLE_PANE_OPTION}}`);
    return raw.trim();
  } catch {
    return null;
  }
}
