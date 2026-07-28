import type { SignTier } from "./store";

/** One changed file in a PR diff — the shape `gh pr view --json files` returns per entry. */
export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface SignTierClassification {
  tiers: SignTier[];
  reason: string;
}

/**
 * kobo-546: sensitivity is decided by PATH ONLY (deterministic, greppable, one
 * list) — never by reading intent or diff content. "shared property" (lead's own
 * wording, use verbatim): a file other oracles run without deploying it
 * themselves — `~/.bun/bin/maw` symlinks into ONE checkout, so editing here hits
 * every oracle instantly, nobody presses anything. A file matching this
 * definition is sensitive, no further argument needed.
 *
 * 6 from the lead + 5 that proved themselves live the same day (kobo-335/362/
 * 400/501/546 dogfood). #1/#2 (hash, money) have no matching file in THIS repo
 * today — maw-js doesn't touch payment/hash-dedup code, that lives in sibling
 * repos (kob-payment-gateway etc, see the global hash-SACRED rule) — the entries
 * stay in the table for when/if such a path ever appears here.
 */
export const SENSITIVE_PATHS: Array<{ category: string; match: (path: string) => boolean }> = [
  { category: "hash / idempotency", match: (p) => /(^|\/)(hash|idempotency)(\/|[-.]|$)/i.test(p) },
  { category: "money paths", match: (p) => /(^|\/)(money|payment|billing)(\/|[-.]|$)/i.test(p) },
  { category: "sign/merge gate code itself", match: (p) => p === "src/core/tasks/store.ts" || p === "src/vendor/mpr-plugins/task/index.ts" || p === "src/core/tasks/sign-tier-classifier.ts" },
  { category: "TaskRecord schema", match: (p) => p === "src/core/tasks/store.ts" },
  { category: "crew-skills assets / hook-setup / statusline", match: (p) => p.startsWith("src/vendor/mpr-plugins/crew-skills/") || p === "src/core/worklog/hook-setup.ts" || p === "src/core/status-reporter.ts" },
  { category: "CI config", match: (p) => p.startsWith(".github/workflows/") },
  { category: "pr-watch", match: (p) => p === "src/core/worklog/pr-watch.ts" || p.startsWith("src/vendor-plugins/serve-pr-watch/") },
  { category: "resolve actor / sign auth", match: (p) => p === "src/vendor/mpr-plugins/task/index.ts" },
  { category: "teardown / kill helper", match: (p) => p === "src/vendor/mpr-plugins/crew/teardown.ts" },
  { category: "route.ts / board projection", match: (p) => p === "src/core/tasks/route.ts" },
  { category: "hook provisioning (~/.config/maw/hooks)", match: (p) => p === "src/core/worklog/hook-setup.ts" },
];

/**
 * kobo-546 rule 6 (mechanical, no interpretation): a test file diff carrying ANY
 * deletion line (`-`) means someone touched an EXISTING assertion and this
 * classifier can't tell whether it got weaker — 2 tiers. A test file that is
 * pure addition (0 deletions) can be 1 tier. Not scoped to test files elsewhere
 * in this classifier (rule 3's "line count" prose is a caution against using
 * line-count ALONE to decide "small," not a second numeric threshold — the AC's
 * Given/When/Then never exercises a raw line-count gate, only path + this
 * test-file rule; adding an unstated threshold would be improvising an extra).
 */
function isTestFile(path: string): boolean {
  return /\.test\.[jt]sx?$/.test(path) || /(^|\/)test\//.test(path);
}

/**
 * Pure — no gh, no filesystem. `files === null` = diff unreadable (gh failed, no
 * PR linked, or the caller never had a diff to give it) — fail-closed 2 tiers.
 * `files.length === 0` = empty diff (PR with no changed files) — ALSO
 * fail-closed 2 tiers per the card's own unhappy path, not treated as harmless.
 */
export function classifySignTiers(files: DiffFile[] | null): SignTierClassification {
  if (files === null) return { tiers: ["crew", "head"], reason: "diff unreadable (gh failure / no PR to read) — fail-closed" };
  if (files.length === 0) return { tiers: ["crew", "head"], reason: "empty diff (PR has no changed files) — fail-closed" };

  // path-sensitivity wins over everything else, checked first (rule 3: path only).
  for (const f of files) {
    const hit = SENSITIVE_PATHS.find((s) => s.match(f.path));
    if (hit) return { tiers: ["crew", "head"], reason: `touches sensitive path (${hit.category}): ${f.path}` };
  }

  for (const f of files) {
    if (isTestFile(f.path) && f.deletions > 0) {
      return { tiers: ["crew", "head"], reason: `test file diff removes/edits existing lines, can't verify assertions weren't weakened: ${f.path}` };
    }
  }

  return { tiers: ["head"], reason: "no sensitive path, no test-file deletions" };
}
