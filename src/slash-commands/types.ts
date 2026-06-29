import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspService } from "../lsp/index.js";
import type { MemoryScope } from "../memory/index.js";
import type { ThemeMode } from "../config.js";
import type { ExternalHookController } from "../hooks/controller.js";

export type SidebarMode = "auto" | "expanded" | "collapsed";

/**
 * Live progress for a manual `/compact` run, pushed to the TUI so it can render
 * a progress bar. `phase` advances collecting → summarizing → applying;
 * `streamedChars` is the running length of the streamed summary (drives the
 * bar's fill within the summarizing phase). Hosts without a UI omit the sink.
 */
export interface CompactionProgress {
  phase: "collecting" | "summarizing" | "applying";
  streamedChars: number;
}

export interface SidebarCommandState {
  mode: SidebarMode;
  visible: boolean;
  active: boolean;
}

export interface SlashCommandContext {
  agent: Agent;
  addMessage: (role: "user" | "assistant" | "error", content: string) => void;
  clearMessages: () => void;
  cwd: string;
  exit: () => void;
  sessionManager?: SessionManager;
  createProvider: (providerId: string, apiKey: string, baseURL: string) => Provider;
  openPicker: (mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "feishu-setup" | "agents", providerId?: string) => void;
  registry: ProviderRegistry;
  skillRegistry: SkillRegistry;
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  hookController?: ExternalHookController;
  mcpManager?: McpManager;
  lspService?: LspService;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: MemoryScope) => Promise<string>;
  runMemoryRefresh?: (scope?: MemoryScope) => Promise<string>;
  /** Get the current theme mode (auto/light/dark) — undefined when running in non-TUI contexts. */
  getThemeMode?: () => ThemeMode;
  /** Get the resolved active theme (always light or dark) — undefined when running in non-TUI contexts. */
  getResolvedTheme?: () => "light" | "dark";
  /** Persist a new theme mode AND apply it to the running TUI. */
  setThemeMode?: (mode: ThemeMode) => void;
  /** Toggle the right session sidebar in the running TUI. */
  toggleSidebar?: () => SidebarCommandState;
  /** Set the right session sidebar mode in the running TUI. */
  setSidebarMode?: (mode: SidebarMode) => SidebarCommandState;
  /** Open the feedback dialog. `initialDescription` prefills the description field. */
  openFeedback?: (initialDescription: string) => void;
  /** Open the interactive rewind picker. When absent, /rewind falls back to a text listing. */
  openRewindPicker?: () => void;
  /** Open the interactive session picker. When absent, /session falls back to a text listing. */
  openSessionPicker?: () => void;
  /** Replace the composer/input box content (e.g. /rewind restores the rewound message for re-editing). */
  fillComposer?: (text: string) => void;
  /** Open the interactive usage stats panel. */
  openStats?: () => void;
  /**
   * Push live compaction progress to the running TUI. Pass a progress object
   * while compacting and `null` to clear the indicator. Absent in non-TUI hosts.
   */
  compactionProgress?: (progress: CompactionProgress | null) => void;
}

/**
 * Return types for a slash command handler:
 *   - string | void: the string (if any) is displayed as an assistant message
 *   - { inject }: the content is sent to the agent as the user's next turn
 *     (used by MCP prompts that expand a template into a user message)
 */
export type SlashCommandOutput = string | void | { inject: string };

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandOutput>;
}
