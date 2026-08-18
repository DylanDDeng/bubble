/**
 * pi-tui production entry — replaces src/tui-ink/run.tsx at the Phase 10
 * cutover. Keeps the same RunTuiOptions surface main.ts already builds so
 * main.ts changes stay minimal.
 */
import process from "node:process";
import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { PlanDecision } from "../types.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { QuestionController } from "../question/controller.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { LspService } from "../lsp/service.js";
import type { McpManager } from "../mcp/manager.js";
import type { GoalStore } from "../goal/store.js";
import type { ProcessManager } from "../tasks/manager.js";
import type { PromotionChannel } from "../tasks/promotion.js";
import type { ThemeMode } from "../config.js";
import type { ExternalHookController } from "../hooks/controller.js";
import type { ExternalRuntimeManager } from "../external-runtime/types.js";
import { BubbleTuiController } from "./controller/controller.js";
import { PiTuiApp } from "./app.js";

export interface RunTuiOptions {
  sessionManager?: SessionManager;
  createProvider?: (providerId: string, apiKey: string, baseURL: string) => unknown;
  registry?: ProviderRegistry;
  skillRegistry?: SkillRegistry;
  planHandlerRef?: { current?: (plan: string) => Promise<PlanDecision> };
  approvalHandlerRef?: { current?: (request: ApprovalRequest) => Promise<ApprovalDecision> };
  questionController?: QuestionController;
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  switchSession?: (sessionFile: string) => { manager: SessionManager } | { error: string };
  lspService?: LspService;
  mcpManager?: McpManager;
  goalStore?: GoalStore;
  processManager?: ProcessManager;
  tasksAutoResume?: boolean;
  promotionChannel?: PromotionChannel;
  themeMode?: ThemeMode;
  themeOverrides?: Record<string, string>;
  detectedTheme?: "light" | "dark";
  onThemeModeChange?: (mode: ThemeMode) => void;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: string) => Promise<string>;
  runMemoryRefresh?: (scope?: string) => Promise<string>;
  bypassEnabled?: boolean;
  updateNotice?: string;
  updateNoticeRefresh?: Promise<string | null>;
  hookController?: ExternalHookController;
  externalRuntime?: ExternalRuntimeManager;
}

export interface TuiExitSummary {
  exitCode: number;
  reason: string;
  wallMs: number;
}

export async function runTui(agent: Agent, _args: unknown, options: RunTuiOptions): Promise<TuiExitSummary> {
  const controller = new BubbleTuiController({
    agent,
    sessionManager: options.sessionManager as never,
    ports: buildPorts(options),
  });

  const app = new PiTuiApp({
    agent,
    sessionManager: options.sessionManager as never,
    registry: options.registry,
    questionController: options.questionController,
    planHandlerRef: options.planHandlerRef as never,
    approvalHandlerRef: options.approvalHandlerRef,
    controller,
    updateNotice: options.updateNotice,
    callbacks: {
      onExitRequest: () => {},
      onClearTranscript: () => controller.clearTranscript(),
      onModelSelect: (modelId) => {
        agent.model = modelId;
      },
      onThemeToggle: () => {
        options.onThemeModeChange?.("dark");
      },
      onCompact: () => {
        void options.runMemoryCompaction?.();
      },
    },
  });

  const startedAt = Date.now();
  app.start();

  const sigterm = () => app.dispose();
  process.once("SIGTERM", sigterm);

  try {
    await app.waitUntilExit();
  } finally {
    process.removeListener("SIGTERM", sigterm);
  }

  return { exitCode: 0, reason: "user-quit", wallMs: Date.now() - startedAt };
}

function buildPorts(options: RunTuiOptions) {
  return {
    clock: { now: () => Date.now() },
    scheduler: {
      setTimeout: (callback: () => void, ms: number) => {
        const timer = setTimeout(callback, ms);
        return { [Symbol.dispose]: () => clearTimeout(timer) } as Disposable;
      },
      setInterval: (callback: () => void, ms: number) => {
        const timer = setInterval(callback, ms);
        return { [Symbol.dispose]: () => clearInterval(timer) } as Disposable;
      },
    },
    flush: {
      scheduleFlush: (_intervalMs: number, flush: () => void) => {
        setTimeout(flush, 40);
      },
      cancelFlush: () => {},
    },
    terminal: {
      isMultiplexed: () => !!process.env.TMUX || (process.env.TERM ?? "").startsWith("screen"),
    },
    sessionHost: {
      switchSession: (file: string) =>
        options.switchSession
          ? options.switchSession(file)
          : { error: "session switching not configured" },
      createFresh: () => {
        throw new Error("createFresh not wired in the pi TUI yet");
      },
    },
    git: { currentBranch: () => undefined },
    exitProcess: (code: number) => process.exit(code),
  } as never;
}
