/**
 * dispatch-engine-menu-label.test.ts — kobo-941: the stall notify must describe
 * what is actually on the target's screen, not invent a permission check.
 *
 * The detector (comm-send `detectOpenMenu`) answers "is a menu open" — a
 * numbered cursor plus an `Esc to cancel` footer. That signature belongs to
 * EVERY Claude Code selection surface: AskUserQuestion, the slash-command
 * picker, the model picker, the file picker. It is deliberately that wide,
 * because the decision it feeds is "may I type into this pane", and the answer
 * is no for all of them. What was wrong was the caller's label: dispatch-engine
 * printed "permission prompt", so senders went looking for a permission dialog
 * that was not there — twice in one hour on 2026-08-14 (lek: a numbered option
 * menu; thawanban: an AskUserQuestion box).
 *
 * So this test does NOT stub `detectMenu`. Stubbing it would assert the label
 * for a boolean the test itself chose; the whole failure was that a real
 * non-permission screen produced the permission wording. It feeds a pane
 * snapshot shaped like a real AskUserQuestion box through the REAL detector,
 * into the REAL engine, and reads the message the SENDER receives.
 *
 * Both entry points into notifyStuck are covered: the periodic sweep
 * (runSweepOnce → checkStall) and the immediate busy→ready path (tryDeliver's
 * failed-delivery branch → checkStall). They share the one label expression, so
 * the point of covering both is to show that they do — not to test two labels.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { join } from "path";

let feedEvents: any[] = [];

mock.module(join(import.meta.dir, "../../src/api/feed"), () => ({
  pushFeedEvent: (e: any) => { feedEvents.push(e); },
}));

const { DispatchEngine } = await import("../../src/core/dispatch-engine");
const { messageQueue } = await import("../../src/core/message-queue");
const { agentStatusStore } = await import("../../src/core/agent-status");
const { detectOpenMenu, isSafeToInject } = await import("../../src/commands/shared/comm-send");

const TARGET = "sess:neo.0";
const SENDER = "sess:sender.0";

/**
 * An AskUserQuestion box — a question with numbered choices and the same modal
 * chrome a permission prompt has. NOT a permission prompt: nothing here asks to
 * run a tool or grants an allowance, it asks a human to pick an option.
 *
 * Provenance: hand-composed to the shape both kobo-941 incidents reported (the
 * AskUserQuestion box thawanban hit on pgw-112, drawn with the ANSI attributes
 * of the real permission-menu capture in test/fixtures/pane-captures). It is a
 * SHAPE, not a byte-exact `tmux capture-pane -e` — the fixtures directory holds
 * only authentic captures and this one would not qualify. What it has to carry
 * is the detector's two signals plus the absence of any permission language,
 * and both are visible in the literal below.
 */
const ASK_USER_QUESTION_PANE = [
  "\x1b[38;5;246m│\x1b[39m",
  "\x1b[38;5;246m│\x1b[39m \x1b[1mจะปิด pgw-112 ทางไหน\x1b[0m",
  "\x1b[38;5;246m│\x1b[39m",
  "\x1b[38;5;246m│\x1b[39m \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.\x1b[39m \x1b[38;5;153mปิดเลย\x1b[39m",
  "\x1b[38;5;246m│\x1b[39m   \x1b[38;5;246m2.\x1b[39m รอ nai ยืนยันก่อน",
  "\x1b[38;5;246m│\x1b[39m   \x1b[38;5;246m3.\x1b[39m แตกใบใหม่",
  "\x1b[38;5;246m│\x1b[39m   \x1b[38;5;246m4.\x1b[39m Chat about this",
  "\x1b[38;5;246m│\x1b[39m",
  "\x1b[38;5;246mEnter\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mselect\x1b[39m \x1b[38;5;246m·\x1b[39m \x1b[38;5;246m↑/↓\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mnavigate\x1b[39m \x1b[38;5;246m·\x1b[39m \x1b[38;5;246mEsc\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mcancel\x1b[39m",
].join("\n");

/** Wire the engine to the REAL detector, reading the snapshot instead of tmux. */
function makeEngine(pane: string) {
  const sendKeysCalls: Array<{ target: string; text: string }> = [];
  const seam = { captureFn: async () => pane };
  const engine = new DispatchEngine(
    async (target: string, text: string) => { sendKeysCalls.push({ target, text }); },
    {
      // Only the recipient shows the menu; the sender's pane is clean so the
      // warning actually lands and can be read back.
      paneIdle: async (target: string) =>
        target === TARGET ? (await isSafeToInject(target, undefined, seam)).safe : true,
      detectMenu: async (target: string) =>
        target === TARGET ? detectOpenMenu(target, undefined, seam) : false,
      resolveSenderTarget: async () => ({ oracle: "sender", target: SENDER }),
      stallThresholdMs: 180_000, // far away — a menu must notify without waiting it out
    },
  );
  return { engine, sendKeysCalls };
}

const senderWarning = (calls: Array<{ target: string; text: string }>) =>
  calls.find(c => c.target === SENDER)?.text;

beforeEach(() => {
  messageQueue.prune(0, 0);
  feedEvents = [];
});

describe("kobo-941 — an open menu is not a permission prompt", () => {
  test("the detector fires on AskUserQuestion — the snapshot really is a menu to it", async () => {
    // If this ever goes false the two assertions below become vacuous: they
    // would be checking the wording of the plain-stall branch instead.
    expect(await detectOpenMenu(TARGET, undefined, { captureFn: async () => ASK_USER_QUESTION_PANE })).toBe(true);
    expect(ASK_USER_QUESTION_PANE.toLowerCase()).not.toContain("permission");
  });

  test("sweep path: the sender's warning names the menu and never says permission", async () => {
    messageQueue.enqueue({ from: "node:sender", to: "neo", target: TARGET, message: "m1" });
    const { engine, sendKeysCalls } = makeEngine(ASK_USER_QUESTION_PANE);

    await engine.runSweepOnce();

    const warning = senderWarning(sendKeysCalls);
    expect(warning).toBeDefined();
    expect(warning!.toLowerCase()).not.toContain("permission");
    expect(warning).toContain("menu");
    // Never overtyped the open menu.
    expect(sendKeysCalls.find(c => c.target === TARGET)).toBeUndefined();
  });

  test("busy→ready path reaches the same label — not only the sweep", async () => {
    messageQueue.enqueue({ from: "node:sender", to: "neo", target: TARGET, message: "m1" });
    const { engine, sendKeysCalls } = makeEngine(ASK_USER_QUESTION_PANE);
    engine.start();
    try {
      // tryDeliver fires on the transition, cannot deliver into the menu, and
      // falls through to checkStall — the second entry into notifyStuck.
      agentStatusStore.report("neo", "busy");
      agentStatusStore.report("neo", "ready");
      // The listener is sync-fired but tryDeliver is async; let it settle.
      for (let i = 0; i < 50 && !senderWarning(sendKeysCalls); i++) await Bun.sleep(10);
    } finally {
      engine.stop();
      agentStatusStore.remove("neo"); // drops the store's 120s idle-TTL timer
    }

    const warning = senderWarning(sendKeysCalls);
    expect(warning).toBeDefined();
    expect(warning!.toLowerCase()).not.toContain("permission");
    expect(sendKeysCalls.find(c => c.target === TARGET)).toBeUndefined();
  });

  test("the feed Notification carries the same truthful reason", async () => {
    messageQueue.enqueue({ from: "node:sender", to: "neo", target: TARGET, message: "m1" });
    const { engine } = makeEngine(ASK_USER_QUESTION_PANE);

    await engine.runSweepOnce();

    const stall = feedEvents.find(e => e?.data?.kind === "dispatch-stall");
    expect(stall).toBeDefined();
    expect(String(stall.message).toLowerCase()).not.toContain("permission");
    expect(String(stall.data.reason).toLowerCase()).not.toContain("permission");
  });
});
