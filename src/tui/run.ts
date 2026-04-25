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
  type SyntaxStyle,
  fg,
  bg,
  bold,
  dim,
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
  useTerminalDimensions,
} from "@opentui/solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { Agent } from "../agent.js";
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
import { expandAtMentions, filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import { compactDisplayMessages, type DisplayMessage, type DisplayToolCall } from "./display-history.js";
import { createMarkdownSyntaxStyle, createSubtleMarkdownSyntaxStyle } from "./markdown-theme.js";
import { getNextPermissionMode } from "../permission/mode.js";
import { getContextBudget } from "../context/budget.js";
import { inferBashPrefix, type BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import { createFrames } from "./opencode-spinner.js";
import { readGitSidebarState, type SidebarFileChange, type SidebarGitState } from "./sidebar-state.js";
import {
  isModeCycleKeyEvent,
  isModeCycleSequence,
  isModifiedEnterSequence,
  PROMPT_TEXTAREA_KEYBINDINGS,
} from "./prompt-keybindings.js";

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
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  mcpManager?: McpManager;
  bypassEnabled?: boolean;
  theme?: Record<string, string>;
}

type RawModeCycleHandler = (sequence: string) => boolean;

const treeSitterClient = getTreeSitterClient();

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

const HOME_LOGO = [
  " /\\_/\\  █▀▀▄ █  █ █▀▀▄ █▀▀▄ █    █▀▀",
  "( o.o ) █▀▀▄ █  █ █▀▀▄ █▀▀▄ █    █▀▀",
  " > ^ <  ▀▀▀  ▀▀▀▀ ▀▀▀  ▀▀▀  ▀▀▀▀ ▀▀▀▀",
];

const HOME_TIPS = [
  "Type @ followed by a filename to attach file context",
  "Press Tab to cycle Build and Plan modes",
  "Type / or press Ctrl+P to open commands",
  "Use /compact to summarize long sessions near context limits",
  "Shift+Enter or Ctrl+J inserts a newline in your prompt",
];

type Child = any;
type PromptScannerSync = (running: boolean) => void;
type SidebarUsageState = {
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  reasoningTokens: number;
  turns: number;
};
type PickerMode = "model" | "key" | "provider" | "provider-add" | "provider-auth" | "login" | "logout" | "slash" | "file";
type PickerItem = {
  label: string;
  detail?: string;
  value: string;
  command: string;
  next?: "auth" | "key";
  after?: { mode: "model"; providerId: string };
  category?: string;
  gutter?: string;
  footer?: string;
};
type ProviderDialogStep = "providers" | "auth" | "key" | "models";
type ProviderDialogState = {
  step: ProviderDialogStep;
  providerId?: string;
  query: string;
  index: number;
  apiKey: string;
  error?: string;
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

export async function runTui(agent: Agent, args: CliArgs, options: RunTuiOptions = {}) {
  return new Promise<void>(async (resolve, reject) => {
    let renderer: CliRenderer | undefined;
    let syntaxStyle: SyntaxStyle | undefined;
    let subtleSyntaxStyle: SyntaxStyle | undefined;
    let rawModeCycleHandler: RawModeCycleHandler | undefined;
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
          (sequence: string) => rawModeCycleHandler?.(sequence) ?? false,
        ],
        autoFocus: true,
        useMouse: true,
        openConsoleOnError: false,
        backgroundColor: theme.background,
      });
      const setRawModeCycleHandler = (handler: RawModeCycleHandler | undefined) => {
        rawModeCycleHandler = handler;
      };
      await render(() => h(OpenTuiApp, { agent, args, options, onExit: exit, syntaxStyle, subtleSyntaxStyle, setRawModeCycleHandler }), renderer);
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
  setRawModeCycleHandler?: (handler: RawModeCycleHandler | undefined) => void;
}) {
  const dimensions = useTerminalDimensions();
  const registry = props.options.registry!;
  const skills = props.options.skillRegistry!;
  let displayMessages = reconstructDisplayMessages(props.agent.messages);
  const homeTip = HOME_TIPS[Math.floor(Math.random() * HOME_TIPS.length)] ?? HOME_TIPS[0]!;
  const homePrompt = HOME_PROMPTS[Math.floor(Math.random() * HOME_PROMPTS.length)] ?? HOME_PROMPTS[0]!;
  let promptText = "";
  const [isRunning, setIsRunning] = createSignal(false);
  const [showThinking, setShowThinking] = createSignal(true);
  let streamingDisplay: DisplayMessage | undefined;
  const [todos, setTodos] = createSignal<Todo[]>(props.agent.getTodos());
  const [mode, setMode] = createSignal<PermissionMode>(props.agent.mode);
  const [notice, setNotice] = createSignal("");
  const [sessionActive, setSessionActive] = createSignal(false);
  const [sidebarTick, setSidebarTick] = createSignal(0);
  const [sidebarUsage, setSidebarUsage] = createSignal<SidebarUsageState>({
    promptTokens: 0,
    completionTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    reasoningTokens: 0,
    turns: 0,
  });
  const [gitState, setGitState] = createSignal<SidebarGitState>({ files: [] });
  const [pendingPlan, setPendingPlan] = createSignal<{
    plan: string;
    resolve: (decision: PlanDecision) => void;
  }>();
  const [pendingApproval, setPendingApproval] = createSignal<{
    request: ApprovalRequest;
    resolve: (decision: ApprovalDecision) => void;
  }>();
  let pendingApprovalRef: { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void } | undefined;
  const PLAN_OPTIONS = ["Approve", "Reject"] as const;
  const [approvalOptionIdx, setApprovalOptionIdx] = createSignal(0);
  let picker: PickerState | undefined;
  let providerDialog: ProviderDialogState | undefined;
  let previousPickerForKey: Extract<PickerState, { kind: "select" }> | undefined;
  let homePromptRef: TextareaRenderable | undefined;
  let sessionPromptRef: TextareaRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  let rootBox: BoxRenderable | undefined;
  let sidebarShell: BoxRenderable | undefined;
  let transcriptHost: BoxRenderable | undefined;
  const transcriptState: TranscriptState = { entries: [], expandedThinking: new Set() };
  let dock: TextRenderable | undefined;
  let homeComposerShell: BoxRenderable | undefined;
  let sessionComposerShell: BoxRenderable | undefined;
  const promptScannerSyncs = new Set<PromptScannerSync>();
  const thinkingSpinnerFrames = createFrames({
    width: 4,
    color: theme.primary,
    style: "blocks",
    inactiveFactor: 0.45,
    minAlpha: 0.25,
  });
  let thinkingSpinnerFrameIndex = 0;
  let thinkingSpinnerTimer: ReturnType<typeof setInterval> | undefined;
  let approvalRoot: BoxRenderable | undefined;
  let approvalHeaderTitle: TextRenderable | undefined;
  let approvalMetaIcon: TextRenderable | undefined;
  let approvalMetaTitle: TextRenderable | undefined;
  let approvalSubtitle: TextRenderable | undefined;
  let approvalPreviewScroll: ScrollBoxRenderable | undefined;
  let approvalPreviewText: TextRenderable | undefined;
  let approvalPreviewDiff: DiffRenderable | undefined;
  const approvalOptionBoxes: Array<BoxRenderable | undefined> = [];
  const approvalOptionTexts: Array<TextRenderable | undefined> = [];
  let pickerFrame: BoxRenderable | undefined;
  let selectList: SelectRenderable | undefined;
  const inlinePickerRows: Array<BoxRenderable | undefined> = [];
  const inlinePickerLabels: Array<TextRenderable | undefined> = [];
  const inlinePickerDetails: Array<TextRenderable | undefined> = [];
  let providerDialogRoot: BoxRenderable | undefined;
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
  let footerModeBadge: TextRenderable | undefined;
  let sidebarTokenText: TextRenderable | undefined;
  let sidebarPercentText: TextRenderable | undefined;
  let sidebarUsageText: TextRenderable | undefined;
  let sidebarReasoningText: TextRenderable | undefined;
  let sidebarCostText: TextRenderable | undefined;

  const activePrompt = () =>
    isHomeSurfaceActive()
      ? homePromptRef ?? sessionPromptRef
      : sessionPromptRef ?? homePromptRef;

  const activeComposerShell = () =>
    isHomeSurfaceActive()
      ? homeComposerShell ?? sessionComposerShell
      : sessionComposerShell ?? homeComposerShell;

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

  const canInsertPromptNewline = () => !isRunning() && !pendingApproval() && !pendingPlan();

  const sidebarVisible = () => sessionActive() && dimensions().width > SESSION_SIDEBAR_AUTO_WIDTH;
  const contentWidth = () => Math.max(20, dimensions().width - (sidebarVisible() ? SESSION_SIDEBAR_WIDTH : 0) - 4);
  const bumpSidebar = () => {
    setSidebarTick((value) => value + 1);
    syncSidebarContext();
  };

  function refreshGitSidebar() {
    setGitState(readGitSidebarState(props.args.cwd));
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

  const promptModeTitle = () => mode() === "plan" ? "Plan" : "Build";
  const footerModeText = () => mode() !== "default" ? `  ${mode()} · tab` : "";

  function syncModeChrome() {
    for (const label of [...promptModeLabels]) {
      try {
        if ((label as any).isDestroyed) {
          promptModeLabels.delete(label);
          continue;
        }
        label.content = promptModeTitle();
        label.requestRender();
      } catch {
        promptModeLabels.delete(label);
      }
    }
    if (footerModeBadge) {
      footerModeBadge.content = footerModeText();
      footerModeBadge.requestRender();
    }
    homeComposerShell?.requestRender();
    sessionComposerShell?.requestRender();
    rootBox?.requestRender();
  }

  const registerPromptModeLabel = (ref: TextRenderable) => {
    promptModeLabels.add(ref);
    ref.content = promptModeTitle();
    ref.requestRender();
  };

  const registerFooterModeBadge = (ref: TextRenderable) => {
    footerModeBadge = ref;
    ref.content = footerModeText();
    ref.requestRender();
  };

  const cycleMode = () => {
    if (picker || pendingPlan()) return false;
    const next = getNextPermissionMode(props.agent.mode, { bypassEnabled: props.options.bypassEnabled });
    props.agent.setMode(next);
    setMode(next);
    setNotice(`Mode: ${next === "plan" ? "Plan" : "Build"}`);
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

  const canPersistApproval = (request: ApprovalRequest) => {
    if (request.type === "bash") return !!props.options.bashAllowlist || !!props.options.settingsManager;
    return !!props.options.settingsManager;
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
    const tool = request.type === "edit" ? "Edit" : "Write";
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

  const handleApprovalKey = (event: any) => {
    const approval = pendingApproval();
    if (!approval) return false;
    const name = String(event.name || "").toLowerCase();
    if (name === "left" || name === "right" || name === "up" || name === "down" || name === "h" || name === "l") {
      const opts = approvalOptionsFor(approval.request);
      const idx = approvalOptionIdx();
      const next = name === "left" || name === "up" || name === "h"
        ? (idx - 1 + opts.length) % opts.length
        : (idx + 1) % opts.length;
      setApprovalOptionIdx(next);
      forceApprovalUI();
      event.preventDefault?.();
      return true;
    }
    if (name === "return" || name === "enter") {
      resolveApprovalSelection();
      event.preventDefault?.();
      return true;
    }
    if (name === "escape") {
      pendingApprovalRef = undefined;
      setPendingApproval(undefined);
      setApprovalOptionIdx(0);
      forceApprovalUI();
      approval.resolve({ action: "reject", feedback: "Rejected by user." });
      event.preventDefault?.();
      return true;
    }
    return false;
  };

  const forceApprovalUI = () => {
    const approval = pendingApproval();
    const plan = pendingPlan();
    syncPromptSurfaces();
    const prompt = activePrompt();
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
    redrawTranscript();
  };

  const installInteractiveHandlers = () => {
    if (props.options.planHandlerRef) {
      props.options.planHandlerRef.current = (plan: string) =>
        new Promise<PlanDecision>((resolve) => {
          setPendingPlan({ plan, resolve });
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
    props.setRawModeCycleHandler?.(cycleModeFromRawSequence);
    refreshGitSidebar();
    setTimeout(() => {
      activePrompt()?.focus();
      scrollbox?.scrollTo(scrollbox.scrollHeight);
    }, 25);
  });

  onCleanup(() => {
    props.setRawModeCycleHandler?.(undefined);
    stopThinkingSpinner();
    if (props.options.planHandlerRef) props.options.planHandlerRef.current = undefined;
    if (props.options.approvalHandlerRef) props.options.approvalHandlerRef.current = undefined;
  });

  useKeyboard((event: any) => {
    const name = String(event.name || "").toLowerCase();
    if (event.ctrl && name === "c") {
      props.onExit();
      return;
    }

    if (handleApprovalKey(event)) return;
    if (handleProviderDialogKey(event)) return;
    if (handlePickerKey(event)) return;

    const plan = pendingPlan();
    if (plan) {
      if (name === "left" || name === "right" || name === "h" || name === "l") {
        const opts = PLAN_OPTIONS;
        const idx = approvalOptionIdx();
        const next = name === "left" || name === "h"
          ? (idx - 1 + opts.length) % opts.length
          : (idx + 1) % opts.length;
        setApprovalOptionIdx(next);
        forceApprovalUI();
        event.preventDefault?.();
        return;
      }
      if (name === "return" || name === "enter") {
        const sel = approvalOptionIdx();
        setPendingPlan(undefined);
        setApprovalOptionIdx(0);
        if (sel === 0) {
          plan.resolve({ action: "approve", plan: plan.plan });
        } else {
          plan.resolve({ action: "reject", reason: "Rejected by user." });
        }
      }
      if (name === "escape") {
        setPendingPlan(undefined);
        setApprovalOptionIdx(0);
        plan.resolve({ action: "reject", reason: "Rejected by user." });
      }
      event.preventDefault?.();
      return;
    }

    if (cycleModeFromKey(event)) return;

    if (event.ctrl && name === "p" && !picker && !isRunning()) {
      openCommandPalette();
      event.preventDefault?.();
      return;
    }
  }, {});

  function currentTranscriptMessages(extra?: DisplayMessage) {
    return compactDisplayMessages(extra ? [...displayMessages, extra] : displayMessages);
  }

  function hasTranscriptMessages(extra?: DisplayMessage) {
    return currentTranscriptMessages(extra).some((message) => hasRenderableMessage(message, showThinking()));
  }

  function isHomeSurfaceActive(extra?: DisplayMessage) {
    return !hasTranscriptMessages(extra) && !pendingPlan();
  }

  function syncPromptSurfaces(focus = false) {
    const homeActive = isHomeSurfaceActive(streamingDisplay);
    setSessionActive(!homeActive);
    if (homeComposerShell) homeComposerShell.visible = homeActive;
    if (sessionComposerShell) sessionComposerShell.visible = !homeActive;
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

  function transcriptOptions() {
    return {
      cwd: props.args.cwd,
      width: contentWidth(),
      tip: homeTip,
      renderHome: renderHomeSurface,
      plan: pendingPlan()?.plan,
      selectedOption: approvalOptionIdx(),
      showThinking: showThinking(),
      onToggleThinking: (key: string) => {
        if (transcriptState.expandedThinking.has(key)) {
          transcriptState.expandedThinking.delete(key);
        } else {
          transcriptState.expandedThinking.add(key);
        }
        syncSessionMessages();
      },
    };
  }

  function syncSessionMessages(messages = currentTranscriptMessages(streamingDisplay)) {
    if (!transcriptHost) return;
    updateTranscriptHost(transcriptHost, transcriptState, messages, transcriptOptions(), props.syntaxStyle, props.subtleSyntaxStyle);
    syncThinkingSpinner();
    syncPromptSurfaces();
  }

  function renderThinkingSpinnerFrame() {
    const frame = thinkingSpinnerFrames[thinkingSpinnerFrameIndex % thinkingSpinnerFrames.length] ?? "";
    let rendered = false;
    for (const entry of transcriptState.entries) {
      const ref = entry.refs.reasoningToggleText;
      if (!ref || !entry.refs.reasoningStreaming) continue;
      ref.content = thinkingToggleLabel(entry.refs.reasoningExpanded === true, true, frame);
      ref.requestRender();
      rendered = true;
    }
    if (rendered) {
      transcriptHost?.requestRender();
      rootBox?.requestRender();
    }
  }

  function stopThinkingSpinner() {
    if (thinkingSpinnerTimer) clearInterval(thinkingSpinnerTimer);
    thinkingSpinnerTimer = undefined;
    thinkingSpinnerFrameIndex = 0;
  }

  function syncThinkingSpinner() {
    const hasStreamingThinking = transcriptState.entries.some((entry) =>
      !!entry.refs.reasoningToggleText && entry.refs.reasoningStreaming === true
    );
    if (!hasStreamingThinking) {
      stopThinkingSpinner();
      return;
    }
    renderThinkingSpinnerFrame();
    if (thinkingSpinnerTimer) return;
    thinkingSpinnerTimer = setInterval(() => {
      thinkingSpinnerFrameIndex = (thinkingSpinnerFrameIndex + 1) % thinkingSpinnerFrames.length;
      renderThinkingSpinnerFrame();
    }, PROMPT_SCANNER_INTERVAL_MS);
  }

  function redrawTranscript(extra?: DisplayMessage, baseMessages = displayMessages) {
    streamingDisplay = extra;
    const nextMessages = compactDisplayMessages(extra ? [...baseMessages, extra] : baseMessages);
    syncSessionMessages(nextMessages);
    rootBox?.requestRender();
    scrollbox?.requestRender();
    setTimeout(() => {
      if (!scrollbox) return;
      if (nextMessages.length <= 3) {
        scrollbox.scrollTo(0);
        return;
      }
      scrollbox.scrollTo(scrollbox.scrollHeight);
    }, 50);
  }

  createEffect(() => {
    dimensions();
    sessionActive();
    syncSidebarChrome();
    scrollbox?.requestRender();
    setTimeout(() => scrollbox?.scrollTo(scrollbox.scrollHeight), 50);
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
      pickerFrame.title = undefined;
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
    providerDialogRoot?.requestRender();
    setTimeout(() => activePrompt()?.focus(), 0);
  }

  function providerDialogItemsFor(step: ProviderDialogStep, providerId?: string) {
    if (step === "providers") return buildProviderConnectItems();
    if (step === "auth") return providerId ? buildPickerItems("provider-auth", providerId) : [];
    if (step === "models") return providerId ? buildPickerItems("model", providerId) : [];
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
    items.forEach((item, optionIndex) => {
      const category = item.category || "";
      if (category && category !== lastCategory) {
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
      providerDialogRoot.requestRender();
      return;
    }

    const width = Math.max(48, Math.min(76, dimensions().width - 8));
    const height = PROVIDER_DIALOG_ROWS + 7;
    providerDialogRoot.visible = true;
    providerDialogRoot.width = width;
    providerDialogRoot.height = height;
    providerDialogRoot.left = Math.max(2, Math.floor((dimensions().width - width) / 2));
    providerDialogRoot.top = Math.max(1, Math.floor((dimensions().height - height) / 4));
    providerDialogRoot.backgroundColor = theme.backgroundPanel;
    providerDialogRoot.borderColor = theme.border;

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
          label.fg = theme.textMuted;
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
          gutter.content = row.item.gutter ?? " ";
          gutter.fg = active ? activeText : providerDialogGutterColor(row.item.gutter);
        }
        if (label) {
          label.content = truncate(row.item.label, 21);
          label.fg = active ? activeText : theme.text;
        }
        if (detail) {
          detail.content = truncate(row.item.detail ?? "", providerDialogDetailWidth());
          detail.fg = active ? activeText : theme.textMuted;
        }
        if (footer) {
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
    const provider = providerDisplayName(state.providerId);
    if (state.step === "auth") return `${provider} auth method`;
    if (state.step === "key") return `${provider} API key`;
    return `${provider} models`;
  }

  function providerDialogFooterFor(state: ProviderDialogState) {
    if (state.step === "key") return "enter save · esc back";
    const items = providerDialogFilteredItems(state);
    const count = items.length ? ` ${Math.min(state.index + 1, items.length)}/${items.length}` : "";
    const escLabel = state.step === "providers" ? "esc close" : "esc back";
    return `type filter · ↑/↓ move · enter select · ${escLabel}${count}`;
  }

  function providerDialogGutterColor(gutter?: string) {
    if (gutter === "●") return theme.primary;
    if (gutter === "✓") return theme.success;
    if (gutter === "○") return theme.warning;
    return theme.textMuted;
  }

  function providerDialogDetailWidth() {
    const width = typeof providerDialogRoot?.width === "number" ? providerDialogRoot.width : 72;
    return Math.max(12, width - 43);
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
    const next = Math.min(items.length - 1, Math.max(0, state.index + delta));
    if (next === state.index) return true;
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
      } else if (state.step === "models") {
        openProviderDialog("providers");
      } else {
        closeProviderDialog();
      }
      event.preventDefault?.();
      return true;
    }
    if (state.step !== "key") {
      const items = providerDialogFilteredItems(state);
      if (name === "up") {
        moveProviderDialogSelection(-1);
        event.preventDefault?.();
        return true;
      }
      if (name === "down") {
        moveProviderDialogSelection(1);
        event.preventDefault?.();
        return true;
      }
      if (name === "pageup") {
        providerDialog = { ...state, index: Math.max(0, state.index - 5) };
        redrawProviderDialog();
        event.preventDefault?.();
        return true;
      }
      if (name === "pagedown") {
        providerDialog = { ...state, index: Math.min(Math.max(0, items.length - 1), state.index + 5) };
        redrawProviderDialog();
        event.preventDefault?.();
        return true;
      }
    }
    if (name === "return" || name === "enter") {
      void runProviderDialogSelection();
      event.preventDefault?.();
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
      closeProviderDialog();
      await executeSlash(item.command);
    }
  }

  function ensureProviderConfiguredForKey(providerId: string) {
    if (!registry.getConfigured().some((provider) => provider.id === providerId)) {
      registry.addProvider(providerId, "");
    }
    registry.setDefault(providerId);
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
      setPendingPlan(undefined);
      setApprovalOptionIdx(0);
      plan.resolve({ action: "approve", plan: plan.plan });
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
      props.onExit();
      return;
    }
    if (input.startsWith("/") && !/\s/.test(input)) {
      const query = input.slice(1).toLowerCase();
      const matches = slashRegistry.list().filter((command) => command.name.toLowerCase().startsWith(query));
      if (matches.length === 1) {
        await executeSlash(`/${matches[0]!.name}`);
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

    const query = trimmedBeforeCursor.slice(1).toLowerCase();
    const commands = buildSlashItems(query);

    picker = {
      kind: "select",
      mode: "slash",
      title: "Commands",
      items: commands,
      index: commands.length
        ? Math.min(picker?.kind === "select" && picker.mode === "slash" ? picker.index : 0, commands.length - 1)
        : 0,
    };
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

  function buildSlashItems(query = ""): PickerItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    return [...LOCAL_SLASH_COMMANDS, ...slashRegistry.list()]
      .filter((command) => {
        if (!normalizedQuery) return true;
        const name = command.name.toLowerCase();
        const description = command.description.toLowerCase();
        return name.startsWith(normalizedQuery)
          || name.includes(normalizedQuery)
          || description.includes(normalizedQuery)
          || fuzzyMatch(name, normalizedQuery)
          || fuzzyMatch(description, normalizedQuery);
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((command): PickerItem => ({
        label: `/${command.name}`,
        detail: command.description,
        value: command.name,
        command: `/${command.name}`,
      }));
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

  async function handleInput(input: string) {
    setNotice("");
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
      setShowThinking((prev) => {
        const next = !prev;
        setNotice(next ? "Thinking blocks visible" : "Thinking blocks hidden");
        return next;
      });
      redrawTranscript();
      return true;
    }

    const { handled, result, inject } = await slashRegistry.execute(input, {
      agent: props.agent,
      addMessage,
      clearMessages,
      cwd: props.args.cwd,
      exit: props.onExit,
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
    });
    if (!handled) return false;
    if (props.agent.mode !== mode()) setMode(props.agent.mode);
    if (result) addMessage("assistant", result);
    if (inject) await runAgentInput(inject, input);
    return true;
  }

  async function openPicker(kind: PickerMode, providerId?: string) {
    if (kind === "provider" || kind === "provider-auth") {
      openProviderDialog(kind === "provider-auth" ? "auth" : "providers", providerId);
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
    if (picker?.kind === "select" && picker.mode === "slash") {
      activePrompt()?.clear();
      closePicker();
      await executeSlash(item.command);
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
                detail: `${provider.name}${isCurrent ? " · current" : ""}`,
                value: `${provider.id}:${model.id}`,
                command: `/model ${provider.id}:${model.id} --reasoning-effort ${level}`,
              });
            }
            continue;
          }
          items.push({
            label: model.name,
            detail: `${provider.name}${props.agent.model === `${provider.id}:${model.id}` ? " · current" : ""}`,
            value: `${provider.id}:${model.id}`,
            command: `/model ${provider.id}:${model.id}`,
          });
        }
      }
      const currentModel = props.agent.model;
      if (!providerId && currentModel && !items.some((item) => item.value === currentModel)) {
        items.unshift({
          label: displayModel(currentModel),
          detail: "current",
          value: currentModel,
          command: `/model ${currentModel}`,
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

    const nextMessages = [...displayMessages, { role: "user" as const, content: displayInput }];
    displayMessages = nextMessages;
    streamingDisplay = undefined;
    redrawTranscript(undefined, nextMessages);
    setRunningState(true);

    let assistantContent = "";
    let assistantReasoning = "";
    const toolCalls: DisplayToolCall[] = [];
    let runError: string | undefined;
    try {
      for await (const event of props.agent.run(actualInput, props.args.cwd)) {
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
        } else if (event.type === "tool_start") {
          toolCalls.push({ id: event.id, name: event.name, args: event.args, status: "running" });
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
            call.status = event.result.isError ? "error" : "completed";
            redrawTranscript({
              role: "assistant",
              content: assistantContent,
              reasoning: assistantReasoning || undefined,
              toolCalls: [...toolCalls],
              streaming: true,
            });
          }
          refreshGitSidebar();
        } else if (event.type === "todos_updated") {
          setTodos(event.todos);
          bumpSidebar();
        } else if (event.type === "mode_changed") {
          setMode(event.mode);
          syncModeChrome();
          bumpSidebar();
        } else if (event.type === "turn_end") {
          if (event.usage) {
            setSidebarUsage((current) => ({
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
      runError = error?.message || String(error);
    } finally {
      pendingApprovalRef = undefined;
      setPendingApproval(undefined);
      setApprovalOptionIdx(0);
      setRunningState(false);
      streamingDisplay = undefined;
      if (runError) {
        const errorMessage = runError;
        const nextMessages = [...displayMessages, { role: "error" as const, content: errorMessage }];
        displayMessages = nextMessages;
        redrawTranscript(undefined, nextMessages);
      } else {
        redrawTranscript();
      }
      redrawDock();
      refreshGitSidebar();
      setTimeout(() => activePrompt()?.focus(), 0);
    }
  }

  function promptUiKeyDown(event: any) {
    if (handleApprovalKey(event)) return true;
    const name = String(event.name || "").toLowerCase();
    const plan = pendingPlan();
    if (plan && (name === "left" || name === "right" || name === "h" || name === "l")) {
      const idx = approvalOptionIdx();
      const next = name === "left" || name === "h"
        ? (idx - 1 + PLAN_OPTIONS.length) % PLAN_OPTIONS.length
        : (idx + 1) % PLAN_OPTIONS.length;
      setApprovalOptionIdx(next);
      forceApprovalUI();
      event.preventDefault?.();
      return true;
    }
    if (cycleModeFromKey(event)) return true;
    return false;
  }

  function renderComposer() {
    return h("box", {
      ref: (ref: BoxRenderable) => {
        sessionComposerShell = ref;
        ref.visible = !isHomeSurfaceActive(streamingDisplay);
      },
      width: "100%",
      paddingLeft: 2,
      paddingRight: 2,
      flexShrink: 0,
      visible: !isHomeSurfaceActive(streamingDisplay),
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
        disabled: () => isRunning() && !pendingApproval() && !pendingPlan(),
        mode,
        registerModeLabel: registerPromptModeLabel,
        model: () => displayModel(props.agent.model) || "no model",
        placeholder: () => {
          const approvalState = pendingApproval();
          if (approvalState) return "Press Enter to approve or Esc to reject";
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
          ref.visible = isHomeSurfaceActive(streamingDisplay);
        },
        width: "100%",
        maxWidth: 75,
        zIndex: 1000,
        paddingTop: 1,
        flexShrink: 0,
        visible: isHomeSurfaceActive(streamingDisplay),
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
        disabled: () => isRunning() && !pendingApproval() && !pendingPlan(),
        mode,
        registerModeLabel: registerPromptModeLabel,
        model: () => displayModel(props.agent.model) || "no model",
        placeholder: () => {
          const approvalState = pendingApproval();
          if (approvalState) return "Press Enter to approve or Esc to reject";
          const plan = pendingPlan();
          if (plan) return "Press Enter to approve plan or Esc to reject";
          return `Ask anything... "${homePrompt}"`;
        },
      }),
      ),
    ]);
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
      left: 4,
      top: 2,
      width: 72,
      height: PROVIDER_DIALOG_ROWS + 7,
      zIndex: 1200,
      backgroundColor: theme.backgroundPanel,
      border: true,
      borderColor: theme.border,
      flexDirection: "column",
      onMouseScroll: updateProviderDialogFromScroll,
    },
    [
      h("box", {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
      },
      h("text", {
        ref: (ref: TextRenderable) => { providerDialogTitle = ref; },
        fg: theme.text,
        content: "Connect a provider",
      }),
      h("text", {
        ref: (ref: TextRenderable) => { providerDialogEsc = ref; },
        fg: theme.textMuted,
        content: "esc",
      })),
      h("box", {
        paddingLeft: 2,
        paddingRight: 2,
        paddingBottom: 1,
        flexShrink: 0,
      },
      h("input", {
        ref: (ref: InputRenderable) => { providerDialogInput = ref; },
        width: "100%",
        value: "",
        placeholder: "Search",
        fg: theme.text,
        backgroundColor: theme.backgroundElement,
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
          paddingRight: 1,
          onMouseMove: () => updateProviderDialogFromMouse(index, false),
          onMouseDown: () => updateProviderDialogFromMouse(index, false),
          onMouseUp: () => updateProviderDialogFromMouse(index, true),
          onMouseScroll: updateProviderDialogFromScroll,
        },
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogGutters[index] = ref; },
          width: 2,
          flexShrink: 0,
          fg: theme.textMuted,
          content: "",
        }),
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogLabels[index] = ref; },
          width: 22,
          flexShrink: 0,
          wrapMode: "none",
          fg: theme.text,
          content: "",
        }),
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogDetails[index] = ref; },
          flexGrow: 1,
          minWidth: 0,
          wrapMode: "none",
          fg: theme.textMuted,
          content: "",
        }),
        h("text", {
          ref: (ref: TextRenderable) => { providerDialogFooters[index] = ref; },
          width: 12,
          flexShrink: 0,
          wrapMode: "none",
          fg: theme.textMuted,
          content: "",
        })),
      )),
      h("box", {
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
        backgroundColor: theme.backgroundElement,
      },
      h("text", {
        ref: (ref: TextRenderable) => { providerDialogFooter = ref; },
        fg: theme.textMuted,
        content: "type filter · ↑/↓ move · enter select · esc cancel",
      })),
    ]);
  }

  function renderSessionSidebar() {
    const context = sidebarContextState();
    const mcpStates = sidebarMcpStates();
    const files = gitState().files;
    const activeTodos = todos().filter((todo) => todo.status !== "completed");
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
                sidebarCostText = ref;
                ref.content = context.costText;
              },
            }),
          ]),
          renderSidebarMcp(mcpStates),
          renderSidebarLsp(),
          activeTodos.length ? renderSidebarTodos(activeTodos) : null,
          files.length ? renderSidebarFiles(files) : null,
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
    return renderSidebarSection("MCP", [
      h("text", { fg: failed ? theme.warning : theme.textMuted },
        `${connected} active${failed ? `, ${failed} error${failed === 1 ? "" : "s"}` : ""}`),
      ...states.slice(0, 5).map((state) =>
        h("box", { flexDirection: "row", gap: 1 },
          h("text", { fg: sidebarStatusColor(state.kind), flexShrink: 0 }, "*"),
          h("text", { fg: theme.textMuted, wrapMode: "word" }, `${state.name} ${state.label}`),
        ),
      ),
    ]);
  }

  function renderSidebarLsp() {
    return renderSidebarSection("LSP", [
      h("text", { fg: theme.textMuted, wrapMode: "word" }, "No LSP runtime attached"),
    ]);
  }

  function renderSidebarTodos(activeTodos: Todo[]) {
    return renderSidebarSection("Todo", activeTodos.slice(0, 6).map((todo) => {
      const marker = todo.status === "in_progress" ? ">" : "o";
      const color = todo.status === "in_progress" ? theme.primary : theme.textMuted;
      return h("text", { fg: color, wrapMode: "word" }, `${marker} ${todo.activeForm || todo.content}`);
    }));
  }

  function renderSidebarFiles(files: SidebarFileChange[]) {
    return renderSidebarSection("Modified Files", files.slice(0, 8).map((file) =>
      h("box", { flexDirection: "row", gap: 1, justifyContent: "space-between" },
        h("text", { fg: theme.textMuted, wrapMode: "none" }, truncate(file.file, 25)),
        h("box", { flexDirection: "row", gap: 1, flexShrink: 0 },
          file.additions ? h("text", { fg: theme.diffAdded }, `+${file.additions}`) : null,
          file.deletions ? h("text", { fg: theme.diffRemoved }, `-${file.deletions}`) : null,
        ),
      ),
    ));
  }

  function renderSidebarFooter() {
    return h("box", { flexDirection: "column", flexShrink: 0, paddingTop: 1 },
      h("text", { fg: theme.textMuted }, `${props.agent.providerId || "unknown"} · ${displayModel(props.agent.model) || "no model"}`),
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
      tokens: budget?.estimatedTokens ?? 0,
      percent: Math.round(budget?.percent ?? 0),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      reasoningTokens: usage.reasoningTokens,
      turns: usage.turns,
      costText: cost ? `${formatCurrency(cost.cost)} spent${cost.estimated ? " est." : ""}` : "cost unavailable",
    };
  }

  function sidebarMcpStates() {
    sidebarTick();
    return (props.options.mcpManager?.getStates() ?? []).map((state) => {
      const kind = state.status.kind;
      return {
        name: state.name,
        kind,
        label: kind === "connected"
          ? "Connected"
          : kind === "failed"
            ? truncate(state.status.error, 42)
            : kind,
      };
    });
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
          syncThinkingSpinner();
          syncPromptSurfaces(isNewHost);
          setTimeout(() => scrollbox?.scrollTo(scrollbox.scrollHeight), 0);
        },
        flexDirection: "column",
        flexShrink: 0,
        width: "100%",
      }),
      ),
      todos().length ? renderTodos(todos()) : null,
      ...renderPromptDock(),
      notice() ? h("text", { fg: theme.warning }, notice()) : null,
      h("box", {
        ref: (ref: BoxRenderable) => { approvalRoot = ref; },
        visible: !!approval,
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
        h("text", { fg: theme.text }, "⇆ ", h("span", { fg: theme.textMuted }, "select")),
        h("text", { fg: theme.text }, "enter ", h("span", { fg: theme.textMuted }, "confirm")),
        h("text", { fg: theme.text }, "esc ", h("span", { fg: theme.textMuted }, "reject")),
      ),
      ),
      ),
      ),
    ]);
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
      provider: () => props.agent.providerId || registry.getDefault()?.id || "unknown",
      model: () => displayModelWithThinking(props.agent.model, props.agent.thinking) || "no model",
      mode,
      running: isRunning,
      registerScanner: registerPromptScanner,
      registerModeBadge: registerFooterModeBadge,
    }),
    renderProviderDialog(),
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
            }, input.mode() === "plan" ? "Plan" : "Build"),
            h("text", { fg: theme.textMuted }, "·"),
            h("text", { fg: theme.text }, input.model()),
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
      renderMarkdownContent(formatThinkingMarkdown(visibleReasoning), subtleSyntaxStyle, {
        streaming: message.streaming === true,
        fg: theme.messageThinkingText,
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
    const thinkingExpanded = state.expandedThinking.has(key);
    const signature = transcriptMessageSignature(message, showThinking, thinkingExpanded);
    const previous = state.entries[index];
    if (previous?.key === key && previous.signature === signature) {
      updateMessageEntry(previous, message, showThinking, thinkingExpanded);
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
      thinkingExpanded,
      options?.onToggleThinking,
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
  expandedThinking: Set<string>;
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
    reasoningExpanded?: boolean;
    reasoningStreaming?: boolean;
    reasoningMarkdown?: MarkdownRenderable;
    contentMarkdown?: MarkdownRenderable;
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

function transcriptMessageSignature(message: DisplayMessage, showThinking = true, thinkingExpanded = false) {
  if (message.role !== "assistant") return message.role;
  const tools = (message.toolCalls ?? [])
    .map((tool) => `${tool.id}:${tool.name}:${tool.status ?? (tool.result === undefined ? "pending" : "completed")}:${tool.isError ? "error" : "ok"}`)
    .join("|");
  const visibleReasoning = showThinking && !!message.reasoning?.trim();
  return [
    message.role,
    message.status ?? "idle",
    visibleReasoning ? (thinkingExpanded ? "reasoning-expanded" : "reasoning-collapsed") : "no-reasoning",
    message.content.trim() ? "content" : "no-content",
    tools,
  ].join(":");
}

function hashString(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function updateMessageEntry(entry: TranscriptEntry, message: DisplayMessage, showThinking = true, thinkingExpanded = false) {
  if (message.role === "user") {
    if (entry.refs.userText) entry.refs.userText.content = message.content || " ";
    return;
  }
  if (message.role === "error") {
    if (entry.refs.errorText) entry.refs.errorText.content = message.content;
    return;
  }
  if (entry.refs.statusText) {
    entry.refs.statusText.content = assistantStatusLabel(message);
  }
  if (entry.refs.reasoningToggleText) {
    entry.refs.reasoningExpanded = thinkingExpanded;
    entry.refs.reasoningStreaming = message.streaming === true;
    entry.refs.reasoningToggleText.content = thinkingToggleLabel(thinkingExpanded, message.streaming === true);
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
  thinkingExpanded = false,
  onToggleThinking?: (key: string) => void,
): TranscriptEntry | null {
  if (message.role === "user") return createUserEntry(ctx, message, index, key, signature);
  if (message.role === "error") return createErrorEntry(ctx, message, key, signature);
  return createAssistantEntry(ctx, message, syntaxStyle, subtleSyntaxStyle, key, signature, showThinking, width, thinkingExpanded, onToggleThinking);
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
  thinkingExpanded = false,
  onToggleThinking?: (key: string) => void,
): TranscriptEntry | null {
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
    const toggleText = createText(ctx, thinkingToggleLabel(thinkingExpanded, message.streaming === true), {
      fg: theme.messageThinkingText,
      wrapMode: "none",
    });
    refs.reasoningToggleText = toggleText;
    refs.reasoningExpanded = thinkingExpanded;
    refs.reasoningStreaming = message.streaming === true;
    reasoningChildren.push(createBox(ctx, {
      flexShrink: 0,
      onMouseUp: () => onToggleThinking?.(key),
    }, [toggleText]));
    if (thinkingExpanded) {
      const markdown = createMarkdown(ctx, formatThinkingMarkdown(visibleReasoning), subtleSyntaxStyle, {
        streaming: message.streaming === true,
        fg: theme.messageThinkingText,
      });
      refs.reasoningMarkdown = markdown;
      reasoningChildren.push(markdown);
    }
    children.push(createBox(ctx, {
      paddingLeft: 2,
      marginTop: 1,
      border: ["left"],
      borderColor: theme.messageThinkingBorder,
      flexDirection: "column",
      flexShrink: 0,
    }, reasoningChildren));
  }

  for (const tool of message.toolCalls ?? []) children.push(createToolRenderable(ctx, tool, syntaxStyle, width));

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

function createToolRenderable(ctx: RenderContext, tool: DisplayToolCall, syntaxStyle: SyntaxStyle, width = 80) {
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
  const color = toolColor(tool);
  const header = toolHeader(tool);
  const diff = extractToolDiff(tool);
  if (diff && !tool.isError && tool.name === "edit") {
    return createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexDirection: "column",
      flexShrink: 0,
    }, [
      createText(ctx, new StyledText([
        fg(color)(`${icon} ${displayToolName(tool.name)}`),
        fg(theme.toolText)(header ? ` ${header}` : ""),
      ])),
      createBox(ctx, {
        paddingLeft: 1,
        marginTop: 1,
        border: ["left"],
        borderColor: theme.borderSubtle,
        flexDirection: "column",
        flexShrink: 0,
      }, [createDiffRenderable(ctx, diff, toolPath(tool), syntaxStyle, width)]),
    ]);
  }
  if (!tool.isError && tool.name === "write" && typeof tool.args?.content === "string" && isToolFinished(tool)) {
    return createBox(ctx, {
      paddingLeft: 3,
      marginTop: 1,
      flexDirection: "column",
      flexShrink: 0,
    }, [
      createText(ctx, new StyledText([
        fg(color)(`${icon} ${displayToolName(tool.name)}`),
        fg(theme.toolText)(header ? ` ${header}` : ""),
      ])),
      createBox(ctx, {
        paddingLeft: 1,
        marginTop: 1,
        border: ["left"],
        borderColor: theme.borderSubtle,
        flexDirection: "column",
        flexShrink: 0,
      }, [createCodeBlockRenderable(ctx, tool.args.content, toolPath(tool), syntaxStyle)]),
    ]);
  }
  const chunks: StyledText["chunks"] = [
    fg(color)(`${isToolFinished(tool) ? "" : "~ "}${icon} ${displayToolName(tool.name)}`),
  ];
  if (header) chunks.push(fg(theme.toolText)(` ${header}`));
  if (tool.result) {
    chunks.push(fg(theme.text)("\n"));
    chunks.push(fg(theme.borderSubtle)("  "));
    chunks.push(fg(tool.isError ? theme.toolError : theme.textMuted)(summarizeToolResult(tool)));
    const preview = toolPreview(tool);
    if (preview) {
      for (const line of preview.lines) {
        chunks.push(fg(theme.text)("\n"));
        chunks.push(fg(theme.borderSubtle)("  "));
        chunks.push(fg(theme.toolText)(line));
      }
      if (preview.omitted > 0) {
        chunks.push(fg(theme.text)("\n"));
        chunks.push(fg(theme.borderSubtle)("  "));
        chunks.push(fg(theme.textMuted)(`+ ${preview.omitted} more`));
      }
    }
  }
  return createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, [
    createText(ctx, new StyledText(chunks), { wrapMode: "word" }),
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
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
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
  if (!tool.isError && tool.name === "write" && typeof tool.args?.content === "string" && isToolFinished(tool)) {
    return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
      h("text", { fg: color },
        `${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
      ),
      h("box", { paddingLeft: 1, marginTop: 1, border: ["left"], borderColor: theme.borderSubtle, flexDirection: "column", flexShrink: 0 },
        renderCodeBlockContent(tool.args.content, toolPath(tool), syntaxStyle),
      ),
    );
  }
  return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column", flexShrink: 0 },
    h("text", { fg: color },
      `${isToolFinished(tool) ? "" : "~ "}${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
    ),
    () => tool.result ? h("text", { fg: tool.isError ? theme.toolError : theme.textMuted, wrapMode: "word" }, toolSummaryWithPreview(tool)) : null,
  );
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
  provider: () => string;
  model: () => string;
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
      fg: theme.warning,
      ref: input.registerModeBadge,
    }, input.mode() !== "default" ? `  ${input.mode()} · tab` : ""),
    h("box", { flexGrow: 1 }),
    h("text", { fg: theme.textMuted }, `${input.provider()} · ${input.model()}`),
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
    case "slash":
      return "Commands";
    case "file":
      return "Files";
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

function reconstructDisplayMessages(agentMessages: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const message of agentMessages) {
    if (message.role === "system" || message.role === "tool") continue;
    if (message.role === "user") {
      if (message.isMeta) continue;
      result.push({ role: "user", content: typeof message.content === "string" ? message.content : "(multimedia)" });
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
        isError: toolResult ? (toolResult as any).content?.startsWith?.("Error:") : false,
        status: toolResult
          ? ((toolResult as any).content?.startsWith?.("Error:") ? "error" : "completed")
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
  onToggleThinking?: (key: string) => void;
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
      appendLine(truncate(formatThinkingMarkdown(visibleReasoning), 500), theme.messageThinkingText);
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
      append(`   ${isToolFinished(tool) ? "" : "~ "}${icon} `, color);
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
  const diff = tool.result.slice(index + marker.length).trim();
  return diff ? diff : undefined;
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

function isToolFinished(tool: DisplayToolCall): boolean {
  return tool.status === "completed" || tool.status === "error" || tool.result !== undefined;
}

function assistantStatusLabel(message: DisplayMessage): string {
  if (message.status === "responding") return "Responding...";
  return message.streaming ? "Thinking..." : "Thinking";
}

function thinkingToggleLabel(expanded: boolean, streaming = false, spinnerFrame = ""): string {
  const arrow = expanded ? "▼" : "▶";
  return streaming && spinnerFrame ? `${spinnerFrame} ${arrow} Thinking` : `${arrow} Thinking`;
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
