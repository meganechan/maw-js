/**
 * kobo-427 — redact credential-shaped values from text before they leave `~/.maw` in a
 * backup archive. Filters IN PLACE (Tony's ruling, option b: filter or encrypt; this picks
 * filter) — a redaction marker replaces only the matched substring, so the rest of the
 * file (task text, room messages, everything non-secret) survives the round trip. AC:
 * "filtering must not lose task data."
 *
 * Patterns are the value-SHAPE, not a field-name guess (kobo-415's F5/F6 lesson: a field
 * named "token" holding nothing is not a leak, and a secret pasted into ordinary note text
 * has no field name to key on at all — this is exactly that case, a GitHub PAT quoted
 * inside a task note). Every pattern here was confirmed present in the real ~/.maw sweep
 * (kobo-427 card note) before being added — this is not a speculative list.
 */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g },
  // JWT: only the FIRST segment (the header) reliably encodes to "eyJ" (base64 of `{"`).
  // The payload segment's leading bytes depend on its first JSON key and do NOT reliably
  // start with "eyJ" — an earlier version of this pattern required BOTH segments to start
  // with "eyJ" and missed a real 2-segment credential-shaped blob in the wild (caught by
  // grepping the REAL produced archive, not by re-reading this regex — exactly the AC's own
  // point). Matches 1, 2, or 3 dot-separated segments in one pass so a partial/truncated
  // token (missing its signature) is still fully redacted, not just its header segment.
  //
  // Boundary chars: the lookbehind/lookahead exclude only [A-Za-z0-9_-] — characters that
  // would mean we're mid-run of the SAME base64 body — NOT `=`. `=` is base64 PADDING: it
  // legitimately ends a segment ("...xyz=") or precedes one in a query-string-shaped
  // separator ("token=eyJ..."). An earlier version excluded `=` from the boundary too and
  // silently refused to start a match right after it — found the same way as the 2-segment
  // gap above, by grepping the real archive a second time after "fixing" it once.
  { name: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_=-]{20,}(?:\.[A-Za-z0-9_=-]{10,}){0,2}(?![A-Za-z0-9_-])/g },
];

export interface RedactResult {
  text: string;
  counts: Record<string, number>;
}

/** Replace every credential-shaped match with a fixed, greppable marker. Never returns the matched value anywhere — not in `counts`, not in a log, not in the returned text. */
export function redactSecrets(input: string): RedactResult {
  let text = input;
  const counts: Record<string, number> = {};
  for (const { name, re } of PATTERNS) {
    let n = 0;
    text = text.replace(re, () => { n++; return `[REDACTED-kobo427:${name}]`; });
    if (n > 0) counts[name] = n;
  }
  return { text, counts };
}
