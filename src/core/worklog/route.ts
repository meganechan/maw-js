/**
 * Worklog read route handler (Web Request → Response), registered by the watch
 * plugin's serve hook (ctx.http.route) — NOT mounted in core. Behind auth via the
 * "/worklog" entry in elysia-auth PROTECTED (loopback hooks bypass; LAN must auth)
 * so captured prompts/commands aren't readable cross-company on the LAN.
 *
 *   GET /api/worklog?oracle=<name>          → { inject: "<slice text>" }
 *   GET /api/worklog?company=<name>&limit=N → { entries: [...] }   (debug)
 *   GET /api/worklog/feed?company=<name>&limit=N → { company, entries: [...] }
 *       timeline projection for company-ui (read-only) — see spec §6
 *   GET /api/pr-watch/liveness?since=<ISO8601> → PrWatchLivenessResult
 *       kobo-633 Slice 5 — see handlePrWatchLivenessRequest below
 */

import { buildInjectSlice } from "./slice";
import { readWorklog } from "./store";
import { prWatchLiveness, DEFAULT_ACCEPTANCE_LOOKBACK_MS } from "./pr-watch";

export function handleWorklogRequest(request: Request): Response {
  const url = new URL(request.url);
  const oracle = url.searchParams.get("oracle");
  if (oracle) {
    const ev = url.searchParams.get("events");
    const events = ev ? Math.max(1, Math.min(50, +ev || 12)) : undefined;
    return Response.json({ inject: buildInjectSlice(oracle, { events }) });
  }
  const company = url.searchParams.get("company");
  const lim = url.searchParams.get("limit");
  const limit = lim ? Math.max(1, Math.min(500, +lim || 50)) : 50;
  return Response.json({ entries: readWorklog(company, { limit }) });
}

/**
 * Worklog feed — timeline projection for the company-ui view. Distinct from the
 * dual-purpose /api/worklog (whose primary mode is the inject string): this one
 * always returns the raw entry list, projected to the locked timeline contract
 * { ts, iso, oracle, kind, summary } so the UI shape stays pinned (spec §6).
 */
export function handleWorklogFeedRequest(request: Request): Response {
  const url = new URL(request.url);
  const company = url.searchParams.get("company");
  const lim = url.searchParams.get("limit");
  const limit = lim ? Math.max(1, Math.min(500, +lim || 50)) : 50;
  const entries = readWorklog(company, { limit }).map((e) => ({
    ts: e.ts,
    iso: e.iso,
    oracle: e.oracle,
    ...(e.pane ? { pane: e.pane } : {}), // optional pane suffix — omitted for old entries
    kind: e.kind,
    summary: e.summary,
  }));
  return Response.json({ company: company ?? null, entries });
}

/**
 * kobo-633 Slice 5 — pr-watch daemon liveness + acceptance, for the company-ui
 * status badge and any human hitting the endpoint directly.
 *
 * `?since=` defaults to `DEFAULT_ACCEPTANCE_LOOKBACK_MS` (rolling window) if
 * omitted — same on-purpose opt-in as the CLI's `status.ts`. `prWatchLiveness`
 * itself still refuses a silent default internally; this route is the ONE
 * place that makes the rolling-window choice for callers that want a live
 * status readout rather than an acceptance audit against a fixed T0. A
 * caller auditing a specific incident passes `?since=` explicitly.
 */
export async function handlePrWatchLivenessRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const sinceIso = sinceParam ?? new Date(Date.now() - DEFAULT_ACCEPTANCE_LOOKBACK_MS).toISOString();
  const result = await prWatchLiveness(sinceIso);
  return Response.json(result);
}
