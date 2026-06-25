import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { AgentAbortError, INTERRUPTED_ASSISTANT_CONTENT, type Agent } from "../agent.js";
import { isHiddenToolMetadata } from "../agent/discovery-barrier.js";
import type { CliArgs } from "../cli.js";
import { SessionManager, type UserTurn } from "../session.js";
import type { AgentEvent, ContentPart, PermissionMode, Message, PlanDecision, Provider, Todo, ToolResultMetadata } from "../types.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { UserConfig, maskKey } from "../config.js";
import {
  createPastedContentMarker,
  InputBox,
  isCtrlCInput,
  shouldCollapsePastedContent,
  type SubmitPayload,
} from "./input-box.js";
import { MessageList } from "./message-list.js";
import {
  appendTextPart,
  appendToolPart,
  compactDisplayMessages,
  contentFromParts,
  latestCompactionSummary,
  moveStatusMessageToEnd,
  nextDisplayMessageKey,
  setUserInputStatus,
  snapshotDisplayParts,
  stripInterruptedAssistantMarker,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
  type UserInputStatus,
  toolCallsFromParts,
} from "./display-history.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import type { PendingApprovalHint } from "./message-list.js";
import { paletteFor, ThemeProvider, useTheme, type ResolvedTheme, type Theme, type ThemeMode } from "./theme.js";
import { isPrintablePickerInput, ModelPicker, ProviderPicker, KeyPicker, SkillPicker } from "./model-picker.js";
import { FeishuSetupPicker } from "./feishu-setup-picker.js";
import { BUILTIN_PROVIDERS, ProviderRegistry, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ThinkingLevel } from "../types.js";
import { getAvailableThinkingLevels, normalizeThinkingLevel } from "../provider-transform.js";
import { FooterBar, buildFooterData } from "./footer.js";
import { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { useTerminalSize } from "./use-terminal-size.js";
import { WelcomeBanner, shouldShowWelcomeBanner } from "./welcome.js";
import { expandAtMentions } from "./file-mentions.js";
import { TodosPanel } from "./todos.js";
import { PlanConfirm } from "./plan-confirm.js";
import { ApprovalDialog } from "./approval/approval-dialog.js";
import { getNextPermissionMode } from "../permission/mode.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { McpServerState } from "../mcp/types.js";
import type { LspService, LspStatus } from "../lsp/index.js";
import type { QuestionAnswer, QuestionController, QuestionRequest } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
import { QuestionDialog } from "./question-dialog.js";
import { FeedbackDialog } from "./feedback-dialog.js";
import type { ExternalHookController } from "../hooks/controller.js";
import type { SidebarCommandState, SidebarMode } from "../slash-commands/types.js";
import { collectFeedback } from "../feedback/collect.js";
import { isKeyReleaseEvent } from "./key-events.js";
import { errorMessage, formatModelSwitchError, switchAgentModel } from "../tui/model-switch.js";
import { formatImageUserDisplayText, nextImageDisplayLabelStart } from "../tui/image-display.js";
import { decideStartingSubmitFingerprint, submitPayloadFingerprint } from "./submit-dedupe.js";
import {
  isQueuedInputForCurrentSession,
  queuedAndPendingDisplayKeys,
  type PendingSteerMeta,
  type QueuedInput,
} from "./input-queue.js";
import { SessionPicker } from "./session-picker.js";
import { sessionDisplayName } from "../tui/session-display.js";
import type { GoalStore, GoalState } from "../goal/store.js";
import { parseGoalCommand } from "../goal/command.js";
import { continuationPrompt, initialPrompt } from "../goal/prompts.js";
import { shouldContinueGoal, stopReasonNotice } from "../goal/engine.js";
import { goalCompleteNotice, goalIndicatorLine, goalSummaryText } from "../goal/format.js";
import { tokenUsageTotal } from "../goal/usage.js";
import { formatInternalContextBlock } from "../agent/internal-reminder-sanitizer.js";
import { collectUsageStatsBundle, formatStatsPanelBody, rangeLabel, type StatsRange, type UsageStatsBundle } from "../stats/usage.js";
import os from "node:os";

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
  /** Whether the bypassPermissions mode is reachable via Shift+Tab cycling. */
  bypassEnabled?: boolean;
  updateNotice?: string;
  updateNoticeRefresh?: Promise<string | null>;
  hookController?: ExternalHookController;
  onExit?: (summary: ExitSummary) => void;
}

export interface ExitSummary {
  /** Wall-clock duration of the session, in milliseconds. */
  wallMs: number;
}

function buildTips(agent: Agent, registry: ProviderRegistry): string[] {
  const tips: string[] = [];
  const hasProvider = registry.getEnabled().length > 0;
  if (!hasProvider) {
    tips.push("Run /login or /provider --add to configure a model");
  } else if (agent.model) {
    tips.push(`Ready with ${displayModel(agent.model)}`);
  } else {
    tips.push("Run /model to pick a model");
  }
  tips.push("Type @ to reference a file");
  tips.push("Type / for commands and skills");
  return tips;
}

function friendlyCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function reconstructDisplayMessages(agentMessages: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const m of agentMessages) {
    if (m.role === "system" || m.role === "tool") continue;
    if (m.role === "user") {
      if ((m as { isMeta?: boolean }).isMeta) continue; // <system-reminder> injections are not user-visible
      result.push({
        key: nextDisplayMessageKey("user"),
        role: "user",
        content: typeof m.content === "string"
          ? (shouldCollapsePastedContent(m.content) ? createPastedContentMarker(m.content) : m.content)
          : "(multimedia)",
      });
    } else if (m.role === "assistant") {
      const toolCalls: DisplayToolCall[] = [];
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.arguments || "{}") as Record<string, any>;
          } catch {
            args = {};
          }
          const toolResult = agentMessages.find(
            (tm) => tm.role === "tool" && (tm as any).toolCallId === tc.id
          );
          if (isHiddenToolMetadata(toolResult ? (toolResult as any).metadata : undefined)) continue;
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result: toolResult ? (toolResult as any).content as string : undefined,
            isError: toolResult ? (toolResult as any).content?.startsWith?.("Error:") : false,
            metadata: toolResult ? (toolResult as any).metadata : undefined,
          });
        }
      }
      // An aborted assistant message carries the model-facing interruption
      // note in its content. Render only what the assistant actually said
      // (partial streamed text, if any) plus a dedicated interrupt row —
      // never the note itself, which reads like a leaked system prompt.
      const interrupted = (m as { error?: { aborted?: boolean } }).error?.aborted === true;
      const content = interrupted
        ? stripInterruptedAssistantMarker(m.content, INTERRUPTED_ASSISTANT_CONTENT)
        : m.content;
      if (content || m.reasoning || toolCalls.length > 0) {
        result.push({
          key: nextDisplayMessageKey("asst"),
          role: "assistant",
          content,
          reasoning: m.reasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
      if (interrupted) {
        result.push({
          key: nextDisplayMessageKey("asst"),
          role: "assistant",
          content: "Interrupted by user",
          syntheticKind: "ui_interrupt",
        });
      }
    }
  }
  return result;
}

/**
 * Streaming tool arguments arrive as an incomplete JSON buffer. We can't
 * JSON.parse() until the closing brace lands, but the user wants to see the
 * short identifying fields (path, command, …) as soon as the model emits
 * them so the tool row header reflects what's happening.
 *
 * Intentionally limited to short, single-line fields. Long fields like
 * `content` are *not* surfaced live: rendering thousands of partial lines
 * per delta floods the terminal and the partial value can break around
 * unescaped sequences. The final value lands when the tool actually
 * executes and tool_start delivers canonical args.
 */
function parsePartialArgs(
  buffer: string,
  previous: Record<string, any>,
): Record<string, any> {
  // If the buffer is now valid JSON, prefer the real parse.
  try {
    const parsed = JSON.parse(buffer);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through to partial extraction below
  }
  const result: Record<string, any> = { ...previous };
  const FIELDS = ["path", "command", "pattern", "url", "query"];
  for (const field of FIELDS) {
    // Match a complete-looking quoted string. Requires a closing quote so we
    // don't surface half-typed paths that may still change as bytes arrive.
    const match = buffer.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match) {
      const raw = match[1] ?? "";
      result[field] = raw
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  return result;
}

function mergeToolMetadata(
  current: ToolResultMetadata | undefined,
  incoming: ToolResultMetadata | undefined,
): ToolResultMetadata | undefined {
  if (!incoming) return current;
  if (current?.kind !== "subagent" || incoming.kind !== "subagent") {
    return incoming;
  }

  const currentSubagents = Array.isArray(current.subagents) ? current.subagents : [];
  const incomingSubagents = Array.isArray(incoming.subagents) ? incoming.subagents : [];
  const byId = new Map<string, unknown>();
  for (const item of currentSubagents) {
    const subAgentId = typeof item === "object" && item !== null && "subAgentId" in item
      ? String((item as Record<string, unknown>).subAgentId)
      : "";
    byId.set(subAgentId || `current:${byId.size}`, item);
  }
  for (const item of incomingSubagents) {
    const subAgentId = typeof item === "object" && item !== null && "subAgentId" in item
      ? String((item as Record<string, unknown>).subAgentId)
      : "";
    byId.set(subAgentId || `incoming:${byId.size}`, item);
  }

  return {
    ...current,
    ...incoming,
    subagents: [...byId.values()],
  };
}

/**
 * Coerce a freshly-constructed DisplayMessage into one that carries a stable
 * `key`. Centralizes the safety net so callers don't have to remember to call
 * nextDisplayMessageKey on every push.
 */
function withMessageKey(message: DisplayMessage): DisplayMessage {
  if (message.key) return message;
  const prefix = message.role === "user" ? "user" : message.role === "error" ? "err" : "asst";
  return { ...message, key: nextDisplayMessageKey(prefix) };
}

// Batch streaming text deltas before committing them to React state. Without
// <Static>, every commit re-renders the full-screen frame; per-token commits
// would make Yoga re-lay-out the transcript for every few bytes of output.
// 40ms keeps perceived latency invisible while capping layout work at 25fps.
const STREAMING_FLUSH_INTERVAL_MS = 40;

export const INK_LOCAL_SLASH_COMMANDS = [
  {
    name: "thinking",
    description: "Toggle thinking block visibility",
  },
  {
    name: "toggle-thinking",
    description: "Toggle thinking block visibility",
  },
  {
    name: "goal",
    description: "Set/manage an autonomous goal (/goal <objective>|clear|pause|resume|edit)",
  },
  {
    name: "trace",
    description: "Toggle verbose trace output",
  },
  {
    name: "verbose",
    description: "Toggle verbose trace output",
  },
  {
    name: "debug",
    description: "Toggle verbose trace output",
  },
  {
    name: "write-previews",
    description: "Toggle write preview expansion",
  },
] as const;

export function App({ agent, args, sessionManager: initialSessionManager, switchSession, createProvider, registry, skillRegistry, planHandlerRef, approvalHandlerRef, questionController, bashAllowlist, settingsManager, lspService, mcpManager, themeMode: initialThemeMode, themeOverrides, detectedTheme, onThemeModeChange, flushMemory, runMemoryCompaction, runMemorySummary, runMemoryRefresh, goalStore, bypassEnabled, updateNotice, updateNoticeRefresh, hookController, onExit }: AppProps) {
  const [sessionManager, setSessionManager] = useState(initialSessionManager);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode ?? "auto");
  // `detectedTheme` is captured once at startup in main.ts. We keep it in state
  // so future re-detection (e.g. if a user runs `/theme auto` after switching
  // their terminal) is possible without re-mounting the app. For now it never
  // changes after first render.
  const [autoResolved] = useState<ResolvedTheme>(detectedTheme ?? "dark");
  const palette = useMemo<Theme>(() => {
    const resolved: ResolvedTheme = themeMode === "auto" ? autoResolved : themeMode;
    return paletteFor(resolved, themeOverrides);
  }, [themeMode, autoResolved, themeOverrides]);
  const applyThemeMode = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    onThemeModeChange?.(mode);
  }, [onThemeModeChange]);
  const themeResolved: ResolvedTheme = themeMode === "auto" ? autoResolved : themeMode;
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => compactDisplayMessages(reconstructDisplayMessages(agent.messages)));
  const nextImageDisplayLabelStartRef = useRef(nextImageDisplayLabelStart(messages));
  const [isRunning, setIsRunning] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingTools, setStreamingTools] = useState<DisplayToolCall[]>([]);
  const [streamingParts, setStreamingParts] = useState<DisplayMessagePart[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(agent.thinking);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(agent.mode);
  const [todos, setTodos] = useState<Todo[]>(() => agent.getTodos());
  const [goalLine, setGoalLine] = useState("");
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
  const [pickerMode, setPickerMode] = useState<"model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "session" | "rewind" | "slash" | "mcp-reconnect" | "feishu-setup" | null>(null);
  const [statsPanel, setStatsPanel] = useState<{ range: StatsRange; bundle: UsageStatsBundle } | null>(null);
  const [cursorResetEpoch, setCursorResetEpoch] = useState(0);
  const [composerDraft, setComposerDraft] = useState<{ text: string; epoch: number } | null>(null);
  const [keyProviderId, setKeyProviderId] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [expandedToolOutput, setExpandedToolOutput] = useState(false);
  const [verboseTrace, setVerboseTrace] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("collapsed");
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
  // Set true the moment /quit is invoked so we can hide dynamic UI (composer,
  // waiting indicator, footer) before Ink snapshots its final frame into the
  // shell scrollback. Without this, the last visible "> " input row stays
  // glued to the bottom of the terminal after exit.
  const [isExiting, setIsExiting] = useState(false);
  // 1Hz tick keeps the composer activity indicator animated while the agent is
  // running without churning renders at idle.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  // Timestamp of when the current agent run started. Used only for the final
  // per-task duration summary.
  const runStartRef = useRef<number | null>(null);
  // Mark the moment the run started; flips back to null in the finally block.
  useEffect(() => {
    if (!isRunning) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  const userConfig = new UserConfig();
  const safeRegistry = registry ?? new ProviderRegistry(userConfig);
  const safeSkillRegistry = skillRegistry ?? new SkillRegistry({
    cwd: args.cwd,
    skillPaths: userConfig.getSkillPaths(),
  });

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

    if (key.ctrl && input.toLowerCase() === "p" && !pickerMode && !activeAbortRef.current) {
      setStatsPanel(null);
      setPickerMode("slash");
      return;
    }

    if (key.ctrl && key.shift && input.toLowerCase() === "m" && !pickerMode) {
      if (!mcpManager || mcpManager.getStates().length === 0) {
        addMessage("assistant", "No MCP servers configured.");
      } else {
        setStatsPanel(null);
        setPickerMode("mcp-reconnect");
      }
      return;
    }

    if (key.ctrl && input.toLowerCase() === "t" && !pickerMode) {
      setShowThinking((current) => {
        const next = !current;
        addMessage("assistant", next ? "Thinking blocks visible" : "Thinking blocks hidden");
        return next;
      });
      return;
    }

    if (key.ctrl && input === "o" && !pickerMode) {
      setVerboseTrace((v) => !v);
      return;
    }

    // Ctrl+R: cycle thinking level (formerly Shift+Tab)
    if (key.ctrl && input === "r" && !pickerMode) {
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
      agent.setMode(nextMode);
      setPermissionMode(nextMode);
      sessionManager?.appendMarker("mode_switch", nextMode);
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
    setMessages((prev) => compactDisplayMessages(updater(prev).map(withMessageKey)));
  }, []);

  // Non-append transcript rebuilds (/clear, /compact, /rewind, session switch)
  // replace the settled list rather than extending it. The rows already
  // committed to the terminal's native scrollback (via <Static>) cannot be
  // un-printed, so we wipe the screen + scrollback and bump the Static key:
  // Ink then re-prints the rebuilt list fresh instead of appending duplicates.
  const resetTranscript = useCallback(
    (updater: (prev: DisplayMessage[]) => DisplayMessage[]) => {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      }
      setStaticGeneration((generation) => generation + 1);
      updateDisplayMessages(updater);
    },
    [updateDisplayMessages],
  );

  const addMessage = useCallback((role: DisplayMessage["role"], content: string) => {
    updateDisplayMessages((prev) => [...prev, withMessageKey({ role, content })]);
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
  }, [resetTranscript]);

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

  const currentSessionFile = useCallback(() => sessionManager?.getSessionFile(), [sessionManager]);

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

  const openPicker = useCallback((mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "session" | "rewind" | "feishu-setup", providerId?: string) => {
    if (mode === "key") {
      setKeyProviderId(providerId ?? null);
    }
    setStatsPanel(null);
    setPickerMode(mode);
  }, []);

  const closePicker = useCallback(() => {
    setPickerMode(null);
    setCursorResetEpoch((epoch) => epoch + 1);
  }, []);

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

  const sidebarFits = terminalColumns > 120;
  const sidebarVisible = sidebarMode === "expanded" ? sidebarFits : sidebarMode === "auto" && sidebarFits;
  const currentSidebarCommandState = useCallback((mode: SidebarMode = sidebarMode): SidebarCommandState => {
    const visible = mode === "expanded" ? sidebarFits : mode === "auto" && sidebarFits;
    return { mode, visible, active: visible };
  }, [sidebarFits, sidebarMode]);
  const toggleSidebar = useCallback((): SidebarCommandState => {
    const next: SidebarMode = sidebarVisible ? "collapsed" : "expanded";
    setSidebarMode(next);
    return currentSidebarCommandState(next);
  }, [currentSidebarCommandState, sidebarVisible]);
  const applySidebarMode = useCallback((mode: SidebarMode): SidebarCommandState => {
    setSidebarMode(mode);
    return currentSidebarCommandState(mode);
  }, [currentSidebarCommandState]);

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

  const handleSessionSelect = useCallback((sessionFile: string) => {
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
    const result = switchSession(sessionFile);
    if ("error" in result) {
      addMessage("error", `Failed to switch session: ${result.error}`);
      closePicker();
      return;
    }
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
    setSessionManager(result.manager);
    setTodos(agent.getTodos());
    resetTranscript(() => [
      ...reconstructDisplayMessages(agent.messages).filter((message) => !queuedDisplayKeys.has(message.key ?? "")),
      withMessageKey({ role: "assistant", content: `⤷ Resumed session: ${sessionDisplayName(result.manager)}` }),
    ]);
    closePicker();
  }, [addMessage, agent, clearComposerDraft, closePicker, setStartingSubmit, switchSession, resetTranscript]);

  const handleModelSelect = useCallback((model: string, selectedThinkingLevel?: ThinkingLevel) => {
    const run = async () => {
      const nextThinkingLevel = await switchAgentModel({
        model,
        agent,
        registry: safeRegistry,
        createProvider,
        workingDir: args.cwd,
        systemPromptOptions: agent.getSystemPromptToolOptions(),
        thinkingLevel: selectedThinkingLevel,
        rememberModel: (nextModel) => userConfig.pushRecentModel(nextModel),
        setThinkingLevel,
        sessionManager,
      });
      // MiniMax thinking is a binary toggle (adaptive thinking), not a graded
      // effort — show it as "thinking mode" rather than "medium effort".
      const isMiniMaxModel = model.toLowerCase().includes("minimax");
      const effortNote = nextThinkingLevel && nextThinkingLevel !== "off"
        ? (isMiniMaxModel ? " in thinking mode" : ` with ${nextThinkingLevel} effort`)
        : "";
      addMessage("assistant", `Model switched to ${displayModel(model)}${effortNote}.`);
      closePicker();
      return nextThinkingLevel;
    };

    void run().catch((error) => {
      addMessage("error", formatModelSwitchError(model, error));
      closePicker();
    });
  }, [agent, addMessage, closePicker, sessionManager, userConfig, safeRegistry, createProvider]);

  const handleProviderSelect = useCallback((providerId: string) => {
    const run = async () => {
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
        safeRegistry.setDefault(providerId);
        setKeyProviderId(providerId);
        setPickerMode("key");
        return;
      }
      safeRegistry.setDefault(providerId);
      agent.setProvider(createProvider!(providerId, p.apiKey, p.baseURL));
      agent.providerId = providerId;
      addMessage("assistant", `Switched to provider ${p.name}. Use /model to pick a model.`);
      closePicker();
    };

    void run().catch((error) => {
      addMessage("error", `Failed to switch provider ${providerId}: ${errorMessage(error)}`);
      closePicker();
    });
  }, [addMessage, agent, closePicker, createProvider, safeRegistry]);

  const handleProviderAddSelect = useCallback((providerId: string) => {
    const ok = safeRegistry.addProvider(providerId, "");
    if (!ok) {
      addMessage("error", `Provider ${providerId} could not be added.`);
      closePicker();
      return;
    }
    safeRegistry.setDefault(providerId);
    setKeyProviderId(providerId);
    setPickerMode("key");
  }, [addMessage, closePicker, safeRegistry]);

  const handleLoginProviderSelect = useCallback(async (providerId: string) => {
    closePicker();
    const command = `/login ${providerId}`;
      const { handled, result } = await slashRegistry.execute(command, {
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
    });
    if (handled && result) {
      addMessage("assistant", result);
    }
  }, [agent, addMessage, clearMessages, closePicker, createProvider, exit, fillComposer, openPicker, openSessionPicker, openRewindPicker, openStatsPanel, safeRegistry, sessionManager]);

  const handleLogoutProviderSelect = useCallback(async (providerId: string) => {
    closePicker();
    const command = `/logout ${providerId}`;
      const { handled, result } = await slashRegistry.execute(command, {
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
    });
    if (handled && result) {
      addMessage("assistant", result);
    }
  }, [agent, addMessage, clearMessages, closePicker, createProvider, exit, fillComposer, openPicker, openSessionPicker, openRewindPicker, openStatsPanel, safeRegistry, sessionManager]);

  const handleKeySubmit = useCallback((key: string) => {
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
      agent.setProvider(createProvider(targetId, key, p.baseURL));
      agent.providerId = targetId;
    }
    addMessage("assistant", `API key updated for ${p?.name || targetId} to ${maskKey(key)}.`);
    closePicker();
    setKeyProviderId(null);
  }, [addMessage, agent, closePicker, createProvider, keyProviderId, safeRegistry]);

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
          if (!hasAssistantOutput()) return;

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
          updateDisplayMessages((prev) => [...prev, msg]);
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
          toolCalls.length = 0;
          assistantParts.length = 0;
        };

        try {
          for await (const event of agent.run(actualInput, args.cwd, {
            abortSignal: abortController.signal,
            inputController,
          })) {
            switch (event.type) {
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
                }
                break;
              }
              case "todos_updated": {
                setTodos(event.todos);
                break;
              }
              case "mode_changed": {
                setPermissionMode(event.mode);
                sessionManager?.appendMarker("mode_switch", event.mode);
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
                  resetTranscript((prev) => moveStatusMessageToEnd(prev, steer.displayKey));
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
          commitAssistantMessage();
          if (err instanceof AgentAbortError || err?.name === "AbortError") {
            runCancelled = true;
            resetTranscript(() => reconstructDisplayMessages(agent.messages));
          } else {
            runErrored = true;
            updateDisplayMessages((prev) => [
              ...prev,
              withMessageKey({ role: "error", content: err.message }),
            ]);
          }
        } finally {
          cancelStreamingFlush();
          // Leftover steers that never reached a model-call boundary: drop
          // them on cancel (the user asked the run to stop); requeue them for
          // the next turn on a normal end.
          const cancelled = abortController.signal.aborted;
          if (cancelled) runCancelled = true;
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
          setPendingSteerCount(0);
          setQueuedCount(queuedInputsRef.current.length);
          if (inputControllerRef.current === inputController) inputControllerRef.current = null;
          if (activeAbortRef.current === abortController) activeAbortRef.current = null;
          setIsRunning(false);
          runStartRef.current = null;
          setStreamingContent("");
          setStreamingReasoning("");
          setStreamingTools([]);
          setStreamingParts([]);
          maybeContinueGoal({
            runCancelled,
            runErrored,
            isGoalRun: !!runOptions.goalRun,
            runTokens: goalRunTokens,
            usageReported: goalRunUsageReported,
          });
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

      // Slash commands and skill invocations drop any attached images —
      // they're meant for pure command routing.
      if (displayInput.startsWith("/")) {
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

        if (/^\/(?:thinking|toggle-thinking)(?:\s|$)/.test(input.trim())) {
          setShowThinking((current) => {
            const next = !current;
            addMessage("assistant", next ? "Thinking blocks visible" : "Thinking blocks hidden");
            return next;
          });
          return;
        }

        if (/^\/(?:trace|verbose|debug)(?:\s|$)/.test(input.trim())) {
          setVerboseTrace((current) => {
            const next = !current;
            addMessage("assistant", next ? "Verbose trace visible" : "Compact trace visible");
            return next;
          });
          return;
        }

        if (/^\/write-previews(?:\s|$)/.test(input.trim())) {
          setExpandedToolOutput((current) => {
            const next = !current;
            addMessage("assistant", next ? "Write previews expanded" : "Write previews collapsed");
            return next;
          });
          return;
        }

        if (/^\/goal(?:\s|$)/.test(input.trim())) {
          await handleGoalCommand(input);
          return;
        }

        const skillInvocation = parseSkillInvocation(input, safeSkillRegistry);
        if (skillInvocation) {
          await runAgentInput(skillInvocation.actualPrompt, displayInput);
          return;
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
          toggleSidebar,
          setSidebarMode: applySidebarMode,
          openStats: openStatsPanel,
        });
        if (handled) {
          if (agent.mode !== permissionMode) {
            setPermissionMode(agent.mode);
          }
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
              // the rewound state before appending the summary.
              resetTranscript(() => [
                ...reconstructDisplayMessages(agent.messages),
                { role: "assistant", content: result },
              ]);
            } else {
              addMessage("assistant", result);
            }
          }
          if (inject) {
            await runAgentInput(inject, displayInput);
          }
          return;
        }
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
    [addMessage, agent, args.cwd, openPicker, openSessionPicker, openRewindPicker, openStatsPanel, createProvider, currentSessionFile, fillComposer, prepareSubmitDisplay, safeRegistry, safeSkillRegistry, updateDisplayMessages, queueInput, submitSteer, requestExit, toggleSidebar, applySidebarMode, setStartingSubmit]
  );

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

  const currentProviderId = agent.providerId || safeRegistry.getDefault()?.id;
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

  // MiniMax has only off/on, so the graded ">2 levels" gate would hide its label;
  // surface it too (rendered as "thinking mode" by formatModelLine).
  const isMiniMaxProvider = (agent.providerId || "").toLowerCase().includes("minimax");
  const showThinkingLabel = Boolean(thinkingLevel)
    && thinkingLevel !== "off"
    && (isMiniMaxProvider || getAvailableThinkingLevels(agent.providerId, agent.apiModel).length > 2);
  const welcomeBannerNode = showWelcome ? (
    <WelcomeBanner
      terminalColumns={terminalColumns}
      tips={buildTips(agent, safeRegistry)}
      updateNotice={currentUpdateNotice}
      cwd={friendlyCwd(args.cwd)}
      providerId={agent.providerId || safeRegistry.getDefault()?.id}
      modelLabel={agent.model ? displayModel(agent.model) : undefined}
      thinkingLabel={showThinkingLabel ? thinkingLevel : undefined}
    />
  ) : null;
  const commandPaletteItems = useMemo(
    () => buildCommandPaletteItems(safeSkillRegistry),
    [safeSkillRegistry],
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
  const sidebarWidth = sidebarVisible ? Math.min(42, Math.max(28, Math.floor(terminalColumns * 0.34))) : 0;
  const mainWidth = Math.max(40, terminalColumns - sidebarWidth);

  return (
    <ThemeProvider value={palette}>
      <Box flexDirection="row" width={terminalColumns} backgroundColor={palette.background}>
      <Box flexDirection="column" width={mainWidth} backgroundColor={palette.background}>
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          streamingReasoning={streamingReasoning}
          streamingTools={streamingTools}
          streamingParts={streamingParts}
          terminalColumns={mainWidth}
          showThinking={showThinking}
          expandedToolOutput={expandedToolOutput}
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
              providers={BUILTIN_PROVIDERS
                .filter((p) => isUserVisibleProvider(p.id))
                .map((p) => {
                  const configured = safeRegistry.getConfigured().find((item) => item.id === p.id);
                  const configuredLabel = configured?.apiKey ? "configured" : "needs key";
                  return {
                    id: p.id,
                    name: `${p.name} [${configuredLabel}]`,
                    enabled: true,
                  };
              })}
              current={currentProviderId}
              onSelect={handleProviderSelect}
              onCancel={closePicker}
            />
          </Box>
        )}
        {pickerMode === "provider-add" && (
          <Box paddingX={1} flexShrink={0}>
            <ProviderPicker
              providers={BUILTIN_PROVIDERS
                .filter((p) => isUserVisibleProvider(p.id))
                .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
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
              providers={BUILTIN_PROVIDERS
                .filter((p) => isUserVisibleProvider(p.id) && safeRegistry.supportsOAuth(p.id))
                .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
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
              providers={safeRegistry.getConfigured()
                .filter((p) => safeRegistry.getAuthStorage().has(p.id))
                .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
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
      {!isExiting && isRunning && !pickerMode && !statsPanel && !pendingPlan && !pendingApproval && !pendingQuestion && !pendingFeedback && (
        <Box paddingX={1} paddingBottom={1} flexShrink={0} backgroundColor={palette.background}>
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
            disabled={!!pendingPlan || !!pendingApproval || !!pendingQuestion || !!pendingFeedback || !!statsPanel}
            cursorResetEpoch={cursorResetEpoch}
            draftText={composerDraft?.text}
            draftEpoch={composerDraft?.epoch}
            onDraftApplied={clearComposerDraft}
            skillRegistry={safeSkillRegistry}
            localSlashCommands={[...INK_LOCAL_SLASH_COMMANDS]}
            terminalColumns={mainWidth}
            cwd={args.cwd}
            sessionFile={currentSessionFile()}
            nextImageLabelStart={nextImageDisplayLabelStartRef.current}
          />
        </Box>
      )}
      {!isExiting && (
        <Box flexShrink={0}>
          <FooterBar data={buildFooterData({ mode: permissionMode, goalLine })} />
        </Box>
      )}
      </Box>
      {sidebarVisible && (
        <InkSidebar
          width={sidebarWidth}
          agent={agent}
          sessionManager={sessionManager}
          cwd={args.cwd}
          mode={permissionMode}
          goalLine={goalLine}
          todos={todos}
          mcpManager={mcpManager}
          lspService={lspService}
        />
      )}
    </Box>
    </ThemeProvider>
  );
}

interface PaletteItem {
  label: string;
  detail: string;
  value: string;
  command: string;
  action?: "insert-skill";
}

function buildCommandPaletteItems(skillRegistry: SkillRegistry): PaletteItem[] {
  const items = new Map<string, PaletteItem>();
  const add = (item: PaletteItem) => {
    const key = `${item.action ?? "command"}:${item.value}`;
    if (!items.has(key)) items.set(key, item);
  };

  for (const command of INK_LOCAL_SLASH_COMMANDS) {
    add({
      label: `/${command.name}`,
      detail: command.description,
      value: command.name,
      command: `/${command.name}`,
    });
  }
  for (const command of slashRegistry.list()) {
    const source = command.source === "mcp" ? " :mcp" : "";
    const sourceLabel = command.sourceLabel ? `[${command.sourceLabel}] ` : "";
    add({
      label: `/${command.name}${source}`,
      detail: `${sourceLabel}${command.description}`,
      value: command.name,
      command: `/${command.name}`,
    });
  }
  for (const skill of skillRegistry.summaries()) {
    add({
      label: `/${skill.name} :skill`,
      detail: `[${skill.source}] ${skill.description}`,
      value: skill.name,
      command: `/${skill.name}`,
      action: "insert-skill",
    });
  }

  return [...items.values()];
}

function buildMcpReconnectItems(mcpManager?: McpManager): PaletteItem[] {
  return (mcpManager?.getStates() ?? []).map((state) => {
    let detail: string;
    if (state.status.kind === "connected") {
      const tools = state.status.tools.length;
      const prompts = state.status.prompts.length;
      detail = `connected · ${tools} tool${tools === 1 ? "" : "s"} · ${prompts} prompt${prompts === 1 ? "" : "s"}`;
    } else if (state.status.kind === "failed") {
      detail = `failed · ${state.status.error}`;
    } else {
      detail = "disabled";
    }
    return {
      label: state.name,
      detail,
      value: state.name,
      command: `/mcp reconnect ${state.name}`,
    };
  });
}

function CommandPalette({
  items,
  terminalColumns,
  terminalRows,
  onSelect,
  onCancel,
}: {
  items: PaletteItem[];
  terminalColumns: number;
  terminalRows: number;
  onSelect: (item: PaletteItem) => void;
  onCancel: () => void;
}) {
  return (
    <PalettePicker
      title="Commands"
      hint="Type to filter · Up/Down choose · Enter run · Esc cancel"
      emptyText="No commands found."
      items={items}
      terminalColumns={terminalColumns}
      terminalRows={terminalRows}
      searchable
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

function McpReconnectPicker({
  items,
  terminalColumns,
  terminalRows,
  onSelect,
  onCancel,
}: {
  items: PaletteItem[];
  terminalColumns: number;
  terminalRows: number;
  onSelect: (item: PaletteItem) => void;
  onCancel: () => void;
}) {
  return (
    <PalettePicker
      title="MCP servers"
      hint="Up/Down choose · Enter or r reconnect · Esc cancel"
      emptyText="No MCP servers configured."
      items={items}
      terminalColumns={terminalColumns}
      terminalRows={terminalRows}
      reconnectAlias
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}

function PalettePicker({
  title,
  hint,
  emptyText,
  items,
  terminalColumns,
  terminalRows,
  searchable = false,
  reconnectAlias = false,
  onSelect,
  onCancel,
}: {
  title: string;
  hint: string;
  emptyText: string;
  items: PaletteItem[];
  terminalColumns: number;
  terminalRows: number;
  searchable?: boolean;
  reconnectAlias?: boolean;
  onSelect: (item: PaletteItem) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const maxVisible = Math.max(5, Math.min(12, terminalRows - 10));
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      item.label.toLowerCase().includes(needle) ||
      item.detail.toLowerCase().includes(needle) ||
      item.value.toLowerCase().includes(needle)
    );
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(Math.max(0, filtered.length - 1), current));
  }, [filtered.length]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return || (reconnectAlias && input.toLowerCase() === "r")) {
      const item = filtered[selectedIndex];
      if (item) onSelect(item);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(Math.max(0, filtered.length - 1), index + 1));
      return;
    }
    if (key.pageUp) {
      setSelectedIndex((index) => Math.max(0, index - maxVisible));
      return;
    }
    if (key.pageDown) {
      setSelectedIndex((index) => Math.min(Math.max(0, filtered.length - 1), index + maxVisible));
      return;
    }
    if (!searchable) return;
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      return;
    }
    if (isPrintablePickerInput(input) && !key.ctrl && !key.meta) {
      setQuery((current) => current + input);
    }
  });

  const start = clampWindowStartForIndex(filtered.length, selectedIndex, maxVisible);
  const visible = filtered.slice(start, start + maxVisible);
  const labelWidth = Math.max(18, Math.min(36, Math.floor(terminalColumns * 0.32)));
  const detailWidth = Math.max(20, terminalColumns - labelWidth - 10);

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>{title}</Text>
      {searchable && (
        <Text color={theme.muted}>
          Filter: <Text color={theme.userMessageText}>{query || " "}</Text>
        </Text>
      )}
      <Text color={theme.muted}>{hint}</Text>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 && <Text color={theme.muted}>{emptyText}</Text>}
        {visible.map((item, offset) => {
          const actualIndex = start + offset;
          const selected = actualIndex === selectedIndex;
          return (
            <Box key={`${item.action ?? "command"}-${item.value}`}>
              <Text color={selected ? theme.accent : undefined}>
                {selected ? "> " : "  "}
                {truncate(item.label, labelWidth)}
              </Text>
              <Text color={theme.muted}> {truncate(item.detail, detailWidth)}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

type RewindScope = "all" | "chat" | "code";

const REWIND_SCOPE_ORDER: RewindScope[] = ["all", "chat", "code"];
const REWIND_SCOPE_LABEL: Record<RewindScope, string> = {
  all: "chat + files",
  chat: "chat only",
  code: "files only",
};

function rewindCommand(turnIndex: number, scope: RewindScope): string {
  const base = `/rewind ${turnIndex + 1}`;
  if (scope === "chat") return `${base} --chat`;
  if (scope === "code") return `${base} --code`;
  return base;
}

function cycleRewindScope(scope: RewindScope, direction: 1 | -1): RewindScope {
  const index = REWIND_SCOPE_ORDER.indexOf(scope);
  return REWIND_SCOPE_ORDER[
    (index + direction + REWIND_SCOPE_ORDER.length) % REWIND_SCOPE_ORDER.length
  ]!;
}

function RewindPicker({
  sessionManager,
  terminalColumns,
  terminalRows,
  onSelect,
  onCancel,
}: {
  sessionManager: SessionManager;
  terminalColumns: number;
  terminalRows: number;
  onSelect: (command: string) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const turns = useMemo(() => sessionManager.listUserTurns(), [sessionManager]);
  const checkpoints = useMemo(() => sessionManager.getCheckpoints(), [sessionManager]);
  const fileCounts = useMemo(() => {
    const entries = checkpoints.listEntries();
    const byTurn = new Map<string, Set<string>>();
    for (const entry of entries) {
      const files = byTurn.get(entry.turn);
      if (files) files.add(entry.path);
      else byTurn.set(entry.turn, new Set([entry.path]));
    }
    return new Map(turns.map((turn) => [turn.id, byTurn.get(turn.id)?.size ?? 0]));
  }, [checkpoints, turns]);
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, turns.length - 1));
  const [scope, setScope] = useState<RewindScope>("all");
  const maxVisible = Math.max(4, Math.min(10, terminalRows - 10));

  useEffect(() => {
    setSelectedIndex((current) => Math.min(Math.max(0, turns.length - 1), current));
  }, [turns.length]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (turns[selectedIndex]) onSelect(rewindCommand(selectedIndex, scope));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(Math.max(0, turns.length - 1), index + 1));
      return;
    }
    if (key.pageUp) {
      setSelectedIndex((index) => Math.max(0, index - maxVisible));
      return;
    }
    if (key.pageDown) {
      setSelectedIndex((index) => Math.min(Math.max(0, turns.length - 1), index + maxVisible));
      return;
    }
    if (key.tab || key.rightArrow || input === "l") {
      setScope((current) => cycleRewindScope(current, 1));
      return;
    }
    if (key.leftArrow || input === "h") {
      setScope((current) => cycleRewindScope(current, -1));
    }
  });

  const start = clampWindowStartForIndex(turns.length, selectedIndex, maxVisible);
  const visibleTurns = turns.slice(start, start + maxVisible);
  const previewWidth = Math.max(18, Math.min(76, terminalColumns - 34));

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Rewind</Text>
      <Text color={theme.muted}>
        Restore: <Text color={theme.accent}>{REWIND_SCOPE_LABEL[scope]}</Text>
        {"  ·  "}
        {turns.length} point{turns.length === 1 ? "" : "s"}
      </Text>
      <Text color={theme.muted}>Up/Down choose · Left/Right scope · Enter rewind · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {turns.length === 0 && <Text color={theme.muted}>Nothing to rewind: no user messages in this session.</Text>}
        {visibleTurns.map((turn, offset) => {
          const actualIndex = start + offset;
          const isSelected = actualIndex === selectedIndex;
          const touched = fileCounts.get(turn.id) ?? 0;
          return (
            <RewindRow
              key={turn.id}
              turn={turn}
              turnNumber={actualIndex + 1}
              selected={isSelected}
              fileCount={touched}
              previewWidth={previewWidth}
            />
          );
        })}
      </Box>
    </Box>
  );
}

function RewindRow({
  turn,
  turnNumber,
  selected,
  fileCount,
  previewWidth,
}: {
  turn: UserTurn;
  turnNumber: number;
  selected: boolean;
  fileCount: number;
  previewWidth: number;
}) {
  const theme = useTheme();
  const time = new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fileNote = fileCount > 0 ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}` : "";
  return (
    <Box>
      <Text color={selected ? theme.accent : undefined}>
        {selected ? "> " : "  "}
        {String(turnNumber).padStart(2, " ")} {time} {truncate(turn.preview, previewWidth)}
      </Text>
      <Text color={theme.muted}>{fileNote}</Text>
    </Box>
  );
}

function clampWindowStartForIndex(total: number, selectedIndex: number, maxVisible: number): number {
  if (total <= maxVisible) return 0;
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedIndex - half);
  if (start + maxVisible > total) start = total - maxVisible;
  return Math.max(0, start);
}

function StatsPanel({
  panel,
  terminalColumns,
  terminalRows,
  onRangeChange,
  onCancel,
}: {
  panel: { range: StatsRange; bundle: UsageStatsBundle };
  terminalColumns: number;
  terminalRows: number;
  onRangeChange: (range: StatsRange) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [scroll, setScroll] = useState(0);
  const bodyWidth = Math.max(48, Math.min(92, terminalColumns - 6));
  const lines = useMemo(
    () => formatStatsPanelBody(panel.bundle.ranges[panel.range], bodyWidth).split("\n"),
    [bodyWidth, panel.bundle, panel.range],
  );
  const maxVisible = Math.max(5, Math.min(16, terminalRows - 10));
  const maxScroll = Math.max(0, lines.length - maxVisible);

  useEffect(() => {
    setScroll(0);
  }, [panel.range]);

  useEffect(() => {
    setScroll((current) => Math.min(current, maxScroll));
  }, [maxScroll]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      onRangeChange(panel.range === "30d" ? "7d" : "30d");
      return;
    }
    if (key.leftArrow || input === "h") {
      onRangeChange("7d");
      return;
    }
    if (key.rightArrow || input === "l") {
      onRangeChange("30d");
      return;
    }
    if (key.upArrow) {
      setScroll((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setScroll((current) => Math.min(maxScroll, current + 1));
      return;
    }
    if (key.pageUp) {
      setScroll((current) => Math.max(0, current - maxVisible));
      return;
    }
    if (key.pageDown) {
      setScroll((current) => Math.min(maxScroll, current + maxVisible));
    }
  });

  const visible = lines.slice(scroll, scroll + maxVisible);
  const generatedAt = panel.bundle.generatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Stats</Text>
      <Text color={theme.muted}>
        {rangeLabel(panel.range)} · generated {generatedAt}
      </Text>
      <Text color={theme.muted}>Left/Right range · Up/Down scroll · Tab toggle · Esc close</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, index) => {
          const key = `${scroll + index}-${line}`;
          const heading = line === "Activity" || line === "Model usage" || line === "Summary";
          return (
            <Text key={key} color={heading ? theme.accent : undefined} bold={heading}>
              {line || " "}
            </Text>
          );
        })}
      </Box>
      {maxScroll > 0 && (
        <Text color={theme.muted}>
          {scroll + 1}-{Math.min(lines.length, scroll + maxVisible)} of {lines.length}
        </Text>
      )}
    </Box>
  );
}

interface InkSidebarProps {
  width: number;
  agent: Agent;
  sessionManager?: SessionManager;
  cwd: string;
  mode: PermissionMode;
  goalLine: string;
  todos: Todo[];
  mcpManager?: McpManager;
  lspService?: LspService;
}

interface StatusCount {
  connected: number;
  starting: number;
  failed: number;
  disabled: number;
}

function summarizeMcpStates(states: McpServerState[]): StatusCount & { tools: number } {
  const summary = { connected: 0, starting: 0, failed: 0, disabled: 0, tools: 0 };
  for (const state of states) {
    if (state.status.kind === "connected") {
      summary.connected += 1;
      summary.tools += state.status.tools.length;
    } else if (state.status.kind === "failed") {
      summary.failed += 1;
    } else {
      summary.disabled += 1;
    }
  }
  return summary;
}

function summarizeLspStatuses(statuses: LspStatus[]): StatusCount {
  const summary = { connected: 0, starting: 0, failed: 0, disabled: 0 };
  for (const status of statuses) {
    if (status.status === "connected") summary.connected += 1;
    else if (status.status === "starting") summary.starting += 1;
    else summary.failed += 1;
  }
  return summary;
}

function formatStatusCount(summary: StatusCount): string {
  const parts: string[] = [];
  if (summary.connected > 0) parts.push(`${summary.connected} up`);
  if (summary.starting > 0) parts.push(`${summary.starting} starting`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.disabled > 0) parts.push(`${summary.disabled} disabled`);
  return parts.join(" · ") || "none";
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent} bold>{title}</Text>
      {children}
    </Box>
  );
}

function SidebarRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.muted}>{label}: </Text>
      <Text color={color ?? theme.userMessageText}>{value}</Text>
    </Box>
  );
}

function InkSidebar({
  width,
  agent,
  sessionManager,
  cwd,
  mode,
  goalLine,
  todos,
  mcpManager,
  lspService,
}: InkSidebarProps) {
  const theme = useTheme();
  const innerWidth = Math.max(12, width - 4);
  const todoCounts = todos.reduce(
    (acc, todo) => {
      acc[todo.status] = (acc[todo.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<Todo["status"], number>,
  );
  const todoSummary = todos.length === 0
    ? "none"
    : [
        todoCounts.in_progress ? `${todoCounts.in_progress} active` : "",
        todoCounts.pending ? `${todoCounts.pending} pending` : "",
        todoCounts.completed ? `${todoCounts.completed} done` : "",
      ].filter(Boolean).join(" · ");
  const mcpStates = mcpManager?.getStates() ?? [];
  const mcpSummary = summarizeMcpStates(mcpStates);
  const lspSummary = lspService?.isDisabled()
    ? { connected: 0, starting: 0, failed: 0, disabled: 1 }
    : summarizeLspStatuses(lspService?.status() ?? []);
  const latestMcpFailure = mcpStates.find((state) => state.status.kind === "failed");
  const latestLspFailure = lspService?.status().find((status) => status.status === "error");
  const sessionTitle = truncate(sessionDisplayName(sessionManager), innerWidth);
  const modelLabel = agent.model ? displayModel(agent.model) : "not selected";
  const route = agent.providerId
    ? `${agent.providerId}/${modelLabel}`
    : modelLabel;

  return (
    <Box
      flexDirection="column"
      width={width}
      height="100%"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
      paddingY={1}
      flexShrink={0}
    >
      <Text color={theme.borderActive} bold>Session</Text>
      <Text color={theme.userMessageText}>{sessionTitle}</Text>
      <Text color={theme.muted}>{truncate(friendlyCwd(cwd), innerWidth)}</Text>

      <Box marginTop={1} flexDirection="column">
        <SidebarSection title="Runtime">
          <SidebarRow label="model" value={truncate(route, innerWidth - 7)} />
          <SidebarRow label="mode" value={mode} color={mode === "bypassPermissions" ? theme.warning : theme.userMessageText} />
          <SidebarRow label="thinking" value={agent.thinking || "off"} />
        </SidebarSection>

        {goalLine && (
          <SidebarSection title="Goal">
            <Text color={theme.userMessageText}>{truncate(goalLine, innerWidth)}</Text>
          </SidebarSection>
        )}

        <SidebarSection title="Todos">
          <Text color={todos.length > 0 ? theme.userMessageText : theme.muted}>
            {truncate(todoSummary, innerWidth)}
          </Text>
        </SidebarSection>

        <SidebarSection title="MCP">
          <Text color={mcpSummary.failed > 0 ? theme.warning : theme.userMessageText}>
            {truncate(`${formatStatusCount(mcpSummary)}${mcpSummary.tools > 0 ? ` · ${mcpSummary.tools} tools` : ""}`, innerWidth)}
          </Text>
          {latestMcpFailure?.status.kind === "failed" && (
            <Text color={theme.muted}>{truncate(latestMcpFailure.status.error, innerWidth)}</Text>
          )}
        </SidebarSection>

        <SidebarSection title="LSP">
          <Text color={lspSummary.failed > 0 ? theme.warning : theme.userMessageText}>
            {truncate(formatStatusCount(lspSummary), innerWidth)}
          </Text>
          {latestLspFailure?.message && (
            <Text color={theme.muted}>{truncate(latestLspFailure.message, innerWidth)}</Text>
          )}
        </SidebarSection>
      </Box>
    </Box>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GENERIC_PHRASES = [
  "mapping the workspace",
  "reading the room",
  "following the threads",
  "connecting the pieces",
  "sorting the context",
  "scanning the structure",
  "shaping the next step",
  "gathering signal",
  "checking the edges",
  "lining up the answer",
  "tracing the flow",
  "building the picture",
  "walking the graph",
  "collecting the clues",
  "framing the problem",
  "locating the source",
  "resolving the shape",
  "untangling the state",
  "comparing the paths",
  "narrowing the target",
  "tracking the changes",
  "reading the patterns",
  "weighing the options",
  "assembling the context",
  "following the signal",
  "checking the assumptions",
  "aligning the details",
  "testing the shape",
  "pulling the thread",
  "cleaning the edges",
  "refining the draft",
  "verifying the route",
  "making sense of it",
  "looking for leverage",
  "stitching the answer",
  "holding the thread",
  "distilling the noise",
  "finding the seam",
  "reading between the lines",
  "preparing the response",
];

const TOOL_TARGET_PHRASES: Record<string, string> = {
  read: "reading files",
  write: "writing changes",
  edit: "patching files",
  grep: "searching the codebase",
  glob: "scanning paths",
  ls: "listing directories",
  bash: "running command",
  web_search: "searching the web",
  web_fetch: "fetching a page",
  task: "spawning subagent",
};

function formatTokensApprox(chars: number): string {
  const tokens = Math.max(0, Math.round(chars / 4));
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

interface WaitingIndicatorProps {
  tools: DisplayToolCall[];
  hasStreamingText: boolean;
  hasStreamingReasoning: boolean;
  streamedChars: number;
  nowTick: number;
  pendingSteerCount?: number;
  queuedCount?: number;
}

function WaitingIndicator({
  tools,
  hasStreamingText,
  hasStreamingReasoning,
  streamedChars,
  nowTick,
  pendingSteerCount = 0,
  queuedCount = 0,
}: WaitingIndicatorProps) {
  void nowTick;
  const theme = useTheme();
  const [frameIndex, setFrameIndex] = useState(0);
  const [idlePhrase, setIdlePhrase] = useState(() => GENERIC_PHRASES[0]);

  // Frame timer is independent of the agent state — keeps animation smooth.
  useEffect(() => {
    const t = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(t);
  }, []);

  // Determine state: active tool > streaming text > streaming reasoning > idle
  const activeTool = [...tools].reverse().find((t) => !t.result);
  const state: "tool" | "text" | "reasoning" | "idle" = activeTool
    ? "tool"
    : hasStreamingText
      ? "text"
      : hasStreamingReasoning
        ? "reasoning"
        : "idle";

  // Rotate idle phrases on a slower cadence; only matters in the idle state.
  useEffect(() => {
    if (state !== "idle") return;
    const t = setInterval(() => {
      setIdlePhrase((current) => {
        const candidates = GENERIC_PHRASES.filter((item) => item !== current);
        return candidates[Math.floor(Math.random() * candidates.length)] || current;
      });
    }, 1500);
    return () => clearInterval(t);
  }, [state]);

  let phrase: string;
  if (state === "tool" && activeTool) {
    phrase =
      TOOL_TARGET_PHRASES[activeTool.name] || `running ${activeTool.name}`;
  } else if (state === "text") {
    phrase = "writing the response";
  } else if (state === "reasoning") {
    phrase = "working through the request";
  } else {
    phrase = idlePhrase;
  }

  const tokenText = streamedChars > 0 ? `↓${formatTokensApprox(streamedChars)} tok` : "";
  const hintParts: string[] = [];
  if (tokenText) hintParts.push(tokenText);
  if (pendingSteerCount > 0) hintParts.push(`${pendingSteerCount} pending steer${pendingSteerCount === 1 ? "" : "s"}`);
  if (queuedCount > 0) hintParts.push(`${queuedCount} queued`);
  hintParts.push("enter steer", "tab queue", "esc stop");

  return (
    <Box>
      <Text color={theme.accent}>{SPINNER_FRAMES[frameIndex]}</Text>
      <Text color={theme.muted}> {phrase} </Text>
      <Text color={theme.muted} dimColor>
        ({hintParts.join(" · ")})
      </Text>
    </Box>
  );
}
