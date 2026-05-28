import {
  BoxRenderable,
  CodeRenderable,
  createCliRenderer,
  DiffRenderable,
  type CliRenderer,
  getTreeSitterClient,
  InputRenderable,
  MarkdownRenderable,
  LineNumberRenderable,
  type RenderContext,
  type Renderable,
  type ScrollBoxRenderable,
  type SelectOption,
  type SelectRenderable,
  StyledText,
  RGBA,
  type SyntaxStyle,
  fg,
  bg,
  bold,
  italic,
  dim,
  TextAttributes,
  TextRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import {
  createComponent,
  createElement,
  insert,
  render,
  spread,
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { registerApp } from "@larksuiteoapi/node-sdk";
import qrTerminal from "qrcode-terminal";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { AgentAbortError, type Agent } from "../agent.js";
import { AgentRunInputQueue } from "../agent/input-controller.js";
import { debugReasoningStream, summarizeDebugText } from "../reasoning-debug.js";
import {
  summarizeAgentEventForTrace,
  summarizeTraceError,
  summarizeTraceValue,
  traceEvent,
} from "../debug-trace.js";
import type { CliArgs } from "../cli.js";
import type { ThemeMode } from "../config.js";
import type { SessionManager } from "../session.js";
import type { ContentPart, Message, PermissionMode, PlanDecision, Provider, ThinkingLevel, Todo, TokenUsage, ToolResultMetadata } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import { BUILTIN_PROVIDERS, decodeModel, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { calculateUsageCost } from "../model-pricing.js";
import { getAvailableThinkingLevels } from "../provider-transform.js";
import { collectUsageStatsBundle, formatStatsPanelBody, type StatsRange, type UsageStats, type UsageStatsBundle } from "../stats/usage.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SidebarCommandState, SidebarMode } from "../slash-commands/types.js";
import { sourceRank } from "../slash-commands/unified.js";
import { sidebarMcpRowsFromStates, renderMcpRowMarker, type SidebarMcpRow } from "./sidebar-mcp.js";
import { expandAtMentions, filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import {
  appendTextPart,
  appendToolPart,
  compactDisplayMessages,
  contentFromParts,
  snapshotDisplayParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
  toolCallsFromParts,
} from "./display-history.js";
import { createMarkdownSyntaxStyle, createSubtleMarkdownSyntaxStyle } from "./markdown-theme.js";
import { markdownInlineSegments, type MarkdownInlineSegment } from "./markdown-inline.js";
import { hashString } from "./render-signature.js";
import { findToolRenderer } from "./tool-renderers/registry.js";
import { writeToolKey } from "./tool-renderers/write.js";
import {
  discoverModelProviderGroups,
  getVisibleModelProviders,
  localModelsForProvider,
  type ModelProviderGroup,
} from "./model-picker-data.js";
import { formatWritePreview, isWritePreviewTool } from "./tool-renderers/write-preview.js";
import { extractStreamingArgsHint } from "./streaming-tool-args.js";
import { getNextPermissionMode, PERMISSION_MODE_INFO } from "../permission/mode.js";
import { getContextBudget } from "../context/budget.js";
import { getLspService, type LspService, type LspStatus } from "../lsp/index.js";
import { inferBashPrefix, type BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { QuestionAnswer, QuestionController, QuestionPrompt, QuestionRequest } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
import { collectFeedback } from "../feedback/collect.js";
import { submitFeedback, FeedbackSubmitError } from "../feedback/submit.js";
import type { FeedbackPayload } from "../feedback/types.js";
import { createFrames } from "./opencode-spinner.js";
import { copyTextToClipboard } from "./clipboard.js";
import { readGitSidebarState, type SidebarFileChange, type SidebarGitState } from "./sidebar-state.js";
import {
  buildImageContentPartsFromLabels,
  extractImagePathTokens,
  imageAttachmentLabelPattern,
  resolveComposerImagePaths,
  resolveImageInput,
  type ImageAttachment,
} from "./image-paste.js";
import {
  isModeCycleKeyEvent,
  isModeCycleSequence,
  isModifiedEnterSequence,
  PROMPT_TEXTAREA_KEYBINDINGS,
} from "./prompt-keybindings.js";
import { keyNameFromEvent, keyNameFromSequence } from "./global-key-router.js";
import { EscapeConfirmationGate } from "./escape-confirmation.js";
import type { ResolvedTheme } from "./detect-theme.js";
import { appendHistoryEntry, loadHistorySync, pushHistoryEntry } from "./input-history.js";
import { buildTraceGroups, traceGroupLabel, type TraceGroup } from "./trace-groups.js";
import { sessionDisplayName } from "./session-display.js";
import {
  bubbleWordmarkForWidth,
  bubbleWordmarkLineText,
  type BubbleWordmarkLine,
  type BubbleWordmarkTone,
} from "./wordmark.js";
import { bootstrapConfig } from "../feishu/config.js";
import { ScopeRegistry } from "../feishu/scope/scope-registry.js";
import type { ScopeConfig } from "../feishu/types.js";

export interface PlanHandlerRef {
  current?: (plan: string) => Promise<PlanDecision>;
}

export interface ApprovalHandlerRef {
  current?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface RunTuiOptions {
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
  /** Legacy dark-palette overrides. Prefer themeOverrides for new callers. */
  theme?: Record<string, string>;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: MemoryScope) => Promise<string>;
  runMemoryRefresh?: (scope?: MemoryScope) => Promise<string>;
}

type RawGlobalKeyHandler = (sequence: string) => boolean;
type RawMouseSelectionHandler = (event: { type: string; button: number; x: number; y: number }) => void;
type CopyToastVariant = "info" | "success" | "warning" | "error";
type CopyToastState = { title?: string; message: string; variant: CopyToastVariant };
type ModalKeyOwner = "approval" | "question" | "feedback" | "stats" | "provider" | "feishu" | "picker";
type QueuedComposerInput = { input: string; displayId?: string };
type PendingSteerInput = { id: string; input: string; displayId: string };
type ActiveAgentRun = { id: number; abortController: AbortController; inputController: AgentRunInputQueue };

const treeSitterClient = getTreeSitterClient();
const PROMPT_HISTORY_LIMIT = 100;
const ESC_CANCEL_CONFIRM_WINDOW_MS = 1800;

const PROVIDER_PRIORITY = new Map<string, number>([
  ["openai", 0],
  ["deepseek", 1],
  ["google", 2],
  ["zhipuai", 3],
  ["zhipuai-coding-plan", 4],
  ["zai", 5],
  ["zai-coding-plan", 6],
  ["kimi-for-coding", 7],
]);

const DEFAULT_THEME = {
  primary: "#fab283",
  accent: "#9d7cd8",
  secondary: "#5c9cf5",
  info: "#56b6c2",
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  border: "#484848",
  borderSubtle: "#3c3c3c",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  messageUserText: "#d7e8ff",
  messageUserBorder: "#5c9cf5",
  messageAssistantText: "#eeeeee",
  messageAssistantAccent: "#fab283",
  messageThinkingText: "#8b949e",
  messageThinkingContentText: "#6e7681",
  messageThinkingBorder: "#282828",
  toolText: "#a6acb8",
  toolPending: "#fab283",
  toolSuccess: "#7fd88f",
  toolError: "#e06c75",
  toolShell: "#56b6c2",
  toolRead: "#9d7cd8",
  toolWrite: "#f5a742",
  toolSearch: "#5c9cf5",
  diffAdded: "#7fd88f",
  diffRemoved: "#e06c75",
  diffContext: "#a6acb8",
  diffAddedBg: "#1d3424",
  diffRemovedBg: "#3a1f24",
  diffContextBg: "#1e1e1e",
  diffLineNumber: "#808080",
  diffAddedLineNumberBg: "#24412d",
  diffRemovedLineNumberBg: "#47272d",
  diffHighlightAdded: "#98f5a8",
  diffHighlightRemoved: "#ff8b96",
};

const LIGHT_THEME: typeof DEFAULT_THEME = {
  primary: "#356FD2",
  accent: "#8B4A00",
  secondary: "#6F55AE",
  info: "#257E8A",
  text: "#171717",
  textMuted: "#6F7377",
  background: "#FCFCFA",
  backgroundPanel: "#F6F6F3",
  backgroundElement: "#ECEDEA",
  border: "#B9BDB8",
  borderSubtle: "#D7DAD4",
  error: "#B62633",
  warning: "#8B4A00",
  success: "#2F7D4A",
  messageUserText: "#234B93",
  messageUserBorder: "#356FD2",
  messageAssistantText: "#171717",
  messageAssistantAccent: "#8B4A00",
  messageThinkingText: "#5F666D",
  messageThinkingContentText: "#6F7377",
  messageThinkingBorder: "#D7DAD4",
  toolText: "#495057",
  toolPending: "#8B4A00",
  toolSuccess: "#2F7D4A",
  toolError: "#B62633",
  toolShell: "#257E8A",
  toolRead: "#6F55AE",
  toolWrite: "#8B4A00",
  toolSearch: "#356FD2",
  diffAdded: "#1E725C",
  diffRemoved: "#B62633",
  diffContext: "#6F7377",
  diffAddedBg: "#D7E8D8",
  diffRemovedBg: "#F7DADC",
  diffContextBg: "#F6F6F3",
  diffLineNumber: "#6F7377",
  diffAddedLineNumberBg: "#C6DCC8",
  diffRemovedLineNumberBg: "#EAC8CC",
  diffHighlightAdded: "#2F7D4A",
  diffHighlightRemoved: "#D12D55",
};

const LOCAL_SLASH_COMMANDS = [
  {
    name: "thinking",
    description: "Toggle thinking block visibility",
  },
  {
    name: "toggle-thinking",
    description: "Toggle thinking block visibility",
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

let theme = DEFAULT_THEME;

const HOME_PROMPTS = [
  "Fix a TODO in the codebase",
  "What is the tech stack of this project?",
  "Find the highest-risk bug in this repo",
  "Explain how this feature is wired",
];

const PROMPT_SCANNER_IDLE_FRAMES = ["        "];
const PROMPT_SCANNER_INTERVAL_MS = 80;
const SESSION_SIDEBAR_WIDTH = 42;
const SESSION_SIDEBAR_AUTO_WIDTH = 120;
const PROVIDER_DIALOG_ROWS = 11;
const QUESTION_MAX_TABS = 4;
const QUESTION_MAX_OPTIONS = 10;
const QUESTION_MAX_CONFIRM_ROWS = 3;
const QUESTION_PANEL_MIN_HEIGHT = 9;
const FEISHU_SETUP_EMPTY_VALUES: FeishuSetupValues = { chatId: "", cwd: "", displayName: "" };

function homeLogoColor(tone: BubbleWordmarkTone) {
  switch (tone) {
    case "brand": return theme.warning;
    case "ink": return theme.text;
    case "stone": return theme.textMuted;
    case "soft": return theme.borderSubtle;
    case "caption": return theme.textMuted;
  }
}

function renderHomeLogoLine(line: BubbleWordmarkLine, width?: number) {
  const text = bubbleWordmarkLineText(line) || " ";
  const pad = width === undefined ? "" : " ".repeat(Math.max(0, Math.floor((width - text.length) / 2)));
  if (!line.segments) {
    return h("text", { fg: homeLogoColor(line.tone ?? "caption"), wrapMode: "none" }, `${pad}${text}`);
  }
  const chunks = [];
  if (pad) chunks.push(fg(theme.text)(pad));
  for (const segment of line.segments) {
    chunks.push(fg(homeLogoColor(segment.tone))(segment.text));
  }
  return h("text", { wrapMode: "none" },
    new StyledText(chunks),
  );
}

const HOME_TIPS = [
  "Type @ followed by a filename to attach file context",
  "Press Shift+Tab to cycle Build, Plan, and Bypass modes",
  "Type / or press Ctrl+P to open commands",
  "Use /compact to summarize long sessions near context limits",
  "Shift+Enter or Ctrl+J inserts a newline in your prompt",
];

type Child = any;
type PromptScannerSync = (running: boolean) => void;
type SidebarUsageState = {
  contextTokens: number;
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  reasoningTokens: number;
  turns: number;
};
type PickerMode = "model" | "key" | "provider" | "provider-add" | "provider-auth" | "login" | "logout" | "skill" | "slash" | "file" | "mcp-reconnect" | "feishu-setup";
type PickerItem = {
  label: string;
  detail?: string;
  value: string;
  command: string;
  action?: "insert-skill";
  next?: "auth" | "key";
  after?: { mode: "model"; providerId: string };
  category?: string;
  gutter?: string;
  footer?: string;
};
type ProviderDialogStep = "providers" | "auth" | "key" | "models" | "skills";
type ProviderDialogState = {
  step: ProviderDialogStep;
  providerId?: string;
  query: string;
  index: number;
  apiKey: string;
  error?: string;
};
type StatsPanelState = {
  range: StatsRange;
  bundle: UsageStatsBundle;
};
type QuestionPanelState = {
  request: QuestionRequest;
  tab: number;
  selected: number;
  answers: QuestionAnswer[];
  custom: string[];
  editing: boolean;
};
type FeedbackPanelState = {
  base: Omit<FeedbackPayload, "description">;
  description: string;
  stage: "edit" | "submitting" | "done";
  showPreview: boolean;
  status?: string;
  result?:
    | { kind: "success"; url: string; number: number }
    | { kind: "error"; message: string };
};
type FeishuSetupField = "chatId" | "cwd" | "displayName";
type FeishuSetupValues = Record<FeishuSetupField, string>;
type FeishuSetupStage =
  | { kind: "registering" }
  | { kind: "qr_shown"; url: string; ascii: string; status: string }
  | { kind: "credentialed"; ownerOpenId: string }
  | { kind: "binding"; ownerOpenId: string; field: FeishuSetupField; values: FeishuSetupValues; error?: string }
  | { kind: "error"; message: string };
type ProviderDialogRow =
  | { type: "category"; label: string }
  | { type: "empty"; label: string; detail?: string }
  | { type: "item"; item: PickerItem; optionIndex: number };
type PickerState =
  | {
      kind: "select";
      mode: Exclude<PickerMode, "key">;
      title: string;
      items: PickerItem[];
      index: number;
      loading?: boolean;
      query?: string;
      allItems?: PickerItem[];
      meta?: Record<string, unknown>;
    }
  | {
      kind: "key";
      title: string;
      providerId?: string;
      previous?: Extract<PickerState, { kind: "select" }>;
      after?: { mode: "model"; providerId: string };
    };

function h(tag: string | ((props: any) => any), props?: Record<string, any> | null, ...children: Child[]) {
  const allProps = props ?? {};
  const childList = children.length > 0 ? children : allProps.children !== undefined ? [allProps.children] : [];
  if (typeof tag === "function") {
    return createComponent(tag as any, {
      ...allProps,
      children: childList.length === 1 ? childList[0] : childList,
    });
  }
  const element = createElement(tag);
  const { children: _children, ...rest } = allProps;
  spread(element, rest, false);
  if (childList.length === 1) insert(element, childList[0]);
  else if (childList.length > 1) insert(element, childList);
  return element;
}

function isDestroyedRenderable(ref: Renderable | undefined): boolean {
  return !ref || (ref as any).isDestroyed === true;
}

function safeRequestRender(ref: Renderable | undefined): boolean {
  if (!ref || isDestroyedRenderable(ref)) return false;
  try {
    ref.requestRender();
    return true;
  } catch {
    return false;
  }
}

function safeSetText(ref: TextRenderable | undefined, content: string | StyledText): boolean {
  if (!ref || isDestroyedRenderable(ref)) return false;
  try {
    ref.content = content;
    ref.requestRender();
    return true;
  } catch {
    return false;
  }
}

export async function runTui(agent: Agent, args: CliArgs, options: RunTuiOptions = {}) {
  return new Promise<void>(async (resolve, reject) => {
    let renderer: CliRenderer | undefined;
    let syntaxStyle: SyntaxStyle | undefined;
    let subtleSyntaxStyle: SyntaxStyle | undefined;
    let rawGlobalKeyHandler: RawGlobalKeyHandler | undefined;
    let rawMouseSelectionHandler: RawMouseSelectionHandler | undefined;
    const exit = () => {
      try {
        renderer?.destroy();
      } finally {
        syntaxStyle?.destroy();
        subtleSyntaxStyle?.destroy();
        if (process.stdout.isTTY) {
          process.stdout.write("\n");
        }
        resolve();
      }
    };

    try {
      theme = resolveTheme({
        mode: resolvedThemeMode(options.themeMode, options.detectedTheme),
        overrides: options.themeOverrides ?? options.theme,
      });
      syntaxStyle = createMarkdownSyntaxStyle(theme);
      subtleSyntaxStyle = createSubtleMarkdownSyntaxStyle(theme);
      renderer = await createCliRenderer({
        externalOutputMode: "passthrough",
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        useKittyKeyboard: {},
        prependInputHandlers: [
          (sequence: string) => rawGlobalKeyHandler?.(sequence) || false,
        ],
        autoFocus: true,
        useMouse: true,
        openConsoleOnError: false,
        backgroundColor: theme.background,
      });
      const setRawGlobalKeyHandler = (handler: RawGlobalKeyHandler | undefined) => {
        rawGlobalKeyHandler = handler;
      };
      const setRawMouseSelectionHandler = (handler: RawMouseSelectionHandler | undefined) => {
        rawMouseSelectionHandler = handler;
      };
      const processSingleMouseEvent = (renderer as any).processSingleMouseEvent;
      if (typeof processSingleMouseEvent === "function") {
        (renderer as any).processSingleMouseEvent = (event: { type: string; button: number; x: number; y: number }) => {
          const handled = processSingleMouseEvent.call(renderer, event);
          if (handled) rawMouseSelectionHandler?.(event);
          return handled;
        };
      }
      await render(() => h(OpenTuiApp, { agent, args, options, onExit: exit, syntaxStyle, subtleSyntaxStyle, setRawGlobalKeyHandler, setRawMouseSelectionHandler }), renderer);
    } catch (error) {
      syntaxStyle?.destroy();
      subtleSyntaxStyle?.destroy();
      reject(error);
    }
  });
}

function resolveTheme(options?: {
  mode?: ResolvedTheme;
  overrides?: Record<string, string>;
}) {
  const next = { ...(options?.mode === "light" ? LIGHT_THEME : DEFAULT_THEME) };
  const overrides = options?.overrides;
  if (!overrides) return next;
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in next)) continue;
    if (!isColorValue(value)) continue;
    (next as Record<string, string>)[key] = value;
  }
  return next;
}

function resolvedThemeMode(mode: ThemeMode | undefined, detectedTheme: ResolvedTheme | undefined): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  return detectedTheme ?? "dark";
}

function isColorValue(value: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value)
    || /^#[0-9a-fA-F]{8}$/.test(value)
    || value === "transparent"
    || value === "none";
}

function initialPromptHistory(displayMessages: DisplayMessage[]): string[] {
  let history = loadHistorySync();
  for (const message of displayMessages) {
    if (message.role !== "user" || message.content === "(multimedia)") continue;
    history = pushHistoryEntry(history, message.content);
  }
  return history.slice(-PROMPT_HISTORY_LIMIT);
}

function annotateLastTaskDuration(messages: DisplayMessage[], elapsedMs: number): DisplayMessage[] {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const next = messages.slice();
    next[index] = { ...message, taskElapsedMs: elapsedMs };
    return next;
  }
  return messages;
}

function OpenTuiApp(props: {
  agent: Agent;
  args: CliArgs;
  options: RunTuiOptions;
  onExit: () => void;
  syntaxStyle: SyntaxStyle;
  subtleSyntaxStyle: SyntaxStyle;
  setRawGlobalKeyHandler?: (handler: RawGlobalKeyHandler | undefined) => void;
  setRawMouseSelectionHandler?: (handler: RawMouseSelectionHandler | undefined) => void;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const registry = props.options.registry!;
  const skills = props.options.skillRegistry!;
  let activeThemeMode: ThemeMode = props.options.themeMode ?? "dark";
  const autoResolvedTheme: ResolvedTheme = props.options.detectedTheme ?? "dark";
  const activeThemeOverrides = () => props.options.themeOverrides ?? props.options.theme;
  const getActiveResolvedTheme = () => resolvedThemeMode(activeThemeMode, autoResolvedTheme);
  const applyThemeMode = (mode: ThemeMode) => {
    activeThemeMode = mode;
    props.options.onThemeModeChange?.(mode);
    theme = resolveTheme({
      mode: getActiveResolvedTheme(),
      overrides: activeThemeOverrides(),
    });
    syncPromptSurfaces(false);
    syncModelChrome();
    syncModeChrome();
    syncTraceChrome();
    redrawTranscript();
    redrawDock();
    redrawProviderDialog();
    redrawApprovalPanel();
    redrawQuestionPanel();
    redrawStatsPanel();
    redrawFeishuSetupPanel();
    setSidebarTick((tick) => tick + 1);
    renderer.requestRender();
  };
  let exitRequested = false;
  async function requestExit(options: { direct?: boolean } = {}) {
    if (exitRequested) return;
    exitRequested = true;
    if (activeRun && !activeRun.abortController.signal.aborted) {
      activeRun.abortController.abort(new AgentAbortError("Exiting Bubble."));
      activeRun = undefined;
      clearRunningCancelHint();
      setRunningState(false);
    }
    try {
      if (!options.direct) {
        await props.options.flushMemory?.();
      }
    } catch {
      // Memory extraction is best-effort and must not trap the TUI on exit.
    } finally {
      props.onExit();
    }
  }

  let displayMessages = reconstructDisplayMessages(props.agent.messages);
  let queuedDisplayMessages: DisplayMessage[] = [];
  const homeTip = HOME_TIPS[Math.floor(Math.random() * HOME_TIPS.length)] ?? HOME_TIPS[0]!;
  const homePrompt = HOME_PROMPTS[Math.floor(Math.random() * HOME_PROMPTS.length)] ?? HOME_PROMPTS[0]!;
  let promptText = "";
  let promptHistory = initialPromptHistory(displayMessages);
  let nextImageAttachmentIndex = nextImageLabelIndex(displayMessages);
  const pendingImageAttachments = new Map<string, ImageAttachment>();
  let composerImageResolutionSeq = 0;
  let applyingComposerImageReplacement = false;
  let promptHistoryIndex: number | undefined;
  let promptHistoryDraft = "";
  const [isRunning, setIsRunning] = createSignal(false);
  let activeRun: ActiveAgentRun | undefined;
  let nextRunId = 0;
  let nextQueuedDisplayId = 0;
  let pendingSteerInputs: PendingSteerInput[] = [];
  let rejectedSteerInputs: QueuedComposerInput[] = [];
  let queuedComposerInputs: QueuedComposerInput[] = [];
  let queuedInputDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let drainingQueuedInput = false;
  const [queuedInputCount, setQueuedInputCount] = createSignal(0);
  const [pendingSteerCount, setPendingSteerCount] = createSignal(0);
  const runningCancelGate = new EscapeConfirmationGate(ESC_CANCEL_CONFIRM_WINDOW_MS);
  const [runningCancelHint, setRunningCancelHint] = createSignal("");
  let runningCancelHintTimer: ReturnType<typeof setTimeout> | undefined;
  const [showThinking, setShowThinking] = createSignal(false);
  const [verboseTrace, setVerboseTrace] = createSignal(false);
  let streamingDisplay: DisplayMessage | undefined;
  let sidebarLspSyncTimer: ReturnType<typeof setInterval> | undefined;
  const [todos, setTodos] = createSignal<Todo[]>(props.agent.getTodos());
  const [mode, setMode] = createSignal<PermissionMode>(props.agent.mode);
  const [notice, setNotice] = createSignal("");
  let copyToastClearTimer: ReturnType<typeof setTimeout> | undefined;
  let copyToastRoot: BoxRenderable | undefined;
  let copyToastText: TextRenderable | undefined;
  const [sessionActive, setSessionActive] = createSignal(false);
  const [sidebarMode, setSidebarModeState] = createSignal<SidebarMode>("auto");
  const [sidebarTick, setSidebarTick] = createSignal(0);
  // Sidebar MCP section collapsed state. Persisted across sidebarTick bumps,
  // only reset on actual mount. Collapse toggle exposed when > 2 servers.
  const [mcpSectionOpen, setMcpSectionOpen] = createSignal(true);
  const lspService = props.options.lspService ?? getLspService(props.args.cwd, props.options.settingsManager?.getMerged().lsp);
  const [lspStatuses, setLspStatuses] = createSignal<LspStatus[]>(lspService.status());
  const [sidebarUsage, setSidebarUsage] = createSignal<SidebarUsageState>({
    contextTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    reasoningTokens: 0,
    turns: 0,
  });
  const [gitState, setGitState] = createSignal<SidebarGitState>({ files: [] });
  let uiDisposed = false;
  const [pendingPlan, setPendingPlan] = createSignal<{
    plan: string;
    resolve: (decision: PlanDecision) => void;
  }>();
  const [pendingApproval, setPendingApproval] = createSignal<{
    request: ApprovalRequest;
    resolve: (decision: ApprovalDecision) => void;
  }>();
  const [pendingQuestion, setPendingQuestion] = createSignal<QuestionPanelState>();
  const [pendingFeedback, setPendingFeedback] = createSignal<FeedbackPanelState>();
  const [pendingFeishuSetup, setPendingFeishuSetup] = createSignal<FeishuSetupStage>();
  let statsPanel: StatsPanelState | undefined;
  const questionSyncTimers = new Set<ReturnType<typeof setTimeout>>();
  let feishuSetupAbortController: AbortController | undefined;
  let pendingApprovalRef: { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void } | undefined;
  const PLAN_OPTIONS = ["Approve", "Reject"] as const;
  const [approvalOptionIdx, setApprovalOptionIdx] = createSignal(0);
  let picker: PickerState | undefined;
  let providerDialog: ProviderDialogState | undefined;
  let providerDialogModelItems: { key: string; items: PickerItem[] } | undefined;
  let providerDialogModelRefreshId = 0;
  let previousPickerForKey: Extract<PickerState, { kind: "select" }> | undefined;
  let homePromptRef: TextareaRenderable | undefined;
  let sessionPromptRef: TextareaRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  let transcriptScrollFollowing = true;
  let transcriptScrollInitialized = false;
  let rootBox: BoxRenderable | undefined;
  let sidebarShell: BoxRenderable | undefined;
  let homeSurfaceShell: BoxRenderable | undefined;
  let transcriptHost: BoxRenderable | undefined;
  const transcriptState: TranscriptState = {
    entries: [],
    expandedCompactions: new Set(),
    expandedWrites: new Set(),
    defaultWritesExpanded: false,
  };
  let dock: TextRenderable | undefined;
  let homeComposerShell: BoxRenderable | undefined;
  let sessionComposerShell: BoxRenderable | undefined;
  const promptScannerSyncs = new Set<PromptScannerSync>();
  let approvalRoot: BoxRenderable | undefined;
  let approvalHeaderTitle: TextRenderable | undefined;
  let approvalMetaIcon: TextRenderable | undefined;
  let approvalMetaTitle: TextRenderable | undefined;
  let approvalSubtitle: TextRenderable | undefined;
  let approvalPreviewScroll: ScrollBoxRenderable | undefined;
  let approvalPreviewText: TextRenderable | undefined;
  let approvalPreviewDiff: DiffRenderable | undefined;
  let questionCustomInput: TextareaRenderable | undefined;
  const approvalOptionBoxes: Array<BoxRenderable | undefined> = [];
  const approvalOptionTexts: Array<TextRenderable | undefined> = [];
  let questionRoot: BoxRenderable | undefined;
  let questionTabsRow: BoxRenderable | undefined;
  const questionTabBoxes: Array<BoxRenderable | undefined> = [];
  const questionTabTexts: Array<TextRenderable | undefined> = [];
  let questionPromptText: TextRenderable | undefined;
  let questionOptionsShell: BoxRenderable | undefined;
  const questionOptionRows: Array<BoxRenderable | undefined> = [];
  const questionOptionIndexTexts: Array<TextRenderable | undefined> = [];
  const questionOptionLabelTexts: Array<TextRenderable | undefined> = [];
  const questionOptionDescriptionTexts: Array<TextRenderable | undefined> = [];
  const questionOptionCheckTexts: Array<TextRenderable | undefined> = [];
  let questionCustomEditorShell: BoxRenderable | undefined;
  let questionConfirmShell: BoxRenderable | undefined;
  const questionConfirmTexts: Array<TextRenderable | undefined> = [];
  let questionFooterTab: TextRenderable | undefined;
  let questionFooterSelect: TextRenderable | undefined;
  let questionFooterEnter: TextRenderable | undefined;
  let questionFooterEsc: TextRenderable | undefined;
  let feedbackRoot: BoxRenderable | undefined;
  let feedbackInput: TextareaRenderable | undefined;
  let feedbackMetaText: TextRenderable | undefined;
  let feedbackStatusText: TextRenderable | undefined;
  let feedbackPreviewShell: BoxRenderable | undefined;
  let feedbackPreviewText: TextRenderable | undefined;
  let feedbackFooterText: TextRenderable | undefined;
  let statsRoot: BoxRenderable | undefined;
  let statsPanelBox: BoxRenderable | undefined;
  let statsTitle: TextRenderable | undefined;
  let statsEsc: TextRenderable | undefined;
  let statsTab7Box: BoxRenderable | undefined;
  let statsTab30Box: BoxRenderable | undefined;
  let statsTab7Text: TextRenderable | undefined;
  let statsTab30Text: TextRenderable | undefined;
  let statsBodyScroll: ScrollBoxRenderable | undefined;
  let statsBodyText: TextRenderable | undefined;
  let statsFooterText: TextRenderable | undefined;
  let feishuSetupRoot: BoxRenderable | undefined;
  let feishuSetupPanel: BoxRenderable | undefined;
  let feishuSetupTitle: TextRenderable | undefined;
  let feishuSetupHint: TextRenderable | undefined;
  let feishuSetupBodyScroll: ScrollBoxRenderable | undefined;
  let feishuSetupBodyText: TextRenderable | undefined;
  let feishuSetupInputShell: BoxRenderable | undefined;
  let feishuSetupInput: InputRenderable | undefined;
  let feishuSetupFooterText: TextRenderable | undefined;
  let pickerFrame: BoxRenderable | undefined;
  let selectList: SelectRenderable | undefined;
  const inlinePickerRows: Array<BoxRenderable | undefined> = [];
  const inlinePickerLabels: Array<TextRenderable | undefined> = [];
  const inlinePickerDetails: Array<TextRenderable | undefined> = [];
  let providerDialogRoot: BoxRenderable | undefined;
  let providerDialogPanel: BoxRenderable | undefined;
  let providerDialogTitle: TextRenderable | undefined;
  let providerDialogEsc: TextRenderable | undefined;
  let providerDialogInput: InputRenderable | undefined;
  let providerDialogList: BoxRenderable | undefined;
  let providerDialogFooter: TextRenderable | undefined;
  const providerDialogRows: Array<BoxRenderable | undefined> = [];
  const providerDialogGutters: Array<TextRenderable | undefined> = [];
  const providerDialogLabels: Array<TextRenderable | undefined> = [];
  const providerDialogDetails: Array<TextRenderable | undefined> = [];
  const providerDialogFooters: Array<TextRenderable | undefined> = [];
  const promptModeLabels = new Set<TextRenderable>();
  const promptModelLabels = new Set<TextRenderable>();
  let footerModeBadge: TextRenderable | undefined;
  let footerTraceBadge: TextRenderable | undefined;
  let sidebarTokenText: TextRenderable | undefined;
  let sidebarPercentText: TextRenderable | undefined;
  let sidebarGaugeText: TextRenderable | undefined;
  let sidebarGaugeLabelText: TextRenderable | undefined;
  let sidebarUsageText: TextRenderable | undefined;
  let sidebarReasoningText: TextRenderable | undefined;
  let sidebarCostText: TextRenderable | undefined;
  let sidebarLspSummaryText: TextRenderable | undefined;
  const sidebarLspRows: Array<BoxRenderable | undefined> = [];
  const sidebarLspMarkers: Array<TextRenderable | undefined> = [];
  const sidebarLspLabels: Array<TextRenderable | undefined> = [];
  let sidebarTodoSection: BoxRenderable | undefined;
  const sidebarTodoRows: Array<BoxRenderable | undefined> = [];
  const sidebarTodoMarkers: Array<TextRenderable | undefined> = [];
  const sidebarTodoLabels: Array<TextRenderable | undefined> = [];
  const sidebarFileRows: Array<BoxRenderable | undefined> = [];
  const sidebarFileLabels: Array<TextRenderable | undefined> = [];
  const sidebarFileAdditions: Array<TextRenderable | undefined> = [];
  const sidebarFileDeletions: Array<TextRenderable | undefined> = [];
  let sidebarFileSection: BoxRenderable | undefined;

  const activePrompt = () =>
    isHomeSurfaceActive()
      ? homePromptRef ?? sessionPromptRef
      : sessionPromptRef ?? homePromptRef;

  function setPromptText(value: string) {
    promptText = value;
    const prompt = activePrompt();
    if (!prompt) return;
    prompt.setText(value);
    prompt.cursorOffset = value.length;
    prompt.focus();
  }

  function resetPromptHistoryBrowse() {
    promptHistoryIndex = undefined;
    promptHistoryDraft = "";
  }

  function rememberPromptHistory(input: string) {
    const value = input.trimEnd();
    if (!value.trim()) return;
    const nextHistory = pushHistoryEntry(promptHistory, value);
    if (nextHistory !== promptHistory) {
      appendHistoryEntry(value);
      promptHistory = nextHistory.length > PROMPT_HISTORY_LIMIT
        ? nextHistory.slice(-PROMPT_HISTORY_LIMIT)
        : nextHistory;
    }
    resetPromptHistoryBrowse();
  }

  function canBrowsePromptHistory(direction: "up" | "down") {
    if (promptHistoryIndex !== undefined) return true;
    const prompt = activePrompt();
    const text = prompt?.plainText ?? promptText;
    if (!text) return true;
    const cursor = prompt?.logicalCursor;
    if (!cursor) return true;
    if (direction === "up") return cursor.row === 0;
    return cursor.row >= text.split("\n").length - 1;
  }

  function browsePromptHistory(direction: "up" | "down") {
    if (!promptHistory.length) return false;
    if (!canBrowsePromptHistory(direction)) return false;

    if (direction === "up") {
      if (promptHistoryIndex === undefined) {
        promptHistoryDraft = readPromptText() || promptText;
        promptHistoryIndex = promptHistory.length - 1;
      } else {
        promptHistoryIndex = Math.max(0, promptHistoryIndex - 1);
      }
      setPromptText(promptHistory[promptHistoryIndex] ?? "");
      return true;
    }

    if (promptHistoryIndex === undefined) return false;
    if (promptHistoryIndex < promptHistory.length - 1) {
      promptHistoryIndex += 1;
      setPromptText(promptHistory[promptHistoryIndex] ?? "");
    } else {
      setPromptText(promptHistoryDraft);
      resetPromptHistoryBrowse();
    }
    return true;
  }

  function handlePromptHistoryKey(event: any) {
    if (event.shift || event.ctrl || event.meta || event.super || event.hyper) return false;
    const name = keyNameFromEvent(event);
    if (name !== "up" && name !== "down") return false;
    if (!browsePromptHistory(name)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }

  function blurInputsForModal() {
    homePromptRef?.blur();
    sessionPromptRef?.blur();
    questionCustomInput?.blur();
    providerDialogInput?.blur();
    feedbackInput?.blur();
    feishuSetupInput?.blur();
  }

  function focusApprovalPanel() {
    setTimeout(() => {
      if (pendingApproval() || pendingPlan()) approvalRoot?.focus();
    }, 0);
  }

  function focusQuestionPanel() {
    setTimeout(() => {
      const state = pendingQuestion();
      if (!state || state.editing) return;
      questionRoot?.focus();
    }, 0);
  }

  function focusFeedbackPanel() {
    setTimeout(() => {
      const state = pendingFeedback();
      if (!state) return;
      if (state.stage === "edit") {
        feedbackInput?.focus();
        return;
      }
      feedbackRoot?.focus();
    }, 0);
  }

  function focusStatsPanel() {
    setTimeout(() => {
      if (statsPanel) statsRoot?.focus();
    }, 0);
  }

  function focusFeishuSetupPanel() {
    setTimeout(() => {
      const state = pendingFeishuSetup();
      if (!state) return;
      if (state.kind === "binding") {
        feishuSetupInput?.focus();
        return;
      }
      feishuSetupRoot?.focus();
    }, 0);
  }

  function restorePromptAfterModal() {
    setTimeout(() => {
      if (!activeModalKeyOwner()) activePrompt()?.focus();
    }, 0);
  }

  const activeComposerShell = () =>
    isHomeSurfaceActive()
      ? homeComposerShell ?? sessionComposerShell
      : sessionComposerShell ?? homeComposerShell;

  onCleanup(() => {
    uiDisposed = true;
    if (copyToastClearTimer) clearTimeout(copyToastClearTimer);
    if (runningCancelHintTimer) clearTimeout(runningCancelHintTimer);
    if (queuedInputDrainTimer) clearTimeout(queuedInputDrainTimer);
    feishuSetupAbortController?.abort();
    promptModeLabels.clear();
    promptModelLabels.clear();
    footerModeBadge = undefined;
  });

  function showCopyToast(toast: CopyToastState, ttl = 2200) {
    if (copyToastClearTimer) clearTimeout(copyToastClearTimer);
    const sidebarOffset = sidebarVisible() ? SESSION_SIDEBAR_WIDTH : 0;
    const mainAreaWidth = Math.max(20, dimensions().width - sidebarOffset - 4);
    const color = toast.variant === "success"
      ? theme.success
      : toast.variant === "error"
        ? theme.error
        : toast.variant === "warning"
          ? theme.warning
          : theme.info;
    const width = Math.max(24, Math.min(60, Math.min(mainAreaWidth, toast.message.length + 6)));
    if (copyToastRoot) {
      copyToastRoot.visible = true;
      copyToastRoot.width = width;
      copyToastRoot.right = sidebarOffset + 2;
      copyToastRoot.borderColor = color;
    }
    if (copyToastText) {
      copyToastText.fg = theme.text;
      safeSetText(copyToastText, toast.message);
    }
    renderer.requestRender();
    copyToastClearTimer = setTimeout(() => {
      if (copyToastRoot) copyToastRoot.visible = false;
      renderer.requestRender();
      copyToastClearTimer = undefined;
    }, ttl);
  }

  async function copySelectionText(text: string) {
    const now = Date.now();
    if (!text.trim()) return;
    if (text === lastCopiedSelection && now - lastCopiedSelectionAt < 350) return;
    const serial = ++selectionCopySerial;
    let copied = false;
    try {
      await copyTextToClipboard(text);
      copied = true;
    } catch {
      try {
        copied = renderer.copyToClipboardOSC52(text);
      } catch {
        copied = false;
      }
    }
    if (serial !== selectionCopySerial) return;
    if (copied) {
      lastCopiedSelection = text;
      lastCopiedSelectionAt = Date.now();
      showCopyToast({ message: "Copied to clipboard", variant: "info" });
    } else {
      showCopyToast({ message: "Failed to copy selection", variant: "error" }, 3000);
    }
  }

  function isInsideRenderable(renderable: any, container: Renderable | undefined) {
    if (!container) return false;
    let current = renderable;
    while (current) {
      if (current === container) return true;
      current = current.parent;
    }
    return false;
  }

  function getOpenTuiSelectionText(selection: any) {
    const selectedRenderables = Array.isArray(selection?.selectedRenderables)
      ? [...selection.selectedRenderables]
      : undefined;
    if (!selectedRenderables?.length) {
      return typeof selection?.getSelectedText === "function" ? selection.getSelectedText() : "";
    }

    return selectedRenderables
      .filter((renderable) => !renderable.isDestroyed && !isInsideRenderable(renderable, sidebarShell))
      .sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      })
      .map((renderable) => typeof renderable.getSelectedText === "function" ? renderable.getSelectedText() : "")
      .filter(Boolean)
      .join("\n");
  }

  const readPromptText = () => {
    try {
      return activePrompt()?.plainText ?? "";
    } catch {
      return "";
    }
  };

  const isTrackedShiftReturn = (event: any) => {
    const name = String(event.name || "").toLowerCase();
    if (name !== "return" && name !== "enter") return false;
    return !!event.shift;
  };

  const canInsertPromptNewline = () => !pendingApproval() && !pendingPlan() && !pendingQuestion() && !pendingFeedback() && !statsPanel && !pendingFeishuSetup();

  const sidebarFits = () => dimensions().width > SESSION_SIDEBAR_WIDTH + 40;
  const sidebarVisible = () => {
    if (!sessionActive()) return false;
    const preference = sidebarMode();
    if (preference === "collapsed") return false;
    if (preference === "expanded") return sidebarFits();
    return dimensions().width > SESSION_SIDEBAR_AUTO_WIDTH;
  };
  const contentWidth = () => Math.max(20, dimensions().width - (sidebarVisible() ? SESSION_SIDEBAR_WIDTH : 0) - 4);
  const bumpSidebar = () => {
    setSidebarTick((value) => value + 1);
    syncSidebarContext();
  };
  const syncTodosFromAgent = () => {
    const nextTodos = props.agent.getTodos();
    setTodos(nextTodos);
    syncSidebarTodos(nextTodos);
    bumpSidebar();
  };

  function refreshGitSidebar() {
    setGitState(readGitSidebarState(props.args.cwd));
    syncSidebarFiles();
    bumpSidebar();
  }

  function syncSidebarChrome() {
    const visible = sidebarVisible();
    if (sidebarShell) {
      sidebarShell.visible = visible;
      (sidebarShell as any).width = visible ? SESSION_SIDEBAR_WIDTH : 0;
      sidebarShell.requestRender();
    }
    rootBox?.requestRender();
  }

  function currentSidebarCommandState(): SidebarCommandState {
    return {
      mode: sidebarMode(),
      visible: sidebarVisible(),
      active: sessionActive(),
    };
  }

  function applySidebarMode(next: SidebarMode): SidebarCommandState {
    setSidebarModeState(next);
    syncSidebarChrome();
    renderTranscriptNow(streamingDisplay, displayMessages);
    redrawDock();
    renderer.requestRender();
    return currentSidebarCommandState();
  }

  function toggleSidebar(): SidebarCommandState {
    return applySidebarMode(sidebarVisible() ? "collapsed" : "expanded");
  }

  function setSidebarText(ref: TextRenderable | undefined, content: string) {
    if (!ref) return;
    ref.content = content;
    ref.requestRender();
  }

  function syncSidebarContext() {
    const context = sidebarContextState();
    setSidebarText(sidebarTokenText, `${formatCompactNumber(context.tokens)} tokens`);
    setSidebarText(sidebarPercentText, `${context.percent}% used`);
    if (sidebarGaugeText) {
      sidebarGaugeText.content = buildContextGauge(context.percent, 30);
      sidebarGaugeText.requestRender();
    }
    if (sidebarGaugeLabelText) {
      sidebarGaugeLabelText.content = buildGaugeLabel(context.percent, context.remainingTokens);
      sidebarGaugeLabelText.fg = context.percent >= 80 ? theme.error : context.percent >= 60 ? theme.warning : theme.success;
      sidebarGaugeLabelText.requestRender();
    }
    setSidebarText(sidebarUsageText, context.turns > 0
      ? `${formatCompactNumber(context.promptTokens)} in · ${formatCompactNumber(context.completionTokens)} out`
      : "usage pending");
    setSidebarText(sidebarReasoningText, context.reasoningTokens > 0
      ? `${formatCompactNumber(context.reasoningTokens)} reasoning`
      : "");
    setSidebarText(sidebarCostText, context.costText);
    sidebarShell?.requestRender();
    rootBox?.requestRender();
  }

  function syncSidebarLsp() {
    if (!sidebarLspSummaryText) return;
    const statuses = lspService.status();
    setLspStatuses(statuses);
    if (lspService.isDisabled()) {
      setSidebarText(sidebarLspSummaryText, "LSPs have been disabled in settings");
      showSidebarLspRows([]);
      return;
    }
    if (statuses.length === 0) {
      setSidebarText(sidebarLspSummaryText, "LSPs will activate as files are read");
      showSidebarLspRows([]);
      return;
    }
    const connected = statuses.filter((status) => status.status === "connected").length;
    const starting = statuses.filter((status) => status.status === "starting").length;
    const failed = statuses.filter((status) => status.status === "error").length;
    setSidebarText(sidebarLspSummaryText, [
      connected ? `${connected} active` : "",
      starting ? `${starting} starting` : "",
      failed ? `${failed} error${failed === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(", "));
    showSidebarLspRows(statuses);
  }

  function syncSidebarFiles() {
    const files = gitState().files.slice(0, 8);
    if (sidebarFileSection) {
      sidebarFileSection.visible = files.length > 0;
    }
    for (let index = 0; index < 8; index++) {
      const row = sidebarFileRows[index];
      const label = sidebarFileLabels[index];
      const additions = sidebarFileAdditions[index];
      const deletions = sidebarFileDeletions[index];
      const file = files[index];
      if (!row || !label) continue;
      if (file) {
        row.visible = true;
        label.content = truncate(file.file, 25);
        if (additions) {
          additions.content = `+${file.additions}`;
          additions.visible = file.additions > 0;
        }
        if (deletions) {
          deletions.content = `-${file.deletions}`;
          deletions.visible = file.deletions > 0;
        }
      } else {
        row.visible = false;
      }
      safeRequestRender(row);
    }
    sidebarShell?.requestRender();
  }

  function syncSidebarTodos(nextTodos = todos()) {
    const visible = nextTodos.slice(0, 8);
    if (sidebarTodoSection) {
      sidebarTodoSection.visible = visible.length > 0;
    }
    for (let index = 0; index < 8; index++) {
      const row = sidebarTodoRows[index];
      const marker = sidebarTodoMarkers[index];
      const label = sidebarTodoLabels[index];
      const todo = visible[index];
      if (!row || !marker || !label) continue;
      row.visible = !!todo;
      if (!todo) {
        safeRequestRender(row);
        continue;
      }
      const completed = todo.status === "completed";
      const inProgress = todo.status === "in_progress";
      const labelText = inProgress ? (todo.activeForm || todo.content) : todo.content;
      marker.content = completed ? "✓" : inProgress ? "◉" : "○";
      marker.fg = completed ? theme.success : inProgress ? theme.warning : theme.textMuted;
      label.content = labelText;
      label.fg = completed ? theme.success : inProgress ? theme.warning : theme.textMuted;
      safeRequestRender(row);
    }
    sidebarShell?.requestRender();
    rootBox?.requestRender();
  }

  function showSidebarLspRows(statuses: LspStatus[]) {
    for (let index = 0; index < sidebarLspRows.length; index++) {
      const row = sidebarLspRows[index];
      const marker = sidebarLspMarkers[index];
      const label = sidebarLspLabels[index];
      const status = statuses[index];
      if (!row || !marker || !label) continue;
      row.visible = !!status;
      if (!status) {
        safeRequestRender(row);
        continue;
      }
      marker.fg = status.status === "connected" ? theme.success : status.status === "starting" ? theme.warning : theme.error;
      marker.content = status.status === "connected" ? "*" : status.status === "starting" ? "~" : "!";
      label.content = status.message ? `${status.id} ${status.root} (${status.message})` : `${status.id} ${status.root}`;
      safeRequestRender(row);
    }
    sidebarShell?.requestRender();
    rootBox?.requestRender();
  }

  const promptModeTitle = () => mode() === "plan" ? "Plan" : "Build";
  const promptModeBadge = () => promptModeBadgeContent(mode());
  const footerModeText = () => footerPermissionModeText(mode());
  const effectiveShowThinking = () => showThinking() || verboseTrace();
  const footerTraceText = () => footerTraceModeText(verboseTrace());

  function syncModeChrome() {
    if (uiDisposed) return;
    for (const label of [...promptModeLabels]) {
      if (!safeSetText(label, promptModeBadge())) promptModeLabels.delete(label);
    }
    if (footerModeBadge) {
      footerModeBadge.fg = permissionModeColor(mode());
      if (!safeSetText(footerModeBadge, footerModeText())) footerModeBadge = undefined;
    }
    safeRequestRender(homeComposerShell);
    safeRequestRender(sessionComposerShell);
    safeRequestRender(rootBox);
  }

  function syncTraceChrome() {
    if (uiDisposed) return;
    if (footerTraceBadge) {
      footerTraceBadge.fg = verboseTrace() ? theme.warning : theme.textMuted;
      if (!safeSetText(footerTraceBadge, footerTraceText())) footerTraceBadge = undefined;
    }
    safeRequestRender(rootBox);
  }

  const registerPromptModeLabel = (ref: TextRenderable) => {
    if (uiDisposed) return;
    promptModeLabels.add(ref);
    if (!safeSetText(ref, promptModeBadge())) promptModeLabels.delete(ref);
  };

  const promptModelTitle = () => displayModel(props.agent.model) || "no model";

  const syncModelChrome = () => {
    if (uiDisposed) return;
    for (const label of [...promptModelLabels]) {
      if (!safeSetText(label, promptModelTitle())) promptModelLabels.delete(label);
    }
    safeRequestRender(homeComposerShell);
    safeRequestRender(sessionComposerShell);
    safeRequestRender(rootBox);
  };

  const registerPromptModelLabel = (ref: TextRenderable) => {
    if (uiDisposed) return;
    promptModelLabels.add(ref);
    if (!safeSetText(ref, promptModelTitle())) promptModelLabels.delete(ref);
  };

  const registerFooterModeBadge = (ref: TextRenderable) => {
    if (uiDisposed) return;
    footerModeBadge = ref;
    if (!safeSetText(ref, footerModeText())) footerModeBadge = undefined;
  };

  const registerFooterTraceBadge = (ref: TextRenderable) => {
    if (uiDisposed) return;
    footerTraceBadge = ref;
    ref.fg = verboseTrace() ? theme.warning : theme.textMuted;
    if (!safeSetText(ref, footerTraceText())) footerTraceBadge = undefined;
  };

  const cycleMode = () => {
    if (picker || pendingPlan() || isRunning()) return false;
    const next = getNextPermissionMode(props.agent.mode);
    props.agent.setMode(next);
    setMode(next);
    setNotice(`Mode: ${permissionModeBadgeLabel(next)}`);
    redrawDock();
    syncPromptSurfaces();
    syncModeChrome();
    return true;
  };

  const cycleModeFromKey = (event: any) => {
    if (!isModeCycleKeyEvent(event) || !cycleMode()) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  };

  const cycleModeFromRawSequence = (sequence: string) => {
    if (!isModeCycleSequence(sequence)) return false;
    return cycleMode();
  };

  const isInlinePicker = (state: PickerState | undefined): state is Extract<PickerState, { kind: "select" }> =>
    !!state && state.kind === "select" && (state.mode === "slash" || state.mode === "file");

  const approvalOptionsFor = (request?: ApprovalRequest) => {
    if (!request) return ["Allow once", "Reject"] as const;
    return canPersistApproval(request)
      ? ["Allow once", "Allow always", "Reject"] as const
      : ["Allow once", "Reject"] as const;
  };

  const modalKeyNameFromSequence = (sequence?: string) => {
    const name = keyNameFromSequence(sequence);
    if (name) return name;
    if (sequence === "\t" || sequence === "\x1b[Z") return "tab";
    if (sequence && /^[1-9]$/.test(sequence)) return sequence;
    if (sequence && /^[hjkl]$/i.test(sequence)) return sequence.toLowerCase();
    return "";
  };

  const moveApprovalOption = (direction: -1 | 1, optionCount: number) => {
    const idx = approvalOptionIdx();
    setApprovalOptionIdx((idx + direction + optionCount) % optionCount);
    forceApprovalUI();
  };

  const rejectPendingPlan = (plan: { resolve: (decision: PlanDecision) => void }) => {
    setPendingPlan(undefined);
    setApprovalOptionIdx(0);
    forceApprovalUI();
    restorePromptAfterModal();
    plan.resolve({ action: "reject", reason: "Rejected by user." });
  };

  const resolvePendingPlanSelection = (plan: { plan: string; resolve: (decision: PlanDecision) => void }) => {
    const sel = approvalOptionIdx();
    setPendingPlan(undefined);
    setApprovalOptionIdx(0);
    forceApprovalUI();
    restorePromptAfterModal();
    if (sel === 0) {
      plan.resolve({ action: "approve", plan: plan.plan });
    } else {
      plan.resolve({ action: "reject", reason: "Rejected by user." });
    }
  };

  const canPersistApproval = (request: ApprovalRequest) => {
    if (request.type === "bash") return !!props.options.bashAllowlist || !!props.options.settingsManager;
    return !!props.options.settingsManager;
  };

  const approvalToolName = (request: ApprovalRequest) => {
    switch (request.type) {
      case "bash": return "Bash";
      case "edit": return "Edit";
      case "patch": return "Patch";
      case "write": return "Write";
      case "lsp": return "Lsp";
    }
  };

  const persistApproval = (request: ApprovalRequest) => {
    if (request.type === "bash") {
      const prefix = inferBashPrefix(request.command);
      if (!prefix) return;
      props.options.bashAllowlist?.add(prefix);
      if (props.options.settingsManager) {
        props.options.settingsManager.addRule("local", "allow", `Bash(${prefix}:*)`);
        setNotice(`Saved local allow rule for ${prefix}`);
        return;
      }
      setNotice(`Allowed ${prefix} for the rest of this session`);
      return;
    }

    const settings = props.options.settingsManager;
    if (!settings) return;
    const tool = approvalToolName(request);
    settings.addRule("local", "allow", `${tool}(${request.path})`);
    setNotice(`Saved local allow rule for ${shortCwd(request.path)}`);
  };

  const resolveApprovalSelection = () => {
    const approval = pendingApproval();
    if (!approval) return false;
    const options = approvalOptionsFor(approval.request);
    const sel = Math.min(approvalOptionIdx(), options.length - 1);
    const choice = options[sel];
    pendingApprovalRef = undefined;
    setPendingApproval(undefined);
    setApprovalOptionIdx(0);
    forceApprovalUI();
    restorePromptAfterModal();
    if (choice === "Allow once") {
      approval.resolve({ action: "approve" });
      return true;
    }
    if (choice === "Allow always") {
      persistApproval(approval.request);
      approval.resolve({ action: "approve" });
      return true;
    }
    approval.resolve({ action: "reject", feedback: "Rejected by user." });
    return true;
  };

  const handleApprovalNavigation = (name: string, preventOnly = false, shift = false) => {
    const approval = pendingApproval();
    if (approval) {
      const opts = approvalOptionsFor(approval.request);
      if (name === "left" || name === "up" || name === "h") {
        moveApprovalOption(-1, opts.length);
        return true;
      }
      if (name === "right" || name === "down" || name === "l") {
        moveApprovalOption(1, opts.length);
        return true;
      }
      if (name === "tab") {
        moveApprovalOption(shift ? -1 : 1, opts.length);
        return true;
      }
      if (name === "enter") {
        if (!preventOnly) resolveApprovalSelection();
        return true;
      }
      if (name === "escape") {
        if (!preventOnly) {
          pendingApprovalRef = undefined;
          setPendingApproval(undefined);
          setApprovalOptionIdx(0);
          forceApprovalUI();
          restorePromptAfterModal();
          approval.resolve({ action: "reject", feedback: "Rejected by user." });
        }
        return true;
      }
    }

    const plan = pendingPlan();
    if (plan) {
      if (name === "left" || name === "h") {
        moveApprovalOption(-1, PLAN_OPTIONS.length);
        return true;
      }
      if (name === "right" || name === "l") {
        moveApprovalOption(1, PLAN_OPTIONS.length);
        return true;
      }
      if (name === "tab") {
        moveApprovalOption(shift ? -1 : 1, PLAN_OPTIONS.length);
        return true;
      }
      if (name === "enter") {
        if (!preventOnly) resolvePendingPlanSelection(plan);
        return true;
      }
      if (name === "escape") {
        if (!preventOnly) rejectPendingPlan(plan);
        return true;
      }
    }
    return false;
  };

  const handleApprovalKey = (event: any) => {
    const name = keyNameFromEvent(event);
    if (handleApprovalNavigation(name, false, !!event.shift)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    return false;
  };

  const forceApprovalUI = () => {
    const approval = pendingApproval();
    const plan = pendingPlan();
    syncPromptSurfaces();
    const prompt = activePrompt();
    if (approval || plan) blurInputsForModal();
    if (prompt) {
      if (approval) {
        const options = approvalOptionsFor(approval.request);
        const sel = Math.min(approvalOptionIdx(), options.length - 1);
        prompt.placeholder = `  ⇆ select · enter confirm · esc reject   [${options[sel]}]`;
      } else if (plan) {
        const sel = approvalOptionIdx();
        prompt.placeholder = `  ⇆ select · enter confirm · esc reject   [${PLAN_OPTIONS[sel]}]`;
      } else {
        prompt.placeholder = `Ask anything... "${homePrompt}"`;
      }
    }
    redrawDock();
    redrawApprovalPanel();
    if (approval || plan) focusApprovalPanel();
    redrawTranscript();
  };

  function questionStateFromRequest(request: QuestionRequest): QuestionPanelState {
    return {
      request,
      tab: 0,
      selected: 0,
      answers: request.questions.map(() => []),
      custom: request.questions.map(() => ""),
      editing: false,
    };
  }

  function currentQuestionSessionID() {
    return props.options.sessionManager?.getSessionFile();
  }

  function controllerQuestionRequests() {
    const controller = props.options.questionController;
    if (!controller) return [];
    const sessionID = currentQuestionSessionID();
    const scoped = sessionID ? controller.list(sessionID) : [];
    if (scoped.length > 0) return scoped;
    const all = controller.list();
    return all.length === 1 ? all : [];
  }

  function syncFirstPendingQuestion() {
    const controller = props.options.questionController;
    if (!controller) return;
    const requests = controllerQuestionRequests();
    const current = pendingQuestion();
    if (current && requests.some((request) => request.id === current.request.id)) {
      return;
    }
    const next = requests[0];
    setPendingQuestion(next ? questionStateFromRequest(next) : undefined);
    syncQuestionUI();
  }

  function scheduleQuestionSync() {
    for (const delay of [0, 20, 75, 200, 500]) {
      const timer = setTimeout(() => {
        questionSyncTimers.delete(timer);
        syncFirstPendingQuestion();
      }, delay);
      questionSyncTimers.add(timer);
    }
  }

  function transcriptMaxScrollTop() {
    if (!scrollbox) return 0;
    return Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
  }

  function isTranscriptAtBottom() {
    if (!scrollbox) return true;
    return scrollbox.scrollTop >= transcriptMaxScrollTop() - 1;
  }

  function updateTranscriptScrollFollowingFromPosition() {
    if (!scrollbox) return;
    transcriptScrollFollowing = isTranscriptAtBottom();
    transcriptScrollInitialized = true;
  }

  function shouldFollowTranscriptBeforeUpdate() {
    if (!scrollbox) return transcriptScrollFollowing;
    if (!transcriptScrollInitialized) return true;
    transcriptScrollFollowing = isTranscriptAtBottom();
    return transcriptScrollFollowing;
  }

  function scrollTranscriptToBottom() {
    if (!scrollbox) return;
    scrollbox.scrollTo(scrollbox.scrollHeight);
    transcriptScrollFollowing = true;
    transcriptScrollInitialized = true;
  }

  function scheduleTranscriptScrollAfterUpdate(shouldFollow: boolean, delay = 50) {
    setTimeout(() => {
      if (!scrollbox) return;
      if (shouldFollow && transcriptScrollFollowing) {
        scrollTranscriptToBottom();
      } else {
        updateTranscriptScrollFollowingFromPosition();
      }
    }, delay);
  }

  function handleTranscriptMouseScroll() {
    setTimeout(updateTranscriptScrollFollowingFromPosition, 0);
  }

  function syncQuestionUI(focusCustom = false) {
    redrawQuestionPanel();
    syncPromptSurfaces();
    const question = pendingQuestion();
    if (question) blurInputsForModal();
    redrawDock();
    rootBox?.requestRender();
    scrollbox?.requestRender();
    if (focusCustom) {
      setTimeout(() => questionCustomInput?.focus(), 0);
    } else if (question) {
      focusQuestionPanel();
    }
  }

  function updateQuestionState(updater: (state: QuestionPanelState) => QuestionPanelState | undefined, focusCustom = false) {
    setPendingQuestion((current) => current ? updater(current) : undefined);
    syncQuestionUI(focusCustom);
  }

  function questionAt(state: QuestionPanelState): QuestionPrompt | undefined {
    return state.request.questions[state.tab];
  }

  function isSingleQuestion(state: QuestionPanelState) {
    const first = state.request.questions[0];
    return state.request.questions.length === 1 && first?.multiple !== true;
  }

  function isQuestionConfirmTab(state: QuestionPanelState) {
    return !isSingleQuestion(state) && state.tab >= state.request.questions.length;
  }

  function questionCustomAllowed(question: QuestionPrompt | undefined) {
    return question?.custom !== false;
  }

  function questionOptionTotal(state: QuestionPanelState) {
    const q = questionAt(state);
    if (!q) return 0;
    return q.options.length + (questionCustomAllowed(q) ? 1 : 0);
  }

  function questionPanelHeight(state: QuestionPanelState) {
    const tabRows = isSingleQuestion(state) ? 0 : 1;
    const bodyRows = isQuestionConfirmTab(state)
      ? Math.max(2, state.request.questions.length + 1)
      : Math.max(2, questionOptionTotal(state) * 2 + (state.editing ? 2 : 0));
    const wanted = QUESTION_PANEL_MIN_HEIGHT + tabRows + bodyRows;
    const max = Math.max(QUESTION_PANEL_MIN_HEIGHT, dimensions().height - 6);
    return Math.min(wanted, max);
  }

  function questionIsOtherSelected(state: QuestionPanelState) {
    const q = questionAt(state);
    return !!q && questionCustomAllowed(q) && state.selected === q.options.length;
  }

  function questionCustomPicked(state: QuestionPanelState) {
    const value = state.custom[state.tab]?.trim();
    return !!value && (state.answers[state.tab] ?? []).includes(value);
  }

  function moveQuestionSelection(delta: number) {
    updateQuestionState((state) => {
      if (isQuestionConfirmTab(state)) return state;
      const total = questionOptionTotal(state);
      if (total <= 0) return state;
      return { ...state, selected: (state.selected + delta + total) % total };
    });
  }

  function selectQuestionTab(tab: number) {
    updateQuestionState((state) => {
      const max = isSingleQuestion(state) ? 0 : state.request.questions.length;
      const nextTab = ((tab % (max + 1)) + max + 1) % (max + 1);
      return { ...state, tab: nextTab, selected: 0, editing: false };
    });
  }

  function setQuestionAnswer(answer: string, custom = false) {
    const controller = props.options.questionController;
    const state = pendingQuestion();
    if (!state || !controller) return;
    const answers = state.answers.map((items) => [...items]);
    const customValues = [...state.custom];
    answers[state.tab] = [answer];
    if (custom) customValues[state.tab] = answer;
    if (isSingleQuestion(state)) {
      controller.reply(state.request.id, [[answer]]);
      setPendingQuestion(undefined);
      syncQuestionUI();
      return;
    }
    const nextTab = Math.min(state.tab + 1, state.request.questions.length);
    setPendingQuestion({ ...state, answers, custom: customValues, tab: nextTab, selected: 0, editing: false });
    syncQuestionUI();
  }

  function toggleQuestionAnswer(answer: string) {
    updateQuestionState((state) => {
      const answers = state.answers.map((items) => [...items]);
      const current = answers[state.tab] ?? [];
      const index = current.indexOf(answer);
      if (index === -1) current.push(answer);
      else current.splice(index, 1);
      answers[state.tab] = current;
      return { ...state, answers };
    });
  }

  function selectQuestionOption() {
    const state = pendingQuestion();
    if (!state || isQuestionConfirmTab(state)) return;
    const q = questionAt(state);
    if (!q) return;
    if (questionIsOtherSelected(state)) {
      updateQuestionState((current) => ({ ...current, editing: true }), true);
      return;
    }
    const option = q.options[state.selected];
    if (!option) return;
    if (q.multiple === true) {
      toggleQuestionAnswer(option.label);
      return;
    }
    setQuestionAnswer(option.label);
  }

  function commitQuestionCustom() {
    const state = pendingQuestion();
    if (!state) return;
    const q = questionAt(state);
    if (!q) return;
    const nextText = (questionCustomInput?.plainText ?? state.custom[state.tab] ?? "").trim();
    if (!nextText) {
      updateQuestionState((current) => {
        const answers = current.answers.map((items) => items.filter((item) => item !== current.custom[current.tab]));
        const custom = [...current.custom];
        custom[current.tab] = "";
        return { ...current, answers, custom, editing: false };
      });
      return;
    }
    if (q.multiple === true) {
      updateQuestionState((current) => {
        const answers = current.answers.map((items) => [...items]);
        const previous = current.custom[current.tab];
        const currentAnswers = (answers[current.tab] ?? []).filter((item) => item !== previous);
        if (!currentAnswers.includes(nextText)) currentAnswers.push(nextText);
        answers[current.tab] = currentAnswers;
        const custom = [...current.custom];
        custom[current.tab] = nextText;
        return { ...current, answers, custom, editing: false };
      });
      return;
    }
    setQuestionAnswer(nextText, true);
  }

  function submitQuestionAnswers() {
    const state = pendingQuestion();
    const controller = props.options.questionController;
    if (!state || !controller) return;
    const answers = state.request.questions.map((_, index) => [...(state.answers[index] ?? [])]);
    controller.reply(state.request.id, answers);
    setPendingQuestion(undefined);
    syncQuestionUI();
  }

  function rejectQuestion() {
    const state = pendingQuestion();
    const controller = props.options.questionController;
    if (!state || !controller) return;
    controller.reject(state.request.id);
    setPendingQuestion(undefined);
    syncQuestionUI();
  }

  function handleQuestionKey(event: any) {
    const state = pendingQuestion();
    if (!state || pendingApproval()) return false;
    const name = keyNameFromEvent(event);

    if (state.editing && !isQuestionConfirmTab(state)) {
      if (name === "escape") {
        event.preventDefault?.();
        updateQuestionState((current) => ({ ...current, editing: false }));
        return true;
      }
      if (name === "enter") {
        event.preventDefault?.();
        commitQuestionCustom();
        return true;
      }
      return false;
    }

    if (name === "escape") {
      event.preventDefault?.();
      rejectQuestion();
      return true;
    }

    if (isSingleQuestion(state) && (name === "left" || name === "h" || name === "right" || name === "l" || name === "tab")) {
      event.preventDefault?.();
      const direction = name === "left" || name === "h" || (name === "tab" && event.shift) ? -1 : 1;
      moveQuestionSelection(direction);
      return true;
    }

    if (!isSingleQuestion(state) && (name === "left" || name === "h")) {
      event.preventDefault?.();
      selectQuestionTab(state.tab - 1);
      return true;
    }
    if (!isSingleQuestion(state) && (name === "right" || name === "l" || name === "tab")) {
      event.preventDefault?.();
      selectQuestionTab(state.tab + (event.shift ? -1 : 1));
      return true;
    }

    if (isQuestionConfirmTab(state)) {
      if (name === "enter") {
        event.preventDefault?.();
        submitQuestionAnswers();
        return true;
      }
      return true;
    }

    const total = questionOptionTotal(state);
    const digit = Number(name);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= Math.min(total, 9)) {
      event.preventDefault?.();
      updateQuestionState((current) => ({ ...current, selected: digit - 1 }));
      setTimeout(selectQuestionOption, 0);
      return true;
    }
    if (name === "up" || name === "k") {
      event.preventDefault?.();
      moveQuestionSelection(-1);
      return true;
    }
    if (name === "down" || name === "j") {
      event.preventDefault?.();
      moveQuestionSelection(1);
      return true;
    }
    if (name === "enter") {
      event.preventDefault?.();
      selectQuestionOption();
      return true;
    }

    return false;
  }

  function openFeedback(initialDescription: string) {
    const base = collectFeedback(props.agent, { description: "" });
    const { description: _description, ...rest } = base;
    picker = undefined;
    providerDialog = undefined;
    redrawProviderDialog();
    setPendingFeedback({
      base: rest,
      description: initialDescription.trim(),
      stage: "edit",
      showPreview: false,
    });
    syncFeedbackUI(true);
  }

  function updateFeedbackState(updater: (state: FeedbackPanelState) => FeedbackPanelState | undefined, focus = false) {
    setPendingFeedback((current) => current ? updater(current) : undefined);
    syncFeedbackUI(focus);
  }

  function closeFeedback() {
    setPendingFeedback(undefined);
    syncFeedbackUI(false);
    restorePromptAfterModal();
    if (queuedInputCount() > 0) scheduleQueuedInputDrain();
  }

  function syncFeedbackUI(focus = false) {
    redrawFeedbackPanel();
    syncPromptSurfaces();
    redrawDock();
    rootBox?.requestRender();
    scrollbox?.requestRender();
    if (focus || pendingFeedback()) focusFeedbackPanel();
  }

  function feedbackTranscriptStats(base: Omit<FeedbackPayload, "description">) {
    const totalChars = base.transcript.reduce((sum, item) => sum + item.content.length, 0);
    return { count: base.transcript.length, totalChars };
  }

  function formatFeedbackPreviewText(base: Omit<FeedbackPayload, "description">) {
    const transcript = base.transcript.length
      ? base.transcript.map((message) => `[${message.role}]\n${message.content}`).join("\n\n")
      : "No transcript messages included.";
    const recentError = base.recentError ? `\n\n[recent error]\n${base.recentError}` : "";
    return truncate(`${transcript}${recentError}`, 6000);
  }

  async function submitFeedbackPanel() {
    const state = pendingFeedback();
    if (!state || state.stage !== "edit") return;
    const description = (feedbackInput?.plainText ?? state.description).trim();
    if (!description && state.base.transcript.length === 0) {
      updateFeedbackState((current) => ({
        ...current,
        description,
        status: "Describe the issue before submitting.",
      }), true);
      return;
    }

    setPendingFeedback({ ...state, description, stage: "submitting", status: undefined });
    syncFeedbackUI();
    try {
      const result = await submitFeedback({ ...state.base, description });
      setPendingFeedback({
        ...state,
        description,
        stage: "done",
        result: { kind: "success", url: result.url, number: result.number },
      });
      addMessage("assistant", `Feedback submitted: ${result.url}`);
    } catch (err) {
      const message = err instanceof FeedbackSubmitError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      setPendingFeedback({
        ...state,
        description,
        stage: "done",
        result: { kind: "error", message },
      });
      addMessage("error", `Feedback failed: ${message}`);
    }
    syncFeedbackUI();
  }

  function handleFeedbackKey(event: any) {
    const state = pendingFeedback();
    if (!state) return false;
    const name = keyNameFromEvent(event);

    if (state.stage === "submitting") return true;

    if (state.stage === "done") {
      if (name === "enter" || name === "escape" || event.input === " ") {
        closeFeedback();
      }
      return true;
    }

    if (name === "escape") {
      closeFeedback();
      return true;
    }
    if (name === "tab") {
      updateFeedbackState((current) => ({
        ...current,
        description: feedbackInput?.plainText ?? current.description,
        showPreview: !current.showPreview,
        status: undefined,
      }), true);
      return true;
    }
    if (event.ctrl && (name === "d" || name === "s")) {
      void submitFeedbackPanel();
      return true;
    }
    return false;
  }

  function openStatsPanel() {
    picker = undefined;
    providerDialog = undefined;
    redrawProviderDialog();
    statsPanel = {
      range: "30d",
      bundle: collectUsageStatsBundle(),
    };
    activePrompt()?.clear();
    activePrompt()?.blur();
    promptText = "";
    syncStatsUI(true);
  }

  function closeStatsPanel() {
    statsPanel = undefined;
    syncStatsUI(false);
    restorePromptAfterModal();
    if (queuedInputCount() > 0) scheduleQueuedInputDrain();
  }

  function syncStatsUI(focus = false) {
    redrawStatsPanel();
    syncPromptSurfaces();
    redrawDock();
    rootBox?.requestRender();
    scrollbox?.requestRender();
    if (focus || statsPanel) focusStatsPanel();
  }

  function setStatsRange(range: StatsRange) {
    if (!statsPanel || statsPanel.range === range) return;
    statsPanel = { ...statsPanel, range };
    redrawStatsPanel();
  }

  function handleStatsKey(event: any) {
    if (!statsPanel) return false;
    const name = keyNameFromEvent(event);
    if (name === "escape") {
      closeStatsPanel();
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (name === "left" || name === "h") {
      setStatsRange("7d");
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (name === "right" || name === "l") {
      setStatsRange("30d");
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (name === "tab") {
      setStatsRange(statsPanel.range === "30d" ? "7d" : "30d");
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    return true;
  }

  function openFeishuSetup() {
    picker = undefined;
    providerDialog = undefined;
    redrawProviderDialog();
    feishuSetupAbortController?.abort();
    const controller = new AbortController();
    feishuSetupAbortController = controller;
    setPendingFeishuSetup({ kind: "registering" });
    syncFeishuSetupUI(true);
    void runFeishuSetupRegistration(controller);
  }

  async function runFeishuSetupRegistration(controller: AbortController) {
    const isActive = () => !uiDisposed && !controller.signal.aborted && feishuSetupAbortController === controller;
    try {
      const result = await registerApp({
        signal: controller.signal,
        onQRCodeReady: (info) => {
          if (!isActive()) return;
          qrTerminal.generate(info.url, { small: true }, (ascii: string) => {
            if (!isActive()) return;
            setPendingFeishuSetup({
              kind: "qr_shown",
              url: info.url,
              ascii,
              status: "等待扫码...",
            });
            syncFeishuSetupUI();
          });
        },
        onStatusChange: (info) => {
          if (!isActive()) return;
          setPendingFeishuSetup((current) => {
            if (!current || current.kind !== "qr_shown") return current;
            return { ...current, status: feishuSetupStatusLabel(info.status) };
          });
          syncFeishuSetupUI();
        },
      });
      if (!isActive()) return;
      const ownerOpenId = result.user_info?.open_id;
      if (!ownerOpenId) {
        setPendingFeishuSetup({ kind: "error", message: "授权成功但没拿到 owner open_id，无法继续。" });
        syncFeishuSetupUI(true);
        return;
      }
      try {
        bootstrapConfig({
          appId: result.client_id,
          appSecret: result.client_secret,
          ownerOpenId,
        });
      } catch (err) {
        setPendingFeishuSetup({ kind: "error", message: `保存 config 失败：${(err as Error).message}` });
        syncFeishuSetupUI(true);
        return;
      }
      setPendingFeishuSetup({ kind: "credentialed", ownerOpenId });
      syncFeishuSetupUI(true);
    } catch (err) {
      if (!isActive()) return;
      setPendingFeishuSetup({ kind: "error", message: (err as Error).message || "扫码注册失败" });
      syncFeishuSetupUI(true);
    }
  }

  function feishuSetupStatusLabel(status: string) {
    if (status === "polling") return "等待扫码...";
    if (status === "slow_down") return "轮询变慢中...仍在等待";
    if (status === "domain_switched") return "已切换域名";
    return status;
  }

  function syncFeishuSetupUI(focus = false) {
    redrawFeishuSetupPanel();
    syncPromptSurfaces();
    redrawDock();
    rootBox?.requestRender();
    scrollbox?.requestRender();
    if (focus || pendingFeishuSetup()) focusFeishuSetupPanel();
  }

  function closeFeishuSetup(message?: string) {
    feishuSetupAbortController?.abort();
    feishuSetupAbortController = undefined;
    setPendingFeishuSetup(undefined);
    redrawFeishuSetupPanel();
    syncPromptSurfaces(true);
    redrawDock();
    restorePromptAfterModal();
    if (message) addMessage("assistant", message);
    if (queuedInputCount() > 0) scheduleQueuedInputDrain();
  }

  function skipFeishuSetupBinding(ownerOpenId: string) {
    closeFeishuSetup(
      `✅ 应用已注册并保存到 ~/.bubble/feishu/。owner: ${ownerOpenId}\n(已跳过 chat 绑定 — 稍后可以编辑 ~/.bubble/feishu/scopes.json 添加)`,
    );
  }

  function startFeishuSetupBinding(ownerOpenId: string) {
    setPendingFeishuSetup({
      kind: "binding",
      ownerOpenId,
      field: "chatId",
      values: { ...FEISHU_SETUP_EMPTY_VALUES },
    });
    syncFeishuSetupUI(true);
  }

  function updateFeishuSetupInput(value: string) {
    setPendingFeishuSetup((current) => {
      if (!current || current.kind !== "binding") return current;
      return {
        ...current,
        values: { ...current.values, [current.field]: value },
        error: undefined,
      };
    });
    redrawFeishuSetupPanel();
  }

  function submitFeishuSetupField() {
    const state = pendingFeishuSetup();
    if (!state || state.kind !== "binding") return false;
    const value = state.values[state.field];

    if (state.field === "chatId") {
      if (!value.trim()) {
        setPendingFeishuSetup({ ...state, error: "Chat ID 不能为空（oc_...）" });
        syncFeishuSetupUI(true);
        return true;
      }
      setPendingFeishuSetup({ ...state, field: "cwd", error: undefined });
      syncFeishuSetupUI(true);
      return true;
    }

    if (state.field === "cwd") {
      const expanded = expandFeishuSetupPath(value.trim());
      if (!isAbsolute(expanded)) {
        setPendingFeishuSetup({ ...state, error: "cwd 必须是绝对路径或 ~/..." });
        syncFeishuSetupUI(true);
        return true;
      }
      try {
        if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
          setPendingFeishuSetup({ ...state, error: `路径不存在或不是目录：${expanded}` });
          syncFeishuSetupUI(true);
          return true;
        }
      } catch (err) {
        setPendingFeishuSetup({ ...state, error: `无法读取路径：${(err as Error).message}` });
        syncFeishuSetupUI(true);
        return true;
      }
      setPendingFeishuSetup({
        ...state,
        field: "displayName",
        values: {
          ...state.values,
          cwd: expanded,
          displayName: state.values.displayName || basename(expanded),
        },
        error: undefined,
      });
      syncFeishuSetupUI(true);
      return true;
    }

    const displayName = value.trim() || basename(state.values.cwd);
    try {
      const registry = ScopeRegistry.load();
      const scope: ScopeConfig = {
        cwd: state.values.cwd,
        displayName,
        allowedUsers: [state.ownerOpenId],
        admins: [state.ownerOpenId],
        defaultPermissionMode: "default",
        model: null,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      registry.upsert(state.values.chatId.trim(), scope);
    } catch (err) {
      setPendingFeishuSetup({ ...state, error: `保存 scope 失败：${(err as Error).message}` });
      syncFeishuSetupUI(true);
      return true;
    }
    closeFeishuSetup(
      `✅ 已注册应用并绑定第一个 chat：\n  chat: ${state.values.chatId.trim()}\n  cwd:  ${state.values.cwd}\n现在可以 /feishu start 启动服务。`,
    );
    return true;
  }

  function handleFeishuSetupKey(event: any) {
    const state = pendingFeishuSetup();
    if (!state) return false;
    const name = keyNameFromEvent(event);

    if (name === "escape") {
      if (state.kind === "credentialed") {
        skipFeishuSetupBinding(state.ownerOpenId);
      } else if (state.kind === "binding") {
        closeFeishuSetup(
          `✅ 应用已注册。owner: ${state.ownerOpenId}\n(已跳过 chat 绑定 — 稍后可以 /feishu setup 重来或编辑 scopes.json)`,
        );
      } else {
        closeFeishuSetup("已取消 Feishu setup。");
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }

    if (name === "return" || name === "enter") {
      if (state.kind === "credentialed") {
        startFeishuSetupBinding(state.ownerOpenId);
      } else if (state.kind === "binding") {
        submitFeishuSetupField();
      } else if (state.kind === "error") {
        closeFeishuSetup("已取消 Feishu setup。");
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }

    if (state.kind === "binding" && name === "tab" && state.field === "displayName") {
      updateFeishuSetupInput(basename(state.values.cwd));
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }

    return false;
  }

  function expandFeishuSetupPath(path: string) {
    if (path === "~" || path.startsWith("~/")) return homedir() + path.slice(1);
    return resolvePath(path);
  }

  function activeModalKeyOwner(): ModalKeyOwner | undefined {
    if (pendingApproval() || pendingPlan()) return "approval";
    if (pendingQuestion()) return "question";
    if (pendingFeedback()) return "feedback";
    if (statsPanel) return "stats";
    if (providerDialog) return "provider";
    if (pendingFeishuSetup()) return "feishu";
    if (picker) return "picker";
    return undefined;
  }

  function routeModalKey(event: any): boolean {
    const owner = activeModalKeyOwner();
    if (!owner) return false;
    switch (owner) {
      case "approval":
        return handleApprovalKey(event);
      case "question":
        return handleQuestionKey(event);
      case "feedback":
        return handleFeedbackKey(event);
      case "stats":
        return handleStatsKey(event);
      case "provider":
        return handleProviderDialogKey(event);
      case "feishu":
        return handleFeishuSetupKey(event);
      case "picker":
        return handlePickerKey(event);
    }
  }

  function shouldModalSwallowUnhandledKey(owner: ModalKeyOwner) {
    if (owner === "approval") return true;
    if (owner === "question") {
      const state = pendingQuestion();
      return !state?.editing || isQuestionConfirmTab(state);
    }
    if (owner === "feedback") return pendingFeedback()?.stage !== "edit";
    if (owner === "stats") return true;
    if (owner === "feishu") return pendingFeishuSetup()?.kind !== "binding";
    return false;
  }

  function routeModalRawSequence(sequence: string) {
    const owner = activeModalKeyOwner();
    if (!owner) return false;
    const name = modalKeyNameFromSequence(sequence);
    if (!name) return false;
    const handled = routeModalKey({
      name,
      key: name,
      input: sequence,
      raw: sequence,
      sequence,
      shift: sequence === "\x1b[Z",
      preventDefault() {},
      stopPropagation() {},
    });
    return handled || shouldModalSwallowUnhandledKey(owner);
  }

  const installInteractiveHandlers = () => {
    if (props.options.planHandlerRef) {
      props.options.planHandlerRef.current = (plan: string) =>
        new Promise<PlanDecision>((resolve) => {
          setPendingPlan({ plan, resolve });
          blurInputsForModal();
          forceApprovalUI();
        });
    }
    if (props.options.approvalHandlerRef) {
      props.options.approvalHandlerRef.current = (request: ApprovalRequest) =>
        new Promise<ApprovalDecision>((resolve) => {
          pendingApprovalRef = { request, resolve };
          picker = undefined;
          providerDialog = undefined;
          setPendingApproval({ request, resolve });
          blurInputsForModal();
          forceApprovalUI();
        });
    }
  };

  installInteractiveHandlers();

  createEffect(() => {
    installInteractiveHandlers();
  });

  createEffect(() => {
    mode();
    syncModeChrome();
  });

  onMount(() => {
    const questionController = props.options.questionController;
    if (questionController) {
      const unsubscribeQuestion = questionController.subscribe((event) => {
        if (event.request.sessionID && currentQuestionSessionID() && event.request.sessionID !== currentQuestionSessionID()) {
          return;
        }
        if (event.type === "asked") {
          if (!pendingQuestion()) setPendingQuestion(questionStateFromRequest(event.request));
          syncQuestionUI();
          return;
        }
        if (pendingQuestion()?.request.id === event.request.id) {
          setPendingQuestion(undefined);
          syncFirstPendingQuestion();
        }
      });
      onCleanup(unsubscribeQuestion);
      syncFirstPendingQuestion();
    }
    props.setRawGlobalKeyHandler?.(routeGlobalRawSequence);
    const unsubscribeLsp = lspService.onStatusChange(() => {
      syncSidebarLsp();
    });
    sidebarLspSyncTimer = setInterval(syncSidebarLsp, 1000);
    onCleanup(unsubscribeLsp);
    refreshGitSidebar();
    setTimeout(() => {
      activePrompt()?.focus();
      scrollTranscriptToBottom();
    }, 25);
  });

  onCleanup(() => {
    props.setRawGlobalKeyHandler?.(undefined);
    if (sidebarLspSyncTimer) clearInterval(sidebarLspSyncTimer);
    for (const timer of questionSyncTimers) clearTimeout(timer);
    questionSyncTimers.clear();
    if (props.options.planHandlerRef) props.options.planHandlerRef.current = undefined;
    if (props.options.approvalHandlerRef) props.options.approvalHandlerRef.current = undefined;
  });

  let lastCopiedSelection = "";
  let lastCopiedSelectionAt = 0;
  let selectionCopySerial = 0;
  let rawSelectionStart: { x: number; y: number } | undefined;

  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const selectedText = getOpenTuiSelectionText(selection);
    void copySelectionText(selectedText);
  });

  function handleRawMouseSelection(event: { type: string; button: number; x: number; y: number }) {
    if (event.button !== 0) return;
    if (event.type === "down") {
      rawSelectionStart = { x: event.x, y: event.y };
      return;
    }
    if (event.type !== "up") return;
    const start = rawSelectionStart;
    rawSelectionStart = undefined;
    if (!start || (start.x === event.x && start.y === event.y)) return;
    const selection = renderer.getSelection();
    if (!selection || selection.isDragging) return;
    void copySelectionText(getOpenTuiSelectionText(selection));
  }

  props.setRawMouseSelectionHandler?.(handleRawMouseSelection);
  onCleanup(() => props.setRawMouseSelectionHandler?.(undefined));

  useKeyboard((event: any) => {
    routeGlobalKeyEvent(event);
  }, {});

  function currentTranscriptMessages(extra?: DisplayMessage) {
    return compactDisplayMessages([
      ...displayMessages,
      ...(extra ? [extra] : []),
      ...queuedDisplayMessages,
    ]);
  }

  function hasTranscriptMessages(extra?: DisplayMessage) {
    return currentTranscriptMessages(extra).some((message) => hasRenderableMessage(message, effectiveShowThinking()));
  }

  function isHomeSurfaceActive(extra?: DisplayMessage) {
    return !hasTranscriptMessages(extra) && !pendingPlan() && !pendingQuestion() && !pendingFeedback() && !statsPanel && !pendingFeishuSetup();
  }

  function syncPromptSurfaces(focus = false) {
    const homeActive = isHomeSurfaceActive(streamingDisplay);
    const nextSessionActive = !homeActive;
    const surfaceChanged = sessionActive() !== nextSessionActive;
    setSessionActive(nextSessionActive);
    const modalComposerHidden = !!pendingQuestion() || !!pendingFeedback() || !!statsPanel || !!pendingFeishuSetup();
    if (homeSurfaceShell) homeSurfaceShell.visible = homeActive;
    if (homeComposerShell) homeComposerShell.visible = homeActive && !modalComposerHidden;
    if (sessionComposerShell) sessionComposerShell.visible = !homeActive && !modalComposerHidden;
    syncSidebarChrome();
    if (focus || surfaceChanged) setTimeout(() => activePrompt()?.focus(), 0);
    rootBox?.requestRender();
  }

  function registerPromptScanner(sync: PromptScannerSync) {
    promptScannerSyncs.add(sync);
    sync(isRunning());
    return () => {
      promptScannerSyncs.delete(sync);
    };
  }

  function setRunningState(running: boolean) {
    setIsRunning(running);
    for (const sync of promptScannerSyncs) {
      try {
        sync(running);
      } catch {
        // The waiting animation is decorative; it must never block the agent run.
      }
    }
    try {
      homeComposerShell?.requestRender();
      sessionComposerShell?.requestRender();
      rootBox?.requestRender();
    } catch {
      // Keep the agent loop alive even if a renderable is already gone.
    }
  }

  function beginAgentRun() {
    clearRunningCancelHint();
    const run: ActiveAgentRun = {
      id: ++nextRunId,
      abortController: new AbortController(),
      inputController: new AgentRunInputQueue(`run-${nextRunId}`),
    };
    activeRun = run;
    clearPendingSteerInputs();
    setRunningState(true);
    return run;
  }

  function finishAgentRun(run: ActiveAgentRun) {
    if (activeRun?.id === run.id) activeRun = undefined;
    clearRunningCancelHint();
    clearPendingSteerInputs();
    setRunningState(false);
  }

  function requestComposerRender() {
    try {
      activeComposerShell()?.requestRender();
      rootBox?.requestRender();
    } catch {
      // Render hints are best-effort and must not interfere with cancellation.
    }
  }

  function syncPendingSteerInputCount() {
    setPendingSteerCount(pendingSteerInputs.length);
    requestComposerRender();
  }

  function syncQueuedComposerInputCount() {
    setQueuedInputCount(rejectedSteerInputs.length + queuedComposerInputs.length);
    requestComposerRender();
  }

  function queuedInputLabel(count = queuedInputCount()) {
    return `${count} queued message${count === 1 ? "" : "s"}`;
  }

  function redrawTranscriptWithQueuedDisplays() {
    redrawTranscript(streamingDisplay, displayMessages);
  }

  function addQueuedUserDisplay(input: string) {
    const displayId = `queued-${++nextQueuedDisplayId}`;
    queuedDisplayMessages = [
      ...queuedDisplayMessages,
      { role: "user", content: input, clientId: displayId, queued: true },
    ];
    redrawTranscriptWithQueuedDisplays();
    return displayId;
  }

  function updateQueuedUserDisplay(displayId: string, queued: boolean) {
    let changed = false;
    const update = (message: DisplayMessage): DisplayMessage => {
      if (message.clientId !== displayId) return message;
      changed = true;
      return { ...message, queued };
    };
    displayMessages = displayMessages.map(update);
    queuedDisplayMessages = queuedDisplayMessages.map(update);
    if (changed) redrawTranscriptWithQueuedDisplays();
    return changed;
  }

  function removeQueuedUserDisplay(displayId?: string) {
    if (!displayId) return false;
    const beforeDisplayCount = displayMessages.length;
    const beforeQueuedCount = queuedDisplayMessages.length;
    displayMessages = displayMessages.filter((message) => message.clientId !== displayId);
    queuedDisplayMessages = queuedDisplayMessages.filter((message) => message.clientId !== displayId);
    const changed = displayMessages.length !== beforeDisplayCount || queuedDisplayMessages.length !== beforeQueuedCount;
    if (changed) redrawTranscriptWithQueuedDisplays();
    return changed;
  }

  function promoteQueuedUserDisplay(displayId?: string, fallbackContent?: string) {
    if (!displayId) return false;
    const index = queuedDisplayMessages.findIndex((message) => message.clientId === displayId);
    if (index === -1) {
      return updateQueuedUserDisplay(displayId, false);
    }
    const message = queuedDisplayMessages[index]!;
    queuedDisplayMessages = queuedDisplayMessages.filter((_, itemIndex) => itemIndex !== index);
    displayMessages = [...displayMessages, { ...message, content: message.content || fallbackContent || " ", queued: false }];
    redrawTranscriptWithQueuedDisplays();
    return true;
  }

  function promptStatusText() {
    const cancelHint = runningCancelHint();
    if (cancelHint) return cancelHint;
    const queued = queuedInputCount();
    const pendingSteers = pendingSteerCount();
    if (isRunning()) {
      const status: string[] = [];
      if (pendingSteers > 0) status.push(`${pendingSteers} pending steer${pendingSteers === 1 ? "" : "s"}`);
      if (queued > 0) status.push(queuedInputLabel(queued));
      status.push("Enter steer");
      status.push("Tab queue");
      status.push("Esc stop");
      return status.join(" · ");
    }
    return queued > 0 ? `${queuedInputLabel(queued)} · starting next` : "";
  }

  function queueComposerInput(input: string, options: { notice?: string | false; displayId?: string; showInTranscript?: boolean } = {}) {
    const displayId = options.displayId ?? (options.showInTranscript ? addQueuedUserDisplay(input) : undefined);
    queuedComposerInputs.push({ input, displayId });
    syncQueuedComposerInputCount();
    if (options.notice !== false) setNotice(options.notice ?? `Queued next message (${queuedInputCount()})`);
    if (!isRunning()) scheduleQueuedInputDrain();
  }

  function requeueRejectedSteer(input: string, displayId?: string) {
    const queuedDisplayId = displayId ?? addQueuedUserDisplay(input);
    updateQueuedUserDisplay(queuedDisplayId, true);
    rejectedSteerInputs.push({ input, displayId: queuedDisplayId });
    syncQueuedComposerInputCount();
    if (!isRunning()) scheduleQueuedInputDrain();
  }

  function clearQueuedComposerInputs() {
    if (queuedInputDrainTimer) {
      clearTimeout(queuedInputDrainTimer);
      queuedInputDrainTimer = undefined;
    }
    if (rejectedSteerInputs.length === 0 && queuedComposerInputs.length === 0) return;
    rejectedSteerInputs = [];
    queuedComposerInputs = [];
    queuedDisplayMessages = [];
    syncQueuedComposerInputCount();
    redrawTranscriptWithQueuedDisplays();
  }

  function clearPendingSteerInputs() {
    pendingSteerInputs = [];
    setPendingSteerCount(0);
    requestComposerRender();
  }

  function removePendingSteerInput(id: string) {
    const removed = pendingSteerInputs.find((item) => item.id === id);
    const next = pendingSteerInputs.filter((item) => item.id !== id);
    if (next.length === pendingSteerInputs.length) return removed;
    pendingSteerInputs = next;
    syncPendingSteerInputCount();
    return removed;
  }

  function scheduleQueuedInputDrain(delay = 0) {
    if (uiDisposed || queuedInputDrainTimer) return;
    queuedInputDrainTimer = setTimeout(() => {
      queuedInputDrainTimer = undefined;
      void drainQueuedInput();
    }, delay);
  }

  async function drainQueuedInput() {
    if (
      uiDisposed
      || drainingQueuedInput
      || isRunning()
      || pendingApproval()
      || pendingPlan()
      || pendingQuestion()
      || pendingFeedback()
      || statsPanel
      || providerDialog
      || picker
    ) {
      return;
    }
    const next = rejectedSteerInputs.shift() ?? queuedComposerInputs.shift();
    if (!next) {
      syncQueuedComposerInputCount();
      return;
    }
    syncQueuedComposerInputCount();
    drainingQueuedInput = true;
    promoteQueuedUserDisplay(next.displayId, next.input);
    const remaining = queuedInputCount();
    setNotice(remaining > 0 ? `Running queued message (${remaining} left)` : "Running queued message");
    try {
      await handleInput(next.input, { displayId: next.displayId });
    } finally {
      drainingQueuedInput = false;
      if (queuedInputCount() > 0) scheduleQueuedInputDrain();
    }
  }

  function isBoundarySteerEligible(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("/")) return false;
    if (trimmed.includes("@")) return false;
    if (imageAttachmentLabelPattern().test(trimmed)) return false;
    if (extractImagePathTokens(trimmed).length > 0) return false;
    return true;
  }

  function submitBoundarySteer(input: string) {
    const run = activeRun;
    if (!run || run.abortController.signal.aborted) {
      queueComposerInput(input, { showInTranscript: true });
      return;
    }
    const displayId = addQueuedUserDisplay(input);
    const pendingInput = run.inputController.enqueue(input);
    pendingSteerInputs.push({ id: pendingInput.id, input, displayId });
    syncPendingSteerInputCount();
    setNotice("Steer pending for next model call");
  }

  function queuePromptFromComposer(options: { clearPicker?: boolean; notice?: string | false } = {}) {
    const raw = readPromptText() || promptText;
    const input = (raw || promptText).trimEnd();
    if (!input.trim()) return false;
    activePrompt()?.clear();
    promptText = "";
    resetPromptHistoryBrowse();
    if (options.clearPicker && picker) closePicker();
    queueComposerInput(input, { notice: options.notice, showInTranscript: isRunning() });
    return true;
  }

  function clearRunningCancelHint() {
    runningCancelGate.clear();
    if (runningCancelHintTimer) {
      clearTimeout(runningCancelHintTimer);
      runningCancelHintTimer = undefined;
    }
    if (runningCancelHint()) {
      setRunningCancelHint("");
      requestComposerRender();
    }
  }

  function armRunningCancelHint(run: { id: number; abortController: AbortController }) {
    const decision = runningCancelGate.press(run.id);
    if (decision.action === "confirm") return true;

    setRunningCancelHint("Press Esc again to stop");
    if (runningCancelHintTimer) clearTimeout(runningCancelHintTimer);
    runningCancelHintTimer = setTimeout(() => {
      if (!runningCancelGate.isArmed(run.id)) {
        if (runningCancelHint()) {
          setRunningCancelHint("");
          requestComposerRender();
        }
        runningCancelHintTimer = undefined;
        return;
      }
      clearRunningCancelHint();
    }, Math.max(0, decision.expiresAt - Date.now()));
    requestComposerRender();
    return false;
  }

  function cancelActiveAgentRun() {
    if (!activeRun || activeRun.abortController.signal.aborted) return false;
    traceEvent("tui_running_cancel", {
      runId: activeRun.id,
      pendingQueuedInputs: queuedInputCount(),
    }, { surface: "tui" });
    clearRunningCancelHint();
    activeRun.abortController.abort(new AgentAbortError("Agent run cancelled by user."));
    setNotice("Agent run cancelled");
    redrawDock();
    return true;
  }

  function preventGlobalKey(event: any) {
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  function isCtrlCSequence(sequence?: string) {
    return sequence === "\x03";
  }

  function isCtrlCEvent(event: any) {
    const name = keyNameFromEvent(event);
    return isCtrlCSequence(event?.raw)
      || isCtrlCSequence(event?.sequence)
      || isCtrlCSequence(event?.input)
      || (event?.ctrl === true && name === "c");
  }

  function routeCtrlCExit(event?: any) {
    if (event && !isCtrlCEvent(event)) return false;
    void requestExit({ direct: true });
    if (event) preventGlobalKey(event);
    return true;
  }

  function routeRunningCancel(name: string, event?: any) {
    if (name !== "escape") return false;
    if (!activeRun || activeRun.abortController.signal.aborted) return false;
    const shouldCancel = armRunningCancelHint(activeRun);
    traceKeyRoute(event ? "key" : "raw", name, !shouldCancel ? "armed_cancel" : "confirm_cancel");
    if (!shouldCancel) {
      if (event) preventGlobalKey(event);
      return true;
    }
    if (!cancelActiveAgentRun()) return false;
    if (event) preventGlobalKey(event);
    return true;
  }

  function routeRunningQueue(name: string, event?: any) {
    if (name !== "tab" || event?.shift) return false;
    if (!isRunning() || activeModalKeyOwner()) return false;
    queuePromptFromComposer({ notice: "Queued next message" });
    traceKeyRoute(event ? "key" : "raw", name, "queued_next_message");
    if (event) preventGlobalKey(event);
    return true;
  }

  function traceKeyRoute(source: "raw" | "key", name: string, result: string) {
    const shouldTrace = result !== "unhandled"
      || name === "escape"
      || name === "enter"
      || name === "tab"
      || name === "up"
      || name === "down"
      || name === "left"
      || name === "right"
      || name === "ctrl-c"
      || !!activeModalKeyOwner()
      || isRunning();
    if (!shouldTrace) return;
    traceEvent("tui_key_route", {
      source,
      key: name,
      result,
      modalOwner: activeModalKeyOwner(),
      running: isRunning(),
      activeRunId: activeRun?.id,
      pendingApproval: !!pendingApproval(),
      pendingPlan: !!pendingPlan(),
      pendingQuestion: !!pendingQuestion(),
      providerDialog: !!providerDialog,
      picker: !!picker,
    }, { surface: "tui" });
  }

  function routeGlobalRawSequence(sequence: string) {
    if (isCtrlCSequence(sequence)) {
      void requestExit({ direct: true });
      traceKeyRoute("raw", "ctrl-c", "exit");
      return true;
    }
    const name = keyNameFromSequence(sequence);
    const modalName = modalKeyNameFromSequence(sequence);
    if (routeModalRawSequence(sequence)) {
      traceKeyRoute("raw", modalName || name, "modal");
      return true;
    }
    if (routeRunningCancel(name)) return true;
    if (routeRunningQueue(modalName)) return true;
    if (cycleModeFromRawSequence(sequence)) {
      traceKeyRoute("raw", name, "mode_cycle");
      return true;
    }
    traceKeyRoute("raw", name, "unhandled");
    return false;
  }

  function routeGlobalKeyEvent(event: any) {
    if (routeCtrlCExit(event)) {
      traceKeyRoute("key", "ctrl-c", "exit");
      return true;
    }
    const name = keyNameFromEvent(event);
    if (routeModalKey(event)) {
      traceKeyRoute("key", name, "modal");
      return true;
    }
    if (routeRunningCancel(name, event)) return true;
    if (routeRunningQueue(name, event)) return true;
    // Ctrl+Shift+M opens the MCP reconnect picker. Shift is required because
    // bare Ctrl+M is Enter on most terminals (historical TTY mapping).
    if (event.ctrl && event.shift && name === "m") {
      openMcpReconnectPicker();
      event.preventDefault?.();
      traceKeyRoute("key", name, "mcp_picker");
      return true;
    }
    if (event.ctrl && name === "t" && !picker) {
      toggleThinkingVisibility();
      event.preventDefault?.();
      traceKeyRoute("key", name, "toggle_thinking");
      return true;
    }
    if (event.ctrl && name === "o" && !picker) {
      toggleVerboseTrace();
      event.preventDefault?.();
      traceKeyRoute("key", name, "toggle_verbose_trace");
      return true;
    }
    if (cycleModeFromKey(event)) {
      traceKeyRoute("key", name, "mode_cycle");
      return true;
    }
    if (event.ctrl && name === "p" && !picker && !isRunning()) {
      openCommandPalette();
      event.preventDefault?.();
      traceKeyRoute("key", name, "command_palette");
      return true;
    }
    traceKeyRoute("key", name, "unhandled");
    return false;
  }

  function transcriptOptions() {
    return {
      cwd: props.args.cwd,
      width: contentWidth(),
      tip: homeTip,
      plan: pendingPlan()?.plan,
      selectedOption: approvalOptionIdx(),
      showThinking: effectiveShowThinking(),
      verboseTrace: verboseTrace(),
      onToggleWrite: (key: string) => {
        if (transcriptState.expandedWrites.has(key)) {
          transcriptState.expandedWrites.delete(key);
        } else {
          transcriptState.expandedWrites.add(key);
        }
        syncSessionMessages();
      },
      onToggleCompaction: (key: string) => {
        if (transcriptState.expandedCompactions.has(key)) {
          transcriptState.expandedCompactions.delete(key);
        } else {
          transcriptState.expandedCompactions.add(key);
        }
        syncSessionMessages();
      },
    };
  }

  function toggleThinkingVisibility() {
    if (!currentTranscriptMessages(streamingDisplay).some((message) => !!message.reasoning?.trim())) {
      setNotice("No thinking blocks to toggle");
      return;
    }
    setShowThinking((prev) => {
      const next = !prev;
      setNotice(next ? "Thinking blocks visible" : "Thinking blocks hidden");
      return next;
    });
    redrawTranscript();
  }

  function toggleVerboseTrace() {
    setVerboseTrace((prev) => {
      const next = !prev;
      setNotice(next ? "Verbose trace visible" : "Compact trace visible");
      return next;
    });
    syncTraceChrome();
    redrawTranscript();
  }

  function toggleVisibleWriteBlocks() {
    const keys = collectVisibleWriteKeys();
    if (!keys.length) {
      setNotice("No write previews to toggle");
      return;
    }
    const shouldExpand = keys.some((key) => !transcriptState.expandedWrites.has(key));
    transcriptState.defaultWritesExpanded = shouldExpand;
    for (const key of keys) {
      if (shouldExpand) transcriptState.expandedWrites.add(key);
      else transcriptState.expandedWrites.delete(key);
    }
    setNotice(shouldExpand ? "Write previews expanded" : "Write previews collapsed");
    syncSessionMessages();
  }

  function collectVisibleWriteKeys() {
    const messages = currentTranscriptMessages(streamingDisplay)
      .filter((message) => hasRenderableMessage(message, effectiveShowThinking()));
    const keys: string[] = [];
    for (const [index, message] of messages.entries()) {
      const messageKey = transcriptMessageKey(message, index);
      for (const tool of message.toolCalls ?? []) {
        if (isWritePreviewTool(tool)) {
          keys.push(writeToolKey(messageKey, tool));
        }
      }
    }
    return keys;
  }

  function syncSessionMessages(messages = currentTranscriptMessages(streamingDisplay)) {
    if (!transcriptHost) return;
    updateTranscriptHost(transcriptHost, transcriptState, messages, transcriptOptions(), props.syntaxStyle, props.subtleSyntaxStyle);
    syncPromptSurfaces();
  }

  function redrawTranscript(
    extra?: DisplayMessage,
    baseMessages = displayMessages,
  ) {
    streamingDisplay = extra;
    renderTranscriptNow(streamingDisplay, baseMessages);
  }

  function renderTranscriptNow(extra?: DisplayMessage, baseMessages = displayMessages) {
    const shouldFollow = shouldFollowTranscriptBeforeUpdate();
    const nextMessages = compactDisplayMessages([
      ...baseMessages,
      ...(extra ? [extra] : []),
      ...queuedDisplayMessages,
    ]);
    syncSessionMessages(nextMessages);
    rootBox?.requestRender();
    scrollbox?.requestRender();
    scheduleTranscriptScrollAfterUpdate(shouldFollow);
  }

  createEffect(() => {
    const shouldFollow = shouldFollowTranscriptBeforeUpdate();
    dimensions();
    sessionActive();
    syncSidebarChrome();
    redrawQuestionPanel();
    redrawStatsPanel();
    redrawFeishuSetupPanel();
    scrollbox?.requestRender();
    scheduleTranscriptScrollAfterUpdate(shouldFollow);
  });

  function redrawDock() {
    if (dock) {
      dock.content = formatDock({
        picker,
        plan: pendingPlan()?.plan,
        selectedOption: approvalOptionIdx(),
      });
    }
    redrawApprovalPanel();
    redrawQuestionPanel();
    const state = picker?.kind === "select" && !picker.loading ? picker : undefined;
    const stateMode = state?.mode;
    const inlinePicker = stateMode === "slash" || stateMode === "file";
    const pickerHeight = state ? selectHeight(state, inlinePicker ? inlinePickerAvailableRows() : undefined) : 0;
    if (selectList) {
      selectList.visible = !!state && !inlinePicker;
      selectList.options = state && !inlinePicker ? state.items.map(toSelectOption) : [];
      selectList.selectedIndex = state ? state.index : 0;
      selectList.height = state && !inlinePicker ? pickerHeight : 0;
      selectList.backgroundColor = theme.background;
      selectList.textColor = theme.text;
      selectList.focusedTextColor = theme.text;
      selectList.selectedBackgroundColor = theme.backgroundElement;
      selectList.selectedTextColor = theme.primary;
      selectList.descriptionColor = theme.textMuted;
      selectList.selectedDescriptionColor = theme.text;
      selectList.showDescription = !!state;
      selectList.showScrollIndicator = true;
      selectList.requestRender();
    }
    if (pickerFrame) {
      pickerFrame.visible = !!state;
      pickerFrame.border = inlinePicker ? ["left", "right"] : false;
      pickerFrame.borderColor = inlinePicker ? theme.border : theme.background;
      pickerFrame.backgroundColor = inlinePicker ? theme.backgroundElement : "#00000000";
      pickerFrame.position = inlinePicker ? "absolute" : undefined;
      pickerFrame.zIndex = inlinePicker ? 1000 : 0;
      if (inlinePicker) {
        const geometry = inlinePickerGeometry(pickerHeight);
        pickerFrame.left = geometry.left;
        pickerFrame.top = geometry.top;
        pickerFrame.width = geometry.width;
        pickerFrame.height = geometry.height;
      } else {
      pickerFrame.left = undefined;
      pickerFrame.top = undefined;
      pickerFrame.width = "auto";
      pickerFrame.height = "auto";
    }
    pickerFrame.title = state?.title;
      pickerFrame.requestRender();
    }
    redrawInlinePickerRows(state, inlinePicker, pickerHeight);
    dock?.requestRender();
  }

  function openProviderDialog(step: ProviderDialogStep = "providers", providerId?: string) {
    if (step === "models") {
      providerDialogModelItems = undefined;
    } else {
      providerDialogModelRefreshId++;
      providerDialogModelItems = undefined;
    }
    const items = providerDialogItemsFor(step, providerId);
    picker = undefined;
    providerDialog = {
      step,
      providerId,
      query: "",
      index: step === "models" ? preferredPickerIndex("model", items) : 0,
      apiKey: "",
    };
    activePrompt()?.clear();
    activePrompt()?.blur();
    promptText = "";
    redrawDock();
    redrawProviderDialog();
    setTimeout(() => providerDialogInput?.focus(), 0);
    if (step === "models") {
      void refreshProviderDialogModelItems(providerId, items);
    }
  }

  function closeProviderDialog() {
    providerDialog = undefined;
    providerDialogModelRefreshId++;
    providerDialogModelItems = undefined;
    providerDialogRoot && (providerDialogRoot.visible = false);
    providerDialogPanel && (providerDialogPanel.visible = false);
    providerDialogRoot?.requestRender();
    setTimeout(() => activePrompt()?.focus(), 0);
    if (queuedInputCount() > 0) scheduleQueuedInputDrain();
  }

  function providerDialogItemsFor(step: ProviderDialogStep, providerId?: string) {
    if (step === "providers") return buildProviderConnectItems();
    if (step === "auth") return providerId ? buildPickerItems("provider-auth", providerId) : [];
    if (step === "skills") return buildSkillItems();
    if (step === "models") {
      if (providerDialogModelItems?.key === modelPickerCacheKey(providerId)) {
        return providerDialogModelItems.items;
      }
      const modelItems = buildPickerItems("model", providerId);
      if (modelItems.length || providerId) return modelItems;
      return buildProviderConnectItems()
        .filter((item) => item.category === "Popular")
        .slice(0, 6)
        .map((item) => ({ ...item, category: "Popular providers" }));
    }
    return [];
  }

  function modelPickerCacheKey(providerId?: string): string {
    return providerId || "__all__";
  }

  async function refreshProviderDialogModelItems(providerId: string | undefined, localItems: PickerItem[]) {
    const refreshId = ++providerDialogModelRefreshId;
    const cacheKey = modelPickerCacheKey(providerId);
    const localPreferredIndex = preferredPickerIndex("model", localItems);

    try {
      const remoteItems = await buildRemoteModelPickerItems(providerId);
      if (refreshId !== providerDialogModelRefreshId) return;
      if (remoteItems.length === 0) return;

      const state = providerDialog;
      if (!state || state.step !== "models" || modelPickerCacheKey(state.providerId) !== cacheKey) return;

      providerDialogModelItems = { key: cacheKey, items: remoteItems };
      const remotePreferredIndex = preferredPickerIndex("model", remoteItems);
      const nextIndex = state.index === localPreferredIndex
        ? remotePreferredIndex
        : Math.min(state.index, Math.max(0, remoteItems.length - 1));
      providerDialog = { ...state, index: nextIndex };
      redrawProviderDialog();
    } catch {
      // Keep the already-rendered local catalog when remote model discovery fails.
    }
  }

  function providerDialogFilteredItems(state = providerDialog) {
    if (!state || state.step === "key") return [];
    const items = providerDialogItemsFor(state.step, state.providerId);
    const query = state.query.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => {
      const haystack = [
        item.label,
        item.detail,
        item.value,
        item.category,
        item.footer,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query) || fuzzyMatch(haystack, query);
    });
  }

  function providerDialogVisibleRows(state = providerDialog): ProviderDialogRow[] {
    if (!state) return [];
    if (state.step === "key") {
      return [{
        type: "empty",
        label: "Paste or type the API key, then press Enter.",
        detail: state.error,
      }];
    }

    const items = providerDialogFilteredItems(state);
    if (!items.length) return [{ type: "empty", label: "No matching options" }];

    const allRows: ProviderDialogRow[] = [];
    let lastCategory = "";
    const flatten = !!state.query.trim();
    items.forEach((item, optionIndex) => {
      const category = item.category || "";
      if (!flatten && category && category !== lastCategory) {
        allRows.push({ type: "category", label: category });
        lastCategory = category;
      }
      allRows.push({ type: "item", item, optionIndex });
    });

    const selectedRow = Math.max(0, allRows.findIndex((row) => row.type === "item" && row.optionIndex === state.index));
    const maxStart = Math.max(0, allRows.length - PROVIDER_DIALOG_ROWS);
    const start = Math.min(maxStart, Math.max(0, selectedRow - Math.floor(PROVIDER_DIALOG_ROWS / 2)));
    return allRows.slice(start, start + PROVIDER_DIALOG_ROWS);
  }

  function redrawProviderDialog() {
    const state = providerDialog;
    if (!providerDialogRoot) return;
    if (!state) {
      providerDialogRoot.visible = false;
      providerDialogPanel && (providerDialogPanel.visible = false);
      providerDialogRoot.requestRender();
      return;
    }

    const width = Math.max(48, Math.min(60, dimensions().width - 2));
    const height = PROVIDER_DIALOG_ROWS + 7;
    providerDialogRoot.visible = true;
    providerDialogRoot.width = dimensions().width;
    providerDialogRoot.height = dimensions().height;
    providerDialogRoot.left = 0;
    providerDialogRoot.top = 0;
    providerDialogRoot.backgroundColor = modalBackdropColor();
    if (providerDialogPanel) {
      providerDialogPanel.visible = true;
      providerDialogPanel.width = width;
      providerDialogPanel.height = height;
      providerDialogPanel.left = Math.max(0, Math.floor((dimensions().width - width) / 2));
      providerDialogPanel.top = Math.max(0, Math.floor(dimensions().height / 4));
      providerDialogPanel.backgroundColor = theme.backgroundPanel;
      providerDialogPanel.borderColor = theme.backgroundPanel;
      providerDialogPanel.requestRender();
    }

    if (providerDialogTitle) providerDialogTitle.content = providerDialogTitleFor(state);
    if (providerDialogEsc) providerDialogEsc.content = "esc";
    if (providerDialogInput) {
      providerDialogInput.placeholder = state.step === "key" ? "API key" : "Search";
      const value = state.step === "key" ? state.apiKey : state.query;
      if (providerDialogInput.value !== value) providerDialogInput.value = value;
    }

    const rows = providerDialogVisibleRows(state);
    for (let i = 0; i < PROVIDER_DIALOG_ROWS; i += 1) {
      const row = rows[i];
      const rowBox = providerDialogRows[i];
      const gutter = providerDialogGutters[i];
      const label = providerDialogLabels[i];
      const detail = providerDialogDetails[i];
      const footer = providerDialogFooters[i];
      if (rowBox) {
        rowBox.visible = !!row;
        rowBox.backgroundColor = row?.type === "item" && row.optionIndex === state.index
          ? theme.primary
          : theme.backgroundPanel;
      }
      if (!row) {
        if (gutter) gutter.content = "";
        if (label) label.content = "";
        if (detail) detail.content = "";
        if (footer) footer.content = "";
        continue;
      }
      const active = row.type === "item" && row.optionIndex === state.index;
      const activeText = contrastText(theme.primary);
      if (row.type === "category") {
        if (gutter) gutter.content = "";
        if (label) {
          label.content = row.label;
          label.fg = theme.accent;
        }
        if (detail) detail.content = "";
        if (footer) footer.content = "";
      } else if (row.type === "empty") {
        if (gutter) gutter.content = "";
        if (label) {
          label.content = row.label;
          label.fg = row.detail ? theme.error : theme.textMuted;
        }
        if (detail) {
          detail.content = row.detail ?? "";
          detail.fg = theme.error;
        }
        if (footer) footer.content = "";
      } else {
        if (gutter) {
          gutter.content = row.item.gutter ?? (isCurrentModelItem(row.item) ? "●" : " ");
          gutter.fg = active ? activeText : providerDialogGutterColor(row.item.gutter ?? (isCurrentModelItem(row.item) ? "●" : undefined));
        }
        if (label) {
          label.content = truncate(row.item.label, providerDialogLabelWidth(state));
          label.fg = active ? activeText : isCurrentModelItem(row.item) ? theme.primary : theme.text;
        }
        if (detail) {
          const detailText = state.query.trim() && state.step === "models"
            ? row.item.category ?? row.item.detail ?? ""
            : row.item.detail ?? "";
          detail.width = providerDialogDetailWidth(state);
          detail.content = truncate(detailText, providerDialogDetailWidth(state));
          detail.fg = active ? activeText : theme.textMuted;
        }
        if (footer) {
          footer.width = providerDialogFooterWidth(state);
          footer.content = row.item.footer ?? "";
          footer.fg = active ? activeText : theme.textMuted;
        }
      }
      rowBox?.requestRender();
    }

    if (providerDialogFooter) providerDialogFooter.content = providerDialogFooterFor(state);
    providerDialogList?.requestRender();
    providerDialogRoot.requestRender();
  }

  function providerDialogTitleFor(state: ProviderDialogState) {
    if (state.step === "providers") return "Connect a provider";
    if (state.step === "skills") return "Select skill";
    const provider = providerDisplayName(state.providerId);
    if (state.step === "auth") return `${provider} auth method`;
    if (state.step === "key") return `${provider} API key`;
    if (!state.providerId) return "Select model";
    return `${provider} models`;
  }

  function providerDialogFooterFor(state: ProviderDialogState) {
    if (state.step === "key") return "enter save · esc back";
    const items = providerDialogFilteredItems(state);
    const count = items.length ? ` ${Math.min(state.index + 1, items.length)}/${items.length}` : "";
    if (state.step === "models") {
      const connect = state.providerId ? "" : " · ctrl+o providers";
      return `↑/↓ move · enter select · esc close${connect}${count}`;
    }
    if (state.step === "skills") return `↑/↓ move · enter insert · esc close${count}`;
    const escLabel = state.step === "providers" ? "esc close" : "esc back";
    return `↑/↓ move · enter select · ${escLabel}${count}`;
  }

  function providerDialogGutterColor(gutter?: string) {
    if (gutter === "●") return theme.primary;
    if (gutter === "✓") return theme.success;
    if (gutter === "○") return theme.warning;
    return theme.textMuted;
  }

  function providerDialogLabelWidth(state: ProviderDialogState) {
    return state.step === "skills" ? 22 : 37;
  }

  function providerDialogDetailWidth(state: ProviderDialogState) {
    return state.step === "skills" ? 26 : 16;
  }

  function providerDialogFooterWidth(state: ProviderDialogState) {
    return state.step === "skills" ? 9 : 8;
  }

  function isCurrentModelItem(item: PickerItem) {
    return item.value === props.agent.model || item.detail?.includes("current");
  }

  function providerDisplayName(providerId?: string) {
    if (!providerId) return "Provider";
    return registry.getConfigured().find((provider) => provider.id === providerId)?.name
      ?? BUILTIN_PROVIDERS.find((provider) => provider.id === providerId)?.name
      ?? providerId;
  }

  function updateProviderDialogFromMouse(rowIndex: number, confirm = false) {
    const state = providerDialog;
    if (!state || state.step === "key") return;
    const row = providerDialogVisibleRows(state)[rowIndex];
    if (!row || row.type !== "item") return;
    providerDialog = { ...state, index: row.optionIndex };
    redrawProviderDialog();
    if (confirm) void runProviderDialogSelection();
  }

  function updateProviderDialogFromScroll(event: any) {
    const direction = event?.scroll?.direction;
    if (direction === "up") {
      moveProviderDialogSelection(-1);
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }
    if (direction === "down") {
      moveProviderDialogSelection(1);
      event.preventDefault?.();
      event.stopPropagation?.();
    }
  }

  function moveProviderDialogSelection(delta: number) {
    const state = providerDialog;
    if (!state || state.step === "key") return false;
    const items = providerDialogFilteredItems(state);
    if (!items.length) return false;
    let next = state.index + delta;
    while (next < 0) next += items.length;
    next %= items.length;
    providerDialog = { ...state, index: next };
    redrawProviderDialog();
    return true;
  }

  function handleProviderDialogKey(event: any): boolean {
    const state = providerDialog;
    if (!state) return false;
    const name = String(event.name || "").toLowerCase();
    if (name === "escape") {
      if (state.step === "auth") {
        openProviderDialog("providers");
      } else if (state.step === "key") {
        openProviderDialog(state.providerId && registry.supportsOAuth(state.providerId) ? "auth" : "providers", state.providerId);
      } else if (state.step === "models" || state.step === "skills") {
        closeProviderDialog();
      } else {
        closeProviderDialog();
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (state.step !== "key") {
      const items = providerDialogFilteredItems(state);
      if (state.step === "models" && event.ctrl && name === "o") {
        openProviderDialog("providers");
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (name === "up" || (event.ctrl && name === "p")) {
        moveProviderDialogSelection(-1);
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (name === "down" || (event.ctrl && name === "n")) {
        moveProviderDialogSelection(1);
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (name === "pageup") {
        providerDialog = { ...state, index: Math.max(0, state.index - 10) };
        redrawProviderDialog();
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (name === "pagedown") {
        providerDialog = { ...state, index: Math.min(Math.max(0, items.length - 1), state.index + 10) };
        redrawProviderDialog();
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (name === "home") {
        providerDialog = { ...state, index: 0 };
        redrawProviderDialog();
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
      if (name === "end") {
        providerDialog = { ...state, index: Math.max(0, items.length - 1) };
        redrawProviderDialog();
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
    }
    if (name === "return" || name === "enter") {
      void runProviderDialogSelection();
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    return false;
  }

  async function runProviderDialogSelection() {
    const state = providerDialog;
    if (!state) return;
    if (state.step === "key") {
      const providerId = state.providerId;
      const apiKey = state.apiKey.trim();
      if (!providerId) return;
      if (!apiKey) {
        providerDialog = { ...state, error: "API key is required." };
        redrawProviderDialog();
        return;
      }
      await executeSlash(`/key ${providerId} ${apiKey}`);
      openProviderDialog("models", providerId);
      return;
    }

    const items = providerDialogFilteredItems(state);
    const item = items[state.index];
    if (!item) return;

    if (state.step === "providers") {
      if (item.next === "auth") {
        openProviderDialog("auth", item.value);
        return;
      }
      if (item.next === "key") {
        ensureProviderConfiguredForKey(item.value);
        openProviderDialog("key", item.value);
        return;
      }
      await executeSlash(item.command);
      openProviderDialog("models", item.value);
      return;
    }

    if (state.step === "auth") {
      if (item.next === "key") {
        ensureProviderConfiguredForKey(item.value);
        openProviderDialog("key", item.value);
        return;
      }
      await executeSlash(item.command);
      openProviderDialog("models", item.value);
      return;
    }

    if (state.step === "models") {
      if (item.next === "auth") {
        openProviderDialog("auth", item.value);
        return;
      }
      if (item.next === "key") {
        ensureProviderConfiguredForKey(item.value);
        openProviderDialog("key", item.value);
        return;
      }
      if (item.after) {
        await executeSlash(item.command);
        openProviderDialog("models", item.after.providerId);
        return;
      }
      closeProviderDialog();
      await executeSlash(item.command);
      return;
    }

    if (state.step === "skills") {
      closeProviderDialog();
      insertSkillPrompt(item.value);
    }
  }

  function ensureProviderConfiguredForKey(providerId: string) {
    if (!registry.getConfigured().some((provider) => provider.id === providerId)) {
      registry.addProvider(providerId, "");
    }
    registry.setDefault(providerId);
  }

  function redrawQuestionPanel() {
    if (!questionRoot) return;
    const state = pendingQuestion();
    if (!state || pendingApproval()) {
      questionRoot.visible = false;
      questionRoot.requestRender();
      return;
    }

    const q = questionAt(state);
    const single = isSingleQuestion(state);
    const confirm = isQuestionConfirmTab(state);
    const optionTotal = questionOptionTotal(state);

    questionRoot.visible = true;
    questionRoot.height = questionPanelHeight(state);

    if (questionTabsRow) questionTabsRow.visible = !single;
    for (let index = 0; index < QUESTION_MAX_TABS; index++) {
      const box = questionTabBoxes[index];
      const text = questionTabTexts[index];
      if (!box || !text) continue;
      const label = index < state.request.questions.length
        ? state.request.questions[index]?.header
        : index === state.request.questions.length
          ? "Confirm"
          : "";
      const active = index === state.tab;
      const answered = index < state.request.questions.length && (state.answers[index]?.length ?? 0) > 0;
      box.visible = !single && !!label;
      box.backgroundColor = active ? theme.accent : theme.backgroundPanel;
      text.content = label || "";
      text.fg = active ? contrastText(theme.accent) : answered ? theme.text : theme.textMuted;
    }

    if (questionPromptText) {
      questionPromptText.visible = !confirm;
      questionPromptText.content = q ? `${q.question}${q.multiple ? " (select all that apply)" : ""}` : "";
    }
    if (questionOptionsShell) questionOptionsShell.visible = !confirm;

    for (let index = 0; index < QUESTION_MAX_OPTIONS; index++) {
      const row = questionOptionRows[index];
      const indexText = questionOptionIndexTexts[index];
      const labelText = questionOptionLabelTexts[index];
      const descriptionText = questionOptionDescriptionTexts[index];
      const checkText = questionOptionCheckTexts[index];
      if (!row || !indexText || !labelText || !descriptionText || !checkText) continue;

      const visible = !confirm && !!q && index < optionTotal;
      row.visible = visible;
      if (!visible || !q) {
        indexText.content = "";
        labelText.content = "";
        descriptionText.content = "";
        checkText.content = "";
        continue;
      }

      const active = index === state.selected;
      const isCustom = questionCustomAllowed(q) && index === q.options.length;
      const option = q.options[index];
      const customValue = state.custom[state.tab]?.trim() ?? "";
      const label = isCustom ? "Type your own answer" : option?.label ?? "";
      const picked = isCustom
        ? questionCustomPicked(state)
        : (state.answers[state.tab]?.includes(label) ?? false);
      const multi = q.multiple === true;

      row.backgroundColor = active ? theme.backgroundElement : theme.backgroundPanel;
      indexText.content = `${index + 1}.`;
      indexText.fg = active ? theme.secondary : theme.textMuted;
      labelText.content = `${multi ? `[${picked ? "✓" : " "}] ` : ""}${label}`;
      labelText.fg = active ? theme.secondary : picked ? theme.success : theme.text;
      descriptionText.content = isCustom
        ? customValue ? `Custom: ${customValue}` : "Enter a different answer."
        : option?.description ?? "";
      descriptionText.fg = theme.textMuted;
      checkText.content = !multi && picked ? "✓" : "";
      checkText.fg = theme.success;
    }

    if (questionCustomEditorShell) questionCustomEditorShell.visible = !confirm && !!q && state.editing;
    if (questionCustomInput && q) {
      const customValue = state.custom[state.tab] ?? "";
      if (questionCustomInput.plainText !== customValue) questionCustomInput.setText(customValue);
      if (!state.editing) {
        try { questionCustomInput.blur(); } catch {}
      }
    }

    if (questionConfirmShell) questionConfirmShell.visible = confirm;
    for (let index = 0; index < QUESTION_MAX_CONFIRM_ROWS; index++) {
      const text = questionConfirmTexts[index];
      if (!text) continue;
      const question = state.request.questions[index];
      text.visible = confirm && !!question;
      if (!question) {
        text.content = "";
        continue;
      }
      const value = state.answers[index]?.join(", ") ?? "";
      text.content = `${question.header}: ${value || "(not answered)"}`;
      text.fg = value ? theme.text : theme.error;
    }

    if (questionFooterTab) {
      questionFooterTab.visible = !single;
      questionFooterTab.content = "⇆ tab";
    }
    if (questionFooterSelect) {
      questionFooterSelect.visible = !confirm;
      questionFooterSelect.content = "↑↓ select";
    }
    if (questionFooterEnter) {
      const enterHint = confirm ? "submit" : q?.multiple ? "toggle" : single ? "submit" : "confirm";
      questionFooterEnter.content = `enter ${enterHint}`;
    }
    if (questionFooterEsc) questionFooterEsc.content = "esc dismiss";

    questionRoot.requestRender();
    questionCustomInput?.requestRender();
  }

  function redrawFeedbackPanel() {
    if (!feedbackRoot) return;
    const state = pendingFeedback();
    if (!state) {
      feedbackRoot.visible = false;
      feedbackRoot.requestRender();
      return;
    }

    const stats = feedbackTranscriptStats(state.base);
    feedbackRoot.visible = true;
    feedbackRoot.height = Math.min(
      Math.max(12, state.showPreview ? 20 : 13),
      Math.max(10, dimensions().height - 5),
    );

    if (feedbackInput) {
      feedbackInput.visible = state.stage === "edit";
      if (feedbackInput.plainText !== state.description) feedbackInput.setText(state.description);
    }
    if (feedbackMetaText) {
      feedbackMetaText.content = `Includes v${state.base.version} · ${state.base.platform}/${state.base.arch} · ${state.base.provider}/${state.base.model} · ${stats.count} messages (${stats.totalChars} chars, redacted)`;
    }
    if (feedbackPreviewShell) feedbackPreviewShell.visible = state.showPreview && state.stage === "edit";
    if (feedbackPreviewText) feedbackPreviewText.content = state.showPreview ? formatFeedbackPreviewText(state.base) : "";
    if (feedbackStatusText) {
      const result = state.result;
      feedbackStatusText.visible = !!state.status || state.stage !== "edit";
      feedbackStatusText.fg = result?.kind === "error" ? theme.error : result?.kind === "success" ? theme.success : state.status ? theme.warning : theme.textMuted;
      feedbackStatusText.content =
        state.stage === "submitting"
          ? "Sending feedback..."
          : result?.kind === "success"
            ? `Feedback submitted. Issue #${result.number}: ${result.url}`
            : result?.kind === "error"
              ? `Feedback failed: ${result.message}`
              : state.status ?? "";
    }
    if (feedbackFooterText) {
      feedbackFooterText.content = state.stage === "done"
        ? "enter dismiss · esc dismiss"
        : state.stage === "submitting"
          ? "submitting..."
          : `ctrl+d submit · tab ${state.showPreview ? "hide" : "view"} payload · enter newline · esc cancel`;
    }

    feedbackRoot.requestRender();
    feedbackInput?.requestRender();
  }

  function redrawStatsPanel() {
    if (!statsRoot) return;
    const state = statsPanel;
    if (!state) {
      statsRoot.visible = false;
      statsPanelBox && (statsPanelBox.visible = false);
      statsRoot.requestRender();
      return;
    }

    const terminalWidth = dimensions().width;
    const terminalHeight = dimensions().height;
    const width = Math.max(56, Math.min(84, terminalWidth - 4));
    const bodyWidth = Math.max(48, width - 8);
    const stats = state.bundle.ranges[state.range];
    const body = formatStatsPanelBody(stats, bodyWidth);
    const bodyLines = body.split("\n");
    const height = Math.min(
      Math.max(22, bodyLines.length + 7),
      Math.max(18, terminalHeight - 4),
    );
    const bodyHeight = Math.max(8, height - 8);

    statsRoot.visible = true;
    statsRoot.width = terminalWidth;
    statsRoot.height = terminalHeight;
    statsRoot.left = 0;
    statsRoot.top = 0;
    statsRoot.backgroundColor = modalBackdropColor();

    if (statsPanelBox) {
      statsPanelBox.visible = true;
      statsPanelBox.width = width;
      statsPanelBox.height = height;
      statsPanelBox.left = Math.max(0, Math.floor((terminalWidth - width) / 2));
      statsPanelBox.top = Math.max(0, Math.floor((terminalHeight - height) / 3));
      statsPanelBox.backgroundColor = theme.backgroundPanel;
      statsPanelBox.borderColor = theme.backgroundPanel;
    }
    if (statsTitle) statsTitle.content = "Stats";
    if (statsEsc) statsEsc.content = "esc";
    syncStatsTab(statsTab7Box, statsTab7Text, state.range === "7d", "7 days");
    syncStatsTab(statsTab30Box, statsTab30Text, state.range === "30d", "30 days");
    if (statsBodyText) {
      statsBodyText.content = statsPanelBodyStyledText(stats, bodyWidth);
      statsBodyText.width = bodyWidth;
    }
    if (statsBodyScroll) {
      statsBodyScroll.width = bodyWidth;
      statsBodyScroll.height = bodyHeight;
      statsBodyScroll.requestRender();
    }
    if (statsFooterText) {
      statsFooterText.content = statsFooterHint(state.range);
      statsFooterText.width = bodyWidth;
      statsFooterText.bg = theme.backgroundPanel;
    }

    statsPanelBox?.requestRender();
    statsRoot.requestRender();
  }

  function statsFooterHint(range: StatsRange) {
    return `left/right:range|tab:toggle|esc:close|view:${range}`;
  }

  function statsPanelBodyStyledText(stats: UsageStats, width: number): StyledText {
    const chunks = [];
    const lines = formatStatsPanelBody(stats, width).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      appendStatsPanelLine(chunks, lines[index]);
      if (index < lines.length - 1) chunks.push(fg(theme.text)("\n"));
    }
    return new StyledText(chunks);
  }

  function appendStatsPanelLine(chunks: any[], line: string) {
    if (isStatsHeatmapWeekdayLine(line)) {
      chunks.push(fg(theme.text)(line.slice(0, 5)));
      appendStatsHeatmapDots(chunks, line.slice(5));
      return;
    }
    if (line.trim() === "Less . o O @ More") {
      appendStatsHeatmapLegend(chunks, line.length - line.trimStart().length);
      return;
    }
    chunks.push(fg(theme.text)(line));
  }

  function isStatsHeatmapWeekdayLine(line: string) {
    return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)  /.test(line);
  }

  function appendStatsHeatmapDots(chunks: any[], text: string) {
    const colors = statsHeatmapDotColors();
    const colorByLevel: Record<string, string> = {
      ".": colors[0],
      o: colors[1],
      O: colors[2],
      "@": colors[3],
    };
    for (const char of text) {
      const color = colorByLevel[char];
      chunks.push(color ? fg(color)("•") : fg(theme.text)(char));
    }
  }

  function appendStatsHeatmapLegend(chunks: any[], indent: number) {
    const colors = statsHeatmapDotColors();
    chunks.push(fg(theme.textMuted)(`${" ".repeat(indent)}Less `));
    colors.forEach((color, index) => {
      if (index > 0) chunks.push(fg(theme.textMuted)(" "));
      chunks.push(fg(color)("•"));
    });
    chunks.push(fg(theme.textMuted)(" More"));
  }

  function statsHeatmapDotColors(): [string, string, string, string] {
    return isLightTheme()
      ? ["#D9B98E", "#BE7D37", "#A56218", theme.warning]
      : ["#6B471D", "#9D6728", "#D18830", theme.warning];
  }

  function syncStatsTab(
    box: BoxRenderable | undefined,
    text: TextRenderable | undefined,
    active: boolean,
    label: string,
  ) {
    if (box) box.backgroundColor = active ? theme.primary : theme.backgroundElement;
    if (text) {
      text.content = label;
      text.fg = active ? contrastText(theme.primary) : theme.textMuted;
    }
  }

  function redrawFeishuSetupPanel() {
    if (!feishuSetupRoot) return;
    const state = pendingFeishuSetup();
    if (!state) {
      feishuSetupRoot.visible = false;
      feishuSetupPanel && (feishuSetupPanel.visible = false);
      feishuSetupInput?.blur();
      feishuSetupRoot.requestRender();
      return;
    }

    const width = Math.max(52, Math.min(78, dimensions().width - 4));
    const height = feishuSetupPanelHeight(state);
    feishuSetupRoot.visible = true;
    feishuSetupRoot.width = dimensions().width;
    feishuSetupRoot.height = dimensions().height;
    feishuSetupRoot.left = 0;
    feishuSetupRoot.top = 0;
    feishuSetupRoot.backgroundColor = modalBackdropColor();
    if (feishuSetupPanel) {
      feishuSetupPanel.visible = true;
      feishuSetupPanel.width = width;
      feishuSetupPanel.height = height;
      feishuSetupPanel.left = Math.max(0, Math.floor((dimensions().width - width) / 2));
      feishuSetupPanel.top = Math.max(0, Math.floor((dimensions().height - height) / 3));
      feishuSetupPanel.backgroundColor = theme.backgroundPanel;
      feishuSetupPanel.borderColor = theme.info;
      feishuSetupPanel.requestRender();
    }
    if (feishuSetupTitle) feishuSetupTitle.content = "Feishu Setup Wizard";
    if (feishuSetupHint) feishuSetupHint.content = feishuSetupHintText(state);
    if (feishuSetupBodyText) {
      feishuSetupBodyText.content = feishuSetupBodyTextFor(state);
      feishuSetupBodyText.fg = state.kind === "error" ? theme.error : theme.text;
    }
    if (feishuSetupBodyScroll) {
      feishuSetupBodyScroll.height = Math.max(3, height - (state.kind === "binding" ? 8 : 6));
      feishuSetupBodyScroll.requestRender();
    }
    const binding = state.kind === "binding" ? state : undefined;
    if (feishuSetupInputShell) feishuSetupInputShell.visible = !!binding;
    if (feishuSetupInput) {
      feishuSetupInput.visible = !!binding;
      if (binding) {
        feishuSetupInput.placeholder = feishuSetupFieldPlaceholder(binding.field);
        feishuSetupInput.value = binding.values[binding.field];
      } else {
        feishuSetupInput.value = "";
      }
      feishuSetupInput.requestRender();
    }
    if (feishuSetupFooterText) feishuSetupFooterText.content = feishuSetupFooterTextFor(state);
    feishuSetupRoot.requestRender();
  }

  function feishuSetupPanelHeight(stage: FeishuSetupStage) {
    const desired = stage.kind === "qr_shown" ? 32 : stage.kind === "binding" ? 16 : 12;
    return Math.max(10, Math.min(desired, Math.max(10, dimensions().height - 3)));
  }

  function feishuSetupHintText(stage: FeishuSetupStage) {
    switch (stage.kind) {
      case "registering": return "Esc 取消";
      case "qr_shown": return "用手机飞书扫码 · Esc 取消";
      case "credentialed": return "Enter 绑定第一个 chat · Esc 跳过";
      case "binding": return "输入后 Enter 下一步 · Esc 跳过绑定";
      case "error": return "Enter 关闭";
    }
  }

  function feishuSetupFooterTextFor(stage: FeishuSetupStage) {
    switch (stage.kind) {
      case "registering": return "esc cancel";
      case "qr_shown": return "scan in Feishu mobile · esc cancel";
      case "credentialed": return "enter bind first chat · esc skip";
      case "binding": return stage.field === "displayName"
        ? "enter save · tab use default · esc skip"
        : "enter next · esc skip";
      case "error": return "enter close · esc close";
    }
  }

  function feishuSetupBodyTextFor(stage: FeishuSetupStage) {
    switch (stage.kind) {
      case "registering":
        return "正在向飞书申请注册码...";
      case "qr_shown":
        return [
          stage.status,
          "",
          stage.ascii.trimEnd(),
          "",
          "扫不到？也可以浏览器打开：",
          stage.url,
        ].join("\n");
      case "credentialed":
        return [
          "✅ 注册成功",
          `owner open_id: ${stage.ownerOpenId}`,
          "",
          "已写入 ~/.bubble/feishu/config.json + secrets.enc（加密）。",
          "下一步：把一个飞书 chat 绑定到本地目录？",
        ].join("\n");
      case "binding":
        return feishuSetupBindingBody(stage);
      case "error":
        return [
          `❌ ${stage.message}`,
          "",
          "按 Enter 关闭。可以稍后再 /feishu setup 重试。",
        ].join("\n");
    }
  }

  function feishuSetupBindingBody(stage: Extract<FeishuSetupStage, { kind: "binding" }>) {
    const fields: FeishuSetupField[] = ["chatId", "cwd", "displayName"];
    const lines: string[] = [];
    for (const field of fields) {
      const active = stage.field === field;
      const done = !active && feishuSetupFieldIndex(stage.field) > feishuSetupFieldIndex(field);
      const marker = active ? "›" : done ? "✓" : " ";
      const value = stage.values[field] || (active ? "(editing below)" : "");
      lines.push(`${marker} ${feishuSetupFieldLabel(field)}: ${value}`);
      if (active) {
        lines.push(`  ${feishuSetupFieldHelp(field)}`);
      }
    }
    if (stage.error) {
      lines.push("");
      lines.push(stage.error);
    }
    return lines.join("\n");
  }

  function feishuSetupFieldIndex(field: FeishuSetupField) {
    if (field === "chatId") return 0;
    if (field === "cwd") return 1;
    return 2;
  }

  function feishuSetupFieldLabel(field: FeishuSetupField) {
    if (field === "chatId") return "Chat ID";
    if (field === "cwd") return "本地 cwd";
    return "显示名";
  }

  function feishuSetupFieldPlaceholder(field: FeishuSetupField) {
    if (field === "chatId") return "oc_...";
    if (field === "cwd") return `${homedir()}/projects/my-app`;
    return "可空，默认目录名";
  }

  function feishuSetupFieldHelp(field: FeishuSetupField) {
    if (field === "chatId") return "飞书 chat 的 oc_ 开头 ID；不知道的话可以 Esc 跳过，先 /feishu start 后用 /feishu discover 获取。";
    if (field === "cwd") return "绝对路径或 ~/...，必须是已经存在的本地目录。";
    return "出现在飞书卡片顶栏的短标签；可空。";
  }

  function redrawApprovalPanel() {
    if (!approvalRoot) return;
    const approval = pendingApproval();
    if (!approval) {
      approvalRoot.visible = false;
      approvalRoot.requestRender();
      return;
    }

    const options = approvalOptionsFor(approval.request);
    const activeIndex = Math.min(approvalOptionIdx(), options.length - 1);
    const meta = getApprovalPanelMeta(approval.request);

    approvalRoot.visible = true;
    if (approvalHeaderTitle) approvalHeaderTitle.content = "Permission required";
    if (approvalMetaIcon) approvalMetaIcon.content = meta.icon;
    if (approvalMetaTitle) approvalMetaTitle.content = meta.title;
    if (approvalSubtitle) {
      approvalSubtitle.content = meta.subtitle ?? "";
      approvalSubtitle.visible = !!meta.subtitle;
    }
    if (approvalPreviewScroll) {
      approvalPreviewScroll.visible = !!meta.preview;
      approvalPreviewScroll.height = meta.previewHeight;
    }
    if (approvalPreviewText) {
      approvalPreviewText.content = meta.preview || "";
      approvalPreviewText.fg = meta.previewColor;
      approvalPreviewText.visible = !meta.diff;
    }
    if (approvalPreviewDiff) {
      approvalPreviewDiff.visible = !!meta.diff;
      if (meta.diff) {
        approvalPreviewDiff.diff = meta.diff;
        approvalPreviewDiff.view = diffViewMode(dimensions().width);
        approvalPreviewDiff.filetype = filetype(meta.path);
        approvalPreviewDiff.wrapMode = "word";
      }
    }

    for (let i = 0; i < approvalOptionBoxes.length; i++) {
      const box = approvalOptionBoxes[i];
      const text = approvalOptionTexts[i];
      const label = options[i];
      if (!box || !text) continue;
      box.visible = !!label;
      if (!label) continue;
      box.backgroundColor = i === activeIndex ? theme.warning : theme.backgroundPanel;
      text.content = label;
      text.fg = i === activeIndex ? contrastText(theme.warning) : theme.textMuted;
    }

    approvalRoot.requestRender();
    approvalPreviewScroll?.requestRender();
  }

  function inlinePickerAvailableRows() {
    const anchor = activeComposerShell();
    if (!anchor) return 10;
    const parentY = pickerFrame?.parent?.y ?? 0;
    return Math.max(1, anchor.y - parentY);
  }

  function inlinePickerGeometry(height: number) {
    const anchor = activeComposerShell();
    const parentX = pickerFrame?.parent?.x ?? 0;
    const parentY = pickerFrame?.parent?.y ?? 0;
    if (!anchor) {
      return { left: 0, top: 0, width: "100%" as const, height };
    }
    const availableRows = Math.max(1, anchor.y - parentY);
    const resolvedHeight = Math.max(1, Math.min(height, availableRows));
    return {
      left: Math.max(0, anchor.x - parentX),
      top: Math.max(0, anchor.y - parentY - resolvedHeight),
      width: anchor.width,
      height: resolvedHeight,
    };
  }

  function inlinePickerWindow(state: Extract<PickerState, { kind: "select" }>, height: number) {
    if (!state.items.length) {
      return [{ item: undefined, index: -1, label: "No matching items", detail: "" }];
    }
    const maxLabelWidth = Math.max(...state.items.map((item) => item.label.length));
    const visibleCount = Math.max(1, Math.min(height, state.items.length));
    const start = Math.min(
      Math.max(0, state.index - visibleCount + 1),
      Math.max(0, state.items.length - visibleCount),
    );
    return state.items.slice(start, start + visibleCount).map((item, offset) => ({
      item,
      index: start + offset,
      label: item.label.padEnd(maxLabelWidth + 2),
      detail: item.detail ? item.detail.replace(/\s+/g, " ") : "",
    }));
  }

  function redrawInlinePickerRows(
    state: Extract<PickerState, { kind: "select" }> | undefined,
    inlinePicker: boolean,
    height: number,
  ) {
    const rows = state && inlinePicker ? inlinePickerWindow(state, height) : [];
    for (let index = 0; index < 10; index += 1) {
      const row = inlinePickerRows[index];
      const label = inlinePickerLabels[index];
      const detail = inlinePickerDetails[index];
      const data = rows[index];
      const isSelected = !!data?.item && data.index === state?.index;
      if (row) {
        row.visible = !!data;
        row.backgroundColor = isSelected ? theme.primary : theme.backgroundElement;
        row.requestRender();
      }
      if (label) {
        label.content = data ? data.label : "";
        label.fg = data?.item
          ? (isSelected ? contrastText(theme.primary) : theme.text)
          : theme.textMuted;
        label.requestRender();
      }
      if (detail) {
        detail.content = data?.detail ?? "";
        detail.fg = isSelected ? contrastText(theme.primary) : theme.textMuted;
        detail.requestRender();
      }
    }
  }

  function updateInlinePickerFromMouse(rowIndex: number, confirm = false) {
    const state = picker?.kind === "select" && isInlinePicker(picker) ? picker : undefined;
    if (!state) return;
    const height = selectHeight(state, inlinePickerAvailableRows());
    const row = inlinePickerWindow(state, height)[rowIndex];
    if (!row?.item) return;
    picker = { ...state, index: row.index };
    redrawDock();
    if (confirm) void runPickerItem(row.item);
  }

  createEffect(() => {
    pendingPlan();
    pendingApproval();
    forceApprovalUI();
  });

  createEffect(() => {
    pendingFeedback();
    syncFeedbackUI();
  });

  function updatePickerFromMouse(event: any, confirm = false) {
    if (!picker || picker.kind !== "select" || !selectList || picker.items.length === 0) return;
    const list = selectList as any;
    const y = typeof event.y === "number" ? event.y : 0;
    const top = typeof list.y === "number" ? list.y : 0;
    const row = Math.max(0, y - top);
    const linesPerItem = 2;
    const visibleIndex = Math.floor(row / linesPerItem);
    const scrollOffset = typeof list.scrollOffset === "number" ? list.scrollOffset : 0;
    const next = Math.min(picker.items.length - 1, Math.max(0, scrollOffset + visibleIndex));
    picker.index = next;
    selectList.setSelectedIndex(next);
    redrawDock();
    if (confirm) {
      const item = picker.items[next];
      if (item) void runPickerItem(item);
    }
  }

  function handlePickerKey(event: any): boolean {
    const name = String(event.name || "").toLowerCase();
    if (picker?.kind === "key") {
      if (name === "escape") {
        closePicker();
        event.preventDefault?.();
        return true;
      }
      return false;
    }

    if (picker?.kind !== "select") return false;

    if (name === "up") {
      picker.index = Math.max(0, picker.index - 1);
      redrawDock();
      event.preventDefault?.();
      return true;
    }
    if (name === "down") {
      picker.index = Math.min(picker.items.length - 1, picker.index + 1);
      redrawDock();
      event.preventDefault?.();
      return true;
    }
    if (name === "pageup") {
      picker.index = Math.max(0, picker.index - 5);
      redrawDock();
      event.preventDefault?.();
      return true;
    }
    if (name === "pagedown") {
      picker.index = Math.min(picker.items.length - 1, picker.index + 5);
      redrawDock();
      event.preventDefault?.();
      return true;
    }
    if (name === "escape") {
      closePicker();
      event.preventDefault?.();
      return true;
    }
    if (name === "return" || name === "enter") {
      const item = picker.items[picker.index];
      if (item) void runPickerItem(item);
      event.preventDefault?.();
      return true;
    }
    if (name === "tab" && picker.mode === "file") {
      const item = picker.items[picker.index];
      if (item) applyFileSuggestion(item.value);
      event.preventDefault?.();
      return true;
    }
    // Inside the MCP reconnect picker, `r` is an alias for Enter — matches
    // the `[r]` hint shown in the sidebar row.
    if (name === "r" && picker.mode === "mcp-reconnect") {
      const item = picker.items[picker.index];
      if (item) void runPickerItem(item);
      event.preventDefault?.();
      return true;
    }
    return false;
  }

  function closePicker() {
    if (picker?.kind === "key" && picker.previous) {
      picker = picker.previous;
      activePrompt()?.clear();
      activePrompt()?.blur();
      redrawDock();
      return;
    }
    picker = undefined;
    redrawDock();
    setTimeout(() => activePrompt()?.focus(), 0);
    if (queuedInputCount() > 0) scheduleQueuedInputDrain();
  }

  const addMessage = (role: DisplayMessage["role"], content: string) => {
    const nextMessages = [...displayMessages, { role, content }];
    displayMessages = nextMessages;
    redrawTranscript(undefined, nextMessages);
  };

  const clearMessages = () => {
    displayMessages = [];
    streamingDisplay = undefined;
    promptHistory = [];
    resetPromptHistoryBrowse();
    clearQueuedComposerInputs();
    transcriptState.expandedCompactions.clear();
    transcriptState.expandedWrites.clear();
    transcriptState.defaultWritesExpanded = false;
    redrawTranscript(undefined, []);
    syncPromptSurfaces(true);
  };

  async function submitPrompt() {
    if (providerDialog) {
      await runProviderDialogSelection();
      return;
    }
    if (pendingApprovalRef) {
      resolveApprovalSelection();
      return;
    }
    const plan = pendingPlan();
    if (plan) {
      resolvePendingPlanSelection(plan);
      return;
    }
    if (isRunning()) {
      if (picker?.kind === "select" && picker.mode === "slash") {
        const item = picker.items[picker.index];
        if (item) {
          activePrompt()?.clear();
          promptText = "";
          closePicker();
          queueComposerInput(item.command, { notice: "Queued command for next turn", showInTranscript: true });
        }
        return;
      }
      const raw = readPromptText() || promptText;
      const input = (raw || promptText).trimEnd();
      if (!input.trim()) return;
      activePrompt()?.clear();
      promptText = "";
      resetPromptHistoryBrowse();
      if (picker) closePicker();
      if (isBoundarySteerEligible(input)) {
        submitBoundarySteer(input);
      } else {
        queueComposerInput(input, { notice: "Queued unsupported steer for next turn", showInTranscript: true });
      }
      return;
    }
    if (picker?.kind === "select" && picker.mode === "slash") {
      const item = picker.items[picker.index];
      if (item) await runPickerItem(item);
      return;
    }
    const raw = readPromptText() || promptText;
    const input = (raw || promptText).trimEnd();
    if (!input.trim()) return;
    activePrompt()?.clear();
    promptText = "";
    resetPromptHistoryBrowse();
    if (picker?.kind === "key") {
      const providerId = picker.providerId;
      const after = picker.after;
      closePicker();
      await executeSlash(providerId ? `/key ${providerId} ${input}` : `/key ${input}`);
      if (after) {
        await openPicker(after.mode, after.providerId);
      }
      return;
    }
    if (input === "exit" || input === "quit" || input === ":q") {
      void requestExit();
      return;
    }
    if (input.startsWith("/") && !/\s/.test(input)) {
      const query = input.slice(1).toLowerCase();
      const matches = slashCandidates().filter((command) => command.name.toLowerCase().startsWith(query));
      if (matches.length === 1) {
        const match = matches[0]!;
        if (match.source === "skill") {
          insertSkillPrompt(match.name);
        } else {
          await executeSlash(`/${match.name}`);
        }
        return;
      }
      if (matches.length > 1) {
        picker = {
          kind: "select",
          mode: "slash",
          title: "Commands",
          items: buildSlashItems(query),
          index: 0,
        };
        redrawDock();
        return;
      }
    }
    await handleInput(input);
  }

  function onPromptContentChange(value?: unknown) {
    const nextValue = typeof value === "string" ? value : readPromptText();
    promptText = nextValue;
    if (!applyingComposerImageReplacement) {
      void applyComposerImagePathReplacement(nextValue);
    }
    if (
      promptHistoryIndex !== undefined
      && nextValue !== (promptHistory[promptHistoryIndex] ?? "")
    ) {
      resetPromptHistoryBrowse();
    }
    if (providerDialog) return;
    if (picker?.kind === "key") return;
    if (picker?.kind === "select" && picker.mode !== "slash" && picker.mode !== "file") {
      filterActivePicker(nextValue);
      return;
    }
    if (picker?.kind === "select" && picker.mode === "slash" && picker.allItems && !nextValue.startsWith("/")) {
      filterActivePicker(nextValue);
      return;
    }

    const trimmedBeforeCursor = nextValue;
    const at = findAtContext(trimmedBeforeCursor, trimmedBeforeCursor.length);
    if (at) {
      void updateFileAutocomplete(at.query, at.start, at.end);
      return;
    }

    if (!trimmedBeforeCursor.startsWith("/") || /\s/.test(trimmedBeforeCursor)) {
      if (picker?.kind === "select" && picker.mode === "slash") closePicker();
      return;
    }

    filterSlashPicker(trimmedBeforeCursor.slice(1).toLowerCase());
    redrawDock();
  }

  function openCommandPalette() {
    const items = buildSlashItems();
    providerDialog = undefined;
    redrawProviderDialog();
    picker = {
      kind: "select",
      mode: "slash",
      title: "Commands",
      items,
      allItems: items,
      index: 0,
    };
    activePrompt()?.clear();
    promptText = "";
    activePrompt()?.focus();
    redrawDock();
  }

  /**
   * Builds the picker shown by `Ctrl+Shift+M`. Follows opencode's
   * dialog-mcp.tsx visual convention:
   *   - label (title)  → pure server name, no marker
   *   - detail (descr) → "status · tools/prompts" or error summary
   *
   * We keep it to two lines (label + detail) because bubble's
   * SelectOption/inline-picker only supports name+description. The
   * footer-badge pattern from opencode (e.g. "✓ Enabled") is inlined
   * into the detail line so it stays visible.
   */
  function buildMcpReconnectItems(): PickerItem[] {
    const mgr = props.options.mcpManager;
    if (!mgr) return [];
    const rows = sidebarMcpRowsFromStates(mgr.getStates());
    return rows.map((row): PickerItem => {
      const statusWord = row.kind === "connected"
        ? "connected"
        : row.kind === "failed"
          ? "failed"
          : "disabled";
      const detail = row.kind === "failed"
        ? `${statusWord} · ${row.label}`
        : `${statusWord} · ${row.label}`;
      return {
        label: row.name,
        detail,
        value: row.name,
        command: `/mcp reconnect ${row.name}`,
      };
    });
  }

  function openMcpReconnectPicker(focusServerName?: string) {
    const items = buildMcpReconnectItems();
    if (items.length === 0) {
      addMessage("assistant", "No MCP servers configured.");
      return;
    }
    const focusIdx = focusServerName
      ? Math.max(0, items.findIndex((it) => it.value === focusServerName))
      : 0;
    providerDialog = undefined;
    redrawProviderDialog();
    picker = {
      kind: "select",
      mode: "mcp-reconnect",
      title: "MCP servers — Enter or r to reconnect",
      items,
      allItems: items,
      index: focusIdx,
    };
    activePrompt()?.clear();
    promptText = "";
    activePrompt()?.focus();
    redrawDock();
  }

  /**
   * Shape used for slash command matching. Built-ins from LOCAL_SLASH_COMMANDS
   * are plain {name, description}; the registry returns UnifiedCommand which
   * adds `source` / `sourceLabel`. Unlabelled entries default to "builtin"
   * via the fallbacks below.
   */
  type SlashCandidate = {
    name: string;
    description: string;
    source?: "builtin" | "mcp" | "skill";
    sourceLabel?: string;
  };

  function slashCandidates(): SlashCandidate[] {
    const skillCommands: SlashCandidate[] = skills.summaries().map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: "skill" as const,
      sourceLabel: skill.source,
    }));
    return [
      ...LOCAL_SLASH_COMMANDS.map((c) => ({ ...c, source: "builtin" as const })),
      ...skillCommands,
      ...slashRegistry.list(),
    ];
  }

  function buildSlashItems(query = ""): PickerItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    const commands = slashCandidates();
    const matches = slashCommandMatches(commands, normalizedQuery);
    return matches.map(({ command }): PickerItem => {
      const isMcp = command.source === "mcp";
      const isSkill = command.source === "skill";
      const badge = isMcp ? " :mcp" : isSkill ? " :skill" : "";
      const label = `/${command.name}${badge}`;
      const detail = isMcp && command.sourceLabel
        ? `[${command.sourceLabel}] ${command.description}`
        : isSkill && command.sourceLabel
          ? `[${command.sourceLabel}] ${command.description}`
        : command.description;
      return {
        label,
        detail,
        value: command.name,
        command: `/${command.name}`,
        action: isSkill ? "insert-skill" : undefined,
      };
    });
  }

  function slashCommandMatches(commands: SlashCandidate[], normalizedQuery: string) {
    const sortKey = (a: { command: SlashCandidate }, b: { command: SlashCandidate }) =>
      sourceRank(a.command.source) - sourceRank(b.command.source)
      || a.command.name.localeCompare(b.command.name);

    if (!normalizedQuery) {
      return commands
        .map((command) => ({ command, score: 0 }))
        .sort(sortKey);
    }

    const exact = commands.filter((command) => command.name.toLowerCase() === normalizedQuery);
    if (exact.length) {
      return exact
        .map((command) => ({ command, score: 0 }))
        .sort(sortKey);
    }

    const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(normalizedQuery));
    if (prefix.length) {
      return prefix
        .map((command) => ({ command, score: 1 }))
        .sort(sortKey);
    }

    return commands
      .map((command) => ({ command, score: slashCommandFallbackScore(command, normalizedQuery) }))
      .filter((item) => item.score < Number.POSITIVE_INFINITY)
      .sort(
        (a, b) =>
          a.score - b.score
          || sourceRank(a.command.source) - sourceRank(b.command.source)
          || a.command.name.localeCompare(b.command.name),
      );
  }

  function slashCommandFallbackScore(command: SlashCandidate, normalizedQuery: string) {
    const name = command.name.toLowerCase();
    const description = command.description.toLowerCase();
    if (name.includes(normalizedQuery)) return 2;
    if (fuzzyMatch(name, normalizedQuery)) return 3;
    if (description.includes(normalizedQuery)) return 4;
    if (fuzzyMatch(description, normalizedQuery)) return 5;
    return Number.POSITIVE_INFINITY;
  }

  function preferredSlashIndex(items: PickerItem[], query: string) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!items.length || !normalizedQuery) return 0;
    const exact = items.findIndex((item) => item.value.toLowerCase() === normalizedQuery);
    if (exact >= 0) return exact;
    const prefix = items.findIndex((item) => item.value.toLowerCase().startsWith(normalizedQuery));
    return prefix >= 0 ? prefix : 0;
  }

  function filterSlashPicker(query: string) {
    const previousQuery = picker?.kind === "select" && picker.mode === "slash" ? picker.query ?? "" : "";
    const previousIndex = picker?.kind === "select" && picker.mode === "slash" ? picker.index : 0;
    const commands = buildSlashItems(query);
    picker = {
      kind: "select",
      mode: "slash",
      title: "Commands",
      items: commands,
      index: commands.length
        ? query === previousQuery
          ? Math.min(Math.max(0, previousIndex), commands.length - 1)
          : preferredSlashIndex(commands, query)
        : 0,
      query,
    };
  }

  function filterActivePicker(value: string) {
    if (!picker || picker.kind !== "select") return;
    const source = picker.allItems ?? picker.items;
    const query = value.trim().toLowerCase();
    const previousQuery = picker.query ?? "";
    const nextItems = query
      ? source.filter((item) => {
        const haystack = `${item.label} ${item.detail ?? ""} ${item.value}`.toLowerCase();
        return haystack.includes(query);
      })
      : source;
    picker.items = nextItems;
    picker.index = query !== previousQuery
      ? 0
      : Math.min(Math.max(0, picker.index), Math.max(0, nextItems.length - 1));
    picker.query = value.trim();
    redrawDock();
  }

  async function updateFileAutocomplete(query: string, start: number, end: number) {
    const files = await listProjectFiles(props.args.cwd).catch(() => []);
    const suggestions = filterFileSuggestions(files, query, 20).map((suggestion): PickerItem => ({
      label: suggestion.path,
      detail: "file",
      value: suggestion.path,
      command: "",
    }));
    if (!suggestions.length) {
      if (picker?.kind === "select" && picker.mode === "file") closePicker();
      return;
    }
    picker = {
      kind: "select",
      mode: "file",
      title: "Files",
      items: suggestions,
      index: Math.min(picker?.kind === "select" && picker.mode === "file" ? picker.index : 0, suggestions.length - 1),
      meta: { start, end },
    };
    redrawDock();
  }

  function applyFileSuggestion(filePath: string) {
    const state = picker?.kind === "select" && picker.mode === "file" ? picker : undefined;
    const start = typeof state?.meta?.start === "number" ? state.meta.start : promptText.lastIndexOf("@");
    const end = typeof state?.meta?.end === "number" ? state.meta.end : promptText.length;
    const prompt = activePrompt();
    if (start < 0 || !prompt) return;
    const next = `${promptText.slice(0, start)}@${filePath} ${promptText.slice(end)}`;
    prompt.setText(next);
    prompt.cursorOffset = next.length;
    closePicker();
  }

  function insertSkillPrompt(skillName: string) {
    closePicker();
    resetPromptHistoryBrowse();
    setPromptText(`/${skillName} `);
    redrawDock();
  }

  async function applyComposerImagePathReplacement(snapshot: string) {
    const seq = ++composerImageResolutionSeq;
    const result = await resolveComposerImagePaths(snapshot, { labelStart: nextImageAttachmentIndex });
    if (seq !== composerImageResolutionSeq) return;
    if (result.attachments.length === 0) return;
    if ((readPromptText() || promptText) !== snapshot) return;

    for (const attachment of result.attachments) {
      pendingImageAttachments.set(attachment.label, attachment);
    }
    nextImageAttachmentIndex = Math.max(nextImageAttachmentIndex, result.nextLabelIndex);
    applyingComposerImageReplacement = true;
    try {
      setPromptText(result.text);
    } finally {
      applyingComposerImageReplacement = false;
    }
  }

  async function expandTextParts(parts: ContentPart[]): Promise<ContentPart[]> {
    const expandedParts: ContentPart[] = [];
    for (const part of parts) {
      if (part.type !== "text") {
        expandedParts.push(part);
        continue;
      }
      const expansion = await expandAtMentions(part.text, props.args.cwd);
      if (expansion.missing.length) addMessage("error", `Could not resolve @mention: ${expansion.missing.join(", ")}`);
      for (const skipped of expansion.skipped) addMessage("error", `Skipped @${skipped.path}: ${skipped.reason}`);
      expandedParts.push({ type: "text", text: expansion.text });
    }
    return expandedParts;
  }

  async function handleInput(input: string, options: { displayId?: string } = {}) {
    setNotice("");
    const labeledInput = buildImageContentPartsFromLabels(input, pendingImageAttachments);
    if (labeledInput.actualInput) {
      await runAgentInput(await expandTextParts(labeledInput.actualInput), labeledInput.displayInput, options);
      for (const label of labeledInput.usedLabels) pendingImageAttachments.delete(label);
      return;
    }

    const imageInput = await resolveImageInput(input, { labelStart: nextImageAttachmentIndex });
    for (const error of imageInput.errors) addMessage("error", `Skipped image: ${error}`);

    if (imageInput.attachments.length > 0) {
      await runAgentInput(await expandTextParts(imageInput.actualInput as ContentPart[]), imageInput.displayInput, options);
      nextImageAttachmentIndex += imageInput.attachments.length;
      return;
    }

    if (imageInput.imagePathCount > 0) return;

    if (input.startsWith("/")) {
      const skillInvocation = parseSkillInvocation(input, skills);
      if (skillInvocation) {
        await runAgentInput(skillInvocation.actualPrompt, input, options);
        return;
      }

      const handled = await executeSlash(input, options);
      if (handled) return;
    }

    const expansion = await expandAtMentions(input, props.args.cwd);
    if (expansion.missing.length) addMessage("error", `Could not resolve @mention: ${expansion.missing.join(", ")}`);
    for (const skipped of expansion.skipped) addMessage("error", `Skipped @${skipped.path}: ${skipped.reason}`);
    await runAgentInput(expansion.text, input, options);
  }

  async function executeSlash(input: string, options: { displayId?: string } = {}) {
    if (/^\/(?:thinking|toggle-thinking)(?:\s|$)/.test(input.trim())) {
      toggleThinkingVisibility();
      return true;
    }
    if (/^\/(?:trace|verbose|debug)(?:\s|$)/.test(input.trim())) {
      toggleVerboseTrace();
      return true;
    }
    if (/^\/write-previews(?:\s|$)/.test(input.trim())) {
      toggleVisibleWriteBlocks();
      return true;
    }

    const wasHomeSurfaceActive = isHomeSurfaceActive();
    const { handled, result, inject } = await slashRegistry.execute(input, {
      agent: props.agent,
      addMessage,
      clearMessages,
      cwd: props.args.cwd,
      exit: () => { void requestExit(); },
      sessionManager: props.options.sessionManager,
      createProvider: props.options.createProvider ?? ((() => {
        throw new Error("Provider creation not available");
      }) as any),
      openPicker: (kind, providerId) => {
        void openPicker(kind, providerId);
      },
      registry,
      skillRegistry: skills,
      bashAllowlist: props.options.bashAllowlist,
      settingsManager: props.options.settingsManager,
      mcpManager: props.options.mcpManager,
      lspService,
      flushMemory: props.options.flushMemory,
      runMemoryCompaction: props.options.runMemoryCompaction,
      runMemorySummary: props.options.runMemorySummary,
      runMemoryRefresh: props.options.runMemoryRefresh,
      getThemeMode: () => activeThemeMode,
      getResolvedTheme: getActiveResolvedTheme,
      setThemeMode: applyThemeMode,
      toggleSidebar,
      setSidebarMode: applySidebarMode,
      openFeedback,
      openStats: openStatsPanel,
    });
    if (!handled) return false;
    if (uiDisposed) return true;
    if (props.agent.mode !== mode()) setMode(props.agent.mode);
    syncTodosFromAgent();
    syncModelChrome();
    syncModeChrome();
    if (uiDisposed) return true;
    if (result) {
      const modelSwitch = parseModelSwitchMessage(result);
      if (modelSwitch && wasHomeSurfaceActive) {
        setNotice(result);
        redrawTranscript(undefined, displayMessages);
        syncPromptSurfaces(true);
      } else {
        const isCompactResult = result.startsWith("✓ Compaction complete");
        if (isCompactResult) {
          setNotice(result);
          displayMessages = reconstructDisplayMessages(props.agent.messages);
          streamingDisplay = undefined;
          redrawTranscript(undefined, displayMessages);
          setTimeout(() => setNotice(""), 4000);
        } else {
          addMessage("assistant", result);
        }
      }
    }
    if (inject) await runAgentInput(inject, input, options);
    return true;
  }

  async function openPicker(kind: PickerMode, providerId?: string) {
    if (kind === "feishu-setup") {
      openFeishuSetup();
      return;
    }
    if (kind === "model") {
      openProviderDialog("models", providerId);
      return;
    }
    if (kind === "provider" || kind === "provider-auth") {
      openProviderDialog(kind === "provider-auth" ? "auth" : "providers", providerId);
      return;
    }
    if (kind === "skill") {
      openProviderDialog("skills");
      return;
    }
    if (kind === "key") {
      picker = {
        kind: "key",
        title: providerId ? `Enter API key for ${providerId}` : "Enter API key",
        providerId,
        previous: previousPickerForKey,
      };
      providerDialog = undefined;
      redrawProviderDialog();
      previousPickerForKey = undefined;
      activePrompt()?.clear();
      activePrompt()?.focus();
      redrawDock();
      return;
    }

    const selectKind = kind as Exclude<PickerMode, "key">;
    providerDialog = undefined;
    redrawProviderDialog();
    activePrompt()?.clear();
    promptText = "";
    const immediateItems = buildPickerItems(selectKind, providerId);
    picker = {
      kind: "select",
      mode: selectKind,
      title: pickerTitle(selectKind, providerId),
      items: immediateItems,
      allItems: immediateItems,
      index: preferredPickerIndex(selectKind, immediateItems),
      loading: false,
      meta: providerId ? { providerId } : undefined,
    };
    activePrompt()?.focus();
    redrawDock();
  }

  async function runPickerItem(item: PickerItem) {
    if (picker?.kind === "select" && picker.mode === "file") {
      applyFileSuggestion(item.value);
      return;
    }
    if (item.action === "insert-skill" || (picker?.kind === "select" && picker.mode === "skill")) {
      insertSkillPrompt(item.value);
      return;
    }
    if (picker?.kind === "select" && picker.mode === "slash") {
      activePrompt()?.clear();
      closePicker();
      await executeSlash(item.command);
      return;
    }
    if (picker?.kind === "select" && picker.mode === "mcp-reconnect") {
      closePicker();
      const mgr = props.options.mcpManager;
      if (!mgr) {
        addMessage("error", "MCP is not initialized for this session.");
        return;
      }
      const name = item.value;
      addMessage("assistant", `Reconnecting MCP server "${name}"…`);
      try {
        const state = await mgr.reconnect(name);
        if (!state) {
          addMessage("error", `Unknown MCP server: ${name}`);
        } else if (state.status.kind === "connected") {
          const tn = state.status.tools.length;
          addMessage("assistant", `Reconnected ${name}. ${tn} tool${tn === 1 ? "" : "s"} available.`);
        } else if (state.status.kind === "failed") {
          addMessage("error", `Failed to connect ${name}: ${state.status.error}`);
        } else {
          addMessage("assistant", `${name}: ${state.status.kind}`);
        }
      } catch (err) {
        addMessage("error", `Reconnect error for ${name}: ${(err as Error).message || String(err)}`);
      } finally {
        bumpSidebar();
      }
      return;
    }
    if (item.next === "auth") {
      const immediateItems = buildPickerItems("provider-auth", item.value);
      picker = {
        kind: "select",
        mode: "provider-auth",
        title: pickerTitle("provider-auth", item.value),
        items: immediateItems,
        allItems: immediateItems,
        index: 0,
        loading: false,
        meta: { providerId: item.value },
      };
      activePrompt()?.clear();
      activePrompt()?.focus();
      redrawDock();
      return;
    }
    if (item.next === "key") {
      if (item.command.startsWith("/provider --add ")) {
        await executeSlash(item.command);
      }
      picker = {
        kind: "key",
        title: `Enter API key for ${item.value}`,
        providerId: item.value,
        after: item.after,
      };
      activePrompt()?.clear();
      activePrompt()?.focus();
      redrawDock();
      return;
    }
    if (picker?.kind === "select" && picker.mode === "provider-add") {
      previousPickerForKey = { ...picker, items: [...picker.items], allItems: picker.allItems ? [...picker.allItems] : undefined };
    }
    activePrompt()?.clear();
    closePicker();
    await executeSlash(item.command);
    if (item.after) {
      await openPicker(item.after.mode, item.after.providerId);
    }
  }

  function buildLocalModelPickerItems(providerId?: string): PickerItem[] {
    const groups = getVisibleModelProviders(registry, providerId).map((provider) => ({
      provider,
      models: localModelsForProvider(registry, provider),
    }));
    return buildModelPickerItemsFromGroups(groups, providerId);
  }

  async function buildRemoteModelPickerItems(providerId?: string): Promise<PickerItem[]> {
    const groups = await discoverModelProviderGroups(registry, providerId);
    return buildModelPickerItemsFromGroups(groups, providerId);
  }

  function buildModelPickerItemsFromGroups(groups: ModelProviderGroup[], providerId?: string): PickerItem[] {
    const items: PickerItem[] = [];
    for (const { provider, models } of groups) {
      for (const model of models) {
        const reasoningLevels = getModelPickerReasoningLevels(provider.id, model.id);
        if (reasoningLevels.length > 0) {
          for (const level of reasoningLevels) {
            const isCurrent = props.agent.model === `${provider.id}:${model.id}` && props.agent.thinking === level;
            items.push({
              label: `${model.name} (${level})`,
              detail: isCurrent ? "(current)" : undefined,
              value: `${provider.id}:${model.id}`,
              command: `/model ${provider.id}:${model.id} --reasoning-effort ${level}`,
              category: provider.name,
              gutter: isCurrent ? "●" : undefined,
            });
          }
          continue;
        }

        const isCurrent = props.agent.model === `${provider.id}:${model.id}`;
        items.push({
          label: model.name,
          detail: isCurrent ? "(current)" : undefined,
          value: `${provider.id}:${model.id}`,
          command: `/model ${provider.id}:${model.id}`,
          category: provider.name,
          gutter: isCurrent ? "●" : undefined,
        });
      }
    }

    const currentModel = props.agent.model;
    if (!providerId && currentModel && !items.some((item) => item.value === currentModel)) {
      items.unshift({
        label: displayModel(currentModel),
        detail: "(current)",
        value: currentModel,
        command: `/model ${currentModel}`,
        category: "Recent",
        gutter: "●",
      });
    }
    return items;
  }

  function buildPickerItems(kind: Exclude<PickerMode, "key">, providerId?: string): PickerItem[] {
    if (kind === "slash") return [];
    if (kind === "mcp-reconnect") return buildMcpReconnectItems();
    if (kind === "skill") return buildSkillItems();
    if (kind === "model") {
      return buildLocalModelPickerItems(providerId);
    }

    if (kind === "provider") {
      return buildProviderConnectItems();
    }

    if (kind === "provider-auth") {
      if (!providerId) return [];
      const provider = BUILTIN_PROVIDERS.find((item) => item.id === providerId);
      if (!provider) return [];
      const items: PickerItem[] = [{
        label: "API key",
        detail: providerAuthDescription(provider.id, "api"),
        value: provider.id,
        command: `/provider --add ${provider.id}`,
        next: "key",
        after: { mode: "model", providerId: provider.id },
      }];
      if (registry.supportsOAuth(provider.id)) {
        items.unshift({
          label: "ChatGPT login",
          detail: providerAuthDescription(provider.id, "oauth"),
          value: provider.id,
          command: `/login ${provider.id}`,
          after: { mode: "model", providerId: provider.id },
        });
      }
      return items;
    }

    if (kind === "provider-add") {
      return BUILTIN_PROVIDERS
        .filter((provider) => isUserVisibleProvider(provider.id))
        .map((provider) => ({
          label: provider.name,
          detail: provider.id,
          value: provider.id,
          command: `/provider --add ${provider.id}`,
        }));
    }

    if (kind === "login") {
      return BUILTIN_PROVIDERS
        .filter((provider) => isUserVisibleProvider(provider.id) && registry.supportsOAuth(provider.id))
        .map((provider) => ({
          label: provider.name,
          detail: provider.id,
          value: provider.id,
          command: `/login ${provider.id}`,
        }));
    }

    return registry.getConfigured()
      .filter((provider) => registry.getAuthStorage().has(provider.id))
      .map((provider) => ({
        label: provider.name,
        detail: provider.id,
        value: provider.id,
        command: `/logout ${provider.id}`,
      }));
  }

  function buildSkillItems(): PickerItem[] {
    return skills.summaries().map((skill) => {
      const tags = skill.tags && skill.tags.length > 0 ? ` · ${skill.tags.join(", ")}` : "";
      const category = skill.source === "project"
        ? "Project skills"
        : skill.source === "configured"
          ? "Configured skills"
          : "User skills";
      return {
        label: skill.name,
        detail: `${skill.description}${tags}`,
        value: skill.name,
        command: `/${skill.name}`,
        action: "insert-skill",
        category,
        footer: skill.source,
      };
    });
  }

  function buildProviderConnectItems(): PickerItem[] {
    const configuredProviders = registry.getConfigured();
    const configured = new Map(configuredProviders.map((provider) => [provider.id, provider]));
    const defaultProviderId = registry.getDefault()?.id;
    const builtinProviders = BUILTIN_PROVIDERS.filter((provider) => isUserVisibleProvider(provider.id));
    const builtinIds = new Set(builtinProviders.map((provider) => provider.id));
    const customProviders = configuredProviders
      .filter((provider) => !builtinIds.has(provider.id))
      .map((provider) => ({ id: provider.id, name: provider.name }));
    return [...builtinProviders, ...customProviders]
      .sort((a, b) => {
        const ap = PROVIDER_PRIORITY.get(a.id) ?? 99;
        const bp = PROVIDER_PRIORITY.get(b.id) ?? 99;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .map((provider) => {
        const profile = configured.get(provider.id);
        const connected = !!profile?.apiKey;
        const needsKey = !!profile && !profile.apiKey;
        const isDefault = connected && provider.id === defaultProviderId;
        const group = PROVIDER_PRIORITY.has(provider.id) ? "Popular" : "Other";
        const marker = isDefault ? "●" : connected ? "✓" : needsKey ? "○" : " ";
        const detail = providerConnectDescription(provider.id);
        const footer = isDefault ? "default" : connected ? "connected" : needsKey ? "needs key" : "";

        if (connected) {
          return {
            label: provider.name,
            detail,
            value: provider.id,
            command: `/provider --set ${provider.id}`,
            after: { mode: "model", providerId: provider.id },
            category: group,
            gutter: marker,
            footer,
          };
        }
        if (needsKey) {
          return {
            label: provider.name,
            detail,
            value: provider.id,
            command: `/key ${provider.id}`,
            next: "key",
            after: { mode: "model", providerId: provider.id },
            category: group,
            gutter: marker,
            footer,
          };
        }
        return {
          label: provider.name,
          detail,
          value: provider.id,
          command: `/provider --add ${provider.id}`,
          next: registry.supportsOAuth(provider.id) ? "auth" : "key",
          after: { mode: "model", providerId: provider.id },
          category: group,
          gutter: marker,
          footer,
        };
      });
  }

  function providerConnectDescription(providerId: string): string {
    const descriptions: Record<string, string> = {
      openai: "ChatGPT login or API key",
      deepseek: "API key",
      google: "API key",
      "zhipuai-coding-plan": "Coding Plan",
      "zai-coding-plan": "Coding Plan",
      "kimi-for-coding": "Coding Plan",
      local: "OpenAI-compatible local endpoint",
    };
    return descriptions[providerId] ?? "API key";
  }

  function providerAuthDescription(providerId: string, type: "api" | "oauth"): string {
    if (type === "oauth") {
      return providerId === "openai" ? "Use ChatGPT account OAuth" : "OAuth login";
    }
    if (providerId === "openai") return "Use an OpenAI API key";
    return "Paste provider API key";
  }

  async function runAgentInput(actualInput: string | ContentPart[], displayInput: string, options: { displayId?: string } = {}) {
    const activeProviderId = props.agent.providerId || registry.getDefault()?.id;
    const hasActiveProvider = !!activeProviderId && registry.getEnabled().some((provider) => provider.id === activeProviderId);
    if (!hasActiveProvider) {
      addMessage("error", "No provider configured. Use /login for ChatGPT or /provider --add <id> before sending a prompt.");
      return;
    }
    if (!props.agent.model) {
      addMessage("error", "No model selected. Use /model after /login or provider setup.");
      return;
    }

    rememberPromptHistory(displayInput);
    const reusedQueuedDisplay = promoteQueuedUserDisplay(options.displayId, displayInput);
    const nextMessages = reusedQueuedDisplay
      ? displayMessages
      : [...displayMessages, { role: "user" as const, content: displayInput }];
    if (!reusedQueuedDisplay) displayMessages = nextMessages;
    streamingDisplay = undefined;
    redrawTranscript(undefined, nextMessages);
    const taskStartedAt = Date.now();
    const run = beginAgentRun();
    traceEvent("tui_agent_run_begin", {
      runId: run.id,
      input: summarizeTraceValue(actualInput),
      displayInput: summarizeTraceValue(displayInput),
      displayMessages: displayMessages.length,
      queuedInputs: queuedInputCount(),
      provider: activeProviderId,
      model: props.agent.apiModel,
    }, { surface: "tui" });

    let assistantContent = "";
    let assistantReasoning = "";
    const toolCalls: DisplayToolCall[] = [];
    const assistantParts: DisplayMessagePart[] = [];
    let turnStartedAt: number | undefined;
    let runError: string | undefined;
    let runCancelled = false;
    // Throttle redraws driven by per-token streaming events (reasoning_delta
    // and tool_call_delta). Both can fire hundreds of times per second on a
    // long reply; coalescing into ~16fps keeps the transcript alive without
    // thrashing OpenTUI's layout or re-parsing markdown per token.
    let pendingStreamingRedrawTimer: ReturnType<typeof setTimeout> | undefined;
    const STREAMING_REDRAW_INTERVAL_MS = 60;
    const buildStreamingDisplay = (status?: DisplayMessage["status"]): DisplayMessage => {
      const currentParts = snapshotDisplayParts(assistantParts);
      const partContent = assistantContent || contentFromParts(currentParts);
      return {
        role: "assistant",
        content: partContent,
        reasoning: assistantReasoning || undefined,
        toolCalls: toolCalls.length ? [...toolCalls] : undefined,
        parts: currentParts.length ? currentParts : undefined,
        status,
        streaming: true,
        turnStartedAt,
      };
    };
    const flushStreamingRedraw = () => {
      if (pendingStreamingRedrawTimer === undefined) return;
      clearTimeout(pendingStreamingRedrawTimer);
      pendingStreamingRedrawTimer = undefined;
      redrawTranscript(buildStreamingDisplay(toolCalls.length ? undefined : "thinking"));
    };
    const scheduleStreamingRedraw = () => {
      if (pendingStreamingRedrawTimer !== undefined) return;
      pendingStreamingRedrawTimer = setTimeout(flushStreamingRedraw, STREAMING_REDRAW_INTERVAL_MS);
    };
    try {
      for await (const event of props.agent.run(actualInput, props.args.cwd, {
        abortSignal: run.abortController.signal,
        inputController: run.inputController,
      })) {
        traceEvent("tui_agent_event", {
          runId: run.id,
          event: summarizeAgentEventForTrace(event),
          displayMessages: displayMessages.length,
          streamingChars: assistantContent.length,
          reasoningChars: assistantReasoning.length,
          toolCount: toolCalls.length,
        }, { surface: "tui" });
        if (event.type === "turn_start") {
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          assistantParts.length = 0;
          turnStartedAt = Date.now();
          redrawTranscript({
            role: "assistant",
            content: "",
            status: "thinking",
            streaming: true,
            turnStartedAt,
          });
        } else if (event.type === "text_delta") {
          assistantContent += event.content;
          appendTextPart(assistantParts, event.content);
          scheduleStreamingRedraw();
        } else if (event.type === "reasoning_delta") {
          debugReasoningStream({
            stage: "ui_append",
            providerId: props.agent.providerId,
            modelId: props.agent.apiModel,
            beforeLength: assistantReasoning.length,
            delta: summarizeDebugText(event.content),
            afterLength: assistantReasoning.length + event.content.length,
          });
          assistantReasoning += event.content;
          scheduleStreamingRedraw();
        } else if (event.type === "tool_call_start") {
          // Insert a streaming placeholder so the user sees feedback the moment
          // the model commits to a tool call, instead of waiting for the args
          // JSON to fully stream + parse.
          if (!toolCalls.find((item) => item.id === event.id)) {
            const toolCall: DisplayToolCall = {
              id: event.id,
              name: event.name,
              args: {},
              rawArguments: "",
              streamingArgs: true,
              status: "pending",
            };
            toolCalls.push(toolCall);
            appendToolPart(assistantParts, toolCall);
          }
          redrawTranscript(buildStreamingDisplay());
        } else if (event.type === "tool_call_delta") {
          const existing = toolCalls.find((item) => item.id === event.id);
          if (existing) {
            existing.name = event.name || existing.name;
            existing.rawArguments = event.arguments;
            existing.streamingArgs = true;
            const hint = extractStreamingArgsHint(event.arguments);
            if (hint.path && existing.args.path !== hint.path) {
              existing.args = { ...existing.args, path: hint.path };
            }
            existing.streamingNewlineCount = hint.newlineCount;
            scheduleStreamingRedraw();
          }
        } else if (event.type === "tool_call_end") {
          // The placeholder is already visible; tool_start will swap in canonical args.
        } else if (event.type === "tool_start") {
          flushStreamingRedraw();
          const now = Date.now();
          const existing = toolCalls.find((item) => item.id === event.id);
          if (existing) {
            existing.args = event.args;
            existing.streamingArgs = false;
            existing.streamingNewlineCount = undefined;
            existing.rawArguments = undefined;
            existing.status = "running";
            existing.startedAt = existing.startedAt ?? now;
          } else {
            const toolCall: DisplayToolCall = {
              id: event.id,
              name: event.name,
              args: event.args,
              status: "running",
              startedAt: now,
            };
            toolCalls.push(toolCall);
            appendToolPart(assistantParts, toolCall);
          }
          if (event.name === "question") {
            scheduleQuestionSync();
          }
          redrawTranscript(buildStreamingDisplay());
        } else if (event.type === "tool_end") {
          const call = toolCalls.find((item) => item.id === event.id);
          if (call) {
            call.result = event.result.content;
            call.isError = event.result.isError;
            call.metadata = event.result.metadata;
            call.status = event.result.isError ? "error" : "completed";
            call.completedAt = Date.now();
            redrawTranscript(buildStreamingDisplay());
          }
          if (event.name === "question") {
            syncFirstPendingQuestion();
          }
          refreshGitSidebar();
          syncSidebarLsp();
        } else if (event.type === "tool_update") {
          const call = toolCalls.find((item) => item.id === event.id);
          if (call) {
            call.metadata = mergeToolMetadata(call.metadata, event.update.metadata);
            call.result = event.update.message ?? call.result;
            const finished = event.update.status === "failed" || event.update.status === "blocked" || event.update.status === "cancelled" || event.update.status === "completed";
            call.status = event.update.status === "failed" || event.update.status === "blocked" || event.update.status === "cancelled"
              ? "error"
              : event.update.status === "completed"
                ? "completed"
                : "running";
            call.isError = call.status === "error";
            if (finished && call.completedAt === undefined) call.completedAt = Date.now();
            redrawTranscript(buildStreamingDisplay());
          }
        } else if (event.type === "todos_updated") {
          setTodos(event.todos);
          syncSidebarTodos(event.todos);
          bumpSidebar();
        } else if (event.type === "mode_changed") {
          setMode(event.mode);
          syncModeChrome();
          bumpSidebar();
        } else if (event.type === "input_pending_changed") {
          if (event.pending === 0) clearPendingSteerInputs();
          else setPendingSteerCount(event.pending);
          requestComposerRender();
        } else if (event.type === "input_applied") {
          const pendingSteer = removePendingSteerInput(event.id);
          promoteQueuedUserDisplay(pendingSteer?.displayId, event.content);
          setNotice("Steer applied to current run");
        } else if (event.type === "input_rejected") {
          const pendingSteer = removePendingSteerInput(event.id);
          requeueRejectedSteer(event.content, pendingSteer?.displayId);
          setNotice("Steer moved to next turn");
        } else if (event.type === "turn_end") {
          if (pendingStreamingRedrawTimer !== undefined) {
            clearTimeout(pendingStreamingRedrawTimer);
            pendingStreamingRedrawTimer = undefined;
          }
          if (event.usage) {
            setSidebarUsage((current) => ({
              contextTokens: event.usage!.promptTokens || current.contextTokens,
              promptTokens: current.promptTokens + event.usage!.promptTokens,
              completionTokens: current.completionTokens + event.usage!.completionTokens,
              promptCacheHitTokens: current.promptCacheHitTokens + (event.usage!.promptCacheHitTokens ?? 0),
              promptCacheMissTokens: current.promptCacheMissTokens + (
                event.usage!.promptCacheMissTokens
                  ?? (event.usage!.promptCacheHitTokens === undefined ? event.usage!.promptTokens : 0)
              ),
              reasoningTokens: current.reasoningTokens + (event.usage!.reasoningTokens ?? 0),
              turns: current.turns + 1,
            }));
          }
          bumpSidebar();
          const currentParts = snapshotDisplayParts(assistantParts);
          const finalContent = assistantContent || contentFromParts(currentParts);
          const finalToolCalls = toolCalls.length > 0
            ? [...toolCalls]
            : toolCallsFromParts(currentParts);
          const assistantMessage: DisplayMessage = {
            role: "assistant",
            content: finalContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: finalToolCalls.length ? finalToolCalls : undefined,
            parts: currentParts.length ? currentParts : undefined,
            turnStartedAt,
            turnCompletedAt: Date.now(),
            turnUsage: event.usage,
          };
          const nextMessages = hasRenderableMessage(assistantMessage)
            ? [...displayMessages, assistantMessage]
            : displayMessages;
          displayMessages = nextMessages;
          redrawTranscript(undefined, nextMessages);
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          assistantParts.length = 0;
          turnStartedAt = undefined;
          streamingDisplay = undefined;
        }
      }
    } catch (error: any) {
      runCancelled = error instanceof AgentAbortError || run.abortController.signal.aborted || error?.name === "AbortError";
      if (!runCancelled) {
        runError = error?.message || String(error);
      }
      traceEvent("tui_agent_run_error", {
        runId: run.id,
        cancelled: runCancelled,
        error: summarizeTraceError(error),
      }, { surface: "tui" });
    } finally {
      if (pendingStreamingRedrawTimer !== undefined) {
        clearTimeout(pendingStreamingRedrawTimer);
        pendingStreamingRedrawTimer = undefined;
      }
      pendingApprovalRef = undefined;
      setPendingApproval(undefined);
      setApprovalOptionIdx(0);
      traceEvent("tui_agent_run_end", {
        runId: run.id,
        cancelled: runCancelled,
        error: runError,
        displayMessages: displayMessages.length,
        queuedInputs: queuedInputCount(),
      }, { surface: "tui" });
      for (const pendingInput of run.inputController.clear()) {
        const pendingSteer = removePendingSteerInput(pendingInput.id);
        if (runCancelled) {
          removeQueuedUserDisplay(pendingSteer?.displayId);
          continue;
        }
        requeueRejectedSteer(pendingInput.content, pendingSteer?.displayId);
      }
      finishAgentRun(run);
      streamingDisplay = undefined;
      if (runError) {
        const errorMessage = runError;
        const nextMessages = [...displayMessages, { role: "error" as const, content: errorMessage }];
        displayMessages = nextMessages;
        redrawTranscript(undefined, nextMessages);
      } else if (runCancelled) {
        if (!notice()) setNotice("Agent run cancelled");
        displayMessages = reconstructDisplayMessages(props.agent.messages);
        redrawTranscript();
      } else {
        displayMessages = annotateLastTaskDuration(displayMessages, Date.now() - taskStartedAt);
        redrawTranscript();
      }
      redrawDock();
      refreshGitSidebar();
      syncSidebarLsp();
      setTimeout(() => activePrompt()?.focus(), 0);
      if (queuedInputCount() > 0) scheduleQueuedInputDrain();
    }
  }

  function promptUiKeyDown(event: any) {
    if (routeCtrlCExit(event)) return true;
    const modalOwner = activeModalKeyOwner();
    if (modalOwner) {
      if (routeModalKey(event) || shouldModalSwallowUnhandledKey(modalOwner)) {
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
    }
    if (routeRunningCancel(keyNameFromEvent(event), event)) return true;
    if (routeRunningQueue(keyNameFromEvent(event), event)) return true;
    if (cycleModeFromKey(event)) return true;
    if (handlePromptHistoryKey(event)) return true;
    return false;
  }

  function renderComposer() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        sessionComposerShell = ref;
          ref.visible = !isHomeSurfaceActive(streamingDisplay) && !pendingQuestion() && !pendingFeedback() && !statsPanel && !pendingFeishuSetup();
      },
      width: "100%",
      paddingLeft: 2,
      paddingRight: 2,
      flexShrink: 0,
      visible: !isHomeSurfaceActive(streamingDisplay) && !pendingQuestion() && !statsPanel && !pendingFeishuSetup(),
    },
      renderPrompt({
        ref: (ref) => { sessionPromptRef = ref; },
        focused: !isHomeSurfaceActive(streamingDisplay),
        onSubmit: submitPrompt,
        isFallbackNewlineKey: isTrackedShiftReturn,
        onFallbackNewline: () => canInsertPromptNewline() && (activePrompt()?.newLine() ?? false),
        onContentChange: onPromptContentChange,
        onKeyDown: handlePickerKey,
        onUiKeyDown: promptUiKeyDown,
        getText: readPromptText,
        disabled: () => !!pendingFeedback() || !!statsPanel,
        mode,
        registerModeLabel: registerPromptModeLabel,
        registerModelLabel: registerPromptModelLabel,
        model: promptModelTitle,
        interruptHint: promptStatusText,
        tabHint: () => isRunning() ? "queue" : "mode",
        placeholder: () => {
          const approvalState = pendingApproval();
          if (approvalState) return "Press Enter to approve or Esc to reject";
          if (pendingQuestion()) return "Answer the question below";
          if (pendingFeedback()) return "Describe feedback below";
          if (statsPanel) return "Stats panel is open";
          const plan = pendingPlan();
          if (plan) return "Press Enter to approve plan or Esc to reject";
          if (isRunning()) return "Steer current run...";
          return `Ask anything... "${homePrompt}"`;
        },
      }),
    );
  }

  function renderHomeSurface() {
    const homeHeight = Math.max(16, dimensions().height - 4);
    const logoLines = bubbleWordmarkForWidth(dimensions().width);
    return h("box", {
      ref: (ref: BoxRenderable) => {
        homeSurfaceShell = ref;
        ref.visible = isHomeSurfaceActive(streamingDisplay);
      },
      visible: isHomeSurfaceActive(streamingDisplay),
      height: homeHeight,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      paddingLeft: 2,
      paddingRight: 2,
    },
    [
      h("box", { flexShrink: 0, flexDirection: "column", alignItems: "center" },
        ...logoLines.map((line) => renderHomeLogoLine(line)),
      ),
      h("box", { height: 1, minHeight: 0, flexShrink: 1 }),
      h("box", {
        ref: (ref: BoxRenderable) => {
          homeComposerShell = ref;
          ref.visible = isHomeSurfaceActive(streamingDisplay) && !pendingQuestion() && !pendingFeedback() && !statsPanel && !pendingFeishuSetup();
        },
        width: "100%",
        maxWidth: 75,
        zIndex: 1000,
        paddingTop: 1,
        flexShrink: 0,
        visible: isHomeSurfaceActive(streamingDisplay) && !pendingQuestion() && !statsPanel && !pendingFeishuSetup(),
      },
      renderPrompt({
        ref: (ref) => {
          homePromptRef = ref;
          if (isHomeSurfaceActive(streamingDisplay)) setTimeout(() => ref.focus(), 0);
        },
        focused: isHomeSurfaceActive(streamingDisplay),
        onSubmit: submitPrompt,
        isFallbackNewlineKey: isTrackedShiftReturn,
        onFallbackNewline: () => canInsertPromptNewline() && (activePrompt()?.newLine() ?? false),
        onContentChange: onPromptContentChange,
        onKeyDown: handlePickerKey,
        onUiKeyDown: promptUiKeyDown,
        getText: readPromptText,
        disabled: () => !!pendingFeedback() || !!statsPanel,
        mode,
        registerModeLabel: registerPromptModeLabel,
        registerModelLabel: registerPromptModelLabel,
        model: promptModelTitle,
        interruptHint: promptStatusText,
        tabHint: () => isRunning() ? "queue" : "mode",
        placeholder: () => {
          const approvalState = pendingApproval();
          if (approvalState) return "Press Enter to approve or Esc to reject";
          if (pendingQuestion()) return "Answer the question below";
          if (pendingFeedback()) return "Describe feedback below";
          if (statsPanel) return "Stats panel is open";
          const plan = pendingPlan();
          if (plan) return "Press Enter to approve plan or Esc to reject";
          if (isRunning()) return "Steer current run...";
          return `Ask anything... "${homePrompt}"`;
        },
      }),
      ),
    ]);
  }

  function renderQuestionPanelHost() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        questionRoot = ref;
        redrawQuestionPanel();
      },
      visible: false,
      focusable: true,
      onKeyDown: handleQuestionKey,
      position: "absolute",
      left: 2,
      right: 2,
      bottom: 4,
      zIndex: 180,
      height: QUESTION_PANEL_MIN_HEIGHT,
      backgroundColor: theme.backgroundPanel,
      border: ["left"],
      borderColor: theme.accent,
      flexDirection: "column",
    },
    h("box", {
      gap: 1,
      paddingLeft: 1,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      flexGrow: 1,
      flexDirection: "column",
    },
    h("box", {
      ref: (ref: BoxRenderable) => { questionTabsRow = ref; },
      flexDirection: "row",
      gap: 1,
      paddingLeft: 1,
      flexShrink: 0,
      visible: false,
    },
    Array.from({ length: QUESTION_MAX_TABS }, (_, index) =>
      h("box", {
        ref: (ref: BoxRenderable) => { questionTabBoxes[index] = ref; },
        paddingLeft: 1,
        paddingRight: 1,
        visible: false,
        backgroundColor: theme.backgroundPanel,
        onMouseOver: () => {
          const state = pendingQuestion();
          if (!state || isSingleQuestion(state)) return;
          if (index > state.request.questions.length) return;
          selectQuestionTab(index);
        },
        onMouseUp: () => {
          const state = pendingQuestion();
          if (!state || isSingleQuestion(state)) return;
          if (index > state.request.questions.length) return;
          selectQuestionTab(index);
        },
      },
      h("text", {
        ref: (ref: TextRenderable) => { questionTabTexts[index] = ref; },
        fg: theme.textMuted,
        content: "",
      })),
    ),
    ),
    h("text", {
      ref: (ref: TextRenderable) => { questionPromptText = ref; },
      fg: theme.text,
      wrapMode: "word",
      content: "",
    }),
    h("box", {
      ref: (ref: BoxRenderable) => { questionOptionsShell = ref; },
      flexDirection: "column",
      gap: 1,
    },
    Array.from({ length: QUESTION_MAX_OPTIONS }, (_, index) => renderQuestionOptionHost(index)),
    ),
    h("box", {
      ref: (ref: BoxRenderable) => { questionCustomEditorShell = ref; },
      paddingLeft: 3,
      visible: false,
      flexShrink: 0,
    },
    h("textarea", {
      ref: (ref: TextareaRenderable) => { questionCustomInput = ref; },
      placeholder: "Type your own answer",
      placeholderColor: theme.textMuted,
      textColor: theme.text,
      focusedTextColor: theme.text,
      backgroundColor: theme.backgroundPanel,
      focusedBackgroundColor: theme.backgroundPanel,
      cursorColor: theme.primary,
      minHeight: 1,
      maxHeight: 6,
      keyBindings: PROMPT_TEXTAREA_KEYBINDINGS,
      onContentChange: () => {
        const value = questionCustomInput?.plainText ?? "";
        setPendingQuestion((current) => {
          if (!current) return current;
          const custom = [...current.custom];
          custom[current.tab] = value;
          return { ...current, custom };
        });
        redrawQuestionPanel();
      },
      onKeyDown: (event: any) => {
        const name = keyNameFromEvent(event);
        if (name === "escape") {
          event.preventDefault?.();
          updateQuestionState((current) => ({ ...current, editing: false }));
        }
        if (name === "enter" && !event.shift) {
          event.preventDefault?.();
          commitQuestionCustom();
        }
      },
    }),
    ),
    h("box", {
      ref: (ref: BoxRenderable) => { questionConfirmShell = ref; },
      paddingLeft: 1,
      gap: 1,
      flexDirection: "column",
      visible: false,
    },
    h("text", { fg: theme.text, content: "Review" }),
    Array.from({ length: QUESTION_MAX_CONFIRM_ROWS }, (_, index) =>
      h("text", {
        ref: (ref: TextRenderable) => { questionConfirmTexts[index] = ref; },
        fg: theme.textMuted,
        wrapMode: "word",
        visible: false,
        content: "",
      }),
    ),
    ),
    ),
    h("box", {
      flexDirection: "row",
      flexShrink: 0,
      gap: 2,
      paddingLeft: 2,
      paddingRight: 3,
      paddingBottom: 1,
    },
    h("text", { ref: (ref: TextRenderable) => { questionFooterTab = ref; }, fg: theme.textMuted, visible: false, content: "⇆ tab" }),
    h("text", { ref: (ref: TextRenderable) => { questionFooterSelect = ref; }, fg: theme.textMuted, content: "↑↓ select" }),
    h("text", { ref: (ref: TextRenderable) => { questionFooterEnter = ref; }, fg: theme.textMuted, content: "enter submit" }),
    h("text", { ref: (ref: TextRenderable) => { questionFooterEsc = ref; }, fg: theme.textMuted, content: "esc dismiss" }),
    ));
  }

  function renderFeedbackPanelHost() {
    return h("box", {
      ref: (ref: BoxRenderable) => { feedbackRoot = ref; },
      visible: !!pendingFeedback(),
      focusable: true,
      onKeyDown: (event: any) => {
        if (handleFeedbackKey(event)) {
          event.preventDefault?.();
          event.stopPropagation?.();
          return true;
        }
        return false;
      },
      position: "absolute",
      left: 2,
      right: 2,
      bottom: 4,
      zIndex: 210,
      backgroundColor: theme.backgroundPanel,
      border: ["left"],
      borderColor: theme.info,
      flexDirection: "column",
    },
    h("box", {
      gap: 1,
      paddingLeft: 2,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      flexDirection: "column",
      flexGrow: 1,
    },
    h("box", { flexDirection: "row", gap: 1, flexShrink: 0 },
      h("text", { fg: theme.info }, "◆"),
      h("text", { fg: theme.text, content: "Send feedback" }),
    ),
    h("text", {
      fg: theme.warning,
      wrapMode: "word",
      content: "Creates a public GitHub issue at DylanDDeng/bubble. Review before sending.",
    }),
    h("textarea", {
      ref: (ref: TextareaRenderable) => { feedbackInput = ref; },
      placeholder: "Describe what happened",
      placeholderColor: theme.textMuted,
      textColor: theme.text,
      focusedTextColor: theme.text,
      backgroundColor: theme.backgroundElement,
      focusedBackgroundColor: theme.backgroundElement,
      cursorColor: theme.primary,
      minHeight: 3,
      maxHeight: 6,
      keyBindings: PROMPT_TEXTAREA_KEYBINDINGS,
      onContentChange: () => {
        const value = feedbackInput?.plainText ?? "";
        updateFeedbackState((current) => ({
          ...current,
          description: value,
          status: undefined,
        }));
      },
      onKeyDown: (event: any) => {
        if (handleFeedbackKey(event)) {
          event.preventDefault?.();
          event.stopPropagation?.();
          return true;
        }
        setTimeout(() => {
          const value = feedbackInput?.plainText ?? "";
          updateFeedbackState((current) => ({
            ...current,
            description: value,
            status: undefined,
          }));
        }, 0);
        return false;
      },
    }),
    h("text", {
      ref: (ref: TextRenderable) => { feedbackMetaText = ref; },
      fg: theme.textMuted,
      wrapMode: "word",
      content: "",
    }),
    h("box", {
      ref: (ref: BoxRenderable) => { feedbackPreviewShell = ref; },
      visible: false,
      border: ["left"],
      borderColor: theme.borderSubtle,
      paddingLeft: 1,
      flexGrow: 1,
      minHeight: 0,
    },
    h("scrollbox", { height: 5, flexGrow: 1, minHeight: 0 },
      h("text", {
        ref: (ref: TextRenderable) => { feedbackPreviewText = ref; },
        fg: theme.textMuted,
        wrapMode: "word",
        content: "",
      }),
    ),
    ),
    h("text", {
      ref: (ref: TextRenderable) => { feedbackStatusText = ref; },
      fg: theme.textMuted,
      wrapMode: "word",
      visible: false,
      content: "",
    }),
    ),
    h("box", {
      flexDirection: "row",
      flexShrink: 0,
      paddingLeft: 2,
      paddingRight: 3,
      paddingBottom: 1,
      backgroundColor: theme.backgroundElement,
    },
    h("text", {
      ref: (ref: TextRenderable) => { feedbackFooterText = ref; },
      fg: theme.textMuted,
      content: "ctrl+d submit · tab view payload · enter newline · esc cancel",
    }),
    ));
  }

  function renderStatsPanel() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        statsRoot = ref;
        redrawStatsPanel();
      },
      visible: false,
      focusable: true,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 3050,
      backgroundColor: modalBackdropColor(),
      flexDirection: "column",
      onKeyDown: (event: any) => {
        if (handleStatsKey(event)) {
          event.preventDefault?.();
          event.stopPropagation?.();
          return true;
        }
        return false;
      },
      onMouseUp: () => closeStatsPanel(),
    },
    h("box", {
      ref: (ref: BoxRenderable) => {
        statsPanelBox = ref;
        redrawStatsPanel();
      },
      visible: false,
      position: "absolute",
      width: 76,
      height: 24,
      backgroundColor: theme.backgroundPanel,
      flexDirection: "column",
      paddingTop: 1,
      onMouseUp: (event: any) => {
        event.stopPropagation?.();
      },
    },
    [
      h("box", {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: 4,
        paddingRight: 4,
        flexShrink: 0,
      },
      h("text", {
        ref: (ref: TextRenderable) => { statsTitle = ref; },
        fg: theme.text,
        content: "Stats",
      }),
      h("text", {
        ref: (ref: TextRenderable) => { statsEsc = ref; },
        fg: theme.textMuted,
        content: "esc",
        onMouseUp: () => closeStatsPanel(),
      })),
      h("box", {
        flexDirection: "row",
        gap: 1,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 1,
        flexShrink: 0,
      },
      h("box", {
        ref: (ref: BoxRenderable) => { statsTab7Box = ref; },
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.backgroundElement,
        onMouseUp: () => setStatsRange("7d"),
      },
      h("text", {
        ref: (ref: TextRenderable) => { statsTab7Text = ref; },
        fg: theme.textMuted,
        content: "7 days",
      })),
      h("box", {
        ref: (ref: BoxRenderable) => { statsTab30Box = ref; },
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.primary,
        onMouseUp: () => setStatsRange("30d"),
      },
      h("text", {
        ref: (ref: TextRenderable) => { statsTab30Text = ref; },
        fg: contrastText(theme.primary),
        content: "30 days",
      }))),
      h("box", {
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 1,
        flexGrow: 1,
        minHeight: 0,
      },
      h("scrollbox", {
        ref: (ref: ScrollBoxRenderable) => { statsBodyScroll = ref; },
        flexGrow: 1,
        minHeight: 0,
        height: 14,
        onMouseScroll: (event: any) => {
          event.stopPropagation?.();
        },
      },
      h("text", {
        ref: (ref: TextRenderable) => { statsBodyText = ref; },
        fg: theme.text,
        wrapMode: "none",
        content: "",
      }))),
      h("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
        backgroundColor: theme.backgroundPanel,
      },
      h("text", {
        ref: (ref: TextRenderable) => { statsFooterText = ref; },
        fg: theme.textMuted,
        bg: theme.backgroundPanel,
        wrapMode: "none",
        truncate: true,
        content: "left/right:range|tab:toggle|esc:close|view:30d",
      })),
    ]));
  }

  function renderFeishuSetupPanel() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        feishuSetupRoot = ref;
        redrawFeishuSetupPanel();
      },
      visible: false,
      focusable: true,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 3100,
      backgroundColor: modalBackdropColor(),
      flexDirection: "column",
      onKeyDown: (event: any) => {
        if (handleFeishuSetupKey(event)) return true;
        return false;
      },
    },
    h("box", {
      ref: (ref: BoxRenderable) => {
        feishuSetupPanel = ref;
        redrawFeishuSetupPanel();
      },
      visible: false,
      position: "absolute",
      width: 72,
      height: 12,
      backgroundColor: theme.backgroundPanel,
      border: true,
      borderColor: theme.info,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      gap: 1,
      onMouseUp: (event: any) => {
        event.stopPropagation?.();
      },
    },
    [
      h("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        flexShrink: 0,
      },
      h("text", {
        ref: (ref: TextRenderable) => { feishuSetupTitle = ref; },
        fg: theme.text,
        content: "Feishu Setup Wizard",
      }),
      h("text", {
        fg: theme.textMuted,
        content: "esc",
        onMouseUp: () => {
          handleFeishuSetupKey({
            name: "escape",
            preventDefault() {},
            stopPropagation() {},
          });
        },
      })),
      h("text", {
        ref: (ref: TextRenderable) => { feishuSetupHint = ref; },
        fg: theme.textMuted,
        content: "",
        flexShrink: 0,
      }),
      h("scrollbox", {
        ref: (ref: ScrollBoxRenderable) => { feishuSetupBodyScroll = ref; },
        flexGrow: 1,
        minHeight: 0,
        height: 5,
      },
      h("text", {
        ref: (ref: TextRenderable) => { feishuSetupBodyText = ref; },
        fg: theme.text,
        wrapMode: "word",
        content: "",
      })),
      h("box", {
        ref: (ref: BoxRenderable) => { feishuSetupInputShell = ref; },
        visible: false,
        flexShrink: 0,
      },
      h("input", {
        ref: (ref: InputRenderable) => { feishuSetupInput = ref; },
        width: "100%",
        value: "",
        placeholder: "",
        fg: theme.text,
        backgroundColor: theme.backgroundElement,
        focusedBackgroundColor: theme.backgroundElement,
        cursorColor: theme.primary,
        placeholderColor: theme.textMuted,
        onInput: (value: string) => updateFeishuSetupInput(value),
        onKeyDown: (event: any) => {
          if (handleFeishuSetupKey(event)) return true;
          return false;
        },
        onSubmit: () => {
          submitFeishuSetupField();
        },
      })),
      h("box", {
        flexDirection: "row",
        flexShrink: 0,
        paddingTop: 1,
      },
      h("text", {
        ref: (ref: TextRenderable) => { feishuSetupFooterText = ref; },
        fg: theme.textMuted,
        content: "",
      })),
    ]));
  }

  function renderQuestionOptionHost(index: number) {
    return h("box", {
      ref: (ref: BoxRenderable) => { questionOptionRows[index] = ref; },
      flexDirection: "column",
      visible: false,
      onMouseOver: () => {
        const state = pendingQuestion();
        if (!state || isQuestionConfirmTab(state) || index >= questionOptionTotal(state)) return;
        updateQuestionState((current) => ({ ...current, selected: index }));
      },
      onMouseUp: () => {
        const state = pendingQuestion();
        if (!state || isQuestionConfirmTab(state) || index >= questionOptionTotal(state)) return;
        updateQuestionState((current) => ({ ...current, selected: index }));
        setTimeout(selectQuestionOption, 0);
      },
    },
    h("box", { flexDirection: "row" },
      h("text", {
        ref: (ref: TextRenderable) => { questionOptionIndexTexts[index] = ref; },
        fg: theme.textMuted,
        content: "",
      }),
      h("text", {
        ref: (ref: TextRenderable) => { questionOptionLabelTexts[index] = ref; },
        fg: theme.text,
        content: "",
      }),
      h("text", {
        ref: (ref: TextRenderable) => { questionOptionCheckTexts[index] = ref; },
        fg: theme.success,
        content: "",
      }),
    ),
    h("box", { paddingLeft: 3 },
      h("text", {
        ref: (ref: TextRenderable) => { questionOptionDescriptionTexts[index] = ref; },
        fg: theme.textMuted,
        wrapMode: "word",
        content: "",
      }),
    ));
  }

  function renderPromptDock() {
    return [
      h("text", {
        ref: (ref: TextRenderable) => { dock = ref; },
        fg: theme.text,
        wrapMode: "word",
        content: formatDock({
          picker,
          plan: pendingPlan()?.plan,
          selectedOption: approvalOptionIdx(),
        }),
      }),
      h("box", {
        ref: (ref: BoxRenderable) => { pickerFrame = ref; },
        flexDirection: "column",
        visible: false,
      },
      h("select", {
        ref: (ref: SelectRenderable) => { selectList = ref; },
        visible: false,
        height: 1,
        options: [],
        selectedIndex: 0,
        backgroundColor: theme.background,
        textColor: theme.text,
        focusedTextColor: theme.text,
        selectedBackgroundColor: theme.backgroundElement,
        selectedTextColor: theme.primary,
        descriptionColor: theme.textMuted,
        selectedDescriptionColor: theme.text,
        showDescription: true,
        showScrollIndicator: true,
        onMouseMove: (event: any) => updatePickerFromMouse(event, false),
        onMouseDown: (event: any) => updatePickerFromMouse(event, false),
        onMouseUp: (event: any) => updatePickerFromMouse(event, true),
      }),
      ...Array.from({ length: 10 }, (_, index) =>
        h("box", {
          ref: (ref: BoxRenderable) => { inlinePickerRows[index] = ref; },
          visible: false,
          height: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.backgroundElement,
          onMouseMove: () => updateInlinePickerFromMouse(index, false),
          onMouseDown: () => updateInlinePickerFromMouse(index, false),
          onMouseUp: () => updateInlinePickerFromMouse(index, true),
        },
        h("text", {
          ref: (ref: TextRenderable) => { inlinePickerLabels[index] = ref; },
          fg: theme.text,
          flexShrink: 0,
          content: "",
        }),
        h("text", {
          ref: (ref: TextRenderable) => { inlinePickerDetails[index] = ref; },
          fg: theme.textMuted,
          wrapMode: "none",
          content: "",
        }),
        ),
      ),
      ),
    ];
  }

  function renderProviderDialog() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        providerDialogRoot = ref;
        redrawProviderDialog();
      },
      visible: false,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 3000,
      backgroundColor: modalBackdropColor(),
      flexDirection: "column",
      onMouseUp: () => closeProviderDialog(),
      onMouseScroll: updateProviderDialogFromScroll,
    },
    h("box", {
      ref: (ref: BoxRenderable) => {
        providerDialogPanel = ref;
        redrawProviderDialog();
      },
      visible: false,
      position: "absolute",
      width: 60,
      height: PROVIDER_DIALOG_ROWS + 7,
      backgroundColor: theme.backgroundPanel,
      flexDirection: "column",
      paddingTop: 1,
      onMouseUp: (event: any) => {
        event.stopPropagation?.();
      },
      onMouseScroll: updateProviderDialogFromScroll,
    },
    [
        h("box", {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 4,
          paddingRight: 4,
          flexShrink: 0,
        },
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogTitle = ref; },
          fg: theme.text,
          content: "Select model",
        }),
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogEsc = ref; },
          fg: theme.textMuted,
          content: "esc",
          onMouseUp: () => closeProviderDialog(),
        })),
        h("box", {
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 1,
          flexShrink: 0,
        },
        h("input", {
          ref: (ref: InputRenderable) => { providerDialogInput = ref; },
          width: "100%",
          value: "",
          placeholder: "Search",
          fg: theme.textMuted,
          backgroundColor: theme.backgroundPanel,
          focusedBackgroundColor: theme.backgroundPanel,
          cursorColor: theme.primary,
          placeholderColor: theme.textMuted,
          onInput: (value: string) => {
            const state = providerDialog;
            if (!state) return;
            if (state.step === "key") {
              providerDialog = { ...state, apiKey: value, error: undefined };
            } else {
              const items = providerDialogItemsFor(state.step, state.providerId).filter((item) => {
                const query = value.trim().toLowerCase();
                if (!query) return true;
                const haystack = [item.label, item.detail, item.value, item.category, item.footer]
                  .filter(Boolean)
                  .join(" ")
                  .toLowerCase();
                return haystack.includes(query) || fuzzyMatch(haystack, query);
              });
              providerDialog = {
                ...state,
                query: value,
                index: value !== state.query ? 0 : Math.min(state.index, Math.max(0, items.length - 1)),
                error: undefined,
              };
            }
            redrawProviderDialog();
          },
          onKeyDown: (event: any) => {
            handleProviderDialogKey(event);
          },
          onSubmit: () => {
            void runProviderDialogSelection();
          },
        })),
        h("box", {
          ref: (ref: BoxRenderable) => { providerDialogList = ref; },
          height: PROVIDER_DIALOG_ROWS,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          flexShrink: 0,
          flexDirection: "column",
          onMouseScroll: updateProviderDialogFromScroll,
        },
        ...Array.from({ length: PROVIDER_DIALOG_ROWS }, (_, index) =>
          h("box", {
            ref: (ref: BoxRenderable) => { providerDialogRows[index] = ref; },
            visible: false,
            height: 1,
            flexDirection: "row",
            gap: 1,
            paddingLeft: 1,
            paddingRight: 3,
            onMouseMove: () => updateProviderDialogFromMouse(index, false),
            onMouseDown: () => updateProviderDialogFromMouse(index, false),
            onMouseUp: () => updateProviderDialogFromMouse(index, true),
            onMouseScroll: updateProviderDialogFromScroll,
          },
          h("text", {
            ref: (ref: TextRenderable) => { providerDialogGutters[index] = ref; },
            width: 1,
            flexShrink: 0,
            fg: theme.textMuted,
            content: "",
          }),
          h("text", {
            ref: (ref: TextRenderable) => { providerDialogLabels[index] = ref; },
            flexGrow: 1,
            minWidth: 0,
            wrapMode: "none",
            fg: theme.text,
            content: "",
          }),
          h("text", {
            ref: (ref: TextRenderable) => { providerDialogDetails[index] = ref; },
            width: 16,
            flexShrink: 0,
            wrapMode: "none",
            fg: theme.textMuted,
            content: "",
          }),
          h("text", {
            ref: (ref: TextRenderable) => { providerDialogFooters[index] = ref; },
            width: 8,
            flexShrink: 0,
            wrapMode: "none",
            fg: theme.textMuted,
            content: "",
          })),
        )),
        h("box", {
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 4,
          paddingRight: 2,
          paddingTop: 1,
          flexShrink: 0,
        },
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogFooter = ref; },
          fg: theme.textMuted,
          content: "↑/↓ move · enter select · esc close",
        })),
      ]),
    );
  }

  function renderSessionSidebar() {
    const context = sidebarContextState();
    const mcpStates = sidebarMcpStates();
    const files = gitState().files;
    return h("box", {
      ref: (ref: BoxRenderable) => {
        sidebarShell = ref;
        syncSidebarChrome();
      },
      width: sidebarVisible() ? SESSION_SIDEBAR_WIDTH : 0,
      height: "100%",
      flexShrink: 0,
      backgroundColor: theme.backgroundPanel,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      visible: sidebarVisible(),
      flexDirection: "column",
    },
    [
      h("scrollbox", { flexGrow: 1, minHeight: 0 },
        h("box", { flexDirection: "column", gap: 1, paddingRight: 1 },
          renderSidebarTitle(),
          renderSidebarSection("Context", [
            h("text", {
              fg: theme.textMuted,
              flexShrink: 0,
              ref: (ref: TextRenderable) => {
                sidebarGaugeText = ref;
                ref.content = buildContextGauge(context.percent, 30);
              },
            }),
            h("text", {
              fg: context.percent >= 80 ? theme.error : context.percent >= 60 ? theme.warning : theme.success,
              flexShrink: 0,
              ref: (ref: TextRenderable) => {
                sidebarGaugeLabelText = ref;
                ref.content = buildGaugeLabel(context.percent, context.remainingTokens);
              },
            }),
            h("text", {
              fg: theme.textMuted,
              ref: (ref: TextRenderable) => {
                sidebarTokenText = ref;
                ref.content = `${formatCompactNumber(context.tokens)} tokens`;
              },
            }),
            h("text", {
              fg: context.percent >= 75 ? theme.warning : theme.textMuted,
              ref: (ref: TextRenderable) => {
                sidebarPercentText = ref;
                ref.content = `${context.percent}% used`;
              },
            }),
            h("text", {
              fg: theme.textMuted,
              ref: (ref: TextRenderable) => {
                sidebarUsageText = ref;
                ref.content = context.turns > 0
                  ? `${formatCompactNumber(context.promptTokens)} in · ${formatCompactNumber(context.completionTokens)} out`
                  : "usage pending";
              },
            }),
            h("text", {
              fg: theme.textMuted,
              ref: (ref: TextRenderable) => {
                sidebarReasoningText = ref;
                ref.content = context.reasoningTokens > 0
                  ? `${formatCompactNumber(context.reasoningTokens)} reasoning`
                  : "";
              },
            }),
            h("text", {
              fg: theme.textMuted,
              ref: (ref: TextRenderable) => {
                sidebarReasoningText = ref;
                ref.content = context.reasoningTokens > 0
                  ? `${formatCompactNumber(context.reasoningTokens)} reasoning`
                  : "";
              },
            }),
            h("text", {
              fg: theme.textMuted,
              ref: (ref: TextRenderable) => {
                sidebarCostText = ref;
                ref.content = context.costText;
              },
            }),
          ]),
          currentTranscriptMessages().filter((m) => m.syntheticKind === "ui_compact_card").length > 0
            ? renderSidebarSection("Compactions", [
                h("text", { fg: theme.info, wrapMode: "word" },
                  `${currentTranscriptMessages().filter((m) => m.syntheticKind === "ui_compact_card").length} in this session`),
              ])
            : null,
          renderSidebarMcp(mcpStates),
          renderSidebarLsp(),
          renderSidebarTodos(todos()),
          renderSidebarFiles(files),
        ),
      ),
      renderSidebarFooter(),
    ]);
  }

  function renderSidebarTitle() {
    const session = sessionDisplayName(props.options.sessionManager);
    const branch = gitState().branch;
    return h("box", { flexDirection: "column", flexShrink: 0 },
      h("text", { fg: theme.text, wrapMode: "word" }, session),
      h("text", { fg: theme.textMuted, wrapMode: "word" }, shortCwd(props.args.cwd)),
      branch ? h("text", { fg: theme.textMuted }, `git: ${branch}`) : null,
    );
  }

  function renderSidebarMcp(states: ReturnType<typeof sidebarMcpStates>) {
    if (!states.length) {
      return renderSidebarSection("MCP", [
        h("text", { fg: theme.textMuted, wrapMode: "word" }, "No servers configured"),
      ]);
    }
    const connected = states.filter((state) => state.kind === "connected").length;
    const failed = states.filter((state) => state.kind === "failed").length;
    const foldable = states.length > 2;
    const open = foldable ? mcpSectionOpen() : true;
    const summary = `${connected} active${failed ? `, ${failed} error${failed === 1 ? "" : "s"}` : ""}`;

    const header = foldable
      ? h(
          "box",
          {
            flexDirection: "row",
            onMouseDown: () => setMcpSectionOpen((v) => !v),
          },
          h(
            "text",
            { fg: failed ? theme.warning : theme.textMuted },
            `${open ? "▼" : "▶"} ${summary}`,
          ),
        )
      : h("text", { fg: failed ? theme.warning : theme.textMuted }, summary);

    const children: Child[] = [header];
    if (open) {
      for (const state of states.slice(0, 5)) {
        children.push(renderSidebarMcpRow(state));
      }
      if (states.length > 5) {
        children.push(
          h("text", { fg: theme.textMuted, wrapMode: "word" }, `  …and ${states.length - 5} more`),
        );
      }
    }
    return renderSidebarSection("MCP", children);
  }

  function renderSidebarMcpRow(state: SidebarMcpRow) {
    // Pure status display. Reconnect is reached via Ctrl+Shift+M or the
    // /mcp reconnect slash command — the sidebar itself is read-only so the
    // affordance matches its purpose: glance at health, don't operate here.
    return h(
      "box",
      { flexDirection: "row", gap: 1 },
      h("text", { fg: sidebarStatusColor(state.kind), flexShrink: 0 }, renderMcpRowMarker(state.kind)),
      h(
        "text",
        { fg: theme.textMuted, wrapMode: "word" },
        `${state.name} ${state.label}`,
      ),
    );
  }

  function renderSidebarLsp() {
    const statuses = lspStatuses().slice(0, 5);
    const connected = statuses.filter((status) => status.status === "connected").length;
    const starting = statuses.filter((status) => status.status === "starting").length;
    const failed = statuses.filter((status) => status.status === "error").length;
    const summary = [
      connected ? `${connected} active` : "",
      starting ? `${starting} starting` : "",
      failed ? `${failed} error${failed === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(", ");
    return renderSidebarSection("LSP", [
      h("text", {
        fg: theme.textMuted,
        wrapMode: "word",
        ref: (ref: TextRenderable) => {
          sidebarLspSummaryText = ref;
          syncSidebarLsp();
        },
      }, lspService.isDisabled()
        ? "LSPs have been disabled in settings"
        : statuses.length
          ? summary
          : "LSPs will activate as files are read"),
      ...Array.from({ length: 5 }, (_, index) => {
        const status = statuses[index];
        return h("box", {
          flexDirection: "row",
          gap: 1,
          visible: !!status,
          ref: (ref: BoxRenderable) => { sidebarLspRows[index] = ref; },
        },
        h("text", {
          fg: status?.status === "connected" ? theme.success : status?.status === "starting" ? theme.warning : theme.error,
          flexShrink: 0,
          ref: (ref: TextRenderable) => { sidebarLspMarkers[index] = ref; },
        }, status?.status === "connected" ? "*" : status?.status === "starting" ? "~" : "!"),
          h("text", {
            fg: theme.textMuted,
            wrapMode: "word",
            ref: (ref: TextRenderable) => { sidebarLspLabels[index] = ref; },
          }, status ? (status.message ? `${status.id} ${status.root} (${status.message})` : `${status.id} ${status.root}`) : ""),
        );
      }),
    ]);
  }

  function renderSidebarTodos(todos: Todo[]) {
    const visible = todos.slice(0, 8);
    return h("box", {
      flexDirection: "column",
      flexShrink: 0,
      visible: visible.length > 0,
      ref: (ref: BoxRenderable) => {
        sidebarTodoSection = ref;
        syncSidebarTodos();
      },
    },
      h("text", { fg: theme.text }, "Todo"),
      ...Array.from({ length: 8 }, (_, index) => {
        const todo = visible[index];
        const completed = todo?.status === "completed";
        const inProgress = todo?.status === "in_progress";
        const labelText = todo
          ? (inProgress ? (todo.activeForm || todo.content) : todo.content)
          : "";
        return h("box", {
          flexDirection: "row",
          gap: 1,
          visible: !!todo,
          ref: (ref: BoxRenderable) => { sidebarTodoRows[index] = ref; },
        },
          h("text", {
            fg: completed ? theme.success : inProgress ? theme.warning : theme.textMuted,
            flexShrink: 0,
            ref: (ref: TextRenderable) => { sidebarTodoMarkers[index] = ref; },
          }, completed ? "✓" : inProgress ? "◉" : "○"),
          h("text", {
            fg: completed ? theme.success : inProgress ? theme.warning : theme.textMuted,
            wrapMode: "word",
            ref: (ref: TextRenderable) => { sidebarTodoLabels[index] = ref; },
          }, labelText),
        );
      }),
    );
  }

  function renderSidebarFiles(files: SidebarFileChange[]) {
    const visible = files.slice(0, 8);
    const hasFiles = visible.length > 0;
    return h("box", {
      flexDirection: "column",
      flexShrink: 0,
      visible: hasFiles,
      ref: (ref: BoxRenderable) => { sidebarFileSection = ref; },
    },
      h("text", { fg: theme.text }, "Modified Files"),
      ...Array.from({ length: 8 }, (_, index) => {
        const file = visible[index];
        return h("box", {
          flexDirection: "row",
          gap: 1,
          justifyContent: "space-between",
          visible: file !== undefined,
          ref: (ref: BoxRenderable) => { sidebarFileRows[index] = ref; },
        },
          h("text", {
            fg: theme.textMuted,
            wrapMode: "none",
            ref: (ref: TextRenderable) => { sidebarFileLabels[index] = ref; },
          }, file ? truncate(file.file, 25) : ""),
          h("box", { flexDirection: "row", gap: 1, flexShrink: 0 },
            h("text", {
              fg: theme.diffAdded,
              visible: (file?.additions ?? 0) > 0,
              ref: (ref: TextRenderable) => { sidebarFileAdditions[index] = ref; },
            }, file ? `+${file.additions}` : ""),
            h("text", {
              fg: theme.diffRemoved,
              visible: (file?.deletions ?? 0) > 0,
              ref: (ref: TextRenderable) => { sidebarFileDeletions[index] = ref; },
            }, file ? `-${file.deletions}` : ""),
          ),
        );
      }),
    );
  }

  function renderSidebarFooter() {
    return h("box", { flexDirection: "column", flexShrink: 0, paddingTop: 1 },
      h("text", { fg: theme.textMuted }, "Bubble"),
    );
  }

  function renderSidebarSection(title: string, children: Child[]) {
    return h("box", { flexDirection: "column", flexShrink: 0 },
      h("text", { fg: theme.text }, title),
      ...children,
    );
  }

  function sidebarContextState() {
    sidebarTick();
    const decoded = decodeModel(props.agent.model);
    const providerId = props.agent.providerId || decoded.providerId || "";
    const modelId = props.agent.apiModel || decoded.modelId || props.agent.model;
    const budget = providerId && modelId
      ? getContextBudget(providerId, modelId, props.agent.messages)
      : undefined;
    const usage = sidebarUsage();
    const contextTokens = usage.contextTokens || (budget?.estimatedTokens ?? 0);
    const contextPercent = budget?.contextWindow
      ? Math.min(100, Math.round((contextTokens / budget.contextWindow) * 100))
      : Math.round(budget?.percent ?? 0);
    const remainingTokens = budget?.contextWindow !== undefined
      ? Math.max(0, budget.contextWindow - contextTokens)
      : undefined;
    const tokenUsage: TokenUsage = {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      promptCacheHitTokens: usage.promptCacheHitTokens,
      promptCacheMissTokens: usage.promptCacheMissTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
    };
    const cost = providerId && modelId ? calculateUsageCost(providerId, modelId, tokenUsage) : undefined;
    return {
      tokens: contextTokens,
      percent: contextPercent,
      remainingTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      reasoningTokens: usage.reasoningTokens,
      turns: usage.turns,
      costText: cost ? `${formatCurrency(cost.cost)} spent${cost.estimated ? " est." : ""}` : "cost unavailable",
    };
  }

  function sidebarMcpStates(): SidebarMcpRow[] {
    sidebarTick();
    return sidebarMcpRowsFromStates(props.options.mcpManager?.getStates() ?? []);
  }

  function renderSessionView() {
    const approval = pendingApproval();
    return h("box", {
      flexDirection: "column",
      flexGrow: 1,
      minHeight: 0,
    },
    [
      h("box", {
        flexDirection: "column",
        flexGrow: 1,
        minHeight: 0,
        paddingLeft: 2,
        paddingRight: 2,
        paddingBottom: 1,
      },
      h("scrollbox", {
        ref: (ref: ScrollBoxRenderable) => { scrollbox = ref; },
        stickyScroll: true,
        stickyStart: "bottom",
        onMouseScroll: handleTranscriptMouseScroll,
        flexGrow: 1,
        minHeight: 0,
      },
      h("box", { height: 1 }),
      renderHomeSurface(),
      h("box", {
        ref: (ref: BoxRenderable) => {
          const isNewHost = transcriptHost !== ref;
          transcriptHost = ref;
          if (isNewHost) transcriptState.entries = [];
          updateTranscriptHost(ref, transcriptState, currentTranscriptMessages(streamingDisplay), transcriptOptions(), props.syntaxStyle, props.subtleSyntaxStyle);
          syncPromptSurfaces(isNewHost);
          if (isNewHost) scheduleTranscriptScrollAfterUpdate(transcriptScrollFollowing, 0);
        },
        flexDirection: "column",
        flexShrink: 0,
        width: "100%",
      }),
      ),
      todos().length ? renderTodos(todos()) : null,
      ...renderPromptDock(),
      notice() ? h("text", {
        fg: notice().startsWith("✓") ? theme.success : notice().startsWith("✗") ? theme.error : theme.warning,
      }, notice()) : null,
      renderQuestionPanelHost(),
      renderFeedbackPanelHost(),
      h("box", {
        ref: (ref: BoxRenderable) => { approvalRoot = ref; },
        visible: !!approval,
        focusable: true,
        onKeyDown: handleApprovalKey,
        position: "absolute",
        left: 2,
        right: 2,
        bottom: 4,
        zIndex: 200,
        backgroundColor: theme.backgroundPanel,
        border: ["left"],
        borderColor: theme.warning,
        flexDirection: "column",
      },
      h("box", {
        gap: 1,
        paddingLeft: 1,
        paddingRight: 3,
        paddingTop: 1,
        paddingBottom: 1,
        flexGrow: 1,
        flexDirection: "column",
      },
      h("box", { flexDirection: "row", gap: 1, paddingLeft: 1, flexShrink: 0 },
        h("text", { fg: theme.warning }, "△"),
        h("text", {
          ref: (ref: TextRenderable) => { approvalHeaderTitle = ref; },
          fg: theme.text,
          content: "Permission required",
        }),
      ),
      h("box", { flexDirection: "row", gap: 1, paddingLeft: 1, flexShrink: 0 },
        h("text", {
          ref: (ref: TextRenderable) => { approvalMetaIcon = ref; },
          fg: theme.textMuted,
          content: approval ? getApprovalPanelMeta(approval.request).icon : "",
        }),
        h("text", {
          ref: (ref: TextRenderable) => { approvalMetaTitle = ref; },
          fg: theme.text,
          wrapMode: "word",
          content: approval ? getApprovalPanelMeta(approval.request).title : "",
        }),
      ),
      h("box", { paddingLeft: 1, flexShrink: 0 },
        h("text", {
          ref: (ref: TextRenderable) => { approvalSubtitle = ref; },
          fg: theme.textMuted,
          wrapMode: "word",
          visible: false,
          content: "",
        }),
      ),
      h("scrollbox", {
        ref: (ref: ScrollBoxRenderable) => { approvalPreviewScroll = ref; },
        height: approval ? getApprovalPanelMeta(approval.request).previewHeight : 3,
        paddingLeft: 1,
        paddingRight: 1,
        visible: !!approval,
      },
      h("text", {
        ref: (ref: TextRenderable) => { approvalPreviewText = ref; },
        fg: approval ? getApprovalPanelMeta(approval.request).previewColor : theme.toolText,
        wrapMode: "word",
        visible: !approval || !getApprovalPanelMeta(approval.request).diff,
        content: approval ? (getApprovalPanelMeta(approval.request).preview || "") : "",
      }),
      h("diff", {
        ref: (ref: DiffRenderable) => { approvalPreviewDiff = ref; },
        visible: !!approval && !!getApprovalPanelMeta(approval.request).diff,
        diff: approval ? (getApprovalPanelMeta(approval.request).diff || "") : "",
        view: diffViewMode(dimensions().width),
        filetype: approval ? filetype(getApprovalPanelMeta(approval.request).path) : undefined,
        syntaxStyle: props.syntaxStyle,
        showLineNumbers: true,
        width: "100%",
        wrapMode: "word",
        fg: theme.text,
        addedBg: theme.diffAddedBg,
        removedBg: theme.diffRemovedBg,
        contextBg: theme.diffContextBg,
        addedSignColor: theme.diffHighlightAdded,
        removedSignColor: theme.diffHighlightRemoved,
        lineNumberFg: theme.diffLineNumber,
        lineNumberBg: theme.diffContextBg,
        addedLineNumberBg: theme.diffAddedLineNumberBg,
        removedLineNumberBg: theme.diffRemovedLineNumberBg,
        treeSitterClient,
      }),
      ),
      ),
      h("box", {
        flexDirection: "row",
        flexShrink: 0,
        gap: 1,
        paddingTop: 1,
        paddingLeft: 2,
        paddingRight: 3,
        paddingBottom: 1,
        backgroundColor: theme.backgroundElement,
        justifyContent: "space-between",
        alignItems: "center",
      },
      h("box", { flexDirection: "row", gap: 1, flexShrink: 0 },
        [0, 1, 2].map((index) =>
          h("box", {
            ref: (ref: BoxRenderable) => { approvalOptionBoxes[index] = ref; },
            paddingLeft: 1,
            paddingRight: 1,
            visible: false,
            backgroundColor: theme.backgroundPanel,
            onMouseOver: () => {
              const approvalState = pendingApproval();
              if (!approvalState) return;
              const options = approvalOptionsFor(approvalState.request);
              if (!options[index]) return;
              setApprovalOptionIdx(index);
              forceApprovalUI();
            },
            onMouseUp: () => {
              const approvalState = pendingApproval();
              if (!approvalState) return;
              const options = approvalOptionsFor(approvalState.request);
              if (!options[index]) return;
              setApprovalOptionIdx(index);
              forceApprovalUI();
              resolveApprovalSelection();
            },
          },
          h("text", {
            ref: (ref: TextRenderable) => { approvalOptionTexts[index] = ref; },
            fg: theme.textMuted,
            content: "",
          })),
        ),
      ),
      h("box", { flexDirection: "row", gap: 2, flexShrink: 0 },
        h("text", { fg: theme.text }, "⇆/tab ", h("span", { fg: theme.textMuted }, "select")),
        h("text", { fg: theme.text }, "enter ", h("span", { fg: theme.textMuted }, "confirm")),
        h("text", { fg: theme.text }, "esc ", h("span", { fg: theme.textMuted }, "reject")),
      ),
      ),
      ),
      ),
    ]);
  }

  function renderNoticeOverlay() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        copyToastRoot = ref;
        ref.visible = false;
      },
      visible: false,
      position: "absolute",
      top: 2,
      right: sidebarVisible() ? SESSION_SIDEBAR_WIDTH + 2 : 2,
      zIndex: 4000,
      flexDirection: "column",
      alignItems: "flex-start",
      width: 24,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: theme.backgroundPanel,
      border: ["left", "right"],
      borderColor: theme.info,
    },
      h("text", {
        ref: (ref: TextRenderable) => { copyToastText = ref; },
        fg: theme.text,
        wrapMode: "word",
        width: "100%",
        content: "",
      }));
  }

  return h("box", {
    ref: (ref: BoxRenderable) => { rootBox = ref; },
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: theme.background,
  }, [
    h("box", {
      flexDirection: "row",
      flexGrow: 1,
      minHeight: 0,
    },
    [
      h("box", {
        flexDirection: "column",
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
      },
      [
        renderSessionView(),
        renderComposer(),
      ]),
      renderSessionSidebar(),
    ]),
    renderFooter({
      cwd: props.args.cwd,
      mode,
      running: isRunning,
      registerScanner: registerPromptScanner,
      registerModeBadge: registerFooterModeBadge,
      traceVerbose: verboseTrace,
      registerTraceBadge: registerFooterTraceBadge,
    }),
    renderProviderDialog(),
    renderStatsPanel(),
    renderFeishuSetupPanel(),
    renderNoticeOverlay(),
  ]);
}

function renderPrompt(input: {
  ref: (ref: TextareaRenderable) => void;
  focused: boolean;
  onSubmit: () => void;
  isFallbackNewlineKey: (event: any) => boolean;
  onFallbackNewline: () => boolean;
  onContentChange: (value?: unknown) => void;
  onKeyDown: (event: any) => boolean;
  onUiKeyDown: (event: any) => boolean;
  getText: () => string;
  disabled: () => boolean;
  mode: () => PermissionMode;
  registerModeLabel?: (ref: TextRenderable) => void;
  registerModelLabel?: (ref: TextRenderable) => void;
  model: () => string;
  interruptHint: () => string;
  tabHint: () => string;
  placeholder: () => string;
}) {
  const transparentBackground = "#00000000";

  return h("box", { flexDirection: "column", flexShrink: 0, marginTop: 1 },
    h("box", { width: "100%", border: true, borderColor: theme.border, backgroundColor: transparentBackground },
      h("box", { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: transparentBackground },
        h("textarea", {
          ref: input.ref,
          focused: input.focused,
          placeholder: input.placeholder(),
          placeholderColor: theme.textMuted,
          textColor: theme.text,
          focusedTextColor: theme.text,
          backgroundColor: transparentBackground,
          focusedBackgroundColor: transparentBackground,
          minHeight: 1,
          maxHeight: 6,
          onContentChange: () => input.onContentChange(input.getText()),
          keyBindings: PROMPT_TEXTAREA_KEYBINDINGS,
          onKeyDown: (event: any) => {
            if (input.onUiKeyDown(event)) return;
            if (input.onKeyDown(event)) return;
            const modifiedEnter = isModifiedEnterSequence(event);
            const fallbackNewline = modifiedEnter || input.isFallbackNewlineKey(event);
            if (fallbackNewline) {
              if (input.onFallbackNewline()) {
                event.preventDefault?.();
                setTimeout(() => input.onContentChange(input.getText()), 0);
                return;
              }
            }
            if (input.disabled()) event.preventDefault();
            setTimeout(() => input.onContentChange(input.getText()), 0);
          },
          onSubmit: input.onSubmit,
        }),
        h("box", { flexDirection: "row", flexShrink: 0, paddingTop: 1, gap: 1, justifyContent: "space-between" },
          h("box", { flexDirection: "row", gap: 1 },
            h("text", {
              fg: theme.primary,
              ref: input.registerModeLabel,
            }, promptModeBadgeContent(input.mode())),
            h("text", { fg: theme.textMuted }, "·"),
            h("text", {
              fg: theme.text,
              ref: input.registerModelLabel,
            }, input.model()),
          ),
        ),
      ),
    ),
    h("box", { width: "100%", flexDirection: "row", justifyContent: "space-between" },
      () => input.interruptHint()
        ? h("text", { fg: input.interruptHint().startsWith("Press Esc") ? theme.warning : theme.textMuted }, input.interruptHint())
        : h("text", { fg: theme.textMuted }, ""),
      h("box", { flexDirection: "row", gap: 2 },
        h("text", { fg: theme.text }, "tab ", h("span", { fg: theme.textMuted }, input.tabHint())),
        h("text", { fg: theme.text }, "ctrl+p ", h("span", { fg: theme.textMuted }, "commands")),
      ),
    ),
  );
}

function PromptScanner(input: {
  running: () => boolean;
  register: (sync: PromptScannerSync) => () => void;
  idleContent?: string;
  idleFg?: string;
  runningFg?: string;
}) {
  let scannerRef: TextRenderable | undefined;
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const frames = createFrames({
    color: theme.primary,
    style: "blocks",
    inactiveFactor: 0.6,
    minAlpha: 0.3,
  });

  const renderFrame = () => {
    if (!scannerRef) return;
    const frame = frames[frameIndex % frames.length] ?? PROMPT_SCANNER_IDLE_FRAMES[0]!;
    try {
      scannerRef.content = frame;
      scannerRef.fg = input.runningFg ?? theme.primary;
      scannerRef.requestRender();
    } catch {
      stop();
    }
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    frameIndex = 0;
    if (scannerRef) {
      try {
        scannerRef.content = input.idleContent ?? PROMPT_SCANNER_IDLE_FRAMES[0]!;
        scannerRef.fg = input.idleFg ?? theme.backgroundElement;
        scannerRef.requestRender();
      } catch {
        // Ignore stale renderables during surface switches.
      }
    }
  };

  const start = () => {
    renderFrame();
    if (timer) return;
    timer = setInterval(() => {
      frameIndex = (frameIndex + 1) % frames.length;
      renderFrame();
    }, PROMPT_SCANNER_INTERVAL_MS);
  };

  const sync = (running: boolean) => {
    if (!scannerRef) return;
    if (running) start();
    else stop();
  };

  createEffect(() => {
    sync(input.running());
  });

  const unregister = input.register(sync);
  onCleanup(stop);
  onCleanup(unregister);

  return h("text", {
    ref: (ref: TextRenderable) => {
      scannerRef = ref;
      sync(input.running());
    },
    fg: input.idleFg ?? theme.backgroundElement,
    height: 1,
  }, input.idleContent ?? PROMPT_SCANNER_IDLE_FRAMES[0]);
}

function renderMessage(
  message: DisplayMessage,
  index: number,
  syntaxStyle: SyntaxStyle,
  subtleSyntaxStyle: SyntaxStyle,
  showThinking = true,
  verboseTrace = false,
  width = 80,
) {
  if (message.role === "user") return renderUserMessage(message, index);
  if (message.role === "error") {
    return h("box", { border: ["left"], borderColor: theme.error, marginTop: 1, paddingLeft: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.backgroundPanel, flexShrink: 0 },
      h("text", { fg: theme.error, wrapMode: "word" }, message.content),
    );
  }
  return renderAssistantMessage(message, syntaxStyle, subtleSyntaxStyle, showThinking, verboseTrace, width);
}

function renderUserMessage(message: DisplayMessage, index: number) {
  const userChildren: Child[] = [
    h("text", { fg: theme.messageUserText, wrapMode: "word" }, message.content || " "),
  ];
  if (message.queued) {
    userChildren.push(
      h("box", { paddingTop: 1 },
        h("text", { fg: theme.textMuted },
          h("span", { bg: theme.primary, fg: theme.background, bold: true }, " QUEUED ")),
      ),
    );
  }
  return h("box", {
    border: ["left"],
    borderColor: theme.primary,
    marginTop: index === 0 ? 0 : 1,
    backgroundColor: theme.backgroundPanel,
    flexShrink: 0,
  },
    h("box", { paddingTop: 1, paddingBottom: 1, paddingLeft: 2, backgroundColor: theme.backgroundPanel, flexShrink: 0, flexDirection: "column" },
      ...userChildren,
    ),
  );
}

function renderAssistantMessage(
  message: DisplayMessage,
  syntaxStyle: SyntaxStyle,
  subtleSyntaxStyle: SyntaxStyle,
  showThinking = true,
  verboseTrace = false,
  width = 80,
) {
  const modelSwitch = parseModelSwitchMessage(message.content);
  if (modelSwitch && !message.reasoning?.trim() && !(message.toolCalls?.length)) {
    return renderModelSwitchMessage(modelSwitch);
  }

  const children: Child[] = [];
  const visibleReasoning = showThinking ? message.reasoning?.trim() : "";
  const parts = message.parts ?? [];
  const hasParts = parts.length > 0;
  if (message.status && !visibleReasoning && !message.content.trim() && !(message.toolCalls?.length) && !hasParts) {
    children.push(h("box", { paddingLeft: 3, marginTop: 1, flexShrink: 0 },
      h("text", { fg: theme.messageThinkingText }, assistantStatusLabel(message)),
    ));
  }
  if (visibleReasoning) {
    children.push(h("box", {
      paddingLeft: 2,
      marginTop: 1,
      border: ["left"],
      borderColor: theme.messageThinkingBorder,
      flexDirection: "column",
      flexShrink: 0,
    },
      h("text", { content: thinkingLabelContent(message.streaming === true, reasoningElapsedMs(message)), fg: theme.messageThinkingText, wrapMode: "none" }),
      renderMarkdownContent(formatThinkingMarkdown(visibleReasoning), subtleSyntaxStyle, {
        streaming: message.streaming === true,
        fg: theme.messageThinkingContentText,
      }),
    ));
  }
  const trimmedContent = message.content.trim();
  if (hasParts) {
    renderAssistantMessageParts(children, parts, syntaxStyle, verboseTrace, width, message.streaming === true);
  } else {
    const toolCalls = message.toolCalls ?? [];
    if (verboseTrace) {
      for (const tool of toolCalls) children.push(renderTool(tool, syntaxStyle, width));
    } else {
      for (const group of buildTraceGroups(toolCalls)) children.push(renderTraceGroup(group, syntaxStyle, width));
    }
    if (trimmedContent && toolCalls.length > 0) {
      children.push(h("box", { paddingLeft: 3, marginTop: 1, flexShrink: 0 },
        h("text", { content: answerDividerStyledText(), wrapMode: "none" }),
      ));
    }
    if (trimmedContent) {
      children.push(h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
        renderMarkdownContent(trimmedContent, syntaxStyle, {
          streaming: message.streaming === true,
          fg: theme.messageAssistantText,
        }),
      ));
    }
  }
  if (message.streaming === true && (trimmedContent || lastPartHasText(parts))) {
    children.push(h("box", { paddingLeft: 3, flexShrink: 0 },
      h("text", { fg: theme.primary, wrapMode: "none" }, "▌"),
    ));
  }
  const summaryString = formatTurnSummary(message);
  if (summaryString) {
    children.push(h("box", { paddingLeft: 3, marginTop: 1, flexShrink: 0 },
      h("text", { fg: theme.textMuted, wrapMode: "none" }, summaryString),
    ));
  }
  if (!children.length) return null;
  return h("box", { flexDirection: "column", flexShrink: 0 }, children);
}

function renderAssistantMessageParts(
  children: Child[],
  parts: DisplayMessagePart[],
  syntaxStyle: SyntaxStyle,
  verboseTrace: boolean,
  width: number,
  streaming: boolean,
) {
  for (const part of parts) {
    if (part.type === "text") {
      const content = part.content.trim();
      if (!content) continue;
      children.push(h("box", {
        paddingLeft: 3,
        marginTop: 1,
        flexDirection: "column",
        flexShrink: 0,
      },
        renderMarkdownContent(content, syntaxStyle, {
          streaming,
          fg: theme.messageAssistantText,
        }),
      ));
      continue;
    }

    if (verboseTrace) {
      for (const tool of part.toolCalls) children.push(renderTool(tool, syntaxStyle, width));
    } else {
      for (const group of buildTraceGroups(part.toolCalls)) children.push(renderTraceGroup(group, syntaxStyle, width));
    }
  }
}

function lastPartHasText(parts: DisplayMessagePart[]): boolean {
  const last = parts[parts.length - 1];
  return last?.type === "text" && !!last.content.trim();
}

function parseModelSwitchMessage(content: string) {
  const match = content.trim().match(/^Model switched to (.+)\.$/);
  return match?.[1]?.trim();
}

function modelSwitchStyledText(model: string): StyledText {
  return new StyledText([
    fg(theme.success)(bold("◆ Model")),
    fg(theme.textMuted)(" switched to "),
    fg(theme.primary)(bold(model)),
  ]);
}

function renderModelSwitchMessage(model: string) {
  return h("box", {
    border: ["left"],
    borderColor: theme.success,
    marginTop: 1,
    paddingLeft: 2,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: theme.backgroundPanel,
    flexShrink: 0,
  },
  h("text", {
    fg: theme.text,
    wrapMode: "none",
  }, modelSwitchStyledText(model)));
}

function renderMarkdownContent(
  content: string,
  syntaxStyle: SyntaxStyle,
  options?: { streaming?: boolean; fg?: string },
) {
  return h("markdown", {
    content,
    syntaxStyle,
    treeSitterClient,
    streaming: options?.streaming === true,
    conceal: true,
    concealCode: false,
    fg: options?.fg ?? theme.messageAssistantText,
    bg: theme.background,
    width: "100%",
    tableOptions: {
      widthMode: "full",
      columnFitter: "balanced",
      wrapMode: "word",
      cellPadding: 1,
      borders: true,
      borderStyle: "single",
      borderColor: theme.borderSubtle,
      selectable: true,
    },
  });
}

function updateTranscriptHost(
  host: BoxRenderable,
  state: TranscriptState,
  messages: DisplayMessage[],
  options: TranscriptOptions | undefined,
  syntaxStyle: SyntaxStyle,
  subtleSyntaxStyle: SyntaxStyle,
) {
  const showThinking = options?.showThinking ?? true;
  const verboseTrace = options?.verboseTrace ?? false;
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  const ctx = host.ctx;
  const nextEntries: TranscriptEntry[] = [];

  if (!visibleMessages.length && !options?.plan) {
    clearTranscriptEntries(host, state);
    host.requestRender();
    return;
  }

  for (const [index, message] of visibleMessages.entries()) {
    const key = transcriptMessageKey(message, index);
    if (state.defaultWritesExpanded) {
      for (const tool of message.toolCalls ?? []) {
        if (isWritePreviewTool(tool)) {
          state.expandedWrites.add(writeToolKey(key, tool));
        }
      }
    }
    const compactionExpanded = state.expandedCompactions.has(key);
    const signature = transcriptMessageSignature(message, compactionExpanded);
    const previous = state.entries[index];
    if (previous?.key === key && previous.signature === signature) {
      updateMessageEntry(previous, message, showThinking, compactionExpanded, {
        syntaxStyle,
        expandedWrites: state.expandedWrites,
        width: options?.width ?? 80,
        onToggleWrite: options?.onToggleWrite,
        verboseTrace,
      });
      nextEntries.push(previous);
      continue;
    }

    if (previous) {
      host.remove(previous.node.id);
      previous.node.destroyRecursively();
    }

    const entry = createMessageEntry(
      ctx,
      message,
      index,
      syntaxStyle,
      subtleSyntaxStyle,
      key,
      signature,
      showThinking,
      options?.width ?? 80,
      verboseTrace,
      compactionExpanded,
      state.expandedWrites,
      options?.onToggleCompaction,
      options?.onToggleWrite,
    );
    if (entry) {
      host.add(entry.node, index);
      nextEntries.push(entry);
    }
  }

  const planIndex = nextEntries.length;
  if (options?.plan) {
    const key = `plan:${hashString(options.plan)}`;
    const previous = state.entries[planIndex];
    if (previous?.key === key) {
      nextEntries.push(previous);
    } else {
      if (previous) {
        host.remove(previous.node.id);
        previous.node.destroyRecursively();
      }
      const node = createPlanRenderable(ctx, options.plan);
      host.add(node, planIndex);
      nextEntries.push({ key, signature: key, node, refs: {} });
    }
  }

  for (let index = state.entries.length - 1; index >= nextEntries.length; index--) {
    const entry = state.entries[index];
    if (!entry) continue;
    host.remove(entry.node.id);
    entry.node.destroyRecursively();
  }

  state.entries = nextEntries;
  host.requestRender();
}

type TranscriptState = {
  entries: TranscriptEntry[];
  expandedCompactions: Set<string>;
  expandedWrites: Set<string>;
  defaultWritesExpanded: boolean;
};

type TranscriptEntry = {
  key: string;
  signature: string;
  node: Renderable;
	refs: {
	    userText?: TextRenderable;
	    userQueuedBox?: BoxRenderable;
	    userQueuedText?: TextRenderable;
    errorText?: TextRenderable;
    statusText?: TextRenderable;
    statusBox?: BoxRenderable;
    reasoningBox?: BoxRenderable;
    reasoningToggleText?: TextRenderable;
    reasoningStreaming?: boolean;
    reasoningPlainText?: TextRenderable;
    reasoningMarkdown?: MarkdownRenderable;
    partsBox?: BoxRenderable;
    partEntries?: Map<string, PartEntryRef>;
    toolsBox?: BoxRenderable;
    toolEntries?: Map<string, ToolEntryRef>;
    answerDividerBox?: BoxRenderable;
    answerDividerText?: TextRenderable;
    contentBox?: BoxRenderable;
    contentMarkdown?: MarkdownRenderable;
    contentCursorBox?: BoxRenderable;
    contentCursorText?: TextRenderable;
    turnSummaryBox?: BoxRenderable;
    turnSummaryText?: TextRenderable;
    compactionExpanded?: boolean;
    compactionToggleText?: TextRenderable;
    compactionContentText?: TextRenderable;
    compactionDetailBox?: BoxRenderable;
  };
};

type ToolEntryRef = {
  signature: string;
  node: Renderable;
};

type PartEntryRef =
  | {
      kind: "text";
      signature: string;
      node: BoxRenderable;
      markdown: MarkdownRenderable;
    }
  | {
      kind: "tools";
      signature: string;
      node: BoxRenderable;
      toolEntries: Map<string, ToolEntryRef>;
    };

function clearTranscriptEntries(host: BoxRenderable, state: TranscriptState) {
  for (const entry of state.entries) {
    host.remove(entry.node.id);
    entry.node.destroyRecursively();
  }
  state.entries = [];
}

function transcriptMessageKey(message: DisplayMessage, index: number) {
  return `${index}:${message.role}`;
}

function transcriptMessageSignature(
  message: DisplayMessage,
  compactionExpanded = false,
) {
  if (message.role !== "assistant") return message.role;
  if (message.syntheticKind === "ui_compact_card") {
    return `compaction:${compactionExpanded ? "expanded" : "collapsed"}:${message.compactionMeta?.turns ?? 0}`;
  }
  const modelSwitch = parseModelSwitchMessage(message.content);
  const pureModelSwitch = modelSwitch && !message.reasoning?.trim() && !(message.toolCalls?.length);
  if (pureModelSwitch) {
    return `assistant:model-switch:${hashString(modelSwitch)}`;
  }
  return [
    message.role,
    "standard",
  ].join(":");
}

function updateMessageEntry(
  entry: TranscriptEntry,
  message: DisplayMessage,
  showThinking = true,
  compactionExpanded = false,
  assistantOptions?: {
    syntaxStyle: SyntaxStyle;
    expandedWrites: Set<string>;
    width: number;
    onToggleWrite?: (key: string) => void;
    verboseTrace?: boolean;
  },
) {
  if (message.role === "user") {
    if (entry.refs.userText) entry.refs.userText.content = message.content || " ";
    if (entry.refs.userQueuedBox) entry.refs.userQueuedBox.visible = message.queued === true;
    if (entry.refs.userQueuedText) entry.refs.userQueuedText.content = message.queued ? " QUEUED " : "";
    return;
  }
  if (message.role === "error") {
    if (entry.refs.errorText) entry.refs.errorText.content = message.content;
    return;
  }
  if (message.syntheticKind === "ui_compact_card") {
    if (entry.refs.compactionToggleText) {
      entry.refs.compactionExpanded = compactionExpanded;
      entry.refs.compactionToggleText.content = compactionToggleLabel(compactionExpanded);
    }
    if (entry.refs.compactionContentText && compactionExpanded) {
      entry.refs.compactionContentText.content = message.content;
    }
    if (entry.refs.compactionDetailBox) {
      entry.refs.compactionDetailBox.visible = compactionExpanded;
    }
    return;
  }
  if (assistantOptions) {
    updateAssistantEntry(entry, message, showThinking, assistantOptions);
    return;
  }
}

function updateAssistantEntry(
  entry: TranscriptEntry,
  message: DisplayMessage,
  showThinking: boolean,
  options: {
    syntaxStyle: SyntaxStyle;
    expandedWrites: Set<string>;
    width: number;
    onToggleWrite?: (key: string) => void;
    verboseTrace?: boolean;
  },
) {
  const content = message.content.trim();
  const visibleReasoning = showThinking ? message.reasoning?.trim() ?? "" : "";
  const tools = message.toolCalls ?? [];
  const parts = message.parts ?? [];
  const hasParts = parts.length > 0;
  const showStatus = !!message.status && !visibleReasoning && !content && tools.length === 0 && !hasParts;

  if (entry.refs.statusText) {
    entry.refs.statusText.content = showStatus ? assistantStatusLabel(message) : "";
  }
  if (entry.refs.statusBox) {
    entry.refs.statusBox.visible = showStatus;
  }
  const streamingReasoning = message.streaming === true;
  if (entry.refs.reasoningToggleText) {
    entry.refs.reasoningStreaming = streamingReasoning;
    entry.refs.reasoningToggleText.content = visibleReasoning
      ? thinkingLabelContent(streamingReasoning, reasoningElapsedMs(message))
      : new StyledText([fg(theme.messageThinkingText)("")]);
  }
  // During streaming we update only the plain text node — cheap per-delta. The
  // markdown node stays hidden + stale. Once streaming ends (turn_end), we
  // pay the parse cost exactly once and swap visibility.
  if (entry.refs.reasoningPlainText) {
    if (streamingReasoning) {
      entry.refs.reasoningPlainText.content = formatThinkingMarkdown(visibleReasoning);
    }
    entry.refs.reasoningPlainText.visible = streamingReasoning && !!visibleReasoning;
  }
  if (entry.refs.reasoningMarkdown) {
    if (!streamingReasoning) {
      syncMarkdownRenderable(
        entry.refs.reasoningMarkdown,
        formatThinkingMarkdown(visibleReasoning),
        false,
      );
    }
    entry.refs.reasoningMarkdown.visible = !streamingReasoning && !!visibleReasoning;
  }
  if (entry.refs.reasoningBox) {
    entry.refs.reasoningBox.visible = !!visibleReasoning;
  }
  if (entry.refs.partsBox) {
    entry.refs.partsBox.visible = hasParts;
  }
  if (hasParts) {
    updateAssistantPartEntries(entry, parts, options, message.streaming === true);
  }
  updateAssistantToolEntries(entry, hasParts ? [] : tools, options);
  if (entry.refs.answerDividerBox) {
    const showDivider = !hasParts && tools.length > 0 && !!content;
    entry.refs.answerDividerBox.visible = showDivider;
    if (entry.refs.answerDividerText) {
      entry.refs.answerDividerText.content = showDivider
        ? answerDividerStyledText()
        : new StyledText([fg(theme.textMuted)("")]);
    }
  }
  if (entry.refs.contentMarkdown) {
    syncMarkdownRenderable(entry.refs.contentMarkdown, content, message.streaming === true);
  }
  if (entry.refs.contentBox) {
    entry.refs.contentBox.visible = !hasParts && !!content;
  }
  if (entry.refs.contentCursorBox) {
    const cursorActive = message.streaming === true && (hasParts ? lastPartHasText(parts) : !!content);
    entry.refs.contentCursorBox.visible = cursorActive;
    if (entry.refs.contentCursorText) entry.refs.contentCursorText.content = cursorActive ? "▌" : "";
  }
  const summaryString = formatTurnSummary(message);
  if (entry.refs.turnSummaryText) {
    entry.refs.turnSummaryText.content = summaryString ?? "";
  }
  if (entry.refs.turnSummaryBox) {
    entry.refs.turnSummaryBox.visible = !!summaryString;
  }
}

function syncMarkdownRenderable(markdown: MarkdownRenderable, content: string, streaming: boolean) {
  if (markdown.content === content && markdown.streaming === streaming) return;
  markdown.content = content;
  markdown.streaming = streaming;
  markdown.clearCache();
}

function updateAssistantPartEntries(
  entry: TranscriptEntry,
  parts: DisplayMessagePart[],
  options: {
    syntaxStyle: SyntaxStyle;
    expandedWrites: Set<string>;
    width: number;
    onToggleWrite?: (key: string) => void;
    verboseTrace?: boolean;
  },
  streaming: boolean,
) {
  const partsBox = entry.refs.partsBox;
  if (!partsBox) return;

  const previousEntries = entry.refs.partEntries ?? new Map<string, PartEntryRef>();
  const nextEntries = new Map<string, PartEntryRef>();

  parts.forEach((part, index) => {
    const key = `part:${index}:${part.type}`;
    const previous = previousEntries.get(key);

    if (part.type === "text") {
      const content = part.content.trim();
      let ref: Extract<PartEntryRef, { kind: "text" }>;
      if (previous?.kind === "text") {
        ref = previous;
      } else {
        if (previous) {
          partsBox.remove(previous.node.id);
          previous.node.destroyRecursively();
        }
        const markdown = createMarkdown(partsBox.ctx, content, options.syntaxStyle, {
          streaming,
          fg: theme.messageAssistantText,
        });
        const node = createBox(partsBox.ctx, {
          paddingLeft: 3,
          marginTop: 1,
          flexDirection: "column",
          flexShrink: 0,
          visible: !!content,
        }, [markdown]);
        partsBox.add(node, index);
        ref = { kind: "text", signature: "text", node, markdown };
      }
      syncMarkdownRenderable(ref.markdown, content, streaming);
      ref.node.visible = !!content;
      nextEntries.set(key, ref);
      return;
    }

    let ref: Extract<PartEntryRef, { kind: "tools" }>;
    if (previous?.kind === "tools") {
      ref = previous;
    } else {
      if (previous) {
        partsBox.remove(previous.node.id);
        previous.node.destroyRecursively();
      }
      const node = createBox(partsBox.ctx, {
        flexDirection: "column",
        flexShrink: 0,
        visible: part.toolCalls.length > 0,
      });
      partsBox.add(node, index);
      ref = { kind: "tools", signature: "tools", node, toolEntries: new Map() };
    }

    const toolHost: TranscriptEntry = {
      key: entry.key,
      signature: entry.signature,
      node: ref.node,
      refs: {
        toolsBox: ref.node,
        toolEntries: ref.toolEntries,
      },
    };
    updateAssistantToolEntries(toolHost, part.toolCalls, options);
    ref.toolEntries = toolHost.refs.toolEntries ?? new Map();
    ref.node.visible = part.toolCalls.length > 0;
    nextEntries.set(key, ref);
  });

  for (const [id, previous] of previousEntries.entries()) {
    if (nextEntries.has(id)) continue;
    partsBox.remove(previous.node.id);
    previous.node.destroyRecursively();
  }

  entry.refs.partEntries = nextEntries;
}

function updateAssistantToolEntries(
  entry: TranscriptEntry,
  tools: DisplayToolCall[],
  options: {
    syntaxStyle: SyntaxStyle;
    expandedWrites: Set<string>;
    width: number;
    onToggleWrite?: (key: string) => void;
    verboseTrace?: boolean;
  },
) {
  const toolsBox = entry.refs.toolsBox;
  if (!toolsBox) return;
  toolsBox.visible = tools.length > 0;

  const previousEntries = entry.refs.toolEntries ?? new Map<string, ToolEntryRef>();
  const nextEntries = new Map<string, ToolEntryRef>();

  const items = options.verboseTrace
    ? tools.map((tool) => ({ kind: "tool" as const, key: `tool:${tool.id}`, tool }))
    : buildTraceGroups(tools).map((group) => ({ kind: "group" as const, key: traceGroupKey(group), group }));

  items.forEach((item, index) => {
    const signature = item.kind === "tool"
      ? toolRenderableSignature(item.tool, options.expandedWrites.has(writeToolKey(entry.key, item.tool)))
      : traceGroupRenderableSignature(item.group);
    const previous = previousEntries.get(item.key);
    if (previous?.signature === signature) {
      nextEntries.set(item.key, previous);
      return;
    }

    if (previous) {
      toolsBox.remove(previous.node.id);
      previous.node.destroyRecursively();
    }
    const node = item.kind === "tool"
      ? createRawToolEntryRenderable(toolsBox.ctx, entry.key, item.tool, options)
      : createTraceGroupRenderable(toolsBox.ctx, item.group, options.syntaxStyle, options.width);
    toolsBox.add(node, index);
    nextEntries.set(item.key, { signature, node });
  });

  for (const [id, previous] of previousEntries.entries()) {
    if (nextEntries.has(id)) continue;
    toolsBox.remove(previous.node.id);
    previous.node.destroyRecursively();
  }

  entry.refs.toolEntries = nextEntries;
}

function createRawToolEntryRenderable(
  ctx: RenderContext,
  messageKey: string,
  tool: DisplayToolCall,
  options: {
    syntaxStyle: SyntaxStyle;
    expandedWrites: Set<string>;
    width: number;
    onToggleWrite?: (key: string) => void;
  },
) {
  const toolKey = writeToolKey(messageKey, tool);
  const writeExpanded = options.expandedWrites.has(toolKey);
  return createToolRenderable(
    ctx,
    tool,
    options.syntaxStyle,
    options.width,
    writeExpanded,
    isWritePreviewTool(tool) ? () => options.onToggleWrite?.(toolKey) : undefined,
  );
}

function createTraceGroupRenderable(ctx: RenderContext, group: TraceGroup, syntaxStyle: SyntaxStyle, width = 80) {
  const rawTool = group.raw.length === 1 ? group.raw[0] as unknown as DisplayToolCall : undefined;
  if (rawTool && shouldRenderTraceGroupAsRawTool(rawTool)) {
    return createToolRenderable(ctx, rawTool, syntaxStyle, width, false);
  }

  const detailLines = traceGroupDetailLines(group);
  const status = traceGroupStatus(group);
  const detailColor = traceGroupDetailColor(group);
  const detailWidth = Math.max(20, width - 10);
  const children: Array<Renderable | null | undefined> = [
    createText(ctx, traceGroupHeaderStyledText(group, width), { wrapMode: "none" }),
  ];

  if (detailLines.length > 0) {
    children.push(createBox(ctx, {
      paddingLeft: 2,
      flexDirection: "column",
      flexShrink: 0,
    }, detailLines.map((line, index) =>
      createText(ctx, `${index === 0 ? "↳ " : "  "}${truncate(line, detailWidth)}`, {
        fg: detailColor,
        wrapMode: "word",
      }),
    )));
  }

  if (group.errorLines.length > 0) {
    children.push(createBox(ctx, {
      paddingLeft: 2,
      flexDirection: "column",
      flexShrink: 0,
    }, group.errorLines.map((line, index) =>
      createText(ctx, `${index === 0 ? "↳ " : "  "}${truncate(line, detailWidth)}`, {
        fg: theme.toolError,
        wrapMode: "word",
      }),
    )));
  }

  if (group.omitted > 0) {
    children.push(createText(ctx, `  ... ${group.omitted} more, Ctrl+O to view`, {
      fg: theme.textMuted,
      wrapMode: "word",
    }));
  }

  return createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, children);
}

function shouldRenderTraceGroupAsRawTool(tool: DisplayToolCall) {
  return tool.name === "question" || tool.name === "todo_write" || tool.name === "edit" || tool.name === "apply_patch";
}

function traceGroupDetailLines(group: TraceGroup) {
  return group.previewLines.length > 0 ? group.previewLines : group.items;
}

function traceGroupStatus(group: TraceGroup): { text: string; color: string } | null {
  if (group.hasError) {
    const count = group.errorCount || 1;
    return { text: count === 1 ? "1 error" : `${count} errors`, color: theme.toolError };
  }
  return null;
}

function traceGroupDetailColor(group: TraceGroup) {
  const allErrored = group.hasError && group.errorCount >= group.raw.length && !group.pending;
  return allErrored ? theme.toolError : theme.toolText;
}

function traceGroupHeaderStyledText(group: TraceGroup, width = 80): StyledText {
  const allErrored = group.hasError && group.errorCount >= group.raw.length && !group.pending;
  const titleColor = allErrored ? theme.toolError : traceGroupTitleColor(group);
  const status = traceGroupStatus(group);
  const commandWidth = Math.max(14, width - group.title.length - 20);
  if (group.pending) {
    return new StyledText([
      fg(theme.toolPending)("● "),
      fg(theme.textMuted)("Working on "),
      fg(titleColor)(truncate(traceGroupCompactLabel(group), Math.max(20, width - 18))),
    ]);
  }
  const chunks: StyledText["chunks"] = [
    fg(titleColor)(bold(group.title)),
  ];
  if (group.command) {
    chunks.push(fg(theme.toolText)(` ${truncate(group.command, commandWidth)}`));
  } else if (group.count !== undefined && group.noun) {
    chunks.push(fg(theme.textMuted)(` ${group.count} ${group.noun}`));
  }
  if (status) {
    chunks.push(fg(status.color)(` ${status.text}`));
  }
  return new StyledText(chunks);
}

function traceGroupCompactLabel(group: TraceGroup) {
  if (group.command) return `${group.title} ${group.command}`;
  if (group.count !== undefined && group.noun) return `${group.title} ${group.count} ${group.noun}`;
  return group.title;
}

function traceGroupTitleColor(group: TraceGroup) {
  switch (group.kind) {
    case "read": return theme.toolRead;
    case "search": return theme.toolSearch;
    case "write": return theme.toolWrite;
    case "execute": return theme.toolShell;
    case "edit": return theme.toolWrite;
    case "subagent": return theme.accent;
    case "list": return theme.secondary;
    default: return theme.toolText;
  }
}

function traceGroupKey(group: TraceGroup) {
  return `group:${group.kind}:${group.raw.map((tool) => tool.id).join(":")}`;
}

function traceGroupRenderableSignature(group: TraceGroup) {
  return [
    traceGroupKey(group),
    group.pending ? "pending" : "settled",
    group.hasError ? `error:${group.errorCount}` : "ok",
    group.count ?? "",
    group.noun ?? "",
    group.command ?? "",
    group.omitted,
    hashString(stableStringify(group.items)),
    hashString(stableStringify(group.previewLines)),
    hashString(stableStringify(group.errorLines)),
    hashString(stableStringify(group.raw.map((rawTool) => {
      const tool = rawTool as unknown as DisplayToolCall;
      return [
        tool.id,
        tool.name,
        tool.status ?? (tool.result === undefined && !tool.resultCollapsed ? "pending" : "completed"),
        tool.isError ? "error" : "ok",
        tool.resultCollapsed ? "collapsed" : "expanded",
        stableStringify(tool.args),
        tool.result ?? "",
        stableStringify(tool.metadata ?? null),
      ];
    }))),
  ].join(":");
}

function toolRenderableSignature(tool: DisplayToolCall, writeExpanded: boolean) {
  return [
    tool.id,
    tool.name,
    tool.status ?? (tool.result === undefined && !tool.resultCollapsed ? "pending" : "completed"),
    tool.isError ? "error" : "ok",
    tool.resultCollapsed ? "collapsed" : "expanded",
    tool.streamingArgs ? "streaming-args" : "args-complete",
    writeExpanded ? "expanded" : "collapsed",
    hashString(stableStringify(tool.args)),
    hashString(tool.rawArguments ?? ""),
    hashString(tool.result ?? ""),
    hashString(stableStringify(tool.metadata ?? null)),
  ].join(":");
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

function stableStringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function createBox(ctx: RenderContext, options: ConstructorParameters<typeof BoxRenderable>[1], children: Array<Renderable | null | undefined> = []) {
  const box = new BoxRenderable(ctx, options);
  for (const child of children) {
    if (child) box.add(child);
  }
  return box;
}

function createText(ctx: RenderContext, content: string | StyledText, options: ConstructorParameters<typeof TextRenderable>[1] = {}) {
  return new TextRenderable(ctx, {
    content,
    fg: theme.text,
    wrapMode: "word",
    ...options,
  });
}

function createMarkdown(
  ctx: RenderContext,
  content: string,
  syntaxStyle: SyntaxStyle,
  options?: { streaming?: boolean; fg?: string; bg?: string },
) {
  return new MarkdownRenderable(ctx, {
    content,
    syntaxStyle,
    treeSitterClient,
    renderNode: createSemanticMarkdownRenderNode(ctx, options?.fg ?? theme.messageAssistantText),
    streaming: options?.streaming === true,
    conceal: true,
    concealCode: false,
    fg: options?.fg ?? theme.messageAssistantText,
    bg: options?.bg ?? theme.background,
    width: "100%",
    flexShrink: 0,
    tableOptions: {
      widthMode: "full",
      columnFitter: "balanced",
      wrapMode: "word",
      cellPadding: 1,
      borders: true,
      borderStyle: "single",
      borderColor: theme.borderSubtle,
      selectable: true,
    },
  });
}

function createSemanticMarkdownRenderNode(ctx: RenderContext, defaultFg: string) {
  const palette = semanticMarkdownPalette(defaultFg);
  return (token: any, context: { defaultRender: () => Renderable | null }) => {
    switch (token?.type) {
      case "hr":
        return createText(ctx, new StyledText([
          fg(theme.borderSubtle)("─".repeat(48)),
        ]), {
          fg: theme.borderSubtle,
          wrapMode: "none",
          flexShrink: 0,
        });
      case "heading":
        return createText(ctx, markdownInlineToStyledText(markdownTokenInlineTokens(token), palette, token.text ?? "", { bold: true }), {
          fg: defaultFg,
          wrapMode: "word",
          flexShrink: 0,
        });
      case "paragraph":
        return createText(ctx, markdownInlineToStyledText(markdownTokenInlineTokens(token), palette, token.text ?? ""), {
          fg: defaultFg,
          wrapMode: "word",
          flexShrink: 0,
        });
      case "list":
        return createMarkdownList(ctx, token, palette, defaultFg);
      default:
        return context.defaultRender();
    }
  };
}

function createMarkdownList(
  ctx: RenderContext,
  token: any,
  palette: SemanticMarkdownPalette,
  defaultFg: string,
) {
  const ordered = token?.ordered === true;
  const start = typeof token?.start === "number" ? token.start : 1;
  const items = Array.isArray(token?.items) ? token.items : [];
  if (items.length === 0) return null;

  return createBox(ctx, {
    flexDirection: "column",
    flexShrink: 0,
  }, items.map((item: any, index: number) => {
    const marker = ordered ? `${start + index}. ` : "• ";
    return createMarkdownListItem(ctx, item, marker, palette, defaultFg);
  }));
}

function createMarkdownListItem(
  ctx: RenderContext,
  item: any,
  marker: string,
  palette: SemanticMarkdownPalette,
  defaultFg: string,
) {
  const tokens = Array.isArray(item?.tokens) ? item.tokens : [];
  const inlineTokens = tokens.filter((child: any) => !isMarkdownListToken(child));
  const nestedLists = tokens.filter(isMarkdownListToken);
  const fallback = tokens.length > 0 ? "" : (item?.text ?? "");
  const children: Renderable[] = [];

  const line = markdownInlineToStyledText(inlineTokens, palette, fallback);
  children.push(createText(ctx, new StyledText([
    fg(theme.textMuted)(marker),
    ...line.chunks,
  ]), {
    fg: defaultFg,
    wrapMode: "word",
    flexShrink: 0,
  }));

  for (const nestedList of nestedLists) {
    const nested = createMarkdownList(ctx, nestedList, palette, defaultFg);
    if (!nested) continue;
    children.push(createBox(ctx, {
      flexDirection: "column",
      flexShrink: 0,
      paddingLeft: Math.max(2, marker.length),
    }, [nested]));
  }

  return children.length === 1
    ? children[0]
    : createBox(ctx, { flexDirection: "column", flexShrink: 0 }, children);
}

function isMarkdownListToken(token: any): boolean {
  return token?.type === "list";
}

function markdownTokenInlineTokens(token: any): any[] | undefined {
  if (Array.isArray(token?.tokens)) return token.tokens;
  if (typeof token?.text === "string") return [{ type: "text", text: token.text }];
  return undefined;
}

interface SemanticMarkdownPalette {
  text: string;
  textMuted: string;
  success: string;
  warning: string;
  secondary: string;
}

function semanticMarkdownPalette(defaultFg: string): SemanticMarkdownPalette {
  return {
    text: defaultFg,
    textMuted: theme.textMuted,
    success: theme.success,
    warning: theme.warning,
    secondary: theme.secondary,
  };
}

function markdownInlineToStyledText(
  tokens: any[] | undefined,
  palette: SemanticMarkdownPalette,
  fallback = "",
  style: Omit<MarkdownInlineSegment, "text"> = {},
): StyledText {
  const chunks = markdownInlineSegments(tokens, fallback, style).map((segment) => {
    let chunk = fg(palette[segment.color ?? "text"])(segment.text);
    if (segment.bold) chunk = bold(chunk);
    if (segment.italic) chunk = italic(chunk);
    if (segment.dim) chunk = dim(chunk);
    return chunk;
  });
  return new StyledText(chunks);
}

function createDiffRenderable(ctx: RenderContext, diff: string, filePath: string | undefined, syntaxStyle: SyntaxStyle, width = 80) {
  return new DiffRenderable(ctx, {
    diff,
    view: diffViewMode(width),
    filetype: filetype(filePath),
    syntaxStyle,
    treeSitterClient,
    showLineNumbers: true,
    width: "100%",
    wrapMode: "word",
    fg: theme.text,
    addedBg: theme.diffAddedBg,
    removedBg: theme.diffRemovedBg,
    contextBg: theme.diffContextBg,
    addedSignColor: theme.diffHighlightAdded,
    removedSignColor: theme.diffHighlightRemoved,
    lineNumberFg: theme.diffLineNumber,
    lineNumberBg: theme.diffContextBg,
    addedLineNumberBg: theme.diffAddedLineNumberBg,
    removedLineNumberBg: theme.diffRemovedLineNumberBg,
  });
}

function renderDiffContent(diff: string, filePath: string | undefined, syntaxStyle: SyntaxStyle, width = 80) {
  return h("diff", {
    diff,
    view: diffViewMode(width),
    filetype: filetype(filePath),
    syntaxStyle,
    treeSitterClient,
    showLineNumbers: true,
    width: "100%",
    wrapMode: "word",
    fg: theme.text,
    addedBg: theme.diffAddedBg,
    removedBg: theme.diffRemovedBg,
    contextBg: theme.diffContextBg,
    addedSignColor: theme.diffHighlightAdded,
    removedSignColor: theme.diffHighlightRemoved,
    lineNumberFg: theme.diffLineNumber,
    lineNumberBg: theme.diffContextBg,
    addedLineNumberBg: theme.diffAddedLineNumberBg,
    removedLineNumberBg: theme.diffRemovedLineNumberBg,
  });
}

function createCodeBlockRenderable(ctx: RenderContext, content: string, filePath: string | undefined, syntaxStyle: SyntaxStyle) {
  const code = new CodeRenderable(ctx, {
    content,
    filetype: filetype(filePath),
    syntaxStyle,
    treeSitterClient,
    conceal: false,
    fg: theme.text,
    width: "100%",
  });
  const lineNumbers = new LineNumberRenderable(ctx, {
    fg: theme.textMuted,
    minWidth: 3,
    paddingRight: 1,
  });
  lineNumbers.add(code);
  return lineNumbers;
}

function createToolRenderHelpers() {
  return {
    theme,
    createBox: (ctx: RenderContext, options: Record<string, unknown>, children?: Array<Renderable | null | undefined>) =>
      createBox(ctx, options as ConstructorParameters<typeof BoxRenderable>[1], children),
    createText: (ctx: RenderContext, content: string | StyledText, options?: Record<string, unknown>) =>
      createText(ctx, content, (options ?? {}) as ConstructorParameters<typeof TextRenderable>[1]),
    createCodeBlockRenderable,
    createDiffRenderable,
    toolColor,
    displayToolName,
    toolHeader,
    toolPath,
    extractToolDiff,
    summarizeToolResult,
    isToolFinished,
    toolPreview,
    toolStateIcon,
  };
}

function renderCodeBlockContent(content: string, filePath: string | undefined, syntaxStyle: SyntaxStyle) {
  return h("line_number", { fg: theme.textMuted, minWidth: 3, paddingRight: 1 },
    h("code", {
      content,
      filetype: filetype(filePath),
      syntaxStyle,
      treeSitterClient,
      conceal: false,
      fg: theme.text,
      width: "100%",
    }),
  );
}

function createMessageEntry(
  ctx: RenderContext,
  message: DisplayMessage,
  index: number,
  syntaxStyle: SyntaxStyle,
  subtleSyntaxStyle: SyntaxStyle,
  key: string,
  signature: string,
  showThinking = true,
  width = 80,
  verboseTrace = false,
  compactionExpanded = false,
  expandedWrites: Set<string> = new Set(),
  onToggleCompaction?: (key: string) => void,
  onToggleWrite?: (key: string) => void,
): TranscriptEntry | null {
  if (message.role === "user") return createUserEntry(ctx, message, index, key, signature);
  if (message.role === "error") return createErrorEntry(ctx, message, key, signature);
  if (message.syntheticKind === "ui_compact_card") return createCompactionCardEntry(ctx, message, key, signature, compactionExpanded, onToggleCompaction);
  return createAssistantEntry(ctx, message, syntaxStyle, subtleSyntaxStyle, key, signature, showThinking, width, verboseTrace, expandedWrites, onToggleWrite);
}

function createUserEntry(ctx: RenderContext, message: DisplayMessage, index: number, key: string, signature: string): TranscriptEntry {
  const refs: TranscriptEntry["refs"] = {};
  const text = createText(ctx, message.content || " ", {
    fg: theme.messageUserText,
    wrapMode: "word",
  });
  refs.userText = text;
  const queuedText = createText(ctx, message.queued ? " QUEUED " : "", {
    fg: theme.background,
    bg: theme.primary,
  });
  refs.userQueuedText = queuedText;
  const queuedBox = createBox(ctx, {
    paddingTop: 1,
    visible: message.queued === true,
  }, [queuedText]);
  refs.userQueuedBox = queuedBox;
  const node = createBox(ctx, {
    border: ["left"],
    borderColor: theme.primary,
    marginTop: index === 0 ? 0 : 1,
    backgroundColor: theme.backgroundPanel,
    flexShrink: 0,
  }, [
    createBox(ctx, {
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      backgroundColor: theme.backgroundPanel,
      flexShrink: 0,
      flexDirection: "column",
    }, [text, queuedBox]),
  ]);
  return { key, signature, node, refs };
}

function createErrorEntry(ctx: RenderContext, message: DisplayMessage, key: string, signature: string): TranscriptEntry {
  const refs: TranscriptEntry["refs"] = {};
  const text = createText(ctx, message.content, {
    fg: theme.error,
    wrapMode: "word",
  });
  refs.errorText = text;
  const node = createBox(ctx, {
    border: ["left"],
    borderColor: theme.error,
    marginTop: 1,
    paddingLeft: 2,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: theme.backgroundPanel,
    flexShrink: 0,
  }, [text]);
  return { key, signature, node, refs };
}

function createAssistantEntry(
  ctx: RenderContext,
  message: DisplayMessage,
  syntaxStyle: SyntaxStyle,
  subtleSyntaxStyle: SyntaxStyle,
  key: string,
  signature: string,
  showThinking = true,
  width = 80,
  verboseTrace = false,
  expandedWrites: Set<string> = new Set(),
  onToggleWrite?: (key: string) => void,
): TranscriptEntry | null {
  const modelSwitch = parseModelSwitchMessage(message.content);
  if (modelSwitch && !message.reasoning?.trim() && !(message.toolCalls?.length)) {
    return createModelSwitchEntry(ctx, modelSwitch, key, signature);
  }

  const children: Renderable[] = [];
  const refs: TranscriptEntry["refs"] = {};
  const visibleReasoning = showThinking ? message.reasoning?.trim() : "";
  const content = message.content.trim();
  const tools = message.toolCalls ?? [];
  const parts = message.parts ?? [];
  const hasParts = parts.length > 0;
  const showStatus = !!message.status && !visibleReasoning && !content && tools.length === 0 && !hasParts;

  const status = createText(ctx, assistantStatusLabel(message), {
    fg: theme.messageThinkingText,
  });
  refs.statusText = status;
  const statusBox = createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexShrink: 0,
    visible: showStatus,
  }, [status]);
  refs.statusBox = statusBox;
  children.push(statusBox);

  const labelText = createText(ctx, thinkingLabelContent(message.streaming === true, reasoningElapsedMs(message)), {
    fg: theme.messageThinkingText,
    wrapMode: "none",
  });
  refs.reasoningToggleText = labelText;
  const streamingReasoning = message.streaming === true;
  refs.reasoningStreaming = streamingReasoning;
  // While the model is still streaming we render reasoning as plain text — a
  // single TextRenderable.content update is cheap, whereas re-parsing markdown
  // (treesitter + cache clear) per token grows to O(N²) and freezes the TUI.
  // The markdown variant is parsed once at turn_end and only then becomes
  // visible.
  const plainText = createText(ctx, formatThinkingMarkdown(visibleReasoning ?? ""), {
    fg: theme.messageThinkingContentText,
    wrapMode: "word",
    visible: streamingReasoning && !!visibleReasoning,
  });
  refs.reasoningPlainText = plainText;
  const markdown = createMarkdown(ctx, streamingReasoning ? "" : formatThinkingMarkdown(visibleReasoning ?? ""), subtleSyntaxStyle, {
    streaming: false,
    fg: theme.messageThinkingContentText,
  });
  markdown.visible = !streamingReasoning && !!visibleReasoning;
  refs.reasoningMarkdown = markdown;
  const reasoningBox = createBox(ctx, {
    paddingLeft: 2,
    marginTop: 1,
    border: ["left"],
    borderColor: theme.messageThinkingBorder,
    flexDirection: "column",
    flexShrink: 0,
    visible: !!visibleReasoning,
  }, [
    createBox(ctx, {
      flexShrink: 0,
    }, [labelText]),
    plainText,
    markdown,
  ]);
  refs.reasoningBox = reasoningBox;
  children.push(reasoningBox);

  const partsBox = createBox(ctx, {
    flexDirection: "column",
    flexShrink: 0,
    visible: hasParts,
  });
  refs.partsBox = partsBox;
  refs.partEntries = new Map();
  children.push(partsBox);

  const toolsBox = createBox(ctx, {
    flexDirection: "column",
    flexShrink: 0,
    visible: !hasParts && tools.length > 0,
  });
  refs.toolsBox = toolsBox;
  refs.toolEntries = new Map();
  children.push(toolsBox);

  const showAnswerDivider = !hasParts && tools.length > 0 && !!content;
  const answerDividerText = createText(ctx, showAnswerDivider ? answerDividerStyledText() : new StyledText([fg(theme.textMuted)("")]), { wrapMode: "none" });
  refs.answerDividerText = answerDividerText;
  const answerDividerBox = createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexShrink: 0,
    visible: showAnswerDivider,
  }, [answerDividerText]);
  refs.answerDividerBox = answerDividerBox;
  children.push(answerDividerBox);

  const contentMarkdown = createMarkdown(ctx, content, syntaxStyle, {
    streaming: message.streaming === true,
    fg: theme.messageAssistantText,
  });
  refs.contentMarkdown = contentMarkdown;
  const contentBox = createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
    visible: !hasParts && !!content,
  }, [contentMarkdown]);
  refs.contentBox = contentBox;
  children.push(contentBox);

  const cursorActive = message.streaming === true && (hasParts ? lastPartHasText(parts) : !!content);
  const contentCursorText = createText(ctx, "▌", { fg: theme.primary, wrapMode: "none" });
  refs.contentCursorText = contentCursorText;
  const contentCursorBox = createBox(ctx, {
    paddingLeft: 3,
    flexShrink: 0,
    visible: cursorActive,
  }, [contentCursorText]);
  refs.contentCursorBox = contentCursorBox;
  children.push(contentCursorBox);

  const summaryString = formatTurnSummary(message);
  const turnSummaryText = createText(ctx, summaryString ?? "", { fg: theme.textMuted, wrapMode: "none" });
  refs.turnSummaryText = turnSummaryText;
  const turnSummaryBox = createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexShrink: 0,
    visible: !!summaryString,
  }, [turnSummaryText]);
  refs.turnSummaryBox = turnSummaryBox;
  children.push(turnSummaryBox);

  const entry: TranscriptEntry = {
    key,
    signature,
    node: createBox(ctx, { flexDirection: "column", flexShrink: 0 }, children),
    refs,
  };
  updateAssistantToolEntries(entry, hasParts ? [] : tools, {
    syntaxStyle,
    expandedWrites,
    width,
    onToggleWrite,
    verboseTrace,
  });
  if (hasParts) {
    updateAssistantPartEntries(entry, parts, {
      syntaxStyle,
      expandedWrites,
      width,
      onToggleWrite,
      verboseTrace,
    }, message.streaming === true);
  }
  return entry;
}

function answerDividerStyledText(): StyledText {
  return new StyledText([
    fg(theme.accent)("◆ "),
    fg(theme.textMuted)(italic("Answer")),
  ]);
}

function createCompactionCardEntry(
  ctx: RenderContext,
  message: DisplayMessage,
  key: string,
  signature: string,
  expanded: boolean,
  onToggle?: (key: string) => void,
): TranscriptEntry {
  const refs: TranscriptEntry["refs"] = {};
  const meta = message.compactionMeta;
  const statsParts: string[] = [];
  if (meta?.turns) statsParts.push(`${meta.turns} turn${meta.turns === 1 ? "" : "s"}`);
  if (meta?.messages) statsParts.push(`${meta.messages} message${meta.messages === 1 ? "" : "s"}`);
  const statsLine = statsParts.length > 0 ? statsParts.join(" · ") : "Compacted";

  const children: Renderable[] = [];

  const headerRow = createBox(ctx, {
    flexDirection: "row",
    gap: 1,
    flexShrink: 0,
    alignItems: "center",
  }, [
    createText(ctx, new StyledText([
      fg(theme.info)(bold("◈ Context Compacted")),
    ]), { width: 20 }),
    createText(ctx, new StyledText([
      fg(theme.textMuted)(`─ ${statsLine}`),
    ])),
  ]);
  children.push(headerRow);

  if (meta?.summarySections && meta.summarySections.length > 0) {
    const sectionLines: string[] = [];
    for (const section of meta.summarySections) {
      const firstLine = section.content.split("\n")[0] || "";
      sectionLines.push(`${section.label}: ${firstLine}`);
    }
    const collapsedPreview = createBox(ctx, {
      flexDirection: "column",
      paddingLeft: 2,
      flexShrink: 0,
      visible: !expanded,
    }, [
      createText(ctx, sectionLines.join("\n"), {
        fg: theme.textMuted,
        wrapMode: "word",
      }),
    ]);
    children.push(collapsedPreview);
    refs.compactionDetailBox = collapsedPreview;
  }

  let contentTextRef: TextRenderable | undefined;
  const compactionContentText = createText(ctx, message.content, {
    fg: theme.textMuted,
    wrapMode: "word",
  });
  contentTextRef = compactionContentText;
  refs.compactionContentText = contentTextRef;

  const expandedContent = createBox(ctx, {
    flexDirection: "column",
    paddingLeft: 2,
    gap: 1,
    flexShrink: 0,
    visible: expanded,
  }, [compactionContentText]);
  children.push(expandedContent);

  const toggleText = createText(ctx, compactionToggleLabel(expanded), {
    fg: theme.secondary,
    wrapMode: "none",
    marginTop: 1,
  });
  refs.compactionToggleText = toggleText;
  refs.compactionExpanded = expanded;

  const toggleRow = createBox(ctx, {
    flexShrink: 0,
    paddingLeft: 2,
    onMouseUp: () => onToggle?.(key),
  }, [toggleText]);
  children.push(toggleRow);

  const node = createBox(ctx, {
    border: true,
    borderColor: theme.info,
    backgroundColor: theme.backgroundPanel,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, children);

  return { key, signature, node, refs };
}

function compactionToggleLabel(expanded: boolean): string {
  return expanded ? "▲ Show less" : "▼ Show details";
}

function createModelSwitchEntry(ctx: RenderContext, model: string, key: string, signature: string): TranscriptEntry {
  const node = createBox(ctx, {
    border: ["left"],
    borderColor: theme.success,
    marginTop: 1,
    paddingLeft: 2,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: theme.backgroundPanel,
    flexShrink: 0,
  }, [
    createText(ctx, modelSwitchStyledText(model), {
      wrapMode: "none",
    }),
  ]);
  return { key, signature, node, refs: {} };
}

function createTodoWriteRenderable(ctx: RenderContext, tool: DisplayToolCall) {
  const todos = (tool.args.todos as Todo[]) || [];
  const summary = tool.result || "";

  if (!isToolFinished(tool)) {
    return createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexDirection: "column",
      flexShrink: 0,
    }, [
      createText(ctx, `→ Planning tasks...`, { fg: toolColor(tool) }),
    ]);
  }

  return createBox(ctx, {
    border: ["left"],
    borderColor: theme.borderSubtle,
    backgroundColor: theme.backgroundPanel,
    marginTop: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    flexDirection: "column",
    flexShrink: 0,
  }, [
    createText(ctx, `# Todo  ${summary ? `— ${summary}` : ""}`, { fg: theme.textMuted }),
    ...todos.map((todo, index) => {
      const completed = todo.status === "completed";
      const inProgress = todo.status === "in_progress";
      const marker = completed ? "✓" : inProgress ? "◉" : "○";
      const fg = completed ? theme.success : inProgress ? theme.warning : theme.textMuted;
      return createText(ctx, `  ${marker} ${todo.content}`, {
        fg,
        marginTop: index === 0 ? 1 : 0,
      });
    }),
  ]);
}

function createToolRenderable(
  ctx: RenderContext,
  tool: DisplayToolCall,
  syntaxStyle: SyntaxStyle,
  width = 80,
  writeExpanded = false,
  onToggleWrite?: () => void,
) {
  if (tool.name === "question") {
    return createQuestionToolRenderable(ctx, tool);
  }
  if (tool.name === "todo_write") {
    return createTodoWriteRenderable(ctx, tool);
  }
  const renderer = findToolRenderer(tool);
  if (renderer) {
    return renderer.render({
      ctx,
      tool,
      syntaxStyle,
      width,
      writeExpanded,
      onToggleWrite,
      helpers: createToolRenderHelpers(),
    });
  }
  throw new Error(`No renderer for tool '${tool.name}'`);
}

function createQuestionToolRenderable(ctx: RenderContext, tool: DisplayToolCall) {
  const questions = questionToolQuestions(tool);
  const answers = questionToolAnswers(tool);
  const rejected = isQuestionRejected(tool);
  if (!isToolFinished(tool) || !answers) {
    return createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexDirection: "column",
      flexShrink: 0,
    }, [
      createText(ctx, `→ ${rejected ? "Asked" : "Asking"} questions...`, {
        fg: rejected ? theme.textMuted : toolColor(tool),
        attributes: rejected ? TextAttributes.STRIKETHROUGH : undefined,
      }),
    ]);
  }

  return createBox(ctx, {
    border: ["left"],
    borderColor: theme.borderSubtle,
    backgroundColor: theme.backgroundPanel,
    marginTop: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    flexDirection: "column",
    flexShrink: 0,
  }, [
    createText(ctx, "# Questions", { fg: theme.textMuted }),
    ...questions.map((question, index) =>
      createBox(ctx, { flexDirection: "column", gap: 0, marginTop: index === 0 ? 1 : 0, flexShrink: 0 }, [
        createText(ctx, question.question, { fg: theme.textMuted }),
        createText(ctx, formatQuestionAnswer(answers[index]), { fg: theme.text }),
      ]),
    ),
  ]);
}

function createPlanRenderable(ctx: RenderContext, plan: string) {
  return createBox(ctx, {
    border: true,
    borderColor: theme.warning,
    backgroundColor: theme.backgroundPanel,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, [
    createText(ctx, "◆ Plan approval", { fg: theme.warning }),
    createText(ctx, truncate(plan, 1800), { fg: theme.text, wrapMode: "word", marginTop: 1 }),
    createText(ctx, "enter/y approve · n/esc reject", { fg: theme.textMuted, marginTop: 1 }),
  ]);
}

function renderTraceGroup(group: TraceGroup, syntaxStyle: SyntaxStyle, width = 80) {
  const rawTool = group.raw.length === 1 ? group.raw[0] as unknown as DisplayToolCall : undefined;
  if (rawTool && shouldRenderTraceGroupAsRawTool(rawTool)) {
    return renderTool(rawTool, syntaxStyle, width);
  }

  const detailLines = traceGroupDetailLines(group);
  const status = traceGroupStatus(group);
  const detailColor = traceGroupDetailColor(group);
  const detailWidth = Math.max(20, width - 10);

  return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
    h("text", {
      content: traceGroupHeaderStyledText(group, width),
      wrapMode: "none",
    }),
    detailLines.length > 0
      ? h("box", { paddingLeft: 2, flexDirection: "column", flexShrink: 0 },
        detailLines.map((line, index) =>
          h("text", {
            fg: detailColor,
            wrapMode: "word",
          }, `${index === 0 ? "↳ " : "  "}${truncate(line, detailWidth)}`),
        ),
      )
      : null,
    group.errorLines.length > 0
      ? h("box", { paddingLeft: 2, flexDirection: "column", flexShrink: 0 },
        group.errorLines.map((line, index) =>
          h("text", {
            fg: theme.toolError,
            wrapMode: "word",
          }, `${index === 0 ? "↳ " : "  "}${truncate(line, detailWidth)}`),
        ),
      )
      : null,
    group.omitted > 0
      ? h("text", { fg: theme.textMuted, wrapMode: "word" }, `  ... ${group.omitted} more, Ctrl+O to view`)
      : null,
  );
}

function renderTool(tool: DisplayToolCall, syntaxStyle: SyntaxStyle, width = 80) {
  if (tool.name === "question") {
    return renderQuestionTool(tool);
  }
  const icon = toolStateIcon(tool);
  const color = toolColor(tool);
  const diff = extractToolDiff(tool);
  if (diff && !tool.resultCollapsed && !tool.isError && (tool.name === "edit" || tool.name === "apply_patch")) {
    return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      h("text", { fg: color },
        `${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
      ),
      h("box", { paddingLeft: 1, marginTop: 1, border: ["left"], borderColor: theme.borderSubtle, flexDirection: "column", flexShrink: 0 },
        renderDiffContent(diff, toolPath(tool), syntaxStyle, width),
      ),
    );
  }
  if (!tool.resultCollapsed && isWritePreviewTool(tool)) {
    const hasContent = typeof tool.args.content === "string";
    const contentStr = hasContent ? String(tool.args.content) : "";
    const preview = hasContent ? formatWritePreview(contentStr, false) : null;
    const lineCount = hasContent
      ? contentStr.split(/\r?\n/).length
      : (tool.streamingNewlineCount ?? 0) + 1;
    const summary = tool.result ?? `${isToolFinished(tool) ? "Prepared" : "Writing"} ${lineCount} lines to ${toolPath(tool) ?? "file"}`;
    return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      h("text", { fg: color },
        `${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
      ),
      h("box", { paddingLeft: 1, marginTop: 0, border: ["left"], borderColor: theme.borderSubtle, flexDirection: "column", flexShrink: 0 },
        h("text", { fg: theme.textMuted }, `└ ${summary}`),
        preview ? renderCodeBlockContent(preview.content, toolPath(tool), syntaxStyle) : null,
        preview && preview.omittedLines > 0
          ? h("text", { fg: theme.textMuted }, `... +${preview.omittedLines} lines (click or /write-previews to expand)`)
          : preview && preview.omittedChars > 0
            ? h("text", { fg: theme.textMuted }, `... +${preview.omittedChars} chars (click or /write-previews to expand)`)
            : null,
      ),
    );
  }
  return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
    h("text", { fg: color },
      `${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
    ),
    () => tool.result ? h("text", { fg: tool.isError ? theme.toolError : theme.textMuted, wrapMode: "word" }, toolSummaryWithPreview(tool)) : null,
  );
}

function renderQuestionTool(tool: DisplayToolCall) {
  const questions = questionToolQuestions(tool);
  const answers = questionToolAnswers(tool);
  const rejected = isQuestionRejected(tool);
  if (!isToolFinished(tool) || !answers) {
    return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      h("text", {
        fg: rejected ? theme.textMuted : toolColor(tool),
        attributes: rejected ? TextAttributes.STRIKETHROUGH : undefined,
      }, `→ ${rejected ? "Asked" : "Asking"} questions...`),
    );
  }

  return h("box", {
    border: ["left"],
    borderColor: theme.borderSubtle,
    backgroundColor: theme.backgroundPanel,
    marginTop: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    flexDirection: "column",
    flexShrink: 0,
  },
  h("text", { fg: theme.textMuted }, "# Questions"),
  questions.map((question, index) =>
    h("box", { flexDirection: "column", marginTop: index === 0 ? 1 : 0, flexShrink: 0 },
      h("text", { fg: theme.textMuted, wrapMode: "word" }, question.question),
      h("text", { fg: theme.text, wrapMode: "word" }, formatQuestionAnswer(answers[index])),
    ),
  ));
}

function renderPlanPrompt(plan: string) {
  return h("box", {
    border: true,
    borderColor: theme.warning,
    backgroundColor: theme.backgroundPanel,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
    marginTop: 1,
    flexDirection: "column",
  },
    h("text", { fg: theme.warning }, "◆ Plan approval"),
    h("text", { fg: theme.text, wrapMode: "word", marginTop: 1 }, truncate(plan, 1800)),
    h("text", { fg: theme.textMuted, marginTop: 1 }, "enter/y approve · n/esc reject"),
  );
}

function renderTodos(todos: Todo[]) {
  return h("box", { flexDirection: "column", marginTop: 1, paddingLeft: 1, border: ["left"], borderColor: theme.border },
    h("text", { fg: theme.accent }, "Todos"),
    todos.slice(0, 6).map((todo) => {
      const marker = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○";
      const color = todo.status === "in_progress" ? theme.primary : theme.textMuted;
      return h("text", { fg: color }, `${marker} ${todo.activeForm || todo.content}`);
    }),
  );
}

function renderFooter(input: {
  cwd: string;
  mode: () => PermissionMode;
  running: () => boolean;
  registerScanner: (sync: PromptScannerSync) => () => void;
  registerModeBadge?: (ref: TextRenderable) => void;
  traceVerbose?: () => boolean;
  registerTraceBadge?: (ref: TextRenderable) => void;
}) {
  return h("box", { flexShrink: 0, height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row" },
    h("text", { fg: theme.border }, "─ "),
    h(PromptScanner, {
      running: input.running,
      register: input.registerScanner,
      idleContent: `${shortCwd(input.cwd)}  idle`,
      idleFg: theme.textMuted,
      runningFg: theme.primary,
    }),
    h("text", {
      fg: permissionModeColor(input.mode()),
      ref: input.registerModeBadge,
    }, footerPermissionModeText(input.mode())),
    h("text", {
      fg: input.traceVerbose?.() ? theme.warning : theme.textMuted,
      ref: input.registerTraceBadge,
    }, footerTraceModeText(input.traceVerbose?.() === true)),
    h("box", { flexGrow: 1 }),
  );
}

function pickerTitle(kind: Exclude<PickerMode, "key">, providerId?: string) {
  switch (kind) {
    case "model":
      if (providerId) {
        const provider = BUILTIN_PROVIDERS.find((item) => item.id === providerId);
        return provider ? `${provider.name} Models` : "Select Model";
      }
      return "Select Model";
    case "provider":
      return "Connect Provider";
    case "provider-add":
      return "Add Provider";
    case "provider-auth": {
      const provider = providerId ? BUILTIN_PROVIDERS.find((item) => item.id === providerId) : undefined;
      return provider ? `${provider.name} Auth` : "Select Auth Method";
    }
    case "login":
      return "Select Login Provider";
    case "logout":
      return "Select Logout Provider";
    case "skill":
      return "Skills";
    case "slash":
      return "Commands";
    case "file":
      return "Files";
    case "mcp-reconnect":
      return "MCP servers — Enter or r to reconnect";
    case "feishu-setup":
      return "Feishu Setup";
  }
}

function getModelPickerReasoningLevels(providerId: string, modelId: string): ThinkingLevel[] {
  if (providerId !== "deepseek" || (modelId !== "deepseek-v4-flash" && modelId !== "deepseek-v4-pro")) {
    return [];
  }
  return getAvailableThinkingLevels(providerId, modelId);
}

function displayModelWithThinking(model: string, thinkingLevel: ThinkingLevel): string {
  if (!model) return "";
  const { providerId, modelId } = decodeModel(model);
  if (!providerId) return displayModel(model);
  const levels = getAvailableThinkingLevels(providerId, modelId);
  if (levels.length > 1 && thinkingLevel !== "off") {
    return `${displayModel(model)} (${thinkingLevel})`;
  }
  return displayModel(model);
}

function preferredPickerIndex(kind: Exclude<PickerMode, "key">, items: PickerItem[]) {
  if (kind === "model") {
    const agentCurrent = items.findIndex((item) => item.detail?.includes("current"));
    if (agentCurrent >= 0) return agentCurrent;
  }
  if (kind === "provider") {
    const current = items.findIndex((item) => item.detail?.includes("default"));
    if (current >= 0) return current;
  }
  return 0;
}

function fuzzyMatch(value: string, query: string) {
  let cursor = 0;
  for (const char of query) {
    cursor = value.indexOf(char, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

function formatDock(input: {
  picker: PickerState | undefined;
  plan?: string;
  selectedOption?: number;
}): string | StyledText {
  if (input.plan) return formatPlanDock(input.plan, input.selectedOption ?? 0);
  const state = input.picker;
  if (!state) return "";
  if (state.kind === "select" && (state.mode === "slash" || state.mode === "file")) return "";
  if (state.kind === "key") {
    return [
      `╭─ ${state.title}`,
      "│ paste or type the key in the prompt, then press Enter",
      "╰─ esc cancel",
    ].join("\n");
  }
  if (state.loading) {
    return [
      `╭─ ${state.title}`,
      "│ Loading…",
      "╰─ esc cancel",
    ].join("\n");
  }
  const range = state.items.length
    ? ` ${state.index + 1}/${state.items.length}`
    : "";
  const query = state.query ? ` · filter: ${state.query}` : "";
  if (state.items.length > 0) {
    return [
      `╭─ ${state.title}${range}${query}`,
      "╰─ type filter · ↑/↓ move · enter select · esc cancel",
    ].join("\n");
  }
  return [
    `╭─ ${state.title}${range}${query}`,
    "│ (no options available)",
    "╰─ type filter · ↑/↓ move · enter select · esc cancel",
  ].join("\n");
}

function formatPlanDock(plan: string, selectedOption: number): StyledText {
  const previewLines = formatDockPreviewLines(plan, { maxLines: 6, maxWidth: 110 });
  const chunks: StyledText["chunks"] = [];
  chunks.push(fg(theme.warning)("┃ "));
  chunks.push(fg(theme.warning)(bold("△ ")));
  chunks.push(fg(theme.text)(bold("Plan approval required\n")));
  chunks.push(fg(theme.warning)("┃\n"));
  for (const line of previewLines) {
    chunks.push(fg(theme.warning)("┃  "));
    chunks.push(fg(theme.toolText)(`${line || " "}\n`));
  }
  chunks.push(fg(theme.warning)("┃\n"));
  chunks.push(fg(theme.warning)("┃  "));
  const options = ["Approve", "Reject"];
  for (let i = 0; i < options.length; i++) {
    if (i > 0) chunks.push(fg(theme.text)("  "));
    if (i === selectedOption) {
      chunks.push(bg(theme.warning)(fg("#000000")(bold(` ${options[i]} `))));
    } else {
      chunks.push(bg(theme.backgroundElement)(fg(theme.textMuted)(` ${options[i]} `)));
    }
  }
  chunks.push(fg(theme.text)("\n"));
  chunks.push(fg(theme.warning)("┃  "));
  chunks.push(dim(fg(theme.textMuted)("⇆ select · enter confirm · esc reject\n")));
  return new StyledText(chunks);
}

function formatDockPreviewLines(value: string, options: { maxLines: number; maxWidth: number }) {
  const normalized = value.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  let truncated = false;

  for (const rawLine of normalized) {
    if (lines.length >= options.maxLines) {
      truncated = true;
      break;
    }

    if (rawLine.length <= options.maxWidth) {
      lines.push(rawLine || " ");
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > options.maxWidth) {
      if (lines.length >= options.maxLines) {
        truncated = true;
        break;
      }
      lines.push(remaining.slice(0, options.maxWidth));
      remaining = remaining.slice(options.maxWidth);
    }
    if (truncated || lines.length >= options.maxLines) break;
    lines.push(remaining || " ");
  }

  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = truncate(lines[lines.length - 1] || "", Math.max(8, options.maxWidth - 1));
  }

  return lines.slice(0, options.maxLines);
}

function selectHeight(state: Extract<PickerState, { kind: "select" }>, maxRows = 10) {
  if (state.mode === "slash" || state.mode === "file") {
    return Math.max(1, Math.min(10, maxRows, state.items.length || 1));
  }
  if (!state.items.length) return 1;
  const linesPerItem = 2;
  return Math.max(linesPerItem, Math.min(10, state.items.length * linesPerItem));
}

function toSelectOption(item: PickerItem): SelectOption {
  return {
    name: item.label,
    description: item.detail ?? "",
    value: item.value,
  };
}

function nextImageLabelIndex(messages: DisplayMessage[]): number {
  let max = 0;
  for (const message of messages) {
    for (const match of message.content.matchAll(imageAttachmentLabelPattern())) {
      max = Math.max(max, Number(match[1] ?? 0));
    }
  }
  return max + 1;
}

function imageExtensionFromUrl(url: string): string {
  const mediaMatch = url.match(/^data:image\/([^;,]+)/i);
  const media = mediaMatch?.[1]?.toLowerCase();
  if (media === "jpeg") return "jpg";
  if (media === "png" || media === "webp" || media === "gif" || media === "bmp") return media;
  const pathMatch = url.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return pathMatch?.[1]?.toLowerCase() || "png";
}

function formatDisplayContentParts(content: ContentPart[], labelStart: number): string {
  const text = content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  let imageIndex = labelStart;
  const imageLines = content
    .filter((part): part is Extract<ContentPart, { type: "image_url" }> => part.type === "image_url")
    .map((part) => `[image#${imageIndex++}.${imageExtensionFromUrl(part.image_url.url)}]`);
  return [text, ...imageLines].filter(Boolean).join("\n") || "(multimedia)";
}

function reconstructDisplayMessages(agentMessages: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const message of agentMessages) {
    if (message.role === "system" || message.role === "meta" || message.role === "tool") continue;
    if (message.role === "user") {
      result.push({
        role: "user",
        content: typeof message.content === "string"
          ? message.content
          : formatDisplayContentParts(message.content, nextImageLabelIndex(result)),
      });
      continue;
    }
    const toolCalls: DisplayToolCall[] = [];
    for (const tc of message.toolCalls ?? []) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.arguments || "{}") as Record<string, any>;
      } catch {}
      const toolResult = agentMessages.find((candidate) => candidate.role === "tool" && (candidate as any).toolCallId === tc.id);
      toolCalls.push({
        id: tc.id,
        name: tc.name,
        args,
        result: toolResult ? (toolResult as any).content as string : undefined,
        isError: toolResult ? ((toolResult as any).isError ?? (toolResult as any).content?.startsWith?.("Error:")) : false,
        metadata: toolResult ? (toolResult as any).metadata : undefined,
        status: toolResult
          ? (((toolResult as any).isError ?? (toolResult as any).content?.startsWith?.("Error:")) ? "error" : "completed")
          : "pending",
      });
    }
    result.push({
      role: "assistant",
      content: message.content,
      reasoning: message.reasoning || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
  }
  return result;
}

type TranscriptOptions = {
  cwd: string;
  width: number;
  tip?: string;
  plan?: string;
  selectedOption?: number;
  showThinking?: boolean;
  verboseTrace?: boolean;
  onToggleCompaction?: (key: string) => void;
  onToggleWrite?: (key: string) => void;
};

function renderTranscript(
  messages: DisplayMessage[],
  options: TranscriptOptions | undefined,
  syntaxStyle: SyntaxStyle,
  subtleSyntaxStyle: SyntaxStyle,
) {
  const showThinking = options?.showThinking ?? true;
  const verboseTrace = options?.verboseTrace ?? false;
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  if (!visibleMessages.length) return null;
  const items = visibleMessages.map((message, index) =>
    renderMessage(message, index, syntaxStyle, subtleSyntaxStyle, showThinking, verboseTrace, options?.width ?? 80)
  );
  if (options?.plan) items.push(renderPlanPrompt(options.plan));
  return items;
}

function renderSessionMessages(messages: DisplayMessage[], syntaxStyle: SyntaxStyle, subtleSyntaxStyle: SyntaxStyle, showThinking = true, verboseTrace = false) {
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  if (!visibleMessages.length) return null;
  return visibleMessages.map((message, index) => renderMessage(message, index, syntaxStyle, subtleSyntaxStyle, showThinking, verboseTrace));
}

function formatTranscript(messages: DisplayMessage[], options?: TranscriptOptions): StyledText {
  const showThinking = options?.showThinking ?? true;
  const verboseTrace = options?.verboseTrace ?? false;
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  const chunks: StyledText["chunks"] = [];
  const append = (content: string, color = theme.text) => {
    if (content) chunks.push(fg(color)(content));
  };
  const appendLine = (content = "", color = theme.text) => {
    append(`${content}\n`, color);
  };
  const appendBlank = () => {
    if (chunks.length > 0) appendLine("");
  };

  for (const [index, message] of visibleMessages.entries()) {
    if (message.role === "user") {
      if (index > 0) appendBlank();
      appendUserTranscript(chunks, message.content);
      continue;
    }
    if (message.role === "error") {
      appendBlank();
      appendLine("│  Error", theme.error);
      for (const line of message.content.split(/\r?\n/)) {
        append("│  ", theme.error);
        appendLine(line || " ", theme.error);
      }
      continue;
    }
    const visibleReasoning = showThinking ? message.reasoning?.trim() : "";
    if (visibleReasoning) {
      appendBlank();
      append("│  ", theme.messageThinkingBorder);
      chunks.push(fg(theme.messageThinkingText)(italic("Thinking\n")));
      append("│  ", theme.messageThinkingBorder);
      appendLine(truncate(formatThinkingMarkdown(visibleReasoning), 500), theme.messageThinkingContentText);
    }
    if (message.status && !visibleReasoning && !message.content.trim() && !(message.toolCalls?.length) && !(message.parts?.length)) {
      appendBlank();
      append("   ", theme.borderSubtle);
      appendLine(assistantStatusLabel(message), theme.messageThinkingText);
    }
    const parts = message.parts ?? [];
    if (parts.length > 0) {
      for (const part of parts) {
        if (part.type === "text") {
          appendAssistantTextTranscript(chunks, part.content);
          continue;
        }
        if (verboseTrace) {
          for (const tool of part.toolCalls) appendRawToolTranscript(chunks, tool);
        } else {
          for (const group of buildTraceGroups(part.toolCalls)) appendTraceGroupTranscript(chunks, group);
        }
      }
      continue;
    }
    if (verboseTrace) {
      for (const tool of message.toolCalls ?? []) {
        appendRawToolTranscript(chunks, tool);
      }
    } else {
      for (const group of buildTraceGroups(message.toolCalls ?? [])) appendTraceGroupTranscript(chunks, group);
    }
    if (message.content.trim()) {
      const modelSwitch = parseModelSwitchMessage(message.content);
      if (modelSwitch && !visibleReasoning && !(message.toolCalls?.length)) {
        appendBlank();
        append("│  ", theme.success);
        append("◆ Model", theme.success);
        append(" switched to ", theme.textMuted);
        appendLine(modelSwitch, theme.primary);
        continue;
      }
      appendAssistantTextTranscript(chunks, message.content);
    }
  }
  if (options?.plan) appendPlanTranscript(chunks, options.plan, options.selectedOption ?? 0);
  return new StyledText(chunks);
}

function appendAssistantTextTranscript(chunks: StyledText["chunks"], content: string) {
  const trimmed = content.trim();
  if (!trimmed) return;
  chunks.push(fg(theme.text)("\n"));
  for (const line of trimmed.split(/\r?\n/)) {
    chunks.push(fg(theme.borderSubtle)("   "));
    chunks.push(fg(theme.messageAssistantText)(`${line || " "}\n`));
  }
}

function appendRawToolTranscript(chunks: StyledText["chunks"], tool: DisplayToolCall) {
  const append = (content: string, color = theme.text) => {
    if (content) chunks.push(fg(color)(content));
  };
  const appendLine = (content = "", color = theme.text) => {
    append(`${content}\n`, color);
  };

  appendLine("");
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch" ? "✎" : "●";
  const color = toolColor(tool);
  append(`   ${icon} `, color);
  append(displayToolName(tool.name), color);
  const header = toolHeader(tool);
  if (header) append(` ${header}`, theme.toolText);
  appendLine("");
  append("     ", theme.borderSubtle);
  appendLine(summarizeToolResult(tool), tool.isError ? theme.toolError : theme.textMuted);
  const preview = toolPreview(tool);
  if (preview) {
    for (const line of preview.lines) {
      append("     ", theme.borderSubtle);
      appendLine(line, theme.toolText);
    }
    if (preview.omitted > 0) {
      append("     ", theme.borderSubtle);
      appendLine(`+ ${preview.omitted} more`, theme.textMuted);
    }
  }
}

function appendTraceGroupTranscript(chunks: StyledText["chunks"], group: TraceGroup) {
  const rawTool = group.raw.length === 1 ? group.raw[0] as unknown as DisplayToolCall : undefined;
  if (rawTool && shouldRenderTraceGroupAsRawTool(rawTool)) {
    appendRawToolTranscript(chunks, rawTool);
    return;
  }

  const append = (content: string, color = theme.text) => {
    if (content) chunks.push(fg(color)(content));
  };
  const appendLine = (content = "", color = theme.text) => {
    append(`${content}\n`, color);
  };

  appendLine("");
  append("   ", theme.borderSubtle);
  append(traceGroupLabel(group), traceGroupTitleColor(group));
  const status = traceGroupStatus(group);
  if (status) append(` ${status.text}`, status.color);
  appendLine("");
  if (group.pending) return;
  const detailLines = traceGroupDetailLines(group);
  const detailColor = traceGroupDetailColor(group);
  for (const [index, line] of detailLines.entries()) {
    append("     ", theme.borderSubtle);
    appendLine(`${index === 0 ? "↳ " : "  "}${line}`, detailColor);
  }
  for (const [index, line] of group.errorLines.entries()) {
    append("     ", theme.borderSubtle);
    appendLine(`${index === 0 ? "↳ " : "  "}${line}`, theme.toolError);
  }
  if (group.omitted > 0) {
    append("     ", theme.borderSubtle);
    appendLine(`... ${group.omitted} more, Ctrl+O to view`, theme.textMuted);
  }
}

function renderHomeState(input: { width: number; cwd: string; tip: string }) {
  const width = Math.max(20, input.width);
  const cwd = input.cwd ? shortCwd(input.cwd) : "";
  const logoLines = bubbleWordmarkForWidth(width);
  return h("box", {
    flexGrow: 1,
    minHeight: 0,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  h("box", { flexDirection: "column", flexShrink: 0, width: "100%" },
    h("text", { fg: theme.text }, ""),
    h("text", { fg: theme.text }, ""),
    ...logoLines.map((line) => renderHomeLogoLine(line, width)),
    h("text", { fg: theme.text }, ""),
    h("text", { fg: theme.warning }, centerLine(`● Tip  ${input.tip}`, width)),
    cwd ? h("text", { fg: theme.textMuted }, centerLine(`  ${cwd}`, width)) : null,
  ));
}

function hasRenderableMessage(message: DisplayMessage, showThinking = true) {
  if (message.role === "error") return !!message.content.trim();
  if (message.role === "user") return !!message.content.trim();
  if (message.status) return true;
  if (showThinking && message.reasoning?.trim()) return true;
  if (message.content.trim()) return true;
  if ((message.parts?.length ?? 0) > 0) return true;
  return (message.toolCalls?.length ?? 0) > 0;
}

function formatThinkingMarkdown(content: string) {
  const trimmed = content.trim();
  return trimmed;
}

function appendUserTranscript(chunks: StyledText["chunks"], content: string) {
  const lines = content.split(/\r?\n/);
  chunks.push(fg(theme.messageUserBorder)("│\n"));
  for (const line of lines) {
    chunks.push(fg(theme.messageUserBorder)("│  "));
    chunks.push(fg(theme.messageUserText)(`${line || " "}\n`));
  }
  chunks.push(fg(theme.messageUserBorder)("│\n"));
}

function appendPlanTranscript(chunks: StyledText["chunks"], plan: string, selectedOption: number) {
  const lines = formatDockPreviewLines(plan, { maxLines: 6, maxWidth: 120 });
  chunks.push(fg(theme.text)("\n"));
  chunks.push(fg(theme.warning)("┃ "));
  chunks.push(fg(theme.warning)(bold("△ ")));
  chunks.push(bold(fg(theme.text)("Plan approval required\n")));
  for (const line of lines) {
    chunks.push(fg(theme.warning)("┃  "));
    chunks.push(fg(theme.toolText)(`${line || " "}\n`));
  }
  chunks.push(fg(theme.warning)("┃  "));
  const options = ["Approve", "Reject"];
  for (let i = 0; i < options.length; i++) {
    if (i > 0) chunks.push(fg(theme.text)("  "));
    if (i === selectedOption) {
      chunks.push(bg(theme.warning)(fg("#000000")(bold(` ${options[i]} `))));
    } else {
      chunks.push(bg(theme.backgroundElement)(fg(theme.textMuted)(` ${options[i]} `)));
    }
  }
  chunks.push(fg(theme.text)("\n"));
  chunks.push(fg(theme.warning)("┃  "));
  chunks.push(dim(fg(theme.textMuted)("⇆ select · enter confirm · esc reject\n")));
}

function centerLine(line: string, width: number) {
  const pad = Math.max(0, Math.floor((width - plainWidth(line)) / 2));
  return `${" ".repeat(pad)}${line}`;
}

function plainWidth(line: string) {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function getApprovalPanelMeta(request: ApprovalRequest) {
  if (request.type === "bash") {
    return {
      icon: "#",
      title: "Shell command",
      subtitle: "",
      preview: `$ ${request.command}`,
      previewHeight: 3,
      previewColor: theme.text,
    };
  }

  if (request.type === "lsp") {
    const path = shortCwd(request.path);
    return {
      icon: "?",
      title: `LSP ${request.operation}`,
      subtitle: "",
      preview: path,
      previewHeight: 3,
      previewColor: theme.text,
      path: request.path,
    };
  }

  const path = shortCwd(request.path);
  if (request.type === "edit") {
    return {
      icon: "→",
      title: `Edit ${path}`,
      subtitle: "",
      preview: request.diff || "No diff provided",
      previewHeight: 8,
      previewColor: request.diff ? theme.toolText : theme.textMuted,
      diff: request.diff,
      path: request.path,
    };
  }

  if (request.type === "patch") {
    return {
      icon: "→",
      title: `Patch ${path}`,
      subtitle: `${request.paths.length} file${request.paths.length === 1 ? "" : "s"}`,
      preview: request.diff || "No diff provided",
      previewHeight: 10,
      previewColor: request.diff ? theme.toolText : theme.textMuted,
      diff: request.diff,
      path: request.paths[0] ?? request.path,
    };
  }

  return {
    icon: "→",
    title: `Write ${path}`,
    subtitle: "",
    preview: request.diff || request.content || "No content provided",
    previewHeight: 8,
    previewColor: request.diff || request.content ? theme.toolText : theme.textMuted,
    diff: request.diff,
    path: request.path,
  };
}

function colorLuminance(color: string) {
  const hex = color.replace("#", "");
  const normalized = hex.length === 8 ? hex.slice(0, 6) : hex;
  if (normalized.length !== 6) return undefined;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isLightTheme() {
  const luminance = colorLuminance(theme.background);
  return luminance !== undefined && luminance > 160;
}

function modalBackdropColor() {
  return isLightTheme() ? theme.backgroundElement : RGBA.fromInts(0, 0, 0, 150);
}

function contrastText(color: string) {
  const luminance = colorLuminance(color);
  if (luminance === undefined) return theme.text;
  return luminance > 160 ? "#111827" : "#F8FAFC";
}

function promptModeBadgeContent(mode: PermissionMode): StyledText {
  const color = permissionModeColor(mode);
  const label = permissionModeBadgeLabel(mode);
  return new StyledText([
    bg(color)(fg(contrastText(color))(bold(` ${label} `))),
  ]);
}

function permissionModeBadgeLabel(mode: PermissionMode) {
  switch (mode) {
    case "default": return "Build";
    case "plan": return "Plan";
    case "bypassPermissions": return "Bypass";
  }
}

function footerPermissionModeText(mode: PermissionMode) {
  const info = PERMISSION_MODE_INFO[mode];
  if (mode === "default") return "  mode: build · shift+tab plan";
  if (mode === "plan") return "  mode: plan · shift+tab bypass";
  return `  mode: ${info.shortTitle} · shift+tab build`;
}

function footerTraceModeText(verbose: boolean) {
  return verbose ? "  trace: verbose · ctrl+o compact" : "  trace: compact · ctrl+o verbose";
}

function permissionModeColor(mode: PermissionMode) {
  const info = PERMISSION_MODE_INFO[mode];
  switch (info.color) {
    case "accent": return theme.accent;
    case "success": return theme.success;
    case "warning": return theme.warning;
    case "error": return theme.error;
    case "muted": return theme.primary;
  }
}

function toolColor(tool: DisplayToolCall) {
  if (tool.isError) return theme.toolError;
  if (!isToolFinished(tool)) return theme.toolPending;
  if (tool.name === "bash") return theme.toolShell;
  if (tool.name === "read") return theme.toolRead;
  if (tool.name === "write" || tool.name === "edit" || tool.name === "apply_patch") return theme.toolWrite;
  if (tool.name === "grep" || tool.name === "glob" || tool.name === "web_search" || tool.name === "web_fetch") return theme.toolSearch;
  return theme.toolSuccess;
}

function displayToolName(name: string): string {
  const labels: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    apply_patch: "Patch",
    bash: "Shell",
    grep: "Grep",
    glob: "Glob",
    web_fetch: "WebFetch",
    web_search: "WebSearch",
    subagent: "Subagent",
    spawn_agent: "SpawnAgent",
    wait_agent: "WaitAgent",
    send_input: "SendInput",
    close_agent: "CloseAgent",
    task: "Task",
    todo: "Todo",
    question: "Questions",
  };
  return labels[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function toolHeader(tool: DisplayToolCall): string {
  const args = tool.args || {};
  if (tool.name === "subagent") {
    if (typeof args.agent === "string") return `(${args.agent})`;
    if (Array.isArray(args.tasks)) return `(${args.tasks.length} tasks)`;
  }
  if (tool.name === "spawn_agent") {
    const agent = args.agent_type ?? args.agent ?? "default";
    return `(${agent})`;
  }
  if (tool.name === "wait_agent" || tool.name === "send_input" || tool.name === "close_agent") {
    const agentId = args.agent_id ?? (Array.isArray(args.agent_ids) ? `${args.agent_ids.length} agents` : undefined);
    return agentId ? `(${truncate(String(agentId), 64)})` : "";
  }
  const value = args.path ?? args.command ?? args.pattern ?? args.url ?? args.query ?? toolPath(tool);
  return value ? `(${truncate(String(value).replace(/\n/g, " "), 64)})` : "";
}

function toolPath(tool: DisplayToolCall): string | undefined {
  const value = tool.args?.path
    ?? tool.args?.filePath
    ?? tool.metadata?.path
    ?? (Array.isArray(tool.metadata?.paths) ? tool.metadata.paths[0] : undefined);
  return typeof value === "string" ? value : undefined;
}

function extractToolDiff(tool: DisplayToolCall): string | undefined {
  if (tool.resultCollapsed) return undefined;
  if (typeof tool.metadata?.diff === "string" && tool.metadata.diff.trim().length > 0) {
    return tool.metadata.diff.trim();
  }
  if (!tool.result) return undefined;
  if (
    tool.result.includes("✂") ||
    tool.result.includes("chars truncated") ||
    tool.result.includes("chars omitted for UI")
  ) {
    return undefined;
  }
  const marker = "\n\nDiff:\n";
  const index = tool.result.indexOf(marker);
  if (index === -1) return undefined;
  const rawDiff = tool.result.slice(index + marker.length);
  const diagnosticsIndex = rawDiff.search(/\n\nLSP diagnostics in /);
  const diff = diagnosticsIndex === -1 ? rawDiff : rawDiff.slice(0, diagnosticsIndex);
  return diff.trim().length > 0 ? diff : undefined;
}

function diffViewMode(width = 80): "unified" | "split" {
  return width > 120 ? "split" : "unified";
}

function filetype(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "typescript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? map[ext] : undefined;
}

function summarizeToolResult(tool: DisplayToolCall): string {
  if (!isToolFinished(tool)) {
    if (tool.status === "running") return "running";
    return tool.streamingArgs ? "preparing" : "pending";
  }
  if (tool.name === "question") {
    if (isQuestionRejected(tool)) return "dismissed";
    const count = questionToolQuestions(tool).length || (Array.isArray(tool.args?.questions) ? tool.args.questions.length : 0);
    return `asked ${count} question${count === 1 ? "" : "s"}`;
  }
  const result = tool.result ?? "";
  if (tool.isError) return truncate(result.split("\n").find(Boolean) || "error", 120);
  const lines = result.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim()).length;
  const matches = typeof tool.metadata?.matches === "number" ? tool.metadata.matches : undefined;
  if (tool.name === "read") return "";
  if (tool.name === "edit" || tool.name === "apply_patch") return "patched file";
  if (tool.name === "write") return "wrote file";
  if (tool.name === "grep" || tool.name === "glob") {
    if (matches !== undefined) return `${matches} match${matches === 1 ? "" : "es"}`;
    return lines ? `${lines} line${lines === 1 ? "" : "s"}` : "no matches";
  }
  if (tool.name === "bash") {
    if (matches !== undefined) return `${matches} match${matches === 1 ? "" : "es"}`;
    return lines ? `${lines} line${lines === 1 ? "" : "s"} output` : "done";
  }
  return lines ? `${lines} line${lines === 1 ? "" : "s"}` : "done";
}

function toolStateIcon(tool: DisplayToolCall): string {
  if (tool.isError || tool.status === "error") return "✗";
  if (!isToolFinished(tool)) {
    if (tool.status === "running") return "◐";
    return "◌";
  }
  if (tool.name === "bash") return "$";
  if (tool.name === "edit" || tool.name === "apply_patch") return "✎";
  if (tool.name === "write") return "✎";
  if (tool.name === "read") return "▤";
  if (tool.name === "grep" || tool.name === "glob") return "⌕";
  if (tool.name === "web_fetch" || tool.name === "web_search") return "⌖";
  return "●";
}

function toolSummaryWithPreview(tool: DisplayToolCall): string {
  const summary = `  ${summarizeToolResult(tool)}`;
  const preview = toolPreview(tool);
  if (!preview) return summary;
  const lines = preview.lines.map((line) => `  ${line}`);
  if (preview.omitted > 0) {
    lines.push(`  + ${preview.omitted} more`);
  }
  return [summary, ...lines].join("\n");
}

function toolPreview(tool: DisplayToolCall): { lines: string[]; omitted: number } | undefined {
  if (!isToolFinished(tool) || tool.isError || !tool.result) return undefined;
  if (tool.name !== "glob") return undefined;

  const lines = tool.result
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return undefined;

  const previewLines = lines.slice(0, 3).map((line) => truncate(line, 120));
  return {
    lines: previewLines,
    omitted: Math.max(0, lines.length - previewLines.length),
  };
}

function questionToolQuestions(tool: DisplayToolCall): QuestionPrompt[] {
  const fromMetadata = tool.metadata?.questions;
  const source = Array.isArray(fromMetadata) ? fromMetadata : Array.isArray(tool.args?.questions) ? tool.args.questions : [];
  return source
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      header: typeof item.header === "string" ? item.header : "",
      question: typeof item.question === "string" ? item.question : "",
      options: Array.isArray(item.options)
        ? item.options
            .filter((opt): opt is Record<string, unknown> => !!opt && typeof opt === "object")
            .map((opt) => ({
              label: typeof opt.label === "string" ? opt.label : "",
              description: typeof opt.description === "string" ? opt.description : "",
            }))
        : [],
      multiple: item.multiple === true,
      custom: item.custom === false ? false : undefined,
    }))
    .filter((item) => item.question);
}

function questionToolAnswers(tool: DisplayToolCall): QuestionAnswer[] | undefined {
  const value = tool.metadata?.answers;
  if (!Array.isArray(value)) return undefined;
  return value.map((answer) => Array.isArray(answer) ? answer.map((item) => String(item)) : []);
}

function isQuestionRejected(tool: DisplayToolCall): boolean {
  return tool.name === "question" && (tool.isError === true || tool.status === "error") && (
    tool.result?.includes("QuestionRejectedError") === true ||
    tool.result?.includes("dismissed this question") === true ||
    tool.metadata?.rejected === true
  );
}

function formatQuestionAnswer(answer?: ReadonlyArray<string>) {
  return answer?.length ? answer.join(", ") : "(no answer)";
}

function isToolFinished(tool: DisplayToolCall): boolean {
  return tool.status === "completed" || tool.status === "error" || tool.resultCollapsed === true || tool.result !== undefined;
}

function assistantStatusLabel(message: DisplayMessage): string {
  if (message.status === "responding") return "Responding...";
  if (message.streaming) return "Thinking...";
  return "Thinking";
}

function buildContextGauge(percent: number, barWidth: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;
  const block = filled > 0 ? "█".repeat(filled) : "";
  const space = empty > 0 ? "░".repeat(empty) : "";
  return `${block}${space}`;
}

function buildGaugeLabel(percent: number, remainingTokens?: number): string {
  const remaining = remainingTokens === undefined ? "" : ` · ${formatContextRemaining(remainingTokens)} left`;
  if (percent >= 95) return `⚠ Compact imminent${remaining}`;
  if (percent >= 80) return `⚠ Approaching limit${remaining}`;
  if (percent >= 60) return `● Context growing${remaining}`;
  if (percent > 0) return `○ Available${remaining}`;
  return "○ Empty";
}

function formatContextRemaining(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 100_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function thinkingLabelContent(streaming = false, elapsedMs?: number): StyledText {
  void elapsedMs;
  const label = streaming ? "Thinking..." : "Thought";
  return new StyledText([
    fg(theme.messageThinkingText)(italic(label)),
  ]);
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  let minutes = Math.floor(seconds / 60);
  let remSec = Math.round(seconds - minutes * 60);
  // Math.round can lift remSec to exactly 60 (e.g. 239.6s → 3m60s). Carry into minutes.
  if (remSec >= 60) {
    minutes += Math.floor(remSec / 60);
    remSec = remSec % 60;
  }
  return remSec === 0 ? `${minutes}m` : `${minutes}m ${remSec}s`;
}

function reasoningElapsedMs(message: DisplayMessage): number | undefined {
  if (message.turnStartedAt === undefined) return undefined;
  const end = !message.streaming ? (message.turnCompletedAt ?? Date.now()) : Date.now();
  const diff = end - message.turnStartedAt;
  return diff > 0 ? diff : undefined;
}

function toolElapsedMs(tool: DisplayToolCall): number | undefined {
  if (tool.startedAt === undefined) return undefined;
  const end = tool.completedAt ?? (tool.status === "completed" || tool.status === "error" ? Date.now() : undefined);
  if (end === undefined) return undefined;
  const diff = end - tool.startedAt;
  return diff > 0 ? diff : undefined;
}

function turnElapsedMs(message: DisplayMessage): number | undefined {
  if (message.turnStartedAt === undefined) return undefined;
  const end = message.turnCompletedAt ?? Date.now();
  const diff = end - message.turnStartedAt;
  return diff > 0 ? diff : undefined;
}

function formatTurnSummary(message: DisplayMessage): string | undefined {
  if (message.taskElapsedMs === undefined) return undefined;
  return `Task duration: ${formatDuration(message.taskElapsedMs)}`;
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, Math.max(1, max - 1)).trimEnd() + "…" : value;
}

function formatCompactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatCurrency(value: number) {
  if (value < 0.0001) return "$0.0000";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function sidebarStatusColor(kind: string) {
  if (kind === "connected") return theme.success;
  if (kind === "failed") return theme.error;
  if (kind === "disabled") return theme.textMuted;
  return theme.warning;
}

function shortCwd(cwd: string) {
  const home = process.env.HOME;
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}
