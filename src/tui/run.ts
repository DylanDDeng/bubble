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
import { AgentAbortError, type Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { ContentPart, Message, PermissionMode, PlanDecision, Provider, ThinkingLevel, Todo, TokenUsage } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import { BUILTIN_PROVIDERS, decodeModel, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { listBuiltinModels } from "../model-catalog.js";
import { calculateUsageCost } from "../model-pricing.js";
import { getAvailableThinkingLevels } from "../provider-transform.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { sourceRank } from "../slash-commands/unified.js";
import { sidebarMcpRowsFromStates, renderMcpRowMarker, type SidebarMcpRow } from "./sidebar-mcp.js";
import { expandAtMentions, filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import { compactDisplayMessages, type DisplayMessage, type DisplayToolCall } from "./display-history.js";
import { createMarkdownSyntaxStyle, createSubtleMarkdownSyntaxStyle } from "./markdown-theme.js";
import { hashString } from "./render-signature.js";
import { StreamingRedrawThrottler, type RedrawReason } from "./streaming-redraw.js";
import { findToolRenderer } from "./tool-renderers/registry.js";
import { finishStreamingToolCall, upsertStreamingToolCall } from "./tool-renderers/streaming.js";
import { writeToolExpansionDigest, writeToolKey } from "./tool-renderers/write.js";
import { formatWritePreview, isWritePreviewTool } from "./tool-renderers/write-preview.js";
import { getNextPermissionMode, PERMISSION_MODE_INFO } from "../permission/mode.js";
import { getContextBudget } from "../context/budget.js";
import { getLspService, type LspService, type LspStatus } from "../lsp/index.js";
import { inferBashPrefix, type BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { QuestionAnswer, QuestionController, QuestionPrompt, QuestionRequest } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
import { createFrames } from "./opencode-spinner.js";
import { copyTextToClipboard } from "./clipboard.js";
import { readGitSidebarState, type SidebarFileChange, type SidebarGitState } from "./sidebar-state.js";
import {
  buildImageContentPartsFromLabels,
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
type ModalKeyOwner = "approval" | "question" | "provider" | "picker";

const treeSitterClient = getTreeSitterClient();
const PROMPT_HISTORY_LIMIT = 100;

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

const LOCAL_SLASH_COMMANDS = [
  {
    name: "thinking",
    description: "Toggle thinking block visibility",
  },
  {
    name: "toggle-thinking",
    description: "Toggle thinking block visibility",
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

const HOME_LOGO = [
  " /\\_/\\  █▀▀▄ █  █ █▀▀▄ █▀▀▄ █    █▀▀",
  "( o.o ) █▀▀▄ █  █ █▀▀▄ █▀▀▄ █    █▀▀",
  " > ^ <  ▀▀▀  ▀▀▀▀ ▀▀▀  ▀▀▀  ▀▀▀▀ ▀▀▀▀",
];

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
type PickerMode = "model" | "key" | "provider" | "provider-add" | "provider-auth" | "login" | "logout" | "skill" | "slash" | "file" | "mcp-reconnect";
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
type QuestionPanelState = {
  request: QuestionRequest;
  tab: number;
  selected: number;
  answers: QuestionAnswer[];
  custom: string[];
  editing: boolean;
};
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
        resolve();
      }
    };

    try {
      theme = resolveTheme(options.theme);
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

function resolveTheme(overrides?: Record<string, string>) {
  if (!overrides) return DEFAULT_THEME;
  const next = { ...DEFAULT_THEME };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in next)) continue;
    if (!isColorValue(value)) continue;
    (next as Record<string, string>)[key] = value;
  }
  return next;
}

function isColorValue(value: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value)
    || /^#[0-9a-fA-F]{8}$/.test(value)
    || value === "transparent"
    || value === "none";
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
  let exitRequested = false;
  async function requestExit() {
    if (exitRequested) return;
    exitRequested = true;
    try {
      await props.options.flushMemory?.();
    } catch {
      // Memory extraction is best-effort and must not trap the TUI on exit.
    } finally {
      props.onExit();
    }
  }

  let displayMessages = reconstructDisplayMessages(props.agent.messages);
  const homeTip = HOME_TIPS[Math.floor(Math.random() * HOME_TIPS.length)] ?? HOME_TIPS[0]!;
  const homePrompt = HOME_PROMPTS[Math.floor(Math.random() * HOME_PROMPTS.length)] ?? HOME_PROMPTS[0]!;
  let promptText = "";
  let promptHistory = displayMessages
    .filter((message) => message.role === "user" && message.content !== "(multimedia)")
    .map((message) => message.content)
    .slice(-PROMPT_HISTORY_LIMIT);
  let nextImageAttachmentIndex = nextImageLabelIndex(displayMessages);
  const pendingImageAttachments = new Map<string, ImageAttachment>();
  let composerImageResolutionSeq = 0;
  let applyingComposerImageReplacement = false;
  let promptHistoryIndex: number | undefined;
  let promptHistoryDraft = "";
  const [isRunning, setIsRunning] = createSignal(false);
  let activeRun: { id: number; abortController: AbortController } | undefined;
  let nextRunId = 0;
  const [showThinking, setShowThinking] = createSignal(true);
  let streamingDisplay: DisplayMessage | undefined;
  let sidebarLspSyncTimer: ReturnType<typeof setInterval> | undefined;
  const [todos, setTodos] = createSignal<Todo[]>(props.agent.getTodos());
  const [mode, setMode] = createSignal<PermissionMode>(props.agent.mode);
  const [notice, setNotice] = createSignal("");
  let copyToastClearTimer: ReturnType<typeof setTimeout> | undefined;
  let copyToastRoot: BoxRenderable | undefined;
  let copyToastText: TextRenderable | undefined;
  const [sessionActive, setSessionActive] = createSignal(false);
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
  const questionSyncTimers = new Set<ReturnType<typeof setTimeout>>();
  let pendingApprovalRef: { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void } | undefined;
  const PLAN_OPTIONS = ["Approve", "Reject"] as const;
  const [approvalOptionIdx, setApprovalOptionIdx] = createSignal(0);
  let picker: PickerState | undefined;
  let providerDialog: ProviderDialogState | undefined;
  let previousPickerForKey: Extract<PickerState, { kind: "select" }> | undefined;
  let homePromptRef: TextareaRenderable | undefined;
  let sessionPromptRef: TextareaRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  let transcriptScrollFollowing = true;
  let transcriptScrollInitialized = false;
  let rootBox: BoxRenderable | undefined;
  let sidebarShell: BoxRenderable | undefined;
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
  const STREAMING_TOOL_CALL_REDRAW_INTERVAL_MS = 80;
  const streamingToolCallRedraw = new StreamingRedrawThrottler(STREAMING_TOOL_CALL_REDRAW_INTERVAL_MS);
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
    promptHistory.push(value);
    if (promptHistory.length > PROMPT_HISTORY_LIMIT) {
      promptHistory = promptHistory.slice(-PROMPT_HISTORY_LIMIT);
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

  const canInsertPromptNewline = () => !isRunning() && !pendingApproval() && !pendingPlan() && !pendingQuestion();

  const sidebarVisible = () => sessionActive() && dimensions().width > SESSION_SIDEBAR_AUTO_WIDTH;
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

  const cycleMode = () => {
    if (picker || pendingPlan()) return false;
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

  function activeModalKeyOwner(): ModalKeyOwner | undefined {
    if (pendingApproval() || pendingPlan()) return "approval";
    if (pendingQuestion()) return "question";
    if (providerDialog) return "provider";
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
      case "provider":
        return handleProviderDialogKey(event);
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
    streamingToolCallRedraw.cancel();
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
    return compactDisplayMessages(extra ? [...displayMessages, extra] : displayMessages);
  }

  function hasTranscriptMessages(extra?: DisplayMessage) {
    return currentTranscriptMessages(extra).some((message) => hasRenderableMessage(message, showThinking()));
  }

  function isHomeSurfaceActive(extra?: DisplayMessage) {
    return !hasTranscriptMessages(extra) && !pendingPlan() && !pendingQuestion();
  }

  function syncPromptSurfaces(focus = false) {
    const homeActive = isHomeSurfaceActive(streamingDisplay);
    setSessionActive(!homeActive);
    const questionActive = !!pendingQuestion();
    if (homeComposerShell) homeComposerShell.visible = homeActive && !questionActive;
    if (sessionComposerShell) sessionComposerShell.visible = !homeActive && !questionActive;
    syncSidebarChrome();
    if (focus) setTimeout(() => activePrompt()?.focus(), 0);
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
    const run = { id: ++nextRunId, abortController: new AbortController() };
    activeRun = run;
    setRunningState(true);
    return run;
  }

  function finishAgentRun(run: { id: number; abortController: AbortController }) {
    if (activeRun?.id === run.id) activeRun = undefined;
    setRunningState(false);
  }

  function cancelActiveAgentRun() {
    if (!activeRun || activeRun.abortController.signal.aborted) return false;
    activeRun.abortController.abort(new AgentAbortError("Agent run cancelled by user."));
    setNotice("Agent run cancelled");
    redrawDock();
    return true;
  }

  function preventGlobalKey(event: any) {
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  function routeRunningCancel(name: string, event?: any) {
    if (name !== "escape") return false;
    if (!cancelActiveAgentRun()) return false;
    if (event) preventGlobalKey(event);
    return true;
  }

  function routeGlobalRawSequence(sequence: string) {
    const name = keyNameFromSequence(sequence);
    if (routeRunningCancel(name)) return true;
    if (routeModalRawSequence(sequence)) return true;
    if (cycleModeFromRawSequence(sequence)) return true;
    return false;
  }

  function routeGlobalKeyEvent(event: any) {
    const name = keyNameFromEvent(event);
    if (event.ctrl && name === "c") {
      void requestExit();
      return true;
    }
    if (routeRunningCancel(name, event)) return true;
    // Ctrl+Shift+M opens the MCP reconnect picker. Shift is required because
    // bare Ctrl+M is Enter on most terminals (historical TTY mapping).
    if (event.ctrl && event.shift && name === "m") {
      openMcpReconnectPicker();
      event.preventDefault?.();
      return true;
    }
    if (event.ctrl && name === "t" && !picker) {
      toggleThinkingVisibility();
      event.preventDefault?.();
      return true;
    }
    if (event.ctrl && name === "o" && !picker) {
      toggleVisibleWriteBlocks();
      event.preventDefault?.();
      return true;
    }
    if (routeModalKey(event)) return true;
    if (cycleModeFromKey(event)) return true;
    if (event.ctrl && name === "p" && !picker && !isRunning()) {
      openCommandPalette();
      event.preventDefault?.();
      return true;
    }
    return false;
  }

  function transcriptOptions() {
    return {
      cwd: props.args.cwd,
      width: contentWidth(),
      tip: homeTip,
      renderHome: renderHomeSurface,
      plan: pendingPlan()?.plan,
      selectedOption: approvalOptionIdx(),
      showThinking: showThinking(),
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
      .filter((message) => hasRenderableMessage(message, showThinking()));
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
    reason: RedrawReason = "normal",
  ) {
    streamingDisplay = extra;
    streamingToolCallRedraw.schedule(reason, () => {
      renderTranscriptNow(streamingDisplay, reason === "streaming-tool-call" ? displayMessages : baseMessages);
    });
  }

  function renderTranscriptNow(extra?: DisplayMessage, baseMessages = displayMessages) {
    const shouldFollow = shouldFollowTranscriptBeforeUpdate();
    const nextMessages = compactDisplayMessages(extra ? [...baseMessages, extra] : baseMessages);
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
  }

  function closeProviderDialog() {
    providerDialog = undefined;
    providerDialogRoot && (providerDialogRoot.visible = false);
    providerDialogPanel && (providerDialogPanel.visible = false);
    providerDialogRoot?.requestRender();
    setTimeout(() => activePrompt()?.focus(), 0);
  }

  function providerDialogItemsFor(step: ProviderDialogStep, providerId?: string) {
    if (step === "providers") return buildProviderConnectItems();
    if (step === "auth") return providerId ? buildPickerItems("provider-auth", providerId) : [];
    if (step === "skills") return buildSkillItems();
    if (step === "models") {
      const modelItems = buildPickerItems("model", providerId);
      if (modelItems.length || providerId) return modelItems;
      return buildProviderConnectItems()
        .filter((item) => item.category === "Popular")
        .slice(0, 6)
        .map((item) => ({ ...item, category: "Popular providers" }));
    }
    return [];
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
    providerDialogRoot.backgroundColor = RGBA.fromInts(0, 0, 0, 150);
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
    redrawTranscript(undefined, []);
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
    if (isRunning()) return;
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

  async function handleInput(input: string) {
    setNotice("");
    const labeledInput = buildImageContentPartsFromLabels(input, pendingImageAttachments);
    if (labeledInput.actualInput) {
      await runAgentInput(await expandTextParts(labeledInput.actualInput), labeledInput.displayInput);
      for (const label of labeledInput.usedLabels) pendingImageAttachments.delete(label);
      return;
    }

    const imageInput = await resolveImageInput(input, { labelStart: nextImageAttachmentIndex });
    for (const error of imageInput.errors) addMessage("error", `Skipped image: ${error}`);

    if (imageInput.attachments.length > 0) {
      await runAgentInput(await expandTextParts(imageInput.actualInput as ContentPart[]), imageInput.displayInput);
      nextImageAttachmentIndex += imageInput.attachments.length;
      return;
    }

    if (imageInput.imagePathCount > 0) return;

    if (input.startsWith("/")) {
      const skillInvocation = parseSkillInvocation(input, skills);
      if (skillInvocation) {
        await runAgentInput(skillInvocation.actualPrompt, input);
        return;
      }

      const handled = await executeSlash(input);
      if (handled) return;
    }

    const expansion = await expandAtMentions(input, props.args.cwd);
    if (expansion.missing.length) addMessage("error", `Could not resolve @mention: ${expansion.missing.join(", ")}`);
    for (const skipped of expansion.skipped) addMessage("error", `Skipped @${skipped.path}: ${skipped.reason}`);
    await runAgentInput(expansion.text, input);
  }

  async function executeSlash(input: string) {
    if (/^\/(?:thinking|toggle-thinking)(?:\s|$)/.test(input.trim())) {
      toggleThinkingVisibility();
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
    if (inject) await runAgentInput(inject, input);
    return true;
  }

  async function openPicker(kind: PickerMode, providerId?: string) {
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

  function buildPickerItems(kind: Exclude<PickerMode, "key">, providerId?: string): PickerItem[] {
    if (kind === "slash") return [];
    if (kind === "mcp-reconnect") return buildMcpReconnectItems();
    if (kind === "skill") return buildSkillItems();
    if (kind === "model") {
      const items: PickerItem[] = [];
      for (const provider of registry.getEnabled()) {
        if (providerId && provider.id !== providerId) continue;
        const customModels = registry.getModelConfig().getCustomModels(provider.id);
        const builtinProviderId = provider.id === "openai" && provider.authType === "oauth"
          ? "openai-codex"
          : provider.id;
        const models = customModels.length > 0
          ? customModels
          : listBuiltinModels(builtinProviderId).map((model) => ({
            id: model.id,
            name: model.name,
            providerId: provider.id,
          }));
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

  async function runAgentInput(actualInput: string | ContentPart[], displayInput: string) {
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
    const nextMessages = [...displayMessages, { role: "user" as const, content: displayInput }];
    displayMessages = nextMessages;
    streamingDisplay = undefined;
    redrawTranscript(undefined, nextMessages);
    const run = beginAgentRun();

    let assistantContent = "";
    let assistantReasoning = "";
    const toolCalls: DisplayToolCall[] = [];
    let runError: string | undefined;
    let runCancelled = false;
    try {
      for await (const event of props.agent.run(actualInput, props.args.cwd, { abortSignal: run.abortController.signal })) {
        if (event.type === "turn_start") {
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          redrawTranscript({
            role: "assistant",
            content: "",
            status: "thinking",
            streaming: true,
          });
        } else if (event.type === "text_delta") {
          assistantContent += event.content;
          redrawTranscript({
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: toolCalls.length ? [...toolCalls] : undefined,
            status: "responding",
            streaming: true,
          });
        } else if (event.type === "reasoning_delta") {
          assistantReasoning += event.content;
          redrawTranscript({
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: toolCalls.length ? [...toolCalls] : undefined,
            status: "thinking",
            streaming: true,
          });
        } else if (event.type === "tool_call_start") {
          upsertStreamingToolCall(toolCalls, event.id, event.name, "");
          redrawTranscript({
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: [...toolCalls],
            streaming: true,
          }, undefined, "streaming-tool-call");
        } else if (event.type === "tool_call_delta") {
          upsertStreamingToolCall(toolCalls, event.id, event.name, event.arguments);
          redrawTranscript({
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: [...toolCalls],
            streaming: true,
          }, undefined, "streaming-tool-call");
        } else if (event.type === "tool_call_end") {
          finishStreamingToolCall(toolCalls, event.id, event.name, event.arguments);
          redrawTranscript({
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: [...toolCalls],
            streaming: true,
          });
        } else if (event.type === "tool_start") {
          const existing = toolCalls.find((item) => item.id === event.id);
          if (existing) {
            existing.args = event.args;
            existing.streamingArgs = false;
            existing.status = "running";
          } else {
            toolCalls.push({ id: event.id, name: event.name, args: event.args, status: "running" });
          }
          if (event.name === "question") {
            scheduleQuestionSync();
          }
          redrawTranscript({
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: [...toolCalls],
            streaming: true,
          });
        } else if (event.type === "tool_end") {
          const call = toolCalls.find((item) => item.id === event.id);
          if (call) {
            call.result = event.result.content;
            call.isError = event.result.isError;
            call.metadata = event.result.metadata;
            call.status = event.result.isError ? "error" : "completed";
            redrawTranscript({
              role: "assistant",
              content: assistantContent,
              reasoning: assistantReasoning || undefined,
              toolCalls: [...toolCalls],
              streaming: true,
            });
          }
          if (event.name === "question") {
            syncFirstPendingQuestion();
          }
          refreshGitSidebar();
          syncSidebarLsp();
        } else if (event.type === "todos_updated") {
          setTodos(event.todos);
          syncSidebarTodos(event.todos);
          bumpSidebar();
        } else if (event.type === "mode_changed") {
          setMode(event.mode);
          syncModeChrome();
          bumpSidebar();
        } else if (event.type === "turn_end") {
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
          const assistantMessage: DisplayMessage = {
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: toolCalls.length ? [...toolCalls] : undefined,
          };
          const nextMessages = hasRenderableMessage(assistantMessage)
            ? [...displayMessages, assistantMessage]
            : displayMessages;
          displayMessages = nextMessages;
          redrawTranscript(undefined, nextMessages);
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          streamingDisplay = undefined;
        }
      }
    } catch (error: any) {
      runCancelled = error instanceof AgentAbortError || run.abortController.signal.aborted || error?.name === "AbortError";
      if (!runCancelled) {
        runError = error?.message || String(error);
      }
    } finally {
      pendingApprovalRef = undefined;
      setPendingApproval(undefined);
      setApprovalOptionIdx(0);
      finishAgentRun(run);
      streamingDisplay = undefined;
      if (runError) {
        const errorMessage = runError;
        const nextMessages = [...displayMessages, { role: "error" as const, content: errorMessage }];
        displayMessages = nextMessages;
        redrawTranscript(undefined, nextMessages);
      } else if (runCancelled) {
        if (!notice()) setNotice("Agent run cancelled");
        redrawTranscript();
      } else {
        redrawTranscript();
      }
      redrawDock();
      refreshGitSidebar();
      syncSidebarLsp();
      setTimeout(() => activePrompt()?.focus(), 0);
    }
  }

  function promptUiKeyDown(event: any) {
    if (routeRunningCancel(keyNameFromEvent(event), event)) return true;
    const modalOwner = activeModalKeyOwner();
    if (modalOwner) {
      if (routeModalKey(event) || shouldModalSwallowUnhandledKey(modalOwner)) {
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
    }
    if (cycleModeFromKey(event)) return true;
    if (handlePromptHistoryKey(event)) return true;
    return false;
  }

  function renderComposer() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        sessionComposerShell = ref;
        ref.visible = !isHomeSurfaceActive(streamingDisplay) && !pendingQuestion();
      },
      width: "100%",
      paddingLeft: 2,
      paddingRight: 2,
      flexShrink: 0,
      visible: !isHomeSurfaceActive(streamingDisplay) && !pendingQuestion(),
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
        disabled: () => isRunning() && !pendingApproval() && !pendingPlan() && !pendingQuestion(),
        mode,
        registerModeLabel: registerPromptModeLabel,
        registerModelLabel: registerPromptModelLabel,
        model: promptModelTitle,
        placeholder: () => {
          const approvalState = pendingApproval();
          if (approvalState) return "Press Enter to approve or Esc to reject";
          if (pendingQuestion()) return "Answer the question below";
          const plan = pendingPlan();
          if (plan) return "Press Enter to approve plan or Esc to reject";
          return `Ask anything... "${homePrompt}"`;
        },
      }),
    );
  }

  function renderHomeSurface() {
    const homeHeight = Math.max(16, dimensions().height - 4);
    return h("box", {
      height: homeHeight,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      paddingLeft: 2,
      paddingRight: 2,
    },
    [
      h("box", { flexShrink: 0, flexDirection: "column" },
        ...HOME_LOGO.map((line) => h("text", { fg: theme.primary }, line)),
      ),
      h("box", { height: 1, minHeight: 0, flexShrink: 1 }),
      h("box", {
        ref: (ref: BoxRenderable) => {
          homeComposerShell = ref;
          ref.visible = isHomeSurfaceActive(streamingDisplay) && !pendingQuestion();
        },
        width: "100%",
        maxWidth: 75,
        zIndex: 1000,
        paddingTop: 1,
        flexShrink: 0,
        visible: isHomeSurfaceActive(streamingDisplay) && !pendingQuestion(),
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
        disabled: () => isRunning() && !pendingApproval() && !pendingPlan() && !pendingQuestion(),
        mode,
        registerModeLabel: registerPromptModeLabel,
        registerModelLabel: registerPromptModelLabel,
        model: promptModelTitle,
        placeholder: () => {
          const approvalState = pendingApproval();
          if (approvalState) return "Press Enter to approve or Esc to reject";
          if (pendingQuestion()) return "Answer the question below";
          const plan = pendingPlan();
          if (plan) return "Press Enter to approve plan or Esc to reject";
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
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
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
    }),
    renderProviderDialog(),
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
  placeholder: () => string;
}) {
  return h("box", { flexDirection: "column", flexShrink: 0, marginTop: 1 },
    h("box", { border: ["left"], borderColor: theme.primary, backgroundColor: theme.backgroundElement },
      h("box", { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.backgroundElement },
        h("textarea", {
          ref: input.ref,
          focused: input.focused,
          placeholder: input.placeholder(),
          placeholderColor: theme.textMuted,
          textColor: theme.text,
          focusedTextColor: theme.text,
          backgroundColor: theme.backgroundElement,
          focusedBackgroundColor: theme.backgroundElement,
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
      () => input.disabled() ? h("text", { fg: theme.textMuted }, "esc interrupt") : h("text", { fg: theme.textMuted }, ""),
      h("box", { flexDirection: "row", gap: 2 },
        h("text", { fg: theme.text }, "tab ", h("span", { fg: theme.textMuted }, "mode")),
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
  width = 80,
) {
  if (message.role === "user") return renderUserMessage(message, index);
  if (message.role === "error") {
    return h("box", { border: ["left"], borderColor: theme.error, marginTop: 1, paddingLeft: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.backgroundPanel, flexShrink: 0 },
      h("text", { fg: theme.error, wrapMode: "word" }, message.content),
    );
  }
  return renderAssistantMessage(message, syntaxStyle, subtleSyntaxStyle, showThinking, width);
}

function renderUserMessage(message: DisplayMessage, index: number) {
  return h("box", {
    border: ["left"],
    borderColor: theme.primary,
    marginTop: index === 0 ? 0 : 1,
    backgroundColor: theme.backgroundPanel,
    flexShrink: 0,
  },
    h("box", { paddingTop: 1, paddingBottom: 1, paddingLeft: 2, backgroundColor: theme.backgroundPanel, flexShrink: 0 },
      h("text", { fg: theme.messageUserText, wrapMode: "word" }, message.content || " "),
    ),
  );
}

function renderAssistantMessage(message: DisplayMessage, syntaxStyle: SyntaxStyle, subtleSyntaxStyle: SyntaxStyle, showThinking = true, width = 80) {
  const modelSwitch = parseModelSwitchMessage(message.content);
  if (modelSwitch && !message.reasoning?.trim() && !(message.toolCalls?.length)) {
    return renderModelSwitchMessage(modelSwitch);
  }

  const children: Child[] = [];
  const visibleReasoning = showThinking ? message.reasoning?.trim() : "";
  if (message.status && !visibleReasoning && !message.content.trim() && !(message.toolCalls?.length)) {
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
      h("text", { content: thinkingLabelContent(message.streaming === true), fg: theme.messageThinkingText, wrapMode: "none" }),
      renderMarkdownContent(formatThinkingMarkdown(visibleReasoning), subtleSyntaxStyle, {
        streaming: message.streaming === true,
        fg: theme.messageThinkingContentText,
      }),
    ));
  }
  for (const tool of message.toolCalls ?? []) children.push(renderTool(tool, syntaxStyle, width));
  if (message.content.trim()) {
    children.push(h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      renderMarkdownContent(message.content.trim(), syntaxStyle, {
        streaming: message.streaming === true,
        fg: theme.messageAssistantText,
      }),
    ));
  }
  if (!children.length) return null;
  return h("box", { flexDirection: "column", flexShrink: 0 }, children);
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
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  const ctx = host.ctx;
  const nextEntries: TranscriptEntry[] = [];

  if (!visibleMessages.length && !options?.plan) {
    const key = `home:${options?.cwd ?? ""}:${options?.tip ?? ""}:${options?.renderHome ? "prompt" : "static"}`;
    const previous = state.entries[0];
    if (previous?.key !== key) {
      clearTranscriptEntries(host, state);
      const node = (options?.renderHome
        ? options.renderHome()
        : renderHomeState({
          width: options?.width ?? 80,
          cwd: options?.cwd ?? "",
          tip: options?.tip ?? "",
        })) as Renderable;
      host.add(node);
      state.entries = [{ key, signature: key, node, refs: {} }];
    }
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
    const writeExpansionDigest = writeToolExpansionDigest(message, key, state.expandedWrites);
    const signature = transcriptMessageSignature(message, showThinking, compactionExpanded, writeExpansionDigest);
    const previous = state.entries[index];
    if (previous?.key === key && previous.signature === signature) {
      updateMessageEntry(previous, message, showThinking, compactionExpanded);
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
    errorText?: TextRenderable;
    statusText?: TextRenderable;
    reasoningToggleText?: TextRenderable;
    reasoningStreaming?: boolean;
    reasoningMarkdown?: MarkdownRenderable;
    contentMarkdown?: MarkdownRenderable;
    compactionExpanded?: boolean;
    compactionToggleText?: TextRenderable;
    compactionContentText?: TextRenderable;
    compactionDetailBox?: BoxRenderable;
  };
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
  showThinking = true,
  compactionExpanded = false,
  writeExpansionDigest = "",
) {
  if (message.role !== "assistant") return message.role;
  if (message.syntheticKind === "ui_compact_card") {
    return `compaction:${compactionExpanded ? "expanded" : "collapsed"}:${message.compactionMeta?.turns ?? 0}`;
  }
  const modelSwitch = parseModelSwitchMessage(message.content);
  const tools = (message.toolCalls ?? [])
    .map((tool) => `${tool.id}:${tool.name}:${tool.status ?? (tool.result === undefined ? "pending" : "completed")}:${tool.isError ? "error" : "ok"}`)
    .join("|");
  const visibleReasoning = showThinking && !!message.reasoning?.trim();
  return [
    message.role,
    modelSwitch ? "model-switch" : "standard",
    message.status ?? "idle",
    visibleReasoning ? "reasoning-visible" : "no-reasoning",
    message.content.trim() ? "content" : "no-content",
    tools,
    writeExpansionDigest,
  ].join(":");
}

function updateMessageEntry(entry: TranscriptEntry, message: DisplayMessage, showThinking = true, compactionExpanded = false) {
  if (message.role === "user") {
    if (entry.refs.userText) entry.refs.userText.content = message.content || " ";
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
  if (entry.refs.statusText) {
    entry.refs.statusText.content = assistantStatusLabel(message);
  }
  if (entry.refs.reasoningToggleText) {
    entry.refs.reasoningStreaming = message.streaming === true;
    entry.refs.reasoningToggleText.content = thinkingLabelContent(message.streaming === true);
  }
  if (entry.refs.reasoningMarkdown) {
    entry.refs.reasoningMarkdown.content = showThinking ? formatThinkingMarkdown(message.reasoning?.trim() ?? "") : "";
    entry.refs.reasoningMarkdown.streaming = message.streaming === true;
  }
  if (entry.refs.contentMarkdown) {
    entry.refs.contentMarkdown.content = message.content.trim();
    entry.refs.contentMarkdown.streaming = message.streaming === true;
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
  compactionExpanded = false,
  expandedWrites: Set<string> = new Set(),
  onToggleCompaction?: (key: string) => void,
  onToggleWrite?: (key: string) => void,
): TranscriptEntry | null {
  if (message.role === "user") return createUserEntry(ctx, message, index, key, signature);
  if (message.role === "error") return createErrorEntry(ctx, message, key, signature);
  if (message.syntheticKind === "ui_compact_card") return createCompactionCardEntry(ctx, message, key, signature, compactionExpanded, onToggleCompaction);
  return createAssistantEntry(ctx, message, syntaxStyle, subtleSyntaxStyle, key, signature, showThinking, width, expandedWrites, onToggleWrite);
}

function createUserEntry(ctx: RenderContext, message: DisplayMessage, index: number, key: string, signature: string): TranscriptEntry {
  const refs: TranscriptEntry["refs"] = {};
  const text = createText(ctx, message.content || " ", {
    fg: theme.messageUserText,
    wrapMode: "word",
  });
  refs.userText = text;
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
    }, [text]),
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
  if (message.status && !visibleReasoning && !message.content.trim() && !(message.toolCalls?.length)) {
    const status = createText(ctx, assistantStatusLabel(message), {
      fg: theme.messageThinkingText,
    });
    refs.statusText = status;
    children.push(createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexShrink: 0,
    }, [status]));
  }
  if (visibleReasoning) {
    const reasoningChildren: Renderable[] = [];
    const labelText = createText(ctx, thinkingLabelContent(message.streaming === true), {
      fg: theme.messageThinkingText,
      wrapMode: "none",
    });
    refs.reasoningToggleText = labelText;
    refs.reasoningStreaming = message.streaming === true;
    reasoningChildren.push(createBox(ctx, {
      flexShrink: 0,
    }, [labelText]));
    const markdown = createMarkdown(ctx, formatThinkingMarkdown(visibleReasoning), subtleSyntaxStyle, {
      streaming: message.streaming === true,
      fg: theme.messageThinkingContentText,
    });
    refs.reasoningMarkdown = markdown;
    reasoningChildren.push(markdown);
    children.push(createBox(ctx, {
      paddingLeft: 2,
      marginTop: 1,
      border: ["left"],
      borderColor: theme.messageThinkingBorder,
      flexDirection: "column",
      flexShrink: 0,
    }, reasoningChildren));
  }

  for (const tool of message.toolCalls ?? []) {
    const toolKey = writeToolKey(key, tool);
    children.push(createToolRenderable(
      ctx,
      tool,
      syntaxStyle,
      width,
      expandedWrites.has(toolKey),
      isWritePreviewTool(tool) ? () => onToggleWrite?.(toolKey) : undefined,
    ));
  }

  if (message.content.trim()) {
    const markdown = createMarkdown(ctx, message.content.trim(), syntaxStyle, {
      streaming: message.streaming === true,
      fg: theme.messageAssistantText,
    });
    refs.contentMarkdown = markdown;
    children.push(createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexDirection: "column",
      flexShrink: 0,
    }, [markdown]));
  }

  if (!children.length) return null;
  return {
    key,
    signature,
    node: createBox(ctx, { flexDirection: "column", flexShrink: 0 }, children),
    refs,
  };
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

function renderTool(tool: DisplayToolCall, syntaxStyle: SyntaxStyle, width = 80) {
  if (tool.name === "question") {
    return renderQuestionTool(tool);
  }
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" ? "✎" : "●";
  const color = toolColor(tool);
  const diff = extractToolDiff(tool);
  if (diff && !tool.isError && tool.name === "edit") {
    return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      h("text", { fg: color },
        `${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
      ),
      h("box", { paddingLeft: 1, marginTop: 1, border: ["left"], borderColor: theme.borderSubtle, flexDirection: "column", flexShrink: 0 },
        renderDiffContent(diff, toolPath(tool), syntaxStyle, width),
      ),
    );
  }
  if (isWritePreviewTool(tool)) {
    const preview = formatWritePreview(tool.args.content, false);
    const summary = tool.result ?? `${isToolFinished(tool) ? "Prepared" : "Writing"} ${tool.args.content.split(/\r?\n/).length} lines to ${toolPath(tool) ?? "file"}`;
    return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      h("text", { fg: color },
        `${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
      ),
      h("box", { paddingLeft: 1, marginTop: 0, border: ["left"], borderColor: theme.borderSubtle, flexDirection: "column", flexShrink: 0 },
        h("text", { fg: theme.textMuted }, `└ ${summary}`),
        renderCodeBlockContent(preview.content, toolPath(tool), syntaxStyle),
        preview.omittedLines > 0
          ? h("text", { fg: theme.textMuted }, `... +${preview.omittedLines} lines (ctrl+o to expand)`)
          : preview.omittedChars > 0
            ? h("text", { fg: theme.textMuted }, `... +${preview.omittedChars} chars (ctrl+o to expand)`)
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
    if (message.role === "system" || message.role === "tool") continue;
    if (message.role === "user") {
      if (message.isMeta) continue;
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
  renderHome?: () => ReturnType<typeof h>;
  plan?: string;
  selectedOption?: number;
  showThinking?: boolean;
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
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  if (!visibleMessages.length) return null;
  const items = visibleMessages.map((message, index) =>
    renderMessage(message, index, syntaxStyle, subtleSyntaxStyle, showThinking, options?.width ?? 80)
  );
  if (options?.plan) items.push(renderPlanPrompt(options.plan));
  return items;
}

function renderSessionMessages(messages: DisplayMessage[], syntaxStyle: SyntaxStyle, subtleSyntaxStyle: SyntaxStyle, showThinking = true) {
  const visibleMessages = messages.filter((message) => hasRenderableMessage(message, showThinking));
  if (!visibleMessages.length) return null;
  return visibleMessages.map((message, index) => renderMessage(message, index, syntaxStyle, subtleSyntaxStyle, showThinking));
}

function formatTranscript(messages: DisplayMessage[], options?: TranscriptOptions): StyledText {
  const showThinking = options?.showThinking ?? true;
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
    if (message.status && !visibleReasoning && !message.content.trim() && !(message.toolCalls?.length)) {
      appendBlank();
      append("   ", theme.borderSubtle);
      appendLine(assistantStatusLabel(message), theme.messageThinkingText);
    }
    for (const tool of message.toolCalls ?? []) {
      appendBlank();
      const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
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
      appendBlank();
      for (const line of message.content.trim().split(/\r?\n/)) {
        append("   ", theme.borderSubtle);
        appendLine(line || " ", theme.messageAssistantText);
      }
    }
  }
  if (options?.plan) appendPlanTranscript(chunks, options.plan, options.selectedOption ?? 0);
  return new StyledText(chunks);
}

function renderHomeState(input: { width: number; cwd: string; tip: string }) {
  const width = Math.max(20, input.width);
  const cwd = input.cwd ? shortCwd(input.cwd) : "";
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
    ...HOME_LOGO.map((line) => h("text", { fg: theme.primary }, centerLine(line, width))),
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

function contrastText(color: string) {
  const hex = color.replace("#", "");
  const normalized = hex.length === 8 ? hex.slice(0, 6) : hex;
  if (normalized.length !== 6) return theme.text;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 160 ? "#000000" : "#ffffff";
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
  if (tool.name === "write" || tool.name === "edit") return theme.toolWrite;
  if (tool.name === "grep" || tool.name === "glob" || tool.name === "web_search" || tool.name === "web_fetch") return theme.toolSearch;
  return theme.toolSuccess;
}

function displayToolName(name: string): string {
  const labels: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Shell",
    grep: "Grep",
    glob: "Glob",
    web_fetch: "WebFetch",
    web_search: "WebSearch",
    task: "Task",
    todo: "Todo",
    question: "Questions",
  };
  return labels[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function toolHeader(tool: DisplayToolCall): string {
  const args = tool.args || {};
  const value = args.path ?? args.command ?? args.pattern ?? args.url ?? args.query;
  return value ? `(${truncate(String(value).replace(/\n/g, " "), 64)})` : "";
}

function toolPath(tool: DisplayToolCall): string | undefined {
  const value = tool.args?.path ?? tool.args?.filePath;
  return typeof value === "string" ? value : undefined;
}

function extractToolDiff(tool: DisplayToolCall): string | undefined {
  if (!tool.result) return undefined;
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
  if (!isToolFinished(tool)) return tool.status === "running" ? "running" : "pending";
  if (tool.name === "question") {
    if (isQuestionRejected(tool)) return "dismissed";
    const count = questionToolQuestions(tool).length || (Array.isArray(tool.args?.questions) ? tool.args.questions.length : 0);
    return `asked ${count} question${count === 1 ? "" : "s"}`;
  }
  const result = tool.result ?? "";
  if (tool.isError) return truncate(result.split("\n").find(Boolean) || "error", 120);
  const lines = result.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim()).length;
  if (tool.name === "edit") return "patched file";
  if (tool.name === "write") return "wrote file";
  if (tool.name === "bash") return lines ? `${lines} line${lines === 1 ? "" : "s"} output` : "done";
  return lines ? `${lines} line${lines === 1 ? "" : "s"}` : "done";
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
  if (tool.name !== "read" && tool.name !== "glob") return undefined;

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
  return tool.status === "completed" || tool.status === "error" || tool.result !== undefined;
}

function assistantStatusLabel(message: DisplayMessage): string {
  if (message.status === "responding") return "Responding...";
  return message.streaming ? "Thinking..." : "Thinking";
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

function thinkingLabelContent(streaming = false): StyledText {
  return new StyledText([
    fg(theme.messageThinkingText)(italic(streaming ? "Thinking..." : "Thinking")),
  ]);
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, Math.max(1, max - 1)).trimEnd() + "…" : value;
}

function sessionDisplayName(sessionManager?: SessionManager) {
  const file = sessionManager?.getSessionFile();
  if (!file) return "Session";
  const name = file.split(/[\\/]/).pop() || "Session";
  return name.replace(/\.jsonl$/, "");
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
