/**
 * maw-test-store-guard — proves test/helpers/real-home-write-fail-closed.ts
 * turns the collection-time store-mutator leak into a loud failure.
 *
 * Every case runs a CHILD process with `HOME` pointed at a throwaway dir and
 * `MAW_DATA_DIR`/`MAW_HOME` deleted, so the child's "real maw home" is
 * `<fakeHome>/.maw`. Asserting on that directory is the same measurement the
 * operator's `~/.maw` would have gotten — without touching it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const LEAK_FIXTURE = "./test/helpers/store-guard/leak-at-collection.ts";
const OK_FIXTURE = "./test/helpers/store-guard/beforeall-redirect.ts";
const RUNTIME_FIXTURE = "./test/helpers/store-guard/runtime-write.ts";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "store-guard-home-"));
});
afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

/** Every file under <fakeHome>/.maw — the leak's blast radius, as a list. */
function filesInFakeMawHome(): string[] {
  const root = join(fakeHome, ".maw");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  return out;
}

function run(argv: string[], env: Record<string, string> = {}) {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...env };
  childEnv.HOME = fakeHome;
  delete childEnv.MAW_DATA_DIR;
  delete childEnv.MAW_HOME;
  delete childEnv.MAW_STATE_DIR;
  const p = Bun.spawnSync({ cmd: argv, cwd: REPO_ROOT, env: childEnv, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

describe("real-home write guard", () => {
  test("negative control: the fixture DOES leak when the guard is disabled", () => {
    // A control that cannot produce the positive proves nothing. With the guard
    // waived, the exact same fixture writes a worklog into the (fake) real home
    // — that is the bug, reproduced.
    const r = run(["bun", "test", LEAK_FIXTURE], { MAW_ALLOW_REAL_HOME_WRITES: "1" });
    expect(r.code).toBe(0);
    expect(filesInFakeMawHome()).toContain(
      join("companies", "store-guard-fixture", "worklog.jsonl"),
    );
  });

  test("collection-time mutator fails loud and writes NOTHING to the real home", () => {
    const r = run(["bun", "test", LEAK_FIXTURE]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("maw-test-store-guard");
    expect(r.out).toContain("tried to write into the REAL maw home");
    // Caught at the mkdirSync that precedes the append — one call earlier than
    // the write itself, so not even the parent directory is created.
    expect(r.out).toContain("leak-at-collection.ts");
    expect(filesInFakeMawHome()).toEqual([]);
  });

  test("a normal file that redirects in beforeAll still passes", () => {
    const r = run(["bun", "test", OK_FIXTURE]);
    expect(r.out).toContain("1 pass");
    expect(r.code).toBe(0);
    expect(filesInFakeMawHome()).toEqual([]);
  });

  test("non-test runtime is unguarded — `bun <file>` still writes the real home", () => {
    // The guard ships as a bunfig `[test] preload` entry, so a production run
    // never loads it. If this ever fails, the guard leaked into the runtime.
    const r = run(["bun", RUNTIME_FIXTURE]);
    expect(r.code).toBe(0);
    expect(filesInFakeMawHome()).toContain(
      join("companies", "store-guard-fixture", "worklog.jsonl"),
    );
  });

  test("no production module imports the guard", () => {
    const grep = Bun.spawnSync({
      cmd: ["grep", "-rl", "real-home-write-fail-closed", "src", "packages", "scripts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(grep.stdout).trim()).toBe("");
  });
});
