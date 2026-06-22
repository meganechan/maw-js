import { Elysia, t } from "elysia";
import { buildInjectSlice } from "../core/worklog/slice";
import { readWorklog } from "../core/worklog/store";

/**
 * Worklog read API — backs the auto-inject hooks (SessionStart / UserPromptSubmit)
 * so they fetch the slice over HTTP instead of resolving the data path in bash.
 *
 * GET /api/worklog?oracle=<name>            → { inject: "<slice text>" }
 * GET /api/worklog?company=<name>&limit=N   → { entries: [...] }  (debug)
 */
export function createWorklogApi() {
  const api = new Elysia();

  api.get("/worklog", ({ query }) => {
    if (query.oracle) {
      const events = query.events ? Math.max(1, Math.min(50, +query.events)) : undefined;
      return { inject: buildInjectSlice(query.oracle, { events }) };
    }
    const limit = query.limit ? Math.max(1, Math.min(500, +query.limit)) : 50;
    return { entries: readWorklog(query.company ?? null, { limit }) };
  }, {
    query: t.Object({
      oracle: t.Optional(t.String()),
      company: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      events: t.Optional(t.String()),
    }),
  });

  return api;
}

export const worklogApi = createWorklogApi();
