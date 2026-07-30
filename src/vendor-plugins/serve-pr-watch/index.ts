import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { pollPrsOnce as defaultPollPrsOnce } from "../../core/worklog/pr-watch";
import { cmdPrWatchStatus, formatPrWatchStatus } from "./status";

// ponytail: fixed 2-min interval; override via MAW_PR_WATCH_INTERVAL_MS if load matters.
const DEFAULT_INTERVAL_MS = 120_000;

type TimerHandle = { unref?: () => void };
type SetIntervalFn = (handler: () => void, ms: number) => TimerHandle;
type ClearIntervalFn = (timer: TimerHandle) => void;

type ServePrWatchDeps = {
  pollPrsOnce: typeof defaultPollPrsOnce;
  setInterval: SetIntervalFn;
  clearInterval: ClearIntervalFn;
  intervalMs: number;
};

const defaultDeps: ServePrWatchDeps = {
  pollPrsOnce: defaultPollPrsOnce,
  setInterval: (handler, ms) => setInterval(handler, ms) as unknown as TimerHandle,
  clearInterval: (timer) => clearInterval(timer as unknown as ReturnType<typeof setInterval>),
  intervalMs: Number(process.env.MAW_PR_WATCH_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
};

/**
 * Start a periodic PR poll. Each tick runs the same on-demand `pollPrsOnce`
 * (open→review, merge→done off the card.pr link), so a plain github.com
 * web-merge drives the linked card WITHOUT a human running any `maw` command.
 * pollPrsOnce is self-throttling via its snapshot diff — a tick with no PR
 * transition is a couple of `gh pr list` calls and no writes.
 *
 * kobo-633 — the ONLY caller is now `daemon.ts`, its own dedicated OS process
 * (its own `pm2` app — see `ecosystem.config.cjs`). Before this card, the
 * caller was `serve()` in this same file, invoked by the plugin `serve`
 * lifecycle hook, running THIS timer INSIDE `maw-server`'s own process — that
 * coupling meant killing `pr-watch`'s work meant killing the whole server,
 * and a server restart for any other reason silently interrupted whatever
 * poll pass was mid-flight (AC1 exists to remove exactly this). `serve()`,
 * the `hooks.serve` manifest entry, and the doc-comment's old `.unref()`
 * call were all REMOVED rather than left as an inert stub — a hook that's
 * registered but does nothing is a claim (`ensures: ["serve:pr:watch"]`
 * in the manifest) that's no longer true, which is worse than not having
 * the hook at all. Previously this function called `timer.unref?.()` — "don't
 * keep the SERVER process alive just for this timer" — that reasoning is gone
 * along with the server-embedded caller: `daemon.ts` has NOTHING ELSE keeping
 * its event loop open, so unref'ing here would let it exit before the very
 * first tick ever fires.
 */
export function startServePrWatch(
  deps: Partial<ServePrWatchDeps> = {},
): { ok: true; stop: () => void } {
  const d = { ...defaultDeps, ...deps };
  const timer = d.setInterval(() => {
    void d.pollPrsOnce().catch(() => { /* never let a poll error kill the daemon */ });
  }, d.intervalMs);
  return { ok: true, stop: () => d.clearInterval(timer) };
}

// kobo-633 Slice 5 — CLI surface for `prWatchLiveness()`. `sinceIso` defaults
// to a rolling window (see status.ts); `--since` overrides it for a real
// acceptance audit against a fixed T0.
export const command = {
  name: "pr-watch",
  description: "pr-watch daemon liveness + acceptance status.",
};
const USAGE = "usage: maw pr-watch [--since <ISO8601>] [--json]";

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    let sinceIso: string | undefined;
    let json = false;
    if (ctx.source === "cli") {
      const flags = parseFlags(ctx.args as string[], { "--since": String, "--json": Boolean, "--help": Boolean, "-h": "--help" });
      if (flags["--help"]) return { ok: false, error: USAGE };
      sinceIso = flags["--since"] as string | undefined;
      json = !!flags["--json"];
    } else {
      const args = ctx.args as Record<string, unknown>;
      sinceIso = args.since as string | undefined;
      json = !!args.json;
    }
    const result = await cmdPrWatchStatus({ sinceIso });
    const output = json ? JSON.stringify(result, null, 2) : formatPrWatchStatus(result);
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
