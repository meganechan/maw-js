/**
 * Policy-inject probe (kobo-853) — the PULL-probe an oracle fires at any moment
 * to ask "did this turn's company policy + brain INDEX inject actually reach me,
 * and if not, which silent exit swallowed it".
 *
 * WHY THIS EXISTS: every failure path in the `company-policy.sh`
 * UserPromptSubmit hook is `exit 0` with no output — by design (a failing inject
 * must never break the agent). The cost of that design is that a dead inject is
 * indistinguishable from a live one from inside the session: company pgw ran ~6
 * weeks with 9 of 11 oracles receiving an empty string and nothing anywhere said
 * so. This module makes the silence answerable on demand. It does NOT change the
 * hook, does not alert, does not log — it answers a question when asked.
 *
 * The stages below mirror the hook's exits IN ORDER, so "stage" names the exact
 * line that swallowed it:
 *   hook   — the hook script isn't installed at all (nothing runs; not one of the
 *            hook's own exits, but a green probe would be a lie without it)
 *   jq     — `command -v jq >/dev/null || exit 0`
 *   oracle — `[ -z "$ORACLE" ] && exit 0`   (CLAUDE_AGENT_NAME, else tmux session
 *            name minus its `NN-` prefix)
 *   server — `curl -s --max-time 2 .../api/policy` failed or timed out
 *   inject — the endpoint answered with an empty `.inject` (not attached, or
 *            attached to a company the registry doesn't place this oracle in)
 *
 * Plus the case a green "entry count" probe CANNOT see (kobo-853 AC3): the INDEX
 * is injected from a clone ON DISK, so a clone that trails its remote injects a
 * stale brain with an identical entry count. `behind` is a real answer; when the
 * comparison can't be made (offline, no upstream) the answer is `unknown`, never
 * `fresh` — an unmeasurable axis reported as green is the bug this card fixes.
 *
 * Pure over injected deps (same shape as kobo-board's preRegisterProbe /
 * prWatchProbe): no live daemon, tmux, network or git needed to test it.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mawConfigPath } from "../xdg";
import { getPolicyAttach } from "./attach-store";
import { brainDir } from "./policy-store";

/** Which stage of the inject chain swallowed it. Ordered as the hook runs. */
export type ProbeStage = "hook" | "jq" | "oracle" | "server" | "inject";

export type BrainFreshness =
  | { state: "fresh"; upstream: string }
  | { state: "behind"; behind: number; upstream: string }
  /** Could NOT be measured. Explicitly not "fresh" — see module header. */
  | { state: "unknown"; reason: string };

export interface PolicyProbeResult {
  /** true only when the inject reached AND its brain clone isn't behind. */
  ok: boolean;
  /** null when the inject arrived; otherwise the stage that swallowed it. */
  stage: ProbeStage | null;
  reason: string;
  /** Concrete next action, or null when there's nothing to fix. */
  fix: string | null;
  oracle: string | null;
  company: string | null;
  dept: string | null;
  /** Brain INDEX entries present in the injected text (`- \`slug\`` lines). */
  entries: number;
  brain: BrainFreshness | null;
  brainPath: string | null;
}

export interface PolicyProbeDeps {
  hookInstalled: () => boolean;
  hasJq: () => boolean;
  /** "" when the hook's own resolution would come up empty. */
  resolveOracle: () => string;
  fetchInject: (oracle: string) => Promise<{ ok: boolean; inject: string; error?: string }>;
  attachOf: (oracle: string) => { company: string; dept: string } | null;
  brainFreshness: (company: string) => BrainFreshness;
  brainPathOf: (company: string) => string;
}

/** Where `maw watch setup-hooks` provisions the policy-inject hook. */
export function policyHookPath(): string {
  return mawConfigPath("hooks", "company-policy.sh");
}

/** The hook's own oracle resolution: CLAUDE_AGENT_NAME, else tmux session minus `NN-`. */
export function resolveOracleLikeHook(): string {
  const env = process.env.CLAUDE_AGENT_NAME?.trim();
  if (env) return env;
  try {
    const s = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return s.trim().replace(/^[0-9]*-/, "");
  } catch {
    return "";
  }
}

/** Brain INDEX entry lines, counted the same way the field probe greps them. */
export function countBrainEntries(inject: string): number {
  return inject.split("\n").filter(l => l.startsWith("- `")).length;
}

/** Port the hook talks to (`${MAW_PORT:-3456}`), read fresh so a test/alt port works. */
export function policyPort(): string {
  return process.env.MAW_PORT || "3456";
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      // Never let a credential/host prompt turn the probe into a hang.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" },
    }).trim();
  } catch {
    return null;
  }
}

/**
 * How far the on-disk brain clone trails its remote. Fetches first (the compare
 * is worthless against stale remote refs); any step that can't run yields
 * `unknown` WITH the reason, never `fresh`.
 */
export function brainFreshnessAt(
  dir: string,
  run: (dir: string, args: string[]) => string | null = git,
): BrainFreshness {
  if (!existsSync(dir)) return { state: "unknown", reason: `no brain clone on disk at ${dir}` };
  const upstream = run(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return { state: "unknown", reason: "clone has no upstream branch — nothing to compare against" };
  if (run(dir, ["fetch", "--quiet"]) === null) {
    return { state: "unknown", reason: `git fetch failed (offline / no access) — staleness was NOT measured against ${upstream}` };
  }
  const raw = run(dir, ["rev-list", "--count", `HEAD..${upstream}`]);
  const behind = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(behind)) return { state: "unknown", reason: `git rev-list failed — staleness was NOT measured against ${upstream}` };
  return behind > 0 ? { state: "behind", behind, upstream } : { state: "fresh", upstream };
}

export function defaultProbeDeps(): PolicyProbeDeps {
  return {
    hookInstalled: () => existsSync(policyHookPath()),
    hasJq: () => {
      try {
        // Byte-for-byte the hook's own test, so PATH differences resolve the same way.
        execFileSync("/bin/sh", ["-c", "command -v jq"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    resolveOracle: resolveOracleLikeHook,
    fetchInject: async (oracle: string) => {
      const url = `http://localhost:${policyPort()}/api/policy?oracle=${encodeURIComponent(oracle)}`;
      try {
        // Same 2s ceiling as the hook's `curl --max-time 2` — a server that is
        // "up but slower than 2s" injects nothing, so the probe must agree.
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return { ok: false, inject: "", error: `HTTP ${res.status} from ${url}` };
        const body = (await res.json()) as { inject?: unknown };
        return { ok: true, inject: typeof body.inject === "string" ? body.inject : "" };
      } catch (e) {
        return { ok: false, inject: "", error: `${(e as Error)?.message ?? e} (${url})` };
      }
    },
    attachOf: (oracle: string) => {
      const m = getPolicyAttach(oracle);
      return m ? { company: m.company, dept: m.dept } : null;
    },
    brainFreshness: (company: string) => brainFreshnessAt(brainDir(company)),
    brainPathOf: brainDir,
  };
}

const BLANK: PolicyProbeResult = {
  ok: false, stage: null, reason: "", fix: null,
  oracle: null, company: null, dept: null,
  entries: 0, brain: null, brainPath: null,
};

export async function probePolicyInject(
  deps: PolicyProbeDeps = defaultProbeDeps(),
): Promise<PolicyProbeResult> {
  if (!deps.hookInstalled()) {
    return {
      ...BLANK,
      stage: "hook",
      reason: `the policy hook is not installed at ${policyHookPath()} — nothing injects, on any turn`,
      fix: "maw watch setup-hooks",
    };
  }

  if (!deps.hasJq()) {
    return {
      ...BLANK,
      stage: "jq",
      reason: "jq is not on PATH — the hook's first line is `command -v jq || exit 0`, so it gives up before doing anything",
      fix: "brew install jq",
    };
  }

  const oracle = deps.resolveOracle().trim();
  if (!oracle) {
    return {
      ...BLANK,
      stage: "oracle",
      reason: "the hook cannot work out which oracle this pane is: CLAUDE_AGENT_NAME is empty and the tmux session name did not resolve",
      fix: "run inside the oracle's tmux session, or export CLAUDE_AGENT_NAME=<oracle>",
    };
  }

  const res = await deps.fetchInject(oracle);
  if (!res.ok) {
    return {
      ...BLANK,
      oracle,
      stage: "server",
      reason: `maw-server did not answer within 2s: ${res.error ?? "request failed"} — past 2s the hook's curl gives up and exits 0`,
      fix: `check the server on port ${policyPort()} (pm2 ls / maw serve), then re-run this probe`,
    };
  }

  const attach = deps.attachOf(oracle);
  const inject = res.inject;
  if (!inject.trim()) {
    return {
      ...BLANK,
      oracle,
      company: attach?.company ?? null,
      dept: attach?.dept ?? null,
      stage: "inject",
      reason: attach
        ? `server answered with an EMPTY inject even though '${oracle}' has an attach marker for company '${attach.company}' — the marker names an oracle the company registry does not, or that company has no policy files`
        : `'${oracle}' has no attach marker — it is attached to no company, so the endpoint correctly returns nothing to inject`,
      fix: attach
        ? `check ~/.maw/companies/${attach.company}.json lists '${oracle}', and that ~/.maw/companies/${attach.company}/policy/ exists (maw company sync ${attach.company})`
        : `attach this oracle to a company (see maw company attach), then re-run this probe`,
    };
  }

  const company = attach?.company ?? null;
  const entries = countBrainEntries(inject);
  const brain = company ? deps.brainFreshness(company) : null;
  const brainPath = company ? deps.brainPathOf(company) : null;

  if (brain?.state === "behind") {
    return {
      ok: false, stage: null, oracle, company, dept: attach?.dept ?? null, entries, brain, brainPath,
      reason: `inject REACHED (${entries} brain entries), but the clone it reads from is ${brain.behind} commits behind ${brain.upstream} — every attached oracle is being injected an out-of-date INDEX, at an entry count that looks normal`,
      fix: `git -C ${brainPath} pull --ff-only`,
    };
  }

  return {
    ok: true, stage: null, oracle, company, dept: attach?.dept ?? null, entries, brain, brainPath,
    reason: `inject reached this pane (${entries} brain INDEX entries)`,
    fix: null,
  };
}
