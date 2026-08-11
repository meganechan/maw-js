import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPaneAway } from "../src/core/worklog/presence-away";
import { appendWorklog, flushWorklog, readWorklog } from "../src/core/worklog/store";
import presenceHandler from "../src/commands/plugins/presence/index";

// mawjs-3 / kobo-120 — away is derived from the worklog (newest-wins per pane), no new store.
describe("isPaneAway (presence gate read side)", () => {
  // The default suite shares one bun process, so this MAW_DATA_DIR outlives the
  // file unless it is put back — it used to reach test/preflight-default.test.ts,
  // whose "default path" case asserts pluginDir() lands under ~/.maw/plugins and
  // instead saw this away-test-XXXX sandbox. Same save/restore shape as
  // test/review-desk.test.ts, which documents the identical hazard.
  const originalDataDir = process.env.MAW_DATA_DIR;
  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.MAW_DATA_DIR;
    else process.env.MAW_DATA_DIR = originalDataDir;
  });

  beforeEach(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "away-test-"));
  });

  const away = (oracle: string, ts: number, paneId?: string) =>
    appendWorklog({ ts, iso: "i", oracle, kind: "away", summary: "away", ...(paneId ? { paneId } : {}) });
  const activity = (oracle: string, ts: number, kind: any = "tool", paneId?: string) =>
    appendWorklog({ ts, iso: "i", oracle, kind, summary: "x", ...(paneId ? { paneId } : {}) });

  it("no events → not away", () => {
    expect(isPaneAway("zzghost", undefined)).toBe(false);
  });

  it("newest event is away → away (oracle-level, no paneId)", async () => {
    activity("zzaway", 1);
    away("zzaway", 2);
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
  });

  it("STICKY — activity (conversation) after away does NOT clear it (kobo-287)", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "conversation"); // background write, e.g. /toilet's own rrr
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true); // was false pre-kobo-287
  });

  it("STICKY repro — tool-write mid-wrap after away still parks (kobo-287 run3)", async () => {
    // /toilet: away at step-0, then its own rrr/forward tool-writes; a peer heys after.
    away("zzaway", 1);
    activity("zzaway", 2, "tool"); // wrap tool-write ~5s in
    activity("zzaway", 3, "tool");
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true); // hey PARKS, no inject
  });

  it("STICKY — idle (CC Stop) after away does NOT clear it (kobo-120)", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "idle"); // transparent turn-end
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
  });

  it("STICKY — error turn-end after away does NOT clear it", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "error");
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
  });

  it("`maw presence back` (kind:back) clears away", async () => {
    away("zzaway", 1);
    activity("zzaway", 2, "back"); // deliberate return
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(false);
  });

  it("PER-PANE — coord pane away + worker pane active (same oracle)", async () => {
    away("zzcrew", 1, "%52"); // coord stepped out
    activity("zzcrew", 2, "tool", "%53"); // worker still working
    await flushWorklog();
    expect(isPaneAway("zzcrew", "%52")).toBe(true); // hey→coord pane parks
    expect(isPaneAway("zzcrew", "%53")).toBe(false); // hey→worker pane injects
  });

  it("PER-PANE — worker idle does not clear coord's away", async () => {
    away("zzcrew", 1, "%52");
    activity("zzcrew", 2, "idle", "%53"); // worker's turn ended
    activity("zzcrew", 3, "idle", "%52"); // coord pane also idled (still away)
    await flushWorklog();
    expect(isPaneAway("zzcrew", "%52")).toBe(true);
  });

  it("scoped per oracle — one oracle away does not mark another", async () => {
    away("zzaway", 5);
    activity("zzother", 6);
    await flushWorklog();
    expect(isPaneAway("zzaway", undefined)).toBe(true);
    expect(isPaneAway("zzother", undefined)).toBe(false);
  });

  it("empty / whitespace oracle → not away (no crash)", () => {
    expect(isPaneAway("", undefined)).toBe(false);
    expect(isPaneAway(null, undefined)).toBe(false);
  });
});

// kobo-868 — the WRITE side that produced the sticky-forever poison: `maw presence
// away/back` writing a paneId-less event when TMUX_PANE is unset. Fix is a refusal at
// the writer, not the reader above (presence-away.ts is out of scope for this card).
describe("presence away/back writer guard (kobo-868)", () => {
  const originalDataDir = process.env.MAW_DATA_DIR;
  const originalTmuxPane = process.env.TMUX_PANE;
  const originalAgentName = process.env.CLAUDE_AGENT_NAME;
  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.MAW_DATA_DIR;
    else process.env.MAW_DATA_DIR = originalDataDir;
    if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalTmuxPane;
    if (originalAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
    else process.env.CLAUDE_AGENT_NAME = originalAgentName;
  });

  beforeEach(() => {
    process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "presence-writer-test-"));
    process.env.CLAUDE_AGENT_NAME = "zzwriter";
    delete process.env.TMUX_PANE;
  });

  const rowCount = () => readWorklog(null, { oracle: "zzwriter" }).length;

  it("no TMUX_PANE → 'away' refuses: ok:false, zero rows written (AC1)", async () => {
    const before = rowCount();
    const result = await presenceHandler({ source: "cli", args: ["away"] });
    expect(result.ok).toBe(false);
    expect(rowCount()).toBe(before);
  });

  it("no TMUX_PANE → 'back' refuses too, same rule (AC2)", async () => {
    const before = rowCount();
    const result = await presenceHandler({ source: "cli", args: ["back"] });
    expect(result.ok).toBe(false);
    expect(rowCount()).toBe(before);
  });

  it("TMUX_PANE set → 'away' still writes normally with paneId (AC3, negative control)", async () => {
    process.env.TMUX_PANE = "%999";
    const before = rowCount();
    const result = await presenceHandler({ source: "cli", args: ["away"] });
    expect(result.ok).toBe(true);
    const events = readWorklog(null, { oracle: "zzwriter" });
    expect(events.length).toBe(before + 1);
    expect(events[events.length - 1]?.paneId).toBe("%999");
  });

  it("TMUX_PANE set → 'back' still writes normally with paneId (AC3, negative control)", async () => {
    process.env.TMUX_PANE = "%999";
    const before = rowCount();
    const result = await presenceHandler({ source: "cli", args: ["back"] });
    expect(result.ok).toBe(true);
    const events = readWorklog(null, { oracle: "zzwriter" });
    expect(events.length).toBe(before + 1);
    expect(events[events.length - 1]?.paneId).toBe("%999");
  });
});
