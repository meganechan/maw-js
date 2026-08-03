import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { extractOracleName, checkBusyGuard } from "../../src/core/agent-status-guard";
import { agentStatusStore } from "../../src/core/agent-status";

const originalFetch = globalThis.fetch;

describe("extractOracleName", () => {
  test("bare name", () => {
    expect(extractOracleName("neo")).toBe("neo");
  });

  test("strips -oracle suffix", () => {
    expect(extractOracleName("neo-oracle")).toBe("neo");
  });

  test("session:window format", () => {
    expect(extractOracleName("08-mawjs:neo-oracle")).toBe("neo");
  });

  test("session:window without -oracle", () => {
    expect(extractOracleName("08-mawjs:neo")).toBe("neo");
  });

  test("local: prefix", () => {
    expect(extractOracleName("local:neo")).toBe("neo");
  });

  test("node:oracle format", () => {
    expect(extractOracleName("white:neo-oracle")).toBe("neo");
  });
});

describe("checkBusyGuard", () => {
  beforeEach(() => {
    for (const e of agentStatusStore.getAll()) agentStatusStore.remove(e.oracle);
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("unknown agent → not busy", async () => {
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("unknown");
  });

  test("busy agent → busy=true", async () => {
    agentStatusStore.report("neo", "busy");
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(true);
    expect(result.status).toBe("busy");
  });

  test("ready agent → not busy", async () => {
    agentStatusStore.report("neo", "ready");
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("ready");
  });

  test("idle agent → not busy", async () => {
    agentStatusStore.report("neo", "idle");
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("idle");
  });

  test("resolves oracle name from session:window-oracle format", async () => {
    agentStatusStore.report("neo", "busy");
    const result = await checkBusyGuard("08-mawjs:neo-oracle");
    expect(result.busy).toBe(true);
    expect(result.oracle).toBe("neo");
  });
});

/**
 * kobo-778 — a guard that cannot see must say NO, for callers that asked to be
 * guarded that way. Every branch below is a DIFFERENT way of not seeing, and
 * each must be distinguishable from the others in `reason`: "unknown" alone
 * cannot tell a sleeping oracle from a status server that is down, and the
 * operator reading a refusal has to know which one they are looking at.
 */
describe("checkBusyGuard fail-closed (kobo-778)", () => {
  beforeEach(() => {
    for (const e of agentStatusStore.getAll()) agentStatusStore.remove(e.oracle);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("404 → refuses, and the reason names the 404 and the oracle", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(true);
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("404");
    expect(result.reason).toContain("neo");
  });

  test("connection refused → refuses, reason says unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); }) as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(true);
    expect(result.reason).toContain("unreachable");
    expect(result.reason).toContain("Unable to connect");
  });

  test("status source hangs → the request is aborted and refuses; a hang is a verdict, not a wait", async () => {
    // Honour the abort signal so this exercises the REAL timeout, not a stub of it.
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(true);
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("unreachable");
  }, 10_000);

  test("malformed JSON body → refuses, reason says the answer was unreadable", async () => {
    globalThis.fetch = (async () => new Response("{not json", { status: 200 })) as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(true);
    expect(result.reason).toContain("unreadable JSON");
    expect(result.reason).toContain("neo");
  });

  test("well-formed JSON with no status field → refuses, reason says the field is missing", async () => {
    globalThis.fetch = (async () => Response.json({ oracle: "neo" })) as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(true);
    expect(result.reason).toContain("no status field");
  });

  // Negative control: fail-closed must refuse only what it CANNOT see. If it
  // refused an oracle the store answers for, the tests above would pass for the
  // wrong reason — a guard that always says busy is not a guard.
  test("status source answers 'ready' → allowed even under failClosed, and no reason", async () => {
    globalThis.fetch = (async () => Response.json({ status: "ready" })) as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(false);
    expect(result.status).toBe("ready");
    expect(result.reason).toBeUndefined();
  });

  test("local store knows the oracle → answered from the store, failClosed changes nothing", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    agentStatusStore.report("neo", "idle");
    const result = await checkBusyGuard("neo", { failClosed: true });
    expect(result.busy).toBe(false);
    expect(result.status).toBe("idle");
  });

  // The other half of the split: `maw hey` reads this same guard, and the status
  // source answers for nobody today. Flipping the DEFAULT would queue every
  // message fleet-wide, so the default stays open — but it now carries the
  // reason, so the blind spot is visible to whoever wants to look.
  test("default (hey/attach) posture is unchanged: unknown → not busy, but the reason is populated", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const result = await checkBusyGuard("neo");
    expect(result.busy).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("404");
  });

  test("failClosed:false is explicit opt-out and behaves like the default", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const result = await checkBusyGuard("neo", { failClosed: false });
    expect(result.busy).toBe(false);
  });
});
