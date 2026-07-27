import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../scripts/lib/redact-secrets";

// kobo-427 — every fixture here is FABRICATED (structurally valid but never captured from
// a real system), per the card's own rule: a matched value must never be pasted anywhere,
// including a test fixture. These strings are shaped like the real patterns found in the
// ~/.maw sweep (card note), not copies of them.
const FAKE_PAT = "ghp_" + "aB3xY9qZ2wR7tK1mN5vC8sD4fG6hJ0pL"; // 36 chars after prefix, matches the real shape's length
const FAKE_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJmYWtlLXVzZXIiLCJpYXQiOjE1MTYyMzkwMjJ9",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
].join(".");
const FAKE_JWT_FRAGMENT = "eyJ" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(1).padEnd(70, "x");
// FABRICATED — a 2-segment credential-shaped blob (header + one more base64 segment, no
// third/signature segment). Shaped after a REAL gap found by grepping the actual produced
// archive (kobo-427 card note): the original pattern required BOTH the header AND the
// second segment to start with "eyJ", which only the header reliably does — a genuine
// 2-segment blob in the wild slipped through. This fixture reproduces that SHAPE, not the
// real value.
const FAKE_JWT_2SEG = "eyJhbGciOiJIUzI1NiJ9" + "x".repeat(50) + "." + "abcDEF123_-".repeat(15);
// FABRICATED — regression fixture for a second real gap: an earlier boundary check excluded
// `=` as a disqualifying preceding character, so a token immediately after a query-string-
// shaped `token=` separator (or right after another base64 segment's `=` padding) silently
// refused to start a match. `=` is padding/a separator, not part of a continuing run.
const FAKE_JWT_AFTER_EQUALS = "someval==" + "eyJ" + "fakeHeaderPayloadBody1234567890".repeat(2);

describe("redactSecrets (kobo-427)", () => {
  test("removes a GitHub-PAT-shaped value, keeps surrounding task text intact", () => {
    const input = `note: found a hardcoded token in a different repo's README: ${FAKE_PAT} — reporting it, not rotating it.`;
    const { text, counts } = redactSecrets(input);
    expect(text).not.toContain(FAKE_PAT);
    expect(text).toContain("found a hardcoded token in a different repo's README"); // non-secret text survives
    expect(text).toContain("reporting it, not rotating it."); // text AFTER the secret survives too
    expect(counts["github-pat"]).toBe(1);
  });

  test("removes a full 3-segment JWT, keeps the rest of the JSON structure intact", () => {
    const input = `{"authHeader":"Bearer ${FAKE_JWT}","room":"ruay","from":"web"}`;
    const { text, counts } = redactSecrets(input);
    expect(text).not.toContain(FAKE_JWT);
    expect(text).toContain('"room":"ruay"');
    expect(text).toContain('"from":"web"');
    expect(counts["jwt"]).toBe(1);
  });

  test("removes a lone JWT fragment (no adjoining dot) without touching a full JWT elsewhere in the same text", () => {
    const input = `stray header fragment: ${FAKE_JWT_FRAGMENT} ... full token later: ${FAKE_JWT}`;
    const { text, counts } = redactSecrets(input);
    expect(text).not.toContain(FAKE_JWT_FRAGMENT);
    expect(text).not.toContain(FAKE_JWT);
    expect(counts["jwt"]).toBe(2);
  });

  // regression fixture for the real archive-verification gap (see comment on FAKE_JWT_2SEG)
  test("removes a 2-segment credential-shaped blob whose second segment does NOT start with eyJ", () => {
    const input = `attached: ${FAKE_JWT_2SEG} end of message`;
    const { text, counts } = redactSecrets(input);
    expect(text).not.toContain(FAKE_JWT_2SEG);
    expect(text).toContain("end of message");
    expect(counts["jwt"]).toBe(1);
  });

  test("counts multiple occurrences of the same pattern, never returns the matched value itself", () => {
    const input = `${FAKE_PAT} and again ${FAKE_PAT}`;
    const { text, counts } = redactSecrets(input);
    expect(counts["github-pat"]).toBe(2);
    expect(text).not.toContain(FAKE_PAT);
    expect(JSON.stringify(counts)).not.toContain(FAKE_PAT.slice(4)); // the counts object itself carries no value fragment
  });

  test("text with no credential-shaped content passes through unchanged", () => {
    const input = "just a normal room message, nothing secret here";
    const { text, counts } = redactSecrets(input);
    expect(text).toBe(input);
    expect(counts).toEqual({});
  });

  // regression fixture for the second real archive-verification gap (see FAKE_JWT_AFTER_EQUALS)
  test("removes a JWT-shaped value immediately preceded by `=` (query-string separator / base64 padding boundary)", () => {
    const input = `redirect?token=${FAKE_JWT_AFTER_EQUALS} more text`;
    const { text, counts } = redactSecrets(input);
    expect(text).not.toContain(FAKE_JWT_AFTER_EQUALS);
    expect(text).toContain("more text");
    expect(counts["jwt"]).toBe(1);
  });
});
