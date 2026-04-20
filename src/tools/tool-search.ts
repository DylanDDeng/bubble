/**
 * tool_search — meta-tool that loads schemas for deferred tools on demand.
 *
 * Mirrors Claude Code's ToolSearch. Two query modes:
 *
 *   - "select:a,b,c"  → fetch these exact tools by name (ignores ranking)
 *   - free text       → rank deferred tools by substring match against name
 *                       and description, return the top N
 *
 * Output is a <functions>…</functions> block containing one
 * `<function>{schema JSON}</function>` per match — the same encoding the
 * provider uses for the tool list at the top of the prompt. The matched
 * tools are also unlocked on the agent so subsequent turns include them in
 * the real tool list.
 */

import type { ToolRegistryEntry, ToolResult } from "../types.js";

export interface ToolSearchController {
  /** All deferred tools in the current session, whether unlocked or not. */
  listDeferred: () => ToolRegistryEntry[];
  /** Mark a set of deferred tool names as unlocked. */
  unlock: (names: string[]) => void;
}

export function createToolSearchTool(controller: ToolSearchController): ToolRegistryEntry {
  return {
    name: "tool_search",
    readOnly: true,
    description:
      'Fetches full schema definitions for deferred tools so they can be called. ' +
      'Deferred tools appear by name in <system-reminder> messages; their parameters are unknown ' +
      'until loaded. Use this tool with query "select:<name>[,<name>...]" to load specific tools, ' +
      'or with free-text keywords to search for relevant tools.',
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Query to find deferred tools. Use "select:<name>,<name>" for direct selection, or keywords to search.',
        },
        max_results: {
          type: "number",
          description: "Maximum number of matches to return (default 5).",
        },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query : "";
      const maxResults = typeof args.max_results === "number" && args.max_results > 0
        ? Math.min(Math.floor(args.max_results), 25)
        : 5;

      const deferred = controller.listDeferred();
      if (deferred.length === 0) {
        return { content: "No deferred tools are registered in this session." };
      }

      let matches: ToolRegistryEntry[];
      const selectPrefix = "select:";
      if (query.startsWith(selectPrefix)) {
        const names = new Set(
          query
            .slice(selectPrefix.length)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        matches = deferred.filter((t) => names.has(t.name));
        if (matches.length === 0) {
          const available = deferred.map((t) => t.name).join(", ");
          return {
            content: `No deferred tool matched select list. Known deferred tools: ${available}`,
            isError: true,
          };
        }
      } else {
        matches = rankByKeywords(deferred, query).slice(0, maxResults);
        if (matches.length === 0) {
          return {
            content: `No deferred tools matched "${query}". Use query "select:<name>" to fetch by exact name, or try different keywords.`,
          };
        }
      }

      controller.unlock(matches.map((t) => t.name));

      const lines = ["<functions>"];
      for (const tool of matches) {
        const schema = {
          description: tool.description,
          name: tool.name,
          parameters: tool.parameters,
        };
        lines.push(`<function>${JSON.stringify(schema)}</function>`);
      }
      lines.push("</functions>");
      lines.push("");
      lines.push(`Loaded ${matches.length} tool${matches.length === 1 ? "" : "s"}. They are now available and callable on the next turn.`);
      return { content: lines.join("\n") };
    },
  };
}

function rankByKeywords(tools: ToolRegistryEntry[], rawQuery: string): ToolRegistryEntry[] {
  const terms = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of terms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const scored: Array<{ tool: ToolRegistryEntry; score: number }> = [];
  for (const tool of tools) {
    const haystack = `${tool.name} ${tool.description}`.toLowerCase();
    if (!requiredTerms.every((t) => haystack.includes(t))) continue;
    let score = 0;
    for (const t of optionalTerms) {
      if (tool.name.toLowerCase().includes(t)) score += 3;
      if (tool.description.toLowerCase().includes(t)) score += 1;
    }
    if (requiredTerms.length > 0 && optionalTerms.length === 0) {
      // Required-only query: every required term already matched, surface by name strength.
      score = requiredTerms.reduce(
        (acc, t) => acc + (tool.name.toLowerCase().includes(t) ? 3 : 1),
        0,
      );
    }
    if (score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.tool);
}
