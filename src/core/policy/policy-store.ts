/**
 * Company/dept policy store — reads the policy markdown that `maw company sync`
 * drops under the company registry at
 *   <COMPANIES_DIR>/<company>/policy/{company.md,<dept>.md}
 *
 * Also reads a company's `<company>-brain` INDEX (ψ/INDEX.md), a sibling
 * knowledge source rooted at MAW_BRAIN_ROOT (default `~/ghq/github.com/meganechan`)
 * rather than COMPANIES_DIR — it's a separate git repo, not registry config.
 *
 * Anchored on COMPANIES_DIR (the company-helpers live binding) so tests can
 * relocate the registry via `_setCompaniesDir`; MAW_BRAIN_ROOT is read fresh on
 * every call for the same reason. Best-effort throughout: a missing directory /
 * file yields null, never an exception — policy injection must never block or
 * crash the agent.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";

/** Directory holding a company's policy markdown. */
export function policyDir(company: string): string {
  return join(COMPANIES_DIR, company, "policy");
}

function readOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf-8");
    return text.length ? text : null;
  } catch {
    return null;
  }
}

/** Company-wide policy (`<dir>/company.md`), or null when absent. */
export function readCompanyPolicy(company: string): string | null {
  return readOrNull(join(policyDir(company), "company.md"));
}

/** Department policy (`<dir>/<dept>.md`), or null when absent. */
export function readDeptPolicy(company: string, dept: string): string | null {
  return readOrNull(join(policyDir(company), `${dept}.md`));
}

/** Root dir holding `<company>-brain` repos. Read at call time (not cached) so
 *  tests can relocate it via MAW_BRAIN_ROOT. */
function brainRoot(): string {
  return process.env.MAW_BRAIN_ROOT || join(homedir(), "ghq", "github.com", "meganechan");
}

/** Where a company's brain repo lives (`<brainRoot>/<company>-brain`). */
export function brainDir(company: string): string {
  return join(brainRoot(), `${company}-brain`);
}

/** Absolute dir the INDEX points into — full learning entries live here. */
export function brainLearningsDir(company: string): string {
  return join(brainDir(company), "ψ", "memory", "learnings");
}

/** Company brain INDEX (`<brain>/ψ/INDEX.md`), or null when absent/empty. */
export function readBrainIndex(company: string): string | null {
  return readOrNull(join(brainDir(company), "ψ", "INDEX.md"));
}
