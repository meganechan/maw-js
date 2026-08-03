/**
 * maw-test-store-guard — global test preload (wired via bunfig.toml
 * `[test] preload`), sibling of hey-spawn-fail-closed.ts and the same idiom:
 * fail-closed under EVERY `bun test` invocation, including a bare
 * `bun test <file>` that bypasses every package script.
 *
 * WHY: a test file ran a store mutator at per-file COLLECTION time (in a
 * `describe` body), which executes BEFORE `beforeAll` sets `MAW_DATA_DIR`. With
 * no redirect in effect yet, `mawDataPath()` resolved to the operator's REAL
 * `~/.maw` — 28 real cards, worklog rows and ledger fixtures were written into
 * live state over six days. `scripts/test-isolated.sh` did not prevent it: it
 * isolates processes, not filesystem destinations.
 *
 * WHERE THE GUARD SITS: not at the path resolver. Resolving a real-home path is
 * legitimate and common in this suite (~15% of isolated test files do it, for
 * reads and path comparisons) — throwing there would break ~100 innocent files.
 * The failure is a WRITE to the real home, so the guard wraps the write surface
 * of `node:fs` (+ `Bun.write`) once, in-place, and rejects any call whose target
 * resolves inside the real maw home. Every one of the ~112 writer modules routes
 * through it; none of them needed to change.
 *
 * WHY NOT AN ENV FLAG: `MAW_TEST_MODE` is exactly what failed here — an env var
 * a human has to remember. This module is loaded only by `[test] preload`, so
 * "is this a test process?" is answered by construction, and the production
 * runtime never imports it. Non-test behavior is byte-identical.
 *
 * REAL HOME is snapshotted at preload time from `$HOME`/`homedir()`, before any
 * test can mutate `process.env.HOME`. A test that redirects HOME to a temp dir
 * and writes under it is therefore ALSO guarded (that dir is this process's real
 * home) — which is what makes the negative-control fixture meaningful.
 *
 * GREEN LOCALLY IS NOT GREEN: the worst offenders write only when the file is
 * ABSENT — `getJwtSecret`/`getPeerKey` read their secret first and return before
 * touching the write path, so on a box that has already run maw they never trip
 * this guard, and on a fresh CI runner they mint a real 0600 credential into the
 * home. Reproduce the runner before trusting a local pass:
 *     HOME=$(mktemp -d) bash scripts/test-isolated.sh
 *
 * ESCAPE HATCH: a test that genuinely must write to the real home sets
 * `MAW_ALLOW_REAL_HOME_WRITES=1` for its own process — explicit and greppable,
 * never a silent default. Nothing in the repo sets it.
 *
 * ponytail: guards the sync/callback/promise fs mutators plus `Bun.write` and
 * write-mode `openSync`. Two known ceilings:
 *   1. Native writers that never touch node:fs (e.g. `bun:sqlite` opening a DB)
 *      — those all `mkdirSync` their parent first, so they are caught one call
 *      earlier. Widen the list if a leak slips past.
 *   2. IN-PROCESS ONLY. A test that spawns the real `maw` CLI gets a production
 *      runtime, which by design never loads this module — those children still
 *      write `audit.jsonl` / `session-warnings.state` into the inherited home.
 *      Closing that needs the spawning tests to pass MAW_HOME to their children;
 *      it is a separate change, not a hole in this guard.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

const REAL_HOMES = [...new Set([process.env.HOME, homedir()].filter(Boolean) as string[])]
  .map((h) => resolve(h, ".maw"));

function isRealHomePath(target: unknown): boolean {
  if (process.env.MAW_ALLOW_REAL_HOME_WRITES === "1") return false;
  let p: string;
  if (typeof target === "string") p = target;
  else if (target instanceof URL) p = target.pathname;
  else if (target instanceof Buffer) p = target.toString("utf8");
  else return false; // fd or unknown handle — nothing to check
  if (!p) return false;
  const abs = isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
  return REAL_HOMES.some((home) => abs === home || abs.startsWith(home + sep));
}

function refuse(fn: string, target: unknown): never {
  throw new Error(
    `maw-test-store-guard: fs.${fn}() tried to write into the REAL maw home ` +
      `(${String(target)}).\n` +
      `A store mutator ran with no MAW_DATA_DIR/MAW_HOME redirect in effect. The ` +
      `usual cause is calling it at COLLECTION time — in a describe() body or at ` +
      `module top level — which runs BEFORE beforeAll() sets MAW_DATA_DIR. Move ` +
      `the call inside beforeAll/test, or set MAW_DATA_DIR at the very top of the ` +
      `file before importing the module under test.`,
  );
}

// The destination path is arg 0 for every one of these.
const GUARDED = [
  "writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync",
  "unlinkSync", "truncateSync", "createWriteStream",
  "writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "rmdir", "unlink", "truncate",
] as const;
// Both args carry a path. `symlink(target, path)` puts the DESTINATION second —
// guarding arg 0 only would have watched the wrong end.
const TWO_PATH = [
  "renameSync", "copyFileSync", "linkSync", "symlinkSync",
  "rename", "copyFile", "link", "symlink",
] as const;

function guard(mod: Record<string, any>, names: readonly string[], paths: number[]) {
  for (const name of names) {
    const original = mod[name];
    if (typeof original !== "function") continue;
    mod[name] = function (this: unknown, ...args: unknown[]) {
      for (const i of paths) if (isRealHomePath(args[i])) refuse(name, args[i]);
      return original.apply(this, args);
    };
  }
}

// Builtins are CJS-backed: mutating the require() object is visible to modules
// that did `import { writeFileSync } from "fs"` (verified on bun 1.3).
const fs = require("node:fs") as Record<string, any>;
guard(fs, GUARDED, [0]);
guard(fs, TWO_PATH, [0, 1]);
guard(fs.promises, GUARDED, [0]);
guard(fs.promises, TWO_PATH, [0, 1]);
// `fs/promises` is a separate module record from `fs.promises`.
const fsp = require("node:fs/promises") as Record<string, any>;
guard(fsp, GUARDED, [0]);
guard(fsp, TWO_PATH, [0, 1]);

// openSync/open: read-mode opens are legitimate (the worklog tail reader uses
// one). Only refuse when the flags ask for write/create/append.
for (const name of ["openSync", "open"] as const) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function (this: unknown, ...args: unknown[]) {
    const flags = args[1];
    const writes =
      typeof flags === "number" ? true : typeof flags === "string" ? /[wa+]/.test(flags) : false;
    if (writes && isRealHomePath(args[0])) refuse(name, args[0]);
    return original.apply(this, args);
  };
}

const bunWrite = Bun.write;
Bun.write = function (this: unknown, dest: unknown, ...rest: unknown[]) {
  if (isRealHomePath(dest)) refuse("Bun.write", dest);
  return (bunWrite as any).call(this, dest, ...rest);
} as typeof Bun.write;
