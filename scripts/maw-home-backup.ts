#!/usr/bin/env bun
/**
 * kobo-427 — daily snapshot of `~/.maw` (or `$MAW_HOME`) so a disk failure doesn't take the
 * whole company board + every brainstorm room with it. Plain script, not a maw plugin/verb
 * (proposal's own conclusion — this doesn't need to be one, and a shell/bun script is the
 * simplest thing that satisfies the card). Read-only against the live home: everything
 * written lands in a staging copy and `$MAW_BACKUP_DIR` (default `~/.maw-backups`, a SIBLING
 * of `~/.maw`, never inside it — so a disaster that takes `~/.maw` doesn't take the backups).
 *
 * Tony's ruling: filter/encrypt the credential-bearing files, run daily, no rotation, no
 * removal of secrets from the live home (that's kobo-433, still open). This filters
 * in-place (redactSecrets) rather than encrypting whole files — simpler, no key management,
 * and satisfies the AC that non-secret data in the SAME file must still come back.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, cpSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { redactSecrets } from "./lib/redact-secrets";

const HOME = process.env.HOME!;
export const MAW_HOME = process.env.MAW_HOME || join(HOME, ".maw");
export const BACKUP_DIR = process.env.MAW_BACKUP_DIR || join(HOME, ".maw-backups");
export const RETENTION_COUNT = 14; // keep last 14 daily snapshots

// kobo-427 trap, paid for by testing the restore (not by inspection): `plugins/` is 133
// symlinks into the live source checkout, not data — a tar that includes it (or dereferences
// it with -h/--dereference) restores a dangling symlink that resolves back to the live repo,
// which is exactly how a prior draft got a false-green "(111 tasks)" on an otherwise-empty
// restore. EXCLUDE only, never dereference. `maw.pid` is the live server's runtime lock —
// carrying it into a restore makes `maw serve` on the restored copy refuse to start,
// mistaking the still-alive production PID for itself. `ui/dist` is build output.
const EXCLUDE_RELATIVE = new Set(["plugins", "maw.pid"]);
const EXCLUDE_PREFIX = ["ui/dist"];

// kobo-427 card note — the sweep that FOUND these files, kept for audit/documentation of
// what was known and why. This is NOT what gates redaction below — see KNOWN_SECRET_BEARING
// comment on the redaction pass itself for why a pinned list turned out to be the wrong
// mechanism, discovered by grepping the REAL produced archive rather than trusting this list.
export const KNOWN_SECRET_BEARING_FILES = [
  "audit.jsonl",
  "maw-log.jsonl",
  "companies/pgw/tasks/pgw-464.json",
  "companies/pgw/rooms/cyberpluspay.json",
  "companies/pgw/rooms/recap-p2p-ruay.json",
  "companies/pgw/rooms/ruay.json",
  "companies/pgw/rooms/upload-slip-kadan.json",
  "companies/pgw/rooms/upload-slip.json",
  "companies/pgw/tasks/pgw-239.json",
  "companies/pgw/tasks/pgw-320.json",
  "companies/pgw/tasks/pgw-326.json",
  "companies/pgw/tasks/pgw-329.json",
  "companies/pgw/tasks/pgw-330.json",
  "companies/pgw/tasks/pgw-331.json",
  "companies/pgw/tasks/pgw-383.json",
  "companies/pgw/worklog.jsonl",
  "companies/pgw/rooms/pompay-poc.json", // found by grepping the REAL archive, missed by the manual sweep
];

// text-only extensions worth scanning — a secret pasted into an ordinary task note or room
// message has no distinguishing FILENAME (kobo-415's F5/F6 lesson), only a value shape. A
// pinned file list has the same failure mode findSqliteFiles() was written to avoid: it's
// fine for identities that don't change, silently wrong the moment a NEW file carries the
// same shape — proven directly, not hypothetically, by pompay-poc.json above, found only by
// grepping the real produced archive after the pinned-list version shipped clean on paper.
const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".log"]);

interface StatusFile {
  lastAttemptTs?: number;
  lastSuccessTs?: number;
  lastError?: string;
  snapshotFile?: string;
  sizeBytes?: number;
  cardCount?: Record<string, number>; // per-company, CLI (N tasks) header — the "readable" line
  taskFileCount?: Record<string, number>; // per-company, raw *.json count — the weaker "present" line
  secretRedactionCounts?: Record<string, number>;
}

export function statusPath(backupDir: string): string {
  return join(backupDir, "status.json");
}

export function readStatus(backupDir: string): StatusFile {
  const p = statusPath(backupDir);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function writeStatus(backupDir: string, patch: Partial<StatusFile>): void {
  mkdirSync(backupDir, { recursive: true });
  const current = readStatus(backupDir);
  const next = { ...current, ...patch };
  const p = statusPath(backupDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  // atomic swap — same pattern the rest of this codebase uses for every artifact write
  execFileSync("mv", [tmp, p]);
}

/** Every `*.sqlite*`/`*.db` under a root, enumerated at RUN TIME — kobo-415/427's shared
 * lesson: a hardcoded list is fine for names whose identity doesn't change (the 2 secret
 * files) and silently wrong for "whatever database files happen to exist" (grows over time,
 * `review-desk.sqlite` was nearly raw-tar'd this exact way). */
export function findSqliteFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.sqlite\b|\.sqlite-|\.db$/i.test(entry.name)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Every text-extension file under a root, enumerated at run time — same reasoning as
 * findSqliteFiles above, applied to the thing that actually bit this card (pompay-poc.json). */
export function findTextFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const dot = entry.name.lastIndexOf(".");
      if (dot !== -1 && TEXT_EXTENSIONS.has(entry.name.slice(dot))) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Rebuild a sqlite file through a text dump so the SAME redactSecrets pass used for JSON
 * files also covers database content — no SQL/schema awareness needed, robust to future
 * schema changes, and treats "torn write mid-transaction" via sqlite's own online-backup
 * semantics (the dump reads a consistent snapshot). */
export function filterSqliteFile(path: string): Record<string, number> {
  const dump = execFileSync("sqlite3", [path, ".dump"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  const { text, counts } = redactSecrets(dump);
  rmSync(path);
  execFileSync("sqlite3", [path], { input: text });
  return counts;
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

/** kobo-427 AC — the "readable" line: the CLI's own `(N tasks)` header, per company, run
 * from the LIVE home (this is the count recorded AT BACKUP TIME, compared later against the
 * SAME field read back after a restore — never against "whatever the board says right now",
 * which is the false-green shape the proposal already eliminated once). Never `--full`
 * (that render has no aggregate total at all). */
export function cardCountPerCompany(mawHome: string, cliEntry: string): Record<string, number> {
  const companiesDir = join(mawHome, "companies");
  const out: Record<string, number> = {};
  if (!existsSync(companiesDir)) return out;
  for (const entry of readdirSync(companiesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const company = entry.name;
    let raw: string;
    try {
      raw = execFileSync("bun", [cliEntry, "company", "task", "ls", "--company", company], {
        encoding: "utf8",
        env: { ...process.env, MAW_HOME: mawHome },
        cwd: tmpdir(), // outside $HOME — avoids the ancestor plugin-shadow walk (proposal's own finding)
      });
    } catch {
      continue; // a company dir with no readable board isn't a backup failure
    }
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const m = clean.match(/\((\d+)\s+tasks\)/);
    if (m) out[company] = parseInt(m[1], 10);
  }
  return out;
}

/** The weaker "present" line — raw member count, no `maw` binary required at all, so it
 * works on a machine with nothing but the tarball and standard Unix tools. */
export function taskFileCountPerCompany(mawHome: string): Record<string, number> {
  const companiesDir = join(mawHome, "companies");
  const out: Record<string, number> = {};
  if (!existsSync(companiesDir)) return out;
  for (const entry of readdirSync(companiesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const tasksDir = join(companiesDir, entry.name, "tasks");
    if (!existsSync(tasksDir)) { out[entry.name] = 0; continue; }
    out[entry.name] = readdirSync(tasksDir).filter((f) => f.endsWith(".json")).length;
  }
  return out;
}

function shouldExclude(relPath: string): boolean {
  if (EXCLUDE_RELATIVE.has(relPath)) return true;
  return EXCLUDE_PREFIX.some((p) => relPath === p || relPath.startsWith(p + "/"));
}

export function sweepOldSnapshots(backupDir: string, keep: number): string[] {
  if (!existsSync(backupDir)) return [];
  const snapshots = readdirSync(backupDir)
    .filter((f) => f.startsWith("maw-") && f.endsWith(".tar.gz"))
    .sort() // filenames are ts-prefixed → lexical sort is chronological
    .reverse();
  const toDelete = snapshots.slice(keep);
  for (const f of toDelete) rmSync(join(backupDir, f), { force: true });
  return toDelete;
}

export async function runBackup(): Promise<void> {
  const cliEntry = join(import.meta.dir, "..", "src", "cli.ts");
  writeStatus(BACKUP_DIR, { lastAttemptTs: Date.now() });

  const stageRoot = mkdtempSync(join(tmpdir(), "maw-backup-stage-"));
  const stageMaw = join(stageRoot, ".maw");
  try {
    // 1. copy the tree — a copy, never a mutation of the live home. Excludes applied here,
    //    not via tar flags, so the sqlite/redaction passes below never touch plugins/pid.
    cpSync(MAW_HOME, stageMaw, {
      recursive: true,
      filter: (src) => {
        const rel = relative(MAW_HOME, src);
        if (rel === "") return true;
        return !shouldExclude(rel);
      },
    });

    // 2. sqlite files — enumerated at run time, dumped+filtered+rebuilt (never raw-tar'd;
    //    a live-written db copied mid-transaction can be genuinely corrupt, not just stale).
    const redactionCounts: Record<string, number> = {};
    for (const f of findSqliteFiles(stageMaw)) {
      mergeCounts(redactionCounts, filterSqliteFile(f));
    }

    // 3. every text file in the tree — filtered in place, rest of each file untouched.
    //    NOT gated by KNOWN_SECRET_BEARING_FILES (see its comment) — this runs on
    //    everything with a text extension, so a secret pasted into a card/room this backup
    //    has never seen before still gets caught, not just the ones already on the list.
    for (const f of findTextFiles(stageMaw)) {
      const { text, counts } = redactSecrets(readFileSync(f, "utf8"));
      if (Object.keys(counts).length === 0) continue; // unchanged — skip the write
      writeFileSync(f, text);
      mergeCounts(redactionCounts, counts);
    }

    // 4. counts — two SEPARATE lines, never cross-compared (kobo-427's own named trap: kobo
    //    has 344 raw task files but the CLI shows far fewer once archive-eligible done/
    //    rejected cards age past the 7-day display window — both numbers are correct, they
    //    answer different questions).
    const cardCount = cardCountPerCompany(MAW_HOME, cliEntry);
    const taskFileCount = taskFileCountPerCompany(MAW_HOME);

    // 5. tar the staged (already-filtered) copy.
    const ts = Date.now();
    mkdirSync(BACKUP_DIR, { recursive: true });
    const snapshotFile = join(BACKUP_DIR, `maw-${ts}.tar.gz`);
    execFileSync("tar", ["-czf", snapshotFile, "-C", stageRoot, ".maw"]);

    // 6. retention.
    sweepOldSnapshots(BACKUP_DIR, RETENTION_COUNT);

    // 7. status — success.
    writeStatus(BACKUP_DIR, {
      lastSuccessTs: Date.now(),
      lastError: undefined,
      snapshotFile,
      sizeBytes: statSync(snapshotFile).size,
      cardCount,
      taskFileCount,
      secretRedactionCounts: redactionCounts,
    });
  } catch (e) {
    writeStatus(BACKUP_DIR, { lastError: String(e) });
    throw e;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runBackup().catch((e) => {
    console.error(`[maw-home-backup] run failed: ${e}`);
    process.exit(1);
  });
}
