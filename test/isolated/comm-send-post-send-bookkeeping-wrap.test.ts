/**
 * kobo-1813 / kobo-693 — post-send bookkeeping in cmdSend's local-delivery
 * branch used to run un-wrapped after a successful sendKeys: any throw in
 * that tail (runHook, the config.node check, logMessage, emitMessageFeed,
 * runPluginEventHooks, detectWindowMismatch) escaped cmdSend even though the
 * message had already landed in the target pane. Tonight's incident: the
 * bare `if (!config.node) throw ...` fired AFTER delivery and turned a
 * successful send into an uncaught rejection.
 *
 * Scope of this test: ONLY the local-delivery branch's post-send tail. It
 * proves two things about the fix in src/commands/shared/comm-send.ts:
 *
 *   1. (positive) With the wrap in place, the same fault (config.node
 *      missing) no longer escapes cmdSend — it is reported via
 *      console.error and the function returns normally.
 *   2. (negative control) The IDENTICAL fault, in the IDENTICAL region, on
 *      the pre-fix source (pinned at origin/alpha's tip immediately before
 *      this patch — commit BASE_OID below), DOES escape. Same mocks, same
 *      scenario, only the source module differs — isolating the wrap
 *      itself as the cause of the difference, not an artifact of the test
 *      setup.
 *
 * Both branches reach the identical point of failure — proven by
 * sendKeysCalls having exactly one entry (delivery already happened) and
 * logMessageCalls staying empty (the line right after the throw never
 * runs) in both the positive and negative-control runs.
 *
 * The pre-fix snapshot (src/commands/shared/comm-send.pre-1813-fix.snapshot.ts)
 * is a checked-in, byte-exact copy of comm-send.ts as of origin/alpha's tip
 * immediately before this patch (commit 32553051), taken via
 * `git show 32553051:src/commands/shared/comm-send.ts`. It lives next to
 * comm-send.ts so its relative imports resolve identically and pick up the
 * same mock.module intercepts below. It is NOT generated at test time:
 * CI runners use a shallow checkout (fetch-depth default, no history beyond
 * the PR head), so `git show <old-oid>` fails there with "path exists on
 * disk, but not in <oid>" — a real failure hit and fixed while writing this
 * test, not a hypothetical. A static, committed fixture has no such
 * dependency on checkout depth.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

const srcRoot = join(import.meta.dir, "../..");
const snapshotPath = join(srcRoot, "src/commands/shared/comm-send.pre-1813-fix.snapshot.ts");

// A committed snapshot is supposed to be frozen forever — the pin below is the
// only thing that distinguishes "frozen on purpose" from "stale by neglect."
// Without it, someone editing this file by accident (or "fixing" it to match
// a later comm-send.ts) silently voids the negative control below: the test
// would keep passing, correctly, about a source that no longer exists.
// Recomputed directly from the file at review time, not copied from a report:
// sha256 a656400a6be3c47e830be8fe667ef07a2dd6b6d89ea332e901d4c559ed24f0bd,
// 104720 bytes, matches comm-send.ts at origin/alpha 32553051 byte-for-byte.
const SNAPSHOT_SHA256 = "a656400a6be3c47e830be8fe667ef07a2dd6b6d89ea332e901d4c559ed24f0bd";

type Session = { name: string; windows: Array<{ index: number; name: string; active: boolean }> };
type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; detail: string; hint?: string }
  | null;

// initialized here (not only in beforeEach): some modules in cmdSend's import
// graph (e.g. src/core/transport/ssh.ts) call loadConfig() eagerly at module
// evaluation time, before any test's beforeEach has run.
let config: any = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [], commands: { default: "claude" } };
let listSessionsReturn: Session[];
let resolveTargetReturn: ResolvedTarget;
let sendKeysCalls: Array<{ target: string; text: string }>;
let captureResponses: string[];
let captureCalls: Array<{ target: string; lines: number }>;
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; data: any }>;
let transportEventCalls: Array<{ eventName: string; payload: unknown }>;

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run(...args: string[]) {
      if (args[0] === "list-panes") return "0 claude\n";
      return "";
    }
    async tryRun(...args: string[]) {
      return "";
    }
  }
  return { Tmux: MockTmux, tmux: new MockTmux(), tmuxCmd: () => "tmux", resolveSocket: () => undefined };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => listSessionsReturn,
  capture: async (target: string, lines: number) => {
    captureCalls.push({ target, lines });
    return captureResponses.length ? captureResponses.shift()! : "";
  },
  sendKeys: async (target: string, text: string) => {
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => "claude",
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
  findPeerForTarget: async () => null,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async () => ({ ok: true, status: 200, data: {} }),
  runHook: async (name: string, payload: any) => {
    runHookCalls.push({ name, payload });
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
  cfgLimit: () => 80,
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  logMessage: (from: string, to: string, message: string, route: string) => {
    logMessageCalls.push({ from, to, message, route });
  },
  emitFeed: (event: string, oracle: string, host: string, message: string, port: number, data: any) => {
    emitFeedCalls.push({ event, data });
  },
}));

mock.module(join(srcRoot, "src/plugin/event-hooks"), () => ({
  runPluginEventHooks: async (eventName: string, payload: unknown) => {
    transportEventCalls.push({ eventName, payload });
    return { eventName, matched: 0, invoked: 0, skipped: 0, failed: 0 };
  },
}));

const origSleep = Bun.sleep.bind(Bun);
const origFetch = globalThis.fetch;
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origTestMode = process.env.MAW_TEST_MODE;

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

const { cmdSend } = await import("../../src/commands/shared/comm-send");
const { cmdSend: cmdSendPreFix } = await import(pathToFileURL(snapshotPath).href);

let exitCode: number | undefined;
let errs: string[];
let logs: string[];

async function runCmd(fn: () => Promise<unknown>) {
  exitCode = undefined;
  errs = [];
  logs = [];
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__")) throw error;
  } finally {
    console.error = origErr;
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  // #kobo-1813 — inlined per-command, never exported: cleared in afterEach below.
  process.env.MAW_TEST_MODE = "1";
  process.env.CLAUDE_AGENT_NAME = "sender";
  // checkBusyGuard (real, unmocked module) falls back to a real fetch against
  // localhost:<port> when no in-memory status entry exists — stub so the test
  // never reaches out over the network for a fake target.
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  config = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [], commands: { default: "claude" } };
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  sendKeysCalls = [];
  captureResponses = ["", "accepted"]; // "" = pane-input guard sees a clean pane; "accepted" = post-send last-line
  captureCalls = [];
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  transportEventCalls = [];
});

afterEach(() => {
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = origTestMode;
});

afterAll(() => {
  globalThis.fetch = origFetch;
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("kobo-1813 — post-send bookkeeping wrap (local-delivery branch)", () => {
  test("negative-control fixture is frozen — sha256 pin catches an accidental (or well-meaning) edit", () => {
    const actual = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
    expect(actual).toBe(SNAPSHOT_SHA256); // if this fails: the snapshot is stale — the negative control below is no longer comparing against real pre-fix source
  });

  test("regression guard: happy path (config.node present) is unchanged by the wrap", async () => {
    await runCmd(() => cmdSend("local:session:oracle", "hello"));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[test-node:sender] hello" }]);
    expect(logMessageCalls).toEqual([{ from: "sender", to: "local:session:oracle", message: "[test-node:sender] hello", route: "local" }]);
    expect(emitFeedCalls).toHaveLength(1);
    expect(transportEventCalls).toHaveLength(1);
    expect(errs.join("\n")).not.toContain("post-send bookkeeping failed");
  });

  test("positive: config.node missing after a successful send is caught, reported, and does not escape cmdSend", async () => {
    config.node = undefined;

    await runCmd(() => cmdSend("local:session:oracle", "hello"));

    // delivery already happened before the bookkeeping tail runs (node falls
    // back to "local" in the visible prefix once config.node is missing)
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[local:sender] hello" }]);
    // the throw fired exactly where expected: nothing after it in the tail ran
    expect(logMessageCalls).toEqual([]);
    expect(emitFeedCalls).toEqual([]);
    expect(transportEventCalls).toEqual([]);
    // never a silent catch — the swallowed error is visible
    expect(errs.join("\n")).toContain("post-send bookkeeping failed");
    expect(errs.join("\n")).toContain("config.node is required");
    // no exception escaped cmdSend, no process.exit was called
    expect(exitCode).toBeUndefined();
  });

  test("negative control: the SAME fault in the SAME region, WITHOUT the wrap (pre-fix source), escapes cmdSend", async () => {
    config.node = undefined;

    await expect(runCmd(() => cmdSendPreFix("local:session:oracle", "hello"))).rejects.toThrow(
      "config.node is required",
    );

    // proves the pre-fix run reached the identical point of failure as the
    // fixed version above, not a different one — the only variable is the wrap
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[local:sender] hello" }]);
    expect(logMessageCalls).toEqual([]);
  });
});
