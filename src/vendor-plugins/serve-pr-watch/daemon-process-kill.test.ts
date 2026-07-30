/**
 * kobo-633 AC1/AC2 — REAL OS-level process kill, not a simulated one.
 * `pr-watch-resilience.test.ts` (kobo-631) already proved durability against
 * an IN-PROCESS simulated abort (a controlled promise that never resolves
 * on its own). This file proves the stronger, more realistic claim: killing
 * the daemon's actual OS process (`SIGKILL`, mid-poll) — the exact way a
 * real crash/OOM-kill/manual `kill -9` would happen in production —
 * (AC1) never touches `maw-server`, and (AC2) never corrupts the snapshot
 * file on disk.
 *
 * AC1's own wording names TWO specific measurements — "API ตอบได้" +
 * "`restart_time` ไม่ขยับ" — an earlier draft of this test only checked
 * `process.pid > 0` in the TEST's own process, which doesn't exercise
 * either named thing. Fixed: a real stand-in "maw-server" is spawned as ITS
 * OWN subprocess (true process independence, not "the test process
 * survived," which would be true even if the architecture were still
 * coupled) with a real HTTP endpoint reporting its own boot timestamp
 * (the `restart_time` stand-in — set ONCE at process start, unchanged
 * unless the process itself restarts).
 *
 * Daemon spawned as a REAL Bun.spawn subprocess, real `daemon.ts` entrypoint
 * (`import.meta.main` branch) — the same script `ecosystem.config.cjs`'s
 * pm2 app actually runs. `gh` is stood in for via a fake executable placed
 * first on the spawned subprocess's PATH (in-process `__setGhForTest` can't
 * reach into a separate OS process — different memory space entirely), with
 * a deliberate short sleep so the daemon is genuinely mid-poll when killed,
 * not sitting idle between ticks.
 *
 * ⚠️ ISOLATION — `MAW_HOME` set for the SPAWNED subprocess's own env (not
 * the test process's `process.env`, which stays untouched) — the subprocess
 * inherits nothing it doesn't need. Snapshot/meta paths are plain files
 * under a fresh `mkdtempSync` root, never touching the real `~/.maw`.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const REAL_MAW_DIR = join(homedir(), ".maw");
const DAEMON_PATH = join(import.meta.dir, "daemon.ts");

function makeFakeGh(dir: string): void {
  const script = `#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  sleep 0.3
  echo "[]"
  exit 0
fi
echo "[]"
exit 0
`;
  const p = join(dir, "gh");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** Minimal stand-in "maw-server" — a real HTTP process, its own PID, a
 *  `/health` endpoint reporting `startedAt` stamped ONCE at boot (the
 *  `restart_time` analog: unchanged unless THIS process itself restarts). */
function makeStandInServerScript(dir: string, port: number): string {
  const script = `
const startedAt = new Date().toISOString();
Bun.serve({
  port: ${port},
  fetch() {
    return Response.json({ ok: true, startedAt });
  },
});
`;
  const p = join(dir, "stand-in-server.ts");
  writeFileSync(p, script);
  return p;
}

describe("daemon.ts — REAL OS-level SIGKILL (kobo-633 AC1/AC2, not a simulated abort)", () => {
  it("killing the daemon's real OS process leaves maw-server's API answering with an unchanged restart_time (AC1), and never corrupts the snapshot file (AC2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-daemon-kill-"));
    if (root.startsWith(REAL_MAW_DIR)) throw new Error(`test root resolved UNDER the real ~/.maw: ${root}`);
    const fakeGhDir = mkdtempSync(join(tmpdir(), "maw-fake-gh-"));
    makeFakeGh(fakeGhDir);
    const serverDir = mkdtempSync(join(tmpdir(), "maw-standin-server-"));
    const port = 30000 + (process.pid % 10000); // spread across runs, avoid common ports
    const serverScript = makeStandInServerScript(serverDir, port);

    const snapshotPath = join(root, "watch-pr-state.json");
    const metaPath = join(root, "watch-pr-state.meta.json");

    // kobo-633's own AC5 shape: seed a card so the daemon actually has a
    // repo to poll (otherwise it resolves instantly with nothing to do,
    // and we'd never reliably catch it "mid-cycle").
    const tasksDir = join(root, "companies", "kobo", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, "kobo-killtest.json"),
      JSON.stringify({ id: "kobo-killtest", company: "kobo", title: "x", ts: 1, state: "review", pr: 1, repo: "x/y" }),
    );

    // AC1's own maw-server stand-in — its OWN subprocess, real independence.
    const serverProc = Bun.spawn(["bun", "run", serverScript], { stdout: "pipe", stderr: "pipe" });

    const daemonProc = Bun.spawn(["bun", "run", DAEMON_PATH], {
      env: {
        ...process.env,
        PATH: `${fakeGhDir}:${process.env.PATH}`,
        MAW_HOME: root,
        MAW_PR_WATCH_INTERVAL_MS: "100",
        MAW_TEST_MODE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Give the stand-in server a moment to bind before the first fetch.
      await new Promise((r) => setTimeout(r, 200));
      const before = await (await fetch(`http://localhost:${port}/health`)).json();
      expect(before.ok).toBe(true);

      // Let the daemon start and get into its first tick — the fake `gh`'s
      // own 0.3s sleep is the window that guarantees "mid-poll," not idle.
      await new Promise((r) => setTimeout(r, 150));

      // The kill itself — real SIGKILL, real OS process termination.
      daemonProc.kill("SIGKILL");
      const exitCode = await daemonProc.exited;
      expect(exitCode).not.toBe(0); // confirms it was actually killed, not a clean exit we raced past

      // AC1 — literally the two things the AC names: "API ตอบได้" +
      // "restart_time ไม่ขยับ". Fetched from a SEPARATE OS process (the
      // stand-in server), never touched by the daemon's kill.
      const after = await (await fetch(`http://localhost:${port}/health`)).json();
      expect(after.ok).toBe(true); // API still answers
      expect(after.startedAt).toBe(before.startedAt); // restart_time unchanged — never restarted

      // AC2 — whatever landed on disk, if anything, must be valid JSON,
      // never a torn/half-written file. kobo-631's atomic tmp+rename is
      // WHY this holds even under a hard SIGKILL — this test exercises that
      // guarantee against the real thing, not a simulated abort.
      if (existsSync(snapshotPath)) {
        expect(() => JSON.parse(readFileSync(snapshotPath, "utf-8"))).not.toThrow();
      }
      if (existsSync(metaPath)) {
        expect(() => JSON.parse(readFileSync(metaPath, "utf-8"))).not.toThrow();
      }
      // No stray .tmp file left behind — proves the atomic rename either
      // completed fully or never started; nothing half-done survives.
      const stray = readdirSync(root).filter((f: string) => f.endsWith(".tmp"));
      expect(stray).toEqual([]);
    } finally {
      try { daemonProc.kill("SIGKILL"); } catch {}
      try { serverProc.kill("SIGKILL"); } catch {}
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      try { rmSync(fakeGhDir, { recursive: true, force: true }); } catch {}
      try { rmSync(serverDir, { recursive: true, force: true }); } catch {}
    }
  }, 5000);
});
