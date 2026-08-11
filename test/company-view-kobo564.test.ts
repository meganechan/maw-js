import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAFE_ESCAPES = new Set(["'", '"', "`", "\\", "b", "f", "n", "r", "t", "v", "0", "x", "u", "$", "\n"]);

function findDangerousBackslashes(text: string): Array<{ match: string; index: number }> {
  const dangerous: Array<{ match: string; index: number }> = [];
  const re = /\\(.)/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (!SAFE_ESCAPES.has(match[1])) dangerous.push({ match: match[0], index: match.index });
  }
  return dangerous;
}

function literalSlice(relFile: string): string {
  const raw = readFileSync(join(import.meta.dir, "..", relFile), "utf8");
  expect((raw.match(/`/g) ?? [])).toHaveLength(2);
  return raw.slice(raw.indexOf("`") + 1, raw.lastIndexOf("`"));
}

describe("view template literals — no backslash silently eaten by escape-cooking", () => {
  test("messages.ts source has no unsafe backslashes", () => {
    expect(findDangerousBackslashes(literalSlice("src/views/messages.ts"))).toEqual([]);
    expect(readFileSync(join(import.meta.dir, "..", "src/views/messages.ts"), "utf8")).toContain("<!doctype html>");
  });

  test("flags a single backslash that would be eaten", () => {
    expect(findDangerousBackslashes("/(?:^|\\s)@/i").map((item) => item.match)).toContain("\\s");
  });
});
