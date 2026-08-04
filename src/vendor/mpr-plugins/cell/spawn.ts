/**
 * `maw company cell spawn <company>` — company/oracle based Cell v2 wake+repair.
 *
 * Tony's requested shape is NOT a caller-local `main` pane. It is per oracle:
 *
 *   head | reviewer/worker
 *
 * The public verb wakes every oracle in the company roster, resolves that
 * oracle's tmux session through the same maw routing machinery as `maw hey`, and
 * injects the local self-spawn into that oracle's own pane. The local self-spawn
 * owns only tmux layout inside that target oracle session.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBusyGuard, cmdWake, findWindow, hostExec, listSessions, type Session } from "maw-js/sdk";
import { loadCompany, type Company } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { teardownCrewWindows, BRAIN_MODEL, DEFAULT_WORKER_MODEL } from "../../../core/agent-panes";
import { ORACLE_PANE_OPTION, stampPaneIdentity, type PaneRole } from "../../../core/pane-identity";

const CELL_WORKERS_WINDOW = "cell-workers";
const CELL_HEAD_WINDOW = "cell-head";
/**
 * kobo-775 — where self-spawn parks the head window's ORIGINAL name so down can
 * put it back. Down cannot derive it: by then the only name on the window is the
 * one self-spawn wrote. A tmux user option, for the same reason `@oracle_pane` is
 * one (core/pane-identity): only a deliberate set-option writes it.
 */
const PREV_WINDOW_OPTION = "@cell_prev_window";
/**
 * kobo-765/B5 — the ONE point where the cell state dir is decided, for BOTH the
 * process that WRITES the contracts (cellSelfSpawn) and the launch line that
 * READS them (headLaunchCommand). Name is historical: there is no override any
 * more, and that is the fix.
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

/**
 * kobo-765/B7 — head boot is its OWN outcome. An injection landing only proves a
 * line was typed; `repaired++` sat right after the send-keys, so a head that died
 * on a bad model was reported as a repair.
 *
 * Ready wins over the fail string here (pollBoot reads them the other way round):
 * the launch line retries IN-PANE with the fallback model, so the first attempt's
 * error text is still on screen while the second one boots — reading it as a
 * verdict would fail a head that recovered. A head that never comes up simply
 * never shows a prompt, which is what this waits for. The window covers both
 * attempts (first boot + fallback), hence the two budgets added.
 */
async function pollHeadReady(paneId: string): Promise<boolean> {
  for (let i = 0; i < BOOT_POLL_MAX + RETRY_POLL_MAX; i++) {
    await sleep(bootPollMs());
    const boot = await capturePane(paneId);
    if (boot && (boot.includes("bypass permissions") || BOOT_READY_RE.test(boot))) return true;
  }
  return false;
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
 * kobo-775 — the pre-759 fallback target: a pane wearing the head `@role` and NO
 * identity at all. Those exist because `@oracle_pane` is younger than the cell.
 *
 * Only when there is EXACTLY ONE in the session: `@role` is a shared namespace
 * (one session holds several oracles' panes plus human splits), so two claimants
 * name nobody. An unidentified pane that is not unique is not evidence.
 */
function soleLegacyHeadPane(panes: PaneRow[]): string | undefined {
  const legacy = panes.filter((p) => p.role.startsWith("👤") && !paneIdentityOf(p));
  return legacy.length === 1 ? legacy[0]!.paneId : undefined;
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

/** The kill list: this oracle's cell-born panes only. head is never a target — it
 *  is the ADOPTED pane the oracle already lived in before the cell existed. */
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
 * kobo-776 — what a running agent is asked to do, in ONE line.
 *
 * One line on purpose: the TUI treats a multi-line send as a paste and can eat or
 * reflow it, and an instruction that arrives mangled is worse than none. Every
 * command in here must be runnable verbatim — the reader is an agent that will
 * copy it into its own Bash, not a human who will fix a typo.
 *
 * The caveat is not decoration. A head launched by the shell path gets the
 * contract via `--append-system-prompt`; an agent that is ALREADY running cannot
 * be handed a system prompt by anyone, so the file is the only channel it has.
 * Leave that out and the pane becomes a head that never read its contract —
 * alive, and behaving like a stranger (the failure kobo-765/B5 closed).
 */
function handoffPrompt(company: string, anchor: string): string {
  // kobo-780: absolute. A relative path only reads correctly if the agent's own
  // cwd happens to be its repo — true today, but it is free to be exact here.
  const contract = join(stateDirOf(anchor), "head-contract.md");
  return `[cell spawn ${company}] Your cell is not up and you are its head pane. Run this in your own Bash tool, exactly as written: \`maw company cell self-spawn ${company}\` — it adopts THIS pane as head (it anchors on $TMUX_PANE, which your Bash tool inherits) and opens the worker + reviewer panes beside you. Then read \`${contract}\` and follow it as your head contract. CAVEAT: you are already running, so that contract could NOT be appended to your system prompt the way a freshly launched head gets it — reading the file is the only way it reaches you. Do not restart yourself, do not run any \`claude --append-system-prompt\` launch line, and do not kill this pane.`;
}

/**
 * kobo-776 — deliver the instruction as a federation message instead of typing a
 * shell line into a REPL.
 *
 * Shelling out to `maw hey` rather than importing cmdSend: spawn.ts already
 * reaches the fleet this way four functions down (the worker double-fail notify),
 * `hey` is the sanctioned delivery path with its own idle/permission gates, and
 * pulling cmdSend in through the sdk barrel would link-break every isolated suite
 * that mocks `maw-js/sdk` with a partial object — the same hazard that made this
 * file inline selfOracleId instead of importing resolveAgentSelf.
 */
async function handOffToAgent(target: string, company: string, anchor: string): Promise<InjectResult> {
  const addr = await paneAddress(target);
  if (!addr) return { ok: false, reason: `cannot resolve a hey address for ${target}` };
  try {
    await hostExec(`maw hey ${shellArg(addr)} ${shellArg(handoffPrompt(company, anchor))}`);
  } catch (e: any) {
    return { ok: false, reason: `maw hey to ${addr} failed (${e.message})` };
  }
  return { ok: true };
}

/**
 * kobo-765 — the head launch line, run by the target pane's own shell right after
 * `maw company cell self-spawn`. Two guarantees are built into the shell chain
 * itself, because nothing outside that pane can enforce them:
 *
 * B5: `test -s <contract>` first. A missing or empty contract means head would
 * boot with an EMPTY system prompt — a head with no contract looks alive and
 * behaves like a stranger. There must be no path to it, so the launch simply does
 * not happen and says why.
 *
 * B7: no `exec`. `exec claude` REPLACED the pane's shell, so a boot failure (bad
 * model) killed the pane outright: nothing left to fall back to, nothing left to
 * inspect, and no shell for the next `cell spawn` to repair. Plain `claude` keeps
 * the shell underneath, so a non-zero exit falls through to the fallback model —
 * the same BRAIN_MODEL → DEFAULT_WORKER_MODEL ladder the worker already climbs.
 *
 * ponytail: the `||` fires on ANY non-zero exit, not just a boot failure — a head
 * that dies hours later comes back on the fallback model. That is the cheap
 * version of "restart the head"; gate it on `$SECONDS` if boot-only ever matters.
 */
function headLaunchCommand(company: string, anchor: string): string {
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");
  // kobo-780: absolute, from the same anchor the writer used. It was relative,
  // which only ever worked when the pane's shell happened to sit in the same
  // directory the writer did — and the maw wrapper's `cd` guaranteed it did not.
  const stateDir = stateDirOf(anchor);
  const contract = join(stateDir, "head-contract.md");
  const claude = (model: string) => [
    `MAW_ROOM_COMPANY=${shellArg(company)}`,
    "CREW_ROLE=head",
    'CREW_COORD_PANE="$TMUX_PANE"',
    `CREW_STATE_DIR=${shellArg(stateDir)}`,
    "claude",
    `--model ${model}`,
    `--settings ${shellArg(settingsPath)}`,
    "--dangerously-skip-permissions",
    `--append-system-prompt "$(cat ${shellArg(contract)})"`,
  ].join(" ");
  const refuse = `⚠ cell head NOT started: ${contract} is missing or empty — head would have booted with an empty system prompt. Run \`maw company cell self-spawn ${company}\` in this pane first.`;
  // if/else, not `&& … || echo`: with `||` a claude that merely exits non-zero
  // would print the "contract is missing" line, which is a lie about the cause.
  return `if test -s ${shellArg(contract)}; then ${claude(BRAIN_MODEL)} || ${claude(DEFAULT_WORKER_MODEL)}; else echo ${shellArg(refuse)}; fi`;
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

/** kobo-775 — see PREV_WINDOW_OPTION. Best-effort: a name we fail to park costs
 *  the restore its exact answer, not its existence (down falls back to the oracle
 *  name), so this must never abort a spawn. */
async function rememberWindowName(paneId: string): Promise<void> {
  try {
    const current = (await hostExec(`tmux display-message -p -t ${shellArg(paneId)} '#{window_name}'`)).trim();
    if (!current || current === CELL_HEAD_WINDOW) return;
    await hostExec(`tmux set-option -p -t ${shellArg(paneId)} ${PREV_WINDOW_OPTION} ${shellArg(current)}`);
  } catch { /* nothing to restore later — down falls back to the oracle name */ }
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

export async function companyCellSpawn(company: string | undefined, emit: (line: string) => void, verbose = false): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell spawn <company> [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const log = (line: string) => { if (verbose) emit(line); };
  let ready = 0, repaired = 0, handed = 0, bootFailed = 0, refused = 0;
  const roster = companyRoster(co);
  let sessions = await listSessions();

  for (const member of roster) {
    let resolved = resolveMemberSession(member.oracle, sessions);
    if (!resolved) {
      log(`${member.oracle}: no session found — waking (maw wake)`);
      try {
        await cmdWake(member.oracle, { noAttach: true, noRehydrate: true });
      } catch (e: any) {
        log(`⚠ ${member.oracle}: wake failed (${e.message})`);
        refused++;
        continue;
      }
      sessions = await listSessions();
      resolved = resolveMemberSession(member.oracle, sessions);
      if (!resolved) {
        log(`⚠ ${member.oracle}: wake reported success but no session found afterward`);
        refused++;
        continue;
      }
    }

    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName);
    const roles = cellRolesOf(panes, member.oracle);
    const isReady = roles.has("head") && roles.has("worker") && roles.has("reviewer");
    if (isReady) { log(`${member.oracle}: cell ready — skip`); ready++; continue; }

    const head = findHeadPane(panes, member.oracle);
    if (head.pane && head.duplicates.length > 0) emit(dualHeadWarning(member.oracle, head.pane, head.duplicates));
    const injectTarget = head.pane?.paneId ?? soleLegacyHeadPane(panes) ?? resolved;
    // kobo-780: the repair line names absolute paths, so it cannot be built at
    // all without knowing this oracle's repo. Refuse rather than fall back to
    // this process's cwd — that cwd is maw-js for every oracle, which is the
    // collision being fixed.
    const anchor = await cellAnchor(injectTarget);
    if (!anchor) {
      emit(`⚠ ${member.oracle}: REFUSED repair — cannot read #{session_path} for ${injectTarget}, so this oracle's repo is unknown. Refusing rather than anchoring the cell to this process's cwd (the maw wrapper makes that maw-js for every oracle).`);
      refused++;
      continue;
    }
    log(`${member.oracle}: cell incomplete/asleep (has: ${[...roles].join("+") || "no identified pane"}) — repairing ${injectTarget} (maw company cell self-spawn)`);
    try {
      const injected = await injectCommand(injectTarget, `maw company cell self-spawn ${company} && ${headLaunchCommand(company, anchor)}`);
      if (!injected.ok) {
        // kobo-776 — a pane running an agent is not unreachable, it is reachable
        // by a different channel: ASK it. Reached only after injectCommand has
        // already refused to type, so the 5371b28e guard decides this, not us —
        // no keystroke has been sent to this pane.
        if (AGENT_CMDS.has(paneCommandBasename(injected.command ?? ""))) {
          const handoff = await handOffToAgent(injectTarget, company, anchor);
          if (handoff.ok) {
            // Not `repaired`: the agent acts on its own clock, so nothing here has
            // observed a cell come up. Its own counter, or the summary would be
            // claiming a result that has not happened yet.
            emit(`↗ ${member.oracle}: HANDED OFF to the agent on ${injectTarget} (running '${injected.command}') — asked it to run \`maw company cell self-spawn ${company}\` itself and read ${join(stateDirOf(anchor), "head-contract.md")}. Not yet a cell: check the board/pane for it acting on this.`);
            handed++;
            continue;
          }
          emit(`⚠ ${member.oracle}: handoff to the agent on ${injectTarget} FAILED — ${handoff.reason}`);
          refused++;
          continue;
        }
        // Loud on purpose (emit, not log): this used to count as repaired while
        // the pane did nothing — the summary said the opposite of the truth.
        emit(`⚠ ${member.oracle}: REFUSED repair injection — ${injected.reason}; a typed command would land as prompt text, not run. Fix by running \`maw company cell self-spawn ${company}\` inside that pane.`);
        refused++;
        continue;
      }
      // The typed line ran — that is NOT yet a repair. Wait for head to actually
      // come up (its launch line falls back to DEFAULT_WORKER_MODEL in-pane if
      // BRAIN_MODEL refuses to boot).
      if (await pollHeadReady(injectTarget)) { repaired++; continue; }
      // Loud on purpose (emit, not log): this used to count as repaired while the
      // head was dead or sitting on an empty system prompt.
      emit(`⚠ ${member.oracle}: head boot FAILED on ${injectTarget} — no claude prompt after ${BRAIN_MODEL} and the ${DEFAULT_WORKER_MODEL} fallback; the repair line ran but the cell has no head. NOT counted as repaired — inspect that pane.`);
      bootFailed++;
    } catch (e: any) {
      log(`⚠ ${member.oracle}: repair injection failed (${e.message})`);
      refused++;
    }
  }

  emit(`✓ cell spawn ${company}: ${ready} ready, ${repaired} repaired, ${handed} handed-off, ${bootFailed} head-boot-failed, ${refused} refused/failed (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
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

    const toKill = panes
      .filter((p) => p.paneId && p.paneId !== invokerPane && isTeardownTarget(p, member.oracle));

    for (const pane of toKill) {
      try { await hostExec(`tmux kill-pane -t ${shellArg(pane.paneId)}`); } catch { /* verified below, not here */ }
    }

    // Count from what the SERVER says, not from what kill-pane returned: a kill
    // that threw may still have landed, and one that returned cleanly may not
    // have. `killed` must mean "pane is gone".
    let killed = 0;
    let survivors = panes.length;
    const failures: string[] = [];
    if (toKill.length > 0) {
      const after = await listSessionPanes(sessionName);
      const alive = new Set(after.map((p) => p.paneId));
      survivors = after.length;
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
      emit(`⚠ ${member.oracle}: cell teardown PARTIAL — killed ${killed}/${toKill.length}, still up: ${failures.join(", ")}; state left in place`);
      partial++;
      continue;
    }

    log(`${member.oracle}: killed ${killed}/${toKill.length} cell pane(s)`);
    // Head is the last pane standing → say so out loud, not only under --verbose:
    // "the session went quiet" must not read as "the oracle was killed too".
    await standDownHead(headPane, member.oracle, survivors <= 1 ? emit : log);
    torn++;
  }

  emit(`✓ cell down ${company}: ${torn} torn, ${partial} partial, ${skipped} skipped, ${refused} refused (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

/**
 * kobo-775 — put the head window's name back. Down used to leave it reading
 * `cell-head` forever: a name that says "a cell lives here" on a pane where none
 * does. Nothing in src ever branched on it (grep: only the rename itself), which
 * is precisely why it survived — but findWindow resolves bare oracle names by
 * window NAME, so the residue steered later verbs at a window whose cell was gone.
 *
 * The original name comes from the option self-spawn stored. Missing option (a
 * cell spawned before this fix) → the oracle's own name, which is the convention
 * the rest of the fleet's windows follow and what findWindow looks for. Renamed
 * only while the name is still ours: a window someone has since renamed is theirs.
 */
async function restoreHeadWindowName(head: PaneRow, oracle: string): Promise<void> {
  if (head.windowName !== CELL_HEAD_WINDOW) return;
  let prev = "";
  try { prev = (await hostExec(`tmux display-message -p -t ${shellArg(head.paneId)} '#{${PREV_WINDOW_OPTION}}'`)).trim(); } catch { /* pane may be gone */ }
  const name = prev || oracle;
  if (!name) return;
  try {
    await hostExec(`tmux rename-window -t ${shellArg(head.paneId)} ${shellArg(name)}`);
    await hostExec(`tmux set-option -pu -t ${shellArg(head.paneId)} ${PREV_WINDOW_OPTION}`);
  } catch { /* pane may be gone */ }
}

/**
 * The head pane outlives the cell — it is the oracle's own pane, adopted at
 * self-spawn. Down puts it back to a plain oracle pane instead: drop the cell
 * `@role`, drop the cell window name, drop the cell state files, keep
 * `@oracle_pane={oracle}:head` (that is exactly what a solo `maw wake` pane
 * carries — the oracle is still there). What is left after this is what
 * readiness reads: identity, and identity alone (cellRolesOf).
 */
async function standDownHead(head: PaneRow, oracle: string, report: (line: string) => void): Promise<void> {
  try { await hostExec(`tmux set-option -pu -t ${shellArg(head.paneId)} @role`); } catch { /* pane may be gone */ }
  await restoreHeadWindowName(head, oracle);
  // kobo-780: the SAME resolver the writer used. This used to read the pane's
  // `pane_current_path` from the listing — which answers the oracle repo here (the
  // pane is running claude) but maw-js inside self-spawn, so down was cleaning a
  // directory self-spawn had never written to. Deleting files is not a place for
  // a second opinion: no anchor, no delete.
  const anchor = await cellAnchor(head.paneId);
  if (!anchor) {
    report(`⚠ ${oracle}: head ${head.paneId} stood down, but cell state was LEFT IN PLACE — cannot read #{session_path}, and this is a delete: refusing to guess the directory.`);
    return;
  }
  const stateDir = stateDirOf(anchor);
  for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }
  report(`${oracle}: head ${head.paneId} kept (the oracle's own pane — never killed by down), @role cleared, window name restored, cell state removed from ${stateDir}`);
}

export function parseCellCompanyArg(args: string[]): string | undefined { return parseCompanyArg(args); }

export async function cellSelfSpawn(company: string | undefined, emit: (line: string) => void): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell self-spawn <company>" };
  if (!loadCompany(company)) return { ok: false, error: `company not found: ${company} — no partial spawn` };

  const head = (process.env.TMUX_PANE || "").trim();
  if (!head) return { ok: false, error: "not inside a tmux pane (TMUX_PANE unset) — self-spawn must run inside the target oracle pane" };

  for (const role of ["head", "worker", "reviewer"] as Role[]) {
    if (!existsSync(contractAssetPath(role))) return { ok: false, error: `contract asset missing: ${contractAssetPath(role)} — run maw crew-skills sync first` };
  }

  const teardown = await teardownCrewWindows({ protectPaneId: head });
  for (const line of teardown.logs) emit(line);
  if (!teardown.ok) return { ok: false, error: teardown.error };

  // kobo-780: this oracle's own repo, before anything is written. Without it there
  // is no honest place to put the contracts — process.cwd() is maw-js inside every
  // maw invocation (the wrapper's `cd`), which is how every oracle's cell ended up
  // overwriting the same directory. No partial spawn, same as a missing company.
  const anchor = await cellAnchor(head);
  if (!anchor) {
    return { ok: false, error: `cannot read #{session_path} for ${head} — this oracle's repo is unknown, and anchoring the cell to this process's cwd would put it in the maw wrapper's repo (shared by every oracle). No partial spawn.` };
  }

  const self = selfOracleId();
  const dept = resolveSelfDept();
  const board = company;
  const stateDir = stateDirOf(anchor); // kobo-765/B5 + kobo-780: one derivation point, from the pane's session — never cwd, never the inherited env
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }

  await hostExec(`tmux set-option -p -t ${shellArg(head)} @role ${shellArg("👤 head")}`);
  // The head pane is ADOPTED (this very pane, whatever it was before) — stamp it
  // now so a previous occupant's identity cannot linger.
  await stampCellPane(head, self, "head", emit);
  await hostExec(`tmux select-pane -t ${shellArg(head)} -T ${shellArg("👤 head")}`);
  // kobo-775: park the name we are about to overwrite so `down` can put it back.
  // Skipped when the window already reads `cell-head` — that is our own leftover,
  // and storing it would make the restore a no-op forever.
  await rememberWindowName(head);
  await hostExec(`tmux rename-window -t ${shellArg(head)} ${shellArg(CELL_HEAD_WINDOW)}`);
  await showPaneLabels(head);
  writeFileSync(join(stateDir, "head-contract.md"), renderContract("head", { company, dept, board }));
  writeFileSync(join(stateDir, "worker-contract.md"), renderContract("worker", { company, dept, board }));
  writeFileSync(join(stateDir, "reviewer-contract.md"), renderContract("reviewer", { company, dept, board }));
  writeFileSync(join(stateDir, "head.md"), `# Head\n\ncompany=${company}\nstate-dir=${stateDir}\nactive-card=none\n`);

  // kobo-780: the worker/reviewer panes open in the ORACLE's repo. This was
  // process.cwd(), i.e. maw-js for every oracle — the panes booted in the wrapper's
  // repo and worked on the wrong tree.
  const cwd = anchor;
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");
  const worker = await spawnWorkerSelfHeal({ cwd, company, stateDir, settingsPath, head, emit });
  if (!worker.ok || !worker.paneId) return { ok: false, error: worker.error ?? "worker spawn failed" };

  const revCmd = `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=reviewer CREW_COORD_PANE=${shellArg(head)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${BRAIN_MODEL} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "reviewer-contract.md"))})"`;
  const reviewer = (await hostExec(`tmux split-window -h -p 50 -t ${shellArg(worker.paneId)} -P -F '#{pane_id}' ${shellArg(revCmd)}`)).trim();
  if (!reviewer) return { ok: false, error: "reviewer spawn produced no pane-id" };
  const reviewerBooted = await pollBoot(reviewer, BOOT_POLL_MAX);
  if (!reviewerBooted) emit("⚠ reviewer boot not confirmed — pane left up for manual inspection");

  await hostExec(`tmux rename-window -t ${shellArg(worker.paneId)} ${shellArg(CELL_WORKERS_WINDOW)}`);
  await showPaneLabels(worker.paneId);
  await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @role ${shellArg("⚒ worker")}`);
  await stampCellPane(worker.paneId, self, "worker", emit);
  await hostExec(`tmux select-pane -t ${shellArg(worker.paneId)} -T ${shellArg("⚒ worker")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @role ${shellArg("🔎 reviewer")}`);
  await stampCellPane(reviewer, self, "reviewer", emit);
  await hostExec(`tmux select-pane -t ${shellArg(reviewer)} -T ${shellArg("🔎 reviewer")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @idle_notify_pane ${shellArg(reviewer)}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @idle_notify_pane ${shellArg(head)}`);

  emit(`✓ cell spawned — head=${head} worker=${worker.paneId} (${worker.model}) reviewer=${reviewer}`);
  return { ok: true, head, worker: worker.paneId, workerModel: worker.model, reviewer };
}

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
