import { describe, expect, it } from "vitest";
import { createTwoFilesPatch } from "diff";
import { parseDiffHunks } from "../approval/diff-hunks.js";

const SINGLE_HUNK = createTwoFilesPatch(
  "a.ts",
  "a.ts",
  "line 1\nline 2\nline 3\nline 4\n",
  "line 1\nline TWO\nline 3\nline 4\n",
  "original",
  "modified",
  { context: 3 },
);

describe("parseDiffHunks", () => {
  it("extracts a single hunk with body lines", () => {
    const hunks = parseDiffHunks(SINGLE_HUNK);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header.startsWith("@@")).toBe(true);
    expect(hunks[0].lines.some((l) => l.startsWith("-line 2"))).toBe(true);
    expect(hunks[0].lines.some((l) => l.startsWith("+line TWO"))).toBe(true);
  });

  it("strips Index:/---/+++ headers", () => {
    const hunks = parseDiffHunks(SINGLE_HUNK);
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        expect(line.startsWith("---")).toBe(false);
        expect(line.startsWith("+++")).toBe(false);
        expect(line.startsWith("Index:")).toBe(false);
      }
    }
  });

  it("parses multiple hunks with separate headers", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 5", "line FIVE").replace("line 25", "line TWENTY-FIVE");
    const multi = createTwoFilesPatch("f.ts", "f.ts", before, after, "a", "b", { context: 2 });
    const hunks = parseDiffHunks(multi);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    for (const h of hunks) expect(h.header.startsWith("@@")).toBe(true);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseDiffHunks("")).toEqual([]);
  });

  it("ignores trailing '\\ No newline' markers", () => {
    const raw = [
      "--- a.ts",
      "+++ a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const hunks = parseDiffHunks(raw);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual(["-old", "+new"]);
  });
});
