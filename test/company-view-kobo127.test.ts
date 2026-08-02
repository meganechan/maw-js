import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-127 — the company page is a single-file HTML+CSS+JS template (companyHtml).
// It has no runtime here to unit-test the DOM, so pin the STRUCTURAL markers a
// refactor must not silently drop. The four board-display markers this file also
// pinned (assignee chip, note clamp, Done-lane fold, epic rollup) went with the
// task subsystem; the State tab they were split out of is what remains.
describe("company view — kobo-127 State tab", () => {
  const html = companyHtml();

  test("state.md renders in its own State tab", () => {
    expect(html).toContain('data-tab="state"'); // nav tab + tabpanel
    expect(html).toContain('id="tab-count-state"');
    // the state panel lives inside the state tabpanel
    expect(html).toContain('id="state-panel"');
    expect(html).toMatch(/data-tab="state"[^]*id="state-panel"/); // panel is inside the state section
  });

});
