/**
 * Install the worklog PostToolUse hook into oracles' Claude Code settings.
 *
 * P1 "sets it up" rather than relying on each oracle having configured a hook:
 * `maw watch setup-hooks` provisions the hook script + merges a PostToolUse hook
 * (matcher = significant tools only) into each target oracle's .claude/settings.json,
 * idempotently — mirroring scripts/deploy-hooks.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { mawConfigPath } from "../xdg";
import { loadCompany } from "../../vendor/mpr-plugins/company/company-helpers";

/** Tools worth logging. CC fires the hook only for these (coarse filter); the
 *  server applies the fine filter (git/gh for Bash). Keep in sync with significant.ts. */
const MATCHER = "Bash|Edit|Write|MultiEdit";

/** Embedded copy of scripts/hooks/worklog-tool.sh so a bundled binary can self-provision. */
const HOOK_SCRIPT = `#!/bin/bash
# Claude Code PostToolUse hook → maw worklog (managed by \`maw watch setup-hooks\`).
MAW_PORT="\${MAW_PORT:-3456}"
MAW_URL="http://localhost:\${MAW_PORT}/api/feed"
command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL" ] && exit 0
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')
ORACLE="\${CLAUDE_AGENT_NAME:-}"
if [ -z "$ORACLE" ]; then
  ORACLE=$(tmux display-message -p '#{session_name}' 2>/dev/null | sed 's/^[0-9]*-//')
fi
[ -z "$ORACLE" ] && ORACLE="unknown"
PROJECT=$(basename "\${PWD}" 2>/dev/null)
PAYLOAD=$(jq -n --arg o "$ORACLE" --arg p "$PROJECT" --arg t "$TOOL" --argjson ti "$TOOL_INPUT" \\
  '{oracle:$o, event:"PostToolUse", project:$p, host:"local", message:("tool:"+$t), data:{tool_name:$t, tool_input:$ti}}')
curl -s -X POST "$MAW_URL" -H 'Content-Type: application/json' -d "$PAYLOAD" >/dev/null 2>&1 &
exit 0
`;

export function worklogHookPath(): string {
  return mawConfigPath("hooks", "worklog-tool.sh");
}

/** Provision the hook script to the config dir (idempotent). Returns true if written. */
export function ensureWorklogHookScript(): boolean {
  const p = worklogHookPath();
  if (existsSync(p) && readFileSync(p, "utf-8") === HOOK_SCRIPT) return false;
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, HOOK_SCRIPT);
  chmodSync(p, 0o755);
  return true;
}

function makeHookEntry() {
  return { type: "command", command: worklogHookPath() };
}

function isWorklogHook(hook: any): boolean {
  return typeof hook?.command === "string" && hook.command.includes("worklog-tool.sh");
}

/** Oracles in a company (all departments' members). Empty if company unknown. */
export function companyOracles(company: string): string[] {
  const c = loadCompany(company);
  if (!c) return [];
  const set = new Set<string>();
  for (const dept of Object.values(c.departments)) {
    for (const m of dept.members) set.add(m.oracle);
  }
  return [...set];
}

export interface SetupHooksOpts {
  company?: string; // default "kobo"
  dryRun?: boolean;
  ghqRoot?: string; // default ~/ghq/github.com/meganechan
}

export interface SetupHooksResult {
  scriptInstalled: boolean;
  updated: string[];
  alreadyOk: string[];
  skipped: string[];
}

/** Merge the PostToolUse worklog hook into each target oracle's settings.json. */
export function setupWorklogHooks(opts: SetupHooksOpts = {}): SetupHooksResult {
  const company = opts.company ?? "kobo";
  const ghqRoot = opts.ghqRoot ?? join(homedir(), "ghq/github.com/meganechan");
  const result: SetupHooksResult = { scriptInstalled: false, updated: [], alreadyOk: [], skipped: [] };

  result.scriptInstalled = opts.dryRun ? !existsSync(worklogHookPath()) : ensureWorklogHookScript();

  const oracles = companyOracles(company);
  for (const oracle of oracles) {
    const repo = oracle.endsWith("-oracle") ? oracle : `${oracle}-oracle`;
    const dir = join(ghqRoot, repo);
    if (!existsSync(dir)) {
      result.skipped.push(oracle);
      continue;
    }
    const settingsPath = join(dir, ".claude", "settings.json");
    let settings: any = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        settings = {};
      }
    }
    settings.hooks ??= {};
    settings.hooks.PostToolUse ??= [];
    const entries = settings.hooks.PostToolUse as any[];
    const has = entries.some(e => e.hooks?.some(isWorklogHook));
    if (has) {
      result.alreadyOk.push(oracle);
      continue;
    }
    if (opts.dryRun) {
      result.updated.push(oracle);
      continue;
    }
    entries.push({ matcher: MATCHER, hooks: [makeHookEntry()] });
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    result.updated.push(oracle);
  }
  return result;
}
