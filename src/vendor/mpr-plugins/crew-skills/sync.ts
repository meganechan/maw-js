/**
 * crew-skills sync — install the canonical /cell + /teardown skills into a
 * home `.claude` tree.
 *
 * One canonical copy lives in this plugin's assets/. Installing globally into
 * ~/.claude/skills + ~/.claude/hooks means every oracle picks up its skills
 * from the maw upgrade — no per-oracle copy to drift. The worker settings +
 * hooks use $HOME-absolute paths so the spawn contract works from any
 * oracle's cwd.
 *
 * kobo-303 — /warroom was hard-removed (migrated → /head 3-tier). The
 * seat-resume.sh hook KEEPS its warroom-dir (ψ/active/warroom) support so any
 * still-running warroom pane survives the skill-file removal (its contract is
 * baked via --append-system-prompt, re-seat reads state files, not the skill).
 *
 * kobo-859 — the worker Stop hook (crew-worker-stop.sh, the idle-notify
 * chain) is gone: it existed to signal a reviewer pane that no longer exists.
 *
 * Pure node:fs so the standalone boundary stays trivial to assert.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * kobo-196 — the SessionStart:clear command that auto-reseats a pane after
 * /clear. $HOME-absolute so it resolves the globally-installed seat-resume.sh
 * from any oracle's cwd. seat-resume.sh self-gates to warroom repos, so a plain
 * (non-warroom) pane sees nothing.
 *
 * Wired into two SCOPED places (never the user's personal ~/.claude/settings.json):
 *  - the oracle REPO's .claude/settings.json → lead/comm/conductor panes, which
 *    run from the repo dir and inherit its settings (where eq3 proved it);
 *  - crew-worker-settings.json (the asset workers spawn with --settings) → worker panes.
 */
const SEAT_RESUME_COMMAND = "bash $HOME/.claude/hooks/seat-resume.sh";
const SEAT_RESUME_MATCHER = "startup|resume|clear"; // kobo-268: auto-seat on every (re)start, not clear-only

export interface SyncItem {
  /** path relative to the plugin assets/ dir */
  src: string;
  /** path relative to <home>/.claude */
  dest: string;
  /** chmod 0o755 after write (shell hooks) */
  exec?: boolean;
}

/** Canonical asset → global .claude layout. */
export const SYNC_ITEMS: SyncItem[] = [
  { src: "skills/cell/SKILL.md", dest: "skills/cell/SKILL.md" },
  { src: "skills/cell/contracts/head.md", dest: "skills/cell/contracts/head.md" },
  { src: "skills/cell/contracts/worker.md", dest: "skills/cell/contracts/worker.md" },
  // crew + head skills dropped with their cell topologies, and the reviewer
  // contract with the reviewer pane (kobo-859) — the kobo-566 prune removes
  // the installed copies on the next sync (intended).
  { src: "skills/teardown/SKILL.md", dest: "skills/teardown/SKILL.md" }, // kobo-343 — /teardown lifecycle close (spin↔teardown); safety-critical pane killer
  // kobo-317 — /worker skill removed: worker is no longer a self-defined standalone role, only a /crew-spawned in-cell pane (crew §4 inline contract).
  // kobo-859 — crew-worker-stop.sh (the idle-notify Stop hook) removed with the
  // reviewer pane it was signaling to; the kobo-566 prune removes the installed
  // copy on the next sync.
  // kobo-174/200 card-gate hook + sample dropped with the task system — the
  // kobo-566 prune removes the installed copies on the next sync (intended).
  { src: "hooks/seat-resume.sh", dest: "hooks/seat-resume.sh", exec: true }, // kobo-196 — auto-seat on SessionStart:clear (self-gates to warroom repos; wired into the oracle REPO's settings by ensureSeatResumeHook, never the user's global ~/.claude)
  { src: "crew-worker-settings.json", dest: "crew-worker-settings.json" },
];

/**
 * kobo-566 — dest paths (relative to .claude) THIS tool has installed, tracked
 * across runs. A later sync prunes ONLY dests that both (a) appear in this
 * manifest (we put them there) and (b) no longer appear in SYNC_ITEMS (the
 * source dropped them) — never a blind diff against whatever else lives in
 * .claude/skills. ~/.claude/skills mixes content from other sources (the
 * arra-oracle skill set, symlinks to external repos); a prune keyed off "not
 * in current SYNC_ITEMS" without the manifest gate would delete those too.
 *
 * A file already installed BEFORE this manifest existed (e.g. a stale
 * skills/worker/SKILL.md from a pre-kobo-566 sync) is not in the manifest's
 * first snapshot, so it is NOT retroactively pruned — only the class of
 * future drops is fixed forward. Documented, not silent.
 */
const MANIFEST_REL_PATH = ".crew-skills-manifest.json";

function readManifestDests(claudeDir: string): string[] {
  const path = join(claudeDir, MANIFEST_REL_PATH);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.installed) ? parsed.installed : [];
  } catch {
    return [];
  }
}

function writeManifestDests(claudeDir: string, dests: string[]): void {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, MANIFEST_REL_PATH), JSON.stringify({ installed: dests }, null, 2) + "\n");
}

export interface SyncOptions {
  /** target home (default: os.homedir()) */
  home?: string;
  /** source assets dir (default: ./assets next to this module) */
  assetsDir?: string;
  /** report what would change without writing */
  dryRun?: boolean;
  /** rewrite even when content is byte-identical */
  force?: boolean;
  /**
   * kobo-196 — where to wire the SessionStart:clear seat-resume hook. The oracle
   * REPO dir (default process.cwd()); its .claude/settings.json is scoped to this
   * repo, so we never touch the user's personal ~/.claude/settings.json.
   */
  repoDir?: string;
}

export interface SyncResult {
  home: string;
  claudeDir: string;
  /** dest paths (relative to .claude) that were written / would be written */
  installed: string[];
  /** dest paths skipped because already up-to-date */
  skipped: string[];
  /** dest paths removed (or, in dryRun, that would be removed) — manifest-tracked only (kobo-566) */
  pruned: string[];
  /** true when the SessionStart:clear seat-resume hook was added to settings.json */
  seatHookWired: boolean;
  dryRun: boolean;
}

/**
 * Ensure the given `.claude/settings.json` carries a SessionStart:clear hook
 * that runs seat-resume.sh (kobo-196). The caller passes the oracle REPO's
 * .claude dir (scoped-both), never the user's personal ~/.claude — mutating a
 * global settings would fire the hook on every /clear in every repo (worker.3
 * reject). Idempotent + non-destructive: reads the existing settings, adds the
 * hook only when absent, preserves every other key and hook. Mirrors the merge
 * shape in core/worklog/hook-setup.ts.
 *
 * Returns true when it added (or, in dryRun, would add) the hook.
 */
export function ensureSeatResumeHook(
  claudeDir: string,
  opts: { dryRun?: boolean } = {},
): boolean {
  const settingsPath = join(claudeDir, "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const entries = settings.hooks.SessionStart as any[];

  // kobo-268: fire on startup|resume|clear (not clear-only) so a pane auto-seats on every
  // (re)start, not just after /clear. Find an existing seat-resume entry by COMMAND (any
  // matcher) so a re-sync UPGRADES an old clear-only install in place instead of duplicating.
  const existing = entries.find(e =>
    Array.isArray(e?.hooks) && e.hooks.some((hk: any) => hk?.command === SEAT_RESUME_COMMAND));
  if (existing) {
    if (existing.matcher === SEAT_RESUME_MATCHER) return false; // already current
    if (opts.dryRun) return true;
    existing.matcher = SEAT_RESUME_MATCHER; // upgrade clear-only → startup|resume|clear
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  }

  entries.push({ matcher: SEAT_RESUME_MATCHER, hooks: [{ type: "command", command: SEAT_RESUME_COMMAND }] });
  if (opts.dryRun) return true;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

function defaultAssetsDir(): string {
  return join(import.meta.dir, "assets");
}

function sameContent(srcPath: string, destPath: string): boolean {
  if (!existsSync(destPath)) return false;
  try {
    return readFileSync(srcPath, "utf8") === readFileSync(destPath, "utf8");
  } catch {
    return false;
  }
}

export function syncCrewSkills(options: SyncOptions = {}): SyncResult {
  const home = options.home ?? homedir();
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const claudeDir = join(home, ".claude");
  const installed: string[] = [];
  const skipped: string[] = [];
  const currentDests = SYNC_ITEMS.map((i) => i.dest);

  // kobo-566 — prune dests THIS tool previously installed (per its own manifest)
  // that have since dropped out of SYNC_ITEMS. Gated on the manifest, never on
  // "absent from SYNC_ITEMS" alone, so other-source files in .claude/skills are
  // structurally unreachable here.
  const pruned: string[] = [];
  for (const dest of readManifestDests(claudeDir)) {
    if (currentDests.includes(dest)) continue;
    pruned.push(dest);
    if (options.dryRun) continue;
    const destPath = join(claudeDir, dest);
    if (existsSync(destPath)) rmSync(destPath);
  }

  for (const item of SYNC_ITEMS) {
    const srcPath = join(assetsDir, item.src);
    const destPath = join(claudeDir, item.dest);

    if (!options.force && sameContent(srcPath, destPath)) {
      skipped.push(item.dest);
      continue;
    }
    installed.push(item.dest);
    if (options.dryRun) continue;

    mkdirSync(dirname(destPath), { recursive: true });
    cpSync(srcPath, destPath);
    if (item.exec) chmodSync(destPath, 0o755);
  }

  // kobo-196 — wire the SessionStart:clear seat-resume hook into the oracle
  // REPO's .claude/settings.json (scoped-both), so lead/comm/conductor panes
  // (which run from the repo dir) auto-reseat after /clear. Worker panes get it
  // via crew-worker-settings.json. NEVER the user's global ~/.claude/settings.json.
  const repoDir = options.repoDir ?? process.cwd();
  const seatHookWired = ensureSeatResumeHook(join(repoDir, ".claude"), { dryRun: options.dryRun });

  if (!options.dryRun) writeManifestDests(claudeDir, currentDests);

  return { home, claudeDir, installed, skipped, pruned, seatHookWired, dryRun: !!options.dryRun };
}

export function formatSyncResult(result: SyncResult): string {
  const verb = result.dryRun ? "would install" : "installed";
  const lines = [
    `${verb} crew skills → ${result.claudeDir}`,
    `  /crew + /head skills, worker Stop hook, worker settings`,
    `  ${verb}: ${result.installed.length} · up-to-date: ${result.skipped.length}`,
  ];
  for (const dest of result.installed) lines.push(`  + ${dest}`);
  if (result.pruned.length > 0) {
    const pruneVerb = result.dryRun ? "would prune" : "pruned";
    lines.push(`  ${pruneVerb}: ${result.pruned.length} (dropped from this tool's manifest, no longer shipped)`);
    for (const dest of result.pruned) lines.push(`  - ${dest}`);
  }
  if (result.seatHookWired) {
    lines.push(`  + settings.json SessionStart:clear → seat-resume.sh (auto-seat)`);
  }
  return lines.join("\n");
}
