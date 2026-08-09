/**
 * maw presence — set this pane's presence state (mawjs-3 / kobo-113).
 *
 *   maw presence away   → durable worklog "away" event for this oracle/pane
 *   maw presence back    → clears it (idle), receiving hey normally again
 *
 * SILENT by design (Tony): a purely local worklog write, ZERO outbound message —
 * "ไปห้องน้ำไม่ต้อง broadcast, แค่ set ไว้". The effect surfaces only when someone
 * tries to `maw hey` this pane while away: the delivery gate parks the message to
 * the inbox and tells the SENDER "parked, wait for seat" (see comm-send.ts). seat
 * drains the inbox on return.
 *
 * Reuses the worklog store (kobo-109/111 idle/error pattern, newest-wins) — no new
 * store. Intended caller: the /toilet + /seat skills (follow-up, shipped separately
 * via skill distribution — NOT this repo).
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { execFileSync } from "child_process";
import { appendWorklog } from "../../../core/worklog/store";
// Same barrel-free resolver the delivery gate reads with (isPaneAway) → the away
// event is written to, and read from, the same company worklog.
import { companyOfOracleLight } from "../../../core/worklog/presence-away";

export const command = {
  name: "presence",
  description: "Set this pane's presence (away/back) — a silent local write; parks incoming hey to inbox until seat.",
};

/** Same resolution the worklog hooks use: CLAUDE_AGENT_NAME, else tmux session name minus prefix. */
function resolveOracle(): string {
  const env = process.env.CLAUDE_AGENT_NAME?.trim();
  if (env) return env;
  try {
    const s = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], { encoding: "utf8" });
    return s.trim().replace(/^[0-9]*-/, "") || "unknown";
  } catch {
    return "unknown";
  }
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" && Array.isArray(ctx.args) ? (ctx.args as string[]) : [];
  const sub = (args.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
  const write = (s: string) => { if (ctx.writer) ctx.writer(s); };

  if (sub !== "away" && sub !== "back") {
    return { ok: false, error: "usage: maw presence <away|back>", output: "" };
  }

  // kobo-868 — refuse instead of writing a pane-less marker. A paneless `away`
  // reads (presence-away.ts's deliberate oracle-level fallback) as covering
  // EVERY pane of the oracle, but `back` always carries a paneId and can only
  // clear its own pane — so one paneless away = the whole oracle stuck away
  // forever, un-clearable by any normal `back`. Applies to both away and back
  // so the two can never drift out of the same rule (see docs/presence-pane-identity.md).
  // Deliberately NOT falling back to a tmux query for our own pane id — an
  // empty/wrong target silently resolves to the CALLER's active pane
  // (core/pane-identity.ts), which would mislabel a different, innocent pane.
  const paneId = process.env.TMUX_PANE?.trim() || undefined;
  if (!paneId) {
    const reason =
      `refusing to write presence ${sub}: TMUX_PANE is not set, so this process cannot prove which pane it is.\n` +
      `  A presence marker with no pane id would silently cover every pane of this oracle (see docs/presence-pane-identity.md).\n` +
      `  Fix: run 'maw presence ${sub}' from inside the tmux pane it applies to — TMUX_PANE is set by tmux automatically.`;
    write(`\x1b[31m✗ presence ${sub} refused\x1b[0m — TMUX_PANE not set, nothing written (see docs/presence-pane-identity.md)`);
    return { ok: false, error: reason, output: "" };
  }

  const oracle = resolveOracle();
  const company = companyOfOracleLight(oracle) ?? undefined;
  const now = Date.now();
  appendWorklog({
    ts: now,
    iso: new Date(now).toISOString(),
    oracle,
    company,
    paneId,
    // back → kind:"back" (NOT idle): the away gate skips transparent idle turn-ends,
    // so a return must be a distinct kind or it would be skipped and away would stick (kobo-120).
    kind: sub === "away" ? "away" : "back",
    summary: sub === "away" ? "away (stepped out)" : "back (returned)",
  });

  write(sub === "away"
    ? "\x1b[33m○ away\x1b[0m — incoming hey parks to your inbox until you seat (nothing broadcast)"
    : "\x1b[32m● back\x1b[0m — receiving hey normally again");
  return { ok: true, output: "" };
}
