import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = await import("fs");
const { UserError, isUserError } = await import("../../src/core/util/user-error.ts");

type FsCall = { fn: string; args: unknown[] };
type PlannedOpen = number | { code: string };

let fsCalls: FsCall[] = [];
let openPlan: PlannedOpen[] = [];
let openCursor = 0;
// kobo-783: an array models a lock file whose OWNER CHANGES across reads (steal a dead
// holder's lock, then read our own pid back at release) — a single string cannot.
let readLockContents: string | string[] = "";
let readCursor = 0;
let linkPlan: (null | { code: string })[] = [];
let linkCursor = 0;
let lockExists = true;
let realDateNow: typeof Date.now;
let nowPlan: number[] = [];
let nowCursor = 0;

const READ_FD = 72_401;

function resetFsMockState(): void {
  fsCalls = [];
  openPlan = [];
  openCursor = 0;
  readLockContents = "";
  readCursor = 0;
  linkPlan = [];
  linkCursor = 0;
  lockExists = true;
  nowPlan = [];
  nowCursor = 0;
}

function setNowPlan(values: number[]): void {
  nowPlan = values;
  nowCursor = 0;
  Date.now = () => {
    const value = nowPlan[Math.min(nowCursor, nowPlan.length - 1)] ?? 0;
    nowCursor += 1;
    return value;
  };
}

await mock.module("fs", () => ({
  ...realFs,
  openSync: (path: string, flags: string) => {
    fsCalls.push({ fn: "openSync", args: [path, flags] });
    if (flags === "r") return READ_FD;
    const next = openPlan[Math.min(openCursor, openPlan.length - 1)];
    openCursor += 1;
    if (typeof next === "number") return next;
    const error: NodeJS.ErrnoException = new Error(`mock ${next?.code ?? "EINVAL"}`);
    error.code = next?.code ?? "EINVAL";
    throw error;
  },
  closeSync: (fd: number) => {
    fsCalls.push({ fn: "closeSync", args: [fd] });
  },
  unlinkSync: (path: string) => {
    fsCalls.push({ fn: "unlinkSync", args: [path] });
  },
  existsSync: (path: string) => {
    fsCalls.push({ fn: "existsSync", args: [path] });
    return lockExists;
  },
  writeSync: (fd: number, buf: Buffer, _offset: number, _length: number, _position: number) => {
    fsCalls.push({ fn: "writeSync", args: [fd, buf.toString("utf-8")] });
    return buf.length;
  },
  linkSync: (existingPath: string, newPath: string) => {
    fsCalls.push({ fn: "linkSync", args: [existingPath, newPath] });
    const next = linkPlan[Math.min(linkCursor, linkPlan.length - 1)];
    linkCursor += 1;
    if (!next) return; // default: the atomic publish succeeds
    const error: NodeJS.ErrnoException = new Error(`mock ${next.code}`);
    error.code = next.code;
    throw error;
  },
  readSync: (fd: number, buf: Buffer, _offset: number, _length: number, _position: number) => {
    fsCalls.push({ fn: "readSync", args: [fd] });
    const contents = Array.isArray(readLockContents)
      ? (readLockContents[Math.min(readCursor, readLockContents.length - 1)] ?? "")
      : readLockContents;
    readCursor += 1;
    const bytes = Buffer.from(contents);
    const n = Math.min(buf.length, bytes.length);
    bytes.copy(buf, 0, 0, n);
    return n;
  },
}));

type PeerRecord = {
  url?: string;
  node?: string | null;
  addedAt?: string;
  lastSeen?: string | null;
  nickname?: string | null;
  pubkey?: string;
  pubkeyFirstSeen?: string;
};

type StoreData = { peers: Record<string, PeerRecord> };

function createMemoryStore() {
  return {
    peers: {} as Record<string, PeerRecord>,
    mutateCalls: 0,
    reset() {
      this.peers = {};
      this.mutateCalls = 0;
    },
    mutate(mutator: (data: StoreData) => void) {
      this.mutateCalls += 1;
      mutator({ peers: this.peers });
    },
  };
}

const libPeerStore = createMemoryStore();

await mock.module(import.meta.resolve("../../src/lib/peers/store.ts"), () => ({
  mutatePeers: (mutator: (data: StoreData) => void) => libPeerStore.mutate(mutator),
}));

let hostExecCalls: string[] = [];
let fetchIssueCalls: Array<[number, string]> = [];
let wakeCalls: Array<[string, { incubate: string; task: string; prompt: string }]> = [];
let hostExecImpl: (cmd: string) => Promise<string> = async () => "iris-oracle\n";
let fetchIssuePromptImpl: (issueNum: number, slug: string) => Promise<string> = async (
  issueNum,
  slug,
) => `prompt for ${slug}#${issueNum}`;

await mock.module("maw-js/sdk", () => ({
  UserError,
  isUserError,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecImpl(cmd);
  },
  fetchIssuePrompt: async (issueNum: number, slug: string) => {
    fetchIssueCalls.push([issueNum, slug]);
    return fetchIssuePromptImpl(issueNum, slug);
  },
  cmdWake: async (
    oracle: string,
    opts: { incubate: string; task: string; prompt: string },
  ) => {
    wakeCalls.push([oracle, opts]);
  },
}));

await mock.module("maw-js/commands/shared/wake", () => ({
  fetchIssuePrompt: async (issueNum: number, slug: string) => {
    fetchIssueCalls.push([issueNum, slug]);
    return fetchIssuePromptImpl(issueNum, slug);
  },
  cmdWake: async (
    oracle: string,
    opts: { incubate: string; task: string; prompt: string },
  ) => {
    wakeCalls.push([oracle, opts]);
  },
}));

const libTofu = await import("../../src/lib/peers/tofu");
const assignImpl = await import("../../src/vendor/mpr-plugins/assign/impl");
const assignPlugin = await import("../../src/vendor/mpr-plugins/assign/index");

const originalTmux = process.env.TMUX;

beforeEach(() => {
  realDateNow = Date.now;
  resetFsMockState();
  libPeerStore.reset();
  hostExecCalls = [];
  fetchIssueCalls = [];
  wakeCalls = [];
  hostExecImpl = async () => "iris-oracle\n";
  fetchIssuePromptImpl = async (issueNum, slug) => `prompt for ${slug}#${issueNum}`;
  delete process.env.TMUX;
});

afterEach(() => {
  Date.now = realDateNow;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

const lockTargets = [
  {
    label: "src/lib/peers",
    load: () => import("../../src/lib/peers/lock"),
  },
  {
    label: "bud/internal",
    load: () => import("../../src/vendor/mpr-plugins/bud/internal/lock"),
  },
  {
    label: "doctor/internal",
    load: () => import("../../src/vendor/mpr-plugins/doctor/internal/lock"),
  },
  {
    label: "pair/internal",
    load: () => import("../../src/vendor/mpr-plugins/pair/internal/lock"),
  },
  {
    label: "peers/plugin",
    load: () => import("../../src/vendor/mpr-plugins/peers/lock"),
  },
];

function lockPathFor(label: string): string {
  return `/tmp/maw-${label.replace(/[^a-z0-9]+/gi, "-")}-peers.json`;
}

describe("assign plugin extra coverage", () => {
  test("command metadata and handler usage errors are stable", async () => {
    expect(assignPlugin.command).toEqual({
      name: "assign",
      description: "Assign a GitHub issue to an oracle.",
    });

    const originalLog = console.log;
    const result = await assignPlugin.default({ source: "api", args: ["ignored"] } as never);

    expect(result).toMatchObject({
      ok: false,
      error: "usage: maw assign <issue-url> [--oracle <name>]",
    });
    expect(result.output).toBeUndefined();
    expect(console.log).toBe(originalLog);
  });

  test("cmdAssign rejects malformed issue URLs before fetching", async () => {
    let thrown: unknown;
    try {
      await assignImpl.cmdAssign("not-a-github-issue", { oracle: "orion" });
    } catch (err) {
      thrown = err;
    }
    expect(isUserError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("Invalid issue URL: not-a-github-issue");
    expect(fetchIssueCalls).toEqual([]);
    expect(wakeCalls).toEqual([]);
  });

  test("cmdAssign uses explicit oracle, parses owner/repo/issue, logs, and wakes with fetched prompt", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await assignImpl.cmdAssign("https://github.com/Soul-Brews-Studio/maw-js/issues/1494", {
        oracle: "orion",
      });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("fetching issue #1494 from Soul-Brews-Studio/maw-js");
    expect(fetchIssueCalls).toEqual([[1494, "Soul-Brews-Studio/maw-js"]]);
    expect(wakeCalls).toEqual([
      [
        "orion",
        {
          incubate: "Soul-Brews-Studio/maw-js",
          task: "issue-1494",
          prompt: "prompt for Soul-Brews-Studio/maw-js#1494",
        },
      ],
    ]);
    expect(hostExecCalls).toEqual([]);
  });

  test("cmdAssign detects oracle from tmux window name and tolerates hostExec failure as undetected", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    hostExecImpl = async () => "lyra-coverage\n";

    const originalLog = console.log;
    console.log = () => {};
    try {
      await assignImpl.cmdAssign("git@github.com:org/repo/issues/7", {});
    } finally {
      console.log = originalLog;
    }

    expect(hostExecCalls).toEqual(["tmux display-message -p '#{window_name}'"]);
    expect(fetchIssueCalls).toEqual([[7, "org/repo"]]);
    expect(wakeCalls[0][0]).toBe("lyra");

    hostExecCalls = [];
    fetchIssueCalls = [];
    wakeCalls = [];
    hostExecImpl = async () => {
      throw new Error("tmux unavailable");
    };

    await expect(assignImpl.cmdAssign("https://github.com/org/repo/issues/8", {})).rejects.toThrow(
      "could not detect oracle",
    );
    expect(hostExecCalls).toEqual(["tmux display-message -p '#{window_name}'"]);
    expect(fetchIssueCalls).toEqual([]);
    expect(wakeCalls).toEqual([]);
  });

  test("handler parses --oracle anywhere and captures console output without a writer", async () => {
    const result = await assignPlugin.default({
      source: "cli",
      args: ["--oracle", "nova", "https://github.com/org/repo/issues/44"],
    } as never);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("fetching issue #44 from org/repo");
    expect(fetchIssueCalls).toEqual([[44, "org/repo"]]);
    expect(wakeCalls[0]).toEqual([
      "nova",
      { incubate: "org/repo", task: "issue-44", prompt: "prompt for org/repo#44" },
    ]);
  });

  test("handler routes console output to writer and captures error logs when no writer is present", async () => {
    const writes: string[] = [];
    let result = await assignPlugin.default({
      source: "cli",
      args: ["https://github.com/org/repo/issues/45", "--oracle", "scribe"],
      writer: (...args: unknown[]) => writes.push(args.map(String).join(" ")),
    } as never);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(writes.join("\n")).toContain("fetching issue #45 from org/repo");

    fetchIssuePromptImpl = async () => {
      console.error("fetch exploded");
      throw new Error("network down");
    };
    result = await assignPlugin.default({
      source: "cli",
      args: ["https://github.com/org/repo/issues/46", "--oracle", "scribe"],
    } as never);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fetching issue #46 from org/repo");
    expect(result.error).toContain("fetch exploded");
    expect(result.error).not.toContain("network down");
    expect(result.output).toBe(result.error);
  });
});

describe("src/lib/peers/tofu extra coverage", () => {
  test("evaluatePeerIdentity covers bootstrap, legacy, match, and mismatch decisions", () => {
    expect(libTofu.evaluatePeerIdentity("fresh", undefined, "observed-pubkey")).toMatchObject({
      kind: "tofu-bootstrap",
      alias: "fresh",
      observed: "observed-pubkey",
    });

    expect(libTofu.evaluatePeerIdentity("legacy", undefined, undefined)).toMatchObject({
      kind: "legacy-first-contact",
      alias: "legacy",
    });

    expect(
      libTofu.evaluatePeerIdentity(
        "rollback",
        { url: "http://rollback", pubkey: "cached-pubkey-abcdefghijklmnop" } as never,
        undefined,
      ),
    ).toMatchObject({
      kind: "legacy-after-pinned",
      alias: "rollback",
      cached: "cached-pubkey-abcdefghijklmnop",
    });

    expect(
      libTofu.evaluatePeerIdentity(
        "stable",
        { url: "http://stable", pubkey: "same-pubkey" } as never,
        "same-pubkey",
      ),
    ).toMatchObject({
      kind: "match",
      alias: "stable",
      cached: "same-pubkey",
      observed: "same-pubkey",
    });

    const mismatch = libTofu.evaluatePeerIdentity(
      "rotated",
      { url: "http://rotated", pubkey: "cached-pubkey-abcdefghijklmnop" } as never,
      "observed-pubkey-qrstuvwxyz",
    );
    expect(mismatch).toMatchObject({
      kind: "mismatch",
      alias: "rotated",
      cached: "cached-pubkey-abcdefghijklmnop",
      observed: "observed-pubkey-qrstuvwxyz",
    });
    expect(mismatch.message).toContain("maw peers forget rotated");
  });

  test("apply and record bootstrap once, preserve racing pins, no-op accepted states, and throw mismatch", () => {
    libPeerStore.peers.alice = { url: "http://alice" };

    const bootstrapped = libTofu.tofuRecordPeerIdentity(
      "alice",
      libPeerStore.peers.alice as never,
      "alice-pubkey",
    );
    expect(bootstrapped.kind).toBe("tofu-bootstrap");
    expect(libPeerStore.peers.alice.pubkey).toBe("alice-pubkey");
    expect(Number.isNaN(Date.parse(libPeerStore.peers.alice.pubkeyFirstSeen!))).toBe(false);

    libPeerStore.peers.alice.pubkeyFirstSeen = "first-write-wins";
    libTofu.applyTofuDecision({
      kind: "tofu-bootstrap",
      alias: "alice",
      observed: "racing-pubkey",
      message: "do not overwrite",
    });
    expect(libPeerStore.peers.alice).toMatchObject({
      pubkey: "alice-pubkey",
      pubkeyFirstSeen: "first-write-wins",
    });

    expect(() =>
      libTofu.applyTofuDecision({
        kind: "tofu-bootstrap",
        alias: "forgotten",
        observed: "lost-race-pubkey",
        message: "peer forgotten",
      }),
    ).not.toThrow();
    expect(libPeerStore.peers.forgotten).toBeUndefined();

    libTofu.applyTofuDecision({
      kind: "match",
      alias: "alice",
      cached: "alice-pubkey",
      observed: "alice-pubkey",
      message: "verified",
    });
    libTofu.applyTofuDecision({
      kind: "legacy-first-contact",
      alias: "legacy",
      message: "legacy accepted",
    });
    libTofu.applyTofuDecision({
      kind: "legacy-after-pinned",
      alias: "rollback",
      cached: "cached",
      message: "migration rollback accepted",
    });

    expect(() =>
      libTofu.tofuRecordPeerIdentity(
        "alice",
        libPeerStore.peers.alice as never,
        "rotated-pubkey",
      ),
    ).toThrow(libTofu.PeerPubkeyMismatchError);
  });

  test("forgetPeerPubkey reports every outcome and preserves unrelated peer fields", () => {
    expect(libTofu.forgetPeerPubkey("missing")).toBe("not-found");

    libPeerStore.peers.legacy = { url: "http://legacy", nickname: "Legacy" };
    expect(libTofu.forgetPeerPubkey("legacy")).toBe("no-pubkey");
    expect(libPeerStore.peers.legacy).toEqual({ url: "http://legacy", nickname: "Legacy" });

    libPeerStore.peers.pinned = {
      url: "http://pinned",
      node: "node-a",
      pubkey: "pinned-pubkey",
      pubkeyFirstSeen: "2026-05-18T00:00:00.000Z",
      nickname: "Pinned",
    };
    expect(libTofu.forgetPeerPubkey("pinned")).toBe("cleared");
    expect(libPeerStore.peers.pinned).toEqual({
      url: "http://pinned",
      node: "node-a",
      nickname: "Pinned",
    });
  });
});

describe("peers lock helper extra coverage", () => {
  // kobo-783: acquisition is now write-pid-to-tmp then link() it into place, so the lock
  // file is never observable without its pid in it. The syscall shape below IS the fix —
  // an open(O_EXCL)-then-write sequence here would mean the empty-lock window is back.
  test("all lock helpers write the pid to a tmp file and link it into place, then release", async () => {
    for (const [idx, target] of lockTargets.entries()) {
      resetFsMockState();
      openPlan = [900 + idx];
      readLockContents = String(process.pid); // release re-reads the lock to confirm it is still ours
      const lock = `${lockPathFor(target.label)}.lock`;
      const tmp = `${lock}.${process.pid}.tmp`;
      const { withPeersLock } = await target.load();

      const result = withPeersLock(lockPathFor(target.label), () => `${target.label}:ok`);

      expect(result).toBe(`${target.label}:ok`);
      expect(fsCalls).toEqual([
        { fn: "openSync", args: [tmp, "wx"] },
        { fn: "writeSync", args: [900 + idx, String(process.pid)] },
        { fn: "closeSync", args: [900 + idx] },
        { fn: "linkSync", args: [tmp, lock] },
        { fn: "unlinkSync", args: [tmp] },
        { fn: "openSync", args: [lock, "r"] },
        { fn: "readSync", args: [READ_FD] },
        { fn: "closeSync", args: [READ_FD] },
        { fn: "unlinkSync", args: [lock] },
      ]);
    }
  });

  test("all lock helpers steal a lock whose recorded pid is readable AND dead", async () => {
    for (const [idx, target] of lockTargets.entries()) {
      resetFsMockState();
      openPlan = [1_200 + idx];
      linkPlan = [{ code: "EEXIST" }, null]; // held on the first pass, ours on the second
      readLockContents = ["999999999", String(process.pid)]; // dead holder, then us at release
      const lock = `${lockPathFor(target.label)}.lock`;
      const { withPeersLock } = await target.load();

      const result = withPeersLock(lockPathFor(target.label), () => "stolen");

      expect(result).toBe("stolen");
      expect(fsCalls.filter((call) => call.fn === "linkSync")).toHaveLength(2);
      expect(fsCalls).toContainEqual({ fn: "openSync", args: [lock, "r"] });
      expect(fsCalls).toContainEqual({ fn: "readSync", args: [READ_FD] });
      expect(fsCalls).toContainEqual({ fn: "unlinkSync", args: [lock] }); // the steal
    }
  });

  // kobo-783 defect (b): an unreadable/empty lock file is a holder caught mid-acquire under
  // the OLD code, never proof of a dead one. It must be waited out, not stolen.
  test("all lock helpers refuse to steal a lock they cannot read a pid from", async () => {
    for (const [idx, target] of lockTargets.entries()) {
      resetFsMockState();
      openPlan = [1_300 + idx];
      linkPlan = [{ code: "EEXIST" }];
      readLockContents = "";
      setNowPlan([1_000, 6_001]);
      const lock = `${lockPathFor(target.label)}.lock`;
      const { withPeersLock } = await target.load();

      expect(() => withPeersLock(lockPathFor(target.label), () => "never")).toThrow(
        `peers lock timeout: pid unreadable still holds ${lock}`,
      );
      expect(fsCalls.filter((call) => call.fn === "unlinkSync" && call.args[0] === lock)).toHaveLength(0);
      Date.now = realDateNow;
    }
  });

  test("all lock helpers wait once on a live holder before retrying acquisition", async () => {
    for (const [idx, target] of lockTargets.entries()) {
      resetFsMockState();
      openPlan = [1_500 + idx];
      linkPlan = [{ code: "EEXIST" }, null];
      readLockContents = String(process.pid);
      setNowPlan([1_000, 1_001, 1_001, 1_100]);
      const { withPeersLock } = await target.load();

      const result = withPeersLock(lockPathFor(target.label), () => "waited");

      expect(result).toBe("waited");
      expect(fsCalls.filter((call) => call.fn === "linkSync")).toHaveLength(2);
      expect(fsCalls).toContainEqual({ fn: "readSync", args: [READ_FD] });
      expect(fsCalls).toContainEqual({ fn: "writeSync", args: [1_500 + idx, String(process.pid)] });
      Date.now = realDateNow;
    }
  });

  test("all lock helpers propagate non-EEXIST acquire errors without cleanup for an unheld fd", async () => {
    for (const target of lockTargets) {
      resetFsMockState();
      openPlan = [{ code: "EACCES" }];
      const { withPeersLock } = await target.load();

      let caught: NodeJS.ErrnoException | undefined;
      try {
        withPeersLock(lockPathFor(target.label), () => "never");
      } catch (error) {
        caught = error as NodeJS.ErrnoException;
      }

      expect(caught?.code).toBe("EACCES");
      expect(fsCalls.some((call) => call.fn === "closeSync")).toBe(false);
      expect(fsCalls.some((call) => call.fn === "unlinkSync")).toBe(false);
    }
  });

  test("all lock helpers release after fn throws and time out on a live holder", async () => {
    for (const [idx, target] of lockTargets.entries()) {
      resetFsMockState();
      openPlan = [2_000 + idx];
      readLockContents = String(process.pid);
      const lock = `${lockPathFor(target.label)}.lock`;
      const { withPeersLock } = await target.load();

      expect(() =>
        withPeersLock(lockPathFor(target.label), () => {
          throw new Error(`${target.label} boom`);
        }),
      ).toThrow(`${target.label} boom`);
      expect(fsCalls).toContainEqual({ fn: "closeSync", args: [2_000 + idx] });
      expect(fsCalls).toContainEqual({ fn: "unlinkSync", args: [lock] });

      resetFsMockState();
      openPlan = [3_000 + idx];
      linkPlan = [{ code: "EEXIST" }];
      readLockContents = String(process.pid);
      setNowPlan([1_000, 6_001]);

      expect(() => withPeersLock(lockPathFor(target.label), () => "never")).toThrow(
        `peers lock timeout: pid ${process.pid} still holds ${lock}`,
      );
      expect(fsCalls).toContainEqual({ fn: "closeSync", args: [READ_FD] });
      // the LOCK is untouched — only our own tmp file is cleaned up
      expect(fsCalls.filter((call) => call.fn === "unlinkSync" && call.args[0] === lock)).toHaveLength(0);
      Date.now = realDateNow;
    }
  });
});
