import { readMemorySummary, searchMemory, type MemorySearchScope } from "../memory/index.js";
import type { ToolRegistryEntry, ToolResult } from "../types.js";

const MEMORY_SCOPE_ENUM = ["project", "global", "all"];

/**
 * Single entry point to persistent memory: without a query it reads the
 * concise memory summary, with a query it searches memory. One schema in the
 * per-turn tool list instead of two (the read/search split cost context on
 * every turn while both modes share this file's backing code).
 */
export function createMemoryTool(cwd: string): ToolRegistryEntry {
  return {
    name: "memory",
    description:
      "Read or search persistent Bubble memory (prior project facts, user preferences, workflows, decisions, gotchas). " +
      "Without query, returns the concise memory summary (scope defaults to project). " +
      "With query, searches memory entries (scope defaults to all, project memory first).",
    readOnly: true,
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Use concrete terms such as file names, feature names, commands, or error text. Omit to read the memory summary instead.",
        },
        scope: {
          type: "string",
          enum: MEMORY_SCOPE_ENUM,
          description: "Memory scope. Defaults to project when reading the summary, all when searching.",
        },
        limit: {
          type: "number",
          description: "Maximum number of search results to return. Defaults to 12. Ignored for summary reads.",
        },
      },
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
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

function parseScope(value: unknown, fallback: MemorySearchScope = "all"): MemorySearchScope {
  return value === "project" || value === "global" || value === "all" ? value : fallback;
}
