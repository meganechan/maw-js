import { describe, expect, test } from "bun:test";
import { join } from "path";

// kobo-337: the PostToolUse(Agent) offload-nudge hook. Drives the REAL bash script with
// captured-shape payloads (live CC 2.1.165: PostToolUse(Agent) carries duration_ms +
// tool_input.run_in_background). Hermetic — the script only reads stdin + writes stdout,
// no side effects, no live pane.

const SCRIPT = join(import.meta.dir, "../../scripts/hooks/agent-offload-nudge.sh");

async function runHook(payload: object, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["bash", SCRIPT], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...env },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

const fg = (duration_ms: number, extra: object = {}) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Agent",
  tool_input: { prompt: "do a thing", subagent_type: "general-purpose", ...extra },
  duration_ms,
});

describe("kobo-337 agent-offload-nudge hook", () => {
  test("foreground Agent over threshold → nudge (additionalContext)", async () => {
    const out = await runHook(fg(90000)); // 90s, default threshold 45s
    expect(out).not.toBe("");
    const j = JSON.parse(out);
    expect(j.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(j.hookSpecificOutput.additionalContext).toContain("run_in_background");
    expect(j.hookSpecificOutput.additionalContext).toContain("~90s");
  });

  test("background Agent (run_in_background:true) → NO nudge even with big duration", async () => {
    // bg self-excludes: the flag (and in reality the detach duration is ~2ms anyway)
    const out = await runHook(fg(90000, { run_in_background: true }));
    expect(out).toBe("");
  });

  test("short foreground Agent (below threshold) → NO nudge", async () => {
    expect(await runHook(fg(1835))).toBe(""); // the real fg-probe duration
  });

  test("missing duration_ms → NO nudge, no crash", async () => {
    const out = await runHook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {} });
    expect(out).toBe("");
  });

  test("non-numeric duration_ms → NO nudge, no crash", async () => {
    const out = await runHook({ tool_name: "Agent", tool_input: {}, duration_ms: "oops" });
    expect(out).toBe("");
  });

  test("non-Agent tool → NO nudge (matcher belt-and-suspenders)", async () => {
    const out = await runHook({ tool_name: "Bash", tool_input: {}, duration_ms: 90000 });
    expect(out).toBe("");
  });

  test("threshold knob MAW_AGENT_NUDGE_MS respected", async () => {
    // 20s call: nudges when threshold lowered to 10s, silent at default 45s
    expect(await runHook(fg(20000))).toBe("");
    const out = await runHook(fg(20000), { MAW_AGENT_NUDGE_MS: "10000" });
    expect(out).not.toBe("");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("~20s");
  });

  test("Task alias (pre-rename tool_name) also handled", async () => {
    const out = await runHook({ tool_name: "Task", tool_input: {}, duration_ms: 90000 });
    expect(out).not.toBe("");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("run_in_background");
  });
});
