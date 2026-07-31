/**
 * `maw company cell spawn <company>` — deterministic Cell v2 layout.
 *
 * Shape: one tmux session, two windows, three panes:
 *   - page1/current window: main (human/coordinate/report)
 *   - page2/cell-workers window: reviewer + worker
 *
 * This is intentionally flatter than legacy /head+/crew: one active card per
 * cell, worker executes, reviewer checks, main talks to human/routes next card.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostExec } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { loadCompany } from "../company/company-helpers";
import { scopeOfOracle } from "../../../core/worklog/company-scope";
import { teardownCrewWindows } from "../crew/teardown";
import { BRAIN_MODEL, DEFAULT_WORKER_MODEL, FALLBACK_WORKER_MODEL } from "../crew/spawn";

const CELL_WORKERS_WINDOW = "cell-workers";
const STATE_FILES = ["main.md", "worker.md", "reviewer.md", "worker-contract.md", "reviewer-contract.md"];
type Role = "worker" | "reviewer";

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

export interface CellSpawnResult {
  ok: boolean;
  error?: string;
  main?: string;
  worker?: string;
  workerModel?: string;
  reviewer?: string;
}

export async function cellSpawn(company: string | undefined, emit: (line: string) => void): Promise<CellSpawnResult> {
  if (!company) return { ok: false, error: "usage: maw company cell spawn <company>" };
  if (!loadCompany(company)) return { ok: false, error: `company not found: ${company} — no partial spawn` };

  const main = (process.env.TMUX_PANE || "").trim();
  if (!main) return { ok: false, error: "not inside a tmux pane (TMUX_PANE unset) — run from a raw claude pane" };

  for (const role of ["worker", "reviewer"] as Role[]) {
    if (!existsSync(contractAssetPath(role))) return { ok: false, error: `contract asset missing: ${contractAssetPath(role)} — run maw crew-skills sync first` };
  }

  const teardown = await teardownCrewWindows({ protectPaneId: main });
  for (const line of teardown.logs) emit(line);
  if (!teardown.ok) return { ok: false, error: teardown.error };

  const oracle = ((loadConfig() as Record<string, unknown>).oracle as string) || "";
  const scope = scopeOfOracle(oracle);
  const dept = scope?.dept ?? "";
  const board = company;
  const stateDir = process.env.CREW_STATE_DIR || "ψ/active/cell";
  mkdirSync(stateDir, { recursive: true });
  for (const f of STATE_FILES) { try { rmSync(join(stateDir, f)); } catch { /* absent */ } }

  await hostExec(`tmux set-option -p -t ${shellArg(main)} @role ${shellArg("🧭 main")}`);
  writeFileSync(join(stateDir, "worker-contract.md"), renderContract("worker", { company, dept, board }));
  writeFileSync(join(stateDir, "reviewer-contract.md"), renderContract("reviewer", { company, dept, board }));
  writeFileSync(join(stateDir, "main.md"), `# Main\n\ncompany=${company}\nstate-dir=${stateDir}\nactive-card=none\n`);

  const cwd = process.cwd();
  const settingsPath = join(resolveHome(), ".claude", "crew-worker-settings.json");
  const worker = await spawnWorkerSelfHeal({ cwd, company, stateDir, settingsPath, main, emit });
  if (!worker.ok || !worker.paneId) return { ok: false, error: worker.error ?? "worker spawn failed" };

  const revCmd = `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=reviewer CREW_COORD_PANE=${shellArg(main)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${BRAIN_MODEL} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "reviewer-contract.md"))})"`;
  const reviewer = (await hostExec(`tmux split-window -h -p 50 -t ${shellArg(worker.paneId)} -P -F '#{pane_id}' ${shellArg(revCmd)}`)).trim();
  if (!reviewer) return { ok: false, error: "reviewer spawn produced no pane-id" };
  const reviewerBooted = await pollBoot(reviewer, BOOT_POLL_MAX);
  if (!reviewerBooted) emit("⚠ reviewer boot not confirmed — pane left up for manual inspection");

  await hostExec(`tmux rename-window -t ${shellArg(worker.paneId)} ${shellArg(CELL_WORKERS_WINDOW)}`);
  await hostExec(`tmux set-option -p -t ${shellArg(worker.paneId)} @role ${shellArg("⚒ worker")}`);
  await hostExec(`tmux set-option -p -t ${shellArg(reviewer)} @role ${shellArg("🔎 reviewer")}`);

  emit(`✓ cell spawned — main=${main} worker=${worker.paneId} (${worker.model}) reviewer=${reviewer}`);
  return { ok: true, main, worker: worker.paneId, workerModel: worker.model, reviewer };
}

interface WorkerSpawnResult { ok: boolean; error?: string; paneId?: string; model?: string }

async function spawnWorkerSelfHeal(opts: { cwd: string; company: string; stateDir: string; settingsPath: string; main: string; emit: (line: string) => void }): Promise<WorkerSpawnResult> {
  const { cwd, company, stateDir, settingsPath, main, emit } = opts;
  const buildCmd = (model: string) => `cd ${shellArg(cwd)} && MAW_ROOM_COMPANY=${shellArg(company)} CREW_ROLE=worker CREW_COORD_PANE=${shellArg(main)} CREW_STATE_DIR=${shellArg(stateDir)} claude --model ${shellArg(model)} --settings ${shellArg(settingsPath)} --dangerously-skip-permissions --append-system-prompt "$(cat ${shellArg(join(stateDir, "worker-contract.md"))})"`;
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
    const mainAddr = (await hostExec(`tmux display-message -t ${shellArg(main)} -p '#{session_name}:#{window_index}.#{pane_index}'`)).trim();
    await hostExec(`maw hey ${shellArg(mainAddr)} ${shellArg(`[cell spawn double-fail] worker failed ${DEFAULT_WORKER_MODEL}+${FALLBACK_WORKER_MODEL} boot — manual recovery needed`)}`);
  } catch { /* best-effort */ }
  emit("⚠ worker double-fail — surfaced to main, pane left up for manual inspection");
  return { ok: true, paneId, model };
}
