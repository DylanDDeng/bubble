import type { Agent } from "../agent.js";
import type { SessionManager, SessionMetadata } from "../session.js";
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
import type { ExternalRuntimeManager } from "../external-runtime/types.js";
import type { ContextUsageSnapshot } from "../context/usage.js";

/**
 * Live progress for a manual `/compact` run. `phase` advances collecting →
 * summarizing → applying; interactive hosts can use it for diagnostics while
 * the visible Grok-style activity lane remains a stable `Compacting…` state.
 * Hosts without a UI omit the sink.
 */
export interface CompactionProgress {
  phase: "collecting" | "summarizing" | "applying";
  streamedChars: number;
}

export interface SlashCommandResultDetail {
  kind: "compaction-summary";
  content: string;
}

export interface SlashCommandContext {
  agent: Agent;
  addMessage: (role: "user" | "assistant" | "error", content: string) => void;
  clearMessages: () => void;
  cwd: string;
  exit: () => void;
  sessionManager?: SessionManager;
  createProvider: (providerId: string, apiKey: string, baseURL: string) => Provider;
  openPicker: (mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "theme" | "feishu-setup", providerId?: string) => void;
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
  /** Open the feedback dialog. `initialDescription` prefills the description field. */
  openFeedback?: (initialDescription: string) => void;
  /** Open the interactive rewind picker. When absent, /rewind falls back to a text listing. */
  openRewindPicker?: () => void;
  /** Open the interactive session picker. When absent, /session falls back to a text listing. */
  openSessionPicker?: () => void;
  /** Replace the composer/input box content (e.g. /rewind restores the rewound message for re-editing). */
  fillComposer?: (text: string) => void;
  /** Re-project host transcript state after a command rewrites agent.messages. */
  rebuildTranscript?: () => void;
  /** Open the interactive usage stats panel. */
  openStats?: () => void;
  /** Open the interactive context-usage panel. Text-only hosts omit this. */
  openContextInfo?: (snapshot: ContextUsageSnapshot) => void;
  /** Execute the persistent autonomous Goal lifecycle in an interactive host. */
  handleGoalCommand?: (input: string) => void | Promise<void>;
  /**
   * Push live compaction progress to the running TUI. Pass a progress object
   * while compacting and `null` to clear the indicator. Absent in non-TUI hosts.
   */
  compactionProgress?: (progress: CompactionProgress | null) => void;
  /** Cancellation signal owned by the interactive host's Compact activity. */
  compactionAbortSignal?: AbortSignal;
  /** External agent runtime used by Grok subscription chat. */
  externalRuntime?: ExternalRuntimeManager;
  /**
   * Atomically create and bind a fresh Bubble session with optional metadata.
   * External runtimes are session-affine, so crossing the native/external
   * boundary never reuses history.
   */
  startFreshSession?: (metadata?: Partial<SessionMetadata>) => Promise<SessionManager>;
  /** Stop the external runtime and atomically enter a fresh native session. */
  transitionToNative?: () => Promise<SessionManager | undefined>;
  /** Refresh TUI state after a command changes the external session binding. */
  onExternalRuntimeChange?: (manager?: SessionManager) => void;
}

/**
 * Return types for a slash command handler:
 *   - string | void: the string (if any) is displayed as an assistant message
 *   - { inject }: the content is sent to the agent as the user's next turn
 *     (used by MCP prompts that expand a template into a user message)
 *   - { result, detail }: keep the visible result terse while exposing
 *     structured, host-rendered detail such as an inspectable Compact summary
 */
export type SlashCommandOutput =
  | string
  | void
  | { inject: string }
  | { result: string; detail?: SlashCommandResultDetail };

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandOutput>;
}
