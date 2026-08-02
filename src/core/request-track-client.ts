/**
 * Client side of the `[request:<id>]` tracking convention: when `maw hey`/`send`
 * dispatches a `[request:<id>]` message, the CLI registers that id into the
 * server's request-reply store via POST /api/request/track, so `maw reply <id>`
 * and `reply --list` (which read the same server store) can find it.
 *
 * Best-effort: if the local server is down the call just fails quietly — the
 * message still delivers; only the reply-tracking convenience is lost.
 */

function mawUrl(): string {
  return `http://localhost:${process.env.MAW_PORT || "3456"}`;
}

// `[request:<id>]` must lead the message (after optional whitespace). Moved here
// from the retired core/tasks/auto-create — the board-card half of the convention
// is gone; the reply-tracking half below is what still reads the tag.
const REQUEST_RE = /^\s*\[request:([A-Za-z0-9._-]+)\]/;

/**
 * The correlation id a hey message dispatches under, or null when it is not a
 * `[request:<id>]` lead — including `re:` replies, which are answers to an
 * already-tracked request, not a new one.
 */
export function parseRequestId(message: string): string | null {
  if (/^\s*re:/i.test(message)) return null; // reply, not a new request
  return REQUEST_RE.exec(message)?.[1] ?? null;
}

export async function trackRequest(
  correlationId: string,
  from: string,
  to: string,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${mawUrl()}/api/request/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correlationId, from, to, message }),
    });
    return res.ok;
  } catch {
    return false; // server unreachable — message still delivered, tracking skipped
  }
}
