/**
 * `maw company cell` — the ADD-ON that gives an already-running oracle the
 * pane it needs to work a company board.
 *
 * `wake` is what brings an oracle up, and cell never touches it. The oracle's own
 * native pane IS the head: not adopted, not renamed, not relaunched, not killed,
 * and — since kobo-822 — not stamped either. `wake` stamps it when it launches
 * the agent; cell only READS `@oracle_pane={oracle}:head` to find it, and refuses
 * when it is absent rather than deciding for itself which pane the oracle is.
 * `spawn` adds a `worker` beside the head and stamps it; `down` removes it.
 *
 * kobo-859 — a cell is head + worker only. There used to be a `reviewer` pane
 * too; review-requests already land on the worker pane (feeder dispatches by
 * role, kobo-771), so the reviewer pane had no work of its own to do. Removed
 * system-wide, not per-company: an option added only to disable a feature
 * leaves you maintaining both.
 *
 * Why the head needs no contract and no launch line — this is what shrank the
 * file: the feeder dispatches work to panes by ROLE directly (kobo-771), nothing
 * routes through the head. So `self-spawn`, the head launch line, the head
 * contract, the send-keys injection and the agent handoff had no consumer left
 * and are gone rather than left unreachable.
 *
 * THREE THINGS THIS FILE KEEPS STRICTLY APART, because collapsing them is exactly
 * what made the old version type shell lines into live agents:
 *   stamp  — `tmux set-option -p` from OUTSIDE. Touches no running process.
 *   rename — never done to a head window. Only our own `cell-workers`.
 *   boot   — only ever the CREATION ARGUMENT of a brand-new pane. Never typed.
 * There is no `send-keys` in this file, and there must never be one again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBusyGuard, findWindow, hostExec, listSessions, type Session } from "maw-js/sdk";
import { loadCompany, type Company } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { BRAIN_MODEL, DEFAULT_WORKER_MODEL } from "../../../core/agent-panes";
import { ORACLE_PANE_OPTION, stampPaneIdentity, type PaneRole } from "../../../core/pane-identity";

const CELL_WORKERS_WINDOW = "cell-workers";
/**
 * Windows cell CREATES panes in — this one and the two singular names older
 * versions used. A head never lives in one, which is the only thing this list is
 * trusted for: it narrows head candidates and names orphans (see
 * `orphanCellPanes`). It is deliberately NOT a kill selector — window name is a
 * shared namespace and selecting kills by it is the kobo-764 bug.
 */
const CELL_WINDOWS = new Set([CELL_WORKERS_WINDOW, "cell-worker", "cell-reviewer"]);
/**
 * kobo-780 — the tail of the cell state path, never a whole one. It used to be
 * used relative, on the premise that the writer ran in the head pane's cwd. That
 * premise was false: `~/bin/maw` does `cd /Users/tony/maw-js` before exec, so
 * `process.cwd()` inside ANY maw invocation is maw-js — every oracle wrote its
 * contracts into the same directory, each overwriting the last. Everything hangs
 * off `cellAnchor()`; see it for why the anchor is what it is.
 */
const DEFAULT_STATE_DIR = "ψ/active/cell";

/** The one pane cell owns. The head is the oracle's, and is not on this list. */
const CELL_ROLES = ["worker"] as const;
type CellRole = (typeof CELL_ROLES)[number];

const ROLE_TITLE: Record<CellRole, string> = { worker: "⚒ worker" };

function shellArg(s: string): string { return `'${s.replace(/'/g, "'\\''")}'`; }
function resolveHome(): string { return process.env.HOME || homedir(); }

function contractAssetPath(role: CellRole): string {
  return join(resolveHome(), ".claude", "skills", "cell", "contracts", `${role}.md`);
}

function renderContract(role: CellRole, vars: { company: string; dept: string; board: string }): string {
  const tpl = readFileSync(contractAssetPath(role), "utf8");
  return tpl.replaceAll("{{COMPANY}}", vars.company).replaceAll("{{DEPT}}", vars.dept).replaceAll("{{BOARD}}", vars.board);
}

/**
 * The dept of the oracle whose contract this is — NOT the caller's.
 *
 * This replaces `resolveSelfDept()`, which read the CURRENT process's identity
 * (`CLAUDE_AGENT_NAME`, else its own tmux session). That was correct while the
 * writer ran inside the target pane. In a loop-the-roster design it is a bug of
 * the same shape as stamping every pane with the caller's name: one process
 * rendering eleven contracts stamped its own dept into all eleven, and from a
 * machine with no tmux it resolved to `""` and every contract read `(none)`.
 *
 * An oracle genuinely outside any dept renders `(none)` explicitly, never blank.
 */
export function resolveOracleDept(oracle: string): string {
  return scopeOfOracle(oracle)?.dept || "(none)";
}

interface RosterMember { oracle: string }

function companyRoster(co: Company): RosterMember[] {
  const seen = new Set<string>();
  const out: RosterMember[] = [];
  if (co.manager) { seen.add(co.manager); out.push({ oracle: co.manager }); }
  for (const team of Object.values(co.teams)) {
    for (const m of team.members) {
      if (seen.has(m.oracle)) continue;
      seen.add(m.oracle);
      out.push({ oracle: m.oracle });
    }
  }
  return out;
}

interface PaneRow { paneId: string; role: string; windowName: string; identity: string; path: string }

async function listSessionPanes(sessionName: string): Promise<PaneRow[]> {
  let raw: string;
  try {
    raw = await hostExec(`tmux list-panes -s -t ${shellArg(sessionName)} -F '#{pane_id}|||#{@role}|||#{window_name}|||#{${ORACLE_PANE_OPTION}}|||#{pane_current_path}'`);
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    const [paneId = "", role = "", windowName = "", identity = "", path = ""] = line.split("|||");
    return { paneId, role, windowName, identity, path };
  });
}

/**
 * kobo-764 — selection is the `@oracle_pane` identity and NOTHING else. Window
 * name and pane title are decoration anything can write; the option is only
 * written by a deliberate `tmux set-option`. A pane with NO identity is not ours:
 * never killed (fail-closed).
 */
function paneIdentityOf(p: PaneRow): { oracle: string; role: string } | null {
  const raw = (p.identity ?? "").trim();
  const i = raw.indexOf(":");
  if (i <= 0 || i === raw.length - 1) return null;
  return { oracle: raw.slice(0, i), role: raw.slice(i + 1) };
}

/** The kill list: this oracle's two cell-born panes. A head is never on it. */
function isTeardownTarget(p: PaneRow, oracle: string): boolean {
  const id = paneIdentityOf(p);
  return !!id && id.oracle === oracle && (CELL_ROLES as readonly string[]).includes(id.role);
}

/** This oracle's pane for each cell role it already has, by identity. */
function rolePanesOf(panes: PaneRow[], oracle: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const p of panes) {
    const id = paneIdentityOf(p);
    if (id?.oracle === oracle && !found.has(id.role)) found.set(id.role, p.paneId);
  }
  return found;
}

/** `%42` → 42, for ordering. Unparseable ids sort last rather than first. */
function paneIdNum(paneId: string): number {
  const n = Number(paneId.replace(/^%/, ""));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * kobo-775/782 — two panes CAN claim `{oracle}:head` (a stamp landed on a newly
 * adopted pane while the old one still carried its own; there is a real one on
 * the fleet right now, `23-worker1`). Both look equally valid, so the winner is a
 * STATED rule rather than tmux's listing order: LOWEST PANE ID = the oldest pane
 * = the one the oracle has been living in (tmux hands out `%N` monotonically).
 * Every loser is named: a duplicate head can be a live agent in someone else's
 * session, so it is warned about and never touched.
 */
function findHeadPane(panes: PaneRow[], oracle: string): { pane?: PaneRow; duplicates: PaneRow[] } {
  const claimants = panes
    .filter((p) => {
      const id = paneIdentityOf(p);
      return id?.oracle === oracle && id.role === "head";
    })
    .sort((a, b) => paneIdNum(a.paneId) - paneIdNum(b.paneId) || a.paneId.localeCompare(b.paneId));
  return { pane: claimants[0], duplicates: claimants.slice(1) };
}

function dualHeadWarning(oracle: string, winner: PaneRow, duplicates: PaneRow[]): string {
  return `⚠ ${oracle}: ${duplicates.length + 1} panes claim ${ORACLE_PANE_OPTION}=${oracle}:head — ${[winner, ...duplicates].map((p) => p.paneId).join(", ")}; using ${winner.paneId} (lowest pane id = oldest). The others are LEFT ALONE (a duplicate head can be a live agent in another session). Clear a stale one with \`tmux set-option -pu -t <pane> ${ORACLE_PANE_OPTION}\`.`;
}

/**
 * kobo-822 F2 — panes cell created whose stamp never landed. They are invisible
 * to everything else here (`rolePanesOf` and `isTeardownTarget` key on
 * `@oracle_pane` and nothing else, kobo-764), so spawn builds a second worker
 * beside them and down leaves them running forever. Real ones exist:
 * `09-repo-architect` `%367`/`%370`.
 *
 * ponytail: named, not adopted and not killed. Adopting them by window name is
 * the exact selector kobo-764 removed for killing a human's pane, and a stamp is
 * as irreversible as a kill for routing purposes. Naming them is what the caller
 * cannot get anywhere else; the fix is one `tmux` line they can read here.
 */
function orphanCellPanes(panes: PaneRow[]): PaneRow[] {
  return panes.filter((p) => CELL_WINDOWS.has(p.windowName) && !paneIdentityOf(p));
}

function orphanWarning(oracle: string, orphans: PaneRow[]): string {
  return `⚠ ${oracle}: ${orphans.length} pane(s) in a cell window carry no ${ORACLE_PANE_OPTION} (${orphans.map((p) => `${p.paneId} in ${p.windowName}`).join(", ")}) — cell selects on that option only, so spawn will build alongside them and down will never remove them. Stamp one: tmux set-option -p -t <pane> ${ORACLE_PANE_OPTION} ${shellArg(`${oracle}:worker`)} — or kill it: tmux kill-pane -t <pane>.`;
}

function parseCompanyArg(args: string[]): string | undefined {
  return args.find((a, i) => i > 0 && !a.startsWith("--"));
}

function sessionNameOf(resolved: string): string {
  const i = resolved.indexOf(":");
  return i === -1 ? resolved : resolved.slice(0, i);
}

function resolveMemberSession(oracle: string, sessions: Session[]): string | null {
  try { return findWindow(sessions, oracle); } catch { return null; }
}

/**
 * kobo-780 — the ONE resolution of "which repo is this oracle's cell anchored
 * to". Give it a pane, get that pane's oracle repo, or nothing.
 *
 * Why `session_path` and not the obvious candidates:
 *   - `process.cwd()` is a lie in this process. `~/bin/maw` does `cd
 *     /Users/tony/maw-js` before exec, so cwd is maw-js in EVERY maw invocation
 *     regardless of where it was typed. (`$PWD` is no better — bash's `cd`
 *     exports it, verified.)
 *   - `#{pane_current_path}` is poisoned for the same reason, but only sometimes,
 *     which is worse: tmux reads it from the pane's FOREGROUND process.
 *   - `#{session_path}` is set once by `tmux new-session -c <repoPath>` (wake-cmd
 *     does exactly that) and no later process can move it.
 *
 * `-t` is mandatory and a blank target is refused: a bare `display-message`
 * answers for the ATTACHED CLIENT's active pane, which is whatever the human was
 * looking at — not the caller.
 */
async function cellAnchor(paneTarget: string): Promise<string | null> {
  if (!(paneTarget ?? "").trim()) return null;
  try {
    const path = (await hostExec(`tmux display-message -p -t ${shellArg(paneTarget)} '#{session_path}'`)).trim();
    return path || null;
  } catch {
    return null;
  }
}

/** The cell state dir for an anchor. The only place these two are joined. */
function stateDirOf(anchor: string): string {
  return join(anchor, DEFAULT_STATE_DIR);
}

/**
 * The launch line for a pane cell is about to CREATE. It is passed to
 * `new-window` as the creation argument — it is never typed at a pane, so
 * there is no pane here to be occupied by anything.
 *
 * B5 (kobo-765): `test -s <contract>` first. A missing or empty contract means
 * the pane would boot with an EMPTY system prompt — alive, and behaving like a
 * stranger. There must be no path to that, so the launch does not happen and the
 * pane says why. It applies to worker for the same reason it once applied to
 * head; the head no longer needs one because nothing routes through it.
 *
 * B7 (kobo-765): no `exec`. `exec claude` REPLACED the pane's shell, so a boot
 * failure (bad model) killed the pane outright — nothing to fall back to, nothing
 * to inspect. Plain `claude` keeps the shell underneath, so a non-zero exit falls
 * through to the fallback model. That `||` IS the model ladder: it replaces the
 * old capture-pane boot poll + kill-window + respawn, and it runs in the pane's
 * own shell, so no amount of roster size makes spawn slow.
 *
 * ponytail: the `||` fires on ANY non-zero exit, not just a boot failure — a pane
 * that dies hours later comes back on the fallback model. Gate it on `$SECONDS`
 * if boot-only ever matters.
 */
function roleLaunchCommand(role: CellRole, company: string, anchor: string, headPane: string): string {
  const stateDir = stateDirOf(anchor);
  const contract = join(stateDir, `${role}-contract.md`);
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");
  const claude = (model: string) => [
    `MAW_ROOM_COMPANY=${shellArg(company)}`,
    `CREW_ROLE=${role}`,
    `CREW_COORD_PANE=${shellArg(headPane)}`,
    `CREW_STATE_DIR=${shellArg(stateDir)}`,
    "claude",
    `--model ${shellArg(model)}`,
    `--settings ${shellArg(settingsPath)}`,
    "--dangerously-skip-permissions",
    `--append-system-prompt "$(cat ${shellArg(contract)})"`,
  ].join(" ");
  const refuse = `⚠ cell ${role} NOT started: ${contract} is missing or empty — it would have booted with an empty system prompt. Re-run \`maw company cell spawn ${company}\`.`;
  // if/else, not `&& … || echo`: with `||` a claude that merely exits non-zero
  // would print the "contract is missing" line, which is a lie about the cause.
  return `cd ${shellArg(anchor)} && if test -s ${shellArg(contract)}; then ${claude(BRAIN_MODEL)} || ${claude(DEFAULT_WORKER_MODEL)}; else echo ${shellArg(refuse)}; fi`;
}

/**
 * kobo-759 — stamp `@oracle_pane` on a pane whose id we captured exactly. Loud on
 * failure: a pane silently missing its identity reads as "unknown" to the observe
 * layer, which is indistinguishable from a human-split pane.
 */
async function stampCellPane(paneId: string, oracle: string, role: PaneRole, emit: (line: string) => void): Promise<void> {
  if (await stampPaneIdentity(paneId, oracle, role, hostExec)) return;
  emit(`⚠ pane identity not set on ${paneId} (${role}) — oracle name unresolved or tmux refused; this pane will read as unknown`);
}

async function showPaneLabels(target: string): Promise<void> {
  await hostExec(`tmux set-window-option -t ${shellArg(target)} pane-border-status top`);
  await hostExec(`tmux set-window-option -t ${shellArg(target)} pane-border-format ${shellArg("#{pane_title}")}`);
}

/**
 * Create the worker pane: a NEW window in the ORACLE's session.
 *
 * `-t <session>:` is not optional. A bare `new-window` lands in the CALLER's
 * session, and spawn now runs from outside every oracle — it would have built
 * eleven oracles' panes in whichever session the human happened to be sitting in.
 * `-d` so the oracle's own display is not yanked to a new window either.
 */
async function createWorkerPane(sessionName: string, launch: string): Promise<string> {
  const paneId = (await hostExec(
    `tmux new-window -d -t ${shellArg(`${sessionName}:`)} -n ${shellArg(CELL_WORKERS_WINDOW)} -P -F '#{pane_id}' ${shellArg(launch)}`,
  )).trim();
  return paneId;
}

/** Cosmetics on panes cell created. Never on a head. */
async function dressCellPane(paneId: string, role: CellRole, oracle: string, emit: (line: string) => void): Promise<void> {
  await hostExec(`tmux set-option -p -t ${shellArg(paneId)} @role ${shellArg(ROLE_TITLE[role])}`);
  await stampCellPane(paneId, oracle, role, emit);
  await hostExec(`tmux select-pane -t ${shellArg(paneId)} -T ${shellArg(ROLE_TITLE[role])}`);
}

export interface CellSpawnResult {
  ok: boolean;
  error?: string;
  head?: string;
  worker?: string;
}

export async function companyCellSpawn(company: string | undefined, emit: (line: string) => void, verbose = false): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell spawn <company> [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };
  for (const role of CELL_ROLES) {
    if (!existsSync(contractAssetPath(role))) return { ok: false, error: `contract asset missing: ${contractAssetPath(role)} — run maw crew-skills sync first` };
  }

  const log = (line: string) => { if (verbose) emit(line); };
  let ready = 0, partial = 0, asleep = 0, refused = 0;
  const roster = companyRoster(co);
  const sessions = await listSessions();

  for (const member of roster) {
    const resolved = resolveMemberSession(member.oracle, sessions);
    if (!resolved) {
      // Cell adds panes to a RUNNING oracle. It does not wake one — that is
      // `wake`'s job, and the old spawn calling it is what made this verb able to
      // relaunch an oracle out from under itself.
      emit(`⚠ ${member.oracle}: no tmux session — cell adds panes to a running oracle, it never wakes one. Run \`maw wake ${member.oracle}\` first, then re-run this.`);
      asleep++;
      continue;
    }

    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName);
    const orphans = orphanCellPanes(panes);
    if (orphans.length > 0) emit(orphanWarning(member.oracle, orphans));
    // The head is found by its `@oracle_pane` stamp and by nothing else, and
    // spawn does not write that stamp — `wake` does, at the moment it launches
    // the agent (`stampWakePane`, wake-cmd.ts). Everything that guessed which
    // pane "must be" the head from window name or index is deleted: a guess that
    // lands wrong hands one oracle's pane to another, silently, and nothing
    // downstream would question it. Unstamped is not spawn's to fix.
    const head = findHeadPane(panes, member.oracle);
    if (head.duplicates.length > 0 && head.pane) emit(dualHeadWarning(member.oracle, head.pane, head.duplicates));
    if (!head.pane) {
      emit(`⚠ ${member.oracle}: REFUSED — no pane in session ${sessionName} carries ${ORACLE_PANE_OPTION}=${member.oracle}:head. Cell does not stamp heads; wake does. Run \`maw wake ${member.oracle}\` and re-run this. (An oracle running since before kobo-759 has no stamp until it is re-woken.)`);
      refused++;
      continue;
    }
    const headPane = head.pane.paneId;

    const anchor = await cellAnchor(headPane);
    if (!anchor) {
      emit(`⚠ ${member.oracle}: REFUSED — cannot read #{session_path} for ${headPane}, so this oracle's repo is unknown. Refusing rather than anchoring the cell to this process's cwd (the maw wrapper makes that maw-js for every oracle).`);
      refused++;
      continue;
    }

    const stateDir = stateDirOf(anchor);
    const dept = resolveOracleDept(member.oracle);
    try {
      mkdirSync(stateDir, { recursive: true });
      for (const role of CELL_ROLES) {
        writeFileSync(join(stateDir, `${role}-contract.md`), renderContract(role, { company, dept, board: company }));
      }
    } catch (e: any) {
      emit(`⚠ ${member.oracle}: REFUSED — cannot write cell contracts to ${stateDir} (${e.message}); a pane launched without one boots with an empty system prompt.`);
      refused++;
      continue;
    }

    const have = rolePanesOf(panes, member.oracle);
    let worker = have.get("worker") ?? "";
    log(`${member.oracle}: head=${headPane} anchor=${anchor} existing=${[...have.keys()].join("+") || "none"}`);

    try {
      if (!worker) {
        worker = await createWorkerPane(sessionName, roleLaunchCommand("worker", company, anchor, headPane));
        if (worker) {
          await showPaneLabels(worker);
          await dressCellPane(worker, "worker", member.oracle, emit);
        }
      }
    } catch (e: any) {
      emit(`⚠ ${member.oracle}: pane creation failed (${e.message})`);
    }

    // Count from what the SERVER says, never from what the creation calls
    // returned: a summary that reports its own intentions is the failure kobo-822
    // opened on (`1 ready · 0 repaired · 10 refused` while nothing had changed).
    const after = rolePanesOf(await listSessionPanes(sessionName), member.oracle);
    const missing = CELL_ROLES.filter((r) => !after.has(r));
    if (missing.length === 0) {
      log(`${member.oracle}: worker=${after.get("worker")} (head ${headPane} untouched)`);
      ready++;
    } else {
      emit(`⚠ ${member.oracle}: INCOMPLETE — no pane carrying ${ORACLE_PANE_OPTION}=${member.oracle}:${missing.join(`/${member.oracle}:`)} after spawn; head ${headPane} is untouched and still stamped.`);
      partial++;
    }
  }

  emit(`✓ cell spawn ${company}: ${ready} ready, ${partial} incomplete, ${asleep} not-running, ${refused} refused (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

export async function companyCellDown(company: string | undefined, opts: { force?: boolean; verbose?: boolean }, emit: (line: string) => void): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell down <company> [--force] [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const log = (line: string) => { if (opts.verbose) emit(line); };
  let torn = 0, partial = 0, skipped = 0, refused = 0;
  const roster = companyRoster(co);
  const sessions = await listSessions();

  for (const member of roster) {
    const resolved = resolveMemberSession(member.oracle, sessions);
    if (!resolved) { log(`${member.oracle}: no session found — nothing to tear down`); skipped++; continue; }
    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName);
    // Said here too: an orphan is a pane down is ABOUT to report gone-and-quiet
    // over, while it stays up running an agent.
    const orphans = orphanCellPanes(panes);
    if (orphans.length > 0) emit(orphanWarning(member.oracle, orphans));
    // Only a pane `findHeadPane` actually RESOLVES gates a teardown, and only the
    // winner is ever named — kobo-782: a duplicate `{oracle}:head` can be a live
    // agent in someone else's session. Down does not kill heads at all, so the
    // duplicate is warned about and otherwise left completely alone.
    const { pane: headPane, duplicates } = findHeadPane(panes, member.oracle);
    if (headPane && duplicates.length > 0) emit(dualHeadWarning(member.oracle, headPane, duplicates));

    if (!headPane) {
      log(`⚠ ${member.oracle}: no pane carrying ${ORACLE_PANE_OPTION}=${member.oracle}:head in session ${sessionName} — skipping teardown fail-closed`);
      skipped++;
      continue;
    }

    // kobo-778 — the busy guard fails CLOSED: an oracle the status source knows
    // nothing about used to read `busy:false`, so teardown was approved for panes
    // it could not see. Loud on purpose (emit, not log): under --verbose only, a
    // summary of "0 torn, 3 refused" would carry no reason at all.
    if (opts.force) {
      emit(`⚠ ${member.oracle}: --force — busy guard SKIPPED, tearing down without checking whether this oracle is working`);
    } else {
      const guard = await checkBusyGuard(member.oracle, { failClosed: true });
      if (guard.busy) {
        const why = guard.reason ?? `oracle reports status '${guard.status}'`;
        emit(`⚠ ${member.oracle}: refusing cell teardown — ${why}; pass --force to tear down anyway`);
        refused++;
        continue;
      }
    }

    // kobo-822 F3 — no `process.env.TMUX_PANE` exemption. It was the last read of
    // the CALLER's identity in this file, and it did not protect anything: a cell
    // pane running `down` dropped SILENTLY out of the kill list while the summary
    // still said `torn`, so a cell reported as gone was still up. Membership of
    // the kill list is the pane's own `@oracle_pane` and nothing about who asked.
    // ponytail: `down` from inside a cell pane now kills that pane, ending the run
    // there — visible (the pane vanishes), unlike the survivor it used to leave.
    const toKill = panes.filter((p) => p.paneId && isTeardownTarget(p, member.oracle));

    for (const pane of toKill) {
      try { await hostExec(`tmux kill-pane -t ${shellArg(pane.paneId)}`); } catch { /* verified below, not here */ }
    }

    // Count from what the SERVER says, not from what kill-pane returned: a kill
    // that threw may still have landed, and one that returned cleanly may not
    // have. `killed` must mean "pane is gone".
    let killed = 0;
    const failures: string[] = [];
    if (toKill.length > 0) {
      const after = await listSessionPanes(sessionName);
      const alive = new Set(after.map((p) => p.paneId));
      // Negative control: head is never a target, so a listing that lost it is a
      // failed probe, not an empty session — refuse to read it as success.
      const probeOk = alive.has(headPane.paneId);
      for (const pane of toKill) {
        if (probeOk && !alive.has(pane.paneId)) { killed++; continue; }
        failures.push(probeOk ? pane.paneId : `${pane.paneId} (unverifiable: pane listing lost the head pane)`);
      }
    }

    if (failures.length > 0) {
      // Loud on purpose (emit, not log): this used to count every attempt as a
      // kill, so a cell still standing reported as torn down.
      emit(`⚠ ${member.oracle}: cell teardown PARTIAL — killed ${killed}/${toKill.length}, still up: ${failures.join(", ")}`);
      partial++;
      continue;
    }

    // Said out loud, not only under --verbose: "the session went quiet" must not
    // read as "the oracle was killed too". The head keeps its `{oracle}:head`
    // stamp — that is exactly what a solo `maw wake` pane carries, and dropping
    // it would blind the feeder to an oracle that is still very much there.
    emit(`${member.oracle}: killed ${killed}/${toKill.length} cell pane(s); head ${headPane.paneId} ALIVE and still stamped ${ORACLE_PANE_OPTION}=${member.oracle}:head`);
    torn++;
  }

  emit(`✓ cell down ${company}: ${torn} torn, ${partial} partial, ${skipped} skipped, ${refused} refused (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

export function parseCellCompanyArg(args: string[]): string | undefined { return parseCompanyArg(args); }
