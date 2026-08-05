import { dirname } from "path";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import os from "os";
import { mawStatePath } from "../xdg";

export function auditFilePath(): string {
  return mawStatePath("audit.jsonl");
}

export interface AuditEntry {
  ts: string;
  cmd: string;
  args: string[];
  user: string;
  pid: number;
  result?: string;
}

/** Append a structured audit log entry to maw's runtime state audit log. */
export function logAudit(cmd: string, args: string[], result?: string): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    cmd,
    args,
    user: process.env.USER || process.env.LOGNAME || "unknown",
    pid: process.pid,
  };
  if (result !== undefined) (entry as any).result = result;
  try {
    const filePath = auditFilePath();
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Silent fail — audit should never break the CLI
  }
}

/**
 * kobo-835 — where a `hey` ACTUALLY landed, next to what the operator typed.
 *
 * The `{cmd:"hey", args:[...]}` row written by cli.ts at process start records
 * the TYPED target and nothing else, so a message that resolved to someone
 * else's pane is indistinguishable in the audit from one that landed right.
 * This row is written after a successful send and carries the other half.
 *
 * `resolvedWhere` exists because `resolvedTarget` is not always human-readable:
 * the pane-identity route (kobo-830) resolves to a raw `%N` pane id, which names
 * nobody. Without a session/window string next to it, "did this land on the
 * right oracle?" is unanswerable for exactly the route that was added to make
 * targeting reliable.
 */
export interface HeyRouteEntry {
  ts: string;
  kind: "hey-route";
  cmd: "hey";
  /** Verbatim target the operator typed. */
  query: string;
  /** Exact send-keys target the message went to (`13-patchwork:0.1`, `%37`, or a peer-side name). */
  resolvedTarget: string;
  /** Human-readable `session:window` for the same destination, when known. */
  resolvedWhere?: string;
  /** Which resolution layer decided — see HeyResolvedBy in comm-send.ts. */
  resolvedBy: string;
  route: "local" | "self-node" | "peer";
  /** Peer node name, for `route: "peer"`. */
  node?: string;
  user: string;
  pid: number;
}

/** Append a hey-route row. Never throws — a send that already happened must not fail here. */
export function logHeyRoute(
  entry: Omit<HeyRouteEntry, "ts" | "kind" | "cmd" | "user" | "pid">,
  filePath = auditFilePath(),
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const row: HeyRouteEntry = {
      ts: new Date().toISOString(),
      kind: "hey-route",
      cmd: "hey",
      ...entry,
      user: process.env.USER || process.env.LOGNAME || "unknown",
      pid: process.pid,
    };
    appendFileSync(filePath, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // Silent fail — audit must never break delivery.
  }
}

export interface AnomalyEntry {
  ts: string;
  kind: "anomaly";
  event: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  user: string;
  pid: number;
  cwd: string;
  tty: string | null;
}

/**
 * Append a structured anomaly entry to maw's runtime state audit log.
 * Optional `filePath` overrides the default path (for test isolation).
 */
export function logAnomaly(
  event: string,
  data: { input?: Record<string, unknown>; context?: Record<string, unknown> },
  filePath = auditFilePath(),
): void {
  try {
    if (filePath === auditFilePath()) mkdirSync(dirname(filePath), { recursive: true });
    const entry: AnomalyEntry = {
      ts: new Date().toISOString(),
      kind: "anomaly",
      event,
      input: data.input ?? {},
      context: data.context ?? {},
      user: os.userInfo().username,
      pid: process.pid,
      cwd: process.cwd(),
      tty: process.stdin.isTTY ? (process.env.TTY ?? null) : null,
    };
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
  } catch { /* silent */ }
}

export function readAudit(count = 20): string[] {
  const filePath = auditFilePath();
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-count);
}
