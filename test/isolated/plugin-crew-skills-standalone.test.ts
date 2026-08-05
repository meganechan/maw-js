import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { SYNC_ITEMS, ensureSeatResumeHook, formatSyncResult, syncCrewSkills } from "../../src/vendor/mpr-plugins/crew-skills/sync.ts?plugin-crew-skills-standalone";

const pluginRoot = join(import.meta.dir, "../../src/vendor/mpr-plugins/crew-skills");
const assetsDir = join(pluginRoot, "assets");
const tmpRoots: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "crew-skills-home-"));
  tmpRoots.push(home);
  return home;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// kobo-573 — syncCrewSkills() defaults repoDir to process.cwd() (correct for a
// real user running from their own repo, per SyncOptions — NOT changing that
// default). Every syncCrewSkills() call in this file must instead pass an
// explicit repoDir pointing at a throwaway tmpdir, or it writes this actual
// checkout's real .claude/settings.json (kobo-573: a test run silently dirtied
// it, git-tracked, ~caught only by an incidental `git status`). This whole-file
// guard is the backstop: if a `repoDir` is ever dropped from a test above,
// THIS repo's real .claude/settings.json changes and the assertion below goes
// red — not a silent pass.
const cwdSettingsPath = join(process.cwd(), ".claude/settings.json");
let cwdSettingsBefore: string | null;
beforeAll(() => {
  cwdSettingsBefore = existsSync(cwdSettingsPath) ? readFileSync(cwdSettingsPath, "utf8") : null;
});
afterAll(() => {
  const after = existsSync(cwdSettingsPath) ? readFileSync(cwdSettingsPath, "utf8") : null;
  expect(after).toBe(cwdSettingsBefore); // this file's own repoDir cwd never gets touched
});

describe("crew-skills plugin standalone boundary", () => {
  test("sync keeps explicit standalone import boundaries (no deep maw-js coupling)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "crew-skills",
      allowRelative: ["./sync"],
    }).map((record) => record.spec);
    // sync.ts is pure node:fs — the whole point is zero core/config coupling.
    expect(imports).toContain("node:fs");
  });

  test("declares a passthrough cli command, no serve hook", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
    expect(manifest.cli.command).toBe("crew-skills");
    expect(manifest.hooks).toBeUndefined();
  });
});

describe("crew-skills global asset contract", () => {
  // The worker spawn contract is deadlock-critical (kobo-91): a worker with no
  // Stop hook never signals idle. Global install only works if the settings +
  // hook are addressed by $HOME-absolute paths, not cwd-relative ones.
  test("worker settings points the Stop hook at a $HOME-absolute path", () => {
    const settings = readFileSync(join(assetsDir, "crew-worker-settings.json"), "utf8");
    expect(settings).toContain("$HOME/.claude/hooks/crew-worker-stop.sh");
    expect(settings).not.toContain('"bash .claude/hooks');
    // still valid JSON with a Stop hook
    const parsed = JSON.parse(settings);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("$HOME/.claude/hooks/crew-worker-stop.sh");
  });

  // kobo-196/268 — worker panes spawn with crew-worker-settings.json (not the repo's
  // settings), so the auto-seat SessionStart hook must ride this asset too to cover them
  // (scoped-both: repo settings → lead/comm/conductor, this → workers). kobo-268: the
  // matcher fires on startup|resume|clear (not clear-only) so a worker auto-seats on every
  // (re)start, not just after /clear.
  test("worker settings carries the SessionStart seat-resume hook (startup|resume|clear)", () => {
    const parsed = JSON.parse(readFileSync(join(assetsDir, "crew-worker-settings.json"), "utf8"));
    const entry = parsed.hooks.SessionStart.find((e: any) => e.matcher === "startup|resume|clear");
    expect(entry.hooks[0].command).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
  });

  // kobo-268 — the seat-resume hook is a synced executable asset that resolves the resume
  // file from the crew env (CREW_STATE_DIR/CREW_ROLE, like the Stop hook) so it seats BOTH
  // crew (ψ/active/crew/worker.md) and warroom (ψ/active/warroom, lead-handoff.md) layouts.
  test("seat-resume hook is a synced executable + resolves crew env AND warroom fallback", () => {
    const item = SYNC_ITEMS.find((i) => i.dest === "hooks/seat-resume.sh");
    expect(item).toBeDefined();
    expect(item?.exec).toBe(true);
    const hook = readFileSync(join(assetsDir, "hooks/seat-resume.sh"), "utf8");
    expect(hook).toContain("CREW_STATE_DIR"); // env-first (mirrors the Stop hook)
    expect(hook).toContain("CREW_ROLE");
    expect(hook).toContain("@role"); // durable tmux fallback
    expect(hook).toContain("$STEM.md"); // crew's role-named file (worker.md)
    expect(hook).toContain("lead-handoff.md"); // eq3 fix + warroom special name
    expect(hook).toContain("ψ/active/crew"); // seats the crew layout too (patchwork dogfood)
    expect(hook).toContain("ψ/active/worker"); // kobo-316: worker fallback dir
    expect(hook).toContain("exit 0"); // solo-safe guards (no dir / no role → silent)
    // kobo-269 fix: when no CREW_STATE_DIR, search BOTH dirs and let the dir that HOLDS the
    // role file win — an empty leftover crew/ must not shadow a populated warroom/ (lead no-seat).
    expect(hook).toContain('for d in $DIRS'); // dir-selection loops both dirs, not blind-pick
    expect(hook).toContain("break 2"); // first dir with a matching file wins
    // kobo-268 fix: the case globs are case-sensitive, but labels are capitalized
    // ("🎼 Conductor") — the stem MUST be lowercased or Conductor never matches conduct*.
    expect(hook).toContain("tr '[:upper:]' '[:lower:]'");
    expect(hook).toContain("conduct*"); // the capitalized-label role this fix rescues
    // kobo-297 — auto-seat is observable: a visible boot-line right after `maw presence back`
    // confirms the pane re-seated online (the flip was otherwise a silent background write).
    expect(hook).toContain("presence: online (auto-seated)");
  });

  // kobo-174/200 card-gate hook + sample dropped with the task system (both the
  // CLI verb and the mcp__maw__maw_task tool are gone) — no replacement asserted.

  // kobo-95/303 — a spawner that points CREW_STATE_DIR elsewhere needs the hook to
  // honor it, or a coord trusting the state hint reads the wrong path. The crew/head
  // spawners are gone; the hook keeps the contract (cell relies on it).
  test("Stop hook honors CREW_STATE_DIR for the state hint", () => {
    const hook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(hook).toContain("${CREW_STATE_DIR:-ψ/active/crew}/$CREW_ROLE.md");
    // no lingering hardcoded crew path in the hint
    expect(hook).not.toContain("state: ψ/active/crew/$CREW_ROLE.md");
  });

  // kobo-356's next-ready queue attachment was removed with the task system
  // (the CLI verb no longer exists) — no replacement asserted here.

  test("Stop hook honors per-pane idle_notify override before legacy coord fallback", () => {
    const hook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(hook).toContain("@idle_notify_pane");
    expect(hook).toContain('TARGET_PANE="$CREW_COORD_PANE"');
    expect(hook).toContain('tmux display-message -t "$TARGET_PANE"');
  });

  // /cell ships; /warroom, /worker, /crew and /head are all hard-removed — no sync
  // item, no asset file. The seat-resume hook KEEPS its crew/warroom/worker-dir
  // support (asserted above) so any still-running pane survives the skill removal:
  // the skill file is gone, the runtime survival path is not.
  test("only /cell ships; /warroom, /worker, /crew and /head are fully removed", () => {
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/cell/SKILL.md")).toBeDefined();
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/cell/contracts/head.md")).toBeDefined();
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/cell/contracts/worker.md")).toBeDefined();
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/cell/contracts/reviewer.md")).toBeDefined();
    expect(existsSync(join(assetsDir, "skills/cell/SKILL.md"))).toBe(true);
    expect(existsSync(join(assetsDir, "skills/cell/contracts/head.md"))).toBe(true);
    for (const gone of ["warroom", "worker", "crew", "head"]) {
      expect(SYNC_ITEMS.find((i) => i.dest === `skills/${gone}/SKILL.md`)).toBeUndefined();
      expect(existsSync(join(assetsDir, `skills/${gone}/SKILL.md`))).toBe(false);
    }
    // crew/head contract templates left with them — nothing may re-add a dest
    // whose asset no longer exists (a sync would throw on the missing src).
    expect(SYNC_ITEMS.filter((i) => /^skills\/(crew|head)\//.test(i.dest))).toEqual([]);
  });

  /**
   * kobo-822 — the doc is the procedure an operator follows, so it fails the same
   * way the code would: a SKILL.md still describing `self-spawn` and head adoption
   * teaches a flow that no longer exists, and the reader has no way to tell.
   */
  test("/cell skill documents the add-on design: head untouched, worker+reviewer added from outside", () => {
    const skill = readFileSync(join(assetsDir, "skills/cell/SKILL.md"), "utf8");
    expect(skill).toContain("name: cell");
    expect(skill).toContain("maw company cell spawn <company>");
    expect(skill).toContain("maw company cell down  <company> [--force]");
    expect(skill).toContain("This is NOT a caller-local split and NOT the older `/crew` 4-pane cell");

    // The head: the oracle's own pane, and cell's relationship to it
    expect(skill).toContain("**The oracle's own pane IS the head.**");
    expect(skill).toContain("does not bring an oracle up — that is `maw wake`, and cell never calls it");
    expect(skill).toContain("**The head is never killed and never written to**");
    expect(skill).toContain("nothing routes through the head (kobo-771)");

    // kobo-764 — the doc must state the selector, not just "cell-owned panes"
    expect(skill).toContain("`@oracle_pane` identity is `{that oracle}:worker` or `{that oracle}:reviewer`");
    // kobo-782 — the duplicate-head rule is guidance, never an action
    expect(skill).toContain("**lowest pane id wins**");
    expect(skill).toContain("left completely alone");

    // The retired verbs must be NAMED, not silently absent: an operator running
    // one from muscle memory needs to be told what replaced it and why.
    expect(skill).toContain("## Removed verbs");
    expect(skill).toContain("**`self-spawn`** — gone");
    expect(skill).toContain("Cell types into no pane any more");

    // The verification command, with the flag that decides whether it can answer
    expect(skill).toContain("tmux list-panes -a -F '#{session_name}:#{window_name} @=#{@oracle_pane}'");
    expect(skill).toContain("`-a` is required");
    expect(readFileSync(join(assetsDir, "skills/cell/contracts/head.md"), "utf8")).toContain("spawn/supervise a background implementation agent");
    expect(readFileSync(join(assetsDir, "skills/cell/contracts/worker.md"), "utf8")).toContain("Act as execution supervisor by default");
    expect(readFileSync(join(assetsDir, "skills/cell/contracts/worker.md"), "utf8")).toContain("Do not review your own work");
    expect(readFileSync(join(assetsDir, "skills/cell/contracts/reviewer.md"), "utf8")).toContain("Do not implement fixes yourself");
  });

  // kobo-343 — /teardown = crew lifecycle close (spin↔teardown). Safety-critical pane killer:
  // kills ONLY crew-spawned panes (@role conductor/worker/reviewer), preserves invoker + untagged
  // (fail-closed). Graceful-wrap before kill (shutdown_request). Ships as a synced skill asset.
  test("teardown skill ships in SYNC_ITEMS and has safety-critical guards (kobo-343)", () => {
    expect(SYNC_ITEMS.find((i) => i.dest === "skills/teardown/SKILL.md")).toBeDefined();
    expect(existsSync(join(assetsDir, "skills/teardown/SKILL.md"))).toBe(true);
    const skill = readFileSync(join(assetsDir, "skills/teardown/SKILL.md"), "utf8");
    // invoker-guard: capture ME from TMUX_PANE before the loop (order-critical, not just presence)
    const meIdx = skill.indexOf("ME");
    const loopIdx = skill.indexOf("kill-pane");
    expect(meIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(meIdx).toBeLessThan(loopIdx); // ME captured BEFORE any kill-pane (kobo-343 safety)
    // fail-closed: untagged/unknown origin → preserve, not kill
    expect(skill).toContain("fail-closed");
    // graceful-wrap: shutdown_request sent before kill
    expect(skill).toContain("shutdown_request");
    // crew roles targeted (all three spawned pane types from /crew §1)
    expect(skill).toContain("conductor");
    expect(skill).toContain("worker");
    expect(skill).toContain("reviewer");
    // @role is the crew-origin proof (set at /crew spawn time §1)
    expect(skill).toContain("@role");
    // TMUX_PANE and ME are the invoker guards
    expect(skill).toContain("TMUX_PANE");
    expect(skill).toContain("kill-pane");
  });

  // kobo-345/347/91 — deadlock-critical: the Stop-hook glob must cover BOTH a bare
  // `worker` and numbered `worker-N` panes, or a worker never fires its idle signal.
  // `worker-*` alone would miss the bare base worker. The crew SKILL prose that had
  // to match this glob is gone; the hook is what cell actually runs, so it keeps the pin.
  test("Stop-hook role glob covers bare worker AND worker-N (kobo-345/347)", () => {
    const stopHook = readFileSync(join(assetsDir, "hooks/crew-worker-stop.sh"), "utf8");
    expect(stopHook).toContain("worker*|reviewer");
    expect(stopHook).not.toContain("worker-*|reviewer");
  });
});

describe("crew-skills sync", () => {
  test("fresh install writes all items, hook is executable", () => {
    const home = freshHome();
    const result = syncCrewSkills({ home, assetsDir, repoDir: freshHome() });

    expect(result.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
    expect(result.skipped).toEqual([]);
    for (const item of SYNC_ITEMS) {
      expect(existsSync(join(home, ".claude", item.dest))).toBe(true);
    }
    const hookMode = statSync(join(home, ".claude/hooks/crew-worker-stop.sh")).mode & 0o111;
    expect(hookMode).not.toBe(0); // some exec bit set

    // installed content matches canonical assets
    const cell = readFileSync(join(home, ".claude/skills/cell/SKILL.md"), "utf8");
    expect(cell).toBe(readFileSync(join(assetsDir, "skills/cell/SKILL.md"), "utf8"));
  });

  test("second sync is idempotent (everything up-to-date)", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const again = syncCrewSkills({ home, assetsDir, repoDir });
    expect(again.installed).toEqual([]);
    expect(again.skipped.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
  });

  test("drifted file is re-synced back to canonical", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const cellDest = join(home, ".claude/skills/cell/SKILL.md");
    writeFileSync(cellDest, "STALE COPY");

    const result = syncCrewSkills({ home, assetsDir, repoDir });
    expect(result.installed).toContain("skills/cell/SKILL.md");
    expect(readFileSync(cellDest, "utf8")).not.toBe("STALE COPY");
  });

  test("--force rewrites even when unchanged", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const forced = syncCrewSkills({ home, assetsDir, repoDir, force: true });
    expect(forced.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
  });

  test("--dry-run reports changes but writes nothing", () => {
    const home = freshHome();
    const result = syncCrewSkills({ home, assetsDir, repoDir: freshHome(), dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.installed.length).toBe(SYNC_ITEMS.length);
    expect(existsSync(join(home, ".claude/skills/cell/SKILL.md"))).toBe(false);
    expect(formatSyncResult(result)).toContain("would install");
  });

  test("wires the SessionStart seat-resume hook into the REPO settings, not global (scoped-both)", () => {
    const home = freshHome();
    const repoDir = freshHome(); // stands in for the oracle repo dir
    const result = syncCrewSkills({ home, assetsDir, repoDir });
    expect(result.seatHookWired).toBe(true);
    // asset script still installs globally (~/.claude/hooks) — unchanged
    expect(existsSync(join(home, ".claude/hooks/seat-resume.sh"))).toBe(true);
    // the wiring lands in the REPO's .claude/settings.json … (kobo-268: startup|resume|clear)
    const settings = JSON.parse(readFileSync(join(repoDir, ".claude/settings.json"), "utf8"));
    const entry = settings.hooks.SessionStart.find((e: any) => e.matcher === "startup|resume|clear");
    expect(entry.hooks[0].command).toBe("bash $HOME/.claude/hooks/seat-resume.sh");
    // … and NEVER the user's global ~/.claude/settings.json (worker.3 reject)
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
  });

  test("seat-resume hook wiring is idempotent (no duplicate entry)", () => {
    const home = freshHome();
    const repoDir = freshHome();
    syncCrewSkills({ home, assetsDir, repoDir });
    const again = syncCrewSkills({ home, assetsDir, repoDir });
    expect(again.seatHookWired).toBe(false);
    const settings = JSON.parse(readFileSync(join(repoDir, ".claude/settings.json"), "utf8"));
    const seats = settings.hooks.SessionStart.filter((e: any) => e.matcher === "startup|resume|clear");
    expect(seats.length).toBe(1);
  });

  // kobo-268 — a re-sync UPGRADES an old clear-only install to startup|resume|clear in place
  // (by matching the command), never leaving a stale clear-only entry or duplicating.
  test("seat-resume wiring upgrades an old clear-only matcher in place", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ matcher: "clear", hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/seat-resume.sh" }] }] },
    }));
    expect(ensureSeatResumeHook(claudeDir)).toBe(true); // upgraded
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const entries = settings.hooks.SessionStart;
    expect(entries.length).toBe(1); // upgraded in place, not duplicated
    expect(entries[0].matcher).toBe("startup|resume|clear");
    expect(ensureSeatResumeHook(claudeDir)).toBe(false); // now current — no-op
  });

  // kobo-566 — sync now prunes dests it previously installed (tracked in its own
  // manifest) that have since dropped out of SYNC_ITEMS, instead of leaving them
  // as permanent stale no-ops (kobo-317's /worker was the proof case).
  describe("prune (kobo-566)", () => {
    test("fresh install (no prior manifest) writes a manifest matching current SYNC_ITEMS, prunes nothing", () => {
      const home = freshHome();
      const result = syncCrewSkills({ home, assetsDir, repoDir: freshHome() });
      expect(result.pruned).toEqual([]);
      const manifest = JSON.parse(readFileSync(join(home, ".claude/.crew-skills-manifest.json"), "utf8"));
      expect(manifest.installed.sort()).toEqual(SYNC_ITEMS.map((i) => i.dest).sort());
    });

    test("a dest tracked in the manifest but no longer in SYNC_ITEMS is deleted from disk and reported pruned", () => {
      const home = freshHome();
      const repoDir = freshHome();
      syncCrewSkills({ home, assetsDir, repoDir }); // seeds a real manifest

      // simulate a stale entry: a dest this tool once installed, now dropped from SYNC_ITEMS
      const claudeDir = join(home, ".claude");
      const staleDest = "skills/worker/SKILL.md";
      const staleAbs = join(claudeDir, staleDest);
      mkdirSync(join(claudeDir, "skills/worker"), { recursive: true });
      writeFileSync(staleAbs, "stale worker skill, kobo-317 removed it from SYNC_ITEMS");
      const manifestPath = join(claudeDir, ".crew-skills-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.installed.push(staleDest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const result = syncCrewSkills({ home, assetsDir, repoDir });
      expect(result.pruned).toContain(staleDest);
      expect(existsSync(staleAbs)).toBe(false);
      // manifest re-written to just the current items — stale dest drops out for good
      const after = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(after.installed).not.toContain(staleDest);
    });

    test("--dry-run reports what would be pruned but deletes nothing and does not touch the manifest", () => {
      const home = freshHome();
      const repoDir = freshHome();
      syncCrewSkills({ home, assetsDir, repoDir });
      const claudeDir = join(home, ".claude");
      const staleDest = "skills/worker/SKILL.md";
      const staleAbs = join(claudeDir, staleDest);
      mkdirSync(join(claudeDir, "skills/worker"), { recursive: true });
      writeFileSync(staleAbs, "stale");
      const manifestPath = join(claudeDir, ".crew-skills-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.installed.push(staleDest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const manifestMtimeBefore = statSync(manifestPath).mtimeMs;

      const result = syncCrewSkills({ home, assetsDir, repoDir, dryRun: true });
      expect(result.pruned).toContain(staleDest);
      expect(existsSync(staleAbs)).toBe(true); // untouched
      expect(statSync(manifestPath).mtimeMs).toBe(manifestMtimeBefore); // untouched
      expect(formatSyncResult(result)).toContain("would prune");
    });

    test("a file from another source (never in this tool's manifest) is never deleted, even if absent from SYNC_ITEMS", () => {
      const home = freshHome();
      const claudeDir = join(home, ".claude");
      // simulate an arra-oracle-set skill or an external symlink target already
      // sitting in .claude/skills before crew-skills ever ran here
      const otherDest = "skills/recap/SKILL.md";
      const otherAbs = join(claudeDir, otherDest);
      mkdirSync(join(claudeDir, "skills/recap"), { recursive: true });
      writeFileSync(otherAbs, "not ours — arra-oracle skill set");

      const repoDir = freshHome();
      syncCrewSkills({ home, assetsDir, repoDir }); // first run: no manifest yet, otherDest untracked
      expect(existsSync(otherAbs)).toBe(true);

      const again = syncCrewSkills({ home, assetsDir, repoDir }); // second run: manifest now exists, still never mentions otherDest
      expect(again.pruned).not.toContain(otherDest);
      expect(existsSync(otherAbs)).toBe(true);
    });
  });

  test("seat-resume wiring preserves pre-existing settings + hooks (non-destructive)", () => {
    const home = freshHome();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "keep-me.sh" }] }] },
    }));
    ensureSeatResumeHook(claudeDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.SessionStart.some((e: any) => e.hooks[0].command === "keep-me.sh")).toBe(true);
    expect(settings.hooks.SessionStart.some((e: any) => e.matcher === "startup|resume|clear")).toBe(true); // kobo-268
  });
});
