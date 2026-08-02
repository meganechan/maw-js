import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRosterRequest } from "./route";
import { appendWorklog } from "../worklog/store";

const dir = mkdtempSync(join(tmpdir(), "maw-roster-route-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  // an open worklog claim — the ownership signal /api/roster still projects now
  // that the board's in-progress-card half retired with the task subsystem.
  appendWorklog({ ts: 1, iso: "x", oracle: "patchwork", company: "kobo", kind: "claim", summary: "claim: kobo-1", task: "kobo-1" });
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("handleRosterRequest", () => {
  test("held is projected from open worklog claims", async () => {
    const res = handleRosterRequest(new Request("http://x/api/roster?company=kobo"));
    const body = (await res.json()) as { company: string; held: Record<string, { id: string; kind: string }[]> };
    expect(body.company).toBe("kobo");
    expect(body.held.patchwork?.map((h) => h.id)).toEqual(["kobo-1"]);
    expect(body.held.patchwork?.[0]?.kind).toBe("claim");
  });

  test("no ?company → empty envelope, never an error", async () => {
    const res = handleRosterRequest(new Request("http://x/api/roster"));
    const body = (await res.json()) as { company: null; roster: unknown[]; held: Record<string, unknown> };
    expect(body.company).toBeNull();
    expect(body.roster).toEqual([]);
    expect(body.held).toEqual({});
  });

  test("the retired `pending` card projection is no longer shipped, with or without the opt-in", async () => {
    for (const q of ["?company=kobo", "?company=kobo&pending=1"]) {
      const body = (await handleRosterRequest(new Request(`http://x/api/roster${q}`)).json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("pending");
    }
  });
});
