/**
 * kobo-835 — `maw hey-audit`: "in the last 24h, which hey landed somewhere other
 * than what the operator typed?"
 *
 * Reads two kinds of row out of the same audit.jsonl:
 *
 *   {cmd:"hey", args:[...]}  — written by cli.ts at process start, since forever.
 *                              Carries the TYPED target and nothing else.
 *   {kind:"hey-route", ...}  — written after a successful send (core/fleet/audit.ts).
 *                              Carries where it actually landed.
 *
 * The two are reported side by side ON PURPOSE. Every row of the first kind with
 * no matching row of the second is a send this tool cannot judge, and a summary
 * that hid that would answer "0 mismatches" for a machine where the instrument
 * has never run — the exact shape of "zero because nobody complained" that this
 * card exists to stop reporting as "zero because it did not happen".
 */
import { readAudit } from "../../core/fleet/audit";
import { parseFlags } from "../../cli/parse-args";

type Row = {
  ts?: string;
  kind?: string;
  cmd?: string;
  args?: string[];
  query?: string;
  resolvedTarget?: string;
  resolvedWhere?: string;
  resolvedBy?: string;
  route?: string;
  node?: string;
};

/** `24h` / `90m` / `7d` / an ISO timestamp → epoch ms. null when unparseable. */
export function parseSince(spec: string, now = Date.now()): number | null {
  const rel = spec.trim().match(/^(\d+)\s*([smhdw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[rel[2]!.toLowerCase()]!;
    return now - n * unit;
  }
  const abs = new Date(spec).getTime();
  return Number.isNaN(abs) ? null : abs;
}

/** Strip the decoration an oracle's name picks up in session/window names. */
function bareName(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\d+-/, "").replace(/-oracle$/, "");
}

/** Flags on `maw hey` that swallow the next argv entry, so it is not the target. */
const VALUE_FLAGS = new Set(["--from", "--channel", "--node", "--as"]);

/** The target the operator typed, pulled back out of the logged argv. */
export function typedTarget(args: string[] | undefined): string | null {
  const rest = (args ?? []).slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

export type TargetShape = "short-name" | "node-prefixed" | "pane-address";

/**
 * Which of the three ways of naming a target this one is. `short-name` is the
 * line where the system guesses; the other two name a node or a pane outright.
 */
export function targetShape(target: string): TargetShape {
  const t = target.trim();
  if (/^[^:]+:\d+(\.\d+)?$/.test(t) || t.startsWith("%")) return "pane-address";
  if (t.includes(":")) return "node-prefixed";
  return "short-name";
}

/**
 * Did it land on the oracle that was named?
 *
 * Deliberately an EXACT match against the names at the destination, not a
 * substring test: the misroute this card was opened for (`m5:helm` →
 * `13-patchwork:0.1`) landed in a window whose name CONTAINS "helm", so a
 * substring test calls that delivery correct — the check would agree with the
 * bug. `undefined` means unjudgeable (the operator named a pane index, or the
 * destination has no readable name), which is reported apart from "matched".
 */
export function heyRouteMismatch(row: Row): boolean | undefined {
  const query = (row.query ?? "").trim();
  if (!query) return undefined;
  if (row.resolvedBy === "exact-pane-address") return undefined;
  // `session:0` / `session:0.1` — the operator picked the pane themselves.
  const afterColon = query.includes(":") ? query.slice(query.indexOf(":") + 1) : query;
  if (/^\d+(\.\d+)?$/.test(afterColon)) return undefined;

  const wanted = bareName(afterColon);
  if (!wanted) return undefined;

  const place = row.resolvedWhere || row.resolvedTarget || "";
  if (!place || place.startsWith("%")) return undefined; // a raw pane id names nobody
  const names = place.split(":").map(bareName).filter(Boolean);
  if (!names.length) return undefined;
  return !names.includes(wanted);
}

export interface HeyAuditSummary {
  since: string;
  typed: number;
  byShape: Record<TargetShape, number>;
  routed: number;
  matched: number;
  mismatched: number;
  unjudgeable: number;
  mismatches: Row[];
}

export function summarizeHeyAudit(rows: Row[], sinceMs: number): HeyAuditSummary {
  const inWindow = rows.filter((r) => r.ts && new Date(r.ts).getTime() >= sinceMs);
  const summary: HeyAuditSummary = {
    since: new Date(sinceMs).toISOString(),
    typed: 0,
    byShape: { "short-name": 0, "node-prefixed": 0, "pane-address": 0 },
    routed: 0,
    matched: 0,
    mismatched: 0,
    unjudgeable: 0,
    mismatches: [],
  };

  for (const r of inWindow) {
    if (r.kind === "hey-route") {
      summary.routed++;
      const bad = heyRouteMismatch(r);
      if (bad === undefined) summary.unjudgeable++;
      else if (bad) { summary.mismatched++; summary.mismatches.push(r); }
      else summary.matched++;
      continue;
    }
    if (r.cmd === "hey" && !r.kind) {
      summary.typed++;
      const target = typedTarget(r.args);
      if (target) summary.byShape[targetShape(target)]++;
    }
  }
  return summary;
}

function pct(n: number, of: number): string {
  return of ? ` (${Math.round((n / of) * 100)}%)` : "";
}

export async function cmdHeyAudit(args: string[] = []): Promise<void> {
  const flags = parseFlags(args, { "--since": String, "--mismatch": Boolean, "--json": Boolean }, 0);
  const sinceSpec = (flags["--since"] as string) || "24h";
  const sinceMs = parseSince(sinceSpec);
  if (sinceMs === null) {
    console.error(`\x1b[31merror\x1b[0m: could not read --since '${sinceSpec}' (try 24h, 7d, or an ISO timestamp)`);
    process.exitCode = 1;
    return;
  }

  const rows: Row[] = [];
  for (const line of readAudit(Number.MAX_SAFE_INTEGER)) {
    try { rows.push(JSON.parse(line) as Row); } catch { /* skip malformed */ }
  }
  const s = summarizeHeyAudit(rows, sinceMs);

  if (flags["--json"]) {
    console.log(JSON.stringify(flags["--mismatch"] ? { since: s.since, mismatches: s.mismatches } : s, null, 2));
    return;
  }

  if (flags["--mismatch"]) {
    if (!s.mismatches.length) {
      console.log(`\x1b[90mno mismatched hey since ${s.since} — out of ${s.routed} routed send(s)\x1b[0m`);
      if (!s.routed) console.log(`\x1b[33m⚠\x1b[0m  ${s.typed} hey were typed in this window and NONE carry a route row, so this is "not measured", not "not happening".`);
      return;
    }
    console.log(`\x1b[31m${s.mismatches.length} mismatched hey\x1b[0m since ${s.since}\n`);
    for (const m of s.mismatches) {
      console.log(`  \x1b[90m${m.ts}\x1b[0m  typed \x1b[36m${m.query}\x1b[0m → landed \x1b[31m${m.resolvedTarget}\x1b[0m` +
        `${m.resolvedWhere ? ` (${m.resolvedWhere})` : ""} \x1b[90m[by=${m.resolvedBy} route=${m.route}]\x1b[0m`);
    }
    console.log();
    return;
  }

  console.log(`\x1b[36mhey routing\x1b[0m since ${s.since}\n`);
  console.log(`  hey typed              ${s.typed}`);
  console.log(`    short name           ${s.byShape["short-name"]}${pct(s.byShape["short-name"], s.typed)}  \x1b[90m← the line where the target is guessed\x1b[0m`);
  console.log(`    node:agent           ${s.byShape["node-prefixed"]}${pct(s.byShape["node-prefixed"], s.typed)}`);
  console.log(`    pane address         ${s.byShape["pane-address"]}${pct(s.byShape["pane-address"], s.typed)}`);
  console.log(`  route rows recorded    ${s.routed}${pct(s.routed, s.typed)}`);
  console.log(`    landed as named      ${s.matched}`);
  console.log(`    \x1b[31mmismatched\x1b[0m           ${s.mismatched}`);
  console.log(`    not judgeable        ${s.unjudgeable} \x1b[90m(operator named the pane, or destination has no readable name)\x1b[0m`);
  if (s.typed && !s.routed) {
    console.log(`\n\x1b[33m⚠\x1b[0m  no route rows in this window: every send above predates the instrument (kobo-835) on this host.`);
    console.log(`   Read the mismatch count as UNMEASURED, not as zero.`);
  }
  console.log(`\n\x1b[90mmaw hey-audit --since ${sinceSpec} --mismatch   # list them\x1b[0m`);
}
