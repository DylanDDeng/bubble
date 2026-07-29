import type { ParsedToolCall } from "../types.js";

export type ToolFamily = "search" | "read" | "write" | "edit" | "shell" | "web" | "other";

export interface SearchIntent {
  pattern: string;
  path?: string;
  include?: string;
  signature: string;
  familyKey: string;
}

export interface ReadIntent {
  path: string;
  offset?: number | string;
  limit?: number | string;
  signature: string;
  familyKey: string;
}

export interface ToolIntent {
  family: ToolFamily;
  search?: SearchIntent;
  read?: ReadIntent;
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
      const parsedRead = parseReadBashCommand(stringArg(toolCall.parsedArgs.command));
      if (parsedRead) {
        return {
          family: "read",
          read: buildReadIntent(parsedRead.path, parsedRead.offset, parsedRead.limit),
        };
      }
      return { family: "shell" };
    }
    case "read":
      return {
        family: "read",
        read: buildReadIntent(
          stringArg(toolCall.parsedArgs.path ?? toolCall.parsedArgs.file),
          numberOrStringArg(toolCall.parsedArgs.offset),
          numberOrStringArg(toolCall.parsedArgs.limit),
        ),
      };
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
  /**
   * True only when a structured-grep rewrite would execute EXACTLY what the
   * model asked for. False whenever anything was dropped or reinterpreted:
   * unknown flags (-i, -A, -w, ...), --iglob (case-insensitivity lost),
   * --include under rg (not an rg flag - a faithful run would error), more
   * than one path, or the `grep` binary itself (BRE dialect vs the tool's
   * rg engine). Observation (intent classification) tolerates lossy parses;
   * execution rewriting must not (tool-arbiter).
   */
  lossless: boolean;
}

export interface ParsedReadCommand {
  path: string;
  offset?: number | string;
  limit?: number | string;
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

  // The structured grep tool shells out to rg, so only rg-origin commands
  // can be dialect-identical; GNU grep patterns are BRE and must not be
  // silently re-executed under rg's Rust regex engine.
  let lossless = binary !== "grep";

  const positional: string[] = [];
  let include: string | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--glob" || token === "--iglob" || token === "--include") {
      include = tokens[index + 1];
      // --iglob loses case-insensitivity in translation; --include is not an
      // rg flag at all (a faithful run would error, and hiding that from the
      // model masks its mistake). Only --glob maps 1:1 onto the tool.
      if (token !== "--glob") lossless = false;
      index += 1;
      continue;
    }
    if (token.startsWith("--glob=") || token.startsWith("--iglob=") || token.startsWith("--include=")) {
      include = token.slice(token.indexOf("=") + 1);
      if (!token.startsWith("--glob=")) lossless = false;
      continue;
    }
    if (token.startsWith("-")) {
      // Any other flag (-i, -A 3, -w, -l, ...) has no representation in the
      // structured tool; dropping it would change the search's meaning.
      lossless = false;
      continue;
    }
    positional.push(token);
  }

  if (positional.length === 0) {
    return undefined;
  }

  // A third positional (multiple search roots) cannot be expressed either.
  if (positional.length > 2) lossless = false;

  const [pattern, maybePath] = positional;
  return {
    pattern,
    path: maybePath,
    include,
    lossless,
  };
}

export function parseReadBashCommand(command: string): ParsedReadCommand | undefined {
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
  if (binary === "cat" || binary === "nl") {
    const path = lastPositional(tokens.slice(1));
    return path ? { path } : undefined;
  }

  if (binary === "head") {
    const { path, lineCount } = parseHeadTailArgs(tokens.slice(1));
    return path ? { path, offset: 1, limit: lineCount ?? "head" } : undefined;
  }

  if (binary === "tail") {
    const { path, lineCount } = parseHeadTailArgs(tokens.slice(1));
    return path ? { path, offset: `tail:${lineCount ?? "default"}`, limit: lineCount ?? "tail" } : undefined;
  }

  if (binary === "sed") {
    return parseSedReadCommand(tokens.slice(1));
  }

  return undefined;
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

function buildReadIntent(path: string, offset?: number | string, limit?: number | string): ReadIntent {
  const normalizedPath = normalizePath(path || ".");
  const normalizedOffset = offset ?? 1;
  const normalizedLimit = limit ?? "default";
  return {
    path,
    offset,
    limit,
    signature: `${normalizedPath}::${normalizedOffset}::${normalizedLimit}`,
    familyKey: normalizedPath,
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

function numberOrStringArg(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function lastPositional(tokens: string[]): string | undefined {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      return token;
    }
  }
  return undefined;
}

function parseHeadTailArgs(tokens: string[]): { path?: string; lineCount?: number } {
  let lineCount: number | undefined;
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "-n" || token === "--lines") {
      lineCount = parseLineCount(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("-n") && token.length > 2) {
      lineCount = parseLineCount(token.slice(2));
      continue;
    }
    if (token.startsWith("--lines=")) {
      lineCount = parseLineCount(token.slice("--lines=".length));
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    positional.push(token);
  }
  return {
    path: positional[positional.length - 1],
    lineCount,
  };
}

function parseSedReadCommand(tokens: string[]): ParsedReadCommand | undefined {
  const positional: string[] = [];
  for (const token of tokens) {
    if (token === "-n" || token.startsWith("-")) {
      continue;
    }
    positional.push(token);
  }
  if (positional.length < 2) {
    return undefined;
  }

  const expression = positional[0];
  const path = positional[positional.length - 1];
  const range = expression.match(/^(\d+)(?:,(\d+))?p$/);
  if (!range) {
    return { path, offset: expression };
  }
  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : start;
  return {
    path,
    offset: start,
    limit: Math.max(1, end - start + 1),
  };
}

function parseLineCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace(/^\+/, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function shellSplit(command: string): string[] {
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
