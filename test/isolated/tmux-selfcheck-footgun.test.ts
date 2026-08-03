/**
 * Class guard: no bare target-sensitive tmux queries in src/ (tmux-selfcheck-footgun).
 *
 * THE TRAP: `tmux display-message -p '#{pane_id}'` does not answer "which pane am
 * I". With no `-t`, tmux resolves the target by walking $TMUX → that SESSION →
 * the session's CURRENT WINDOW → that window's ACTIVE PANE. Every step after the
 * first is about the session's state, not the caller's. A process asks "who am
 * I?" and is confidently told its neighbour's identity. There is no error, no
 * empty string, nothing to notice: the wrong answer has the shape of the right one.
 *
 * No human and no attached client is required — that framing was wrong in the
 * first version of this file. A detached session answers just the same. What
 * decides it is whether the caller IS the active pane of its session's current
 * window; every other pane gets someone else's answer. A cell v2 head and worker
 * sharing one window is exactly this shape, and so is any agent running in a
 * window that is not the session's current one.
 *
 * SCOPE — this guard flags a call when BOTH hold:
 *   1. the format string names a PANE- or WINDOW-scoped field (`#{pane_*}`,
 *      `#{window_*}`, `#W`, `#D`, `#P`), and
 *   2. the call passes no `-t`.
 * Session-scoped reads (`#S`, `#{session_name}`, `#{client_*}`) are deliberately
 * NOT flagged, and the reason is the FIRST step of that walk, not anything about
 * clients: the session comes from the caller's own $TMUX, so a bare `#S` names the
 * caller's own session. The lie enters only at the window/pane steps. Flagging
 * these too would drown the signal — a guard nobody can keep green gets deleted,
 * and this one has to outlive the sweep that created it.
 *
 * `list-panes` with neither `-t` nor `-a` is flagged for the same reason: it
 * enumerates the session's CURRENT WINDOW. Two `close` verbs were killing (and
 * hiding) the panes of a window their caller need not have been in.
 *
 * WHY A SOURCE GREP: this failure cannot be caught by a unit test of the call
 * site — a mocked tmux answers whatever the mock says, so a bare call passes its
 * own test forever. The bug lives in the argument list, so the argument list is
 * what gets checked.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../src");

/**
 * Bare calls that are CORRECT and must not fail this guard. One entry per line as
 * `file:line-fragment`, each with a comment saying why bare is right there.
 *
 * Empty on purpose: after the tmux-selfcheck-footgun sweep, no bare pane- or
 * window-scoped query survives in src/. An entry here is a claim that a call
 * genuinely wants "whichever pane the session has active" — real for interactive
 * verbs, so the list exists; it is just not needed yet.
 */
const ALLOWLIST: { file: string; fragment: string; why: string }[] = [
  {
    file: "vendor/mpr-plugins/panes/impl.ts",
    fragment: "list-panes ${targetFlag}",
    why:
      "The flag is computed six lines above and is ALWAYS one of `-a`, `-s -t '<filter>'`, " +
      "or `-t '$TMUX_PANE'`; the no-target case throws before reaching here. A source grep " +
      "cannot see through the variable — read the ternary, not this line.",
  },
];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Comments are prose ABOUT the trap — several of the fixes explain the bare form
 * they replaced. Stripping them first is not tidiness: a guard that trips on its
 * own explanation teaches people to delete the explanation.
 */
function stripComments(src: string): string {
  // A `/*` only opens a comment when nothing but whitespace precedes it ON ITS
  // LINE. Without that anchor, shell globs inside string literals opened ghost
  // comments that ran to the next `*/` — `-path '*/agents/*'` in done.ts:159 ends
  // in `/*` and blinded the guard to 45% of that file, including a line THIS PR
  // fixed (done.ts:283). A blind guard is worse than no guard: it reports green.
  // ponytail: no tokenizer. The anchor costs one regex and the residual (a block
  // comment opened mid-line after code) can only cause a false POSITIVE, which is
  // noisy, not silent.
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PANE_SCOPED = /#\{(pane_|window_)|#[WDP](?![a-zA-Z])/;

/** One tmux invocation, however it is spelled: a template string, a quoted
 *  hostExec line, or `.run("display-message", "-p", …)` argument lists. */
/**
 * Is this occurrence an INVOCATION, or the verb's name inside a message? Error
 * strings ("list-panes failed for …") are not calls, and flagging them trains
 * people to stop naming the command in their error messages.
 */
function isInvocation(src: string, at: number): boolean {
  const before = src.slice(Math.max(0, at - 8), at);
  return /(tmux|\}|\/)\s$/.test(before) || /["'`]$/.test(before) && /["']/.test(src[at - 1] ?? "");
}

function callsOf(src: string, verb: string): string[] {
  const out: string[] = [];
  let i = src.indexOf(verb);
  while (i !== -1) {
    if (!isInvocation(src, i)) { i = src.indexOf(verb, i + 1); continue; }
    // From the verb to the end of ITS statement. A fixed-size window instead
    // swept up the next line's format string and blamed a `#S` read for a
    // `#{window_name}` two lines below — every flag and format that belongs to
    // this call is between the verb and the `;`, in all three spellings used here.
    const rest = src.slice(i);
    const end = rest.search(/;|\n\s*\n/);
    out.push(end === -1 ? rest.slice(0, 300) : rest.slice(0, end));
    i = src.indexOf(verb, i + 1);
  }
  return out;
}

const hasTarget = (call: string) => /["'\s]-t["'\s]|["']-t["']|-t\s+["'$]/.test(call);

interface Offence { file: string; call: string }

function scan(): { displayMessage: Offence[]; listPanes: Offence[] } {
  const displayMessage: Offence[] = [];
  const listPanes: Offence[] = [];

  for (const file of tsFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel.includes("pre-1813-fix.snapshot")) continue; // frozen historical copy, never executed
    const src = stripComments(readFileSync(file, "utf8"));

    for (const call of callsOf(src, "display-message")) {
      if (!PANE_SCOPED.test(call) || hasTarget(call)) continue;
      if (ALLOWLIST.some((a) => rel.endsWith(a.file) && call.includes(a.fragment))) continue;
      displayMessage.push({ file: rel, call: call.trim() });
    }

    for (const call of callsOf(src, "list-panes")) {
      if (hasTarget(call) || /["'\s]-a["'\s]/.test(call)) continue;
      if (ALLOWLIST.some((a) => rel.endsWith(a.file) && call.includes(a.fragment))) continue;
      listPanes.push({ file: rel, call: call.trim() });
    }
  }
  return { displayMessage, listPanes };
}

const POINTER =
  "card tmux-selfcheck-footgun: a bare tmux query resolves $TMUX -> session -> its CURRENT WINDOW -> " +
  "that window's ACTIVE PANE. That is the caller only when the caller happens to be the active pane; " +
  "otherwise it is a neighbour, attached client or not. Pass -t $TMUX_PANE (or the pane id already in scope). If TMUX_PANE is unset in " +
  "that path, refuse or return null — never fall through to a bare call. If the call genuinely wants " +
  "the active pane, add it to ALLOWLIST in this file with the reason.";

describe("no bare target-sensitive tmux queries in src/ (tmux-selfcheck-footgun)", () => {
  test("display-message with a pane/window-scoped format always passes -t", () => {
    const { displayMessage } = scan();
    const report = displayMessage.map((o) => `\n  ${o.file}\n    ${o.call.replace(/\s+/g, " ").slice(0, 160)}`).join("");
    expect(displayMessage.length === 0 ? "" : `${report}\n\n${POINTER}`).toBe("");
  });

  test("list-panes is scoped by -t or explicitly server-wide with -a", () => {
    const { listPanes } = scan();
    const report = listPanes.map((o) => `\n  ${o.file}\n    ${o.call.replace(/\s+/g, " ").slice(0, 160)}`).join("");
    expect(listPanes.length === 0 ? "" : `${report}\n\n${POINTER}`).toBe("");
  });

  test("the guard actually detects a bare call (negative control)", () => {
    // If this ever passes vacuously — a broken walker, a regex that matches
    // nothing — the two tests above would be green on a tree full of the bug.
    const bare = `const id = await hostExec("tmux display-message -p '#{pane_id}'");`;
    const targeted = `const id = await hostExec(\`tmux display-message -p -t '\${self}' '#{pane_id}'\`);`;
    const sessionScoped = `const s = await hostExec("tmux display-message -p '#{session_name}'");`;

    expect(PANE_SCOPED.test(bare) && !hasTarget(bare)).toBe(true);
    expect(hasTarget(targeted)).toBe(true);
    expect(PANE_SCOPED.test(sessionScoped)).toBe(false);
  });

  test("comments explaining the trap do not trip it", () => {
    const commented = `// bare display-message -p '#{pane_id}' was the bug\nconst x = 1;`;
    const stripped = stripComments(commented);
    expect(PANE_SCOPED.test(stripped)).toBe(false);
  });
});
