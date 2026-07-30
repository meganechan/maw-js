/**
 * kobo-633 — WIRING test, not a unit test of an extracted helper. New
 * mutation-control rule this session (from a real kobo-647 incident, front
 * relayed): mutating an extracted function alone is not enough — a crew
 * mutated the extracted function and correctly saw RED, then eq3 mutated the
 * CALL SITE instead (the wiring that invokes it) and 74/74 tests stayed
 * green, because every test observed the function's return value directly,
 * never the actual served output. Extracting a function to make it testable
 * is good; it also moves what the test can see AWAY from where the result
 * actually lands. If a mutation test only exercises the point a test can
 * already see, it answers "does the test run," not "is the code pinned."
 *
 * `recordHeartbeat`/`pollPrsOnce` both have direct unit tests elsewhere
 * (`pr-watch-liveness.test.ts`, `pr-watch-backfill.test.ts`) — every one of
 * those calls `recordHeartbeat` DIRECTLY. None of them would notice if
 * `daemon.ts`'s own wiring (`pollAndHeartbeat` calling `recordHeartbeat`
 * after `pollPrsOnce`) were silently deleted. This file closes exactly that
 * gap: it calls ONLY `startDaemon()` (the real entrypoint `daemon.ts`
 * exports and the only thing `ecosystem.config.cjs`'s pm2 app actually
 * invokes), lets a REAL tick fire on a short interval, and checks the
 * ACTUAL heartbeat FILE on disk — the same artifact `prWatchLiveness()`
 * reads in production — never a function's return value in isolation.
 *
 * Deliberately imports `daemon.ts` and `pr-watch.ts` by their PLAIN paths
 * (no `?query` suffix) — daemon.ts itself imports pr-watch.ts by plain path
 * (see its own source), so this test must share that exact same module
 * instance to observe what daemon.ts actually does, not a separate copy.
 *
 * ⚠️ ISOLATION — deliberately does NOT import `core/xdg` (an earlier draft
 * did, to cross-check `mawStateDir()`/`mawDataDir()` the same way other
 * pr-watch tests do — reviewer should independently confirm this reasoning:
 * that cross-check is REDUNDANT here, not just extra, because this test
 * already forces the exact write paths via `__setMetaPathForTest`/
 * `__setSnapshotPathForTest` — the STRONGEST isolation this session
 * established, since it bypasses env-var resolution (and therefore `xdg`)
 * entirely. Importing `xdg` just to re-derive a fact the override seams
 * already guarantee would have needed widening this plugin's boundary test
 * (`plugin-serve-pr-watch-standalone.test.ts`'s `allowRelative`) — and that
 * widening applies to the WHOLE directory, not just test files (the
 * boundary helper can't scope by file), so it would have silently allowed
 * PRODUCTION code (`daemon.ts`/`index.ts`) to reach `core/xdg` too, with
 * nothing left to catch it. `MAW_HOME` is still set as defense-in-depth for
 * anything not routed through the override seams; the assertion below
 * checks the LOCAL constructed paths directly against the real `~/.maw`,
 * no `xdg` needed for that.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ORIG_HOME = process.env.MAW_HOME;
let root: string;
const REAL_MAW_DIR = join(homedir(), ".maw");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-daemon-wiring-"));
  process.env.MAW_HOME = root;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = ORIG_HOME;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("daemon.ts — real wiring, not the extracted function (kobo-633, kobo-647-shaped mutation gap)", () => {
  it("calling startDaemon() and letting one real tick fire actually writes a heartbeat file — through the daemon's OWN entrypoint, not a direct recordHeartbeat() call", async () => {
    const metaPath = join(root, "watch-pr-state.meta.json");
    const snapshotPath = join(root, "watch-pr-state.json");
    // The resolved-path assert this session's own rule requires — checked
    // directly, no `xdg` needed (see file header for why importing it here
    // would have been redundant AND would have widened the plugin boundary).
    if (metaPath.startsWith(REAL_MAW_DIR) || snapshotPath.startsWith(REAL_MAW_DIR)) {
      throw new Error(`test path resolved UNDER the real ~/.maw — refusing to run`);
    }

    // Plain-path imports — SAME module instances daemon.ts itself uses.
    const pw = await import("../../core/worklog/pr-watch");
    const { startDaemon } = await import("./daemon");

    pw.__setMetaPathForTest(() => metaPath);
    pw.__setSnapshotPathForTest(() => snapshotPath);
    pw.__resetHeartbeatCountForTest();
    // No real gh calls: empty task store => openPrLinkedRepos()/scanWorktrees
    // resolve to nothing to poll, pollPrsOnce resolves near-instantly and
    // harmlessly — this test is about the WIRING firing, not poll content.
    pw.__setGhForTest(async () => "[]");

    expect(existsSync(metaPath)).toBe(false); // nothing yet — sanity before the real tick

    const handle = startDaemon(30); // 30ms — short enough for a real tick in a test
    try {
      // kobo-633 — was a fixed 500ms sleep-then-check (already bumped once
      // from 200ms after measuring flaky under test-runner overhead — the
      // same shape of fix that doesn't hold, same class as kobo-631's own
      // "6/6" timeout test before it switched to injected determinism). A
      // fixed wall-clock margin racing a real setInterval tick against real
      // subprocess contention (this suite also spawns real OS processes in
      // daemon-process-kill.test.ts) has no ceiling that's safe on every
      // machine/load. Poll for the actual artifact instead: this only cares
      // THAT a tick landed, not how long it took, so wait for the file to
      // exist rather than sleeping a guessed duration and hoping.
      const deadline = Date.now() + 1800; // stays under this test's own 2000ms timeout
      while (!existsSync(metaPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(metaPath)).toBe(true); // the daemon's OWN wiring produced this, not a direct call
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      expect(meta.pollsCompleted).toBeGreaterThanOrEqual(1);
    } finally {
      handle.stop();
      pw.__resetMetaPathForTest();
      pw.__resetSnapshotPathForTest();
      pw.__resetGhForTest();
      pw.__resetHeartbeatCountForTest();
    }
  }, 2000);
});
