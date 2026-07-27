import { describe, expect, it } from "bun:test";
import { probeServer } from "./probe";

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (url: string, init: RequestInit) => impl(url, init)) as unknown as typeof fetch;
}

describe("kobo-458 probeServer — ok / slow / dead / probe-error must never collapse into each other", () => {
  it("fast 200 response → ok", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
    });
    expect(result.status).toBe("ok");
  });

  it("200 response past the slow-threshold → slow, not ok, not dead", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      slowThresholdMs: 0, // any measurable delay counts as slow for this test
      fetchImpl: fakeFetch(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return new Response("{}", { status: 200 });
      }),
    });
    expect(result.status).toBe("slow");
  });

  it("fetch throwing (connection refused / timeout) → dead", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => { throw new Error("ECONNREFUSED"); }),
    });
    expect(result.status).toBe("dead");
  });

  it("non-2xx response → dead, not ok — an answer that isn't usable is the same bucket as no answer", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })),
    });
    expect(result.status).toBe("dead");
  });

  it("malformed URL → probe-error, distinct from dead — this is the WATCHER misconfigured, not the server unreachable", async () => {
    const result = await probeServer("not a url at all", { fetchImpl: fakeFetch(() => new Response("{}")) });
    expect(result.status).toBe("probe-error");
  });

  it("non-function fetchImpl → probe-error", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: "not a function" as unknown as typeof fetch,
    });
    expect(result.status).toBe("probe-error");
  });
});
