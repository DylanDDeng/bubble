import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../web-fetch.js";

describe("web fetch tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns MCP crawling results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'data: {"result":{"content":[{"type":"text","text":"Fetched page content"}]}}\n\n',
    }));

    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.com" }, { cwd: process.cwd() });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Fetched page content");
  });

  it("calls the crawling_exa remote tool", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'data: {"result":{"content":[{"type":"text","text":"Fetched page content"}]}}\n\n',
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebFetchTool();
    await tool.execute({ url: "https://example.com", query: "pricing" }, { cwd: process.cwd() });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.name).toBe("crawling_exa");
    expect(body.params.arguments.urls).toEqual(["https://example.com"]);
    expect(body.params.arguments.summary).toEqual({ query: "pricing" });
  });
});
