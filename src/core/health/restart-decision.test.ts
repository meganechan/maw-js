import { describe, expect, it } from "bun:test";
import { shouldRestart } from "./restart-decision";
import type { ProbeResult } from "./probe";

const ok: ProbeResult = { status: "ok", elapsedMs: 10 };
const slow: ProbeResult = { status: "slow", elapsedMs: 3000 };
const dead: ProbeResult = { status: "dead", elapsedMs: 8000 };
const err: ProbeResult = { status: "probe-error", reason: "test fixture" };

describe("kobo-458 shouldRestart — restart only on N consecutive dead, never on a single blip", () => {
  it("all healthy history → never restarts (required negative — avoids restart-storm)", () => {
    const decision = shouldRestart([ok, ok, ok, ok, ok]);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toBe("healthy");
  });

  it("N consecutive dead reaches the threshold → restart, reason names the count", () => {
    const decision = shouldRestart([ok, dead, dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(true);
    expect(decision.reason).toContain("3 consecutive dead");
  });

  it("a single dead blip (below threshold) → does not restart", () => {
    const decision = shouldRestart([ok, ok, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("a dead streak that recovers (one blip that self-heals, matching the card's own evidence) → does not restart, even if an EARLIER streak once reached the threshold", () => {
    // 3 dead in a row earlier, then it came back — the streak must reset, not
    // accumulate across a recovery, or a server that healed itself an hour
    // ago would still trigger a restart on the next unrelated blip.
    const decision = shouldRestart([dead, dead, dead, ok, ok, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("a slow response breaks a building dead streak — slow must never count toward restart", () => {
    const decision = shouldRestart([dead, dead, slow, dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false); // only 2 consecutive dead at the tail, slow reset it
  });

  it("a probe-error streak alone does NOT restart, but is flagged distinctly — not read as healthy", () => {
    const decision = shouldRestart([ok, err, err, err]);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toContain("WATCHER ERROR");
    expect(decision.reason).not.toBe("healthy");
  });

  it("a probe-error breaks a building dead streak too, same as slow", () => {
    const decision = shouldRestart([dead, dead, err, dead, dead], { consecutiveDeadThreshold: 3 });
    expect(decision.restart).toBe(false);
  });

  it("empty history → healthy (nothing observed yet is not evidence of trouble)", () => {
    const decision = shouldRestart([]);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toBe("healthy");
  });
});
