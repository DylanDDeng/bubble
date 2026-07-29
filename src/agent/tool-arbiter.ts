import { analyzeToolIntent, parseSearchBashCommand } from "./tool-intent.js";
import type { ParsedToolCall } from "../types.js";

export interface ToolArbitration {
  toolCall: ParsedToolCall;
  note?: string;
}

export function arbitrateToolCall(toolCall: ParsedToolCall): ToolArbitration {
  if (toolCall.name !== "bash") {
    return { toolCall };
  }

  const command = typeof toolCall.parsedArgs.command === "string"
    ? toolCall.parsedArgs.command
    : "";
  const parsedSearch = parseSearchBashCommand(command);
  if (!parsedSearch) {
    return { toolCall };
  }
  // Rewrite ONLY when the translation is provably lossless. A lossy rewrite
  // silently changes what gets searched (e.g. `rg -i` losing its
  // case-insensitivity) and the model reasons over wrong results without any
  // way to notice. When in doubt, run the model's own command untouched.
  if (!parsedSearch.lossless) {
    return { toolCall };
  }

  return {
    toolCall: {
      ...toolCall,
      name: "grep",
      parsedArgs: {
        pattern: parsedSearch.pattern,
        ...(parsedSearch.path ? { path: parsedSearch.path } : {}),
        ...(parsedSearch.include ? { glob: parsedSearch.include } : {}),
      },
      arguments: JSON.stringify({
        pattern: parsedSearch.pattern,
        ...(parsedSearch.path ? { path: parsedSearch.path } : {}),
        ...(parsedSearch.include ? { glob: parsedSearch.include } : {}),
      }),
    },
    note: `Rewrote bash search to grep for structured execution: ${command}`,
  };
}

export function isSearchLikeToolCall(toolCall: ParsedToolCall): boolean {
  return analyzeToolIntent(toolCall).family === "search";
}
