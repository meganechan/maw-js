/**
 * kobo-783 — withPeersLock did not provide mutual exclusion. These tests pin the LOCK,
 * not any one caller of it (the room store's kobo-430 test is the integration check that
 * sits on top). Each test targets one of the three defects; see the header of ./lock.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { withPeersLock } from "./lock";

let dir = "";
let target = "";
const realDateNow = Date.now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-lock-783-"));
  target = join(dir, "data.json");
});
afterEach(() => {
  Date.now = realDateNow;
  rmSync(dir, { recursive: true, force: true });
});

/** Jump the clock forward on every read so the 5s deadline is reached without spinning 5s of real CPU. */
function fastForwardClock(): void {
  let now = realDateNow();
  Date.now = () => { now += 10_000; return now; };
}

/** A pid that is genuinely dead — spawned and reaped, not a mocked process.kill. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

describe("withPeersLock — defect (a): acquisition is atomic (kobo-783)", () => {
  // The regression proper. `beforePublish` widens the window between "our pid is written"
  // and "the lock is visible" to 2ms in every worker. Under the old open(O_EXCL)-then-write
  // acquisition that same 2ms cost 30 of every 80 appends (measured, kobo-783); a contender
  // landing in the gap read an EMPTY lock file and unlinked a live holder's lock. If the
  // publish is genuinely atomic, widening it changes nothing at all.
  test("4 real OS processes × 20 entries with the acquire window widened 2ms — every entry survives", async () => {
    writeFileSync(target, "[]");
    const fixture = new URL("./__fixtures__/lock-counter-worker.ts", import.meta.url).pathname;
    const env = { ...process.env, MAW_TEST_MODE: "1" };
    const procs = Array.from({ length: 4 }, (_, w) =>
      Bun.spawn(["bun", "run", fixture, target, `W${w}`, "20", "2"], { env, stderr: "pipe" }),
    );
    const exits = await Promise.all(procs.map((p) => p.exited));
    for (let w = 0; w < procs.length; w++) {
      if (exits[w] !== 0) throw new Error(`worker W${w} failed: ${await new Response(procs[w].stderr).text()}`);
    }

    const entries = JSON.parse(readFileSync(target, "utf8")) as string[];
    expect(entries).toHaveLength(80);
    expect(new Set(entries).size).toBe(80); // no entry silently overwritten by a second holder
    for (let w = 0; w < 4; w++) {
      // each writer's own 20 entries, in its own order — cross-writer interleaving is
      // legitimately non-deterministic, a writer losing its OWN ordering is not
      expect(entries.filter((e) => e.startsWith(`W${w}-`))).toEqual(Array.from({ length: 20 }, (_, i) => `W${w}-${i}`));
    }
    expect(existsSync(`${target}.lock`)).toBe(false); // released, no stale lock left behind
  }, 30_000);
});

describe("withPeersLock — defect (b): steals ONLY a readable, genuinely dead pid (kobo-783)", () => {
  test("a lock held by a DEAD pid is stolen", async () => {
    writeFileSync(`${target}.lock`, String(await deadPid()));
    expect(withPeersLock(target, () => "ran")).toBe("ran");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("a lock held by a LIVE pid is never stolen — it times out and the holder's file survives", () => {
    writeFileSync(`${target}.lock`, String(process.pid));
    fastForwardClock();
    expect(() => withPeersLock(target, () => "never")).toThrow(`peers lock timeout: pid ${process.pid} still holds`);
    expect(readFileSync(`${target}.lock`, "utf8")).toBe(String(process.pid));
  });

  // THE defect that caused the lost writes: an empty lock file is a live holder caught
  // between two syscalls, not a stale one. The old code read 0 bytes, parsed NaN, and
  // unlinked it. Waiting (and failing loudly) is the correct answer — never stealing.
  test("an EMPTY lock file is NOT stale — it is waited out, not stolen", () => {
    writeFileSync(`${target}.lock`, "");
    fastForwardClock();
    expect(() => withPeersLock(target, () => "never")).toThrow("peers lock timeout: pid unreadable still holds");
    expect(existsSync(`${target}.lock`)).toBe(true);
  });

  test("a lock file whose contents are not a pid is NOT stale either", () => {
    writeFileSync(`${target}.lock`, "not-a-pid");
    fastForwardClock();
    expect(() => withPeersLock(target, () => "never")).toThrow("peers lock timeout: pid unreadable still holds");
    expect(existsSync(`${target}.lock`)).toBe(true);
  });
});

describe("withPeersLock — defect (c): release only removes OUR lock (kobo-783)", () => {
  // Once someone else's pid is in the file, that file is their critical section. Unlinking
  // it on our way out (what the old unconditional unlink did) admits a third writer while
  // they are still inside.
  test("a lock that now holds a DIFFERENT live pid is left alone on release", () => {
    const foreign = String(process.ppid); // alive, and not us
    withPeersLock(target, () => { writeFileSync(`${target}.lock`, foreign); });
    expect(readFileSync(`${target}.lock`, "utf8")).toBe(foreign);
  });

  test("our own lock is released even when fn throws", () => {
    expect(() => withPeersLock(target, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});
