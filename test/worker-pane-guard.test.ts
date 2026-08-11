/**
 * Worker-pane injection guard (D-E, eq3 dispatcher/worker-pane spec 2026-08-08).
 *
 * Rule under test: a target whose `@oracle_pane` role is `worker`/`reviewer`
 * refuses unless the caller carries `MAW_WORKER_PANE_OK=1`. Unknown identity
 * (blank, unparseable, or a tmux lookup that failed) is NOT gated — same
 * "absence != guess" posture as pane-identity.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertPaneInjectAllowed,
  identityOfExactTarget,
  WORKER_PANE_INJECT_ENV,
  WorkerPaneAccessError,
  workerPaneRefusal,
} from "../src/core/worker-pane-guard";

describe("assertPaneInjectAllowed", () => {
  const prevEnv = process.env[WORKER_PANE_INJECT_ENV];
  beforeEach(() => { delete process.env[WORKER_PANE_INJECT_ENV]; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[WORKER_PANE_INJECT_ENV];
    else process.env[WORKER_PANE_INJECT_ENV] = prevEnv;
  });

  test("refuses a worker-pane target with no opt-in env", () => {
    expect(() => assertPaneInjectAllowed("%42", "patchwork:worker")).toThrow(WorkerPaneAccessError);
  });

  test("refuses a reviewer-pane target with no opt-in env", () => {
    expect(() => assertPaneInjectAllowed("%42", "patchwork:reviewer")).toThrow(WorkerPaneAccessError);
  });

  test("allows a worker-pane target when the dispatcher opt-in env is set", () => {
    process.env[WORKER_PANE_INJECT_ENV] = "1";
    expect(() => assertPaneInjectAllowed("%42", "patchwork:worker")).not.toThrow();
  });

  test("a truthy-looking but wrong value does not opt in — must be exactly '1'", () => {
    process.env[WORKER_PANE_INJECT_ENV] = "true";
    expect(() => assertPaneInjectAllowed("%42", "patchwork:worker")).toThrow(WorkerPaneAccessError);
  });

  test("a head-pane target is never gated", () => {
    expect(() => assertPaneInjectAllowed("%42", "patchwork:head")).not.toThrow();
  });

  test("no identity (unstamped pane — most of the fleet) is not gated", () => {
    expect(() => assertPaneInjectAllowed("%42", "")).not.toThrow();
    expect(() => assertPaneInjectAllowed("%42", null)).not.toThrow();
    expect(() => assertPaneInjectAllowed("%42", undefined)).not.toThrow();
  });

  test("unparseable identity (no role half, or garbage) is not gated", () => {
    expect(() => assertPaneInjectAllowed("%42", "patchwork")).not.toThrow();
    expect(() => assertPaneInjectAllowed("%42", "a:b:c")).not.toThrow();
  });

  test("refusal message names the pane, the role, and both alternatives", () => {
    expect(() => assertPaneInjectAllowed("%42", "patchwork:worker")).toThrow(
      /%42 is a worker pane.*maw hey patchwork.*create a card for patchwork/s,
    );
  });

  test("workerPaneRefusal formats exactly the spec'd three lines", () => {
    expect(workerPaneRefusal("%42", "patchwork", "worker")).toBe(
      `%42 is a worker pane — workers take orders from the board\n` +
      `  talk to the oracle:  maw hey patchwork "..."\n` +
      `  give it work:        create a card for patchwork`,
    );
  });
});

describe("identityOfExactTarget", () => {
  test("queries display-message -p -t <target> for the @oracle_pane option", async () => {
    const calls: string[][] = [];
    const run = async (...args: string[]) => { calls.push(args); return "patchwork:worker\n"; };
    const identity = await identityOfExactTarget(run, "%42");
    expect(identity).toBe("patchwork:worker");
    expect(calls).toEqual([["display-message", "-p", "-t", "%42", "#{@oracle_pane}"]]);
  });

  test("a tmux error resolves to null (unknown), never throws", async () => {
    const run = async () => { throw new Error("tmux not running"); };
    expect(await identityOfExactTarget(run, "%42")).toBeNull();
  });
});
