/**
 * kobo-633 — standalone `pr-watch` daemon, run as its own OS process (its own
 * `pm2` app, see `ecosystem.config.cjs`), independent of `maw-server`.
 *
 * Before this card, `serve-pr-watch/index.ts#serve()` ran the poll loop
 * INSIDE `maw-server`'s own process via the plugin `serve` lifecycle hook —
 * so a hung/killed `pr-watch` pass could only be recovered by killing (and
 * restarting) the whole server, and a `maw-server` restart for any OTHER
 * reason silently interrupted whatever poll pass was mid-flight. That hook
 * has been REMOVED (not left as a no-op stub — see `index.ts`'s doc comment);
 * this file is the sole caller of `startServePrWatch` now.
 *
 * AC1: killing THIS process must never affect `maw-server` (API still
 * answers, `restart_time` unchanged) — guaranteed structurally by being a
 * separate OS process with no shared state, not by any code in this file.
 * AC2: killing THIS process mid-pass must never corrupt the snapshot or lose
 * an already-persisted prior round — already guaranteed by `pollPrsOnce`'s
 * own per-repo incremental atomic writes (kobo-631); this file adds nothing
 * to that guarantee, it just moves the caller into its own process so a kill
 * here can no longer take `maw-server` down with it.
 */

import { pollPrsOnce, recordHeartbeat } from "../../core/worklog/pr-watch";
import { startServePrWatch } from "./index";

const DEFAULT_INTERVAL_MS = 120_000;

function intervalMs(): number {
  return Number(process.env.MAW_PR_WATCH_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
}

/**
 * kobo-633 — wraps the real `pollPrsOnce` so a heartbeat is recorded on every
 * COMPLETED pass (see `recordHeartbeat`'s own doc comment for why "completed"
 * matters). `startServePrWatch`'s own `.catch()` already stops a throw here
 * from killing the daemon — a pass that throws simply never reaches the
 * `recordHeartbeat` call, which is exactly the desired behavior.
 */
function pollAndHeartbeat(ms: number) {
  return async () => {
    const entries = await pollPrsOnce();
    recordHeartbeat(ms);
    return entries;
  };
}

/**
 * kobo-633 — INTENDED side effect of `startServePrWatch` no longer unref'ing
 * its timer (see `index.ts`'s doc comment for why the unref was removed):
 * the `setInterval` handle it creates is now the ONLY thing keeping this
 * process's event loop open — nothing else in this file does. That means if
 * this returned `.stop()` is ever called (or the interval is otherwise
 * cleared) with nothing else scheduled, the process exits right after,
 * on its own, with no crash, no error, no signal. This is DELIBERATE, not a
 * bug: a visible death (the pm2 process list shows it stopped/restarting) is
 * strictly better than an invisible hang (the exact shape of kobo-630's
 * 86-minute incident — a process that LOOKED alive while doing nothing). If
 * you're debugging "the daemon disappeared" and nothing crashed, check
 * whether something called `.stop()` before assuming a failure.
 */
export function startDaemon(ms = intervalMs()): { stop: () => void } {
  return startServePrWatch({ pollPrsOnce: pollAndHeartbeat(ms), intervalMs: ms });
}

if (import.meta.main) {
  const ms = intervalMs();
  console.log(`[pr-watch daemon] starting — interval=${ms}ms pid=${process.pid}`);
  startDaemon(ms);
}
