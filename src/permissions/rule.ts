import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import picomatch from "picomatch";
import { analyzeShellCommand, effectiveCommandTokens, shellTokens } from "./shell-command.js";
import type {
  ParsedRule,
  PermissionCheckResult,
  PermissionDecision,
  PermissionQuery,
  PermissionRule,
  PermissionRuleSet,
} from "./types.js";

const KNOWN_TOOLS = new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Lsp",
  "WebFetch",
  "WebSearch",
  "*",
]);

const RULE_SHAPE = /^([A-Za-z_*][A-Za-z0-9_]*)(?:\(([^)]*)\))?$/;

/**
 * Parse a single rule string, e.g. `Bash(git status:*)`.
 *
 * Whitespace around the whole expression is trimmed; whitespace inside the
 * pattern is preserved (Bash patterns are tokenized later, paths may legitimately
 * contain spaces inside globs).
 */
export function parseRule(input: string): ParsedRule {
  const source = input;
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      ok: false,
      error: { source, message: "Rule is empty." },
    };
  }

  const match = RULE_SHAPE.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: {
        source,
        message: `Rule must look like "Tool" or "Tool(pattern)"; got: ${trimmed}`,
      },
    };
  }

  const tool = match[1];
  const rawPattern = match[2];

  if (tool !== "*" && !KNOWN_TOOLS.has(tool)) {
    // Allow unknown tool names through — future MCP tools etc. can reuse this
    // parser. But empty bodies with no paren and unknown names are fine too.
  }

  const pattern = rawPattern !== undefined ? rawPattern.trim() : undefined;

  if (pattern !== undefined && pattern.length === 0) {
    return {
      ok: false,
      error: {
        source,
        message: `Rule has empty parentheses; drop the parens to match all uses of ${tool}.`,
      },
    };
  }

  return {
    ok: true,
    rule: { tool, pattern, source },
  };
}

/**
 * Parse a list of rule strings. Invalid entries are reported in `errors`; valid
 * ones populate `rules`. Callers decide whether to surface errors or ignore.
 */
export function parseRules(inputs: string[]): {
  rules: PermissionRule[];
  errors: { source: string; message: string }[];
} {
  const rules: PermissionRule[] = [];
  const errors: { source: string; message: string }[] = [];
  for (const input of inputs) {
    const parsed = parseRule(input);
    if (parsed.ok) {
      rules.push(parsed.rule);
    } else {
      errors.push(parsed.error);
    }
  }
  return { rules, errors };
}

/**
 * Does `rule` match `query`?
 *
 * Tool name must match (or rule.tool is "*"; `mcp__server` covers every
 * `mcp__server__tool`). If the rule has no pattern, it matches any use of that
 * tool. Otherwise the tool-specific matcher decides. `list` matters for Bash:
 * an allow rule must cover every command a compound command runs, while a
 * deny rule fires if it covers any of them.
 */
export function matchRule(
  rule: PermissionRule,
  query: PermissionQuery,
  list: "allow" | "deny" = "allow",
): boolean {
  if (rule.tool !== "*" && rule.tool !== query.tool && !isMcpServerRule(rule, query)) {
    return false;
  }

  if (rule.pattern === undefined) {
    return true;
  }

  const toolKey = rule.tool === "*" ? query.tool : rule.tool;

  switch (toolKey) {
    case "Bash":
      if (!("command" in query) || typeof query.command !== "string") return false;
      return list === "deny"
        ? bashDenyMatches(rule.pattern, query.command)
        : bashAllowMatches(rule.pattern, query.command);
    case "Read":
    case "Write":
    case "Edit":
    case "Lsp":
      if (!("path" in query) || !("cwd" in query)) return false;
      return matchPath(rule.pattern, query.path as string, query.cwd as string);
    case "WebFetch":
      if (!("url" in query) || typeof query.url !== "string") return false;
      return matchDomain(rule.pattern, query.url);
    case "WebSearch":
      // WebSearch rules only support tool-level match for v1.
      return false;
    default:
      // Unknown tool with a pattern: be conservative, don't match.
      return false;
  }
}

/**
 * Evaluate a rule set against a query. Deny wins; otherwise first allow wins;
 * otherwise "ask".
 */
export function checkPermission(
  rules: PermissionRuleSet,
  query: PermissionQuery,
): PermissionCheckResult {
  for (const rule of rules.deny) {
    if (matchRule(rule, query, "deny")) {
      return { decision: "deny", rule };
    }
  }
  if (query.tool === "Bash" && "command" in query && typeof query.command === "string") {
    return checkBashAllow(rules.allow, query.command);
  }
  for (const rule of rules.allow) {
    if (matchRule(rule, query, "allow")) {
      return { decision: "allow", rule };
    }
  }
  return { decision: "ask" };
}

/**
 * A compound command is allowed when every simple command in it is covered
 * by some allow rule (different rules may cover different parts), and it has
 * nothing opaque — unless a rule grants any command (`Bash`, `*`, `Bash(:*)`).
 */
function checkBashAllow(allowRules: PermissionRule[], command: string): PermissionCheckResult {
  const bashRules = allowRules.filter((rule) => rule.tool === "Bash" || rule.tool === "*");
  const anyCommand = bashRules.find((rule) =>
    rule.pattern === undefined || tokenize(rule.pattern).join(" ") === ":*",
  );
  if (anyCommand) return { decision: "allow", rule: anyCommand };

  const analysis = analyzeShellCommand(command);
  if (analysis.opaque || analysis.segments.length === 0) return { decision: "ask" };
  let first: PermissionRule | undefined;
  for (const segment of analysis.segments) {
    const tokens = shellTokens(segment);
    const rule = bashRules.find((candidate) => matchBash(candidate.pattern!, tokens));
    if (!rule) return { decision: "ask" };
    first ??= rule;
  }
  return first ? { decision: "allow", rule: first } : { decision: "ask" };
}

// --- per-tool matchers ---------------------------------------------------

/** `mcp__github` (no pattern) covers every tool of that MCP server. */
function isMcpServerRule(rule: PermissionRule, query: PermissionQuery): boolean {
  return rule.pattern === undefined
    && rule.tool.startsWith("mcp__")
    && query.tool.startsWith(`${rule.tool}__`);
}

/**
 * Allow: every simple command the line runs must match, and nothing opaque
 * (substitution, file redirection, heredoc) may ride along.
 */
function bashAllowMatches(pattern: string, command: string): boolean {
  // `Bash(:*)` is an explicit "any command" grant.
  if (tokenize(pattern).join(" ") === ":*") return true;
  const analysis = analyzeShellCommand(command);
  if (analysis.opaque || analysis.segments.length === 0) return false;
  return analysis.segments.every((segment) => matchBash(pattern, shellTokens(segment)));
}

/**
 * Deny: any simple command matching — as written, or with leading
 * assignments/wrappers (`sudo`, `env`, ...) stripped — blocks the line.
 */
function bashDenyMatches(pattern: string, command: string): boolean {
  const analysis = analyzeShellCommand(command);
  if (analysis.segments.length === 0) return matchBash(pattern, shellTokens(command));
  return analysis.segments.some((segment) =>
    matchBash(pattern, shellTokens(segment)) || matchBash(pattern, effectiveCommandTokens(segment)),
  );
}

/**
 * Bash pattern matching.
 *
 * - `git status`     → command tokens equal ["git","status"] exactly
 * - `git status:*`   → command tokens start with ["git","status"]
 *
 * Matches one simple command's tokens; bashAllowMatches / bashDenyMatches
 * split compound commands first (see shell-command.ts).
 */
function matchBash(pattern: string, cmdTokens: string[]): boolean {
  let ruleTokens = tokenize(pattern);
  let prefixMatch = false;

  if (ruleTokens.length > 0) {
    const last = ruleTokens[ruleTokens.length - 1];
    if (last === ":*") {
      prefixMatch = true;
      ruleTokens = ruleTokens.slice(0, -1);
    } else if (last.endsWith(":*")) {
      prefixMatch = true;
      ruleTokens = ruleTokens.slice(0, -1).concat([last.slice(0, -2)]);
    }
  }

  if (ruleTokens.length === 0) {
    return prefixMatch; // `Bash(:*)` would match anything; keep behavior defined
  }

  if (prefixMatch) {
    if (ruleTokens.length > cmdTokens.length) return false;
    return ruleTokens.every((tok, i) => tok === cmdTokens[i]);
  }

  if (ruleTokens.length !== cmdTokens.length) return false;
  return ruleTokens.every((tok, i) => tok === cmdTokens[i]);
}

/**
 * Path pattern matching via picomatch (glob). The rule pattern is expanded for
 * `~` (home) and resolved relative to cwd if not absolute. The query path is
 * resolved the same way to compare canonical absolute paths.
 */
function matchPath(pattern: string, queryPath: string, cwd: string): boolean {
  const expandedPattern = expandHome(pattern);
  const absolutePattern = isAbsolute(expandedPattern)
    ? expandedPattern
    : resolve(cwd, expandedPattern);
  const absoluteQuery = isAbsolute(queryPath)
    ? queryPath
    : resolve(cwd, queryPath);

  const matcher = picomatch(absolutePattern, { dot: true });
  return matcher(absoluteQuery);
}

/**
 * WebFetch domain matching. Pattern must be `domain:<host>`. Match is true if
 * the URL host equals `<host>` or is a subdomain of it.
 *
 *   domain:github.com → matches https://github.com/... and https://api.github.com/...
 */
function matchDomain(pattern: string, url: string): boolean {
  const prefix = "domain:";
  if (!pattern.startsWith(prefix)) return false;
  const expectedHost = pattern.slice(prefix.length).trim().toLowerCase();
  if (!expectedHost) return false;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (host === expectedHost) return true;
  return host.endsWith("." + expectedHost);
}

// --- small helpers -------------------------------------------------------

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Convenience: given raw `allow`/`deny` string arrays from settings, produce a
 * ready-to-use rule set (silently dropping parse errors — callers that want
 * diagnostics should call parseRules directly).
 */
export function buildRuleSet(allow: string[], deny: string[]): PermissionRuleSet {
  return {
    allow: parseRules(allow).rules,
    deny: parseRules(deny).rules,
  };
}

export type { PermissionDecision };
