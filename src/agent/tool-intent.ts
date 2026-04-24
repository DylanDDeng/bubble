import type { ParsedToolCall } from "../types.js";

export type ToolFamily = "search" | "read" | "write" | "edit" | "shell" | "web" | "other";

export interface SearchIntent {
  pattern: string;
  path?: string;
  include?: string;
  signature: string;
  familyKey: string;
}

export interface ToolIntent {
  family: ToolFamily;
  search?: SearchIntent;
}

const SEARCH_TOKEN_CANONICAL = new Map<string, string>([
  ["api_key", "secret"],
  ["apikey", "secret"],
  ["api", "secret"],
  ["key", "secret"],
  ["keys", "secret"],
  ["secret", "secret"],
  ["secrets", "secret"],
  ["token", "secret"],
  ["tokens", "secret"],
  ["credential", "secret"],
  ["credentials", "secret"],
  ["auth", "secret"],
  ["password", "secret"],
  ["passwd", "secret"],
  ["bearer", "secret"],
  ["env", "config"],
  ["config", "config"],
  ["dotenv", "config"],
]);

export function analyzeToolIntent(toolCall: Pick<ParsedToolCall, "name" | "parsedArgs">): ToolIntent {
  switch (toolCall.name) {
    case "glob":
      return {
        family: "search",
        search: buildSearchIntent(
          stringArg(toolCall.parsedArgs.pattern),
          stringArg(toolCall.parsedArgs.path),
        ),
      };
    case "grep":
      return {
        family: "search",
        search: buildSearchIntent(
          stringArg(toolCall.parsedArgs.pattern),
          stringArg(toolCall.parsedArgs.path),
          stringArg(toolCall.parsedArgs.glob),
        ),
      };
    case "bash": {
      const parsed = parseSearchBashCommand(stringArg(toolCall.parsedArgs.command));
      if (parsed) {
        return {
          family: "search",
          search: buildSearchIntent(parsed.pattern, parsed.path, parsed.include),
        };
      }
      return { family: "shell" };
    }
    case "read":
      return { family: "read" };
    case "write":
      return { family: "write" };
    case "edit":
      return { family: "edit" };
    case "web_search":
    case "web_fetch":
      return { family: "web" };
    default:
      return { family: "other" };
  }
}

export interface ParsedSearchCommand {
  pattern: string;
  path?: string;
  include?: string;
}

export function parseSearchBashCommand(command: string): ParsedSearchCommand | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/[|;&><`]/.test(trimmed)) {
    return undefined;
  }

  const tokens = shellSplit(trimmed);
  if (tokens.length === 0) {
    return undefined;
  }

  const binary = tokens[0];
  if (!["grep", "rg", "ripgrep"].includes(binary)) {
    return undefined;
  }

  const positional: string[] = [];
  let include: string | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--glob" || token === "--iglob" || token === "--include") {
      include = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--glob=") || token.startsWith("--iglob=") || token.startsWith("--include=")) {
      include = token.slice(token.indexOf("=") + 1);
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    positional.push(token);
  }

  if (positional.length === 0) {
    return undefined;
  }

  const [pattern, maybePath] = positional;
  return {
    pattern,
    path: maybePath,
    include,
  };
}

function buildSearchIntent(pattern: string, path?: string, include?: string): SearchIntent {
  const normalizedPath = normalizePath(path ?? ".");
  const rawNormalizedPattern = normalizeRawPattern(pattern);
  const normalizedTokens = canonicalizeSearchTokens(pattern);
  const signature = `${normalizedPath}::${include ?? "*"}::${rawNormalizedPattern || normalizedTokens.join("|")}`;
  const familyTokens = normalizedTokens.filter((token) => token === "secret" || token === "config");
  const familyKey = `${normalizedPath}::${familyTokens.join("|") || normalizedTokens.slice(0, 3).join("|") || "generic-search"}`;

  return {
    pattern,
    path,
    include,
    signature,
    familyKey,
  };
}

function canonicalizeSearchTokens(pattern: string): string[] {
  const normalized = normalizeRawPattern(pattern);
  const tokens = normalized.split(/[^a-z0-9_]+/).filter(Boolean);
  const canonical = new Set<string>();
  for (const token of tokens) {
    canonical.add(SEARCH_TOKEN_CANONICAL.get(token) ?? token);
  }
  return [...canonical].sort();
}

function normalizeRawPattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/\\s\+/g, " ").replace(/\s+/g, " ");
}

function normalizePath(pathValue: string): string {
  return pathValue.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
