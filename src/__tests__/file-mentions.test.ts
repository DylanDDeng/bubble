import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandAtMentions,
  filterFileSuggestions,
  findAtContext,
  invalidateFileListCache,
} from "../tui/file-mentions.js";

describe("findAtContext", () => {
  it("returns null when no @ before cursor", () => {
    expect(findAtContext("hello world", 5)).toBeNull();
  });

  it("detects @ at start of input", () => {
    const ctx = findAtContext("@src", 4);
    expect(ctx).toEqual({ start: 0, end: 4, query: "src" });
  });

  it("detects @ after whitespace", () => {
    const ctx = findAtContext("look at @src/agent", 18);
    expect(ctx).toEqual({ start: 8, end: 18, query: "src/agent" });
  });

  it("ignores @ preceded by non-whitespace (e.g., email)", () => {
    expect(findAtContext("mail user@example.com", 21)).toBeNull();
  });

  it("returns null when whitespace separates cursor from @", () => {
    expect(findAtContext("@src done", 9)).toBeNull();
  });

  it("treats empty query as valid context right after @", () => {
    const ctx = findAtContext("hey @", 5);
    expect(ctx).toEqual({ start: 4, end: 5, query: "" });
  });

  it("uses cursor position, not end-of-string", () => {
    const ctx = findAtContext("@src and @lib", 4);
    expect(ctx).toEqual({ start: 0, end: 4, query: "src" });
  });
});

describe("filterFileSuggestions", () => {
  const files = [
    "src/agent.ts",
    "src/tui/input-box.tsx",
    "src/tui/app.tsx",
    "src/tools/bash.ts",
    "README.md",
    "package.json",
  ];

  it("returns all files (capped) when query is empty", () => {
    const result = filterFileSuggestions(files, "", 3);
    expect(result).toHaveLength(3);
  });

  it("ranks basename prefix match above path substring match", () => {
    const result = filterFileSuggestions(files, "app");
    expect(result[0].path).toBe("src/tui/app.tsx");
  });

  it("matches by path prefix", () => {
    const result = filterFileSuggestions(files, "src/tui");
    const paths = result.map((r) => r.path);
    expect(paths).toContain("src/tui/input-box.tsx");
    expect(paths).toContain("src/tui/app.tsx");
  });

  it("returns empty when no match", () => {
    expect(filterFileSuggestions(files, "xyz")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const result = filterFileSuggestions(files, "README");
    expect(result[0].path).toBe("README.md");
  });
});

describe("expandAtMentions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mentions-"));
    invalidateFileListCache();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns text unchanged when no mentions", async () => {
    const result = await expandAtMentions("hello world", tmpDir);
    expect(result.text).toBe("hello world");
    expect(result.expanded).toEqual([]);
  });

  it("inlines a referenced file as a fenced block", async () => {
    await fs.writeFile(path.join(tmpDir, "hello.ts"), "export const x = 1;\n");
    const result = await expandAtMentions("look at @hello.ts please", tmpDir);
    expect(result.text).toContain("Referenced files:");
    expect(result.text).toContain("### @hello.ts");
    expect(result.text).toContain("export const x = 1;");
    expect(result.expanded).toHaveLength(1);
    expect(result.expanded[0].path).toBe("hello.ts");
  });

  it("records missing paths without altering original text", async () => {
    const result = await expandAtMentions("check @nope.ts", tmpDir);
    expect(result.missing).toEqual(["nope.ts"]);
    expect(result.text).toBe("check @nope.ts");
  });

  it("skips files that exceed the inline size cap", async () => {
    const big = Buffer.alloc(250 * 1024, 0x61).toString("utf8");
    await fs.writeFile(path.join(tmpDir, "big.txt"), big);
    const result = await expandAtMentions("see @big.txt", tmpDir);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("too large");
    expect(result.text).toContain("exceeds inline limit");
    expect(result.expanded).toEqual([]);
  });

  it("rejects paths that escape the project root", async () => {
    const result = await expandAtMentions("see @../etc/passwd", tmpDir);
    expect(result.skipped.some((s) => s.reason === "outside project")).toBe(true);
  });

  it("does not trigger on email-like @ (no preceding whitespace)", async () => {
    await fs.writeFile(path.join(tmpDir, "example.com"), "x");
    const result = await expandAtMentions("email user@example.com", tmpDir);
    expect(result.expanded).toEqual([]);
    expect(result.text).toBe("email user@example.com");
  });

  it("deduplicates repeated mentions", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), "X");
    const result = await expandAtMentions("@a.ts and @a.ts again", tmpDir);
    expect(result.expanded).toHaveLength(1);
  });
});
