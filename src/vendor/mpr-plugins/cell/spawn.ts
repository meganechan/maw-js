/**
 * `maw company cell spawn <company>` — company/oracle based Cell v2 wake+build.
 *
 * Tony's requested shape is NOT a caller-local `main` pane. It is per oracle:
 *
 *   head | reviewer/worker
 *
 * kobo-822 — spawn never types a command into a pane it does not own the
 * process of. `cmdWake` is the PRIMARY path for every roster member, not a
 * fallback for "no session found": it is also how an already-live pane
 * (running claude, unstamped) gets its `@oracle_pane` identity — kobo-777's
 * in-place stamp, a `tmux set-option` from OUTSIDE the pane, never a keystroke
 * typed into it. Once a pane carries `{oracle}:head`, spawn fills in whatever
 * worker/reviewer panes are missing the same way: `tmux new-window` /
 * `split-window`, each given its launch command directly at creation — never a
 * line typed into a pane that already has something running in it.
 *
 * There is no separate "repair" mode. `cell down <company>` tears down a whole
 * cell, head included; `cell spawn <company>` always builds whatever is
 * missing from there. Repairing a broken cell is `down` then `spawn` — two
 * verbs, not a third one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBusyGuard, cmdWake, findWindow, hostExec, listSessions, type Session } from "maw-js/sdk";
import { loadCompany, type Company } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { BRAIN_MODEL, DEFAULT_WORKER_MODEL } from "../../../core/agent-panes";
import { ORACLE_PANE_OPTION, stampPaneIdentity, type PaneRole } from "../../../core/pane-identity";

const CELL_WORKERS_WINDOW = "cell-workers";
/**
 * kobo-765/B5 — the ONE point where the cell state dir is decided, for both the
 * process that writes the contracts and the launch lines that read them
 * (`companyCellSpawn`, worker/reviewer launch commands). Name is historical:
 * there is no override any more, and that is the fix.
 *
 * It used to be derived twice: the writer took the pane's inherited
 * CREW_STATE_DIR env when set, the launch line always took this. A pane that had
 * already been a cell still exported the PREVIOUS cell's dir, so the contracts
 * were written over there while head cat'd this path, got nothing, and booted
 * with an EMPTY system prompt.
 *
 * Env cannot be the shared answer here even in principle: the launch line is
 * built in the SPAWNER's process and runs in the TARGET pane's shell — two
 * different environments — and the pane's env is exactly where the stale value
 * lives. We still EXPORT CREW_STATE_DIR into the spawned panes (the seat/Stop
 * hooks read it); it is an output, never an input.
 *
 * kobo-780 — this is now the tail of a path, never a whole one. It used to be
 * used relative, on the premise that "writer and launch line both run in the head
 * pane's cwd". That premise was false the whole time: `~/bin/maw` does `cd
 * /Users/tony/maw-js` before exec, so process.cwd() inside ANY maw invocation is
 * maw-js — every oracle's self-spawn wrote its contracts into the same maw-js
 * directory, each overwriting the last, and booted its worker/reviewer there too.
 * Everything now hangs off cellAnchor(); see it for why the anchor is what it is.
 */
const DEFAULT_STATE_DIR = "ψ/active/cell";
const STATE_FILES = ["head.md", "worker.md", "reviewer.md", "head-contract.md", "worker-contract.md", "reviewer-contract.md"];
type Role = "head" | "worker" | "reviewer";

function shellArg(s: string): string { return `'${s.replace(/'/g, "'\\''")}'`; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function resolveHome(): string { return process.env.HOME || homedir(); }
function bootPollMs(): number {
  const override = Number(process.env.CELL_SPAWN_POLL_MS);
  return Number.isFinite(override) && override > 0 ? override : 2000;
}
const BOOT_FAIL_RE = /not available for your account|unknown model|invalid model|no such model/i;
const BOOT_READY_RE = /^❯\s*$/m;
const BOOT_POLL_MAX = 10;
const RETRY_POLL_MAX = 5;
const INJECT_SETTLE_MS = 450;

function contractAssetPath(role: Role): string {
  return join(resolveHome(), ".claude", "skills", "cell", "contracts", `${role}.md`);
}

function renderContract(role: Role, vars: { company: string; dept: string; board: string }): string {
  const tpl = readFileSync(contractAssetPath(role), "utf8");
  return tpl.replaceAll("{{COMPANY}}", vars.company).replaceAll("{{DEPT}}", vars.dept).replaceAll("{{BOARD}}", vars.board);
}

/**
 * kobo-cell-spawn-dept-resolve: the CURRENT pane's own oracle identity —
 * CLAUDE_AGENT_NAME, else the pane's own tmux session name (numeric prefix
 * stripped). Inlined rather than importing commands/shared/comm-send's
 * resolveAgentSelf(): that import drags the maw-js/sdk barrel into this
 * plugin's module graph, which broke isolated tests where sdk is mocked
 * without every export (kobo-cell-spawn-dept-resolve CI review). Mirrors
 * resolveAgentSelf (comm-send.ts:264) in a few lines.
 */
function selfOracleId(): string {
  const agent = process.env.CLAUDE_AGENT_NAME?.trim();
  if (agent) return agent;
  if (process.env.TMUX) {
    try {
      const session = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
      if (session) return session.replace(/^\d+-/, "");
    } catch { /* not in a live tmux pane */ }
  }
  return "";
}

/**
 * kobo-cell-spawn-dept-resolve: resolve the CURRENT pane's own dept for the
 * rendered contract. Was reading `loadConfig().oracle` — a generic maw-js
 * family identity that defaults to "mawjs" everywhere it's consumed — never
 * the specific oracle instance name a company roster keys on, so the lookup
 * always missed. selfOracleId() matches how the roster loop above resolves
 * sessions via findWindow(sessions, member.oracle). An oracle genuinely
 * outside any dept (or an unresolvable identity) renders explicitly rather
 * than a blank.
 */
export function resolveSelfDept(): string {
  return scopeOfOracle(selfOracleId())?.dept || "(none)";
}

async function capturePane(paneId: string): Promise<string> {
  try { return await hostExec(`tmux capture-pane -t ${shellArg(paneId)} -p -S -20`); } catch { return ""; }
}

async function pollBoot(paneId: string, maxTries: number): Promise<boolean> {
  for (let i = 0; i < maxTries; i++) {
    await sleep(bootPollMs());
    const boot = await capturePane(paneId);
    if (!boot) continue;
    if (BOOT_FAIL_RE.test(boot)) return false;
    if (boot.includes("bypass permissions") || BOOT_READY_RE.test(boot)) return true;
  }
  return false;
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
 * kobo-764 — teardown selection is the `@oracle_pane` identity and NOTHING else.
 *
 * What it replaces: a pane counted as "cell owned" if its `@role` started with a
 * cell emoji OR its window was named `cell-head`/`cell-workers`. Both are shared
 * namespaces — one tmux session holds several oracles' cells plus human panes, so
 * `down A` reached B's panes and any human split that happened to sit in a
 * cell-named window. Window name and pane title are decoration anything can write;
 * the option is only written by a deliberate `tmux set-option`.
 *
 * A pane with NO identity is NOT ours: never killed (fail-closed).
 */
function paneIdentityOf(p: PaneRow): { oracle: string; role: string } | null {
  const raw = (p.identity ?? "").trim();
  const i = raw.indexOf(":");
  if (i <= 0 || i === raw.length - 1) return null;
  return { oracle: raw.slice(0, i), role: raw.slice(i + 1) };
}

/**
 * The kill list: this oracle's worker/reviewer panes. Head is handled
 * separately in `companyCellDown` — deliberately the single RESOLVED winner
 * from `findHeadPane`, never every pane that merely claims `{oracle}:head`.
 * kobo-782's own warning is exactly why: a duplicate head claimant is a LIVE
 * pane with a live agent in it, and killing one automatically off a naive
 * identity match would destroy work to tidy a label. Worker/reviewer carry no
 * such ambiguity — a cell never legitimately has two.
 */
function isTeardownTarget(p: PaneRow, oracle: string): boolean {
  const id = paneIdentityOf(p);
  return !!id && id.oracle === oracle && (id.role === "worker" || id.role === "reviewer");
}

/**
 * kobo-775 — the roles THIS oracle actually has panes for, by identity.
 *
 * Readiness used to be "the session has a 👤 pane and a ⚒ pane and a 🔎 pane",
 * which asks about the SESSION, not the oracle: with A's cell down and B's cell
 * up in the same session, A read as ready and was never repaired. It also had to
 * disagree with down by construction — down clears the head's `@role` and kills
 * the panes that carried the other two, so what it leaves behind cannot be what
 * readiness reads. Identity is the one thing down and spawn can both name.
 */
function cellRolesOf(panes: PaneRow[], oracle: string): Set<string> {
  const roles = new Set<string>();
  for (const p of panes) {
    const id = paneIdentityOf(p);
    if (id?.oracle === oracle) roles.add(id.role);
  }
  return roles;
}

/** `%42` → 42, for ordering. Unparseable ids sort last rather than first. */
function paneIdNum(paneId: string): number {
  const n = Number(paneId.replace(/^%/, ""));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * kobo-775 — two panes CAN claim `{oracle}:head` (a stamp landed on a newly
 * adopted pane while the old one still carried its own). Both look equally
 * valid, so the winner is a stated rule rather than tmux's listing order:
 * LOWEST PANE ID = the oldest pane = the one the oracle has been living in
 * (tmux hands out `%N` monotonically). Every loser is named to the caller —
 * this pane is where a repair line gets typed, so a silent pick is a blind send.
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
  return `⚠ ${oracle}: ${duplicates.length + 1} panes claim ${ORACLE_PANE_OPTION}=${oracle}:head — ${[winner, ...duplicates].map((p) => p.paneId).join(", ")}; using ${winner.paneId} (lowest pane id = oldest). Clear the stale one with \`tmux set-option -pu -t <pane> ${ORACLE_PANE_OPTION}\`.`;
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
 * tmux `pane_current_command` basenames that will actually EXECUTE a typed
 * line. Allowlist, not denylist: a pane running an agent REPL (claude/node/…)
 * swallows the line as PROMPT TEXT and never runs it, and any command we
 * cannot name gets the same treatment — refuse rather than type blind.
 */
const SHELL_CMDS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

/**
 * kobo-776 — the OTHER kind of pane a cell instruction can reach: an agent REPL.
 * It cannot run a shell line, but it can be TOLD to run one, which is what every
 * oracle's steady state needs (a pane already running claude was previously a
 * dead end, so bringing up a roster meant a human relaying commands by hand).
 *
 * Still an allowlist, and still fail-closed: a pane running vim or psql is
 * neither a shell nor an agent, and a federation message typed at it is the same
 * blind send 5371b28e killed — it stays REFUSED. `node`/`bun` are here because
 * that is how a claude process reports itself through `pane_current_command`
 * depending on how it was launched (the guard's own tests pin `node`).
 */
const AGENT_CMDS = new Set(["claude", "node", "bun"]);

function paneCommandBasename(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return base.replace(/^-/, "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

async function paneCurrentCommand(target: string): Promise<string | null> {
  try {
    const raw = (await hostExec(`tmux display-message -p -t ${shellArg(target)} '#{pane_current_command}'`)).trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** `command` is set only when the pane was READ and turned out not to be a shell —
 *  the caller needs the observed command to decide whether it can be talked to
 *  (kobo-776). An unreadable pane has none, which is what keeps it refused. */
type InjectResult = { ok: true } | { ok: false; reason: string; command?: string };

async function injectCommand(target: string, command: string): Promise<InjectResult> {
  // Classify HERE, in the same call that sends the keys — never from an earlier
  // pane listing: what a pane is running goes stale in seconds. Even the C-u
  // must wait for the verdict; in a REPL it edits the prompt box.
  const current = await paneCurrentCommand(target);
  if (current === null) return { ok: false, reason: `cannot read pane_current_command for ${target}` };
  if (!SHELL_CMDS.has(paneCommandBasename(current))) return { ok: false, reason: `pane ${target} is running '${current}', not a shell`, command: current };
  await hostExec(`tmux send-keys -t ${shellArg(target)} C-u`);
  await hostExec(`tmux send-keys -t ${shellArg(target)} ${shellArg(command)}`);
  await sleep(INJECT_SETTLE_MS);
  await hostExec(`tmux send-keys -t ${shellArg(target)} Enter`);
  return { ok: true };
}

/**
 * kobo-780 — the ONE resolution of "which repo is this oracle's cell anchored
 * to", for the writer (self-spawn), the launch line, and the cleaner (down).
 * Give it a pane, get that pane's oracle repo, or nothing.
 *
 * Why `session_path` and not the obvious candidates:
 *   - `process.cwd()` is a lie in this process. `~/bin/maw` does `cd
 *     /Users/tony/maw-js` before exec, so cwd is maw-js in EVERY maw invocation
 *     regardless of where it was typed. That is the bug being fixed; it cannot
 *     also be the fix. (`$PWD` is no better — bash's `cd` exports it, verified.)
 *   - `#{pane_current_path}` is poisoned for the same reason, but only sometimes,
 *     which is worse. tmux reads it from the pane's FOREGROUND process (macOS:
 *     tcgetpgrp + proc_pidinfo), and during self-spawn the foreground process is
 *     maw itself — sitting in maw-js. Read from OUTSIDE (down, where the pane is
 *     running claude) the very same field answers the oracle's repo. One field,
 *     two answers, depending on who asks: write and clean would silently disagree.
 *   - `#{session_path}` is set once by `tmux new-session -c <repoPath>` (wake-cmd
 *     does exactly that) and no later process can move it. Same answer from
 *     inside and outside, which is what lets one function serve both callers.
 *
 * `-t` is mandatory and a blank target is refused: a bare `display-message`
 * answers for the ATTACHED CLIENT's active pane, which is whatever the human was
 * looking at — not the caller. Returns null rather than a default: there is no
 * safe fallback here, because the wrong answer is a directory this code deletes
 * files from.
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

/** The pane's `session:window.pane` address — what `maw hey` takes as a target. */
async function paneAddress(target: string): Promise<string | null> {
  try {
    const addr = (await hostExec(`tmux display-message -t ${shellArg(target)} -p '#{session_name}:#{window_index}.#{pane_index}'`)).trim();
    return addr || null;
  } catch {
    return null;
  }
}

/**
 * kobo-759 — stamp `@oracle_pane` on a cell pane whose id we captured exactly.
 * Loud on failure: a pane silently missing its identity reads as "unknown" to the
 * observe layer, which is indistinguishable from a human-split pane.
 */
async function stampCellPane(paneId: string, oracle: string, role: PaneRole, emit: (line: string) => void): Promise<void> {
  if (await stampPaneIdentity(paneId, oracle, role, hostExec)) return;
  emit(`⚠ pane identity not set on ${paneId} (${role}) — oracle name unresolved or tmux refused; this pane will read as unknown`);
}

async function showPaneLabels(target: string): Promise<void> {
  await hostExec(`tmux set-window-option -t ${shellArg(target)} pane-border-status top`);
  await hostExec(`tmux set-window-option -t ${shellArg(target)} pane-border-format ${shellArg("#{pane_title}")}`);
}

export interface CellSpawnResult {
  ok: boolean;
  error?: string;
  head?: string;
  worker?: string;
  workerModel?: string;
  reviewer?: string;
}

/**
 * kobo-822 — wake first (primary path, not a fallback), then fill in whatever
 * roles the resulting pane is missing.
 *
 * `cmdWake` is called for EVERY roster member, every time, whether or not a
 * session already exists: that single call covers all three shapes a roster
 * member can be in —
 *   - genuinely asleep → wake creates the session and pane, fresh
 *   - a live solo pane already running claude, never stamped → kobo-777's
 *     `stampLiveSoloPane` names it `{oracle}:head` in place, a `tmux set-option`
 *     issued from OUTSIDE the pane, never a keystroke sent into it
 *   - already a complete cell → wake no-ops (idempotent), spawn reads it ready
 * and it is the same call this function already made when no session was
 * found, just no longer gated on that condition.
 *
 * What is missing after that is filled in the same way self-spawn used to, but
 * from OUTSIDE: worker gets a `tmux new-window`, reviewer a `split-window`,
 * each given its full launch command as the argument the pane is CREATED
 * with — never typed in after the fact. There is nothing here that sends
 * `send-keys` to a pane that already has a process in it.
 */
export async function companyCellSpawn(company: string | undefined, emit: (line: string) => void, verbose = false): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell spawn <company> [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const log = (line: string) => { if (verbose) emit(line); };
  let ready = 0, repaired = 0, refused = 0;
  const roster = companyRoster(co);

  for (const member of roster) {
    try {
      await cmdWake(member.oracle, { noAttach: true, noRehydrate: true });
    } catch (e: any) {
      emit(`⚠ ${member.oracle}: wake failed (${e.message})`);
      refused++;
      continue;
    }

    const sessions = await listSessions();
    const resolved = resolveMemberSession(member.oracle, sessions);
    if (!resolved) {
      emit(`⚠ ${member.oracle}: wake reported success but no session found afterward`);
      refused++;
      continue;
    }

    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName);
    const head = findHeadPane(panes, member.oracle);
    if (head.pane && head.duplicates.length > 0) emit(dualHeadWarning(member.oracle, head.pane, head.duplicates));
    if (!head.pane) {
      emit(`⚠ ${member.oracle}: REFUSED — wake left no pane carrying ${ORACLE_PANE_OPTION}=${member.oracle}:head in session ${sessionName}`);
      refused++;
      continue;
    }

    const roles = cellRolesOf(panes, member.oracle);
    if (roles.has("worker") && roles.has("reviewer")) { log(`${member.oracle}: cell ready — skip`); ready++; continue; }

    // kobo-822: spawn fills in what is missing, it does not patch a half state
    // — the card that shipped this is explicit that there is no repair logic in
    // the code at all. Exactly one of worker/reviewer present is not a shape
    // spawn was asked to reason about; `down` + `spawn` rebuilds it cleanly.
    if (roles.has("worker") !== roles.has("reviewer")) {
      emit(`⚠ ${member.oracle}: cell has head+${roles.has("worker") ? "worker" : "reviewer"} only — asymmetric state, not auto-repaired. Run \`cell down ${company}\` then \`cell spawn ${company}\` to rebuild it cleanly.`);
      refused++;
      continue;
    }

    const headId = head.pane.paneId;
    // kobo-780: same resolver `down` uses, read the same way — from OUTSIDE the
    // pane. Refuse rather than fall back to this process's cwd (the maw wrapper
    // makes that maw-js for every oracle).
    const anchor = await cellAnchor(headId);
    if (!anchor) {
      emit(`⚠ ${member.oracle}: REFUSED — cannot read #{session_path} for ${headId}, so this oracle's repo is unknown. Refusing rather than anchoring the cell to this process's cwd (the maw wrapper makes that maw-js for every oracle).`);
      refused++;
      continue;
    }
    log(`${member.oracle}: cell has head only — filling in worker+reviewer on ${headId}`);

    const missingContract = (["head", "worker", "reviewer"] as Role[]).find((role) => !existsSync(contractAssetPath(role)));
    if (missingContract) {
      emit(`⚠ ${member.oracle}: contract asset missing: ${contractAssetPath(missingContract)} — run maw crew-skills sync first`);
      refused++;
      continue;
    }

    // kobo-822: `self`/`dept` used to be "who am I" (selfOracleId/resolveSelfDept)
    // because self-spawn ran INSIDE each target oracle's own pane — its own
    // identity WAS the member being spawned. companyCellSpawn runs ONCE from an
    // external orchestrator, looping over every roster member in turn: reading
    // the invoker's own env here would stamp every member's worker/reviewer with
    // the SAME (wrong, invoker's) identity instead of each member's own. The
    // member being processed IS the answer, not an ambient lookup.
    const self = member.oracle;
    const dept = scopeOfOracle(member.oracle)?.dept || "(none)";
    const stateDir = stateDirOf(anchor);
    mkdirSync(stateDir, { recursive: true });
    for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }
    writeFileSync(join(stateDir, "head-contract.md"), renderContract("head", { company, dept, board: company }));
    writeFileSync(join(stateDir, "worker-contract.md"), renderContract("worker", { company, dept, board: company }));
    writeFileSync(join(stateDir, "reviewer-contract.md"), renderContract("reviewer", { company, dept, board: company }));
    writeFileSync(join(stateDir, "head.md"), `# Head\n\ncompany=${company}\nstate-dir=${stateDir}\nactive-card=none\n`);

    const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");
    const worker = await spawnWorkerSelfHeal({ cwd: anchor, company, stateDir, settingsPath, head: headId, emit });
    if (!worker.ok || !worker.paneId) {
      emit(`⚠ ${member.oracle}: worker spawn FAILED — ${worker.error ?? "no pane id"}`);
      refused++;
      continue;
    }
    await hostExec(`tmux rename-window -t ${shellArg(worker.paneId)} ${shellArg(CELL_WORKERS_WINDOW)}`);
    await showPaneLabels(worker.paneId);
    await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @role ${shellArg("⚒ worker")}`);
    await stampCellPane(worker.paneId, self, "worker", emit);
    await hostExec(`tmux select-pane -t ${shellArg(worker.paneId)} -T ${shellArg("⚒ worker")}`);

    const revCmd = `cd ${shellArg(anchor)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=reviewer CREW_COORD_PANE=${shellArg(headId)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${BRAIN_MODEL} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "reviewer-contract.md"))})"`;
    const reviewer = (await hostExec(`tmux split-window -h -p 50 -t ${shellArg(worker.paneId)} -P -F '#{pane_id}' ${shellArg(revCmd)}`)).trim();
    if (!reviewer) {
      emit(`⚠ ${member.oracle}: reviewer spawn produced no pane-id`);
      refused++;
      continue;
    }
    const reviewerBooted = await pollBoot(reviewer, BOOT_POLL_MAX);
    if (!reviewerBooted) emit(`⚠ ${member.oracle}: reviewer boot not confirmed on ${reviewer} — pane left up for manual inspection`);
    await showPaneLabels(reviewer);
    await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @role ${shellArg("🔎 reviewer")}`);
    await stampCellPane(reviewer, self, "reviewer", emit);
    await hostExec(`tmux select-pane -t ${shellArg(reviewer)} -T ${shellArg("🔎 reviewer")}`);
    await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @idle_notify_pane ${shellArg(reviewer)}`);
    await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @idle_notify_pane ${shellArg(headId)}`);

    repaired++;
    emit(`✓ ${member.oracle}: cell filled in — head=${headId} worker=${worker.paneId} (${worker.model}) reviewer=${reviewer}`);
  }

  emit(`✓ cell spawn ${company}: ${ready} ready, ${repaired} repaired, ${refused} refused/failed (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

/**
 * kobo-822 — down tears down the WHOLE cell now, head included. There is no
 * longer a path in this file that reads an occupied pane and re-adopts it, so
 * keeping the head alive across a down bought nothing but a pane that LOOKED
 * torn down while still running. Repair is `down` then `spawn`, never a
 * stand-down that leaves a pane up for a later verb to find.
 */
export async function companyCellDown(company: string | undefined, opts: { force?: boolean; verbose?: boolean }, emit: (line: string) => void): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell down <company> [--force] [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const log = (line: string) => { if (opts.verbose) emit(line); };
  let torn = 0, partial = 0, skipped = 0, refused = 0;
  const roster = companyRoster(co);
  const sessions = await listSessions();
  const invokerPane = (process.env.TMUX_PANE || "").trim();

  for (const member of roster) {
    const resolved = resolveMemberSession(member.oracle, sessions);
    if (!resolved) { log(`${member.oracle}: no session found — nothing to tear down`); skipped++; continue; }
    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName);
    const { pane: headPane, duplicates } = findHeadPane(panes, member.oracle);
    if (headPane && duplicates.length > 0) emit(dualHeadWarning(member.oracle, headPane, duplicates));

    if (!headPane) {
      log(`⚠ ${member.oracle}: no pane carrying ${ORACLE_PANE_OPTION}=${member.oracle}:head in session ${sessionName} — skipping teardown fail-closed`);
      skipped++;
      continue;
    }

    // kobo-778 — the busy guard used to fail OPEN: an oracle the status source
    // knows nothing about read as `busy:false`, so teardown was approved for
    // panes it could not see. It says NO now (failClosed) and `guard.reason`
    // names the blind spot. Loud on purpose (emit, not log): under --verbose
    // only, a summary of "0 torn, 3 refused" would carry no reason at all.
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

    // kobo-822: head joins the kill list too, but as the single RESOLVED
    // winner (headPane from findHeadPane) — never every pane that merely
    // claims `{oracle}:head`. A duplicate claimant is left alone on purpose
    // (kobo-782: it may be a live agent in someone else's session; killing it
    // off a naive identity match would destroy work to tidy a label).
    // `invokerPane` still excludes whichever pane is running THIS command, so
    // `cell down` can never kill itself out from under itself.
    const toKill = panes.filter((p) => p.paneId && p.paneId !== invokerPane && isTeardownTarget(p, member.oracle));
    if (headPane.paneId !== invokerPane) toKill.push(headPane);

    if (toKill.length === 0) {
      if (headPane.paneId === invokerPane) {
        emit(`⚠ ${member.oracle}: head ${headPane.paneId} is the invoker's OWN pane — left up, not torn down (would kill the pane running this command)`);
      } else {
        log(`${member.oracle}: nothing to tear down`);
      }
      skipped++;
      continue;
    }

    // kobo-780: resolve the state-dir anchor BEFORE killing — cellAnchor reads
    // `#{session_path}` off the live pane, and there is nothing left to read
    // once head is dead. Best-effort: a delete this cannot anchor is skipped,
    // never guessed.
    const anchor = await cellAnchor(headPane.paneId);

    for (const pane of toKill) {
      try { await hostExec(`tmux kill-pane -t ${shellArg(pane.paneId)}`); } catch { /* verified below, not here */ }
    }

    // Count from what the SERVER says, not from what kill-pane returned. Head is
    // now a kill target and can be the pane whose death takes the whole SESSION
    // with it (it was the last pane standing) — `list-panes` on a session that no
    // longer exists throws, which `listSessionPanes` reads as an empty list,
    // indistinguishable from "the query glitched". `has-session` answers the
    // session's own existence and cannot go empty-on-error the same way, so it is
    // the negative control now instead of "did head survive the listing".
    let killed = 0;
    const failures: string[] = [];
    let sessionGone = false;
    try { await hostExec(`tmux has-session -t ${shellArg(sessionName)}`); } catch { sessionGone = true; }
    if (sessionGone) {
      killed = toKill.length;
    } else {
      const after = await listSessionPanes(sessionName);
      const alive = new Set(after.map((p) => p.paneId));
      for (const pane of toKill) {
        if (!alive.has(pane.paneId)) killed++;
        else failures.push(pane.paneId);
      }
    }

    if (failures.length > 0) {
      // Loud on purpose (emit, not log): this used to count every attempt as a
      // kill, so a cell still standing reported as torn down.
      emit(`⚠ ${member.oracle}: cell teardown PARTIAL — killed ${killed}/${toKill.length}, still up: ${failures.join(", ")}; state left in place`);
      partial++;
      continue;
    }

    if (anchor) {
      const stateDir = stateDirOf(anchor);
      for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }
      log(`${member.oracle}: killed ${killed}/${toKill.length} cell pane(s), head included; cell state removed from ${stateDir}`);
    } else {
      log(`⚠ ${member.oracle}: killed ${killed}/${toKill.length} cell pane(s), head included; cell state LEFT IN PLACE — could not read #{session_path} for ${headPane.paneId} before the kill, refusing to guess the directory`);
    }
    torn++;
  }

  emit(`✓ cell down ${company}: ${torn} torn, ${partial} partial, ${skipped} skipped, ${refused} refused (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

export function parseCellCompanyArg(args: string[]): string | undefined { return parseCompanyArg(args); }

interface WorkerSpawnResult { ok: boolean; error?: string; paneId?: string; model?: string }

async function spawnWorkerSelfHeal(opts: { cwd: string; company: string; stateDir: string; settingsPath: string; head: string; emit: (line: string) => void }): Promise<WorkerSpawnResult> {
  const { cwd, company, stateDir, settingsPath, head, emit } = opts;
  const buildCmd = (model: string) => `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=worker CREW_COORD_PANE=${shellArg(head)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${shellArg(model)} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "worker-contract.md"))})"`;
  let model = BRAIN_MODEL;
  let paneId = (await hostExec(`tmux new-window -P -F '#{pane_id}' -n ${shellArg(CELL_WORKERS_WINDOW)} ${shellArg(buildCmd(model))}`)).trim();
  if (!paneId) return { ok: false, error: "worker spawn produced no pane-id" };
  if (await pollBoot(paneId, BOOT_POLL_MAX)) return { ok: true, paneId, model };

  try { await hostExec(`tmux kill-window -t ${shellArg(paneId)}`); } catch { /* already gone */ }
  model = DEFAULT_WORKER_MODEL;
  paneId = (await hostExec(`tmux new-window -P -F '#{pane_id}' -n ${shellArg(CELL_WORKERS_WINDOW)} ${shellArg(buildCmd(model))}`)).trim();
  if (!paneId) return { ok: false, error: "worker retry-spawn produced no pane-id" };
  if (await pollBoot(paneId, RETRY_POLL_MAX)) return { ok: true, paneId, model };

  try {
    const headAddr = await paneAddress(head);
    if (headAddr) await hostExec(`maw hey ${shellArg(headAddr)} ${shellArg(`[cell spawn double-fail] worker failed ${BRAIN_MODEL}+${DEFAULT_WORKER_MODEL} boot — manual recovery needed`)}`);
  } catch { /* best-effort */ }
  emit("⚠ worker double-fail — surfaced to head, pane left up for manual inspection");
  return { ok: true, paneId, model };
}
