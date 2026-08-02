import { describe, expect, test } from "bun:test";
import { authenticateActor, resolveAgentSelf } from "../../src/commands/shared/comm-send";

// kobo-335: actor-auth — an actor is bound to the local agent self
// (CLAUDE_AGENT_NAME or tmux); a --from/MAW_SENDER claim naming a DIFFERENT oracle is
// refused. env is injected so these are deterministic (no real tmux / process env).
//
// The end-to-end half of this file drove a real task WRITE verb (`runTask`) to prove
// the guard held at the verb boundary; that verb retired with the task subsystem. The
// surviving in-process caller of authenticateActor is the `[request:<id>]` hook in
// src/cli/route-comm.ts, which refuses a forged claim the same way (catch → skip).

describe("kobo-335 resolveAgentSelf", () => {
  test("CLAUDE_AGENT_NAME wins", () => {
    expect(resolveAgentSelf({ CLAUDE_AGENT_NAME: "eq3" } as any)).toBe("eq3");
  });
  test("no CLAUDE_AGENT_NAME, no TMUX → null (a bare CLI / person, not an oracle)", () => {
    expect(resolveAgentSelf({} as any)).toBeNull();
  });
});

describe("kobo-335 authenticateActor", () => {
  const eq3 = { CLAUDE_AGENT_NAME: "eq3" } as any;
  const none = {} as any;

  test("no claim + agent self → self", () => {
    expect(authenticateActor(undefined, eq3)).toBe("eq3");
  });
  test("no claim + no self → human (bare CLI person)", () => {
    expect(authenticateActor(undefined, none)).toBe("human");
  });
  test("--from matches self → ALLOW", () => {
    expect(authenticateActor("local:eq3", eq3)).toBe("eq3");
  });
  test("--from names a DIFFERENT oracle → REFUSE", () => {
    expect(() => authenticateActor("mba:tony", eq3)).toThrow(/authenticated identity is "eq3", can't act as "tony"/);
  });
  test("--from + no authenticated self → REFUSE (bare CLI can't assert an oracle)", () => {
    expect(() => authenticateActor("local:eq3", none)).toThrow(/no authenticated identity/);
  });
  test("MAW_SENDER is treated as a claim, bound to self", () => {
    expect(() => authenticateActor(undefined, { CLAUDE_AGENT_NAME: "eq3", MAW_SENDER: "mba:tony" } as any))
      .toThrow(/can't act as "tony"/);
    // matching MAW_SENDER is allowed
    expect(authenticateActor(undefined, { CLAUDE_AGENT_NAME: "eq3", MAW_SENDER: "local:eq3" } as any)).toBe("eq3");
  });
  test("--from wins over MAW_SENDER as the claim", () => {
    // explicit --from matches self → allow, even with a mismatched MAW_SENDER present
    expect(authenticateActor("local:eq3", { CLAUDE_AGENT_NAME: "eq3", MAW_SENDER: "mba:tony" } as any)).toBe("eq3");
  });
  test("malformed claim → invalid error (not a silent pass)", () => {
    expect(() => authenticateActor("eq3", eq3)).toThrow(/invalid actor/); // bare, not <node>:<oracle>
  });
});
