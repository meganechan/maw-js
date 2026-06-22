/**
 * Ping on merge — surface a state change to the people who would otherwise hold
 * stale state: the department lead (the "pm" in the desync story) + the PR
 * author. The worklog entry already records the merge; this nudges humans/oracles
 * so the log gets read.
 *
 * Sender is injected (testable). Default fires a detached `maw hey` subprocess so
 * any delivery failure stays isolated from the calling CLI/poller.
 */

import { loadCompany } from "../../vendor/mpr-plugins/company/company-helpers";

export interface PingDeps {
  send: (target: string, message: string) => void;
}

const defaultSend = (target: string, message: string) => {
  try {
    Bun.spawn(["maw", "hey", target, message], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best effort — the worklog entry still records the merge */
  }
};

/** Resolve a department's lead oracle (best effort, never throws). */
export function deptLead(company: string, dept: string): string | null {
  try {
    return loadCompany(company)?.departments?.[dept]?.lead ?? null;
  } catch {
    return null;
  }
}

export interface PingOnMergeOpts {
  company?: string;
  dept?: string;
  author?: string | null; // oracle / gh login that opened the PR
  pr: number;
  repo: string;
  by?: string; // who merged
}

/** Notify lead + author about a merge. Returns the list of pinged targets. */
export function pingOnMerge(opts: PingOnMergeOpts, deps: PingDeps = { send: defaultSend }): string[] {
  const targets = new Set<string>();
  if (opts.company && opts.dept) {
    const lead = deptLead(opts.company, opts.dept);
    if (lead) targets.add(lead);
  }
  if (opts.author) targets.add(opts.author);

  if (!targets.size) return [];
  const msg = `[watch] PR #${opts.pr} (${opts.repo}) merged${opts.by ? ` by ${opts.by}` : ""} — sync your state (maw watch log)`;
  const pinged: string[] = [];
  for (const t of targets) {
    deps.send(t, msg);
    pinged.push(t);
  }
  return pinged;
}
