import { describe, expect, test } from "bun:test";
import { companyHtml } from "./company";

// The board half of this file (comment tree, card-detail sign block, board
// collapse/lanes, card deep-link) retired with the task subsystem. What remains
// is the presence pane's own readouts, which are rendered by the same page.

// kobo-443: ctxPct() lives inside the served client script (companyHtml's
// template literal), same as room.ts's client-side helpers — extract it
// straight from the served HTML the same way room.test.ts does for
// loadMermaidRenderer, rather than reimplementing it here (a reimplementation
// could silently drift from what actually ships).
function loadCtxPct() {
  const html = companyHtml();
  const start = html.indexOf("function ctxPct(p)");
  const end = html.indexOf("function renderPresence");
  const src = html.slice(start, end);
  return new Function(`${src}; return ctxPct;`)();
}

describe("ctxPct — board context% readout (kobo-443)", () => {
  test("normal row: a plain remaining_percentage passes through rounded", () => {
    const ctxPct = loadCtxPct();
    expect(ctxPct({ remaining_percentage: 29.6 })).toBe(30);
  });

  test("both null (no API call yet / just compacted): returns null, not 0", () => {
    const ctxPct = loadCtxPct();
    expect(ctxPct({ remaining_percentage: null, used_percentage: null })).toBeNull();
    expect(ctxPct({})).toBeNull();
  });

  // 🔴 the AC's named branch: total_input_tokens is the CUMULATIVE session
  // counter, not current usage — once it exceeds the pane's own window,
  // upstream's remaining_percentage/used_percentage are a lying flat 0/100.
  test("tok > win (cumulative counter exceeded the window): returns null, NEVER 0 and NEVER 100", () => {
    const ctxPct = loadCtxPct();
    const out = ctxPct({ total_input_tokens: 944264, context_window_size: 200000, remaining_percentage: 0, used_percentage: 100 });
    expect(out).toBeNull();
  });

  // regression guard: the tok>win guard must NOT swallow a genuinely-near-full
  // pane (tok <= win, remaining_percentage really is 0) — that's real signal.
  test("a real near-full pane (tok <= win, remaining_percentage genuinely 0) still shows 0, not masked to null", () => {
    const ctxPct = loadCtxPct();
    const out = ctxPct({ total_input_tokens: 199999, context_window_size: 200000, remaining_percentage: 0, used_percentage: 100 });
    expect(out).toBe(0);
  });

  // kobo-443 review (eq3 L1): at exactly tok == win the pane is legitimately
  // full — the number is not corrupt (corruption only starts once the
  // cumulative counter goes PAST the window) — so this must render 0, the
  // same as any other real near-full pane, not the em-dash. Pins the `>`
  // boundary: mutating it to `>=` stayed green with no test watching this.
  test("boundary: tok == win exactly is a legitimately full pane, renders 0 (not the em-dash)", () => {
    const ctxPct = loadCtxPct();
    const out = ctxPct({ total_input_tokens: 200000, context_window_size: 200000, remaining_percentage: 0, used_percentage: 100 });
    expect(out).toBe(0);
  });

  // the board shows REMAINING, not used — lock the DIRECTION explicitly (the
  // same family of bug as the statusline's inverted label, kobo-441): a
  // mostly-EMPTY pane (used_percentage low) must show a HIGH number here.
  test("direction: a mostly-empty pane (used_percentage low) reads as a HIGH percentage here (remaining, not used)", () => {
    const ctxPct = loadCtxPct();
    expect(ctxPct({ used_percentage: 5 })).toBe(95);
  });
});

// kobo-443: the ctx-span label direction fix — extract just the 3 lines that
// build the span (narrower than the whole renderPresence, which also drives
// roster grouping/pane-state unrelated to this bug) with a minimal `el` stub.
function loadCtxLabel(p: Record<string, any>) {
  const html = companyHtml();
  const start = html.indexOf("const pct = ctxPct(p);");
  const end = html.indexOf("row.appendChild(ctx);");
  const src = html.slice(start, end);
  const el = (_tag: string, cls: string, txt: string) => ({ className: cls, textContent: txt, title: "" });
  const ctxPct = loadCtxPct();
  return new Function("el", "ctxPct", "p", `${src}; return ctx;`)(el, ctxPct, p);
}

describe("ctx-span label direction (kobo-443 — same bug family as the statusline inversion)", () => {
  test("a normal pct states its OWN direction in the visible text, not just in a hover-only title", () => {
    const ctx = loadCtxLabel({ remaining_percentage: 42 });
    expect(ctx.textContent).toBe("ctx 42% left");
    expect(ctx.title).toBe("42% context remaining");
  });

  test("null still renders the unchanged em-dash — no regression", () => {
    const ctx = loadCtxLabel({});
    expect(ctx.textContent).toBe("ctx —");
    expect(ctx.title).toBe("");
  });

  test("stale pane: no title is set even when pct is known (existing behavior, unchanged)", () => {
    const ctx = loadCtxLabel({ remaining_percentage: 42, stale: true });
    expect(ctx.textContent).toBe("ctx 42% left");
    expect(ctx.title).toBe("");
  });
});

describe("presence cell clamp (kobo-284)", () => {
  const html = companyHtml();
  test(".p-last + .p-status clamp to 1 line with ellipsis (no multi-line spill)", () => {
    expect(html).toContain(".presence-cell .p-last { color:var(--fg); font-size:var(--t-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }");
    expect(html).toContain(".presence-cell .p-status { color:var(--st-meta); font-size:var(--t-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }");
    // the old multi-line spill is gone
    expect(html).not.toContain(".p-last { color:var(--fg); font-size:var(--t-sm); white-space:pre-wrap; word-break:break-word; }");
  });
  test("full text is preserved on hover via the title attribute", () => {
    expect(html).toContain("lastEl.title = lastTxt"); // p-last tooltip
    expect(html).toContain("statusEl.title = statusTxt"); // p-status tooltip
  });
});
