/**
 * `maw company cell down` busy guard — ISOLATED SUITE (kobo-778).
 *
 * The bug: `checkBusyGuard` mapped an oracle the status source cannot answer for
 * to `{ busy: false }`, and cell down read that as permission. The status source
 * answers for no kobo oracle today (`/api/status` → `{"agents":[],"total":0}`),
 * so teardown was approved for every pane it knew nothing about — the same
 * posture bug the shell-allowlist guard exists to prevent. A guard that cannot
 * see must say NO.
 *
 * The guard here is the REAL `checkBusyGuard` (imported by path, wired in through
 * the SDK mock) with only `fetch` stubbed. Mocking the guard's verdict directly
 * would prove nothing: it would assert that down refuses when told to refuse,
 * not that a 404 from the status source reaches down as a refusal.
 *
 * Why isolated: spawn.ts shells through maw-js/sdk hostExec and Bun's
 * mock.module is process-global. No test here touches a real tmux server.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBusyGuard as realCheckBusyGuard } from "../../src/core/agent-status-guard";
import { agentStatusStore } from "../../src/core/agent-status";

const dir = mkdtempSync(join(tmpdir(), "maw-cellguard-"));
const prevDataDir = process.env.MAW_DATA_DIR;
const prevPane = process.env.TMUX_PANE;
const originalFetch = globalThis.fetch;

process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
writeFileSync(join(dir, "companies", "testco.json"),
  JSON.stringify({ name: "testco", teams: { core: { members: [{ oracle: "patchwork" }] } } }));

const headCwd = join(dir, "headcwd");
const stateDir = join(headCwd, "ψ", "active", "cell");

interface FakePane { id: string; role: string; window: string; identity: string; path: string }

let panes: FakePane[] = [];
let killAttempts: string[] = [];
/** every `checkBusyGuard` call the cell path made, with the options it asked for */
let guardCalls: Array<{ target: string; opts: unknown }> = [];

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    if (cmd.includes("tmux list-panes")) {
      return panes.map((p) => `${p.id}|||${p.role}|||${p.window}|||${p.identity}|||${p.path}`).join("\n") + "\n";
    }
    if (cmd.includes("kill-pane")) {
      const target = cmd.match(/kill-pane -t '([^']+)'/)?.[1] ?? "";
      killAttempts.push(target);
      panes = panes.filter((p) => p.id !== target);
      return "";
    }
    return "";
  },
  listSessions: async () => [],
  findWindow: () => "sess:win",
  cmdWake: async () => {},
  checkBusyGuard: async (target: string, opts?: unknown) => {
    guardCalls.push({ target, opts });
    return await realCheckBusyGuard(target, opts as { failClosed?: boolean });
  },
}));

const { companyCellDown } = await import("../../src/vendor/mpr-plugins/cell/spawn");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;
_setCompaniesDir(join(dir, "companies"));

afterAll(() => {
  _setCompaniesDir(prevCompaniesDir);
  globalThis.fetch = originalFetch;
  if (prevDataDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDataDir;
  if (prevPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = prevPane;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  killAttempts = [];
  guardCalls = [];
  process.env.TMUX_PANE = "%invoker";
  // Empty the in-memory store so the guard has to ask the status source — with
  // an entry present it would answer locally and never reach the blind path.
  for (const e of agentStatusStore.getAll()) agentStatusStore.remove(e.oracle);
  panes = [
    { id: "%head", role: "👤 head", window: "cell-head", identity: "patchwork:head", path: headCwd },
    { id: "%worker", role: "⚒ worker", window: "cell-workers", identity: "patchwork:worker", path: headCwd },
  ];
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "head.md"), "state\n");
});

// kobo-822: down now tears down head too (it used to stand it down and keep
// it alive for a self-spawn re-adopt that no longer exists) — the guard
// question this suite is about (does a blind status source block teardown at
// all) is unaffected, but "teardown proceeds" now means BOTH panes gone.

/** default false — a refusal that only shows under --verbose is a silent refusal */
async function down(opts: { force?: boolean; verbose?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  await companyCellDown("testco", opts, (line) => out.push(line));
  return out;
}

/** Each entry is a different way for the status source to fail to answer. */
const blindSpots: Array<{ name: string; stub: () => void; reason: RegExp }> = [
  {
    name: "404 — the status source has never heard of this oracle",
    stub: () => { globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch; },
    reason: /404/,
  },
  {
    name: "connection refused — the status server is not running",
    stub: () => { globalThis.fetch = (async () => { throw new Error("Unable to connect"); }) as typeof fetch; },
    reason: /unreachable/,
  },
  {
    name: "hang — the status server accepted the socket and never answered",
    stub: () => {
      globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
      })) as unknown as typeof fetch;
    },
    reason: /unreachable/,
  },
  {
    name: "malformed JSON — something answered on the port, but not the status API",
    stub: () => { globalThis.fetch = (async () => new Response("{not json", { status: 200 })) as typeof fetch; },
    reason: /unreadable JSON/,
  },
];

describe("cell down fails CLOSED when the status source cannot answer (kobo-778)", () => {
  for (const spot of blindSpots) {
    test(`${spot.name} → refuses teardown, kills nothing`, async () => {
      spot.stub();
      const out = await down();

      expect(killAttempts).toEqual([]);
      expect(panes.map((p) => p.id).sort()).toEqual(["%head", "%worker"]);
      expect(out.at(-1)).toContain("0 torn, 0 partial, 0 skipped, 1 refused");
    }, 10_000);

    test(`${spot.name} → the refusal names the blind spot and the way out, without --verbose`, async () => {
      spot.stub();
      const out = await down();

      const refusal = out.find((l) => l.includes("refusing cell teardown"));
      expect(refusal).toBeDefined();
      expect(refusal!).toContain("patchwork");
      expect(refusal!).toMatch(spot.reason);
      expect(refusal!).toContain("--force");
    }, 10_000);
  }

  test("the cell path asks for fail-closed explicitly — it does not inherit it", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    await down();

    expect(guardCalls).toHaveLength(1);
    expect(guardCalls[0]!.target).toBe("patchwork");
    expect(guardCalls[0]!.opts).toEqual({ failClosed: true });
  });

  // Negative control: if fail-closed refused everything, the tests above would
  // pass for the wrong reason. A status source that answers must still be obeyed.
  test("status source answers 'ready' → teardown proceeds", async () => {
    globalThis.fetch = (async () => Response.json({ status: "ready" })) as typeof fetch;
    const out = await down();

    expect(killAttempts.sort()).toEqual(["%head", "%worker"]);
    expect(out.at(-1)).toContain("1 torn");
  });

  test("status source answers 'busy' → still refuses, with the status as the reason", async () => {
    globalThis.fetch = (async () => Response.json({ status: "busy" })) as typeof fetch;
    const out = await down();

    expect(killAttempts).toEqual([]);
    expect(out.some((l) => l.includes("refusing cell teardown") && l.includes("busy"))).toBe(true);
    expect(out.at(-1)).toContain("1 refused");
  });
});

describe("--force overrides the guard, loudly (kobo-778)", () => {
  test("blind status source + --force → tears down, and says the guard was skipped without --verbose", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const out = await down({ force: true });

    expect(killAttempts.sort()).toEqual(["%head", "%worker"]);
    expect(out.at(-1)).toContain("1 torn");
    const override = out.find((l) => l.includes("busy guard SKIPPED"));
    expect(override).toBeDefined();
    expect(override!).toContain("--force");
    expect(override!).toContain("patchwork");
  });

  test("--force does not consult the status source at all — the escape hatch cannot hang on it", async () => {
    globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
    const out = await down({ force: true });

    expect(guardCalls).toEqual([]);
    expect(killAttempts.sort()).toEqual(["%head", "%worker"]);
    expect(out.at(-1)).toContain("1 torn");
  });
});
