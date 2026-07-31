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
import { cmdWake, findWindow, hostExec, listSessions, type Session } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { loadCompany, type Company } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { teardownCrewWindows } from "../crew/teardown";
import { BRAIN_MODEL, DEFAULT_WORKER_MODEL, FALLBACK_WORKER_MODEL } from "../crew/spawn";

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

interface PaneRow { paneId: string; role: string }

async function listSessionPanes(sessionName: string): Promise<PaneRow[]> {
  let raw: string;
  try {
    raw = await hostExec(`tmux list-panes -t ${shellArg(sessionName)} -F '#{pane_id}|||#{@role}'`);
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    const [paneId = "", role = ""] = line.split("|||");
    return { paneId, role };
  });
}

function hasRole(panes: PaneRow[], prefix: string): boolean {
  return panes.some((p) => p.role.startsWith(prefix));
}

function findRolePane(panes: PaneRow[], prefix: string): string | undefined {
  return panes.find((p) => p.role.startsWith(prefix))?.paneId;
}

function sessionNameOf(resolved: string): string {
  const i = resolved.indexOf(":");
  return i === -1 ? resolved : resolved.slice(0, i);
}

function resolveMemberSession(oracle: string, sessions: Session[]): string | null {
  try { return findWindow(sessions, oracle); } catch { return null; }
}

async function injectCommand(target: string, command: string): Promise<void> {
  await hostExec(`tmux send-keys -t ${shellArg(target)} C-u`);
  await hostExec(`tmux send-keys -t ${shellArg(target)} ${shellArg(command)}`);
  await sleep(INJECT_SETTLE_MS);
  await hostExec(`tmux send-keys -t ${shellArg(target)} Enter`);
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
      await injectCommand(injectTarget, `maw company cell self-spawn ${company} && ${headLaunchCommand(company)}`);
      repaired++;
    } catch (e: any) {
      log(`⚠ ${member.oracle}: repair injection failed (${e.message})`);
      refused++;
    }
  }

  emit(`✓ cell spawn ${company}: ${ready} ready, ${repaired} repaired, ${refused} refused/failed (${roster.length} oracle${roster.length === 1 ? "" : "s"})`);
  return { ok: true };
}

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

  const oracle = ((loadConfig() as unknown as Record<string, unknown>).oracle as string) || "";
  const scope = scopeOfOracle(oracle);
  const dept = scope?.dept ?? "";
  const board = company;
  const stateDir = process.env.CREW_STATE_DIR || DEFAULT_STATE_DIR;
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }

  await hostExec(`tmux set-option -p -t ${shellArg(head)} @role ${shellArg("👤 head")}`);
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
  await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @role ${shellArg("⚒ worker")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @role ${shellArg("🔎 reviewer")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @idle_notify_pane ${shellArg(reviewer)}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @idle_notify_pane ${shellArg(worker.paneId)}`);

  emit(`✓ cell spawned — head=${head} worker=${worker.paneId} (${worker.model}) reviewer=${reviewer}`);
  return { ok: true, head, worker: worker.paneId, workerModel: worker.model, reviewer };
}

interface WorkerSpawnResult { ok: boolean; error?: string; paneId?: string; model?: string }

async function spawnWorkerSelfHeal(opts: { cwd: string; company: string; stateDir: string; settingsPath: string; head: string; emit: (line: string) => void }): Promise<WorkerSpawnResult> {
  const { cwd, company, stateDir, settingsPath, head, emit } = opts;
  const buildCmd = (model: string) => `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=worker CREW_COORD_PANE=${shellArg(head)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${shellArg(model)} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "worker-contract.md"))})"`;
  let model = DEFAULT_WORKER_MODEL;
  let paneId = (await hostExec(`tmux new-window -P -F '#{pane_id}' -n ${shellArg(CELL_WORKERS_WINDOW)} ${shellArg(buildCmd(model))}`)).trim();
  if (!paneId) return { ok: false, error: "worker spawn produced no pane-id" };
  if (await pollBoot(paneId, BOOT_POLL_MAX)) return { ok: true, paneId, model };

  try { await hostExec(`tmux kill-window -t ${shellArg(paneId)}`); } catch { /* already gone */ }
  model = FALLBACK_WORKER_MODEL;
  paneId = (await hostExec(`tmux new-window -P -F '#{pane_id}' -n ${shellArg(CELL_WORKERS_WINDOW)} ${shellArg(buildCmd(model))}`)).trim();
  if (!paneId) return { ok: false, error: "worker retry-spawn produced no pane-id" };
  if (await pollBoot(paneId, RETRY_POLL_MAX)) return { ok: true, paneId, model };

  try {
    const headAddr = (await hostExec(`tmux display-message -t ${shellArg(head)} -p '#{session_name}:#{window_index}.#{pane_index}'`)).trim();
    await hostExec(`maw hey ${shellArg(headAddr)} ${shellArg(`[cell spawn double-fail] worker failed ${DEFAULT_WORKER_MODEL}+${FALLBACK_WORKER_MODEL} boot — manual recovery needed`)}`);
  } catch { /* best-effort */ }
  emit("⚠ worker double-fail — surfaced to head, pane left up for manual inspection");
  return { ok: true, paneId, model };
}
