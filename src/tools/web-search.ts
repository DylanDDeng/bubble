/**
 * Web search tool - remote MCP-backed search service.
 */

import type { ToolRegistryEntry, ToolResult } from "../types.js";

const DEFAULT_RESULTS = 8;
const MCP_URL = process.env.BUBBLE_WEB_SEARCH_URL || "https://mcp.exa.ai/mcp";

export function createWebSearchTool(): ToolRegistryEntry {
  return {
    name: "web_search",
    description: "Search the web using a remote search service and return current, structured results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query" },
        numResults: { type: "number", description: `Number of search results to return (default: ${DEFAULT_RESULTS})` },
        livecrawl: {
          type: "string",
          description: "Live crawl mode",
          enum: ["fallback", "preferred"],
        },
        type: {
          type: "string",
          description: "Search type",
          enum: ["auto", "fast", "deep"],
        },
        contextMaxCharacters: {
          type: "number",
          description: "Maximum number of characters to return in the result context",
        },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { content: "Error: query is required", isError: true };
      }

      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query,
            type: typeof args.type === "string" ? args.type : "auto",
            numResults: typeof args.numResults === "number" ? args.numResults : DEFAULT_RESULTS,
            livecrawl: typeof args.livecrawl === "string" ? args.livecrawl : "fallback",
            ...(typeof args.contextMaxCharacters === "number"
              ? { contextMaxCharacters: args.contextMaxCharacters }
              : {}),
          },
        },
      };

      const response = await fetch(MCP_URL, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "User-Agent": "bubble",
        },
        body: JSON.stringify(body),
      }).catch((error) => {
        throw new Error(error instanceof Error ? error.message : String(error));
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          content: `Error: Web search request failed with status ${response.status}${errorText ? `: ${errorText}` : ""}`,
          isError: true,
        };
      }

      const text = await response.text();
      const result = parseMcpResponse(text);
      if (!result) {
        return { content: "No search results found." };
      }

      return { content: result };
    },
  };
}

function parseMcpResponse(body: string): string | undefined {
  const lines = body.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        result?: { content?: Array<{ type?: string; text?: string }> };
      };
      const text = parsed.result?.content?.find((item) => item.type === "text")?.text;
      if (text) {
        return text;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  try {
    const parsed = JSON.parse(body) as {
      result?: { content?: Array<{ type?: string; text?: string }> };
    };
    return parsed.result?.content?.find((item) => item.type === "text")?.text;
  } catch {
    return undefined;
  }
}
