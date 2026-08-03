/**
 * whoami plugin standalone boundary (#2316 gate) + the pane-identity discipline
 * this verb exists for (tmux-selfcheck-footgun).
 *
 * whoami answers "which pane am I". It used to ask tmux with no `-t`, which
 * resolves $TMUX → session → the session's CURRENT WINDOW → that window's ACTIVE
 * PANE — so any pane that was not the active one was told its neighbour's
 * address, and then copied that address into other verbs as a target.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const implSrc = () => readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/whoami/impl.ts"), "utf8");

describe("whoami plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "whoami",
      // UserError is the CLI's user-facing error type; a plugin that throws
      // anything else prints a stack trace instead of a message.
      allowMawJs: [/^maw-js\/core\/util\/user-error$/, /^maw-js\/plugin\/types$/],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("identifies ITSELF by $TMUX_PANE, and refuses rather than report a neighbour", () => {
    const src = implSrc();
    // Both reads (--short and the full form) must be targeted: this verb's whole
    // output is an address someone pastes into another command.
    expect(src).toContain("const self = process.env.TMUX_PANE;");
    expect(src).toContain("display-message -p -t '${self}' '#S'");
    expect(src).toContain("display-message -p -t '${self}' '#S\\t#W\\t#{window_id}\\t#{pane_title}\\t#{pane_id}'");
    // No bare fallback anywhere in the file.
    expect(src).not.toMatch(/display-message -p '#/);
    expect(src).toContain("refusing to report another pane's address");
  });
});
