import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { AgentAbortError, INTERRUPTED_ASSISTANT_CONTENT, type Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import { SessionManager, type SessionMetadata } from "../session.js";
import type { AgentEvent, ContentPart, PermissionMode, PlanDecision, Provider, Todo, ToolResultMetadata } from "../types.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { UserConfig, maskKey } from "../config.js";
import {
  InputBox,
  isCtrlCInput,
  isCtrlLetterInput,
  type SubmitPayload,
} from "./input-box.js";
import { MessageList } from "./message-list.js";
import { isMultiplexedTerminal } from "./terminal-env.js";
import {
  appendTextPart,
  appendToolPart,
  contentFromParts,
  latestCompactionSummary,
  moveStatusMessageToEnd,
  nextDisplayMessageKey,
  setUserInputStatus,
  snapshotDisplayParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
  type UserInputStatus,
  toolCallsFromParts,
} from "./display-history.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import type { PendingApprovalHint } from "./message-list.js";
import { canvasBackgroundFor, paletteFor, ThemeProvider, type ResolvedTheme, type Theme, type ThemeMode } from "./theme.js";
import { ModelPicker, ProviderPicker, KeyPicker, SkillPicker } from "./model-picker.js";
import { FeishuSetupPicker } from "./feishu-setup-picker.js";
import { BUILTIN_PROVIDERS, ProviderRegistry, decodeModel, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ThinkingLevel } from "../types.js";
import { getAvailableThinkingLevels, isThinkingOnlyLevels, isThinkingToggleModel, normalizeThinkingLevel } from "../provider-transform.js";
import { FooterBar, buildFooterData } from "./footer.js";
import { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { useTerminalSize } from "./use-terminal-size.js";
import { WelcomeBanner, shouldShowWelcomeBanner } from "./welcome.js";
import { BubbleCodeWordmark } from "./wordmark.js";
import { expandAtMentions } from "./file-mentions.js";
import { TodosPanel } from "./todos.js";
import { CompactionProgressCard } from "./compaction-progress.js";
import type { CompactionProgress } from "../slash-commands/types.js";
import { PlanConfirm } from "./plan-confirm.js";
import { ApprovalDialog } from "./approval/approval-dialog.js";
import { getNextPermissionMode } from "../permission/mode.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspService } from "../lsp/index.js";
import type { QuestionAnswer, QuestionController, QuestionRequest } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
import { QuestionDialog } from "./question-dialog.js";
import { FeedbackDialog } from "./feedback-dialog.js";
import type { ExternalHookController } from "../hooks/controller.js";
import { collectFeedback } from "../feedback/collect.js";
import { isKeyReleaseEvent } from "./key-events.js";
import { errorMessage, formatModelSwitchError, modelSwitchTarget, switchAgentModel } from "../tui/model-switch.js";
import { formatImageUserDisplayText, nextImageDisplayLabelStart } from "../tui/image-display.js";
import { decideStartingSubmitFingerprint, submitPayloadFingerprint } from "./submit-dedupe.js";
import {
  isQueuedInputForCurrentSession,
  queuedAndPendingDisplayKeys,
  type PendingSteerMeta,
  type QueuedInput,
} from "./input-queue.js";
import { SessionPicker } from "./session-picker.js";
import { SubagentInspector } from "./subagent-inspector.js";
import { accumulateLiveSubagentUpdate, collectSubagentGroups, mergeToolMetadata, pruneSettledLiveSubagentTools, subagentSummary } from "./subagent-view.js";
import { sessionDisplayName } from "../tui/session-display.js";
import type { GoalStore, GoalState } from "../goal/store.js";
import { parseGoalCommand } from "../goal/command.js";
import { continuationPrompt, initialPrompt } from "../goal/prompts.js";
import { shouldContinueGoal, stopReasonNotice } from "../goal/engine.js";
import { goalCompleteNotice, goalIndicatorLine, goalSummaryText } from "../goal/format.js";
import { tokenUsageTotal } from "../goal/usage.js";
import { formatInternalContextBlock, isInternalBlockOnlyContent } from "../agent/internal-reminder-sanitizer.js";
import type { BackgroundTaskInfo, ProcessManager } from "../tasks/manager.js";
import type { PromotionChannel } from "../tasks/promotion.js";
import {
  MAX_ACTIVE_LOOPS,
  decideLoopFiring,
  formatInterval,
  formatLoopList,
  parseLoopCommand,
  type LoopState,
} from "../loop/engine.js";
import {
  TaskWakeCoalescer,
  findDanglingTaskStarts,
  formatTaskWakeSummary,
  isPidAlive,
  shouldFireTaskWake,
  taskEligibleForWake,
} from "../tasks/wake.js";
import {
  STREAMING_FLUSH_INTERVAL_MS,
  TASK_WAKE_DEBOUNCE_MS,
  buildTips,
  formatContextUsageLabel,
  friendlyCwd,
  parsePartialArgs,
  sessionBasename,
  slashResultNoticeKind,
  taskRowSummary,
  truncate,
  withMessageKey,
} from "./app-helpers.js";
import { reconstructDisplayMessages } from "./display-reconstruct.js";
export { reconstructDisplayMessages } from "./display-reconstruct.js";
import {
  INK_LOCAL_SLASH_COMMANDS,
  CommandPalette,
  McpReconnectPicker,
  buildCommandPaletteItems,
  buildMcpReconnectItems,
} from "./command-palette.js";
export { INK_LOCAL_SLASH_COMMANDS } from "./command-palette.js";
import { RewindPicker } from "./rewind-picker.js";
import { StatsPanel } from "./stats-panel.js";
import { WaitingIndicator } from "./waiting-indicator.js";

import { collectUsageStatsBundle, type StatsRange, type UsageStatsBundle } from "../stats/usage.js";
import type { ExternalRuntimeManager, ExternalRuntimeModel } from "../external-runtime/types.js";
import { GrokRuntimeError } from "../external-runtime/grok-errors.js";
import {
  GROK_LOCAL_SLASH_COMMANDS,
  classifyGrokInput,
} from "../external-runtime/grok-input-policy.js";
import {
  GROK_SUBSCRIPTION_PROVIDER_ID,
  isGrokSubscriptionProviderId,
  withGrokSubscriptionProvider,
} from "../external-runtime/grok-provider.js";
import {
  classifyExternalRuntimeBinding,
  stopExternalRuntimeForSessionSwitch,
} from "../external-runtime/session-policy.js";
import { rmSync } from "node:fs";
import { execFile } from "node:child_process";

export interface PlanHandlerRef {
  current?: (plan: string) => Promise<PlanDecision>;
}

export interface ApprovalHandlerRef {
  current?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

interface AppProps {
  agent: Agent;
  args: CliArgs;
  sessionManager?: SessionManager;
  switchSession?: (sessionFile: string) => { manager: SessionManager } | { error: string };
  createProvider?: (providerId: string, apiKey: string, baseURL: string) => Provider;
  registry?: ProviderRegistry;
  skillRegistry?: SkillRegistry;
  planHandlerRef?: PlanHandlerRef;
  approvalHandlerRef?: ApprovalHandlerRef;
  questionController?: QuestionController;
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  lspService?: LspService;
  mcpManager?: McpManager;
  themeMode?: ThemeMode;
  themeOverrides?: Record<string, string>;
  detectedTheme?: ResolvedTheme;
  onThemeModeChange?: (mode: ThemeMode) => void;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: MemoryScope) => Promise<string>;
  runMemoryRefresh?: (scope?: MemoryScope) => Promise<string>;
  goalStore?: GoalStore;
  /** Unified process manager; drives task notices, auto-resume, and the status row. */
  processManager?: ProcessManager;
  /** tasks.auto_resume user config (design §2.3b). Default ON. */
  tasksAutoResume?: boolean;
  /** Ctrl+G send-to-background channel shared with the bash tool (design §2.5). */
  promotionChannel?: PromotionChannel;
  /** Whether the bypassPermissions mode is reachable via Shift+Tab cycling. */
  bypassEnabled?: boolean;
  updateNotice?: string;
  updateNoticeRefresh?: Promise<string | null>;
  hookController?: ExternalHookController;
  externalRuntime?: ExternalRuntimeManager;
  onExit?: (summary: ExitSummary) => void;
}

export interface ExitSummary {
  /** Wall-clock duration of the session, in milliseconds. */
  wallMs: number;
}

// Canonical implementation lives in the sanitizer module so non-TUI surfaces
// (session pickers, desktop host) share it; re-exported here for existing users.
export { isInternalBlockOnlyContent };


export function App({ agent, args, sessionManager: initialSessionManager, switchSession, createProvider, registry, skillRegistry, planHandlerRef, approvalHandlerRef, questionController, bashAllowlist, settingsManager, lspService, mcpManager, themeMode: initialThemeMode, themeOverrides, detectedTheme, onThemeModeChange, flushMemory, runMemoryCompaction, runMemorySummary, runMemoryRefresh, goalStore, processManager, tasksAutoResume, promotionChannel, bypassEnabled, updateNotice, updateNoticeRefresh, hookController, externalRuntime, onExit }: AppProps) {
  const [sessionManager, setSessionManager] = useState(initialSessionManager);
  const [externalRuntimeBinding, setExternalRuntimeBinding] = useState(
    () => initialSessionManager?.getMetadata().externalRuntime,
  );
  const sessionManagerRef = useRef(sessionManager);
  sessionManagerRef.current = sessionManager;
  const externalRuntimeBindingRef = useRef(externalRuntimeBinding);
  externalRuntimeBindingRef.current = externalRuntimeBinding;
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode ?? "auto");
  // `detectedTheme` is captured once at startup in main.ts. We keep it in state
  // so future re-detection (e.g. if a user runs `/theme auto` after switching
  // their terminal) is possible without re-mounting the app. For now it never
  // changes after first render.
  const [autoResolved] = useState<ResolvedTheme>(detectedTheme ?? "dark");
  const palette = useMemo<Theme>(() => {
    const resolved: ResolvedTheme = themeMode === "auto" ? autoResolved : themeMode;
    const base = paletteFor(resolved, themeOverrides);
    // A user override wins; otherwise paint the canvas only when a forced
    // theme mismatches the terminal it is running in.
    if (base.background === undefined) {
      const canvas = canvasBackgroundFor(themeMode, resolved, autoResolved);
      if (canvas !== undefined) return { ...base, background: canvas };
    }
    return base;
  }, [themeMode, autoResolved, themeOverrides]);
  const applyThemeMode = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    onThemeModeChange?.(mode);
  }, [onThemeModeChange]);
  // Theme mode at the moment the /theme picker opened, so Esc can restore it
  // after live-previewing other themes while navigating the picker.
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;
  const themePickerRevertRef = useRef<ThemeMode>("auto");
  const themeResolved: ResolvedTheme = themeMode === "auto" ? autoResolved : themeMode;
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => reconstructDisplayMessages(agent.messages));
  const nextImageDisplayLabelStartRef = useRef(nextImageDisplayLabelStart(messages));
  const [isRunning, setIsRunning] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingTools, setStreamingTools] = useState<DisplayToolCall[]>([]);
  const [streamingParts, setStreamingParts] = useState<DisplayMessagePart[]>([]);
  // Background-child updates that outlived their launching tool call's
  // streaming round (toolCalls is cleared on every turn_start): keyed by the
  // launching call id, they feed the inspector as synthetic tool calls so
  // traces stay live e.g. while a wait_workflow blocks. The version counter
  // triggers recompute since the ref mutates in place.
  const liveSubagentToolsRef = useRef<Map<string, DisplayToolCall>>(new Map());
  const [liveSubagentVersion, setLiveSubagentVersion] = useState(0);
  // Transcript-reset paths (/clear, session switch, /rewind) must drop the
  // accumulator too, or ghost subagent groups from the wiped conversation keep
  // feeding the entry line and inspector for the rest of the process.
  const clearLiveSubagentTools = useCallback(() => {
    if (liveSubagentToolsRef.current.size === 0) return;
    liveSubagentToolsRef.current.clear();
    setLiveSubagentVersion((version) => version + 1);
  }, []);
  // Live subagent groups for the inspector opened from the subagent entry line;
  // recomputed each render so it reflects members as their events stream into the transcript.
  const subagentGroups = useMemo(
    () => collectSubagentGroups(messages, [...streamingTools, ...liveSubagentToolsRef.current.values()]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, streamingTools, liveSubagentVersion],
  );
  const subagentMembers = useMemo(() => subagentGroups.flatMap((g) => g.members), [subagentGroups]);
  // Down-arrow from the composer focuses the subagent entry line; Enter then
  // opens the inspector, Esc/Up returns to the composer (Claude Code parity).
  const [subagentEntryFocused, setSubagentEntryFocused] = useState(false);
  useEffect(() => {
    if (subagentMembers.length === 0 && subagentEntryFocused) setSubagentEntryFocused(false);
  }, [subagentMembers.length, subagentEntryFocused]);
  // Live progress for a manual `/compact` run (null when not compacting).
  const [compaction, setCompaction] = useState<CompactionProgress | null>(null);
  // The reasoning level is persisted on the agent (agent.thinking); display it
  // directly. switchAgentModel re-normalizes on explicit model switches, so the
  // initial value needs no clamping against the (possibly not-yet-discovered)
  // model ladder.
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(agent.thinking);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(agent.mode);
  const [todos, setTodos] = useState<Todo[]>(() => agent.getTodos());
  const [goalLine, setGoalLine] = useState("");
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [contextUsage, setContextUsage] = useState("");

  useEffect(() => {
    let cancelled = false;
    execFile("git", ["-C", args.cwd, "branch", "--show-current"], { timeout: 3000 }, (error, stdout) => {
      if (cancelled) return;
      if (error) return;
      const name = stdout.trim();
      setBranch(name || undefined);
    });
    return () => { cancelled = true; };
  }, [args.cwd]);

  useEffect(() => {
    setContextUsage(formatContextUsageLabel(agent.getContextUsageSnapshot()));
  }, [agent]);
  const [currentUpdateNotice, setCurrentUpdateNotice] = useState(updateNotice);
  const [pendingPlan, setPendingPlan] = useState<{
    plan: string;
    resolve: (decision: PlanDecision) => void;
  } | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    request: ApprovalRequest;
    resolve: (decision: ApprovalDecision) => void;
  } | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<{
    base: Omit<import("../feedback/types.js").FeedbackPayload, "description">;
    initialDescription: string;
  } | null>(null);
  const [pickerMode, setPickerMode] = useState<"model" | "grok-model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "theme" | "session" | "rewind" | "slash" | "mcp-reconnect" | "feishu-setup" | "agents" | null>(null);
  const [grokModels, setGrokModels] = useState<ExternalRuntimeModel[]>([]);
  const [statsPanel, setStatsPanel] = useState<{ range: StatsRange; bundle: UsageStatsBundle } | null>(null);
  const [cursorResetEpoch, setCursorResetEpoch] = useState(0);
  const [composerDraft, setComposerDraft] = useState<{ text: string; epoch: number } | null>(null);
  const [keyProviderId, setKeyProviderId] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [verboseTrace, setVerboseTrace] = useState(false);
  const startedWithVisibleHistoryRef = useRef(messages.some((message) => message.syntheticKind !== "ui_summary"));
  const { columns: terminalColumns, rows: terminalRows } = useTerminalSize();
  const showWelcome = shouldShowWelcomeBanner({
    messages,
    startedWithVisibleHistory: startedWithVisibleHistoryRef.current,
  });
  const showWelcomeRef = useRef(showWelcome);
  const activeAbortRef = useRef<AbortController | null>(null);
  const exitRequestedRef = useRef(false);
  const sessionStartRef = useRef<number>(Date.now());
  // Bumped whenever the settled transcript is rebuilt non-monotonically
  // (/clear, /compact, /rewind, session switch). Used as the <Static> key in
  // MessageList so Ink discards its already-printed rows and re-prints the
  // rebuilt list onto a freshly-cleared screen instead of appending duplicates.
  const [staticGeneration, setStaticGeneration] = useState(0);
  // The clear must go through Ink's stdout hook, not a raw process.stdout
  // write: Ink replays its last dynamic frame after any external write
  // (restoreLastOutput), which is the only repaint guarantee when the
  // generation bump produces no new output — with zero settled rows (fresh
  // welcome screen) <Static> emits nothing and the dynamic frame diffs equal,
  // so Ink skips the write and a raw clear would leave the screen blank.
  const { write: writeThroughInk } = useStdout();
  const reprintTranscript = useCallback(() => {
    if (process.stdout.isTTY) {
      writeThroughInk("\x1b[0m\x1b[2J\x1b[3J\x1b[H");
    }
    setStaticGeneration((generation) => generation + 1);
  }, [writeThroughInk]);
  // Steer/queue while the agent runs:
  // Enter steers the current run via the agent's input controller; Tab (or an
  // ineligible input) queues for the next turn. Both render placeholder user
  // rows whose badge tracks the input's lifecycle.
  const inputControllerRef = useRef<AgentRunInputQueue | null>(null);
  const pendingSteersRef = useRef(new Map<string, PendingSteerMeta>());
  const queuedInputsRef = useRef<QueuedInput[]>([]);
  const [pendingSteerCount, setPendingSteerCount] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const startingSubmitFingerprintRef = useRef<string | null>(null);
  const [startingSubmitFingerprint, setStartingSubmitFingerprint] = useState<string | null>(null);
  const nextRunIdRef = useRef(0);
  // Invalidates late external-runtime events whenever the Bubble session or
  // runtime binding changes. Native Agent events retain their existing path.
  const externalRuntimeGenerationRef = useRef(0);
  // Set true the moment /quit is invoked so we can hide dynamic UI (composer,
  // waiting indicator, footer) before Ink snapshots its final frame into the
  // shell scrollback. Without this, the last visible "> " input row stays
  // glued to the bottom of the terminal after exit.
  const [isExiting, setIsExiting] = useState(false);
  // 1Hz tick keeps the composer activity indicator animated while the agent is
  // running without churning renders at idle.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  // Live background-task snapshot for the status row (design §2.5); refreshed
  // by the manager subscription effect below.
  const [taskSnapshot, setTaskSnapshot] = useState<BackgroundTaskInfo[]>([]);
  const runningTasks = useMemo(
    () => taskSnapshot.filter((task) => task.status === "running"),
    [taskSnapshot],
  );
  // Timestamp of when the current agent run started. Used only for the final
  // per-task duration summary.
  const runStartRef = useRef<number | null>(null);
  // Mark the moment the run started; flips back to null in the finally block.
  // Also ticks while background tasks run at idle so their elapsed counter
  // keeps moving (design §2.5).
  useEffect(() => {
    if (!isRunning && runningTasks.length === 0) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning, runningTasks.length]);

  const userConfig = new UserConfig();
  const safeRegistry = registry ?? new ProviderRegistry(userConfig);
  const safeSkillRegistry = skillRegistry ?? new SkillRegistry({
    cwd: args.cwd,
    skillPaths: userConfig.getSkillPaths(),
  });
  const externalRuntimeBindingKind = classifyExternalRuntimeBinding(externalRuntimeBinding);
  const externalSessionBound = externalRuntimeBindingKind !== "none";
  const grokSessionBound = externalRuntimeBindingKind === "grok";
  const unsupportedExternalSessionBound = externalRuntimeBindingKind === "unsupported";

  const refreshExternalRuntimeBinding = useCallback((manager?: SessionManager) => {
    const next = (manager ?? sessionManagerRef.current)?.getMetadata().externalRuntime;
    externalRuntimeBindingRef.current = next;
    setExternalRuntimeBinding(next);
  }, []);

  useEffect(() => {
    setCurrentUpdateNotice(updateNotice);
  }, [updateNotice]);

  useEffect(() => {
    showWelcomeRef.current = showWelcome;
  }, [showWelcome]);

  useEffect(() => {
    if (!goalStore) return;
    let persistSuspended = false;
    const persistGoal = (goal: GoalState | null) => {
      if (!sessionManager) return;
      try {
        const metadata = sessionManager.getMetadata();
        sessionManager.setMetadata({ ...metadata, goal: goal ?? undefined });
      } catch {
        // Goal persistence is best-effort; never break the run loop over it.
      }
    };
    const unsubscribe = goalStore.onChange((goal) => {
      setGoalLine(goal ? goalIndicatorLine(goal) : "");
      if (!persistSuspended) persistGoal(goal);
    });
    const persisted = sessionManager?.getMetadata().goal;
    if (persisted) {
      persistSuspended = true;
      goalStore.loadFrom(persisted.status === "active" ? { ...persisted, status: "paused" } : persisted);
      persistSuspended = false;
    } else {
      persistSuspended = true;
      goalStore.loadFrom(undefined);
      persistSuspended = false;
      setGoalLine("");
    }
    return unsubscribe;
  }, [goalStore, sessionManager]);

  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    // Drop the composer / waiting indicator / footer from the React tree
    // *before* we tell Ink to exit, so Ink's final log-update snapshot
    // doesn't leave an empty "> " row behind in the shell scrollback.
    setIsExiting(true);

    // Cancel any in-flight agent run first so its tools / network calls
    // don't keep emitting text after Ink unmounts and corrupt the
    // restored shell prompt.
    if (activeAbortRef.current) {
      try {
        activeAbortRef.current.abort(new AgentAbortError("Exiting Bubble."));
      } catch {
        // ignore — abort is best effort during shutdown
      }
      activeAbortRef.current = null;
    }

    void (async () => {
      // Yield once so React can commit the `isExiting=true` render
      // (which strips the composer/footer) before we hand control to
      // Ink's teardown. Without this, on the no-flushMemory path the
      // exit() below races the next React commit and Ink snapshots the
      // pre-exit frame with the composer still visible.
      await new Promise<void>((resolve) => setImmediate(resolve));

      let flushError: unknown = null;
      if (flushMemory) {
        // Bound the flush so a stuck LLM/network call cannot trap the TUI.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            flushMemory(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("flushMemory timed out after 3s")),
                3000,
              );
            }),
          ]);
        } catch (err) {
          flushError = err;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }

      // Hand off to Ink. Ink's render instance owns TTY teardown (raw mode,
      // cursor, alt-screen); doing it ourselves here races with that and
      // leaves the terminal in odd states. run.tsx awaits waitUntilExit()
      // and then main.ts handles the rest.
      exit();

      // Surface flush failures *after* Ink has restored the screen so the
      // warning lands on the real shell instead of being clobbered.
      if (flushError) {
        const message = flushError instanceof Error ? flushError.message : String(flushError);
        process.nextTick(() => {
          process.stderr.write(`warning: failed to flush memory on exit: ${message}\n`);
        });
      }

      onExit?.({ wallMs: Date.now() - sessionStartRef.current });
    })();
  }, [exit, flushMemory, onExit]);

  useEffect(() => {
    if (!planHandlerRef) return;
    planHandlerRef.current = (plan: string) =>
      new Promise<PlanDecision>((resolve) => {
        setPendingPlan({ plan, resolve });
      });
    return () => {
      if (planHandlerRef.current) {
        planHandlerRef.current = undefined;
      }
    };
  }, [planHandlerRef]);

  useEffect(() => {
    if (!approvalHandlerRef) return;
    approvalHandlerRef.current = (request: ApprovalRequest) =>
      new Promise<ApprovalDecision>((resolve) => {
        setPendingApproval({ request, resolve });
      });
    return () => {
      if (approvalHandlerRef.current) {
        approvalHandlerRef.current = undefined;
      }
    };
  }, [approvalHandlerRef]);

  useEffect(() => {
    if (!questionController) return;
    const syncFirstPending = () => {
      setPendingQuestion((current) => current ?? questionController.list()[0] ?? null);
    };
    const unsubscribe = questionController.subscribe((event) => {
      if (event.type === "asked") {
        setPendingQuestion(event.request);
        return;
      }
      setPendingQuestion((current) => current?.id === event.request.id ? null : current);
      setTimeout(syncFirstPending, 0);
    });
    syncFirstPending();
    return unsubscribe;
  }, [questionController]);

  const rebuildSystemPrompt = useCallback(
    (overrides?: { thinkingLevel?: ThinkingLevel; mode?: PermissionMode }) => {
      const modelParts = agent.model.includes(":")
        ? agent.model.split(":")
        : [agent.providerId || safeRegistry.getDefault()?.id || "openai", agent.model];
      const providerId = modelParts[0];
      agent.setSystemPrompt(buildSystemPrompt({
        agentName: "Bubble",
        configuredProvider: providerId,
        configuredModel: displayModel(agent.model),
        configuredModelId: agent.model,
        thinkingLevel: overrides?.thinkingLevel ?? agent.thinking,
        mode: overrides?.mode ?? agent.mode,
        workingDir: args.cwd,
        ...agent.getSystemPromptToolOptions(),
      }));
    },
    [agent, args.cwd, safeRegistry, safeSkillRegistry],
  );

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (isCtrlCInput(input, key)) {
      requestExit();
      return;
    }

    // Scrolling is the terminal's job now: settled rows live in native
    // scrollback (committed via <Static>), so the wheel, tmux copy-mode, and
    // PageUp/PageDown scroll the real terminal with no app involvement and no
    // flicker. Bubble no longer intercepts mouse reports or page keys, which
    // also frees the arrow keys entirely for composer history.
    if (pendingPlan || pendingApproval || pendingQuestion || pendingFeedback || statsPanel) return;

    // Subagent entry is focused (the composer is disabled): Enter opens the
    // inspector, Up/Esc returns to the composer. Other keys just return focus.
    if (subagentEntryFocused && !pickerMode) {
      if (key.return) {
        setSubagentEntryFocused(false);
        setStatsPanel(null);
        setPickerMode("agents");
        return;
      }
      if (key.escape || key.upArrow) {
        setSubagentEntryFocused(false);
        return;
      }
      if (key.downArrow) return; // stay focused
      setSubagentEntryFocused(false);
      return;
    }

    if (isCtrlLetterInput(input, key, "p") && !pickerMode && !activeAbortRef.current) {
      setStatsPanel(null);
      setPickerMode("slash");
      return;
    }

    // Ctrl+G: promote the running foreground bash command to a background
    // task (design §2.5). A no-op when nothing promotable is running.
    if (isCtrlLetterInput(input, key, "g") && !pickerMode && promotionChannel) {
      const liveTools = [
        ...streamingTools,
        ...streamingParts.flatMap((part) => (part.type === "tools" ? part.toolCalls : [])),
      ];
      const candidate = [...liveTools].reverse().find(
        (tool) => tool.name === "bash" && !tool.result && promotionChannel.hasPromotable(tool.id),
      );
      if (candidate) {
        const taskId = promotionChannel.requestPromotion(candidate.id);
        if (taskId) {
          addMessage("assistant", `Moved to background: ${taskId} — the command keeps running (Ctrl+G).`, "ui_notice");
        }
      }
      return;
    }

    if (key.ctrl && key.shift && input.toLowerCase() === "m" && !pickerMode) {
      if (externalSessionBound) {
        addMessage("assistant", "MCP is unavailable in external runtime sessions (no Bubble workspace access).");
        return;
      }
      if (!mcpManager || mcpManager.getStates().length === 0) {
        addMessage("assistant", "No MCP servers configured.");
      } else {
        setStatsPanel(null);
        setPickerMode("mcp-reconnect");
      }
      return;
    }

    if (isCtrlLetterInput(input, key, "t") && !pickerMode) {
      setShowThinking((current) => {
        const next = !current;
        addMessage("assistant", next ? "Thinking blocks visible" : "Thinking blocks hidden");
        return next;
      });
      return;
    }

    if (isCtrlLetterInput(input, key, "o") && !pickerMode) {
      setVerboseTrace((v) => !v);
      reprintTranscript();
      return;
    }

    // Ctrl+R: cycle thinking level (formerly Shift+Tab)
    if (isCtrlLetterInput(input, key, "r") && !pickerMode) {
      if (externalSessionBound) {
        if (!grokSessionBound || !externalRuntime) {
          addMessage("assistant", "The external runtime manages its own model and reasoning settings.");
          return;
        }
        const bound = externalRuntimeBindingRef.current;
        void (bound?.sessionId
          ? externalRuntime.hydrateSession(bound.sessionId, bound.modelId, bound.reasoningEffort)
          : Promise.resolve()
        ).then(async () => await externalRuntime.listModels()).then(async (models) => {
          const current = externalRuntime.getModelSelection();
          const model = models.find((candidate) => candidate.id === current.modelId);
          if (!model || model.reasoningLevels.length < 2) {
            addMessage("assistant", `${current.modelId ?? "The current Grok model"} has no alternate reasoning effort.`);
            return;
          }
          const index = Math.max(0, model.reasoningLevels.indexOf(current.reasoningEffort));
          const next = model.reasoningLevels[(index + 1) % model.reasoningLevels.length]!;
          const selection = await externalRuntime.setModel(model.id, next);
          const manager = sessionManagerRef.current;
          const binding = manager?.getMetadata().externalRuntime;
          if (manager && binding && isGrokSubscriptionProviderId(binding.id)) {
            manager.updateMetadata({ externalRuntime: { ...binding, ...selection } });
            manager.appendMarker("thinking_level_switch", selection.reasoningEffort);
            refreshExternalRuntimeBinding(manager);
          }
          addMessage("assistant", `Grok reasoning effort set to ${selection.reasoningEffort}.`);
        }).catch((error) => addMessage("error", `Failed to switch Grok reasoning: ${errorMessage(error)}`));
        return;
      }
      const modelParts = agent.model.includes(":")
        ? agent.model.split(":")
        : [agent.providerId || safeRegistry.getDefault()?.id || "openai", agent.model];
      const providerId = modelParts[0];
      const modelId = modelParts.slice(1).join(":");
      const availableLevels = getAvailableThinkingLevels(providerId, modelId);
      const currentLevel = normalizeThinkingLevel(agent.thinking, availableLevels);
      const currentIndex = availableLevels.indexOf(currentLevel);
      const nextLevel = availableLevels[(currentIndex + 1) % availableLevels.length];
      agent.thinking = nextLevel;
      rebuildSystemPrompt({ thinkingLevel: nextLevel });
      userConfig.setDefaultThinkingLevel(nextLevel);
      setThinkingLevel(nextLevel);
      sessionManager?.updateMetadata({ model: agent.model, thinkingLevel: nextLevel, reasoningEffort: nextLevel });
      sessionManager?.appendMarker("thinking_level_switch", nextLevel);
      return;
    }

    // Shift+Tab: cycle through permission modes (default → acceptEdits → plan
    // → [bypassPermissions if enabled] → default). Agent.setMode injects a
    // <system-reminder>, so we do not rebuild the cache-friendly system prompt here.
    if (key.tab && key.shift && !pickerMode) {
      const nextMode = getNextPermissionMode(agent.mode);
      // setMode fires onModeUpdate, which is the single writer of the
      // mode_switch marker — appending here too double-logs every switch.
      agent.setMode(nextMode);
      setPermissionMode(nextMode);
      return;
    }

    if (key.escape && !pickerMode) {
      if (isRunning && activeAbortRef.current) {
        activeAbortRef.current.abort(new AgentAbortError("Agent run cancelled by user."));
        return;
      }
    }
  });

  const updateDisplayMessages = useCallback((updater: (prev: DisplayMessage[]) => DisplayMessage[]) => {
    setMessages((prev) => updater(prev).map(withMessageKey));
  }, []);

  // Non-append transcript rebuilds (/clear, /compact, /rewind, session switch)
  // replace the settled list rather than extending it. The rows already
  // committed to the terminal's native scrollback (via <Static>) cannot be
  // un-printed, so we wipe the screen + scrollback and bump the Static key:
  // Ink then re-prints the rebuilt list fresh instead of appending duplicates.
  const resetTranscript = useCallback(
    (updater: (prev: DisplayMessage[]) => DisplayMessage[]) => {
      reprintTranscript();
      updateDisplayMessages(updater);
    },
    [reprintTranscript, updateDisplayMessages],
  );

  const addMessage = useCallback((role: DisplayMessage["role"], content: string, syntheticKind?: DisplayMessage["syntheticKind"]) => {
    updateDisplayMessages((prev) => [...prev, withMessageKey(syntheticKind ? { role, content, syntheticKind } : { role, content })]);
  }, [updateDisplayMessages]);

  // Reflow on terminal resize. ink 7.0.3 only clears its dynamic frame when the
  // terminal NARROWS (see its resized() handler); on widen / tmux split the
  // stale frame is left behind and the working trace duplicates into
  // scrollback. Dedicated scrollback renderers (pi-tui) handle this by doing a
  // full clear + re-print on ANY width/height change so content rewraps
  // cleanly — resetTranscript does exactly that here. Debounced so a drag
  // coalesces into one reflow instead of flashing on every resize event.
  const didMountSizeRef = useRef(false);
  useEffect(() => {
    if (!didMountSizeRef.current) {
      didMountSizeRef.current = true;
      return;
    }
    const timer = setTimeout(() => {
      resetTranscript((prev) => prev);
    }, 80);
    return () => clearTimeout(timer);
  }, [terminalColumns, terminalRows, resetTranscript]);

  useEffect(() => {
    if (!updateNoticeRefresh) return;
    let cancelled = false;
    updateNoticeRefresh.then((notice) => {
      if (cancelled || !notice) return;
      setCurrentUpdateNotice(notice);
      if (!showWelcomeRef.current) addMessage("assistant", notice);
    }).catch(() => {
      // Best-effort update checks should never disturb the session.
    });
    return () => {
      cancelled = true;
    };
  }, [addMessage, updateNoticeRefresh]);

  const clearMessages = useCallback(() => {
    // Settled rows live in the terminal's native scrollback now (committed via
    // <Static>), so clearing React state is not enough — resetTranscript wipes
    // the screen + scrollback and re-prints the (now empty) transcript.
    resetTranscript(() => []);
    // The todos panel renders off React state, not the transcript, so wiping
    // messages alone leaves a stale To-Do list on screen. /clear already reset
    // the agent's todos; mirror that into the UI (same as session switch).
    setTodos(agent.getTodos());
    clearLiveSubagentTools();
  }, [resetTranscript, agent, clearLiveSubagentTools]);

  // Render a placeholder user row for input waiting to enter the run.
  const addStatusUserMessage = useCallback((content: string, status: UserInputStatus): string => {
    const key = nextDisplayMessageKey("user");
    updateDisplayMessages((prev) => [...prev, { key, role: "user", content, inputStatus: status }]);
    return key;
  }, [updateDisplayMessages]);

  const prepareSubmitDisplay = useCallback((payload: SubmitPayload): SubmitPayload => {
    if (payload.images.length === 0) return payload;
    if (payload.imageDisplayStart !== undefined) {
      nextImageDisplayLabelStartRef.current = Math.max(
        nextImageDisplayLabelStartRef.current,
        payload.imageDisplayStart + payload.images.length,
      );
      return payload;
    }
    const imageDisplayStart = nextImageDisplayLabelStartRef.current;
    nextImageDisplayLabelStartRef.current += payload.images.length;
    return { ...payload, imageDisplayStart };
  }, []);

  const submitDisplayText = useCallback((payload: SubmitPayload): string => (
    formatImageUserDisplayText(
      payload.displayText ?? payload.text,
      payload.images.length,
      payload.imageDisplayStart,
    )
  ), []);

  const currentSessionFile = useCallback(() => sessionManagerRef.current?.getSessionFile(), []);

  const queueInput = useCallback((payload: SubmitPayload) => {
    const preparedPayload = prepareSubmitDisplay(payload);
    const displayKey = addStatusUserMessage(submitDisplayText(preparedPayload), "queued");
    queuedInputsRef.current.push({ payload: preparedPayload, displayKey, sessionFile: currentSessionFile() });
    setQueuedCount(queuedInputsRef.current.length);
  }, [addStatusUserMessage, currentSessionFile, prepareSubmitDisplay, submitDisplayText]);

  const submitSteer = useCallback((payload: SubmitPayload) => {
    const controller = inputControllerRef.current;
    if (!controller) {
      queueInput(payload);
      return;
    }
    const preparedPayload = prepareSubmitDisplay(payload);
    const displayKey = addStatusUserMessage(submitDisplayText(preparedPayload), "pending_steer");
    const pending = controller.enqueue(preparedPayload.text);
    pendingSteersRef.current.set(pending.id, { displayKey, sessionFile: currentSessionFile() });
    setPendingSteerCount(pendingSteersRef.current.size);
  }, [addStatusUserMessage, currentSessionFile, prepareSubmitDisplay, queueInput, submitDisplayText]);

  const openPicker = useCallback((mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "theme" | "session" | "rewind" | "feishu-setup" | "agents", providerId?: string) => {
    if (mode === "model" && grokSessionBound && externalRuntime) {
      setStatsPanel(null);
      setGrokModels([]);
      setPickerMode("grok-model");
      const bound = externalRuntimeBindingRef.current;
      void (bound?.sessionId
        ? externalRuntime.hydrateSession(bound.sessionId, bound.modelId, bound.reasoningEffort)
        : Promise.resolve()
      ).then(async () => await externalRuntime.listModels()).then(setGrokModels).catch((error) => {
        addMessage("error", `Failed to load Grok models: ${errorMessage(error)}`);
        setPickerMode(null);
      });
      return;
    }
    if (mode === "key") {
      setKeyProviderId(providerId ?? null);
    }
    if (mode === "theme") {
      themePickerRevertRef.current = themeModeRef.current;
    }
    setStatsPanel(null);
    setPickerMode(mode);
  }, [addMessage, externalRuntime, grokSessionBound]);

  const closePicker = useCallback(() => {
    setPickerMode(null);
    setCursorResetEpoch((epoch) => epoch + 1);
  }, []);

  const handleGrokModelSelect = useCallback((encoded: string) => {
    if (!externalRuntime) return;
    const run = async () => {
      const parsed = JSON.parse(encoded) as { modelId: string; reasoningEffort: ThinkingLevel };
      const boundSessionId = externalRuntimeBindingRef.current?.sessionId;
      if (boundSessionId) await externalRuntime.hydrateSession(boundSessionId);
      const selection = await externalRuntime.setModel(parsed.modelId, parsed.reasoningEffort);
      const manager = sessionManagerRef.current;
      const binding = manager?.getMetadata().externalRuntime;
      if (manager && binding && isGrokSubscriptionProviderId(binding.id)) {
        manager.updateMetadata({ externalRuntime: { ...binding, ...selection } });
        manager.appendMarker("model_switch", selection.modelId ?? parsed.modelId);
        manager.appendMarker("thinking_level_switch", selection.reasoningEffort);
        refreshExternalRuntimeBinding(manager);
      }
      addMessage("assistant", `Grok model switched to ${selection.modelId ?? parsed.modelId}${selection.reasoningEffort !== "off" ? ` (${selection.reasoningEffort})` : ""}.`, "ui_notice");
      closePicker();
    };
    void run().catch((error) => {
      addMessage("error", `Failed to switch Grok model: ${errorMessage(error)}`);
      closePicker();
    });
  }, [addMessage, closePicker, externalRuntime, refreshExternalRuntimeBinding]);

  const fillComposer = useCallback((text: string) => {
    setComposerDraft((current) => ({
      text,
      epoch: (current?.epoch ?? 0) + 1,
    }));
  }, []);

  const clearComposerDraft = useCallback(() => {
    setComposerDraft(null);
  }, []);

  const setStartingSubmit = useCallback((fingerprint: string | null) => {
    startingSubmitFingerprintRef.current = fingerprint;
    setStartingSubmitFingerprint(fingerprint);
  }, []);

  const openFeedback = useCallback((initialDescription: string) => {
    const base = collectFeedback(agent, { description: "" });
    const { description: _drop, ...rest } = base;
    setPendingFeedback({ base: rest, initialDescription });
  }, [agent]);

  const openSessionPicker = useCallback(() => {
    if (activeAbortRef.current) {
      addMessage("error", "Stop the current run before switching sessions.");
      return;
    }
    setStatsPanel(null);
    setPickerMode("session");
  }, [addMessage]);

  const openRewindPicker = useCallback(() => {
    if (!sessionManager) {
      addMessage("error", "Rewind requires an active session.");
      return;
    }
    if (activeAbortRef.current) {
      addMessage("error", "Stop the current run before rewinding.");
      return;
    }
    setStatsPanel(null);
    setPickerMode("rewind");
  }, [addMessage, sessionManager]);

  const openStatsPanel = useCallback(() => {
    setPickerMode(null);
    setStatsPanel({
      range: "30d",
      bundle: collectUsageStatsBundle(),
    });
  }, []);

  const closeStatsPanel = useCallback(() => {
    setStatsPanel(null);
    setCursorResetEpoch((epoch) => epoch + 1);
  }, []);

  const applySessionSwitch = useCallback((result: { manager: SessionManager }, notice?: string) => {
    externalRuntimeGenerationRef.current += 1;
    const queuedDisplayKeys = queuedAndPendingDisplayKeys(
      queuedInputsRef.current,
      pendingSteersRef.current.values(),
    );
    queuedInputsRef.current = [];
    pendingSteersRef.current.clear();
    inputControllerRef.current = null;
    setQueuedCount(0);
    setPendingSteerCount(0);
    setStartingSubmit(null);
    clearComposerDraft();
    sessionManagerRef.current = result.manager;
    setSessionManager(result.manager);
    // Keep ownerSessionId on newly spawned tasks/servers accurate (§2.2c).
    agent.setSessionID(result.manager.getSessionFile());
    const nextExternalBinding = result.manager.getMetadata().externalRuntime;
    externalRuntimeBindingRef.current = nextExternalBinding;
    setExternalRuntimeBinding(nextExternalBinding);
    setTodos(agent.getTodos());
    clearLiveSubagentTools();
    resetTranscript(() => [
      ...reconstructDisplayMessages(agent.messages).filter((message) => !queuedDisplayKeys.has(message.key ?? "")),
      ...(notice ? [withMessageKey({ role: "assistant" as const, content: notice })] : []),
    ]);
    closePicker();
    return result.manager;
  }, [agent, clearComposerDraft, clearLiveSubagentTools, closePicker, resetTranscript, setStartingSubmit]);

  const prepareFreshSession = useCallback((metadata?: Partial<SessionMetadata>): SessionManager => {
    const fresh = SessionManager.createFresh(args.cwd);
    try {
      if (metadata && Object.keys(metadata).length > 0) {
        fresh.updateMetadata(metadata);
      }
      return fresh;
    } catch (error) {
      rmSync(fresh.getSessionFile(), { force: true });
      throw error;
    }
  }, [args.cwd]);

  const commitFreshSession = useCallback((fresh: SessionManager): SessionManager => {
    if (!switchSession) {
      rmSync(fresh.getSessionFile(), { force: true });
      throw new Error("Starting a fresh session is not available in this mode.");
    }
    const result = switchSession(fresh.getSessionFile());
    if ("error" in result) {
      rmSync(fresh.getSessionFile(), { force: true });
      throw new Error(result.error);
    }
    return applySessionSwitch(result);
  }, [applySessionSwitch, switchSession]);

  const startFreshSession = useCallback(async (
    metadata?: Partial<SessionMetadata>,
  ): Promise<SessionManager> => {
    return commitFreshSession(prepareFreshSession(metadata));
  }, [commitFreshSession, prepareFreshSession]);

  const transitionToNative = useCallback(async (): Promise<SessionManager | undefined> => {
    if (!externalSessionBound) return sessionManagerRef.current;
    const candidate = prepareFreshSession();
    externalRuntimeGenerationRef.current += 1;
    const boundSessionId = externalRuntimeBinding?.sessionId;
    try {
      // Validate/prepare the native provider before calling this function.
      // The external sidecar must be fully stopped before the new Bubble
      // session is committed. If commit then fails, the old binding remains
      // authoritative and the reusable manager will lazy-load it next time.
      await stopExternalRuntimeForSessionSwitch(externalRuntime, boundSessionId);
      return commitFreshSession(candidate);
    } catch (error) {
      rmSync(candidate.getSessionFile(), { force: true });
      throw error;
    }
  }, [commitFreshSession, externalRuntime, externalRuntimeBinding?.sessionId, externalSessionBound, prepareFreshSession]);

  const handleSessionSelect = useCallback((sessionFile: string) => {
    const run = async () => {
    if (!switchSession) {
      addMessage("error", "Session switching is not available in this mode.");
      closePicker();
      return;
    }
    if (activeAbortRef.current) {
      addMessage("error", "Stop the current run before switching sessions.");
      closePicker();
      return;
    }
    if (externalSessionBound) {
      externalRuntimeGenerationRef.current += 1;
      const boundSessionId = externalRuntimeBinding?.sessionId;
      await stopExternalRuntimeForSessionSwitch(externalRuntime, boundSessionId);
    }
    const result = switchSession(sessionFile);
    if ("error" in result) {
      addMessage("error", `Failed to switch session: ${result.error}`);
      closePicker();
      return;
    }
    applySessionSwitch(result, `⤷ Resumed session: ${sessionDisplayName(result.manager)}`);
    };
    void run().catch((error) => {
      addMessage("error", `Failed to switch session: ${errorMessage(error)}`);
      closePicker();
    });
  }, [activeAbortRef, addMessage, applySessionSwitch, closePicker, externalRuntime, externalRuntimeBinding?.sessionId, externalSessionBound, switchSession]);

  const handleModelSelect = useCallback((model: string, selectedThinkingLevel?: ThinkingLevel) => {
    const run = async () => {
      const target = modelSwitchTarget(
        model,
        agent.providerId || safeRegistry.getDefault()?.id,
      );
      await safeRegistry.prepareProvider(target.providerId);
      const targetProvider = safeRegistry.getConfigured().find((item) => item.id === target.providerId);
      if (!targetProvider?.apiKey || !createProvider) {
        throw new Error(`Provider ${target.providerId} is not configured or has no active credentials.`);
      }
      // Construct once as a side-effect-free preflight before stopping Grok.
      // switchAgentModel constructs the committed instance after the fresh
      // native session has been installed.
      const preparedProvider = createProvider(target.providerId, targetProvider.apiKey, targetProvider.baseURL);
      const targetSessionManager = await transitionToNative();
      const nextThinkingLevel = await switchAgentModel({
        model,
        agent,
        registry: safeRegistry,
        createProvider,
        preparedProvider,
        workingDir: args.cwd,
        systemPromptOptions: agent.getSystemPromptToolOptions(),
        thinkingLevel: selectedThinkingLevel,
        rememberModel: (nextModel) => userConfig.pushRecentModel(nextModel),
        setThinkingLevel,
        sessionManager: targetSessionManager,
      });
      // Persist the resolved effort alongside the model so a fresh session
      // restores both. Without this, the picker path only remembered the model
      // and new sessions fell back to a stale config.json defaultThinkingLevel
      // (e.g. picking glm-5.3 + max still restored "high" on next launch).
      userConfig.setDefaultThinkingLevel(nextThinkingLevel);
      // Binary thinking toggles and thinking-only models use internal level
      // placeholders; do not present those placeholders as real effort grades.
      const decodedModel = decodeModel(model);
      const switchedProviderId = decodedModel.providerId || agent.providerId || safeRegistry.getDefault()?.id || "openai";
      const isThinkingToggle = isThinkingToggleModel(switchedProviderId, decodedModel.modelId);
      const isThinkingOnly = isThinkingOnlyLevels(
        getAvailableThinkingLevels(switchedProviderId, decodedModel.modelId),
      );
      const effortNote = nextThinkingLevel && nextThinkingLevel !== "off"
        ? (isThinkingToggle || isThinkingOnly ? " in thinking mode" : ` with ${nextThinkingLevel} effort`)
        : "";
      setContextUsage(formatContextUsageLabel(agent.getContextUsageSnapshot()));
      addMessage("assistant", `Model switched to ${displayModel(model)}${effortNote}.`, "ui_notice");
      closePicker();
      return nextThinkingLevel;
    };

    void run().catch((error) => {
      addMessage("error", formatModelSwitchError(model, error));
      closePicker();
    });
  }, [agent, addMessage, closePicker, sessionManager, transitionToNative, userConfig, safeRegistry, createProvider]);

  const handleThemeHighlight = useCallback((mode: string) => {
    setThemeMode(mode as ThemeMode);
  }, []);

  const handleThemeSelect = useCallback((mode: string) => {
    applyThemeMode(mode as ThemeMode);
    const resolvedNote = mode === "auto" ? ` (resolved to ${autoResolved})` : "";
    addMessage("assistant", `Theme set to ${mode}${resolvedNote}.`);
    closePicker();
  }, [addMessage, applyThemeMode, autoResolved, closePicker]);

  const handleThemeCancel = useCallback(() => {
    setThemeMode(themePickerRevertRef.current);
    closePicker();
  }, [closePicker]);

  const executeProviderCommand = useCallback(async (command: string): Promise<void> => {
    closePicker();
    const { handled, result } = await slashRegistry.execute(command, {
      agent,
      addMessage,
      clearMessages,
      cwd: args.cwd,
      exit: requestExit,
      sessionManager: sessionManagerRef.current,
      createProvider: createProvider ?? ((() => {
        throw new Error("Provider creation not available");
      }) as any),
      openPicker,
      openSessionPicker,
      openRewindPicker,
      openFeedback,
      fillComposer,
      registry: safeRegistry,
      skillRegistry: safeSkillRegistry!,
      bashAllowlist,
      settingsManager,
      lspService,
      mcpManager,
      hookController,
      flushMemory,
      runMemoryCompaction,
      runMemorySummary,
      runMemoryRefresh,
      getThemeMode: () => themeMode,
      getResolvedTheme: () => themeResolved,
      setThemeMode: applyThemeMode,
      openStats: openStatsPanel,
      externalRuntime,
      startFreshSession,
      transitionToNative,
      onExternalRuntimeChange: refreshExternalRuntimeBinding,
    });
    if (handled) {
      setContextUsage(formatContextUsageLabel(agent.getContextUsageSnapshot()));
      if (result) addMessage("assistant", result, slashResultNoticeKind(result));
    }
  }, [
    addMessage,
    agent,
    applyThemeMode,
    args.cwd,
    bashAllowlist,
    clearMessages,
    closePicker,
    createProvider,
    externalRuntime,
    fillComposer,
    flushMemory,
    hookController,
    lspService,
    mcpManager,
    openFeedback,
    openPicker,
    openRewindPicker,
    openSessionPicker,
    openStatsPanel,
    refreshExternalRuntimeBinding,
    requestExit,
    runMemoryCompaction,
    runMemoryRefresh,
    runMemorySummary,
    safeRegistry,
    safeSkillRegistry,
    settingsManager,
    startFreshSession,
    themeMode,
    themeResolved,
    transitionToNative,
  ]);

  const handleProviderSelect = useCallback((providerId: string) => {
    const run = async () => {
      if (isGrokSubscriptionProviderId(providerId)) {
        if (grokSessionBound) {
          closePicker();
          return;
        }
        await executeProviderCommand(`/provider --set ${GROK_SUBSCRIPTION_PROVIDER_ID}`);
        return;
      }

      await safeRegistry.prepareProvider(providerId);
      const configured = safeRegistry.getConfigured();
      const p = configured.find((x) => x.id === providerId);
      const builtin = BUILTIN_PROVIDERS.find((x) => x.id === providerId);
      if (!p && !builtin) {
        addMessage("error", `Provider ${providerId} not found.`);
        closePicker();
        return;
      }
      if (!p?.apiKey) {
        if (!p && builtin) {
          safeRegistry.addProvider(providerId, "");
        }
        setKeyProviderId(providerId);
        setPickerMode("key");
        return;
      }

      if (!createProvider) throw new Error("Provider creation not available");
      // Construct the target before stopping a Grok sidecar. A bad provider
      // configuration must leave the current external session untouched.
      const nextProvider = createProvider(providerId, p.apiKey, p.baseURL);
      await transitionToNative();
      agent.setProvider(nextProvider);
      agent.providerId = providerId;
      try {
        safeRegistry.setDefault(providerId);
      } catch (error) {
        addMessage("error", `Switched providers, but could not remember the default: ${errorMessage(error)}`);
      }
      addMessage("assistant", `Switched to provider ${p.name}. Use /model to pick a model.`);
      closePicker();
    };

    void run().catch((error) => {
      addMessage("error", `Failed to switch provider ${providerId}: ${errorMessage(error)}`);
      closePicker();
    });
  }, [addMessage, agent, closePicker, createProvider, executeProviderCommand, grokSessionBound, safeRegistry, transitionToNative]);

  const handleProviderAddSelect = useCallback((providerId: string) => {
    const run = async () => {
      if (isGrokSubscriptionProviderId(providerId)) {
        await executeProviderCommand(`/provider --add ${GROK_SUBSCRIPTION_PROVIDER_ID}`);
        return;
      }
      const ok = safeRegistry.addProvider(providerId, "");
      if (!ok) {
        addMessage("error", `Provider ${providerId} could not be added.`);
        closePicker();
        return;
      }
      setKeyProviderId(providerId);
      setPickerMode("key");
    };
    void run().catch((error) => {
      addMessage("error", `Failed to add provider ${providerId}: ${errorMessage(error)}`);
      closePicker();
    });
  }, [addMessage, closePicker, executeProviderCommand, safeRegistry]);

  const handleLoginProviderSelect = useCallback((providerId: string) => {
    void executeProviderCommand(`/login ${providerId}`).catch((error) => {
      addMessage("error", `Failed to log in to ${providerId}: ${errorMessage(error)}`);
    });
  }, [addMessage, executeProviderCommand]);

  const handleLogoutProviderSelect = useCallback((providerId: string) => {
    void executeProviderCommand(`/logout ${providerId}`).catch((error) => {
      addMessage("error", `Failed to log out of ${providerId}: ${errorMessage(error)}`);
    });
  }, [addMessage, executeProviderCommand]);

  const handleKeySubmit = useCallback((key: string) => {
    const run = async () => {
      const targetId = keyProviderId || safeRegistry.getDefault()?.id;
      if (!targetId) {
        addMessage("error", "No provider selected.");
        closePicker();
        setKeyProviderId(null);
        return;
      }
      safeRegistry.updateProviderKey(targetId, key);
      const p = safeRegistry.getConfigured().find((x) => x.id === targetId);
      if (p && createProvider) {
        const nextProvider = createProvider(targetId, key, p.baseURL);
        await transitionToNative();
        agent.setProvider(nextProvider);
        agent.providerId = targetId;
        try {
          safeRegistry.setDefault(targetId);
        } catch (error) {
          addMessage("error", `API key saved, but could not remember the default: ${errorMessage(error)}`);
        }
      }
      addMessage("assistant", `API key updated for ${p?.name || targetId} to ${maskKey(key)}.`);
      closePicker();
      setKeyProviderId(null);
    };
    void run().catch((error) => {
      addMessage("error", `Failed to update provider key: ${errorMessage(error)}`);
      closePicker();
    });
  }, [addMessage, agent, closePicker, createProvider, keyProviderId, safeRegistry, transitionToNative]);

  // /loop handler lives below handleSubmit (it needs addMessage only); the
  // ref breaks the declaration cycle so handleSubmit can route to it.
  const handleLoopCommandRef = useRef<((raw: string) => void) | null>(null);

  const handleSubmit = useCallback(
    async (payload: SubmitPayload | string) => {
      const initialPayload: SubmitPayload =
        typeof payload === "string" ? { text: payload, images: [] } : payload;
      const input = initialPayload.text;
      const displayInput = initialPayload.displayText ?? input;
      const images = initialPayload.images;
      if (!input.trim() && images.length === 0) return;

      // Agent already running: route the submit into the live run instead of
      // starting a new one. Plain prose steers the current turn; slash
      // commands, @-mentions and image payloads queue for the next turn.
      if (activeAbortRef.current) {
        if (/^\/(?:quit|exit)\s*$/.test(input.trim())) {
          requestExit();
          return;
        }
        if (externalSessionBound) {
          // External ACP turns do not support Bubble's boundary steer
          // protocol. Preserve ordering by sending every additional input to
          // the next turn instead.
          queueInput(initialPayload);
          return;
        }
        const steerEligible =
          !displayInput.trim().startsWith("/") &&
          !input.includes("@") &&
          images.length === 0;
        if (steerEligible) {
          submitSteer(initialPayload);
        } else {
          queueInput(initialPayload);
        }
        return;
      }

      const grokInputDecision = externalSessionBound
        ? classifyGrokInput({ text: input, imageCount: images.length })
        : undefined;
      if (grokInputDecision?.kind === "blocked") {
        addMessage("error", grokInputDecision.message);
        return;
      }
      if (grokInputDecision?.kind === "prompt" && unsupportedExternalSessionBound) {
        addMessage(
          "error",
          "This session has an unsupported external runtime binding. Native tools and providers are disabled; use /session, /provider, or /model to enter a fresh native session.",
        );
        return;
      }
      if (grokInputDecision?.kind === "prompt" && grokSessionBound && !externalRuntime) {
        addMessage(
          "error",
          "This session belongs to Grok Subscription, but its runtime is unavailable in this TUI. Use /model, /provider, or /session to enter a fresh native session.",
        );
        return;
      }

      const submitFingerprint = submitPayloadFingerprint(initialPayload);
      const startingDecision = decideStartingSubmitFingerprint(
        startingSubmitFingerprintRef.current,
        submitFingerprint,
      );
      if (startingDecision === "ignore") return;
      if (startingDecision === "queue") {
        queueInput(initialPayload);
        return;
      }

      const normalized = prepareSubmitDisplay(initialPayload);
      setStartingSubmit(submitFingerprint);
      try {
      const runAgentInput = async (
        actualInput: string | ContentPart[],
        displayInput: string,
        attachedImages: { filename?: string; bytes: number }[] = [],
        runOptions: { hidden?: boolean; goalRun?: boolean; imageDisplayStart?: number } = {},
      ) => {
        const runSessionFile = currentSessionFile();
        const runSessionManager = sessionManagerRef.current;
        const runExternalRuntime = isGrokSubscriptionProviderId(
          externalRuntimeBindingRef.current?.id,
        );
        const externalSessionId = runExternalRuntime
          ? externalRuntimeBindingRef.current?.sessionId
          : undefined;
        const externalModelId = runExternalRuntime
          ? externalRuntimeBindingRef.current?.modelId ?? "subscription-default"
          : undefined;
        const externalGeneration = runExternalRuntime
          ? ++externalRuntimeGenerationRef.current
          : undefined;
        const isCurrentExternalRun = () => !runExternalRuntime || (
          externalRuntimeGenerationRef.current === externalGeneration
          && currentSessionFile() === runSessionFile
          && isGrokSubscriptionProviderId(externalRuntimeBindingRef.current?.id)
          && externalRuntimeBindingRef.current?.sessionId === externalSessionId
        );

        if (runExternalRuntime) {
          if (!externalRuntime || typeof actualInput !== "string" || !externalSessionId || !runSessionManager) {
            addMessage("error", "Grok subscription session binding is unavailable. Start a fresh session with /login grok.");
            return;
          }
          const boundModelId = externalRuntimeBindingRef.current?.modelId;
          if (boundModelId) {
            await externalRuntime.hydrateSession(
              externalSessionId,
              boundModelId,
              externalRuntimeBindingRef.current?.reasoningEffort,
            );
          }
        } else {
          const activeProviderId = agent.providerId || safeRegistry.getDefault()?.id;
          const hasActiveProvider = !!activeProviderId && safeRegistry.getEnabled().some((provider) => provider.id === activeProviderId);
          if (!hasActiveProvider) {
            addMessage("error", "No provider configured. Use /login for ChatGPT or /provider --add <id> before sending a prompt.");
            if (runOptions.goalRun && goalStore?.snapshot()?.status === "active") {
              goalStore.pause();
              addMessage("assistant", stopReasonNotice("error"));
            }
            return;
          }
          if (!agent.model) {
            addMessage("error", "No model selected. Use /model after /login or provider setup.");
            if (runOptions.goalRun && goalStore?.snapshot()?.status === "active") {
              goalStore.pause();
              addMessage("assistant", stopReasonNotice("error"));
            }
            return;
          }
        }

        const displayContent = formatImageUserDisplayText(
          displayInput,
          attachedImages.length,
          runOptions.imageDisplayStart,
        );
        if (!runOptions.hidden) {
          updateDisplayMessages((prev) => [
            ...prev,
            withMessageKey({ role: "user", content: displayContent }),
          ]);
          // The new user row commits to native scrollback; the terminal keeps
          // the prompt in view, so there is no app-side "snap to bottom" to do.
        }
        if (runExternalRuntime) {
          runSessionManager!.appendMessage({ role: "user", content: actualInput as string });
        }
        setIsRunning(true);
        runStartRef.current = Date.now();
        setStreamingContent("");
        setStreamingReasoning("");
        setStreamingTools([]);
        setStreamingParts([]);

        let assistantContent = "";
        let assistantReasoning = "";
        let goalRunTokens = 0;
        let goalRunUsageReported = false;
        let runCancelled = false;
        let runErrored = false;
        const toolCalls: DisplayToolCall[] = [];
        const assistantParts: DisplayMessagePart[] = [];
        let assistantSystemFingerprint: string | undefined;
        // Entries whose members all reached a final status are now covered by
        // the settled transcript; drop them so the accumulator stays bounded
        // across a long session. Running entries survive — for a workflow
        // spanning turns they are the only live view of its members.
        if (pruneSettledLiveSubagentTools(liveSubagentToolsRef.current)) {
          setLiveSubagentVersion((version) => version + 1);
        }
        const abortController = new AbortController();
        activeAbortRef.current = abortController;
        setStartingSubmit(null);
        const inputController = new AgentRunInputQueue(`run-${++nextRunIdRef.current}`);
        inputControllerRef.current = inputController;

        const syncStreamingParts = () => {
          setStreamingParts(snapshotDisplayParts(assistantParts));
        };
        // Text/reasoning deltas arrive far faster than the screen needs to
        // update; batch them so the full-frame re-render runs at most every
        // STREAMING_FLUSH_INTERVAL_MS. Tool events stay immediate.
        let streamingFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const cancelStreamingFlush = () => {
          if (streamingFlushTimer !== null) {
            clearTimeout(streamingFlushTimer);
            streamingFlushTimer = null;
          }
        };
        const scheduleStreamingFlush = () => {
          if (streamingFlushTimer !== null) return;
          streamingFlushTimer = setTimeout(() => {
            streamingFlushTimer = null;
            setStreamingContent(assistantContent);
            setStreamingReasoning(assistantReasoning);
            syncStreamingParts();
          }, STREAMING_FLUSH_INTERVAL_MS);
        };
        const hasAssistantOutput = () => (
          !!assistantContent ||
          !!assistantReasoning ||
          toolCalls.length > 0 ||
          assistantParts.length > 0
        );
        const commitAssistantMessage = (taskElapsedMs?: number) => {
          if (!hasAssistantOutput() || !isCurrentExternalRun()) return;

          const currentParts = snapshotDisplayParts(assistantParts);
          const currentToolCalls = [...toolCalls];
          const partContent = assistantContent || contentFromParts(currentParts);
          const partToolCalls = currentToolCalls.length > 0
            ? currentToolCalls
            : toolCallsFromParts(currentParts);
          const msg: DisplayMessage = {
            key: nextDisplayMessageKey("asst"),
            role: "assistant",
            content: partContent,
          };
          if (assistantReasoning) {
            msg.reasoning = assistantReasoning;
          }
          if (partToolCalls.length > 0) {
            msg.toolCalls = partToolCalls;
          }
          if (currentParts.length > 0) {
            msg.parts = currentParts;
          }
          if (taskElapsedMs !== undefined && Number.isFinite(taskElapsedMs) && taskElapsedMs > 0) {
            msg.taskElapsedMs = taskElapsedMs;
          }
          if (assistantSystemFingerprint) {
            msg.systemFingerprint = assistantSystemFingerprint;
          }
          updateDisplayMessages((prev) => [...prev, msg]);
          if (runExternalRuntime) {
            runSessionManager!.appendMessage({
              role: "assistant",
              content: partContent,
              ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
              providerId: "grok",
              model: "grok-subscription",
              modelId: externalModelId,
            });
          }
        };
        const clearAssistantStream = () => {
          // A timer firing after this reset would resurrect the just-committed
          // text as a phantom streaming block — cancel before clearing.
          cancelStreamingFlush();
          setStreamingContent("");
          setStreamingReasoning("");
          setStreamingTools([]);
          setStreamingParts([]);
          assistantContent = "";
          assistantReasoning = "";
          assistantSystemFingerprint = undefined;
          toolCalls.length = 0;
          assistantParts.length = 0;
        };

        try {
          const eventStream: AsyncIterable<AgentEvent> = runExternalRuntime
            ? externalRuntime!.run(actualInput as string, {
                sessionId: externalSessionId,
                signal: abortController.signal,
                generation: externalGeneration,
              })
            : agent.run(actualInput, args.cwd, {
                abortSignal: abortController.signal,
                inputController,
              });
          for await (const event of eventStream) {
            if (runExternalRuntime) {
              if (!isCurrentExternalRun()) {
                abortController.abort(new AgentAbortError("Stale Grok runtime generation."));
                break;
              }
              if (
                event.type !== "turn_start"
                && event.type !== "text_delta"
                && event.type !== "reasoning_delta"
                && event.type !== "tool_start"
                && event.type !== "tool_update"
                && event.type !== "tool_end"
                && event.type !== "turn_end"
              ) {
                await externalRuntime!.cancel(externalSessionId).catch(() => undefined);
                throw new GrokRuntimeError(
                  "policy_violation",
                  "Grok emitted an unsupported external runtime event.",
                );
              }
            }
            switch (event.type) {
              case "turn_start":
                // A fresh provider call is starting. Everything worth keeping
                // was committed at the preceding turn_end, so leftovers here
                // can only be a half-built attempt the agent discarded (its
                // stream-interruption retry re-issues the whole request and
                // never appends the partial message — see agent.ts). Drop the
                // stale buffer, or the retry re-streams the same opening text
                // on top of it and the answer duplicates on screen.
                clearAssistantStream();
                break;
              case "text_delta":
                assistantContent += event.content;
                appendTextPart(assistantParts, event.content);
                scheduleStreamingFlush();
                break;
              case "reasoning_delta":
                assistantReasoning += event.content;
                scheduleStreamingFlush();
                break;
              case "tool_call_start": {
                // The LLM has begun emitting this tool call. Args are still
                // streaming — render an empty-args placeholder so the user
                // sees the tool the moment it appears in the assistant
                // response, not after the full arg payload finishes.
                if (!toolCalls.some((t) => t.id === event.id)) {
                  const toolCall: DisplayToolCall = {
                    id: event.id,
                    name: event.name,
                    args: {},
                    startedAt: Date.now(),
                  };
                  toolCalls.push(toolCall);
                  appendToolPart(assistantParts, toolCall);
                  setStreamingTools([...toolCalls]);
                  syncStreamingParts();
                }
                break;
              }
              case "tool_call_delta": {
                // Best-effort parse of the partial argument JSON to extract
                // identifying fields (path, command, content, …). The buffer
                // is incomplete JSON during streaming, so fall back to regex
                // peeks on common string fields.
                const tc = toolCalls.find((t) => t.id === event.id);
                if (tc) {
                  tc.args = parsePartialArgs(event.arguments, tc.args);
                  setStreamingTools([...toolCalls]);
                  syncStreamingParts();
                }
                break;
              }
              case "tool_call_end": {
                // Provider signaled args streaming is complete; agent will
                // emit tool_start next. We don't need to do anything visual
                // here — the placeholder is already in place and tool_start
                // will refresh it with the canonical parsed args.
                break;
              }
              case "tool_start": {
                // Tool is about to execute. Upgrade the placeholder created
                // by tool_call_start (or append if upstream skipped the
                // streaming path).
                const existing = toolCalls.find((t) => t.id === event.id);
                if (existing) {
                  existing.args = event.args;
                  existing.startedAt = existing.startedAt ?? Date.now();
                } else {
                  const toolCall: DisplayToolCall = {
                    id: event.id,
                    name: event.name,
                    args: event.args,
                    startedAt: Date.now(),
                  };
                  toolCalls.push(toolCall);
                  appendToolPart(assistantParts, toolCall);
                }
                setStreamingTools([...toolCalls]);
                syncStreamingParts();
                break;
              }
              case "tool_end": {
                const tc = toolCalls.find((t) => t.id === event.id);
                if (tc) {
                  tc.result = event.result.content;
                  tc.isError = event.result.isError;
                  tc.metadata = event.result.metadata;
                  setStreamingTools([...toolCalls]);
                  syncStreamingParts();
                }
                break;
              }
              case "tool_update": {
                const tc = toolCalls.find((t) => t.id === event.id);
                if (tc) {
                  tc.metadata = mergeToolMetadata(tc.metadata, event.update.metadata);
                  if (event.update.message) {
                    tc.result = event.update.message;
                  }
                  tc.isError = event.update.status === "failed"
                    || event.update.status === "blocked"
                    || event.update.status === "cancelled";
                  setStreamingTools([...toolCalls]);
                  syncStreamingParts();
                } else if (accumulateLiveSubagentUpdate(liveSubagentToolsRef.current, {
                  id: event.id,
                  name: event.name,
                  metadata: event.update.metadata,
                })) {
                  // The launching call already settled out of this round's
                  // toolCalls; absorbed into the live accumulator instead.
                  setLiveSubagentVersion((version) => version + 1);
                }
                break;
              }
              case "todos_updated": {
                setTodos(event.todos);
                break;
              }
              case "mode_changed": {
                // Marker already persisted by onModeUpdate at setMode time.
                setPermissionMode(event.mode);
                break;
              }
              case "input_applied": {
                // The steer joined the current turn at the next model-call
                // boundary. Move it after the just-finished tool/assistant
                // turn instead of clearing the badge in its original
                // placeholder position.
                //
                // This move pulls the pending-steer block out of the live
                // (dynamic) region and re-commits it elsewhere in <Static>, so
                // the live frame SHRINKS and the block's old rows are vacated
                // with nothing taking their place. Ink's in-place redraw leaves
                // those rows behind under tmux (its cursor-up clear can't reach
                // a frame that has scrolled), which is the blank gap users see
                // after steering. A full reprint (resetTranscript) rewrites the
                // transcript cleanly with no leftover — the same fix the resize
                // path uses. Unlike a turn settling (content moves in place),
                // this reorder is rare, so the reprint cost is acceptable.
                const steer = pendingSteersRef.current.get(event.id);
                if (steer) {
                  pendingSteersRef.current.delete(event.id);
                  setPendingSteerCount(pendingSteersRef.current.size);
                  // Moving the steer placeholder out of the live region into
                  // <Static> is a pure append (it was never in the settled list,
                  // only the dynamic block). Off a multiplexer Ink erases the
                  // vacated live rows in place, so a plain append avoids the
                  // full-screen reprint flash. Under tmux/screen the in-place
                  // erase can't reach scrolled rows, so keep the clean reprint.
                  const commit = isMultiplexedTerminal() ? resetTranscript : updateDisplayMessages;
                  commit((prev) => moveStatusMessageToEnd(prev, steer.displayKey));
                }
                break;
              }
              case "input_rejected": {
                // No model continuation left in this run: the steer moves to
                // the next turn's queue, badge flips to QUEUED.
                const steer = pendingSteersRef.current.get(event.id);
                if (steer) {
                  pendingSteersRef.current.delete(event.id);
                  setPendingSteerCount(pendingSteersRef.current.size);
                  updateDisplayMessages((prev) => prev.map((message) =>
                    message.key === steer.displayKey ? setUserInputStatus(message, "queued") : message,
                  ));
                  queuedInputsRef.current.push({
                    payload: { text: event.content, images: [] },
                    displayKey: steer.displayKey,
                    sessionFile: steer.sessionFile ?? runSessionFile,
                  });
                  setQueuedCount(queuedInputsRef.current.length);
                }
                break;
              }
              case "input_pending_changed": {
                if (event.pending === 0 && pendingSteersRef.current.size > 0) {
                  pendingSteersRef.current.clear();
                }
                setPendingSteerCount(event.pending === 0 ? 0 : event.pending);
                break;
              }
              case "turn_end": {
                if (event.usage) {
                  goalRunUsageReported = true;
                  goalRunTokens += tokenUsageTotal(event.usage);
                }
                assistantSystemFingerprint = event.systemFingerprint;
                setContextUsage(formatContextUsageLabel(agent.getContextUsageSnapshot()));
                if (event.willContinue) {
                  commitAssistantMessage();
                  clearAssistantStream();
                  break;
                }
                commitAssistantMessage(runStartRef.current ? Date.now() - runStartRef.current : undefined);
                clearAssistantStream();
                break;
              }
            }
          }
        } catch (err: any) {
          const staleExternalRun = runExternalRuntime && !isCurrentExternalRun();
          if (!staleExternalRun) commitAssistantMessage();
          const cancelledError = err instanceof AgentAbortError
            || err?.name === "AbortError"
            || (err instanceof GrokRuntimeError && err.code === "cancelled");
          if (staleExternalRun) {
            runCancelled = true;
          } else if (cancelledError) {
            runCancelled = true;
            // commitAssistantMessage already appended the partial answer; the
            // interrupt is otherwise a pure append (the partial + a "Interrupted"
            // row). Off a multiplexer, append just the interrupt row so settled
            // history is never reprinted — no flash. Under tmux/screen, fall back
            // to the full reprint that rebuilds from the canonical agent.messages.
            if (!runExternalRuntime && isMultiplexedTerminal()) {
              resetTranscript(() => reconstructDisplayMessages(agent.messages));
            } else {
              updateDisplayMessages((prev) => [
                ...prev,
                withMessageKey({
                  role: "assistant",
                  content: "Interrupted by user",
                  syntheticKind: "ui_interrupt",
                }),
              ]);
            }
          } else {
            runErrored = true;
            updateDisplayMessages((prev) => [
              ...prev,
              withMessageKey({ role: "error", content: errorMessage(err) }),
            ]);
          }
        } finally {
          cancelStreamingFlush();
          // Leftover steers that never reached a model-call boundary: drop
          // them on cancel (the user asked the run to stop); requeue them for
          // the next turn on a normal end.
          const cancelled = abortController.signal.aborted;
          if (cancelled) runCancelled = true;
          if (runExternalRuntime && runCancelled) {
            // External ACP owns its own conversation state, so Bubble persists
            // an explicit boundary for its local transcript. Without this,
            // a partial response looks successfully completed after resume.
            runSessionManager!.appendMessage({
              role: "assistant",
              content: INTERRUPTED_ASSISTANT_CONTENT,
              error: {
                name: "MessageAbortedError",
                message: "Assistant response was interrupted by the user.",
                aborted: true,
              },
              providerId: "grok",
              model: "grok-subscription",
              modelId: externalModelId,
            });
          }
          for (const leftover of inputController.clear()) {
            const steer = pendingSteersRef.current.get(leftover.id);
            pendingSteersRef.current.delete(leftover.id);
            if (cancelled) {
              if (steer) {
                updateDisplayMessages((prev) => prev.filter((message) => message.key !== steer.displayKey));
              }
              continue;
            }
            if (steer) {
              updateDisplayMessages((prev) => prev.map((message) =>
                message.key === steer.displayKey ? setUserInputStatus(message, "queued") : message,
              ));
            }
            queuedInputsRef.current.push({
              payload: { text: leftover.content, images: [] },
              displayKey: steer?.displayKey,
              sessionFile: steer?.sessionFile ?? runSessionFile,
            });
          }
          const ownsCurrentUiGeneration = !runExternalRuntime || isCurrentExternalRun();
          if (ownsCurrentUiGeneration) {
            setPendingSteerCount(0);
            setQueuedCount(queuedInputsRef.current.length);
          }
          if (inputControllerRef.current === inputController) inputControllerRef.current = null;
          if (activeAbortRef.current === abortController) activeAbortRef.current = null;
          if (ownsCurrentUiGeneration) {
            setIsRunning(false);
            runStartRef.current = null;
            setStreamingContent("");
            setStreamingReasoning("");
            setStreamingTools([]);
            setStreamingParts([]);
          }
          if (!runExternalRuntime) {
            maybeContinueGoal({
              runCancelled,
              runErrored,
              isGoalRun: !!runOptions.goalRun,
              runTokens: goalRunTokens,
              usageReported: goalRunUsageReported,
            });
          }
        }
      };

      const kickGoalTurn = (prompt: string, visibleInput?: string) => {
        if (activeAbortRef.current) return;
        queueMicrotask(() => {
          void runAgentInput(prompt, visibleInput ?? "", [], {
            hidden: visibleInput === undefined,
            goalRun: true,
          });
        });
      };

      function maybeContinueGoal(input: { runCancelled: boolean; runErrored: boolean; isGoalRun: boolean; runTokens: number; usageReported: boolean }) {
        if (!goalStore || exitRequestedRef.current) return;
        const current = goalStore.snapshot();
        if (!current) return;

        if (input.runCancelled || input.runErrored) {
          if (current.status === "active") {
            goalStore.pause();
            addMessage("assistant", stopReasonNotice(input.runErrored ? "error" : "cancelled"));
          }
          return;
        }

        if (input.isGoalRun) {
          if (input.usageReported) {
            if (input.runTokens > 0) goalStore.addTokens(input.runTokens);
          } else {
            goalStore.markTokenUsageUnavailable();
          }
          goalStore.incrementTurn();
        }

        const goal = goalStore.snapshot()!;
        const decision = shouldContinueGoal({
          goal,
          queuedInputs: queuedInputsRef.current.length,
        });

        if (decision.continue) {
          kickGoalTurn(formatInternalContextBlock("goal", continuationPrompt(goal)));
          return;
        }

        if (decision.reason === "budget" && goal.status === "active") {
          goalStore.markBudgetLimited();
        }
        if (decision.reason === "complete") {
          addMessage("assistant", goalCompleteNotice(goal));
          return;
        }
        const note = stopReasonNotice(decision.reason);
        if (note) addMessage("assistant", note);
      }

      const handleGoalCommand = async (goalInput: string) => {
        if (!goalStore) {
          addMessage("error", "Goals are not available in this session.");
          return;
        }
        const command = parseGoalCommand(goalInput);
        if (command.error) {
          addMessage("error", command.error);
          return;
        }
        const existing = goalStore.snapshot();
        switch (command.kind) {
          case "show": {
            addMessage("assistant", existing ? goalSummaryText(existing) : "No active goal. Set one with /goal <objective>");
            return;
          }
          case "clear": {
            if (!existing) { addMessage("assistant", "No active goal to clear"); return; }
            goalStore.clear();
            addMessage("assistant", "Goal cleared");
            return;
          }
          case "pause": {
            if (!existing) { addMessage("assistant", "No active goal to pause"); return; }
            goalStore.pause();
            addMessage("assistant", "Goal paused — /goal resume to continue");
            return;
          }
          case "resume": {
            if (!existing) { addMessage("assistant", "No goal to resume. Set one with /goal <objective>"); return; }
            const resumed = goalStore.resume();
            if (resumed?.status === "active") {
              addMessage("assistant", "Goal resumed");
              kickGoalTurn(formatInternalContextBlock("goal", continuationPrompt(resumed)));
            } else {
              addMessage("assistant", "Goal cannot be resumed (already complete)");
            }
            return;
          }
          case "edit": {
            if (!existing) { addMessage("assistant", "No active goal to edit. Set one with /goal <objective>"); return; }
            goalStore.edit(command.objective!);
            if (command.tokenBudget !== undefined) goalStore.setBudget(command.tokenBudget);
            addMessage("assistant", `Goal updated: ${truncate(goalStore.snapshot()!.objective, 60)}`);
            return;
          }
          case "set": {
            const goal = goalStore.set(command.objective!, { tokenBudget: command.tokenBudget });
            const budgetNote = goal.tokenBudget !== undefined ? ` (budget ${goal.tokenBudget} tok)` : "";
            addMessage("assistant", `Goal set${budgetNote} — working autonomously. /goal pause to stop.`);
            kickGoalTurn(formatInternalContextBlock("goal", initialPrompt(goal)), goalInput.trim());
            return;
          }
        }
      };

      // Background-task wake (design §2.3b): an internal continuation, not a
      // user message — hidden from the transcript (the ✦ notice row is the
      // user-facing record) and wrapped as internal context for the model.
      if (initialPayload.internal === "task_wake") {
        await runAgentInput(input, "", [], { hidden: true });
        return;
      }

      // Slash commands and skill invocations drop any attached images —
      // they're meant for pure command routing.
      if (input.trimStart().startsWith("/")) {
        // Fast-path `/quit` and `/exit` before slash-registry / skill
        // resolution. This guarantees a literal "/quit" always exits even if
        // a skill or alias of the same name is later registered. The
        // canonical handler still lives in slash-commands/commands.ts so
        // `/help` and the slash menu can list it; both paths end up calling
        // requestExit().
        if (/^\/(?:quit|exit)\s*$/.test(input.trim())) {
          requestExit();
          return;
        }

        if (!externalSessionBound) {
          if (/^\/goal(?:\s|$)/.test(input.trim())) {
            await handleGoalCommand(input);
            return;
          }

          if (/^\/loop(?:\s|$)/.test(input.trim())) {
            handleLoopCommandRef.current?.(input);
            return;
          }

          const skillInvocation = parseSkillInvocation(input, safeSkillRegistry);
          if (skillInvocation) {
            await runAgentInput(skillInvocation.actualPrompt, displayInput);
            return;
          }
        }

        const { handled, result, inject } = await slashRegistry.execute(input, {
          agent,
          addMessage,
          clearMessages,
          cwd: args.cwd,
          exit: () => { requestExit(); },
          sessionManager,
          createProvider: createProvider ?? ((() => {
            throw new Error("Provider creation not available");
          }) as any),
          openPicker,
          openSessionPicker,
          openRewindPicker,
          openFeedback,
          fillComposer,
          registry: safeRegistry,
          skillRegistry: safeSkillRegistry!,
          bashAllowlist,
          settingsManager,
          lspService,
          mcpManager,
          hookController,
          flushMemory,
          runMemoryCompaction,
          runMemorySummary,
          runMemoryRefresh,
          getThemeMode: () => themeMode,
          getResolvedTheme: () => themeResolved,
          setThemeMode: applyThemeMode,
          openStats: openStatsPanel,
          compactionProgress: setCompaction,
          externalRuntime,
          startFreshSession,
          transitionToNative,
          onExternalRuntimeChange: refreshExternalRuntimeBinding,
        });
        if (handled) {
          if (agent.mode !== permissionMode) {
            setPermissionMode(agent.mode);
          }
          // Context-rewriting commands (/clear, /compact, /rewind, /model…)
          // mutate agent state without a provider turn, so the footer's
          // usage readout would keep the pre-command value until the next
          // turn_end. Resync it from live agent state here.
          setContextUsage(formatContextUsageLabel(agent.getContextUsageSnapshot()));
          if (result) {
            // `/compact` rewrites agent.messages, so the Ink transcript needs to
            // be rebuilt from the new agent state before appending the summary
            // card; otherwise the pre-compaction history would keep rendering.
            if (result.startsWith("✓ Compaction complete")) {
              const summary = latestCompactionSummary(agent.messages);
              resetTranscript(() => [
                ...reconstructDisplayMessages(agent.messages),
                {
                  role: "assistant",
                  content: result,
                  syntheticKind: "ui_compact_summary",
                  compactionSummary: summary,
                },
              ]);
            } else if (result.startsWith("⏪")) {
              // /rewind truncated agent.messages — rebuild the transcript from
              // the rewound state before appending the summary. Subagents
              // rewound out of history must not linger in the live accumulator.
              clearLiveSubagentTools();
              resetTranscript(() => [
                ...reconstructDisplayMessages(agent.messages),
                { role: "assistant", content: result },
              ]);
            } else {
              addMessage("assistant", result, slashResultNoticeKind(result));
            }
          }
          if (inject) {
            await runAgentInput(inject, displayInput);
          }
          return;
        }
        if (externalSessionBound) {
          addMessage("error", "That command is unavailable in this external runtime session.");
          return;
        }
      }
      if (grokSessionBound) {
        await runAgentInput(input, displayInput);
        return;
      }
      const expansion = await expandAtMentions(input, args.cwd);
      if (expansion.missing.length > 0) {
        addMessage("error", `Could not resolve @mention: ${expansion.missing.join(", ")}`);
      }
      for (const skip of expansion.skipped) {
        if (skip.reason !== "too large") addMessage("error", `Skipped @${skip.path}: ${skip.reason}`);
      }
      const agentInput: string | ContentPart[] = images.length > 0
        ? [
            ...(expansion.text ? [{ type: "text" as const, text: expansion.text }] : []),
            ...images.map((img) => ({
              type: "image_url" as const,
              image_url: { url: img.dataUrl },
            })),
          ]
        : expansion.text;
      await runAgentInput(
        agentInput,
        displayInput,
        images.map((img) => ({ filename: img.filename, bytes: img.bytes })),
        { imageDisplayStart: normalized.imageDisplayStart },
      );
      } finally {
        if (startingSubmitFingerprintRef.current === submitFingerprint) {
          setStartingSubmit(null);
        }
      }
    },
    [addMessage, agent, args.cwd, openPicker, openSessionPicker, openRewindPicker, openStatsPanel, createProvider, currentSessionFile, externalRuntime, externalRuntimeBinding, externalSessionBound, fillComposer, grokSessionBound, prepareSubmitDisplay, refreshExternalRuntimeBinding, safeRegistry, safeSkillRegistry, startFreshSession, transitionToNative, unsupportedExternalSessionBound, updateDisplayMessages, queueInput, submitSteer, requestExit, setStartingSubmit]
  );

  // --- Background tasks: markers, notices, auto-resume (design §2.3b) ---
  // Owner SessionManager captured at spawn so markers always land in the
  // owner session's jsonl, regardless of what is bound when the task ends.
  const taskOwnerSessionsRef = useRef(new Map<string, SessionManager>());
  // Completions for non-current sessions, held until switch-back (§2.2c).
  const pendingTaskCompletionsRef = useRef(new Map<string, BackgroundTaskInfo[]>());
  const taskWakeCoalescerRef = useRef<TaskWakeCoalescer | null>(null);

  const announceTaskCompletion = useCallback((task: BackgroundTaskInfo) => {
    const elapsed = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
    addMessage(
      "assistant",
      `Background task ${task.id}${task.description ? ` (${task.description})` : ""} ${task.status}${task.exitCode != null ? ` — exit ${task.exitCode}` : ""} in ${elapsed}s.`,
      "ui_notice",
    );
  }, [addMessage]);

  const fireTaskWake = useCallback((tasks: BackgroundTaskInfo[]) => {
    if (!processManager) return;
    // Gate at FIRE time (after the debounce): a turn that started meanwhile
    // or queued user input suppresses the wake — the state-change reminder
    // carries the completion into the next turn instead.
    if (!shouldFireTaskWake({
      autoResume: tasksAutoResume !== false,
      turnRunning: !!activeAbortRef.current,
      queuedInputs: queuedInputsRef.current.length,
      exiting: exitRequestedRef.current,
    })) {
      return;
    }
    const summary = formatTaskWakeSummary(tasks, (id) => processManager.taskOutputTail(id, 2000));
    for (const task of tasks) processManager.markTaskDelivered(task.id);
    void handleSubmit({
      text: formatInternalContextBlock("task-finished", summary),
      images: [],
      internal: "task_wake",
    });
  }, [handleSubmit, processManager, tasksAutoResume]);

  const refreshTaskSnapshot = useCallback(() => {
    if (!processManager) return;
    setTaskSnapshot(processManager.listTasks(sessionManagerRef.current?.getSessionFile()));
  }, [processManager]);

  useEffect(() => {
    refreshTaskSnapshot();
  }, [refreshTaskSnapshot, sessionManager]);

  useEffect(() => {
    if (!processManager) return;
    taskWakeCoalescerRef.current = new TaskWakeCoalescer(TASK_WAKE_DEBOUNCE_MS, fireTaskWake);
    const unsubSnapshot = processManager.onChange(() => refreshTaskSnapshot());
    const unsubChange = processManager.onChange((task) => {
      if (task.status !== "running" || taskOwnerSessionsRef.current.has(task.id)) return;
      const owner = sessionManagerRef.current;
      if (!owner || task.ownerSessionId !== owner.getSessionFile()) return;
      taskOwnerSessionsRef.current.set(task.id, owner);
      owner.appendMarker("task_started", JSON.stringify({
        id: task.id,
        pid: task.pid,
        startedAt: task.startedAt,
        command: task.command,
        description: task.description,
      }));
    });
    const unsubFinish = processManager.onTaskFinished((task) => {
      taskOwnerSessionsRef.current.get(task.id)?.appendMarker(
        task.status === "killed" ? "task_killed" : "task_finished",
        JSON.stringify({ id: task.id, status: task.status, exitCode: task.exitCode ?? null, endedAt: task.endedAt }),
      );
      const currentFile = sessionManagerRef.current?.getSessionFile();
      if (task.ownerSessionId !== currentFile) {
        if (taskEligibleForWake(task) && task.ownerSessionId) {
          const held = pendingTaskCompletionsRef.current.get(task.ownerSessionId) ?? [];
          held.push(task);
          pendingTaskCompletionsRef.current.set(task.ownerSessionId, held);
        }
        return;
      }
      announceTaskCompletion(task);
      if (taskEligibleForWake(task)) taskWakeCoalescerRef.current?.add(task);
    });
    return () => {
      unsubSnapshot();
      unsubChange();
      unsubFinish();
      taskWakeCoalescerRef.current?.cancel();
      taskWakeCoalescerRef.current = null;
    };
  }, [announceTaskCompletion, fireTaskWake, processManager, refreshTaskSnapshot]);

  // Switch-back sweep: completions held for this session fire now (§2.2c).
  useEffect(() => {
    if (!processManager) return;
    const file = sessionManager?.getSessionFile();
    if (!file) return;
    const held = pendingTaskCompletionsRef.current.get(file);
    if (!held?.length) return;
    pendingTaskCompletionsRef.current.delete(file);
    for (const task of held) {
      announceTaskCompletion(task);
      taskWakeCoalescerRef.current?.add(task);
    }
  }, [announceTaskCompletion, processManager, sessionManager]);

  // Resume-time orphan report: dangling task_started markers from a previous
  // process, probed for liveness (§2.2c). Runs once per mount.
  const orphanProbeDoneRef = useRef(false);
  useEffect(() => {
    if (!processManager || orphanProbeDoneRef.current) return;
    orphanProbeDoneRef.current = true;
    const manager = sessionManagerRef.current;
    if (!manager) return;
    let entries: Array<{ type: string; kind?: string; value?: string }>;
    try {
      entries = manager.getEntries() as Array<{ type: string; kind?: string; value?: string }>;
    } catch {
      return;
    }
    for (const orphan of findDanglingTaskStarts(entries)) {
      const alive = isPidAlive(orphan.pid);
      addMessage(
        "assistant",
        alive
          ? `Background task ${orphan.id}${orphan.description ? ` (${orphan.description})` : ""} from a previous process is still running (pid ${orphan.pid}). Kill it manually if unwanted: kill ${orphan.pid}`
          : `Background task ${orphan.id}${orphan.description ? ` (${orphan.description})` : ""} was orphaned by a previous process and is no longer running.`,
        "ui_notice",
      );
    }
  }, [addMessage, processManager]);

  // --- /loop: recurring prompts (design §2.6) ---
  const loopsRef = useRef<LoopState[]>([]);
  const nextLoopIdRef = useRef(1);
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  const handleLoopCommand = useCallback((raw: string) => {
    const parsed = parseLoopCommand(raw);
    if (parsed.action === "help" || parsed.error) {
      addMessage("assistant", parsed.error ?? "Usage: /loop <interval> <prompt> (e.g. /loop 5m check CI status). Also: /loop list, /loop stop [id].");
      return;
    }
    if (parsed.action === "list") {
      addMessage("assistant", formatLoopList(loopsRef.current, Date.now()));
      return;
    }
    if (parsed.action === "stop") {
      if (parsed.stopId === undefined) {
        const count = loopsRef.current.length;
        loopsRef.current = [];
        addMessage("assistant", count > 0 ? `Stopped ${count} loop${count === 1 ? "" : "s"}.` : "No active loops.");
        return;
      }
      const before = loopsRef.current.length;
      loopsRef.current = loopsRef.current.filter((loop) => loop.id !== parsed.stopId);
      addMessage("assistant", loopsRef.current.length < before ? `Stopped loop #${parsed.stopId}.` : `No loop #${parsed.stopId}.`);
      return;
    }
    if (loopsRef.current.length >= MAX_ACTIVE_LOOPS) {
      addMessage("assistant", `Loop limit reached (${MAX_ACTIVE_LOOPS}). Stop one with /loop stop [id] first.`);
      return;
    }
    const loop: LoopState = {
      id: nextLoopIdRef.current++,
      prompt: parsed.prompt!,
      intervalMs: parsed.intervalMs!,
      // Fires immediately on creation (next idle tick), then repeats.
      nextFireAt: Date.now(),
      fires: 0,
    };
    loopsRef.current = [...loopsRef.current, loop];
    addMessage("assistant", `Loop #${loop.id} set: every ${formatInterval(loop.intervalMs)} — ${loop.prompt}\nSession-scoped; /loop stop ${loop.id} to cancel.`, "ui_notice");
  }, [addMessage]);
  handleLoopCommandRef.current = handleLoopCommand;

  useEffect(() => {
    const timer = setInterval(() => {
      if (loopsRef.current.length === 0 || exitRequestedRef.current) return;
      const now = Date.now();
      for (const loop of loopsRef.current) {
        const decision = decideLoopFiring(loop, now, !!activeAbortRef.current);
        if (decision === "wait") continue;
        loop.nextFireAt = now + loop.intervalMs;
        if (decision === "defer") {
          // Defer-not-stack (design §2.6): the previous turn is still running.
          addMessage("assistant", `Loop #${loop.id} skipped this interval (a turn is still running); next in ${formatInterval(loop.intervalMs)}.`, "ui_notice");
          continue;
        }
        loop.fires += 1;
        void handleSubmitRef.current({
          text: loop.prompt,
          displayText: `⟳ loop #${loop.id}: ${loop.prompt}`,
          images: [],
        });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [addMessage]);

  // Drain the queue once the run ends and no modal needs the user first.
  // The placeholder row is removed right before resubmitting — handleSubmit
  // renders the message again as a regular user row.
  const drainQueuedInput = useCallback(() => {
    if (activeAbortRef.current) return;
    if (startingSubmitFingerprintRef.current) return;
    if (pendingPlan || pendingApproval || pendingQuestion || pendingFeedback || pickerMode || statsPanel) return;
    const next = queuedInputsRef.current.shift();
    if (!next) return;
    setQueuedCount(queuedInputsRef.current.length);
    if (next.displayKey) {
      updateDisplayMessages((prev) => prev.filter((message) => message.key !== next.displayKey));
    }
    if (!isQueuedInputForCurrentSession(next, currentSessionFile())) return;
    void handleSubmit(next.payload);
  }, [pendingPlan, pendingApproval, pendingQuestion, pendingFeedback, pickerMode, statsPanel, currentSessionFile, updateDisplayMessages, handleSubmit]);

  useEffect(() => {
    if (isRunning || queuedCount === 0) return;
    if (startingSubmitFingerprint) return;
    if (pendingPlan || pendingApproval || pendingQuestion || pendingFeedback || pickerMode || statsPanel) return;
    const timer = setTimeout(drainQueuedInput, 0);
    return () => clearTimeout(timer);
  }, [isRunning, queuedCount, startingSubmitFingerprint, pendingPlan, pendingApproval, pendingQuestion, pendingFeedback, pickerMode, statsPanel, drainQueuedInput]);

  const currentProviderId = externalSessionBound
    ? (grokSessionBound ? GROK_SUBSCRIPTION_PROVIDER_ID : undefined)
    : agent.providerId || safeRegistry.getDefault()?.id;
  const keyTarget = keyProviderId
    ? safeRegistry.getConfigured().find((p) => p.id === keyProviderId)
    : safeRegistry.getDefault();

  // Surface a pending approval as an inline badge on the matching tool row.
  // ApprovalRequest does not carry a toolCallId today; matching is loose by
  // type + the most identifying arg (path/command).
  const approvalHint: PendingApprovalHint | null = pendingApproval
    ? (() => {
        const r = pendingApproval.request;
        if (r.type === "bash") return { toolName: "bash" as const, command: r.command };
        if (r.type === "edit") return { toolName: "edit" as const, path: r.path };
        if (r.type === "write") return { toolName: "write" as const, path: r.path };
        return null;
      })()
    : null;

  // Binary thinking toggles have only off/on, so the graded ">2 levels" gate would hide their label;
  // surface it too (rendered as "thinking mode" by formatModelLine).
  const isThinkingToggle = isThinkingToggleModel(agent.providerId, agent.apiModel);
  const availableThinkingLevels = getAvailableThinkingLevels(agent.providerId, agent.apiModel);
  const isThinkingOnly = isThinkingOnlyLevels(availableThinkingLevels);
  const showThinkingLabel = Boolean(thinkingLevel)
    && thinkingLevel !== "off"
    && (isThinkingToggle || isThinkingOnly || availableThinkingLevels.length > 2);
  // The banner's model row stays live until the first settled row commits it
  // into <Static> scrollback (so a /model switch on the fresh launch screen
  // updates in place); after that the accent-colored transcript notices carry
  // model changes. External runtimes surface theirs via the footer runtimeLabel.
  const bannerTips = buildTips(agent, safeRegistry, grokSessionBound);
  const bannerProviderId = grokSessionBound ? "grok" : externalSessionBound ? undefined : agent.providerId || safeRegistry.getDefault()?.id;
  const bannerModelId = grokSessionBound ? externalRuntimeBinding?.modelId : externalSessionBound ? undefined : agent.apiModel;
  const bannerModelLabel = externalSessionBound
    ? (grokSessionBound
        ? `Grok Subscription${externalRuntimeBinding?.modelId ? ` · ${externalRuntimeBinding.modelId}` : ""}`
        : "Unsupported external runtime · recovery-only mode")
    : agent.model ? displayModel(agent.model) : undefined;
  const bannerThinkingLabel = grokSessionBound
    ? externalRuntimeBinding?.reasoningEffort
    : !externalSessionBound && showThinkingLabel ? thinkingLevel : undefined;
  // Footer surfaces the graded effort level too (grok/DeepSeek/OpenAI ladders),
  // but skips on/off toggles and thinking-only placeholders ("medium").
  const footerThinkingLabel = !externalSessionBound
    && thinkingLevel
    && thinkingLevel !== "off"
    && !isThinkingToggle
    && !isThinkingOnly
    ? thinkingLevel
    : undefined;
  const welcomeBannerNode = showWelcome ? (
    <Box flexDirection="column" marginBottom={1}>
      <BubbleCodeWordmark width={terminalColumns} />
      <WelcomeBanner
        terminalColumns={terminalColumns}
        tips={bannerTips}
        updateNotice={currentUpdateNotice}
        cwd={friendlyCwd(args.cwd)}
        sessionLabel={sessionBasename(currentSessionFile())}
        providerId={bannerProviderId}
        modelId={bannerModelId}
        modelLabel={bannerModelLabel}
        thinkingLabel={bannerThinkingLabel}
      />
    </Box>
  ) : null;
  const commandPaletteItems = useMemo(
    () => buildCommandPaletteItems(safeSkillRegistry, externalSessionBound),
    [externalSessionBound, safeSkillRegistry],
  );
  const mcpReconnectItems = useMemo(
    () => buildMcpReconnectItems(mcpManager),
    [mcpManager],
  );

  // No fixed-height frame: settled rows flow into the terminal's native
  // scrollback via <Static>, and only the dynamic bottom stack (streaming
  // tail, pickers, composer, footer) occupies the live region. Letting it size
  // to its content keeps the composer pinned just below the latest output the
  // way ordinary shell programs do.
  const mainWidth = Math.max(40, terminalColumns);

  return (
    <ThemeProvider value={palette}>
      {/* No backgroundColor here: ink's Box wraps its children in a
          backgroundContext.Provider ONLY when a background is set, so toggling
          palette.background (canvas paint on forced-theme mismatch) would change
          the element type above <Static>, remounting it — which reprints the
          whole transcript into scrollback and resets every picker's selection.
          The canvas is painted per-region instead: static items in MessageList,
          each dynamic-stack wrapper below. */}
      <Box flexDirection="column" width={mainWidth}>
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          streamingReasoning={streamingReasoning}
          streamingTools={streamingTools}
          streamingParts={streamingParts}
          terminalColumns={mainWidth}
          showThinking={showThinking}
          verboseTrace={verboseTrace}
          pendingApproval={approvalHint}
          nowTick={nowTick}
          welcomeBanner={welcomeBannerNode}
          staticGeneration={staticGeneration}
          paddingX={1}
          maxStreamRows={Math.max(6, terminalRows - 10)}
        />
        {/* Pickers live in the fixed bottom stack (not the scrollable
            transcript) so they can never be scrolled out of view. */}
        {pickerMode === "grok-model" && (
          <Box paddingX={1} flexShrink={0}>
            {grokModels.length === 0 ? (
              <Text>Loading Grok subscription models…</Text>
            ) : (
              <ProviderPicker
                title="Select Grok Model and Reasoning"
                providers={grokModels.flatMap((model) => model.reasoningLevels.map((effort) => ({
                  id: JSON.stringify({ modelId: model.id, reasoningEffort: effort }),
                  name: `${model.name}${effort === "off" ? "" : ` · ${effort}`}`,
                  enabled: true,
                })))}
                current={JSON.stringify({
                  modelId: externalRuntimeBinding?.modelId,
                  reasoningEffort: externalRuntimeBinding?.reasoningEffort ?? "high",
                })}
                onSelect={handleGrokModelSelect}
                onCancel={closePicker}
              />
            )}
          </Box>
        )}
        {pickerMode === "model" && (
          <Box paddingX={1} flexShrink={0}>
            <ModelPicker
              registry={safeRegistry}
              current={agent.model}
              currentThinkingLevel={thinkingLevel}
              recent={userConfig.getRecentModels()}
              onSelect={handleModelSelect}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "provider" && (
          <Box paddingX={1} flexShrink={0}>
            <ProviderPicker
              providers={withGrokSubscriptionProvider(
                BUILTIN_PROVIDERS
                  .filter((p) => isUserVisibleProvider(p.id))
                  .map((p) => {
                  const configured = safeRegistry.getConfigured().find((item) => item.id === p.id);
                  const configuredLabel = configured?.apiKey ? "configured" : "needs key";
                  return {
                    id: p.id,
                    name: `${p.name} [${configuredLabel}]`,
                    enabled: true,
                  };
                }),
              )}
              current={currentProviderId}
              onSelect={handleProviderSelect}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "provider-add" && (
          <Box paddingX={1} flexShrink={0}>
            <ProviderPicker
              providers={withGrokSubscriptionProvider(
                BUILTIN_PROVIDERS
                  .filter((p) => isUserVisibleProvider(p.id))
                  .map((p) => ({ id: p.id, name: p.name, enabled: true })),
              )}
              current={currentProviderId}
              onSelect={handleProviderAddSelect}
              onCancel={closePicker}
              title="Add Provider"
            />
          </Box>
        )}
        {pickerMode === "login" && (
          <Box paddingX={1} flexShrink={0}>
            <ProviderPicker
              providers={
                // The native grok provider is OAuth-capable, so it appears via
                // supportsOAuth like OpenAI — no extra hardcoded row.
                BUILTIN_PROVIDERS
                  .filter((p) => isUserVisibleProvider(p.id) && safeRegistry.supportsOAuth(p.id))
                  .map((p) => ({ id: p.id, name: p.name, enabled: true }))
              }
              current={currentProviderId}
              onSelect={handleLoginProviderSelect}
              onCancel={closePicker}
              title="Select Login Provider"
            />
          </Box>
        )}
        {pickerMode === "logout" && (
          <Box paddingX={1} flexShrink={0}>
            <ProviderPicker
              providers={[
                ...safeRegistry.getConfigured()
                  .filter((p) => safeRegistry.getAuthStorage().has(p.id))
                  .map((p) => ({ id: p.id, name: p.name, enabled: true })),
                ...(grokSessionBound
                  ? [{ id: GROK_SUBSCRIPTION_PROVIDER_ID, name: "Grok Subscription [local login]", enabled: true }]
                  : []),
              ]}
              current={currentProviderId}
              onSelect={handleLogoutProviderSelect}
              onCancel={closePicker}
              title="Select Logout Provider"
            />
          </Box>
        )}
        {pickerMode === "key" && keyTarget && (
          <Box paddingX={1} flexShrink={0}>
            <KeyPicker
              providerName={keyTarget.name}
              onSubmit={handleKeySubmit}
              onCancel={() => {
                closePicker();
                setKeyProviderId(null);
              }}
            />
          </Box>
        )}
        {pickerMode === "skill" && (
          <Box paddingX={1} flexShrink={0}>
            <SkillPicker
              skills={safeSkillRegistry.summaries()}
              onSelect={(name) => {
                fillComposer(`/${name} `);
                closePicker();
              }}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "theme" && (
          <Box paddingX={1} flexShrink={0}>
            <ProviderPicker
              title="Select Theme"
              providers={[
                { id: "auto", name: `Auto — match terminal (${autoResolved})`, enabled: true },
                { id: "light", name: "Light", enabled: true },
                { id: "dark", name: "Dark", enabled: true },
              ]}
              current={themePickerRevertRef.current}
              onSelect={handleThemeSelect}
              onHighlight={handleThemeHighlight}
              onCancel={handleThemeCancel}
            />
          </Box>
        )}
        {pickerMode === "slash" && (
          <Box paddingX={1} flexShrink={0}>
            <CommandPalette
              items={commandPaletteItems}
              terminalColumns={mainWidth}
              terminalRows={terminalRows}
              onSelect={(item) => {
                closePicker();
                if (item.action === "insert-skill") {
                  fillComposer(`/${item.value} `);
                } else {
                  void handleSubmit(item.command);
                }
              }}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "mcp-reconnect" && (
          <Box paddingX={1} flexShrink={0}>
            <McpReconnectPicker
              items={mcpReconnectItems}
              terminalColumns={mainWidth}
              terminalRows={terminalRows}
              onSelect={(item) => {
                closePicker();
                void handleSubmit(item.command);
              }}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "session" && (
          <Box paddingX={1} flexShrink={0}>
            <SessionPicker
              currentCwd={args.cwd}
              currentSessions={SessionManager.summarizeSessionsForCwd(args.cwd)}
              allSessions={SessionManager.listAllSessions()}
              onSelect={handleSessionSelect}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "agents" && (
          <Box paddingX={1} flexShrink={0}>
            <SubagentInspector
              groups={subagentGroups}
              onCancel={closePicker}
              tasks={taskSnapshot}
              onKillTask={(taskId) => { void processManager?.killTask(taskId); }}
            />
          </Box>
        )}
        {pickerMode === "rewind" && sessionManager && (
          <Box paddingX={1} flexShrink={0}>
            <RewindPicker
              sessionManager={sessionManager}
              terminalColumns={mainWidth}
              terminalRows={terminalRows}
              onSelect={(command) => {
                closePicker();
                void handleSubmit(command);
              }}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "feishu-setup" && (
          <Box paddingX={1} flexShrink={0}>
            <FeishuSetupPicker
              onComplete={(summary) => {
                closePicker();
                addMessage("assistant", summary);
              }}
              onCancel={() => {
                closePicker();
                addMessage("assistant", "已取消 Feishu setup。");
              }}
            />
          </Box>
        )}
      {statsPanel && !pickerMode && (
        <Box paddingX={1} flexShrink={0}>
          <StatsPanel
            panel={statsPanel}
            terminalColumns={mainWidth}
            terminalRows={terminalRows}
            onRangeChange={(range) => setStatsPanel((current) => current ? { ...current, range } : current)}
            onCancel={closeStatsPanel}
          />
        </Box>
      )}
      {todos.length > 0 && !pickerMode && !statsPanel && !pendingPlan && !pendingQuestion && (
        <Box paddingX={1} flexShrink={0}>
          <TodosPanel todos={todos} terminalColumns={terminalColumns} />
        </Box>
      )}
      {pendingPlan && !pickerMode && !statsPanel && !pendingQuestion && (
        <Box paddingX={1} flexShrink={0}>
          <PlanConfirm
            initialPlan={pendingPlan.plan}
            onApprove={(finalPlan) => {
              const resolve = pendingPlan.resolve;
              setPendingPlan(null);
              resolve({ action: "approve", plan: finalPlan });
            }}
            onReject={(reason) => {
              const resolve = pendingPlan.resolve;
              setPendingPlan(null);
              resolve({ action: "reject", reason });
            }}
          />
        </Box>
      )}
      {pendingApproval && !pickerMode && !statsPanel && !pendingPlan && !pendingQuestion && (
        <Box paddingX={1} flexShrink={0}>
          <ApprovalDialog
            request={pendingApproval.request}
            onDecision={(decision) => {
              const resolve = pendingApproval.resolve;
              setPendingApproval(null);
              resolve(decision);
            }}
            onAllowBashPrefix={(prefix) => {
              bashAllowlist?.add(prefix);
            }}
          />
        </Box>
      )}
      {pendingQuestion && !pickerMode && !statsPanel && !pendingPlan && !pendingApproval && !pendingFeedback && (
        <Box paddingX={1} flexShrink={0}>
          <QuestionDialog
            request={pendingQuestion}
            onSubmit={(answers) => {
              questionController?.reply(pendingQuestion.id, answers);
              setPendingQuestion(null);
            }}
            onCancel={() => {
              questionController?.reject(pendingQuestion.id);
              setPendingQuestion(null);
            }}
          />
        </Box>
      )}
      {pendingFeedback && !pickerMode && !statsPanel && !pendingPlan && !pendingApproval && !pendingQuestion && (
        <Box paddingX={1} flexShrink={0}>
          <FeedbackDialog
            base={pendingFeedback.base}
            initialDescription={pendingFeedback.initialDescription}
            onDismiss={() => setPendingFeedback(null)}
            onResult={(result) => {
              if (result.kind === "success") {
                addMessage("assistant", `Feedback submitted: ${result.url}`);
              } else if (result.kind === "error") {
                addMessage("error", `Feedback failed: ${result.message}`);
              }
            }}
          />
        </Box>
      )}
      {!isExiting && compaction && (
        <Box flexShrink={0} backgroundColor={palette.background}>
          <CompactionProgressCard progress={compaction} />
        </Box>
      )}
      {!isExiting && isRunning && !pickerMode && !statsPanel && !pendingPlan && !pendingApproval && !pendingQuestion && !pendingFeedback && (
        // The streaming tail supplies its own bottom margin once it has
        // visible output, but right after a prompt is sent the tail renders
        // nothing and the spinner would hug the user's message bubble — give
        // it a top gap only in that empty-tail state to avoid double spacing.
        <Box
          paddingX={1}
          paddingBottom={1}
          paddingTop={
            streamingParts.length === 0
              && streamingContent.length === 0
              && streamingTools.length === 0
              && (streamingReasoning.length === 0 || !(showThinking || verboseTrace))
              ? 1
              : 0
          }
          flexShrink={0}
          backgroundColor={palette.background}
        >
          <WaitingIndicator
            tools={streamingTools}
            hasStreamingText={streamingContent.length > 0}
            hasStreamingReasoning={streamingReasoning.length > 0}
            streamedChars={streamingContent.length + streamingReasoning.length}
            nowTick={nowTick}
            pendingSteerCount={pendingSteerCount}
            queuedCount={queuedCount}
          />
        </Box>
      )}
      {!isExiting && !pickerMode && !statsPanel && (
        <Box paddingBottom={1} flexShrink={0} backgroundColor={palette.background}>
          <InputBox
            onSubmit={handleSubmit}
            onQueue={isRunning ? queueInput : undefined}
            onArrowDownAtBottom={() => {
              if (subagentMembers.length > 0 && !pickerMode) setSubagentEntryFocused(true);
            }}
            disabled={!!pendingPlan || !!pendingApproval || !!pendingQuestion || !!pendingFeedback || !!statsPanel || subagentEntryFocused}
            cursorResetEpoch={cursorResetEpoch}
            draftText={composerDraft?.text}
            draftEpoch={composerDraft?.epoch}
            onDraftApplied={clearComposerDraft}
            skillRegistry={externalSessionBound ? undefined : safeSkillRegistry}
            localSlashCommands={externalSessionBound ? [] : [...INK_LOCAL_SLASH_COMMANDS]}
            allowedSlashCommands={unsupportedExternalSessionBound ? GROK_LOCAL_SLASH_COMMANDS : undefined}
            allowWorkspaceMentions={!unsupportedExternalSessionBound}
            allowImageAttachments={!externalSessionBound}
            terminalColumns={mainWidth}
            cwd={args.cwd}
            sessionFile={currentSessionFile()}
            nextImageLabelStart={nextImageDisplayLabelStartRef.current}
          />
        </Box>
      )}
      {/* Subagent/task entry sits BELOW the composer: pressing ↓ from the
          composer moves focus downward into it (spatially consistent). The
          row renders for background tasks too (design §2.5) — tasks come from
          the process-manager snapshot, a different store than subagents. */}
      {!isExiting && !pickerMode && !statsPanel && !pendingPlan && !pendingApproval && !pendingQuestion && !pendingFeedback && (subagentMembers.length > 0 || runningTasks.length > 0) && (
        <Box paddingX={1} flexShrink={0}>
          <Text bold={subagentEntryFocused} color={subagentEntryFocused ? palette.accent : palette.toolName}>{subagentEntryFocused ? "> ↳ " : "  ↳ "}</Text>
          <Text color={subagentEntryFocused ? palette.accent : palette.muted}>
            {[
              subagentMembers.length > 0
                ? `${subagentMembers.length} subagent${subagentMembers.length === 1 ? "" : "s"} · ${subagentSummary(subagentMembers)}`
                : undefined,
              runningTasks.length > 0
                ? `${runningTasks.length} task${runningTasks.length === 1 ? "" : "s"} · ${taskRowSummary(runningTasks, nowTick)}`
                : undefined,
            ].filter(Boolean).join(" · ")} · </Text>
          {subagentMembers.length > 0
            ? <Text color={palette.accent}>{subagentEntryFocused ? "Enter open · Esc back" : "↓ to inspect traces"}</Text>
            : <Text color={palette.accent}>task_output to check · kill_task to stop</Text>}
        </Box>
      )}
      {!isExiting && (
        <Box flexShrink={0}>
          <FooterBar data={buildFooterData({
            mode: permissionMode,
            goalLine: externalSessionBound ? undefined : goalLine,
            runtimeLabel: externalSessionBound
              ? (grokSessionBound
                  ? `Grok Subscription${externalRuntimeBinding?.modelId ? ` · ${externalRuntimeBinding.modelId}` : ""}${externalRuntimeBinding?.reasoningEffort && externalRuntimeBinding.reasoningEffort !== "off" ? ` · ${externalRuntimeBinding.reasoningEffort}` : ""} · workspace`
                  : "Unsupported external runtime · recovery-only")
              : undefined,
            cwd: friendlyCwd(args.cwd),
            branch,
            model: externalSessionBound
              ? undefined
              : (agent.model
                ? `${displayModel(agent.model)}${footerThinkingLabel ? ` · ${footerThinkingLabel}` : ""}`
                : undefined),
            sessionTitle: externalSessionBound ? undefined : (sessionManager?.getMetadata().title?.trim() || undefined),
            contextUsage: externalSessionBound ? undefined : (contextUsage || undefined),
          })} />
        </Box>
      )}
      </Box>
    </ThemeProvider>
  );
}
