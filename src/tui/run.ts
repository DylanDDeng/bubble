/**
 * Pi TUI production entry. Keeps the RunTuiOptions surface main.ts builds so
 * renderer startup and shutdown remain isolated from application wiring.
 */
import process from "node:process";
import { execFile } from "node:child_process";
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
import type { FlushScheduler } from "./controller/ports.js";

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
  createFreshSession?: (cwd: string) => { manager: SessionManager } | { error: string };
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
    goalStore: options.goalStore,
    processManager: options.processManager,
    tasksAutoResume: options.tasksAutoResume,
    promotionChannel: options.promotionChannel,
    workspaceCwd: process.cwd(),
    ports: buildPorts(options),
  });

  const app = new PiTuiApp({
    agent,
    sessionManager: options.sessionManager as never,
    registry: options.registry,
    createProvider: options.createProvider,
    skillRegistry: options.skillRegistry,
    bashAllowlist: options.bashAllowlist,
    settingsManager: options.settingsManager,
    hookController: options.hookController,
    mcpManager: options.mcpManager,
    lspService: options.lspService,
    questionController: options.questionController,
    planHandlerRef: options.planHandlerRef,
    approvalHandlerRef: options.approvalHandlerRef,
    controller,
    updateNotice: options.updateNotice,
    updateNoticeRefresh: options.updateNoticeRefresh,
    flushMemory: options.flushMemory,
    runMemoryCompaction: options.runMemoryCompaction,
    runMemorySummary: options.runMemorySummary,
    runMemoryRefresh: options.runMemoryRefresh,
    themeMode: options.themeMode,
    detectedTheme: options.detectedTheme,
    themeOverrides: options.themeOverrides,
    resolveGitBranch: currentGitBranch,
    // Fullscreen is the production root renderer. Selecting it before start()
    // prevents a regular-screen frame from ever being painted at startup.
    uiMode: "fullscreen",
    callbacks: {
      onExitRequest: () => {},
      onClearTranscript: () => controller.clearTranscript(),
      onThemeToggle: () => {
        // Kept for embedded hosts compiled against the pre-runtime-theme
        // callback shape. /theme now uses onThemeModeChange directly.
      },
      onThemeModeChange: (mode) => {
        options.onThemeModeChange?.(mode);
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
    // The app has stopped painting, but the runtime still retains owner-session
    // bindings. Reap first, then persist killed terminal markers so a resumed
    // session never contains a dangling `task_started` lifecycle.
    await options.processManager?.shutdownTasks();
    controller.persistFinalTaskMarkers();
  }

  return { exitCode: 0, reason: "user-quit", wallMs: Date.now() - startedAt };
}

/** Resolve after first paint so git discovery never delays TUI startup. */
export function currentGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "branch", "--show-current"], { timeout: 3_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(stdout.trim() || undefined);
    });
  });
}

/** Production streaming repaint scheduler: one cancellable timer per burst. */
export function createFlushScheduler(): FlushScheduler {
  let pending: ReturnType<typeof setTimeout> | null = null;
  return {
    scheduleFlush: (intervalMs, flush) => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        flush();
      }, intervalMs);
    },
    cancelFlush: () => {
      if (pending !== null) clearTimeout(pending);
      pending = null;
    },
  };
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
    flush: createFlushScheduler(),
    terminal: {
      isMultiplexed: () => !!process.env.TMUX || (process.env.TERM ?? "").startsWith("screen"),
    },
    sessionHost: {
      switchSession: (file: string) =>
        options.switchSession
          ? options.switchSession(file)
          : { error: "session switching not configured" },
      createFresh: (cwd: string) =>
        options.createFreshSession
          ? options.createFreshSession(cwd)
          : { error: "fresh session creation not configured" },
    },
    git: { currentBranch: () => undefined },
    exitProcess: (code: number) => process.exit(code),
  } as never;
}
