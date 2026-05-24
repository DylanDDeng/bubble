import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { AgentAbortError, type Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
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
  nextDisplayMessageKey,
  snapshotDisplayParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
  toolCallsFromParts,
} from "./display-history.js";
import type { PendingApprovalHint } from "./message-list.js";
import { paletteFor, ThemeProvider, useTheme, type ResolvedTheme, type Theme, type ThemeMode } from "./theme.js";
import { ModelPicker, ProviderPicker, KeyPicker, SkillPicker } from "./model-picker.js";
import { FeishuSetupPicker } from "./feishu-setup-picker.js";
import { BUILTIN_PROVIDERS, ProviderRegistry, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ThinkingLevel } from "../types.js";
import { getAvailableThinkingLevels, getDefaultThinkingLevel, normalizeThinkingLevel } from "../provider-transform.js";
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
import type { LspService } from "../lsp/index.js";
import type { QuestionAnswer, QuestionController, QuestionRequest } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
import { QuestionDialog } from "./question-dialog.js";
import { FeedbackDialog } from "./feedback-dialog.js";
import { collectFeedback } from "../feedback/collect.js";
import { hasTerminalMouseSequence } from "./terminal-mouse.js";
import os from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  /** Whether the bypassPermissions mode is reachable via Shift+Tab cycling. */
  bypassEnabled?: boolean;
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
      result.push({
        key: nextDisplayMessageKey("asst"),
        role: "assistant",
        content: m.content,
        reasoning: m.reasoning || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
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

const STREAMING_STATIC_FLUSH_MIN_CHARS = 5000;
const STREAMING_STATIC_FLUSH_TARGET_CHARS = 3600;
const STREAMING_STATIC_FLUSH_MIN_TAIL = 700;

function findStreamingStaticFlushIndex(content: string): number {
  if (content.length < STREAMING_STATIC_FLUSH_MIN_CHARS) return -1;
  const upper = Math.min(
    STREAMING_STATIC_FLUSH_TARGET_CHARS,
    content.length - STREAMING_STATIC_FLUSH_MIN_TAIL,
  );
  if (upper <= 0) return -1;
  const search = content.slice(0, upper);
  const paragraphBreak = search.lastIndexOf("\n\n");
  if (paragraphBreak >= STREAMING_STATIC_FLUSH_TARGET_CHARS / 2) {
    return paragraphBreak + 2;
  }
  const lineBreak = search.lastIndexOf("\n");
  if (lineBreak >= STREAMING_STATIC_FLUSH_TARGET_CHARS / 2) {
    return lineBreak + 1;
  }
  return -1;
}

function cloneDisplayPart(part: DisplayMessagePart): DisplayMessagePart {
  if (part.type === "text") {
    return { type: "text", content: part.content };
  }
  return {
    type: "tools",
    toolCalls: part.toolCalls.map((toolCall) => ({
      ...toolCall,
      args: { ...toolCall.args },
    })),
  };
}

function splitDisplayPartsAtTextOffset(
  parts: DisplayMessagePart[],
  offset: number,
): { flushedParts: DisplayMessagePart[]; remainingParts: DisplayMessagePart[] } {
  const flushedParts: DisplayMessagePart[] = [];
  const remainingParts: DisplayMessagePart[] = [];
  let remainingOffset = Math.max(0, offset);
  let reachedTail = false;

  for (const part of parts) {
    if (part.type === "text") {
      if (!reachedTail && remainingOffset >= part.content.length) {
        if (part.content) flushedParts.push(cloneDisplayPart(part));
        remainingOffset -= part.content.length;
        continue;
      }
      if (!reachedTail && remainingOffset > 0) {
        const head = part.content.slice(0, remainingOffset);
        const tail = part.content.slice(remainingOffset);
        if (head) flushedParts.push({ type: "text", content: head });
        if (tail) remainingParts.push({ type: "text", content: tail });
        remainingOffset = 0;
        reachedTail = true;
        continue;
      }
      remainingParts.push(cloneDisplayPart(part));
      reachedTail = true;
      continue;
    }

    if (!reachedTail && remainingOffset > 0) {
      flushedParts.push(cloneDisplayPart(part));
    } else {
      remainingParts.push(cloneDisplayPart(part));
      reachedTail = true;
    }
  }

  return { flushedParts, remainingParts };
}

export function App({ agent, args, sessionManager, createProvider, registry, skillRegistry, planHandlerRef, approvalHandlerRef, questionController, bashAllowlist, settingsManager, lspService, mcpManager, themeMode: initialThemeMode, themeOverrides, detectedTheme, onThemeModeChange, flushMemory, runMemoryCompaction, runMemorySummary, runMemoryRefresh, bypassEnabled, onExit }: AppProps) {
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
  const [clearEpoch, setClearEpoch] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingTools, setStreamingTools] = useState<DisplayToolCall[]>([]);
  const [streamingParts, setStreamingParts] = useState<DisplayMessagePart[]>([]);
  const [usageTotals, setUsageTotals] = useState({ prompt: 0, completion: 0 });
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(agent.thinking);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(agent.mode);
  const [todos, setTodos] = useState<Todo[]>(() => agent.getTodos());
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
  const [pickerMode, setPickerMode] = useState<"model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "feishu-setup" | null>(null);
  const [cursorResetEpoch, setCursorResetEpoch] = useState(0);
  const [composerDraft, setComposerDraft] = useState<{ text: string; epoch: number } | null>(null);
  const [keyProviderId, setKeyProviderId] = useState<string | null>(null);
  const [verboseTrace, setVerboseTrace] = useState(false);
  const startedWithVisibleHistoryRef = useRef(messages.some((message) => message.syntheticKind !== "ui_summary"));
  const { columns: terminalColumns } = useTerminalSize();
  const showWelcome = shouldShowWelcomeBanner({
    messages,
    startedWithVisibleHistory: startedWithVisibleHistoryRef.current,
  });
  const activeAbortRef = useRef<AbortController | null>(null);
  const exitRequestedRef = useRef(false);
  const sessionStartRef = useRef<number>(Date.now());
  const previousTerminalColumnsRef = useRef<number | null>(null);
  useEffect(() => {
    if (previousTerminalColumnsRef.current === null) {
      previousTerminalColumnsRef.current = terminalColumns;
      return;
    }
    if (previousTerminalColumnsRef.current === terminalColumns) return;
    previousTerminalColumnsRef.current = terminalColumns;

    // This follows Gemini CLI's normal terminal-buffer strategy: after a
    // resize, the previous live Ink frame may have wrapped at the old width,
    // so cursor-up based repaint can leave stale progress frames behind.
    // Debounce resize storms, then clear and replay Static at the settled width.
    const timer = setTimeout(() => {
      if (exitRequestedRef.current) return;
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setClearEpoch((epoch) => epoch + 1);
    }, 300);
    return () => clearTimeout(timer);
  }, [terminalColumns]);
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
        skills: safeSkillRegistry?.summaries() ?? [],
      }));
    },
    [agent, args.cwd, safeRegistry, safeSkillRegistry],
  );

  useInput((input, key) => {
    if (isCtrlCInput(input, key)) {
      requestExit();
      return;
    }

    if (pendingPlan || pendingApproval || pendingQuestion || pendingFeedback) return;
    if (hasTerminalMouseSequence(input)) return;

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
      sessionManager?.setMetadata({ model: agent.model, thinkingLevel: nextLevel, reasoningEffort: nextLevel });
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

  const addMessage = useCallback((role: DisplayMessage["role"], content: string) => {
    updateDisplayMessages((prev) => [...prev, withMessageKey({ role, content })]);
  }, [updateDisplayMessages]);

  const clearMessages = useCallback(() => {
    // Static history is already written to terminal scrollback, so clearing
    // React state alone would leave old rows visible.
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setMessages([]);
    setClearEpoch((epoch) => epoch + 1);
  }, []);

  const openPicker = useCallback((mode: "model" | "key" | "provider" | "provider-add" | "login" | "logout" | "skill" | "feishu-setup", providerId?: string) => {
    if (mode === "key") {
      setKeyProviderId(providerId ?? null);
    }
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

  const openFeedback = useCallback((initialDescription: string) => {
    const base = collectFeedback(agent, { description: "" });
    const { description: _drop, ...rest } = base;
    setPendingFeedback({ base: rest, initialDescription });
  }, [agent]);

  const handleModelSelect = useCallback((model: string) => {
    const run = async () => {
      agent.model = model;
      const decoded = model.includes(":")
        ? model.split(":")
        : [agent.providerId || safeRegistry.getDefault()?.id || "openai", model];
      const providerId = decoded[0];

      await safeRegistry.prepareProvider(providerId);
      const provider = safeRegistry.getConfigured().find((item) => item.id === providerId);
      if (!provider?.apiKey || !createProvider) {
        addMessage("error", `Provider ${providerId} is not configured or has no active credentials.`);
        closePicker();
        return;
      }

      const modelId = model.includes(":") ? model.split(":").slice(1).join(":") : model;
      agent.thinking = normalizeThinkingLevel(
        agent.thinking || getDefaultThinkingLevel(providerId, modelId),
        getAvailableThinkingLevels(providerId, modelId),
      );
      agent.setProvider(createProvider(providerId, provider.apiKey, provider.baseURL));
      agent.providerId = providerId;
      agent.setSystemPrompt(buildSystemPrompt({
        agentName: "Bubble",
        configuredProvider: providerId,
        configuredModel: displayModel(model),
        configuredModelId: model,
        thinkingLevel: agent.thinking,
        workingDir: args.cwd,
        skills: safeSkillRegistry?.summaries() ?? [],
      }));
      userConfig.pushRecentModel(model);
      setThinkingLevel(agent.thinking);
      sessionManager?.setMetadata({ model, thinkingLevel: agent.thinking, reasoningEffort: agent.thinking });
      sessionManager?.appendMarker("model_switch", model);
      addMessage("assistant", `Model switched to ${displayModel(model)}.`);
      closePicker();
    };

    void run();
  }, [agent, addMessage, closePicker, sessionManager, userConfig, safeRegistry, createProvider]);

  const handleProviderSelect = useCallback(async (providerId: string) => {
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
      openFeedback,
      registry: safeRegistry,
      skillRegistry: safeSkillRegistry!,
      bashAllowlist,
      settingsManager,
      lspService,
      mcpManager,
      flushMemory,
      runMemoryCompaction,
      runMemorySummary,
      runMemoryRefresh,
      getThemeMode: () => themeMode,
      getResolvedTheme: () => themeResolved,
      setThemeMode: applyThemeMode,
    });
    if (handled && result) {
      addMessage("assistant", result);
    }
  }, [agent, addMessage, clearMessages, closePicker, createProvider, exit, openPicker, safeRegistry, sessionManager]);

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
      openFeedback,
      registry: safeRegistry,
      skillRegistry: safeSkillRegistry!,
      bashAllowlist,
      settingsManager,
      lspService,
      mcpManager,
      flushMemory,
      runMemoryCompaction,
      runMemorySummary,
      runMemoryRefresh,
      getThemeMode: () => themeMode,
      getResolvedTheme: () => themeResolved,
      setThemeMode: applyThemeMode,
    });
    if (handled && result) {
      addMessage("assistant", result);
    }
  }, [agent, addMessage, clearMessages, closePicker, createProvider, exit, openPicker, safeRegistry, sessionManager]);

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
      const normalized: SubmitPayload =
        typeof payload === "string" ? { text: payload, images: [] } : payload;
      const input = normalized.text;
      const displayInput = normalized.displayText ?? input;
      const images = normalized.images;
      if (!input.trim() && images.length === 0) return;

      const runAgentInput = async (
        actualInput: string | ContentPart[],
        displayInput: string,
        attachedImages: { filename?: string; bytes: number }[] = [],
      ) => {
        const activeProviderId = agent.providerId || safeRegistry.getDefault()?.id;
        const hasActiveProvider = !!activeProviderId && safeRegistry.getEnabled().some((provider) => provider.id === activeProviderId);
        if (!hasActiveProvider) {
          addMessage("error", "No provider configured. Use /login for ChatGPT or /provider --add <id> before sending a prompt.");
          return;
        }
        if (!agent.model) {
          addMessage("error", "No model selected. Use /model after /login or provider setup.");
          return;
        }

        const displayContent = attachedImages.length > 0
          ? `${displayInput}${displayInput ? "\n" : ""}${attachedImages
              .map((img, i) =>
                `[image${attachedImages.length > 1 ? ` ${i + 1}` : ""}: ${img.filename ?? "clipboard"} · ${Math.max(1, Math.round(img.bytes / 1024))}KB]`,
              )
              .join(" ")}`
          : displayInput;
        updateDisplayMessages((prev) => [
          ...prev,
          withMessageKey({ role: "user", content: displayContent }),
        ]);
        setIsRunning(true);
        runStartRef.current = Date.now();
        setStreamingContent("");
        setStreamingReasoning("");
        setStreamingTools([]);
        setStreamingParts([]);

        let assistantContent = "";
        let assistantReasoning = "";
        const toolCalls: DisplayToolCall[] = [];
        const assistantParts: DisplayMessagePart[] = [];
        const abortController = new AbortController();
        activeAbortRef.current = abortController;

        const syncStreamingParts = () => {
          setStreamingParts(snapshotDisplayParts(assistantParts));
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
          setStreamingContent("");
          setStreamingReasoning("");
          setStreamingTools([]);
          setStreamingParts([]);
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          assistantParts.length = 0;
        };
        const flushAssistantStaticChunk = (): boolean => {
          if (toolCalls.some((toolCall) => toolCall.result === undefined)) {
            return false;
          }
          const splitIndex = findStreamingStaticFlushIndex(assistantContent);
          if (splitIndex <= 0) return false;

          const { flushedParts, remainingParts } = splitDisplayPartsAtTextOffset(assistantParts, splitIndex);
          const flushedContent = contentFromParts(flushedParts);
          const flushedToolCalls = toolCallsFromParts(flushedParts);
          if (!flushedContent && flushedToolCalls.length === 0) return false;

          const msg: DisplayMessage = {
            key: nextDisplayMessageKey("asst"),
            role: "assistant",
            content: flushedContent,
          };
          if (assistantReasoning) {
            msg.reasoning = assistantReasoning;
            assistantReasoning = "";
            setStreamingReasoning("");
          }
          if (flushedToolCalls.length > 0) {
            msg.toolCalls = flushedToolCalls;
          }
          if (flushedParts.length > 0) {
            msg.parts = flushedParts;
          }
          updateDisplayMessages((prev) => [...prev, msg]);

          assistantParts.splice(0, assistantParts.length, ...remainingParts);
          assistantContent = contentFromParts(assistantParts);
          const remainingToolCalls = toolCallsFromParts(assistantParts);
          toolCalls.splice(0, toolCalls.length, ...remainingToolCalls);
          setStreamingContent(assistantContent);
          setStreamingTools([...toolCalls]);
          syncStreamingParts();
          return true;
        };

        try {
          for await (const event of agent.run(actualInput, args.cwd, { abortSignal: abortController.signal })) {
            switch (event.type) {
              case "text_delta":
                assistantContent += event.content;
                appendTextPart(assistantParts, event.content);
                if (!flushAssistantStaticChunk()) {
                  setStreamingContent(assistantContent);
                  syncStreamingParts();
                }
                break;
              case "reasoning_delta":
                assistantReasoning += event.content;
                setStreamingReasoning(assistantReasoning);
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
              case "turn_end": {
                if (event.usage) {
                  setUsageTotals((totals) => ({
                    prompt: totals.prompt + event.usage!.promptTokens,
                    completion: totals.completion + event.usage!.completionTokens,
                  }));
                }
                if (event.willContinue) {
                  syncStreamingParts();
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
            updateDisplayMessages((prev) => [
              ...prev,
              withMessageKey({ role: "assistant", content: "Cancelled." }),
            ]);
          } else {
            updateDisplayMessages((prev) => [
              ...prev,
              withMessageKey({ role: "error", content: err.message }),
            ]);
          }
        } finally {
          if (activeAbortRef.current === abortController) activeAbortRef.current = null;
          setIsRunning(false);
          runStartRef.current = null;
          setStreamingContent("");
          setStreamingReasoning("");
          setStreamingTools([]);
          setStreamingParts([]);
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
          openFeedback,
          registry: safeRegistry,
          skillRegistry: safeSkillRegistry!,
          bashAllowlist,
          settingsManager,
          lspService,
          mcpManager,
          flushMemory,
          runMemoryCompaction,
          runMemorySummary,
          runMemoryRefresh,
          getThemeMode: () => themeMode,
          getResolvedTheme: () => themeResolved,
          setThemeMode: applyThemeMode,
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
              updateDisplayMessages(() => [
                ...reconstructDisplayMessages(agent.messages),
                {
                  role: "assistant",
                  content: result,
                  syntheticKind: "ui_compact_summary",
                  compactionSummary: summary,
                },
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
        addMessage("error", `Skipped @${skip.path}: ${skip.reason}`);
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
      );
    },
    [addMessage, agent, args.cwd, openPicker, createProvider, safeRegistry, safeSkillRegistry, updateDisplayMessages]
  );

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

  const mcpStates = mcpManager?.getStates() ?? [];
  const mcpConnectedCount = mcpStates.filter((state) => state.status.kind === "connected").length;
  const hasAgentsFile = useMemo(
    () => existsSync(join(args.cwd, "AGENTS.md")) || existsSync(join(args.cwd, ".bubble", "AGENTS.md")),
    [args.cwd],
  );

  const welcomeBannerNode = showWelcome ? (
    <WelcomeBanner
      terminalColumns={terminalColumns}
      modelLabel={agent.model ? displayModel(agent.model) : undefined}
      cwd={friendlyCwd(args.cwd)}
      tips={buildTips(agent, safeRegistry)}
      skillsCount={safeSkillRegistry.summaries().length}
      mcpConnectedCount={mcpConnectedCount}
      mcpTotalCount={mcpStates.length}
      hasAgentsFile={hasAgentsFile}
    />
  ) : null;

  return (
    <ThemeProvider value={palette}>
      <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="column" paddingX={1} paddingTop={1} flexShrink={0}>
          <MessageList
            key={clearEpoch}
            messages={messages}
            streamingContent={streamingContent}
            streamingReasoning={streamingReasoning}
            streamingTools={streamingTools}
            streamingParts={streamingParts}
            terminalColumns={terminalColumns}
            verboseTrace={verboseTrace}
            pendingApproval={approvalHint}
            nowTick={nowTick}
            welcomeBanner={welcomeBannerNode}
          />
        {pickerMode === "model" && (
          <ModelPicker
            registry={safeRegistry}
            current={agent.model}
            recent={userConfig.getRecentModels()}
            onSelect={handleModelSelect}
            onCancel={closePicker}
          />
        )}
        {pickerMode === "provider" && (
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
        )}
        {pickerMode === "provider-add" && (
          <ProviderPicker
            providers={BUILTIN_PROVIDERS
              .filter((p) => isUserVisibleProvider(p.id))
              .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
            current={currentProviderId}
            onSelect={handleProviderAddSelect}
            onCancel={closePicker}
            title="Add Provider"
          />
        )}
        {pickerMode === "login" && (
          <ProviderPicker
            providers={BUILTIN_PROVIDERS
              .filter((p) => isUserVisibleProvider(p.id) && safeRegistry.supportsOAuth(p.id))
              .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
            current={currentProviderId}
            onSelect={handleLoginProviderSelect}
            onCancel={closePicker}
            title="Select Login Provider"
          />
        )}
        {pickerMode === "logout" && (
          <ProviderPicker
            providers={safeRegistry.getConfigured()
              .filter((p) => safeRegistry.getAuthStorage().has(p.id))
              .map((p) => ({ id: p.id, name: p.name, enabled: true }))}
            current={currentProviderId}
            onSelect={handleLogoutProviderSelect}
            onCancel={closePicker}
            title="Select Logout Provider"
          />
        )}
        {pickerMode === "key" && keyTarget && (
          <KeyPicker
            providerName={keyTarget.name}
            onSubmit={handleKeySubmit}
            onCancel={() => {
              closePicker();
              setKeyProviderId(null);
            }}
          />
        )}
        {pickerMode === "skill" && (
          <SkillPicker
            skills={safeSkillRegistry.summaries()}
            onSelect={(name) => {
              fillComposer(`/${name} `);
              closePicker();
            }}
            onCancel={closePicker}
          />
        )}
        {pickerMode === "feishu-setup" && (
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
        )}
      </Box>
      {todos.length > 0 && !pickerMode && !pendingPlan && !pendingQuestion && (
        <Box paddingX={1} flexShrink={0}>
          <TodosPanel todos={todos} terminalColumns={terminalColumns} />
        </Box>
      )}
      {pendingPlan && !pickerMode && !pendingQuestion && (
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
      {pendingApproval && !pickerMode && !pendingPlan && !pendingQuestion && (
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
      {pendingQuestion && !pickerMode && !pendingPlan && !pendingApproval && !pendingFeedback && (
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
      {pendingFeedback && !pickerMode && !pendingPlan && !pendingApproval && !pendingQuestion && (
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
      {!isExiting && isRunning && !pickerMode && !pendingPlan && !pendingApproval && !pendingQuestion && !pendingFeedback && (
        <Box paddingX={1} paddingBottom={1} flexShrink={0}>
          <WaitingIndicator
            tools={streamingTools}
            hasStreamingText={streamingContent.length > 0}
            hasStreamingReasoning={streamingReasoning.length > 0}
            streamedChars={streamingContent.length + streamingReasoning.length}
            nowTick={nowTick}
          />
        </Box>
      )}
      {!isExiting && !pickerMode && (
        <Box paddingBottom={1} flexShrink={0}>
          <InputBox
            onSubmit={handleSubmit}
            disabled={isRunning || !!pendingPlan || !!pendingApproval || !!pendingQuestion || !!pendingFeedback}
            cursorResetEpoch={cursorResetEpoch}
            draftText={composerDraft?.text}
            draftEpoch={composerDraft?.epoch}
            onDraftApplied={clearComposerDraft}
            skillRegistry={safeSkillRegistry}
            terminalColumns={terminalColumns}
            cwd={args.cwd}
          />
        </Box>
      )}
      {!isExiting && (
        <Box flexShrink={0}>
          <FooterBar
            data={buildFooterData({
              cwd: args.cwd,
              providerId: agent.providerId || safeRegistry.getDefault()?.id || "unknown",
              model: displayModel(agent.model) || "no model",
              thinkingLevel,
              showThinking: getAvailableThinkingLevels(agent.providerId, agent.apiModel).length > 2,
              mode: permissionMode,
              usageTotals,
              verboseTrace,
            })}
          />
        </Box>
      )}
    </Box>
    </ThemeProvider>
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
}

function WaitingIndicator({
  tools,
  hasStreamingText,
  hasStreamingReasoning,
  streamedChars,
  nowTick,
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

  return (
    <Box>
      <Text color={theme.accent}>{SPINNER_FRAMES[frameIndex]}</Text>
      <Text color={theme.muted}> {phrase} </Text>
      <Text color={theme.muted} dimColor>
        ({tokenText ? `${tokenText} · ` : ""}esc·esc to interrupt)
      </Text>
    </Box>
  );
}
