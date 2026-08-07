/**
 * watch plugin — serve lifecycle hook. THIS is what makes the engine toggleable:
 * disabling the `watch` plugin means this hook never runs, so neither the capture
 * listener nor the /api/worklog route is registered → capture + inject are off.
 *
 * - capture: add the feed listener (PostToolUse/UserPromptSubmit/interrupt → worklog)
 * - inject/read: register GET /api/worklog (behind auth — see PROTECTED "/worklog")
 * - company-ui (read-only): GET /api/worklog/feed (timeline) + GET /api/state
 *   (coordination markdown panel) — toggle with this plugin, same worklog-engine
 *   territory (spec §6 + addendum).
 */

import type { PluginLifecycleContext } from "maw-js/plugin/lifecycle";
import { registerWorklogListener } from "../../../core/worklog/listener";
import { handleWorklogRequest, handleWorklogFeedRequest } from "../../../core/worklog/route";
import { handleStateDocRequest } from "../../../core/state-doc/route";
import { handleRosterRequest } from "../../../core/roster/route";
import { handlePresenceRequest } from "../../../core/presence/route";
import { handlePolicyRequest } from "../../../core/policy/route";
import { handleRoomSendRequest, handleRoomOpenRequest, handleRoomCloseRequest, handleRoomReopenRequest, handleRoomThreadRequest, handleRoomMergeRequest, handleRoomActivityRequest, handleRoomsListRequest, handleRoomReplyRequest, handleRoomInviteRequest } from "../../../core/room/route";
import { registerRoomListener } from "../../../core/room/listener";
import { companyVersion } from "../../../views/company";
import { feedListeners } from "../../../api/feed";

export function serve(ctx: PluginLifecycleContext): { ok: true } {
  // The HOST's Set, not the one this module imported. This hook is loaded with a
  // runtime import() of an absolute path, so under a compiled bundle the import
  // below evaluates a SECOND copy of api/feed — adding to it registers into a Set
  // the server never pushes to. The routes kept working the whole time because
  // ctx.http is a live object, which is what made the outage silent. The import
  // stays as the fallback for callers that build a context without it (tests, and
  // any host that has not been updated).
  const listeners = ctx.feedListeners ?? feedListeners;
  // capture (idempotent across reloads)
  registerWorklogListener(listeners);
  // kobo-241 — persist room turns to the off-card artifact off the SAME feed events
  // (both directions carry [room:<id>]); idempotent, no new capture.
  registerRoomListener(listeners);
  // read/inject route
  ctx.http?.route("GET", "/api/worklog", (request: Request) => handleWorklogRequest(request));
  // company-ui timeline feed (behind auth — see PROTECTED "/worklog/feed")
  ctx.http?.route("GET", "/api/worklog/feed", (request: Request) => handleWorklogFeedRequest(request));
  // kobo-245 — Brainstorm Room core wire: the web /room input box posts here; we
  // deliver to the lead via `maw hey` (the SAME transport oracles use, which emits a
  // MessageSend feed event). The reply renders back on /room by filtering /api/feed on
  // the room tag — no new transport/session/pane. Behind auth (PROTECTED "/room/…").
  ctx.http?.route("POST", "/api/room/send", (request: Request) => handleRoomSendRequest(request));
  // kobo-260 — the room-target reply primitive (a lead/teammate writes into the artifact
  // directly, replacing the pane-hey hack) + teammate invite (record + one-shot notify).
  // Behind auth (PROTECTED "/room/…"); reply `from` is server-verified (Rule 6).
  ctx.http?.route("POST", "/api/room/reply", (request: Request) => handleRoomReplyRequest(request));
  ctx.http?.route("POST", "/api/room/invite", (request: Request) => handleRoomInviteRequest(request));
  // kobo-241 — off-card room artifact lifecycle + thread read. open/close/reopen write
  // rooms/<id>.json (NEVER a kanban card); GET thread reloads the persisted conversation
  // (private company convo, Rule 6). Behind auth (PROTECTED "/room/…").
  ctx.http?.route("POST", "/api/room/open", (request: Request) => handleRoomOpenRequest(request));
  ctx.http?.route("POST", "/api/room/close", (request: Request) => handleRoomCloseRequest(request));
  ctx.http?.route("POST", "/api/room/reopen", (request: Request) => handleRoomReopenRequest(request));
  ctx.http?.route("GET", "/api/room/thread", (request: Request) => handleRoomThreadRequest(request));
  // kobo-243 — lead-driven merge: consolidate same-problem rooms into one thread. Gated
  // by confirm:true (NEVER auto-merge); sources archived (status→merged), not deleted.
  ctx.http?.route("POST", "/api/room/merge", (request: Request) => handleRoomMergeRequest(request));
  // kobo-242 — CC-style activity for a room's participants: a pure join over the
  // worklog feed + presence (reuses both readers, no new store). Behind auth ("/room/…").
  ctx.http?.route("GET", "/api/room/activity", (request: Request) => handleRoomActivityRequest(request));
  // kobo-258 — company-scoped room list (topic pane + company selector + default lead).
  // Public read like the /room view; the thread/activity reads stay auth-gated.
  ctx.http?.route("GET", "/api/rooms", (request: Request) => handleRoomsListRequest(request));
  // company-ui coordination markdown panel (behind auth — PROTECTED "/state")
  ctx.http?.route("GET", "/api/state", (request: Request) => handleStateDocRequest(request));
  // company-ui presence roster (kobo-50): authoritative company membership for the
  // Presence tab (behind auth — PROTECTED "/roster").
  ctx.http?.route("GET", "/api/roster", (request: Request) => handleRosterRequest(request));
  // company-ui presence detail (kobo-104): per-pane model + context% from the
  // statusLine capture files (behind auth — PROTECTED "/presence").
  ctx.http?.route("GET", "/api/presence", (request: Request) => handlePresenceRequest(request));
  // company/dept policy inject route — on-attach context (separate concern,
  // toggles with this plugin). Behind auth via PROTECTED "/policy".
  ctx.http?.route("GET", "/api/policy", (request: Request) => handlePolicyRequest(request));
  // cache-bust version (kobo-57): the board polls this + compares to the version
  // it loaded with → a "reload" banner after a deploy. Public (just a content
  // hash — no company data), so it works before/without auth.
  ctx.http?.route("GET", "/api/version", () => Response.json({ version: companyVersion() }));
  return { ok: true };
}
