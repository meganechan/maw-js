/**
 * kobo-534 — openPrLinkedRepos used to fully read+parse EVERY card on the board,
 * every 120s pr-watch tick, regardless of whether anything changed. Fixed with an
 * in-process mtime-gated cache (module-level Map in pr-watch.ts): stat every file
 * every tick (cheap), only read+parse the ones whose mtime changed since the last
 * tick. Two things must hold: (1) an unchanged card is genuinely served from cache,
 * not re-read — proven by forging a stale mtime over changed content (a real
 * mtime bump always accompanies a real write, so this scenario can't happen
 * naturally, but it's the only way to OBSERVE that the cache is real rather than
 * a no-op that happens to return the same answer); (2) a real write (mtime bumps
 * with the content) is picked up on the very next tick, and a deleted card's
 * repo doesn't linger. Plus an end-to-end proof that pr-watch's actual job — PR
 * open drives a card to review, PR merge drives it to done — still fires through
 * the cached path across multiple ticks.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIG_DATA_DIR = process.env.MAW_DATA_DIR;
const ORIG_HOME = process.env.MAW_HOME;
const ORIG_PORT = process.env.MAW_PORT;
const ORIG_PATH = process.env.PATH;
let root: string;

function card(company: string, id: string, fields: Record<string, unknown>): string {
  const dir = join(root, "companies", company, "tasks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, company, title: id, ts: 1, ...fields }));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-mtime-"));
  process.env.MAW_DATA_DIR = root;
  // MAW_HOME overrides BOTH mawDataDir AND mawStateDir (src/core/xdg.ts) — without
  // this, pollPrsOnce's snapshot file (watch-pr-state.json) resolves under the REAL
  // ~/.maw regardless of MAW_DATA_DIR, and a fictional test PR silently pollutes the
  // real machine's pr-watch state (caught live during this card's own development —
  // cleaned up by hand once, never again). MAW_PORT to an unused port so postLive's
  // fire-and-forget fetch can't reach a real running maw-server either.
  process.env.MAW_HOME = root;
  process.env.MAW_PORT = "1";
});

afterEach(() => {
  if (ORIG_DATA_DIR === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = ORIG_DATA_DIR;
  if (ORIG_HOME === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = ORIG_HOME;
  if (ORIG_PORT === undefined) delete process.env.MAW_PORT; else process.env.MAW_PORT = ORIG_PORT;
  process.env.PATH = ORIG_PATH;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("openPrLinkedRepos mtime cache (kobo-534)", () => {
  it("REGRESSION GUARD — an unchanged mtime is served from cache, even if content changed behind its back", async () => {
    const { openPrLinkedRepos, _clearPrLinkFieldsCache } = await import("./pr-watch.ts?mtime-stale-guard");
    _clearPrLinkFieldsCache();
    const path = card("kobo", "kobo-1", { state: "review", pr: 10, repo: "acme/one" });
    expect(openPrLinkedRepos()).toEqual(["acme/one"]); // warms the cache

    const before = statSync(path);
    // Rewrite content (as if content changed) but force mtime BACK to the original —
    // a real filesystem write always bumps mtime together with content, so this is an
    // artificial probe, not a real-world case. It exists purely to prove the cache
    // trusts mtime rather than re-reading regardless: if this test is EVER green
    // without the cache (i.e. after reverting to the old always-read behavior), the
    // artificial premise breaks (content really did change) and this must go RED.
    // Fractional seconds (not Date objects — those truncate to whole seconds in
    // utimesSync) so the restored mtime matches the cached mtimeMs exactly.
    writeFileSync(path, JSON.stringify({ id: "kobo-1", company: "kobo", title: "kobo-1", ts: 1, state: "review", pr: 10, repo: "acme/CHANGED" }));
    utimesSync(path, before.atimeMs / 1000, before.mtimeMs / 1000);

    expect(openPrLinkedRepos()).toEqual(["acme/one"]); // still the cached value — proves caching is real
  });

  it("a REAL write (content + mtime both change) is picked up on the very next call", async () => {
    const { openPrLinkedRepos, _clearPrLinkFieldsCache } = await import("./pr-watch.ts?mtime-real-write");
    _clearPrLinkFieldsCache();
    const path = card("kobo", "kobo-2", { state: "review", pr: 11, repo: "acme/before" });
    expect(openPrLinkedRepos()).toEqual(["acme/before"]);

    // simulate another pane's `maw task comment`/edit: an ordinary write, real mtime bump
    writeFileSync(path, JSON.stringify({ id: "kobo-2", company: "kobo", title: "kobo-2", ts: 1, state: "review", pr: 11, repo: "acme/after" }));

    expect(openPrLinkedRepos()).toEqual(["acme/after"]); // fresh value, not stale
  });

  it("a deleted card's repo does not linger in the cache", async () => {
    const { openPrLinkedRepos, _clearPrLinkFieldsCache } = await import("./pr-watch.ts?mtime-evict");
    _clearPrLinkFieldsCache();
    const path = card("kobo", "kobo-3", { state: "review", pr: 12, repo: "acme/gone" });
    expect(openPrLinkedRepos()).toEqual(["acme/gone"]);

    rmSync(path);
    expect(openPrLinkedRepos()).toEqual([]); // evicted, not resurrected from cache
  });

  it("a newly PR-linked card is discovered on the tick after it changes, even with a warm cache from prior ticks", async () => {
    const { openPrLinkedRepos, _clearPrLinkFieldsCache } = await import("./pr-watch.ts?mtime-newcard");
    _clearPrLinkFieldsCache();
    card("kobo", "kobo-4", { state: "in-progress" }); // no pr yet — not linked
    expect(openPrLinkedRepos()).toEqual([]); // warms cache with this card's fields (no pr)

    // later tick: same card gets a PR stamped on it (a real write)
    const path = join(root, "companies", "kobo", "tasks", "kobo-4.json");
    writeFileSync(path, JSON.stringify({ id: "kobo-4", company: "kobo", title: "kobo-4", ts: 1, state: "review", pr: 13, repo: "acme/new" }));
    expect(openPrLinkedRepos()).toEqual(["acme/new"]);
  });
});

describe("pr-watch end-to-end through the cached repo-discovery path (kobo-534)", () => {
  let ghDir: string;

  function fakeGh(prListJson: string, prViewJson = '{"mergedBy":{"login":"someone"}}') {
    ghDir = mkdtempSync(join(tmpdir(), "fake-gh-bin-"));
    const script = `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  cat "$FAKE_GH_PR_LIST"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "$FAKE_GH_PR_VIEW"
  exit 0
fi
echo "[]"
exit 0
`;
    const ghPath = join(ghDir, "gh");
    writeFileSync(ghPath, script);
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${ghDir}:${ORIG_PATH}`;
    const listPath = join(ghDir, "pr-list.json");
    const viewPath = join(ghDir, "pr-view.json");
    writeFileSync(listPath, prListJson);
    writeFileSync(viewPath, prViewJson);
    process.env.FAKE_GH_PR_LIST = listPath;
    process.env.FAKE_GH_PR_VIEW = viewPath;
    return { setList: (json: string) => writeFileSync(listPath, json) };
  }

  afterEach(() => {
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_PR_VIEW;
    try { rmSync(ghDir, { recursive: true, force: true }); } catch {}
  });

  it("PR open -> card moves to review, then PR merge -> card moves to done, across three ticks 120s apart", async () => {
    const mod = await import("./pr-watch.ts?e2e-lifecycle");
    const { readTask } = await import("./../tasks/store.ts?e2e-lifecycle");
    mod._clearPrLinkFieldsCache();

    // tick 0: pr-watch's FIRST EVER poll always seeds a baseline snapshot and never
    // acts on it (pr-watch.ts's own `if (firstRun) continue` — "seed baseline only,
    // no retroactive spam" for whatever already existed when watching started). Real
    // pr-watch has been running for a long time so this already happened months ago;
    // reproduce that here with an empty repo list so our PR 900 doesn't exist yet.
    const gh = fakeGh(JSON.stringify([]));
    await mod.pollPrsOnce();

    card("kobo", "kobo-77", { state: "in-progress", pr: 900, assignee: "patchwork", repo: "acme/live" });
    gh.setList(JSON.stringify([{ number: 900, title: "the fix", state: "OPEN", mergedAt: null, author: { login: "patchwork" } }]));

    // tick 1: PR 900 appears OPEN for the first time (snapshot already seeded, so this
    // is a genuine never-seen-this-key transition) -> card should flip to review
    await mod.pollPrsOnce();
    expect(readTask("kobo", "kobo-77")?.state).toBe("review");

    // tick 2 (simulating 120s later): PR is now MERGED -> card should flip to done/wait-for-deploy
    gh.setList(JSON.stringify([{ number: 900, title: "the fix", state: "MERGED", mergedAt: "2026-07-28T00:00:00Z", author: { login: "patchwork" } }]));
    await mod.pollPrsOnce();
    const finalState = readTask("kobo", "kobo-77")?.state;
    expect(["done", "wait-for-deploy"]).toContain(finalState); // kobo-274: has-PR defaults to wait-for-deploy
  });
});
