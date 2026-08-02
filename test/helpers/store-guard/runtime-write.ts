/**
 * Same mutator, run as PRODUCTION runtime (`bun <file>`, not `bun test`).
 * The guard is loaded only by bunfig's `[test] preload`, so this must still
 * write — that is the byte-identical-runtime assertion in
 * test/isolated/store-guard-real-home.test.ts.
 */
import { appendWorklog, worklogPath } from "../../../src/core/worklog/store";

appendWorklog({
  ts: Date.now(),
  iso: new Date().toISOString(),
  oracle: "store-guard-fixture",
  company: "store-guard-fixture",
  kind: "tool",
  summary: "runtime write — must NOT be guarded",
});

console.log(worklogPath("store-guard-fixture"));
