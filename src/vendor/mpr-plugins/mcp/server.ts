/**
 * server.ts — builds the stdio MCP server that wraps the real `maw` CLI.
 *
 * Each tool spawns `maw <verb> ...` (see tools.ts) and relays its output.
 * Identity / Rule-6 signing happen INSIDE `maw` — this layer only relays.
 *
 * CRITICAL: stdout is the MCP JSON-RPC channel. All logging goes to stderr
 * (console.error). Tool subprocesses pipe their own stdout (never inherit).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  heyArgs,
  replyArgs,
  inboxArgs,
  lsArgs,
  companyArgs,
  deptArgs,
  runMaw,
  toMcpResult,
  type SpawnFn,
} from "./tools";
import { inlineImages, defaultInlineImagesDeps } from "./inline-images";
import {
  roomRead,
  roomReply,
  roomMerge,
  roomClose,
  roomOpen,
  defaultRoomClientDeps,
  type RoomClientDeps,
} from "./room-client";

export interface BuildOptions {
  /** Injectable spawn (default Bun.spawn via runMaw). Mostly for tests. */
  spawn?: SpawnFn;
  /** Injectable room HTTP client deps (default live fetch). */
  roomDeps?: RoomClientDeps;
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const { spawn } = opts;
  const rd = opts.roomDeps ?? defaultRoomClientDeps();
  const server = new McpServer({ name: "maw", version: "0.1.0" });
  // Wrap each handler so a thrown mapper error becomes a clean MCP error
  // result instead of crashing the server.
  const guard = async (build: () => string[]): Promise<CallToolResult> => {
    let argv: string[];
    try {
      argv = build();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text }], isError: true };
    }
    return toMcpResult(await runMaw(argv, spawn));
  };

  server.registerTool(
    "maw_hey",
    {
      title: "Send a message to another oracle",
      description:
        "Send a message to a target oracle/peer (maw hey <target> <message>). " +
        "Sender is auto-signed as a [node:oracle] envelope (derived from CLAUDE_AGENT_NAME / the tmux session).",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target address. Formats: `<oracle>` (bare local name); `<session>:<window>`; " +
              "`<session>:<window>.<pane>` — the `.N` suffix routes to a SPECIFIC pane (needed when a " +
              "window has multiple panes, e.g. a coordinator in pane 1 beside a PM in pane 0; without it, " +
              "delivery auto-picks the lowest-index agent pane, NOT necessarily the one you replied from); " +
              "`<node>:<oracle>` for a cross-node peer (the explicit `<node>:` prefix is required to leave the local node).",
          ),
        message: z.string().describe("message body"),
      },
    },
    async ({ target, message }) => guard(() => heyArgs(target, message)),
  );

  server.registerTool(
    "maw_reply",
    {
      title: "Reply to a request",
      description: "Reply to a [request:<correlationId>] (maw reply <correlationId> <message>).",
      inputSchema: {
        correlationId: z.string().describe("correlationId from the [request:<id>] prompt"),
        message: z.string().describe("reply body"),
      },
    },
    async ({ correlationId, message }) => guard(() => replyArgs(correlationId, message)),
  );

  server.registerTool(
    "maw_inbox",
    {
      title: "Inbox status / list / read",
      description:
        "Check the inbox: status (maw inbox status), list (maw inbox list), or read an item (maw inbox read <id>).",
      inputSchema: {
        action: z.enum(["status", "list", "read"]).describe("inbox action"),
        id: z.string().optional().describe("message id (required for action=read)"),
      },
    },
    async ({ action, id }) => guard(() => inboxArgs(action, id)),
  );

  server.registerTool(
    "maw_ls",
    {
      title: "List oracles / sessions",
      description: "List oracles (maw ls). Pass verbose for the detailed view (maw ls -v).",
      inputSchema: {
        verbose: z.boolean().optional().describe("verbose listing (maw ls -v)"),
      },
    },
    async ({ verbose }) => guard(() => lsArgs(verbose)),
  );

  server.registerTool(
    "maw_company",
    {
      title: "Company ls / tree / attach",
      description:
        "Company ops: ls (maw company ls), tree (maw company tree [company]), attach (maw company attach <company> <dept>).",
      inputSchema: {
        action: z.enum(["ls", "tree", "attach"]).describe("company action"),
        company: z.string().optional().describe("company name (tree optional, attach required)"),
        dept: z.string().optional().describe("dept name (required for attach)"),
      },
    },
    async ({ action, company, dept }) => guard(() => companyArgs({ action, company, dept })),
  );

  server.registerTool(
    "maw_dept",
    {
      title: "Dept assign / members / learn / knowledge",
      description:
        "Dept ops: assign (maw dept assign <company> <dept> <oracle> [--role <role>]), members, learn (maw dept learn <company> <dept> \"<text>\"), knowledge (maw dept knowledge <company> <dept> [text]).",
      inputSchema: {
        action: z.enum(["assign", "members", "learn", "knowledge"]).describe("dept action"),
        company: z.string().optional().describe("company name"),
        dept: z.string().optional().describe("dept name"),
        oracle: z.string().optional().describe("oracle name (required for assign)"),
        role: z.string().optional().describe("role (optional for assign)"),
        text: z.string().optional().describe("text to learn (required for learn; query for knowledge)"),
      },
    },
    async ({ action, company, dept, oracle, role, text }) =>
      guard(() => deptArgs({ action, company, dept, oracle, role, text })),
  );

  // ── room tools — thin HTTP wrappers (no subprocess) ──────────────────────────

  server.registerTool(
    "maw_room_read",
    {
      title: "Read a brainstorm room thread",
      description:
        "GET /api/room/thread — returns the persisted room artifact (messages[], topic, status). " +
        "Default-capped to the last 20 turns so a large room never blows the token cap. " +
        "Use `last`/`since` to page, `offset` to page further back, or `all` for the full thread.",
      inputSchema: {
        company: z.string().describe("company the room belongs to"),
        room: z.string().describe("room id"),
        last: z.number().int().nonnegative().optional().describe("return only the last N turns (0 = all); default 20 when unset"),
        since: z.union([z.number(), z.string()]).optional().describe("return only turns at/after this time (epoch ms or ISO date)"),
        all: z.boolean().optional().describe("return the full thread (overrides the default 20-turn cap)"),
        offset: z.number().int().nonnegative().optional().describe("skip this many turns from the newest end before taking `last` — pages backward through history (kobo-357)"),
      },
    },
    async ({ company, room, last, since, all, offset }): Promise<CallToolResult> => {
      const r = await roomRead({ company, room, last, since, all, offset }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_reply",
    {
      title: "Reply into a brainstorm room",
      description:
        "POST /api/room/reply — write an oracle reply directly into the room artifact. " +
        "`from` must be a verified oracle of the room (Rule-6 enforced server-side).",
      inputSchema: {
        company: z.string().describe("company the room belongs to"),
        room: z.string().describe("room id"),
        from: z.string().describe("the oracle replying (bare name, e.g. eq3)"),
        text: z.string().describe("reply text"),
      },
    },
    async ({ company, room, from, text }): Promise<CallToolResult> => {
      const r = await roomReply({ company, room, from, text }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_merge",
    {
      title: "Merge rooms into a target",
      description:
        "POST /api/room/merge — consolidate one or more source rooms INTO a target room. " +
        "Sources are archived (never deleted). Calling this tool IS the confirmation (confirm:true is forwarded automatically).",
      inputSchema: {
        company: z.string().describe("company the rooms belong to"),
        target: z.string().describe("target room id (absorbs sources)"),
        sources: z.array(z.string()).min(1).describe("source room ids to merge into target"),
      },
    },
    async ({ company, target, sources }): Promise<CallToolResult> => {
      const r = await roomMerge({ company, target, sources }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_close",
    {
      title: "Close a brainstorm room",
      description:
        "POST /api/room/close — mark a room closed (thread preserved, reopenable). " +
        "Use when a room's topic is resolved.",
      inputSchema: {
        company: z.string().describe("company the room belongs to"),
        room: z.string().describe("room id to close"),
      },
    },
    async ({ company, room }): Promise<CallToolResult> => {
      const r = await roomClose({ company, room }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    "maw_room_open",
    {
      title: "Open (create or reopen) a brainstorm room",
      description:
        "POST /api/room/open — create a new room or reopen a closed one (idempotent; keeps existing thread). " +
        "The room is always scoped to a company.",
      inputSchema: {
        company: z.string().describe("company to open the room under"),
        room: z.string().describe("room id"),
        topic: z.string().optional().describe("short topic/title for the room"),
      },
    },
    async ({ company, room, topic }): Promise<CallToolResult> => {
      const r = await roomOpen({ company, room, topic }, rd);
      return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
    },
  );

  // Unlike the other tools, this one resolves IN-PROCESS (no `maw` subprocess):
  // it owns the `maw://` concept and only needs config + fetch. Fail-fast errors
  // map to an isError result so the caller never receives markdown that still
  // has an unresolved `maw://` in it.
  server.registerTool(
    "maw_inline_images",
    {
      title: "Inline maw:// image refs as base64",
      description:
        "Scan markdown for maw://<node>/<file> image refs, fetch each from the mesh, and replace them with data:image/...;base64 URIs — returning markdown with NO maw:// left. Fail-fast: if any ref can't be resolved (unknown node, 404, too large, unsupported type) the whole call fails and names the ref. Knows nothing about any downstream consumer; it only returns markdown.",
      inputSchema: {
        markdown: z.string().describe("markdown that may contain maw://<node>/<uuid>.<ext> image refs"),
      },
    },
    async ({ markdown }): Promise<CallToolResult> => {
      try {
        const out = await inlineImages(markdown, defaultInlineImagesDeps());
        return { content: [{ type: "text", text: out }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  );

  return server;
}
