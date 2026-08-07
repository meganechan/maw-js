/**
 * test/isolated/comm-send-resolve-pane.test.ts
 *
 * Unit tests for resolveOraclePane() after the defensive refactor (H1).
 * Verifies that target strings are passed as discrete args to Tmux.run()
 * rather than interpolated into a shell string — which means injection
 * characters in target values cannot break out of the tmux target context.
 *
 * Isolated because mock.module is process-global and stubs the tmux transport.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

// --- Capture real Tmux refs BEFORE any mock.module installs ---
const _rTmux = await import("../../src/core/transport/tmux");

// --- Mutable run stub ---
type RunCall = { subcommand: string; args: (string | number)[] };
let runCalls: RunCall[] = [];
let runReturnValue = "";

// --- Mock tmux module ---
mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    constructor(public host?: string, public socket?: string) {}
    async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
      runCalls.push({ subcommand, args });
      return runReturnValue;
    }
    async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
      return this.run(subcommand, ...args);
    }
  }
  return {
    ..._rTmux,
    Tmux: MockTmux,
    tmux: new MockTmux(),
  };
});

// --- Mock config ---
mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => ({ node: "test-node" })),
);

// --- Mock sdk (need to stub listSessions etc but not hostExec) ---
mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => [],
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "claude",
  isAgentCommand: (cmd: string | null | undefined) => {
    const c = (cmd ?? "").trim();
    return !!c && (/claude|codex|node/i.test(c) || /^\d+\.\d+\.\d+$/.test(c));
  },
  findPeerForTarget: async () => null,
  resolveTarget: () => null,
  curlFetch: async () => ({ ok: false, status: 0, data: null }),
  runHook: async () => {},
  hostExec: async () => "",
  tmux: { run: async () => "", tryRun: async () => "" },
  FLEET_DIR: "/tmp/maw-test-fleet",
}));

// --- Import the module under test AFTER all mock.module installs ---
const { resolveOraclePane } = await import("../../src/commands/shared/comm-send");

describe("resolveOraclePane — H1 defensive refactor", () => {
  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
  });

  test("Case 1 — benign target: Tmux.run called with correct args, agent pane selected", async () => {
    // Two panes: index 0 = claude (agent), index 1 = zsh
    runReturnValue = "0 claude\n1 zsh\n";
    const result = await resolveOraclePane("mawjs-session:mawjs-oracle");
    // Should resolve to pane 0 (agent at index 0)
    expect(result).toBe("mawjs-session:mawjs-oracle.0");
    // Should have called Tmux.run with discrete args
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].subcommand).toBe("list-panes");
    // kobo-782 appended `|||#{@oracle_pane}` — the identity rides along on this
    // same call rather than costing a second one. The `<index> <command>` prefix
    // is unchanged, which is why this case's canned reply still parses.
    expect(runCalls[0].args).toEqual(["-t", "mawjs-session:mawjs-oracle", "-F", "#{pane_index} #{pane_current_command}|||#{@oracle_pane}"]);
  });

  test("Case 2 — injection character in target does NOT reach shell as interpreted text", async () => {
    // Single-pane result so we don't alter the return value
    runReturnValue = "0 claude\n";
    const injectionTarget = "a'; touch /tmp/pwned; tmux #";
    await resolveOraclePane(injectionTarget);
    // Tmux.run must have been called with the literal injection string as a separate arg
    expect(runCalls).toHaveLength(1);
    // The target must appear as a discrete argument element, not inside a shell string
    const targetArgIndex = runCalls[0].args.indexOf(injectionTarget);
    expect(targetArgIndex).toBeGreaterThanOrEqual(0);
    // Verify the injection string is the exact value of args[1] (after "-t")
    expect(runCalls[0].args[0]).toBe("-t");
    expect(runCalls[0].args[1]).toBe(injectionTarget);
  });

  test("Case 3 — pane-specific target passes through untouched (D-E: one display-message identity check)", async () => {
    const result = await resolveOraclePane("session:window.2");
    // Regex short-circuit: already has .N suffix — no list-panes call, but D-E
    // still needs this exact target's identity to gate a worker/reviewer pane.
    expect(result).toBe("session:window.2");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].subcommand).toBe("display-message");
    expect(runCalls[0].args).toEqual(["-p", "-t", "session:window.2", "#{@oracle_pane}"]);
  });

  test("kobo-83 — a %NNN pane-id passes through untouched, no .index suffix (D-E: one display-message identity check)", async () => {
    // Multi-agent-pane output would otherwise trigger a `.{index}` append; a
    // pane-id must short-circuit BEFORE that so `send-keys -t '%678.1'` (invalid)
    // is never constructed for a kobo-81 team-member pane.
    runReturnValue = "0 zsh\n1 claude\n2 claude\n";
    const result = await resolveOraclePane("%678");
    expect(result).toBe("%678");
    // Not the multi-pane list-panes call above — a single identity lookup on
    // the exact pane-id target (D-E worker-pane guard).
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].subcommand).toBe("display-message");
  });

  test("Case 4 — single-pane window: returns target unchanged", async () => {
    runReturnValue = "0 zsh\n";
    const result = await resolveOraclePane("my-session:oracle");
    expect(result).toBe("my-session:oracle");
  });

  test("Case 5 — no agent pane found: returns target unchanged", async () => {
    runReturnValue = "0 zsh\n1 bash\n";
    const result = await resolveOraclePane("my-session:oracle");
    expect(result).toBe("my-session:oracle");
  });

  test("Case 6 — Tmux.run throws: returns target unchanged (error swallowed)", async () => {
    // Override run to throw
    const _rTmuxAgain = await import("../../src/core/transport/tmux");
    const origRun = (_rTmuxAgain.Tmux.prototype as any).run;
    (_rTmuxAgain.Tmux.prototype as any).run = async () => { throw new Error("tmux not running"); };
    const result = await resolveOraclePane("my-session:oracle");
    expect(result).toBe("my-session:oracle");
    (_rTmuxAgain.Tmux.prototype as any).run = origRun;
  });

  // kobo-596 (option C) — the return VALUE has always been unchanged-on-error
  // (Case 6 above); what was missing is any way for a caller to tell that
  // apart from "resolution wasn't needed at all" (Cases 3/4/5, also
  // unchanged). The diagnostics out-param is the new signal.
  test("kobo-596: Tmux.run throws → diagnostics.degraded=true + the real error message, when the caller asks for it", async () => {
    const _rTmuxAgain = await import("../../src/core/transport/tmux");
    const origRun = (_rTmuxAgain.Tmux.prototype as any).run;
    (_rTmuxAgain.Tmux.prototype as any).run = async () => { throw new Error("tmux not running"); };
    const diagnostics: { degraded?: boolean; error?: string } = {};
    const result = await resolveOraclePane("my-session:oracle", {}, {}, diagnostics);
    expect(result).toBe("my-session:oracle");
    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.error).toContain("tmux not running");
    (_rTmuxAgain.Tmux.prototype as any).run = origRun;
  });

  // The 3 other "unchanged target" paths (single-pane, no-agent-found,
  // already-pane-specific/pane-id short-circuits) are NOT errors — a caller
  // passing diagnostics must not see degraded=true for a genuinely clean
  // resolution that just happened to need no suffix.
  test("kobo-596: diagnostics stays empty on the legitimate no-change paths (not degraded)", async () => {
    const d1: { degraded?: boolean } = {};
    await resolveOraclePane("session:window.2", {}, {}, d1); // already pane-specific
    expect(d1.degraded).toBeUndefined();

    runReturnValue = "0 zsh\n"; // single-pane window
    const d2: { degraded?: boolean } = {};
    await resolveOraclePane("my-session:oracle", {}, {}, d2);
    expect(d2.degraded).toBeUndefined();

    runReturnValue = "0 zsh\n1 bash\n"; // no agent pane found
    const d3: { degraded?: boolean } = {};
    await resolveOraclePane("my-session:oracle", {}, {}, d3);
    expect(d3.degraded).toBeUndefined();
  });
});

describe("resolveOraclePane — kobo-36 channel→pane routing", () => {
  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
  });

  // 4-pane warroom: coord (agent) at .1, worker (agent) at .2, main at .0.
  const WARROOM = "0 claude\n1 claude\n2 claude\n3 zsh\n";

  test("channel with a live mapped pane → routes there (overrides default .0)", async () => {
    runReturnValue = WARROOM;
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: (oracle, channel) => (oracle === "eq3" && channel === "task-events" ? 1 : null) },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.1"); // coord pane, NOT .0
  });

  test("mapped pane not present in window → falls back to default lowest-agent pane", async () => {
    runReturnValue = WARROOM; // panes 0..3; mapping points at 9 (stale/closed)
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: () => 9 },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.0"); // stale → default, never a dead index
  });

  test("no mapping for the channel → default behavior unchanged (backward-compat)", async () => {
    runReturnValue = WARROOM;
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: () => null },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.0");
  });

  test("no channel supplied → registry is never consulted", async () => {
    runReturnValue = WARROOM;
    let consulted = false;
    const result = await resolveOraclePane(
      "eq3:eq3-oracle",
      { getPaneRouteFn: () => { consulted = true; return 1; } },
      { oracle: "eq3" }, // channel omitted
    );
    expect(consulted).toBe(false);
    expect(result).toBe("eq3:eq3-oracle.0");
  });

  test("explicit .N suffix still wins over any channel mapping", async () => {
    const result = await resolveOraclePane(
      "eq3:eq3-oracle.2",
      { getPaneRouteFn: () => 1 },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("eq3:eq3-oracle.2");
    expect(runCalls).toHaveLength(1); // short-circuits before list-panes, but D-E still checks identity
  });
});

/**
 * kobo-782 — which pane of a cell-up oracle's window gets the message.
 *
 * "Lowest agent pane index" is a POSITION. A cell head window also holds the
 * worker and reviewer panes, so position silently retargets the oracle's mail at
 * a teammate whenever the head is not the lowest index. `@oracle_pane` says
 * which pane is the oracle.
 */
describe("resolveOraclePane picks the head pane by identity (kobo-782)", () => {
  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
  });

  test("the head pane wins even when a teammate sits at a lower index", async () => {
    runReturnValue = [
      "0 claude|||eq3:worker",
      "1 claude|||eq3:head",
      "2 claude|||eq3:reviewer",
    ].join("\n");

    expect(await resolveOraclePane("54-eq3:cell-head", {}, { oracle: "eq3" })).toBe("54-eq3:cell-head.1");
  });

  test("another oracle's head in the same window is not this oracle's pane", async () => {
    runReturnValue = [
      "0 claude|||thawanban:head",
      "1 claude|||eq3:head",
    ].join("\n");

    // position alone would answer .0 — the identity is what makes it .1
    expect(await resolveOraclePane("54-shared:w", {}, { oracle: "eq3" })).toBe("54-shared:w.1");
  });

  test("duplicate heads in one window resolve to the lowest index — the same oldest-wins rule", async () => {
    runReturnValue = [
      "0 claude|||eq3:worker",
      "1 claude|||eq3:head",
      "2 claude|||eq3:head",
    ].join("\n");

    expect(await resolveOraclePane("54-eq3:cell-head", {}, { oracle: "eq3" })).toBe("54-eq3:cell-head.1");
  });

  test("legacy: no pane carries an identity → the historical lowest-agent-pane default", async () => {
    runReturnValue = "0 zsh|||\n1 claude|||\n";

    expect(await resolveOraclePane("54-eq3:eq3-oracle", {}, { oracle: "eq3" })).toBe("54-eq3:eq3-oracle.1");
  });

  test("a reply with no identity field at all still parses (fail-open on the older format)", async () => {
    runReturnValue = "0 zsh\n1 claude\n";

    expect(await resolveOraclePane("54-eq3:eq3-oracle", {}, { oracle: "eq3" })).toBe("54-eq3:eq3-oracle.1");
  });

  test("a head whose agent died is not deliverable — the live agent default stands", async () => {
    // pane 1 deliberately carries no identity here (most of the fleet
    // doesn't) — this test is about the dead-head fallback, not D-E's
    // worker/reviewer gate, which is covered separately below.
    runReturnValue = "0 zsh|||eq3:head\n1 claude|||\n";

    expect(await resolveOraclePane("54-eq3:cell-head", {}, { oracle: "eq3" })).toBe("54-eq3:cell-head.1");
  });

  test("an explicit channel→pane mapping still wins — identity does not override a declared route", async () => {
    // pane 0 deliberately carries no identity — this test is about mapping
    // beating identity-based head selection, not D-E's worker/reviewer gate.
    runReturnValue = "0 claude|||\n1 claude|||eq3:head\n";

    const result = await resolveOraclePane(
      "54-eq3:cell-head",
      { getPaneRouteFn: () => 0 },
      { oracle: "eq3", channel: "task-events" },
    );
    expect(result).toBe("54-eq3:cell-head.0");
  });
});

/**
 * D-E — the worker-pane injection guard, exercised through the funnel
 * (not just the pure `assertPaneInjectAllowed` unit, see
 * test/worker-pane-guard.test.ts). Confirms resolveOraclePane's OWN
 * return points call the guard with the right identity, on every path
 * that can land on a worker/reviewer pane.
 */
describe("resolveOraclePane — D-E worker-pane guard", () => {
  const ENV = "MAW_WORKER_PANE_OK";
  const prevEnv = process.env[ENV];

  beforeEach(() => {
    runCalls = [];
    runReturnValue = "";
    delete process.env[ENV];
  });

  afterAll(() => {
    if (prevEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = prevEnv;
  });

  test("already-pane-specific target (.N) resolving to a worker pane is refused", async () => {
    runReturnValue = "patchwork:worker\n"; // the display-message reply for this exact pane
    await expect(resolveOraclePane("session:window.2")).rejects.toThrow(/worker pane/);
  });

  test("a %NNN pane-id resolving to a reviewer pane is refused", async () => {
    runReturnValue = "patchwork:reviewer\n";
    await expect(resolveOraclePane("%678")).rejects.toThrow(/reviewer pane/);
  });

  test("single-pane window whose only pane is a worker is refused (no extra tmux call)", async () => {
    runReturnValue = "0 claude|||patchwork:worker\n";
    await expect(resolveOraclePane("my-session:oracle")).rejects.toThrow(/worker pane/);
    expect(runCalls).toHaveLength(1); // the same list-panes call, no second lookup
  });

  test("the default lowest-agent-pane pick is refused when that pane is a worker", async () => {
    runReturnValue = "0 claude|||patchwork:worker\n1 zsh|||\n";
    await expect(resolveOraclePane("my-session:oracle")).rejects.toThrow(/worker pane/);
  });

  test("a channel-mapped pane is refused when the mapped index is a worker", async () => {
    runReturnValue = "0 claude|||patchwork:worker\n1 claude|||eq3:head\n";
    await expect(
      resolveOraclePane(
        "eq3:eq3-oracle",
        { getPaneRouteFn: () => 0 },
        { oracle: "eq3", channel: "task-events" },
      ),
    ).rejects.toThrow(/worker pane/);
  });

  test("MAW_WORKER_PANE_OK=1 allows the same worker target through", async () => {
    process.env[ENV] = "1";
    runReturnValue = "patchwork:worker\n";
    await expect(resolveOraclePane("session:window.2")).resolves.toBe("session:window.2");
  });

  test("a worker-gate refusal is a thrown error, not the silent degraded-diagnostics fallback", async () => {
    runReturnValue = "0 claude|||patchwork:worker\n1 zsh|||\n";
    const diagnostics: { degraded?: boolean; error?: string } = {};
    await expect(resolveOraclePane("my-session:oracle", {}, {}, diagnostics)).rejects.toThrow(/worker pane/);
    // Not folded into "resolution failed, guessing" — this was a deliberate refusal.
    expect(diagnostics.degraded).toBeUndefined();
  });
});
