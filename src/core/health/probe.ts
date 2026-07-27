/**
 * kobo-458 — a health probe that answers "did the server actually respond?"
 * instead of "does pm2 think it's online?" (pm2 reported `online`, uptime
 * ~61min, while the port returned nothing for 2 consecutive checks 40s apart —
 * a zombie, alive to the supervisor, dead to every real caller).
 *
 * Reuses /api/probe (src/vendor/mpr-plugins/health/impl.ts's `cmdHealth`
 * already established this as the meaningful endpoint, not the bare root — it
 * walks the same code path as /api/send, so it can't report healthy while
 * delivery is actually broken, kobo-804/#1979's hard-won lesson).
 *
 * Four states, not two — collapsing any pair of these back into one is the
 * exact defect class this card exists to fix:
 *   ok           — responded within the fast window
 *   slow         — responded, but past the slow-threshold (still a REAL
 *                  answer — must never be treated as unhealthy; this is the
 *                  kobo-453 case, a hung/slow call is not the same thing as a
 *                  refused one)
 *   dead         — no usable response inside the hard timeout (network error,
 *                  non-2xx, or the timeout itself firing) — the only state
 *                  that should ever count toward a restart
 *   probe-error  — the check couldn't even be ATTEMPTED (malformed URL, a
 *                  broken fetchImpl) — this is the WATCHER failing, not a
 *                  statement about the server at all, and must never be read
 *                  as either "healthy" or "dead"
 */

export type ProbeResult =
  | { status: "ok"; elapsedMs: number }
  | { status: "slow"; elapsedMs: number }
  | { status: "dead"; elapsedMs: number }
  | { status: "probe-error"; reason: string };

export interface ProbeOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  slowThresholdMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000; // matches the card's own repro (`curl --max-time 8`)
const DEFAULT_SLOW_THRESHOLD_MS = 2000;

export async function probeServer(url: string, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;

  // Validate BEFORE attempting anything network-related. A malformed URL or a
  // non-function fetchImpl means the WATCHER is misconfigured, not that the
  // server is unreachable — this must never fall through to "dead", or a
  // broken watcher would restart a server it never actually asked.
  try {
    new URL(url);
  } catch (e) {
    return { status: "probe-error", reason: `invalid probe URL: ${(e as Error).message}` };
  }
  if (typeof fetchImpl !== "function") {
    return { status: "probe-error", reason: "fetchImpl is not a function" };
  }

  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) return { status: "dead", elapsedMs }; // answered, but not usably — same bucket as no answer
    return elapsedMs > slowThresholdMs ? { status: "slow", elapsedMs } : { status: "ok", elapsedMs };
  } catch {
    // network error, connection-refused, or the hard timeout firing — all
    // "dead": the server did not answer within the window we gave it.
    return { status: "dead", elapsedMs: Date.now() - start };
  }
}
