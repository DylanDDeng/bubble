import { describe, expect, it } from "vitest";
import { createToolSearchTool } from "../tools/tool-search.js";
import type { ToolRegistryEntry } from "../types.js";

function deferredTool(name: string, description: string): ToolRegistryEntry {
  return {
    name,
    description,
    parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    deferred: true,
    async execute() {
      return { content: "ok" };
    },
  };
}

describe("tool_search", () => {
  it("selects tools by name via select: query and unlocks them", async () => {
    const deferred = [
      deferredTool("mcp__arxiv__search_papers", "Search arXiv for papers"),
      deferredTool("mcp__arxiv__download_paper", "Download a paper PDF"),
      deferredTool("mcp__github__create_issue", "Open a GitHub issue"),
    ];
    const unlocked: string[] = [];
    const tool = createToolSearchTool({
      listDeferred: () => deferred,
      unlock: (names) => unlocked.push(...names),
    });

    const result = await tool.execute(
      { query: "select:mcp__arxiv__download_paper,mcp__github__create_issue" },
      { cwd: process.cwd() },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("<functions>");
    expect(result.content).toContain('"name":"mcp__arxiv__download_paper"');
    expect(result.content).toContain('"name":"mcp__github__create_issue"');
    expect(result.content).not.toContain("search_papers");
    expect(unlocked.sort()).toEqual(["mcp__arxiv__download_paper", "mcp__github__create_issue"]);
  });

  it("reports when select: matches nothing", async () => {
    const deferred = [deferredTool("mcp__arxiv__search_papers", "Search arXiv")];
    const tool = createToolSearchTool({
      listDeferred: () => deferred,
      unlock: () => {},
    });
    const result = await tool.execute({ query: "select:nope" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("mcp__arxiv__search_papers");
  });

  it("ranks keyword search by name > description and respects max_results", async () => {
    const deferred = [
      deferredTool("search_papers", "find papers on arxiv"),
      deferredTool("download_paper", "download arxiv papers"),
      deferredTool("github_create_issue", "create a github issue"),
    ];
    const unlocked: string[] = [];
    const tool = createToolSearchTool({
      listDeferred: () => deferred,
      unlock: (names) => unlocked.push(...names),
    });

    const result = await tool.execute({ query: "arxiv papers", max_results: 2 }, { cwd: process.cwd() });
    expect(result.isError).toBeFalsy();
    // Only 2 results included.
    const matches = result.content.match(/<function>/g) ?? [];
    expect(matches).toHaveLength(2);
    // github tool should not be among top 2.
    expect(result.content).not.toContain("github_create_issue");
  });

  it("honors +required terms, filtering out tools missing the term", async () => {
    const deferred = [
      deferredTool("slack_send", "send a message on slack"),
      deferredTool("discord_send", "send a message on discord"),
    ];
    const tool = createToolSearchTool({
      listDeferred: () => deferred,
      unlock: () => {},
    });
    const result = await tool.execute({ query: "+slack send" }, { cwd: process.cwd() });
    expect(result.content).toContain("slack_send");
    expect(result.content).not.toContain("discord_send");
  });

  it("returns a friendly message when no deferred tools exist", async () => {
    const tool = createToolSearchTool({
      listDeferred: () => [],
      unlock: () => {},
    });
    const result = await tool.execute({ query: "anything" }, { cwd: process.cwd() });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("No deferred tools");
  });
});
