/**
 * Permission rule system — types.
 *
 * A rule is one entry from the `allow` / `deny` arrays of a settings file:
 *
 *   "Bash"                      → any bash command
 *   "Bash(git status)"          → exact command
 *   "Bash(npm run:*)"           → prefix (anything starting with `npm run`)
 *   "Read(./src/**)"            → glob on resolved path
 *   "Read(~/.ssh/**)"           → tilde expanded
 *   "WebFetch(domain:github.com)" → URL host match (suffix)
 *   "*"                         → any tool
 */

export type ToolName =
  | "Bash"
  | "Read"
  | "Write"
  | "Edit"
  | "Lsp"
  | "WebFetch"
  | "WebSearch"
  | string; // allow unknown tools; only tool-name-level rules will apply

export interface PermissionRule {
  /** Tool this rule applies to, or "*" for all tools. */
  tool: ToolName | "*";
  /** Tool-specific pattern. Absent means "match any use of this tool". */
  pattern?: string;
  /** Original rule text as written in config, for display and diagnostics. */
  source: string;
}

export interface PermissionRuleSet {
  allow: PermissionRule[];
  deny: PermissionRule[];
}

export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Discriminated input to the matcher. Tools only provide the fields they have.
 */
export type PermissionQuery =
  | { tool: "Bash"; command: string }
  | { tool: "Read" | "Write" | "Edit" | "Lsp"; path: string; cwd: string }
  | { tool: "WebFetch"; url: string }
  | { tool: "WebSearch" }
  | { tool: string }; // fallback for tools without structured args

export interface PermissionCheckResult {
  decision: PermissionDecision;
  /** Rule that produced the decision, if any. */
  rule?: PermissionRule;
}

export interface RuleParseError {
  source: string;
  message: string;
}

export type ParsedRule =
  | { ok: true; rule: PermissionRule }
  | { ok: false; error: RuleParseError };
