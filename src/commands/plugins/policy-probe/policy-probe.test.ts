/**
 * maw policy-probe printer tests (kobo-853) — the exit-code contract is the part
 * scripts depend on, so it gets asserted directly: 0 reached · 1 never arrived
 * (stage names which hook exit) · 2 arrived but the brain clone is behind.
 */
import { describe, it, expect } from "bun:test";
import { formatProbe, toResult } from "./index";
import type { PolicyProbeResult } from "../../../core/policy/probe";

const base: PolicyProbeResult = {
  ok: true, stage: null, reason: "inject reached this pane (28 brain INDEX entries)", fix: null,
  oracle: "eq3", company: "kobo", dept: "core", entries: 28,
  brain: { state: "fresh", upstream: "origin/main" }, brainPath: "/x/kobo-brain",
};

describe("policy-probe exit codes", () => {
  it("reached + fresh → ok, no exit code (0)", () => {
    expect(toResult(base)).toMatchObject({ ok: true });
  });

  it("never arrived → exit 1", () => {
    const r = toResult({ ...base, ok: false, stage: "server", brain: null });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("arrived but clone behind → exit 2, NOT 1 (a stale brain is a different failure from a missing one)", () => {
    const r = toResult({ ...base, ok: false, brain: { state: "behind", behind: 44, upstream: "origin/main" } });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
  });

  it("arrived with no brain section → exit 3, distinct from both 1 and 2", () => {
    const r = toResult({ ...base, ok: false, stage: "brain", entries: 0, brain: null });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });
});

describe("policy-probe output", () => {
  it("failure names the stage and the fix", () => {
    const out = formatProbe({ ...base, ok: false, stage: "jq", fix: "brew install jq", reason: "jq is not on PATH" });
    expect(out).toContain("stage: jq");
    expect(out).toContain("brew install jq");
  });

  it("behind clone prints the commit count, not just 'stale'", () => {
    const out = formatProbe({ ...base, ok: false, brain: { state: "behind", behind: 44, upstream: "origin/main" } });
    expect(out).toContain("44 commits BEHIND origin/main");
  });

  it("no brain section does NOT print as OK, and does not claim the inject never arrived", () => {
    const out = formatProbe({ ...base, ok: false, stage: "brain", entries: 0, brain: null, reason: "carried NO brain INDEX section for 'kobo'" });
    expect(out).toContain("carried NO brain INDEX");
    expect(out).not.toContain("policy inject OK");
    expect(out).not.toContain("did NOT reach");
  });

  it("unmeasurable freshness never renders as up to date", () => {
    const out = formatProbe({ ...base, brain: { state: "unknown", reason: "git fetch failed (offline)" } });
    expect(out).toContain("NOT measured");
    expect(out).not.toContain("up to date");
  });
});
