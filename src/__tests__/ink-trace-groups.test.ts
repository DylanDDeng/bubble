import { describe, expect, it } from "vitest";
import {
  buildTraceGroups,
  formatElapsed,
  formatTracePath,
  traceGroupLabel,
} from "../tui-ink/trace-groups.js";
import type { DisplayToolCall } from "../tui-ink/display-history.js";

describe("Ink trace groups", () => {
  const homeDir = "/Users/tester";

  it("groups consecutive reads into a file summary without file content preview", () => {
    const groups = buildTraceGroups([
      tool("read", { path: "/Users/tester/project/a.ts" }, "line 1\nline 2"),
      tool("read", { path: "/Users/tester/project/b.ts" }, "line 1\nline 2"),
    ], { homeDir });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "read",
      title: "Read",
      count: 2,
      noun: "files",
      items: ["~/project/a.ts", "~/project/b.ts"],
      previewLines: [],
    });
  });

  it("keeps separated read phases when another action happens between them", () => {
    const groups = buildTraceGroups([
      tool("read", { path: "/Users/tester/project/a.ts" }, "a"),
      tool("grep", { pattern: "<title>", path: "/Users/tester/project" }, "a.html:1:<title>A</title>"),
      tool("read", { path: "/Users/tester/project/b.ts" }, "b"),
    ], { homeDir });

    expect(groups.map((group) => group.title)).toEqual(["Read", "Search", "Read"]);
  });

  it("keeps partial read failures visible without marking every read as failed", () => {
    const groups = buildTraceGroups([
      tool("read", { path: "/Users/tester/project/about-bubble.html" }, "ok"),
      tool("read", { path: "/Users/tester/project/about-bubble.html" }, "ok"),
      tool("read", { path: "/Users/tester/project/deepseek-v4.html" }, "ok"),
      tool(
        "read",
        { path: "/Users/tester/project/tetris.py" },
        "Error: Cannot read file: /Users/tester/project/tetris.py",
        { isError: true },
      ),
    ], { homeDir });

    expect(groups[0]).toMatchObject({
      kind: "read",
      title: "Read",
      count: 3,
      noun: "files",
      items: [
        "~/project/about-bubble.html",
        "~/project/deepseek-v4.html",
        "~/project/tetris.py",
      ],
      errorCount: 1,
      errorLines: ["Error: Cannot read file: ~/project/tetris.py"],
      hasError: true,
    });
  });

  it("renames simple glob calls as list directory summaries", () => {
    const groups = buildTraceGroups([
      tool("glob", { pattern: "*" }, "a.html\nb.html\nsubdir"),
    ], { homeDir });

    expect(groups[0]).toMatchObject({
      kind: "list",
      title: "List Directory",
      count: 3,
      noun: "files",
      items: ["a.html", "b.html", "subdir"],
    });
  });

  it("summarizes grep calls by search pattern and scope", () => {
    const groups = buildTraceGroups([
      tool("grep", { pattern: "<title>", path: "/Users/tester/project" }, "a.html:1:<title>A</title>"),
      tool("grep", { pattern: "THREE|p5", path: "/Users/tester/project" }, "b.html:4:THREE"),
    ], { homeDir });

    expect(groups[0]).toMatchObject({
      kind: "search",
      title: "Search",
      count: 2,
      noun: "searches",
      items: ['"<title>" in ~/project', '"THREE|p5" in ~/project'],
    });
  });

  it("keeps execute commands separate and truncates output previews", () => {
    const result = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const groups = buildTraceGroups([
      tool("bash", { command: "ls -la /Users/tester/project" }, result),
    ], { homeDir, maxPreviewLines: 4 });

    expect(groups[0].kind).toBe("execute");
    expect(groups[0].command).toBe("ls -la /Users/tester/project");
    expect(groups[0].previewLines).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(groups[0].omitted).toBe(8);
  });

  it("tracks pending groups for running status labels", () => {
    const startedAt = 1_000;
    const groups = buildTraceGroups([
      tool("bash", { command: "npm test" }, undefined, { startedAt }),
    ], { homeDir });

    expect(groups[0].pending).toBe(true);
    expect(groups[0].startedAt).toBe(startedAt);
    expect(traceGroupLabel(groups[0])).toBe("Execute npm test");
    expect(formatElapsed(startedAt, 4_200)).toBe("3s");
  });

  it("summarizes edits by changed file and diff stats", () => {
    const groups = buildTraceGroups([
      tool(
        "edit",
        { path: "/Users/tester/project/a.ts" },
        "Edited file\nDiff:\n@@ -1,2 +1,2 @@\n-old\n+new\n+added",
      ),
      tool("write", { path: "/Users/tester/project/b.ts", content: "hello" }, "Wrote file"),
    ], { homeDir });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: "edit",
      title: "Edit",
      items: ["~/project/a.ts (+2 -1)"],
    });
    expect(groups[1]).toMatchObject({
      kind: "write",
      title: "Write",
      items: ["~/project/b.ts"],
    });
  });

  it("surfaces mutation error details in compact trace groups", () => {
    const groups = buildTraceGroups([
      tool(
        "write",
        {},
        "Error: The arguments for \"write\" failed to parse as JSON, indicating the tool call was truncated.",
        { isError: true },
      ),
    ], { homeDir });

    expect(groups[0]).toMatchObject({
      kind: "write",
      title: "Write",
      count: 1,
      noun: "file",
      items: [],
      previewLines: [
        "Error: The arguments for \"write\" failed to parse as JSON, indicating the tool call was truncated.",
      ],
      hasError: true,
    });
  });

  it("formats home-relative paths consistently", () => {
    expect(formatTracePath("/Users/tester/project/a.ts", homeDir)).toBe("~/project/a.ts");
    expect(formatTracePath("/tmp/a.ts", homeDir)).toBe("/tmp/a.ts");
  });
});

let toolCounter = 0;

function tool(
  name: string,
  args: Record<string, unknown>,
  result?: string,
  extra: Partial<DisplayToolCall> = {},
): DisplayToolCall {
  return {
    id: `${name}-${++toolCounter}`,
    name,
    args,
    result,
    ...extra,
  };
}
