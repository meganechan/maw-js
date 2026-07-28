import { describe, expect, test } from "bun:test";
import { companyStatusHtml } from "../src/views/company-status";

// kobo-445 — Tony's own explicit constraint: the company-status page is READ-ONLY,
// no command buttons at all (a second card covers write actions later). Pin it so a
// future edit that adds a POST/PUT/DELETE fetch here can't slip past review. The
// board is a single-file HTML+JS template (no runtime here) — same string-pin
// approach as kobo-198/kobo-263 (no jsdom in repo).
describe("company-status view — kobo-445 read-only gate", () => {
  const html = companyStatusHtml();

  test("no POST/PUT/DELETE anywhere in the served page", () => {
    expect(html).not.toMatch(/method\s*:\s*['"](POST|PUT|DELETE)['"]/i);
    expect(html).not.toMatch(/\.method\s*=\s*['"](POST|PUT|DELETE)['"]/i);
  });

  test("only fetch()es GET endpoints — no postJson/write helper exists on this page", () => {
    // every getJson(...) call target a GET-only read route; postJson doesn't exist here at all
    expect(html).not.toContain("postJson");
    expect(html).toContain("getJson('/api/roster?company=");
    expect(html).toContain("getJson('/api/presence?company=");
    expect(html).toContain("getJson('/api/worklog/feed?company=");
    // kobo-445 review round 1: /api/tasks dropped entirely — /api/roster's `pending`
    // field (server-side, ~4KB) replaced it instead of a second 848KB/532-file scan.
    expect(html).not.toContain("/api/tasks");
  });

  test("missing data renders an explicit no-data message, never a fabricated 0/empty-looking value", () => {
    expect(html).toContain("pct == null ? 'ctx —'"); // no presence sample → em-dash, not "ctx 0%"
    expect(html).toContain("'no live pane'"); // no panes for this oracle → says so
    expect(html).toContain("'nothing pending'"); // no pending cards → says so
    expect(html).toContain("'no recent activity'"); // no worklog entries → says so
    expect(html).toContain("'no roster members'"); // empty roster → says so
  });

  test("pending list has no client-side done/rejected filter — the server (pendingTasksByOracle) already excludes terminal states, so a closed card is simply absent", () => {
    // if this ever reads `pending[member.oracle]` through an extra done/rejected check,
    // that's a second, driftable copy of the filter — it should stay server-only.
    expect(html).not.toMatch(/state\s*===\s*['"]done['"]/);
    expect(html).not.toMatch(/state\s*===\s*['"]rejected['"]/);
    expect(html).toContain("const oraclePending = pending[member.oracle] || [];");
  });

  test("polling never overlaps a still-in-flight request", () => {
    expect(html).toContain("let loadInFlight = false;");
    expect(html).toContain("if (loadInFlight) return;");
  });
});
