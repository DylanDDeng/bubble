/**
 * Process-level dependencies shared across all Feishu scopes / runs.
 *
 * Built once at serve.ts startup. Per-run dependencies (Agent,
 * SessionManager, ApprovalController) are constructed fresh by the
 * RunDriver against this shared bundle.
 */

import type { McpManager } from "../../mcp/manager.js";
import type { ProviderRegistry } from "../../provider-registry.js";
import type { SettingsManager } from "../../permissions/settings.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { UserConfig } from "../../config.js";
import type { Provider } from "../../types.js";

export interface FeishuRuntimeDeps {
  /** Read-only access to settings (allow/deny rules, LSP config). */
  settingsManager: SettingsManager;
  /** Provider registry; we resolve the active provider per run. */
  providerRegistry: ProviderRegistry;
  /** User config; per-process defaults (model, thinking level, …). */
  userConfig: UserConfig;
  /** Skill registry; tools resolve skills against it. */
  skillRegistry: SkillRegistry;
  /** Live MCP tool source; tools list includes MCP entries. */
  mcpManager: McpManager;
  /** Factory used by main provider + subagent routes. */
  createProvider: (providerId: string, apiKey: string, baseURL: string, promptCacheKey?: string) => Provider;
  createProviderForRoute: (route: { providerId: string; model: string }, promptCacheKey?: string) => Promise<Provider>;
  /** Resolved owner open_id (from config.app.ownerOpenId). */
  ownerOpenId: string;
}
