import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { heldWorkByOracle } from "./held";
import { appendWorklog } from "../worklog/store";

const dir = mkdtempSync(join(tmpdir(), "maw-held-"));
const prev = process.env.MAW_DATA_DIR;

function claim(company: string, oracle: string, task: string) {
  appendWorklog({ ts: 1, iso: "x", oracle, company, kind: "claim", summary: `claim: ${task}`, task });
}
function release(company: string, oracle: string, task: string) {
  appendWorklog({ ts: 2, iso: "x", oracle, company, kind: "claim-release", summary: `release: ${task}`, task });
}

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  // open worklog claims held by eq3
  claim("kobo", "eq3", "kobo-200");
  claim("kobo", "eq3", "kobo-202");
  // a released claim must NOT count
  claim("kobo", "neo", "kobo-201");
  release("kobo", "neo", "kobo-201");
  // another company's claim must not leak in
  claim("pgw", "thawanban", "pgw-1");
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("heldWorkByOracle", () => {
  test("folds open worklog claims per oracle, ignoring released ones", () => {
    const held = heldWorkByOracle("kobo");
    expect(held.eq3?.map((h) => h.id).sort()).toEqual(["kobo-200", "kobo-202"]);
    expect(held.eq3?.every((h) => h.kind === "claim")).toBe(true);
    // released → the oracle drops out of the map entirely (a truly-idle oracle stays grey)
    expect(held.neo).toBeUndefined();
  });

  test("duplicate claims on the same id fold to one entry", () => {
    claim("kobo", "eq3", "kobo-200");
    expect(heldWorkByOracle("kobo").eq3?.filter((h) => h.id === "kobo-200").length).toBe(1);
  });

  test("scoped to the company asked for", () => {
    expect(heldWorkByOracle("pgw").thawanban?.map((h) => h.id)).toEqual(["pgw-1"]);
    expect(heldWorkByOracle("pgw").eq3).toBeUndefined();
  });

  test("null / unknown company → empty map, never throws", () => {
    expect(heldWorkByOracle(null)).toEqual({});
    expect(heldWorkByOracle("no-such-company")).toEqual({});
  });
});
