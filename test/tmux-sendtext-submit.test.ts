/**
 * tmux-sendtext-submit.test.ts — regression for maw-stress finding #6.
 *
 * Tmux.sendText used to fire 3 blind `Enter` keys on a fixed ~1.9s schedule
 * with zero feedback. When the pane wasn't ready as they landed, every Enter
 * missed and the command sat in the input box unexecuted — this forced
 * brain to manually re-launch dispatches on 2026-05-14.
 *
 * The fix: send Enter, re-inspect the pane, retry only while the input line
 * still holds un-submitted content (capped at MAX_SUBMIT_ATTEMPTS).
 *
 * Strategy: subclass Tmux and override the low-level primitives so we can
 * script the pane's capture output and assert the exact key sequence — no
 * tmux process, no module mock (safe for the main suite).
 */
import { describe, test, expect } from "bun:test";
import { Tmux } from "../src/core/transport/tmux-class";

/** Tmux with the tmux-touching primitives stubbed + a scripted capture feed. */
class FakeTmux extends Tmux {
  calls: string[] = [];
  /** Successive return values for capture(); last value repeats once exhausted. */
  captureScript: string[] = [];
  private captureIdx = 0;

  constructor() {
    super(undefined, ""); // no socket — overridden methods never hit hostExec
  }

  async capture(_target: string, _lines = 80): Promise<string> {
    this.calls.push("capture");
    const v = this.captureScript[this.captureIdx] ?? this.captureScript.at(-1) ?? "";
    this.captureIdx++;
    return v;
  }
  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }
  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }
  async loadBuffer(text: string): Promise<void> {
    this.calls.push(`loadBuffer:${text.length}`);
  }
  async pasteBuffer(_target: string): Promise<void> {
    this.calls.push("pasteBuffer");
  }
  async exitModeIfNeeded(_target: string): Promise<boolean> {
    return false;
  }

  // kobo-483 (fail-closed): 14 sibling `extends Tmux` test files already
  // override `run()` — the one bottleneck every Tmux method funnels through
  // before reaching hostExec (tmux-class.ts) — which makes them safe by
  // STRUCTURE. This file was the one exception: it only overrode individual
  // primitives, and was safe today only by LUCK of the call graph — sendText
  // calls submitWithConfirm + paneInputPending (neither overridden here),
  // which happen to bottom out at `capture` (which IS overridden). The day
  // someone adds a line to submitWithConfirm that calls some other primitive,
  // that call falls through to the REAL base-class method — straight to
  // `run()` → hostExec → a live shell command, silently. Patching individual
  // primitives here would only extend that luck, not end it; overriding
  // `run()` itself turns the safety into structure, matching the other 14
  // files, and turns any future gap into an immediate throw instead of a
  // silent real tmux call. This file exercises sendText — the exact
  // keystroke-injection mechanism kobo-477 froze the whole fleet's test
  // suite over — so if any file needed this to be structural rather than
  // lucky, it was this one.
  async run(subcommand: string, ..._args: (string | number)[]): Promise<string> {
    throw new Error(
      `[kobo-483 fail-closed] Tmux.run("${subcommand}") reached the base-class ` +
      `bottleneck — FakeTmux didn't stub a primitive that the real implementation ` +
      `called. Stub the missing primitive; don't let it fall through to hostExec.`,
    );
  }
}

const PROMPT_IDLE = "agent@host:~$ "; // prompt marker + trailing space → submitted
const PROMPT_PENDING = "agent@host:~$ unsent command text"; // input still on the line
const enterCount = (calls: string[]) => calls.filter(c => c === "sendKeys:Enter").length;

describe("Tmux.sendText — confirmed submit (#6)", () => {
  test(
    "single Enter when the pane clears on the first check — no blind trailing Enters",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [PROMPT_IDLE];
      await t.sendText("sess:win", "hello");

      expect(t.calls).toEqual(["sendKeysLiteral:hello", "sendKeys:Enter", "capture"]);
      expect(enterCount(t.calls)).toBe(1);
    },
    10_000,
  );

  test(
    "retries Enter while input is still pending, stops as soon as it clears",
    async () => {
      const t = new FakeTmux();
      // pending after Enter #1 and #2, cleared after #3
      t.captureScript = [PROMPT_PENDING, PROMPT_PENDING, PROMPT_IDLE];
      await t.sendText("sess:win", "deploy task");

      expect(enterCount(t.calls)).toBe(3);
      // last action is the confirming capture, not another blind Enter
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );


  test(
    "recognizes Codex U+203A prompts as pending via prompt fallback",
    async () => {
      const t = new FakeTmux();
      t.captureScript = ["› [m5:mawjs] codex-1: unrelated pending input", "› "];
      await t.sendText("sess:codex", "hello");

      expect(enterCount(t.calls)).toBe(2);
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );

  test(
    "detects pending input from the sent text without known prompt markers",
    async () => {
      const t = new FakeTmux();
      t.captureScript = ["ENGINE_PROMPT please handle this", "ENGINE_PROMPT "];
      await t.sendText("sess:any-engine", "please handle this");

      expect(enterCount(t.calls)).toBe(2);
      expect(t.calls.at(-1)).toBe("capture");
    },
    15_000,
  );

  test(
    "stops after MAX_SUBMIT_ATTEMPTS and warns when the pane never clears",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [PROMPT_PENDING]; // repeats → never clears

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      try {
        await t.sendText("sess:win", "stuck task");
      } finally {
        console.warn = origWarn;
      }

      // capped — not an unbounded spin
      expect(enterCount(t.calls)).toBe(4);
      expect(warnings.some(w => w.includes("pending input") && w.includes("sess:win"))).toBe(true);
    },
    15_000,
  );

  // --- kobo-998: status chrome is not unsent input ---
  //
  // Every string below is a VERBATIM `tmux capture-pane` line from a live pane
  // on this machine, taken read-only on 2026-08-20. Invented fixtures were the
  // hole here: the bug is in what the real TUIs actually draw.
  //
  // The pair is the point. CHROME_AGENT_ROW and CLAUDE_INPUT_BOX come from the
  // same TUI and open with the same `❯` marker — the discrimination has to be
  // what FOLLOWS it, so a fix that just returns false everywhere fails the
  // second half. `sentText` never appears in any of these lines, so the
  // sent-text needle check above the fallback cannot decide any of them; the
  // fallback regex is what is under test.

  /** 24-nai:1.0 — Claude Code background-agent row. `❯` is the list cursor. */
  const CHROME_AGENT_ROW =
    "❯ ◯ pgw104-worker  Execute kobo card **pgw-104** (company pgw, board ...                                                                               idle";
  /** 376:0.0 — Codex footer. The `%` is a percentage, not a shell prompt. */
  const CHROME_CODEX_FOOTER =
    "  gpt-5.6-sol xhigh fast · ~ · gpt-5.6-sol · Ready · weekly 57% left · 258K window · 64.3K used · Main [default]";
  /** 22-pm1:0.0 — text sitting UNSENT in the Claude Code input box. */
  const CLAUDE_INPUT_BOX = "❯ เปิด card ให้ patchwork เลย";
  /** 22-pm1:0.0 — a `maw hey` broadcast on the prompt row: load-buffer + paste-buffer, i.e. bracketed paste. */
  const CLAUDE_PASTED_MESSAGE =
    "❯ [broadcast from eq3-oracle] [m5:eq3] อัปเดต INTERIM MERGE RULE (Tony เคาะเพิ่ม):";
  /** 83:0.0 — classic zsh prompt holding command text. */
  const SHELL_PROMPT_TYPED = "tony@Tonys-MacBook-Air ~ % hermes dashboard";

  test.each([
    ["Claude Code background-agent row", CHROME_AGENT_ROW],
    ["Codex footer percentage", CHROME_CODEX_FOOTER],
  ])("kobo-998: %s is not pending input — one Enter, no warning", async (_name, paneLine) => {
    const t = new FakeTmux();
    t.captureScript = [paneLine]; // repeats → if this read as pending it would never clear

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      await t.sendText("sess:agent", "ping");
    } finally {
      console.warn = origWarn;
    }

    expect(enterCount(t.calls)).toBe(1);
    expect(warnings).toEqual([]);
  }, 15_000);

  test.each([
    ["typed into the Claude Code input box", CLAUDE_INPUT_BOX],
    ["bracketed-paste stuck in the input box", CLAUDE_PASTED_MESSAGE],
    ["typed at a classic shell prompt", SHELL_PROMPT_TYPED],
  ])("kobo-998: %s still reads as pending — Enter retried until it clears", async (_name, paneLine) => {
    const t = new FakeTmux();
    t.captureScript = [paneLine, PROMPT_IDLE];
    await t.sendText("sess:pane", "ping");

    expect(enterCount(t.calls)).toBe(2);
    expect(t.calls.at(-1)).toBe("capture");
  }, 15_000);

  test(
    "multiline content routes through loadBuffer + pasteBuffer, then confirmed submit",
    async () => {
      const t = new FakeTmux();
      t.captureScript = [PROMPT_IDLE];
      await t.sendText("sess:win", "line one\nline two");

      expect(t.calls[0]).toBe(`loadBuffer:${"line one\nline two".length}`);
      expect(t.calls[1]).toBe("pasteBuffer");
      expect(t.calls).not.toContain("sendKeysLiteral:line one\nline two");
      expect(enterCount(t.calls)).toBe(1);
    },
    10_000,
  );

  test(
    "a capture failure is treated as submitted — the retry loop cannot spin",
    async () => {
      const t = new FakeTmux();
      // capture throws → paneInputPending swallows → false (assume submitted)
      t.capture = async () => { throw new Error("tmux gone"); };
      await t.sendText("sess:win", "hi");

      expect(enterCount(t.calls)).toBe(1);
    },
    10_000,
  );
});
