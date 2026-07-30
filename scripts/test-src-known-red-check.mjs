#!/usr/bin/env bun
// scripts/test-src-known-red-check.mjs — kobo-472: test:src is allowed a
// small, NAMED set of already-known-broken tests (scripts/test-src-known-red.json,
// each entry owned by a card) without blocking the job on every one of them
// being fixed first (Tony-approved direction). This is the gate that keeps
// that list honest — checked in BOTH directions, or it only ever grows:
//
//   1. NEW red (a failure NOT on the list) -> fail loudly, name it as new.
//   2. EXPIRED entries (a listed test that now PASSES) -> fail loudly too,
//      say DELETE this line — don't go hunting a phantom regression.
//   3. Any entry missing `card` or `owner` -> hard error before comparing;
//      an ownerless line can never silently exist.
//
// Design ported from kobo-472's own earlier PR (#326, stitch) — the
// bidirectional exact-set-diff approach already solved this correctly; no
// reason to reinvent it. Adapted here to a fresh discovery run rather than
// carrying that PR's stale commits forward (its known-red set no longer
// matches what a fresh run on current alpha actually finds).
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

const badEntries = allowlistRaw.filter((e) => !e || typeof e.test !== "string" || !e.card || !e.owner);
if (badEntries.length > 0) {
  console.error("error: scripts/test-src-known-red.json has entr(y/ies) missing `test`, `card`, or `owner`:");
  for (const e of badEntries) console.error(`  ${JSON.stringify(e)}`);
  console.error("every known-red line must name the card that owns it and who owns that card — no anonymous entries.");
  process.exit(2);
}

const allowByTest = new Map(allowlistRaw.map((e) => [e.test, e]));

// bun prints each failure inline as `(fail) <full test name>`, optionally
// suffixed with `[123.00ms]`, interleaved with (pass)/(skip) — never
// collected into a separate end-of-run recap in bun's own stdout.
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
  console.error(`NEW FAILURE — ${newFailures.length} test(s) failing that are NOT on the known-red allowlist. Investigate these, don't touch the allowlist:`);
  for (const t of newFailures) console.error(`  - ${t}`);
}

if (expiredEntries.length > 0) {
  ok = false;
  console.error("");
  console.error(`EXPIRED — ${expiredEntries.length} allowlist entr(y/ies) now PASS. Nothing is broken; DELETE these lines from scripts/test-src-known-red.json, don't go looking for a regression:`);
  for (const e of expiredEntries) console.error(`  - [${e.card} / @${e.owner}] ${e.test}`);
}

if (!ok) {
  console.error("");
  console.error("test-src-known-red-check: FAIL — the allowlist and reality disagree (see above).");
  process.exit(1);
}

console.log(`test-src-known-red-check: PASS — ${actualFailSet.size} known-red test(s), all accounted for, no drift either direction.`);
