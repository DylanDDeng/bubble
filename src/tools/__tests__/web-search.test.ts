import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../web-search.js";

describe("web search tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns MCP text results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'data: {"result":{"content":[{"type":"text","text":"Result A\\nResult B"}]}}\n\n',
    }));

    const tool = createWebSearchTool();
    const result = await tool.execute({ query: "example" }, { cwd: process.cwd() });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Result A");
    expect(result.content).toContain("Result B");
  });

  it("returns a useful error for HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream failure",
    }));

    const tool = createWebSearchTool();
    const result = await tool.execute({ query: "example" }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("status 500");
    expect(result.content).toContain("upstream failure");
  });
});
