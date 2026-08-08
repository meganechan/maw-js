/**
 * maw policy-probe (kobo-853) — thin printer over probePolicyInject().
 *
 * All logic lives in src/core/policy/probe.ts; this file only formats and picks
 * an exit code:
 *   0  inject reached, brain INDEX present, clone not behind
 *   1  inject did NOT reach — `stage:` names which silent hook exit ate it
 *   2  inject reached but the brain INDEX it carried is STALE (clone behind remote)
 *   3  inject reached but carried NO brain INDEX section at all
 *
 * 3 is deliberately its own code, not 1: "arrived without the brain half" needs a
 * different fix (regenerate/clone the brain repo) from "never arrived" (server,
 * jq, attach marker), and a script that treats them alike will chase the wrong one.
 *
 * An `unknown` freshness (offline / no upstream) still exits 0 — but prints as
 * "NOT measured", never as fresh.
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { probePolicyInject, policyPort, policyHookPath, BRAIN_ONLY_STAGE, type PolicyProbeResult } from "../../../core/policy/probe";

export const command = {
  name: "policy-probe",
  description: "Did this pane's policy + brain INDEX inject actually arrive?",
};

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

export function formatProbe(r: PolicyProbeResult): string {
  const who = [
    r.oracle ? `oracle=${r.oracle}` : null,
    r.company ? `company=${r.company}` : null,
    r.dept ? `dept=${r.dept}` : null,
  ].filter(Boolean).join(" ");

  if (r.stage === BRAIN_ONLY_STAGE) {
    return [
      `${YELLOW}⚠ policy inject reached, but carried NO brain INDEX${OFF} — ${who}`,
      `  ${r.reason}`,
      r.brainPath ? `  ${DIM}clone: ${r.brainPath}${OFF}` : null,
      r.fix ? `  ${DIM}fix:${OFF} ${r.fix}` : null,
    ].filter(Boolean).join("\n");
  }

  if (r.stage) {
    return [
      `${RED}✗ policy inject did NOT reach this pane${OFF} — stage: ${r.stage}`,
      `  ${r.reason}`,
      r.fix ? `  ${DIM}fix:${OFF} ${r.fix}` : null,
      who ? `  ${DIM}${who}${OFF}` : null,
    ].filter(Boolean).join("\n");
  }

  const brainLine = !r.brain
    ? `  ${DIM}brain: no company attached — nothing to compare${OFF}`
    : r.brain.state === "fresh"
      ? `  brain INDEX: ${r.entries} entries · clone up to date with ${r.brain.upstream}`
      : r.brain.state === "behind"
        ? `  ${YELLOW}brain INDEX: ${r.entries} entries · clone is ${r.brain.behind} commits BEHIND ${r.brain.upstream}${OFF}`
        : `  brain INDEX: ${r.entries} entries · ${YELLOW}freshness NOT measured${OFF} — ${r.brain.reason}`;

  const head = r.ok
    ? `${GREEN}● policy inject OK${OFF} — ${who}`
    : `${YELLOW}⚠ policy inject reached, but the brain it carried is STALE${OFF} — ${who}`;

  return [
    head,
    brainLine,
    r.brainPath ? `  ${DIM}clone: ${r.brainPath}${OFF}` : null,
    r.fix ? `  ${DIM}fix:${OFF} ${r.fix}` : null,
  ].filter(Boolean).join("\n");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" && Array.isArray(ctx.args) ? (ctx.args as string[]) : [];
  if (args.some(a => a === "-h" || a === "--help")) {
    return {
      ok: true,
      output: [
        "usage: maw policy-probe",
        "",
        "  Answers, right now, whether this turn's company policy + brain INDEX inject",
        "  reached this pane — and when it did not, which silent exit of the",
        `  UserPromptSubmit hook (${policyHookPath()}) swallowed it:`,
        "    hook   — hook not installed at all",
        "    jq     — jq missing from PATH",
        "    oracle — pane's oracle name did not resolve",
        `    server — no answer from localhost:${policyPort()}/api/policy within 2s`,
        "    inject — endpoint answered empty (not attached / policy files missing)",
        "    brain  — arrived, but with no brain INDEX section at all",
        "",
        "  It also compares the on-disk <company>-brain clone against its remote: a clone",
        "  that trails injects a stale INDEX at an unchanged entry count.",
        "",
        "  exit 0 = reached whole · 1 = did not reach · 2 = reached, brain clone behind",
        "       3 = reached, but carried no brain INDEX",
      ].join("\n"),
    };
  }

  return toResult(await probePolicyInject());
}

/** Probe result → CLI result. See the exit-code table in the file header. */
export function toResult(r: PolicyProbeResult): InvokeResult {
  const output = formatProbe(r);
  if (r.ok) return { ok: true, output };
  const exitCode = r.stage === BRAIN_ONLY_STAGE ? 3 : r.stage ? 1 : 2;
  return { ok: false, exitCode, output };
}
