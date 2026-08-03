import { agentStatusStore, type AgentStatus } from "./agent-status";
import { messageQueue } from "./message-queue";

/**
 * Extract bare oracle name from a query/target string.
 * "neo" → "neo", "neo-oracle" → "neo", "08-mawjs:neo-oracle" → "neo"
 */
export function extractOracleName(target: string): string {
  const parts = target.split(":");
  const last = parts.at(-1) || target;
  return last.replace(/-oracle$/i, "").trim();
}

export interface BusyGuardResult {
  busy: boolean;
  status: AgentStatus | "unknown";
  oracle: string;
  /**
   * Why the status is `unknown` — set only when the status source could not
   * answer, and it names WHICH way it failed (404 / unreachable / unreadable).
   * "unknown" alone cannot tell a sleeping oracle from a dead status server.
   */
  reason?: string;
}

const MAW_PORT = process.env.MAW_PORT || "3456";
/** A hung status server must become a verdict, not a hang: teardown waits on this. */
const STATUS_TIMEOUT_MS = 2000;

async function fetchRemoteStatus(oracle: string): Promise<{ status: AgentStatus } | { error: string }> {
  const url = `http://localhost:${MAW_PORT}/api/status/${oracle}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  } catch (e: any) {
    return { error: `status source unreachable at localhost:${MAW_PORT} (${e?.message || e})` };
  }
  if (!res.ok) return { error: `status source returned ${res.status} for '${oracle}'` };
  let data: { status?: AgentStatus } | null;
  try {
    data = await res.json() as { status?: AgentStatus };
  } catch (e: any) {
    return { error: `status source returned unreadable JSON for '${oracle}' (${e?.message || e})` };
  }
  if (!data?.status) return { error: `status source answered for '${oracle}' with no status field` };
  return { status: data.status };
}

/**
 * Check if a target oracle is busy.
 * In server context: reads local in-memory store.
 * In CLI context: queries the server API for live status.
 *
 * kobo-778 — `failClosed` for callers that do something IRREVERSIBLE to the pane
 * (teardown, injection): when the status source cannot answer, a guard that
 * cannot see must say NO, and `reason` says what it could not see.
 *
 * It is opt-in, not the default, because `maw hey` reads this same guard and the
 * status source answers for nobody today — flipping unknown→busy there would
 * queue every message fleet-wide instead of delivering it.
 */
export async function checkBusyGuard(
  target: string,
  opts: { failClosed?: boolean } = {},
): Promise<BusyGuardResult> {
  const oracle = extractOracleName(target);

  const entry = agentStatusStore.get(oracle);
  if (entry) {
    return { busy: entry.status === "busy", status: entry.status, oracle };
  }

  const remote = await fetchRemoteStatus(oracle);
  if ("status" in remote) {
    return { busy: remote.status === "busy", status: remote.status, oracle };
  }

  return { busy: opts.failClosed === true, status: "unknown", oracle, reason: remote.error };
}

/**
 * Queue a message for auto-delivery when the target becomes idle/ready.
 * In server context: enqueues locally. In CLI context: also POST to server
 * so DispatchEngine can auto-deliver.
 */
export async function queueForDispatch(opts: {
  from: string;
  to: string;
  target: string;
  message: string;
}) {
  const oracle = extractOracleName(opts.to);
  const msg = messageQueue.enqueue({
    from: opts.from,
    to: oracle,
    target: opts.target,
    message: opts.message,
  });

  if (!agentStatusStore.get(oracle)) {
    try {
      await fetch(`http://localhost:${MAW_PORT}/api/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: opts.from,
          to: opts.to,
          target: opts.target,
          message: opts.message,
        }),
      });
    } catch {}
  }

  return msg;
}
