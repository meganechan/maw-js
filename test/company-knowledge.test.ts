import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _setCompaniesDir,
  createCompany, addDepartment, assignMember, kbTagFor,
} from "../src/vendor/mpr-plugins/company/company-helpers";
import {
  kbLearnPayload, kbSearchUrl, softBiasByDeptTag, resolveKbUrl,
  resolveLead, planShareTargets, planSyncTargets,
  deptLearn, deptKnowledge, deptShare, deptSync,
  type FetchLike, type KbSearchResult, type ClaudeJson,
} from "../src/vendor/mpr-plugins/company/company-knowledge";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-company-knowledge-"));
  _setCompaniesDir(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ─── pure: resolveKbUrl ──────────────────────────────────────────────────────

describe("resolveKbUrl", () => {
  const REMOTE = "http://10.66.66.26:47778";
  const root = (url: string): ClaudeJson => ({
    mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: url } } },
  });
  const perProject = (url: string): ClaudeJson => ({
    projects: { "/some/path": { mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: url } } } } },
  });

  test("(a) env.ORACLE_REMOTE_URL wins over everything", () => {
    expect(
      resolveKbUrl({ env: { ORACLE_REMOTE_URL: REMOTE, ARRA_URL: "http://other" }, claudeJson: root("http://json") }),
    ).toBe(REMOTE);
  });

  test("(b) env.ARRA_URL is next when ORACLE_REMOTE_URL absent", () => {
    expect(
      resolveKbUrl({ env: { ARRA_URL: "http://manual" }, claudeJson: root("http://json") }),
    ).toBe("http://manual");
  });

  test("(c) claude.json ROOT mcpServers used when env absent", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: root(REMOTE) })).toBe(REMOTE);
  });

  test("(d) per-project fallback when root absent", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: perProject(REMOTE) })).toBe(REMOTE);
  });

  test("(d) first non-empty per-project hit wins", () => {
    const cj: ClaudeJson = {
      projects: {
        "/a": { mcpServers: { "arra-oracle": { env: {} } } },
        "/b": { mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: REMOTE } } } },
      },
    };
    expect(resolveKbUrl({ env: {}, claudeJson: cj })).toBe(REMOTE);
  });

  test("(e) localhost fallback when claude.json is null", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: null })).toBe("http://localhost:47778");
  });

  test("(e) localhost fallback honors ORACLE_PORT", () => {
    expect(resolveKbUrl({ env: { ORACLE_PORT: "9999" }, claudeJson: null })).toBe("http://localhost:9999");
  });

  test("(e) localhost fallback when claude.json lacks the keys", () => {
    expect(resolveKbUrl({ env: {}, claudeJson: { mcpServers: {} } })).toBe("http://localhost:47778");
    expect(resolveKbUrl({ env: {}, claudeJson: {} })).toBe("http://localhost:47778");
  });

  test("(f) precedence: root claude.json beats per-project", () => {
    const cj: ClaudeJson = {
      mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: "http://root" } } },
      projects: { "/p": { mcpServers: { "arra-oracle": { env: { ORACLE_REMOTE_URL: "http://proj" } } } } },
    };
    expect(resolveKbUrl({ env: {}, claudeJson: cj })).toBe("http://root");
  });

  test("(f) full precedence order ORACLE_REMOTE_URL > ARRA_URL > json > localhost", () => {
    const cj = root("http://json");
    expect(resolveKbUrl({ env: { ORACLE_REMOTE_URL: "http://exp", ARRA_URL: "http://man" }, claudeJson: cj })).toBe("http://exp");
    expect(resolveKbUrl({ env: { ARRA_URL: "http://man" }, claudeJson: cj })).toBe("http://man");
    expect(resolveKbUrl({ env: {}, claudeJson: cj })).toBe("http://json");
    expect(resolveKbUrl({ env: {}, claudeJson: null })).toBe("http://localhost:47778");
  });

  test("blank/whitespace values fall through, not treated as set", () => {
    expect(
      resolveKbUrl({ env: { ORACLE_REMOTE_URL: "   ", ARRA_URL: "" }, claudeJson: root(REMOTE) }),
    ).toBe(REMOTE);
    expect(resolveKbUrl({ env: {}, claudeJson: root("  ") })).toBe("http://localhost:47778");
  });
});

// ─── pure: kbLearnPayload ────────────────────────────────────────────────────

describe("kbLearnPayload", () => {
  test("tags concept AND embeds tag inline in content", () => {
    const p = kbLearnPayload("kob", "payment", "use idempotency keys for retries");
    const tag = kbTagFor("kob", "payment"); // dept:kob:payment
    expect(p.concepts).toEqual([tag]);
    expect(p.content.startsWith(`[${tag}] `)).toBe(true);
    expect(p.content).toContain("use idempotency keys for retries");
    expect(p.type).toBe("learning");
    expect(p.source).toBe("maw dept learn:kob/payment");
  });

  test("pattern is first-line summary of the knowledge", () => {
    const p = kbLearnPayload("kob", "payment", "first line summary\nmore detail here");
    expect(p.pattern).toBe("first line summary");
  });

  test("leading-blank knowledge: first non-empty line after trim is the pattern", () => {
    const p = kbLearnPayload("kob", "payment", "\nbody only");
    expect(p.pattern).toBe("body only");
  });

  test("pattern falls back to dept tag when knowledge is whitespace-only", () => {
    const tag = kbTagFor("kob", "payment");
    const p = kbLearnPayload("kob", "payment", "   ");
    expect(p.pattern).toBe(tag);
  });

  test("long first line is truncated for pattern but full in content", () => {
    const long = "x".repeat(200);
    const p = kbLearnPayload("kob", "payment", long);
    expect(p.pattern.length).toBeLessThanOrEqual(120);
    expect(p.pattern.endsWith("...")).toBe(true);
    expect(p.content).toContain(long);
  });
});

// ─── pure: kbSearchUrl ───────────────────────────────────────────────────────

describe("kbSearchUrl", () => {
  const tag = "dept:kob:payment";

  test("query present: tag prepended to q, encoded", () => {
    const url = kbSearchUrl("http://localhost:47778", tag, "retry logic");
    expect(url).toContain(`q=${encodeURIComponent(`${tag} retry logic`)}`);
    expect(url).toContain("limit=10");
    expect(url).toContain("mode=hybrid");
    expect(url).not.toContain("mode=fts");
  });

  test("no query: tag alone is the q", () => {
    const url = kbSearchUrl("http://localhost:47778", tag);
    expect(url).toContain(`q=${encodeURIComponent(tag)}`);
  });

  test("empty/whitespace query treated as no query", () => {
    const url = kbSearchUrl("http://localhost:47778", tag, "   ");
    expect(url).toContain(`q=${encodeURIComponent(tag)}`);
  });

  test("encodes special characters in query", () => {
    const url = kbSearchUrl("http://b", tag, "a&b=c");
    expect(url).toContain(encodeURIComponent(`${tag} a&b=c`));
    expect(url).not.toContain("a&b=c"); // raw form must not leak
  });
});

// ─── pure: softBiasByDeptTag ─────────────────────────────────────────────────

describe("softBiasByDeptTag", () => {
  const tag = "dept:kob:payment";
  const mk = (content: string, source_file: string): KbSearchResult => ({ content, type: "learning", source_file, score: 1 });

  test("keeps ALL results — nothing is dropped (untagged still returned)", () => {
    const results = [
      mk(`[${tag}] in dept`, "a"),
      mk("unrelated knowledge", "b"),
      mk(`some text [${tag}] mid`, "c"),
    ];
    const out = softBiasByDeptTag(results, tag);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.source_file).sort()).toEqual(["a", "b", "c"]);
  });

  test("orders tagged entries before untagged", () => {
    const results = [
      mk("untagged-1", "u1"),
      mk(`[${tag}] tagged-1`, "t1"),
      mk("untagged-2", "u2"),
      mk(`[${tag}] tagged-2`, "t2"),
    ];
    const out = softBiasByDeptTag(results, tag);
    expect(out.map((r) => r.source_file)).toEqual(["t1", "t2", "u1", "u2"]);
  });

  test("is stable within each group (preserves KB rank order)", () => {
    const results = [
      mk(`[${tag}] first-tagged`, "t1"),
      mk("first-untagged", "u1"),
      mk(`[${tag}] second-tagged`, "t2"),
      mk("second-untagged", "u2"),
    ];
    const out = softBiasByDeptTag(results, tag);
    expect(out.map((r) => r.source_file)).toEqual(["t1", "t2", "u1", "u2"]);
  });

  test("non-string content is treated as untagged (kept, ordered last)", () => {
    const results = [
      { content: undefined as any, type: "x", source_file: "u", score: 1 },
      mk(`[${tag}] tagged`, "t"),
    ];
    const out = softBiasByDeptTag(results, tag);
    expect(out.map((r) => r.source_file)).toEqual(["t", "u"]);
  });
});

// ─── pure: resolveLead / planShareTargets / planSyncTargets ──────────────────

describe("target planning", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "pay-lead" });
    assignMember("kob", "payment", "pay-dev-1", "dev");
    assignMember("kob", "payment", "pay-dev-2", "dev");
  });

  test("resolveLead returns the lead when set", () => {
    expect(resolveLead("kob", "payment")).toBe("pay-lead");
  });

  test("resolveLead returns null when no lead", () => {
    addDepartment("kob", "ops");
    expect(resolveLead("kob", "ops")).toBeNull();
  });

  test("resolveLead returns null for unknown company/dept", () => {
    expect(resolveLead("ghost", "x")).toBeNull();
  });

  test("planShareTargets returns ALL members (including lead)", () => {
    const targets = planShareTargets("kob", "payment").map((m) => m.oracle).sort();
    expect(targets).toEqual(["pay-dev-1", "pay-dev-2", "pay-lead"]);
  });

  test("planSyncTargets EXCLUDES the lead (lead is the source)", () => {
    const targets = planSyncTargets("kob", "payment").map((m) => m.oracle).sort();
    expect(targets).toEqual(["pay-dev-1", "pay-dev-2"]);
    expect(targets).not.toContain("pay-lead");
  });
});

// ─── async: deptLearn (injected fetch) ───────────────────────────────────────

describe("deptLearn (injected fetch)", () => {
  test("POSTs to /api/learn with the dept-tagged payload", async () => {
    let captured: { url: string; init: any } | null = null;
    const fakeFetch: FetchLike = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const res = await deptLearn("kob", "payment", "use idempotency keys", {
      fetch: fakeFetch,
      url: "http://kb",
    });
    expect(res.ok).toBe(true);
    expect(captured!.url).toBe("http://kb/api/learn");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body);
    expect(body.concepts).toEqual(["dept:kob:payment"]);
    expect(body.content).toContain("[dept:kob:payment]");
    expect(body.content).toContain("use idempotency keys");
  });

  test("non-2xx → graceful error, no throw", async () => {
    const fakeFetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const res = await deptLearn("kob", "payment", "k", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("503");
  });

  test("thrown fetch (KB unreachable) → graceful error, no throw", async () => {
    const fakeFetch: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const res = await deptLearn("kob", "payment", "k", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("KB unreachable");
    expect(res.message).toContain("http://kb");
  });
});

// ─── async: deptKnowledge (injected fetch) ───────────────────────────────────

describe("deptKnowledge (injected fetch)", () => {
  test("builds dept-scoped GET url and soft-biases (tagged first, none dropped)", async () => {
    let capturedUrl = "";
    const fakeFetch: FetchLike = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            // KB returns an untagged semantic neighbor RANKED ABOVE the tagged one
            { content: "unrelated", type: "learning", source_file: "b", score: 0.95 },
            { content: "[dept:kob:payment] scoped one", type: "learning", source_file: "a", score: 0.9 },
          ],
        }),
      };
    };
    const res = await deptKnowledge("kob", "payment", "retries", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(true);
    expect(capturedUrl).toContain("http://kb/api/search");
    expect(capturedUrl).toContain(encodeURIComponent("dept:kob:payment retries"));
    expect(capturedUrl).toContain("mode=hybrid");
    // soft bias: ALL results kept (regression guard — untagged neighbor NOT dropped)
    expect(res.results).toHaveLength(2);
    // tagged entry surfaced first despite lower KB score
    expect(res.results[0].source_file).toBe("a");
    expect(res.results[1].source_file).toBe("b");
  });

  test("no query → tag-only q", async () => {
    let capturedUrl = "";
    const fakeFetch: FetchLike = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };
    await deptKnowledge("kob", "payment", undefined, { fetch: fakeFetch, url: "http://kb" });
    expect(capturedUrl).toContain(encodeURIComponent("dept:kob:payment"));
  });

  test("non-2xx → graceful error, empty results", async () => {
    const fakeFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const res = await deptKnowledge("kob", "payment", "q", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.results).toEqual([]);
  });

  test("thrown fetch → graceful 'KB unreachable', empty results", async () => {
    const fakeFetch: FetchLike = async () => { throw new Error("down"); };
    const res = await deptKnowledge("kob", "payment", "q", { fetch: fakeFetch, url: "http://kb" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("KB unreachable");
    expect(res.results).toEqual([]);
  });
});

// ─── async: deptShare / deptSync (injected send/sync, no process spawn) ───────

describe("deptShare (injected send)", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "pay-lead" });
    assignMember("kob", "payment", "pay-dev-1", "dev");
  });

  test("sends to every member, reports per-member ok", async () => {
    const seen: string[] = [];
    const reports = await deptShare("kob", "payment", "ship it", {
      send: async (member) => { seen.push(member); },
    });
    expect(seen.sort()).toEqual(["pay-dev-1", "pay-lead"]);
    expect(reports.every((r) => r.ok)).toBe(true);
  });

  test("one failing send does not abort the rest", async () => {
    const reports = await deptShare("kob", "payment", "msg", {
      send: async (member) => { if (member === "pay-lead") throw new Error("offline"); },
    });
    const byOracle = Object.fromEntries(reports.map((r) => [r.oracle, r]));
    expect(byOracle["pay-lead"].ok).toBe(false);
    expect(byOracle["pay-lead"].detail).toContain("offline");
    expect(byOracle["pay-dev-1"].ok).toBe(true);
  });
});

describe("deptSync (injected sync)", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "pay-lead" });
    assignMember("kob", "payment", "pay-dev-1", "dev");
    assignMember("kob", "payment", "pay-dev-2", "dev");
  });

  test("syncs each non-lead member FROM the lead", async () => {
    const pairs: Array<[string, string]> = [];
    const res = await deptSync("kob", "payment", {
      sync: async (lead, member) => { pairs.push([lead, member]); },
    });
    expect(res.lead).toBe("pay-lead");
    expect(pairs.every(([lead]) => lead === "pay-lead")).toBe(true);
    expect(pairs.map(([, m]) => m).sort()).toEqual(["pay-dev-1", "pay-dev-2"]);
    expect(res.reports.every((r) => r.ok)).toBe(true);
  });

  test("no lead → lead:null, no sync attempted", async () => {
    addDepartment("kob", "ops");
    assignMember("kob", "ops", "ops-1", "dev");
    let called = false;
    const res = await deptSync("kob", "ops", { sync: async () => { called = true; } });
    expect(res.lead).toBeNull();
    expect(called).toBe(false);
  });

  test("a failing member sync is reported, others continue", async () => {
    const res = await deptSync("kob", "payment", {
      sync: async (_lead, member) => { if (member === "pay-dev-1") throw new Error("no repo"); },
    });
    const byOracle = Object.fromEntries(res.reports.map((r) => [r.oracle, r]));
    expect(byOracle["pay-dev-1"].ok).toBe(false);
    expect(byOracle["pay-dev-2"].ok).toBe(true);
  });
});
