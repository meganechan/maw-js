/**
 * kobo-633 Slice 5 — `handlePrWatchLivenessRequest`. Scope: only the new
 * route added this card. `prWatchLiveness()` itself is already exhaustively
 * covered by `pr-watch-liveness.test.ts`/`pr-watch-backfill.test.ts`; this
 * file's job is the route's OWN logic — sinceIso resolution (default vs
 * explicit `?since=`) and the Response shape — not re-proving the acceptance
 * verdict machinery.
 *
 * Uses `MAW_HOME` (env-var resolution), not the `__set*ForTest` override
 * seams — this is the SAME path real production code takes (route.ts has no
 * override seams of its own), matching how `daemon-process-kill.test.ts`
 * exercises the real thing rather than an injected shortcut.
 *
 * Empty task store ⇒ `computeAcceptance` finds zero repos to check ⇒ no real
 * `gh` subprocess call happens at all — hermetic without stubbing `gh`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ORIG_HOME = process.env.MAW_HOME;
let root: string;
const REAL_MAW_DIR = join(homedir(), ".maw");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-route-"));
  if (root.startsWith(REAL_MAW_DIR)) throw new Error(`test root resolved UNDER the real ~/.maw: ${root}`);
  process.env.MAW_HOME = root;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = ORIG_HOME;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("handlePrWatchLivenessRequest (kobo-633 Slice 5)", () => {
  it("omitting ?since= defaults to a rolling DEFAULT_ACCEPTANCE_LOOKBACK_MS window, not a silent/undated one", async () => {
    const { handlePrWatchLivenessRequest } = await import("./route.ts?prwatch-route-default-since");
    const before = Date.now();
    const res = await handlePrWatchLivenessRequest(new Request("http://localhost/api/pr-watch/liveness"));
    const after = Date.now();
    expect(res.status).toBe(200);
    const body = await res.json();
    const sinceMs = new Date(body.acceptance.sinceIso).getTime();
    // within [before - 24h, after - 24h] — proves it's a REAL rolling window
    // computed at request time, not a hardcoded/stale string.
    expect(sinceMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 1000);
  });

  it("explicit ?since= is honored verbatim, not overridden by the default", async () => {
    const { handlePrWatchLivenessRequest } = await import("./route.ts?prwatch-route-explicit-since");
    const explicit = "2020-01-01T00:00:00.000Z";
    const res = await handlePrWatchLivenessRequest(
      new Request("http://localhost/api/pr-watch/liveness?since=" + encodeURIComponent(explicit)),
    );
    const body = await res.json();
    expect(body.acceptance.sinceIso).toBe(explicit);
  });

  it("response shape carries both acceptance and diagnostics (Tier 1 + Tier 2), never just one", async () => {
    const { handlePrWatchLivenessRequest } = await import("./route.ts?prwatch-route-shape");
    const res = await handlePrWatchLivenessRequest(new Request("http://localhost/api/pr-watch/liveness"));
    const body = await res.json();
    expect(typeof body.acceptance.verdict).toBe("string");
    expect(typeof body.diagnostics.heartbeatStatus).toBe("string");
    // empty task store, nothing ever polled — the two verdicts a fresh
    // environment must produce, pinned so a future regression here is loud.
    expect(body.acceptance.verdict).toBe("n/a");
    expect(body.diagnostics.heartbeatStatus).toBe("missing");
  });
});
