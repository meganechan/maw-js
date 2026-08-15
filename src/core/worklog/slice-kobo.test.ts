/**
 * kobo-949 — the auto-inject block is the kobo board, not the worklog.
 *
 * Every test here runs against a STUB kobo API that reproduces the real one's
 * two awkward properties (measured against 127.0.0.1:4171 on 2026-08-14):
 *   - /api/board?company= returns EVERY lane for the company, not just in-flight
 *   - /api/events is a forward-only cursor: `?limit=200` returns the FIRST 200
 *     events ever recorded, never the last 200, and carries no company filter
 * so a regression that "filters" by trusting the server is guaranteed to fail
 * here rather than silently inject another company's log.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildInjectSlice } from "./slice";
import { appendWorklog } from "./store";
import { _setCompaniesDir, saveCompany, COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";
import { _clearScopeCache } from "./company-scope";

interface StubCard { id: string; company: string; lane: string; assignee: string | null; pr?: number | null }
interface StubEvent { seq: number; cardId: string; ts: string; who: string; kind: string; summary: string }

/**
 * Stub of the real kobo API — same cursor contract as kobo-board's handleEvents:
 * `SELECT * FROM events WHERE seq > since ORDER BY seq LIMIT limit`.
 */
function startStubKobo(cards: StubCard[], events: StubEvent[]) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/board") {
        const company = url.searchParams.get("company");
        const mine = cards.filter((c) => c.company === company);
        return Response.json({ ok: true, count: mine.length, cards: mine });
      }
      if (url.pathname === "/api/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const page = events.filter((e) => e.seq > since).slice(0, limit);
        return Response.json({ ok: true, cursor: page.length ? page[page.length - 1]!.seq : since, events: page });
      }
      return new Response("nope", { status: 404 });
    },
  });
}

function ev(seq: number, cardId: string, kind: string, summary: string, who = "eq3"): StubEvent {
  return { seq, cardId, ts: new Date(1_760_000_000_000 + seq * 1000).toISOString(), who, kind, summary };
}

let companiesDir: string;
const origCompaniesDir = COMPANIES_DIR;
const origApi = process.env.MAW_KOBO_API;

beforeAll(() => {
  process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "kobo949-data-"));
  companiesDir = mkdtempSync(join(tmpdir(), "kobo949-reg-"));
  _setCompaniesDir(join(companiesDir, "companies"));
  // Two companies on one board: the inject for `mine` must never leak `other`.
  saveCompany({ name: "mine", manager: "kobo949bot", teams: { core: { lead: "kobo949bot", members: [{ oracle: "kobo949bot", role: "lead" }] } } } as any);
  saveCompany({ name: "other", manager: "zz", teams: { core: { lead: "zz", members: [{ oracle: "zz", role: "lead" }] } } } as any);
  // scopeOfOracle memoizes HITS per process. Sharing a Bun process with any file
  // that already resolved an oracle against this machine's REAL registry would
  // otherwise hand us its real company and quietly query the stub for cards that
  // aren't there — an empty inject that looks like a code bug.
  _clearScopeCache();
});

afterAll(() => {
  _setCompaniesDir(origCompaniesDir);
  _clearScopeCache();
  rmSync(companiesDir, { recursive: true, force: true });
  if (origApi === undefined) delete process.env.MAW_KOBO_API; else process.env.MAW_KOBO_API = origApi;
});

describe("inject slice — kobo feed (kobo-949)", () => {
  it("filters events to the company's OWN cards (the events API has no company filter)", async () => {
    const server = startStubKobo(
      [
        { id: "k-1", company: "mine", lane: "doing", assignee: "eq3", pr: 451 },
        { id: "k-2", company: "other", lane: "doing", assignee: "zz" },
      ],
      [ev(1, "k-2", "move", "OTHER-COMPANY-MARKER", "zz"), ev(2, "k-1", "move", "MY-COMPANY-MARKER")],
    );
    process.env.MAW_KOBO_API = server.url.origin;
    try {
      const out = await buildInjectSlice("kobo949bot");
      expect(out).toContain("MY-COMPANY-MARKER");
      expect(out).not.toContain("OTHER-COMPANY-MARKER");
      expect(out).not.toContain("k-2"); // no other-company card id anywhere in the block
      expect(out).toContain("k-1");
      expect(out).toContain("doing");
      expect(out).toContain("eq3");
      expect(out).toContain("451"); // pr number of the in-flight card
    } finally {
      server.stop(true);
    }
  });

  it("drops noise kinds (comment/note/work-order/body-edited) from the event lines", async () => {
    const server = startStubKobo(
      [{ id: "k-1", company: "mine", lane: "doing", assignee: "eq3" }],
      [
        ev(1, "k-1", "comment", "NOISE-COMMENT"),
        ev(2, "k-1", "note", "NOISE-NOTE"),
        ev(3, "k-1", "work-order", "NOISE-WORK-ORDER"),
        ev(4, "k-1", "body-edited", "NOISE-BODY-EDITED"),
        ev(5, "k-1", "move", "SIGNAL-MOVE"),
      ],
    );
    process.env.MAW_KOBO_API = server.url.origin;
    try {
      const out = await buildInjectSlice("kobo949bot");
      expect(out).toContain("SIGNAL-MOVE");
      for (const noise of ["NOISE-COMMENT", "NOISE-NOTE", "NOISE-WORK-ORDER", "NOISE-BODY-EDITED"]) {
        expect(out).not.toContain(noise);
      }
    } finally {
      server.stop(true);
    }
  });

  it("degrades to ONE line when the kobo API is down — and never falls back to the worklog", async () => {
    // A worklog entry + an open claim that the OLD inject would have rendered.
    appendWorklog({ ts: 10, iso: "i", oracle: "eq3", company: "mine", kind: "claim", summary: "claim: WORKLOG-FALLBACK-MARKER", task: "WORKLOG-FALLBACK-MARKER" });
    appendWorklog({ ts: 11, iso: "i", oracle: "eq3", company: "mine", kind: "tool", summary: "git WORKLOG-ACTIVITY-MARKER" });

    // Port 1 on loopback: nothing listens, connection refused immediately.
    process.env.MAW_KOBO_API = "http://127.0.0.1:1";
    const out = await buildInjectSlice("kobo949bot");

    expect(out.split("\n")).toHaveLength(1);
    expect(out.toLowerCase()).toContain("kobo");
    expect(out.toLowerCase()).toContain("unavailable");
    expect(out).not.toContain("WORKLOG-FALLBACK-MARKER");
    expect(out).not.toContain("WORKLOG-ACTIVITY-MARKER");
    expect(out).not.toContain("open claims");
  });

  it("in-flight section is doing/review only — done/triage/reject stay out", async () => {
    const server = startStubKobo(
      [
        { id: "k-doing", company: "mine", lane: "doing", assignee: "eq3" },
        { id: "k-review", company: "mine", lane: "review", assignee: "patchwork", pr: 12 },
        { id: "k-done", company: "mine", lane: "done", assignee: "eq3" },
        { id: "k-triage", company: "mine", lane: "triage", assignee: null },
        { id: "k-reject", company: "mine", lane: "reject", assignee: "eq3" },
      ],
      [ev(1, "k-done", "move", "DONE-CARD-EVENT")],
    );
    process.env.MAW_KOBO_API = server.url.origin;
    try {
      const out = await buildInjectSlice("kobo949bot");
      const inFlight = out.split("recent")[0]!;
      expect(inFlight).toContain("k-doing");
      expect(inFlight).toContain("k-review");
      expect(inFlight).not.toContain("k-done");
      expect(inFlight).not.toContain("k-triage");
      expect(inFlight).not.toContain("k-reject");
      // events of a done card still count as activity — only the in-flight list is lane-filtered
      expect(out).toContain("DONE-CARD-EVENT");
    } finally {
      server.stop(true);
    }
  });

  it("shows the NEWEST events, not the first page of the cursor (log longer than one page)", async () => {
    const events: StubEvent[] = [];
    for (let i = 1; i <= 900; i++) events.push(ev(i, "k-1", "move", `EVENT-${i}`));
    const server = startStubKobo([{ id: "k-1", company: "mine", lane: "doing", assignee: "eq3" }], events);
    process.env.MAW_KOBO_API = server.url.origin;
    try {
      const out = await buildInjectSlice("kobo949bot");
      expect(out).toContain("EVENT-900"); // newest
      expect(out).not.toContain("EVENT-1 "); // oldest — what `?limit=200` would have returned
      expect(out).not.toContain("EVENT-200");
      expect(out.split("\n").length).toBeLessThan(25); // stays token-bounded
    } finally {
      server.stop(true);
    }
  });
});
