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
import { stampPaneIdentity, type PaneRole } from "../../../core/pane-identity";

const CELL_WORKERS_WINDOW = "cell-workers";
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

interface PaneRow { paneId: string; role: string; windowName: string }

async function listSessionPanes(sessionName: string): Promise<PaneRow[]> {
  let raw: string;
  try {
    raw = await hostExec(`tmux list-panes -s -t ${shellArg(sessionName)} -F '#{pane_id}|||#{@role}|||#{window_name}'`);
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    const [paneId = "", role = "", windowName = ""] = line.split("|||");
    return { paneId, role, windowName };
  });
}

function hasRole(panes: PaneRow[], prefix: string): boolean {
  return panes.some((p) => p.role.startsWith(prefix));
}

function findRolePane(panes: PaneRow[], prefix: string): string | undefined {
  return panes.find((p) => p.role.startsWith(prefix))?.paneId;
}

function isCellOwnedPane(p: PaneRow): boolean {
  if (p.role.startsWith("👤") || p.role.startsWith("⚒") || p.role.startsWith("🔎")) return true;
  if (p.windowName === "cell-head" || p.windowName === CELL_WORKERS_WINDOW) return true;
  return false;
}

function killOrder(p: PaneRow): number {
  if (p.role.startsWith("👤") || p.windowName === "cell-head") return 2;
  return 1;
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

type InjectResult = { ok: true } | { ok: false; reason: string };

async function injectCommand(target: string, command: string): Promise<InjectResult> {
  // Classify HERE, in the same call that sends the keys — never from an earlier
  // pane listing: what a pane is running goes stale in seconds. Even the C-u
  // must wait for the verdict; in a REPL it edits the prompt box.
  const current = await paneCurrentCommand(target);
  if (current === null) return { ok: false, reason: `cannot read pane_current_command for ${target}` };
  if (!SHELL_CMDS.has(paneCommandBasename(current))) return { ok: false, reason: `pane ${target} is running '${current}', not a shell` };
  await hostExec(`tmux send-keys -t ${shellArg(target)} C-u`);
  await hostExec(`tmux send-keys -t ${shellArg(target)} ${shellArg(command)}`);
  await sleep(INJECT_SETTLE_MS);
  await hostExec(`tmux send-keys -t ${shellArg(target)} Enter`);
  return { ok: true };
}

function headLaunchCommand(company: string, stateDir = DEFAULT_STATE_DIR): string {
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");
  return [
    `MAW_ROOM_COMPANY=${shellArg(company)}`,
    "CREW_ROLE=head",
    'CREW_COORD_PANE="$TMUX_PANE"',
    `CREW_STATE_DIR=${shellArg(stateDir)}`,
    "exec claude",
    `--model ${BRAIN_MODEL}`,
    `--settings ${shellArg(settingsPath)}`,
    "--dangerously-skip-permissions",
    `--append-system-prompt "$(cat ${shellArg(join(stateDir, "head-contract.md"))})"`,
  ].join(" ");
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

export async function companyCellSpawn(company: string | undefined, emit: (line: string) => void, verbose = false): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell spawn <company> [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const log = (line: string) => { if (verbose) emit(line); };
  let ready = 0, repaired = 0, refused = 0;
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
    const isReady = hasRole(panes, "👤") && hasRole(panes, "⚒") && hasRole(panes, "🔎");
    if (isReady) { log(`${member.oracle}: cell ready — skip`); ready++; continue; }

    const injectTarget = findRolePane(panes, "👤") ?? resolved;
    log(`${member.oracle}: cell incomplete/asleep — repairing (maw company cell self-spawn)`);
    try {
      const injected = await injectCommand(injectTarget, `maw company cell self-spawn ${company} && ${headLaunchCommand(company)}`);
      if (!injected.ok) {
        // Loud on purpose (emit, not log): this used to count as repaired while
        // the pane did nothing — the summary said the opposite of the truth.
        emit(`⚠ ${member.oracle}: REFUSED repair injection — ${injected.reason}; a typed command would land as prompt text, not run. Fix by running \`maw company cell self-spawn ${company}\` inside that pane.`);
        refused++;
        continue;
      }
      repaired++;
    } catch (e: any) {
      log(`⚠ ${member.oracle}: repair injection failed (${e.message})`);
      refused++;
    }
  }

  emit(`✓ cell spawn ${company}: ${ready} ready, ${repaired} repaired, ${refused} refused/failed (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

export async function companyCellDown(company: string | undefined, opts: { force?: boolean; verbose?: boolean }, emit: (line: string) => void): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell down <company> [--force] [--verbose|--full]" };
  const co = loadCompany(company);
  if (!co) return { ok: false, error: `company not found: ${company}` };

  const log = (line: string) => { if (opts.verbose) emit(line); };
  let torn = 0, skipped = 0, refused = 0;
  const roster = companyRoster(co);
  const sessions = await listSessions();
  const invokerPane = (process.env.TMUX_PANE || "").trim();

  for (const member of roster) {
    const resolved = resolveMemberSession(member.oracle, sessions);
    if (!resolved) { log(`${member.oracle}: no session found — nothing to tear down`); skipped++; continue; }
    const sessionName = sessionNameOf(resolved);
    const panes = await listSessionPanes(sessionName);
    const headPane = findRolePane(panes, "👤") ?? panes.find((p) => p.windowName === "cell-head")?.paneId;

    if (!headPane) {
      log(`⚠ ${member.oracle}: no cell head pane found in session ${sessionName} — skipping teardown fail-closed`);
      skipped++;
      continue;
    }

    if (!opts.force) {
      const guard = await checkBusyGuard(member.oracle);
      if (guard.busy) {
        log(`⚠ ${member.oracle}: BUSY — refusing cell teardown (pass --force to override)`);
        refused++;
        continue;
      }
    }

    const toKill = panes
      .filter(isCellOwnedPane)
      .filter((p) => p.paneId && p.paneId !== invokerPane)
      .sort((a, b) => killOrder(a) - killOrder(b));

    if (toKill.length === 0) { log(`${member.oracle}: no killable cell panes (invoker/head protected?)`); skipped++; continue; }

    let killed = 0;
    for (const pane of toKill) {
      try {
        await hostExec(`tmux kill-pane -t ${shellArg(pane.paneId)}`);
        killed++;
      } catch {
        /* already gone — race with manual teardown is fine */
        killed++;
      }
    }
    log(`${member.oracle}: killed ${killed}/${toKill.length} cell pane(s)`);
    torn++;
  }

  emit(`✓ cell down ${company}: ${torn} torn, ${skipped} skipped, ${refused} refused (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
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

  const self = selfOracleId();
  const dept = resolveSelfDept();
  const board = company;
  const stateDir = process.env.CREW_STATE_DIR || DEFAULT_STATE_DIR;
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }

  await hostExec(`tmux set-option -p -t ${shellArg(head)} @role ${shellArg("👤 head")}`);
  // The head pane is ADOPTED (this very pane, whatever it was before) — stamp it
  // now so a previous occupant's identity cannot linger.
  await stampCellPane(head, self, "head", emit);
  await hostExec(`tmux select-pane -t ${shellArg(head)} -T ${shellArg("👤 head")}`);
  await hostExec(`tmux rename-window -t ${shellArg(head)} ${shellArg("cell-head")}`);
  await showPaneLabels(head);
  writeFileSync(join(stateDir, "head-contract.md"), renderContract("head", { company, dept, board }));
  writeFileSync(join(stateDir, "worker-contract.md"), renderContract("worker", { company, dept, board }));
  writeFileSync(join(stateDir, "reviewer-contract.md"), renderContract("reviewer", { company, dept, board }));
  writeFileSync(join(stateDir, "head.md"), `# Head\n\ncompany=${company}\nstate-dir=${stateDir}\nactive-card=none\n`);

  const cwd = process.cwd();
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
    const headAddr = (await hostExec(`tmux display-message -t ${shellArg(head)} -p '#{session_name}:#{window_index}.#{pane_index}'`)).trim();
    await hostExec(`maw hey ${shellArg(headAddr)} ${shellArg(`[cell spawn double-fail] worker failed ${BRAIN_MODEL}+${DEFAULT_WORKER_MODEL} boot — manual recovery needed`)}`);
  } catch { /* best-effort */ }
  emit("⚠ worker double-fail — surfaced to head, pane left up for manual inspection");
  return { ok: true, paneId, model };
}
