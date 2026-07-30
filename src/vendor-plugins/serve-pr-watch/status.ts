/**
 * kobo-633 Slice 5 — CLI-facing readout of `prWatchLiveness()`. Pure
 * formatting kept separate from the CLI plumbing (ctx/console redirection)
 * in `index.ts`, same split as this repo's other CLI plugins (e.g.
 * zenoh-scout's `impl.ts`).
 *
 * `sinceIso` defaults to the exported `DEFAULT_ACCEPTANCE_LOOKBACK_MS`
 * rolling window — this IS the "caller that explicitly wants a rolling
 * daily status window" the constant's own doc comment names as the sanctioned
 * opt-in (a status readout, not an acceptance audit against a fixed T0).
 * `prWatchLiveness` itself still refuses a silent default — this file is
 * the one place that makes the rolling-window choice, on purpose, once.
 */
import {
  prWatchLiveness,
  DEFAULT_ACCEPTANCE_LOOKBACK_MS,
  type PrWatchLivenessResult,
} from "../../core/worklog/pr-watch";

export async function cmdPrWatchStatus(opts: { sinceIso?: string } = {}): Promise<PrWatchLivenessResult> {
  const sinceIso = opts.sinceIso ?? new Date(Date.now() - DEFAULT_ACCEPTANCE_LOOKBACK_MS).toISOString();
  return prWatchLiveness(sinceIso);
}

export function formatPrWatchStatus(result: PrWatchLivenessResult): string {
  const { acceptance, diagnostics } = result;
  const lines = [
    `acceptance: ${acceptance.verdict} — ${acceptance.reason}`,
    `  since ${acceptance.sinceIso} · merged ${acceptance.mergedSinceCount} (limit ${acceptance.limit}) · passed ${acceptance.passedCount} · failed ${acceptance.failed.length} · unlinked ${acceptance.unlinked.length}`,
    `  provenance: ${acceptance.provenanceClaim} — ${acceptance.provenanceReason}`,
    `heartbeat: ${diagnostics.heartbeatStatus} — ${diagnostics.reason}`,
  ];
  if (diagnostics.pollsCompleted !== undefined) {
    lines.push(
      `  polls completed ${diagnostics.pollsCompleted} · last pass ${diagnostics.lastPollCompletedAtIso} · age ${diagnostics.ageSeconds}s · version ${diagnostics.codeVersion}`,
    );
  }
  if (acceptance.failed.length > 0) {
    lines.push(`  failed: ${acceptance.failed.map((f) => `${f.repo}#${f.number}`).join(", ")}`);
  }
  if (acceptance.unlinked.length > 0) {
    lines.push(`  unlinked: ${acceptance.unlinked.map((u) => `${u.repo}#${u.number}`).join(", ")}`);
  }
  return lines.join("\n");
}
