#!/usr/bin/env bun
// scripts/test-src-known-red-check.mjs — kobo-472 "path 3": test-src.sh is
// allowed to have a fixed, named set of already-known-broken tests without
// failing the job for the SAME reason every run. This is the gate that keeps
// that allowlist honest. It has three jobs, and skipping any one of them
// turns the allowlist into a silent graveyard (kobo-472 note, AC1-3):
//
//   1. NEW red (a failure NOT on the allowlist) -> fail loudly, name it
//      "NEW FAILURE" so nobody mistakes it for expected debt.
//   2. EXPIRED allowlist entries (a listed test that now PASSES) -> fail
//      loudly too, name it "EXPIRED" so whoever reads the log knows to
//      DELETE the line, not go hunting for a regression that isn't there.
//   3. Any allowlist entry missing `card` or `owner` -> hard error before
//      even comparing, so an ownerless line can never silently exist
//      (kobo-472 AC2: "no owner = no one removes it = graveyard").
//
// Exit code is the actual gate (kobo-472 AC3, kobo-476 lesson): printing a
// message is not enough if the job still exits 0. Only an EXACT set match
// between "tests bun actually reported as failing" and "the allowlist"
// exits 0.
import { readFileSync } from "node:fs";

const [, , logPath, allowlistPath] = process.argv;
if (!logPath || !allowlistPath) {
  console.error("usage: test-src-known-red-check.mjs <captured-test-output-file> <allowlist.json>");
  process.exit(2);
}

const allowlistRaw = JSON.parse(readFileSync(allowlistPath, "utf8"));
if (!Array.isArray(allowlistRaw)) {
  console.error(`error: ${allowlistPath} must be a JSON array`);
  process.exit(2);
}

// AC2 — every line must be traceable to a card and an owner, or it doesn't
// get to exist. Enforced here, not left to convention/review discipline.
const badEntries = allowlistRaw.filter((e) => !e || typeof e.test !== "string" || !e.card || !e.owner);
if (badEntries.length > 0) {
  console.error("error: scripts/test-src-known-red.json has entr(y/ies) missing `test`, `card`, or `owner`:");
  for (const e of badEntries) console.error(`  ${JSON.stringify(e)}`);
  console.error("every known-red line must name the card that owns it and who owns that card — no anonymous entries.");
  process.exit(2);
}

const allowByTest = new Map(allowlistRaw.map((e) => [e.test, e]));

// bun prints each failure inline as it happens — `(fail) <full test name>`,
// optionally suffixed with `[123.00ms]` — interleaved with `(pass)`/`(skip)`
// lines and stack traces, NOT collected into a separate end-of-run "N tests
// failed:" recap block (that recap only exists as `gh run view --log-failed`'s
// OWN synthesized header, not in bun's actual stdout — confirmed by diffing
// against the raw, non-synthesized GH Actions log for run 30339030797:
// zero occurrences of "tests failed:" in it). Matching the recap block here
// would silently see zero failures on every real run and misreport every
// known-red entry as "expired" — this must scan every line directly instead.
const log = readFileSync(logPath, "utf8");
const failLines = log
  .split("\n")
  .filter((l) => l.startsWith("(fail) "))
  .map((l) => l.slice("(fail) ".length).replace(/\s*\[[\d.]+m?s\]\s*$/, "").trim());

const actualFailSet = new Set(failLines);

const newFailures = [...actualFailSet].filter((t) => !allowByTest.has(t));
const expiredEntries = allowlistRaw.filter((e) => !actualFailSet.has(e.test));

let ok = true;

if (newFailures.length > 0) {
  ok = false;
  console.error("");
  console.error(`🔴 NEW FAILURE — ${newFailures.length} test(s) failing that are NOT on the known-red allowlist. Investigate these, don't touch the allowlist:`);
  for (const t of newFailures) console.error(`  - ${t}`);
}

if (expiredEntries.length > 0) {
  ok = false;
  console.error("");
  console.error(`🟢 EXPIRED — ${expiredEntries.length} allowlist entr(y/ies) now PASS. Nothing is broken; DELETE these lines from scripts/test-src-known-red.json, don't go looking for a regression:`);
  for (const e of expiredEntries) console.error(`  - [${e.card} / @${e.owner}] ${e.test}`);
}

if (!ok) {
  console.error("");
  console.error("test-src-known-red-check: FAIL — the allowlist and reality disagree (see above).");
  process.exit(1);
}

console.log(`test-src-known-red-check: PASS — ${actualFailSet.size} known-red test(s), all accounted for, no drift either direction.`);
