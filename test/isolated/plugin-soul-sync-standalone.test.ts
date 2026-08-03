/**
 * soul-sync plugin standalone boundary (#2316 gate) + the pane-identity
 * discipline (tmux-selfcheck-footgun).
 *
 * soul-sync decides WHICH ORACLE it is syncing from the cwd it detects. Bare, that
 * detection resolves $TMUX → session → the session's CURRENT WINDOW → that
 * window's ACTIVE PANE, so a sync run from a non-active pane could read a
 * neighbour's repo as its own source.
 *
 * NOTE: this same file is vendored into archive/, bud/ and done/ as
 * `internal/soul-sync-impl.ts`. The `-t` fix had to land in all four copies; the
 * assertion below is repeated in their boundary tests for the same reason.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const implSrc = () => readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/soul-sync/impl.ts"), "utf8");

describe("soul-sync plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "soul-sync",
      // PRE-EXISTING, pinned rather than endorsed: ghq root/lookup are still
      // reached directly instead of through the SDK barrel. Recorded so the next
      // extraction pass can see exactly what is left, not so it stays.
      allowMawJs: [/^maw-js\/config\/ghq-root$/, /^maw-js\/core\/ghq$/, /^maw-js\/commands\/shared\/fleet-load$/],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("cwd detection is anchored to the caller's own pane in BOTH entry points", () => {
    const src = implSrc();
    // cmdSoulSync and cmdSoulSyncProject each resolve a cwd; both were bare.
    const targeted = src.match(/display-message -p -t '\$\{self\}' '#\{pane_current_path\}'/g) ?? [];
    expect(targeted).toHaveLength(2);
    expect(src).not.toContain("display-message -p '#{pane_current_path}'");
    // Unknown pane falls to process.cwd(), which is the pre-existing fallback —
    // never another pane's path.
    expect(src).toContain('throw new Error("TMUX_PANE unset")');
  });
});
