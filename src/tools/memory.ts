import { readMemorySummary, searchMemory, type MemorySearchScope } from "../memory/index.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

const MEMORY_SCOPE_ENUM = ["project", "global", "all"];

export function createMemorySearchTool(cwd: string): ToolRegistryEntry {
  return {
    name: "memory_search",
    description: "Search persistent Bubble memory for prior project facts, user preferences, workflows, decisions, and gotchas.",
    readOnly: true,
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Use concrete terms such as file names, feature names, commands, or error text.",
        },
        scope: {
          type: "string",
          enum: MEMORY_SCOPE_ENUM,
          description: "Memory scope to search. Defaults to all, with project memory first.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 12.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { content: "query is required", isError: true, status: "no_match" };
      }
      const scope = parseScope(args.scope);
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(50, Math.floor(args.limit)))
        : undefined;
      const results = searchMemory(cwd, query, { scope, limit });
      if (results.length === 0) {
        return { content: `No memory matches for "${query}".`, status: "no_match" };
      }
      return {
        content: [
          `Memory search results for "${query}":`,
          ...results.flatMap((result) => [
            `- ${result.scope} ${result.path}:${result.line}`,
            `  ${result.text}`,
          ]),
        ].join("\n"),
        metadata: { kind: "search", matches: results.length },
      };
    },
  };
}

export function createMemoryReadSummaryTool(cwd: string): ToolRegistryEntry {
  return {
    name: "memory_read_summary",
    description: "Read the concise persistent memory summary for the current project, global scope, or both.",
    readOnly: true,
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: MEMORY_SCOPE_ENUM,
          description: "Memory scope to read. Defaults to project.",
        },
      },
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const scope = parseScope(args.scope, "project");
      const summaries = readMemorySummary(cwd, scope);
      if (summaries.length === 0) {
        return { content: `No ${scope} memory summary is available.`, status: "no_match" };
      }
      return {
        content: summaries.map((summary) => [
          `# ${summary.scope} memory summary`,
          `Path: ${summary.path}`,
          "",
          summary.content,
        ].join("\n")).join("\n\n---\n\n"),
        metadata: { kind: "read", matches: summaries.length },
      };
    },
  };
}

function parseScope(value: unknown, fallback: MemorySearchScope = "all"): MemorySearchScope {
  return value === "project" || value === "global" || value === "all" ? value : fallback;
}
