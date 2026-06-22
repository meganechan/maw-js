import { parseFlags, type InvokeContext, type InvokeResult } from "maw-js/sdk";
import { readWorklog } from "../../../core/worklog/store";
import { renderTimeline } from "../../../core/worklog/render";
import { pollPrsOnce } from "../../../core/worklog/pr-watch";
import { setupWorklogHooks } from "../../../core/worklog/hook-setup";

export const command = {
  name: "watch",
  description: "Activity worklog — desync-killer timeline (tool-calls + PR status).",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const subcmd = args[0];

    if (subcmd === "log") {
      const flags = parseFlags(args.slice(1), { "--limit": String, "--oracle": String }, 0);
      // on-read poll: pick up any PR transitions since last trigger (best effort)
      if (!args.includes("--no-poll")) {
        try { await pollPrsOnce(); } catch { /* render from jsonl regardless */ }
      }
      const limit = flags["--limit"] ? Math.max(1, parseInt(flags["--limit"], 10) || 50) : 50;
      const entries = readWorklog({ limit, oracle: flags["--oracle"] });
      console.log(renderTimeline(entries));
    } else if (subcmd === "sync") {
      const recorded = await pollPrsOnce();
      console.log(`\x1b[32m✓\x1b[0m synced — ${recorded.length} new event${recorded.length === 1 ? "" : "s"}`);
    } else if (subcmd === "setup-hooks") {
      const dryRun = args.includes("--dry-run");
      const flags = parseFlags(args.slice(1), { "--company": String }, 0);
      const res = setupWorklogHooks({ dryRun, company: flags["--company"] });
      console.log(`\n\x1b[36mWorklog hook setup\x1b[0m${dryRun ? " \x1b[90m(dry run)\x1b[0m" : ""}\n`);
      console.log(`  script: ${res.scriptInstalled ? (dryRun ? "would install" : "installed") : "present"}`);
      if (res.updated.length) console.log(`  \x1b[32m${dryRun ? "would update" : "updated"}\x1b[0m: ${res.updated.join(", ")}`);
      if (res.alreadyOk.length) console.log(`  \x1b[90mok (already)\x1b[0m: ${res.alreadyOk.join(", ")}`);
      if (res.skipped.length) console.log(`  \x1b[33mskip (no dir)\x1b[0m: ${res.skipped.join(", ")}`);
      if (!res.updated.length && !res.alreadyOk.length) console.log(`  \x1b[33mno target oracles found\x1b[0m (check company config)`);
      console.log();
    } else {
      return { ok: false, error: "usage: maw watch <log|sync|setup-hooks> [opts]" };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
