/**
 * Inject slice — the small, token-bounded view the engine pushes back into an
 * agent before it acts (UserPromptSubmit) and when it wakes (SessionStart).
 *
 * Read-before-act, automatically: what the company has IN FLIGHT on the kobo
 * board (so you don't double-work) + the last few board events (so you're not
 * stale). Source of truth is the kobo API, not the worklog: the board is state
 * that cleans itself up when a card moves, whereas the worklog's open-claims
 * list had no TTL (72 open claims, oldest 45 days) and its activity lines were
 * mostly `Edit <long path>` — ~1500 tokens per prompt of things nobody read.
 *
 * The worklog store itself is untouched — openClaims()/readWorklog() keep every
 * one of their other readers (roster held, away-gate, statusline, kobo
 * supervisor, /api/worklog/feed). This module simply stopped being one of them.
 *
 * Deliberately NO fallback to the worklog when kobo is down (kobo-949): a stale
 * claims dump that appears only when the board is unreachable is exactly the
 * failure mode this replaced — one honest line is better.
 */

import { companyOfOracle } from "./company-scope";

const DEFAULT_EVENTS = 12;
const DEFAULT_BASE = "http://127.0.0.1:4171";
/** Whole-block budget. The hook that fetches this gives us 2s total (scripts/hooks/worklog-*.sh). */
const BUDGET_MS = 1_200;
/** Board lanes that mean "someone is on this right now". */
const IN_FLIGHT_LANES = new Set(["doing", "review"]);
/** Board bookkeeping — real, but not activity worth a line in every prompt. */
const NOISE_KINDS = new Set(["comment", "note", "work-order", "body-edited"]);
/** How many raw events back to look for this company's lines. */
const WINDOW = 400;
const MAX_SUMMARY = 90;

interface KoboCard { id: string; lane: string; assignee: string | null; pr?: number | null }
interface KoboEvent { seq: number; cardId: string; ts: string; who: string; kind: string; summary: string }

export interface SliceOpts {
  events?: number; // recent events to include
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The tail of the board's event log.
 *
 * kobo's /api/events is a forward-only cursor (`?since=` + oldest-first), with
 * no tail mode: `?limit=200` returns the FIRST 200 events ever recorded, not
 * the last 200. Pulling the whole log to read its end costs 4.1MB / 325ms today
 * (8,150 events) and grows without bound, so we binary-search for the end with
 * `limit=1` probes (~5ms each, ~10 of them) and then fetch one window.
 *
 * ponytail: delete this helper the day kobo-board grows `?tail=N` — it exists
 * only because the server can't answer "the last N" (follow-up card).
 */
async function tailEvents(base: string, signal: AbortSignal): Promise<KoboEvent[]> {
  const page = async (since: number, limit: number) =>
    (await getJson<{ events: KoboEvent[] }>(`${base}/api/events?since=${since}&limit=${limit}`, signal)).events ?? [];
  const hasAfter = async (seq: number) => (await page(seq, 1)).length > 0;

  let lo = 0; // known to have events after it
  let hi = 1024; // candidate end
  while (await hasAfter(hi)) { lo = hi; hi *= 2; }
  while (hi - lo > WINDOW) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasAfter(mid)) lo = mid; else hi = mid;
  }
  // A quiet company can have fewer than DEFAULT_EVENTS lines inside this window;
  // showing what's there beats paging backwards on every single prompt.
  return page(Math.max(0, lo - WINDOW), WINDOW * 3);
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "--:--" : d.toTimeString().slice(0, 5);
}

function clip(s: string): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1)}…` : one;
}

/** Build the inject text for an oracle (resolves its company). Empty string if nothing. */
export async function buildInjectSlice(oracle: string, opts: SliceOpts = {}): Promise<string> {
  const company = companyOfOracle(oracle);
  if (!company) return ""; // no company → no board to read; nothing to inject
  const base = process.env.MAW_KOBO_API || DEFAULT_BASE;

  let cards: KoboCard[];
  let events: KoboEvent[];
  try {
    const signal = AbortSignal.timeout(BUDGET_MS); // one deadline for every request in this build
    cards = (await getJson<{ cards: KoboCard[] }>(`${base}/api/board?company=${encodeURIComponent(company)}`, signal)).cards ?? [];
    events = await tailEvents(base, signal);
  } catch (e) {
    return `📋 kobo feed unavailable (${base}: ${e instanceof Error ? e.message : String(e)}) — board not read this turn`;
  }

  const ids = new Set(cards.map((c) => c.id)); // /api/events has no company filter — this set IS the filter
  const inFlight = cards.filter((c) => IN_FLIGHT_LANES.has(c.lane));
  const recent = events
    .filter((e) => ids.has(e.cardId) && !NOISE_KINDS.has(e.kind))
    .slice(-(opts.events ?? DEFAULT_EVENTS));

  if (!inFlight.length && !recent.length) return "";

  const parts: string[] = [`📋 kobo board — ${company} (auto-injected, read before acting):`];
  if (inFlight.length) {
    parts.push("", "in-flight (doing/review):");
    for (const c of inFlight) {
      parts.push(`  ${c.id} [${c.lane}] ${c.assignee ?? "unassigned"}${c.pr ? ` PR#${c.pr}` : ""}`);
    }
  }
  if (recent.length) {
    parts.push("", "recent board activity:");
    for (const e of recent) parts.push(`  ${hhmm(e.ts)} ${e.cardId} ${clip(e.summary) || e.kind} — ${e.who}`);
  }
  return parts.join("\n");
}
