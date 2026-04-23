import {
  type BoxRenderable,
  createCliRenderer,
  type CliRenderer,
  type ScrollBoxRenderable,
  type SelectOption,
  type SelectRenderable,
  StyledText,
  fg,
  bg,
  bold,
  dim,
  type TextRenderable,
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
import type { ContentPart, Message, PermissionMode, PlanDecision, Provider, Todo } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import { BUILTIN_PROVIDERS, displayModel, isUserVisibleProvider } from "../provider-registry.js";
import { listBuiltinModels } from "../model-catalog.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { expandAtMentions, filterFileSuggestions, findAtContext, listProjectFiles } from "./file-mentions.js";
import { compactDisplayMessages, type DisplayMessage, type DisplayToolCall } from "./display-history.js";
import { getNextPermissionMode } from "../permission/mode.js";
import { inferBashPrefix, type BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";

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
};

let theme = DEFAULT_THEME;

const HOME_LOGO = [
  "█▀▀▄ █  █ █▀▀▄ █▀▀▄ █    █▀▀",
  "█▀▀▄ █  █ █▀▀▄ █▀▀▄ █    █▀▀",
  "▀▀▀  ▀▀▀▀ ▀▀▀  ▀▀▀  ▀▀▀▀ ▀▀▀▀",
];

const HOME_PROMPTS = [
  "Fix a TODO in the codebase",
  "What is the tech stack of this project?",
  "Find the highest-risk bug in this repo",
  "Explain how this feature is wired",
];

const HOME_TIPS = [
  "Type @ followed by a filename to attach file context",
  "Press Tab to cycle Build and Plan modes",
  "Type / or press Ctrl+P to open commands",
  "Use /compact to summarize long sessions near context limits",
  "Shift+Enter adds a newline in your prompt",
];

type Child = any;
type PickerMode = "model" | "key" | "provider" | "provider-add" | "login" | "logout" | "slash" | "file";
type PickerItem = {
  label: string;
  detail?: string;
  value: string;
  command: string;
  next?: "key";
};
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
  | { kind: "key"; title: string; providerId?: string; previous?: Extract<PickerState, { kind: "select" }> };

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
    const exit = () => {
      try {
        renderer?.destroy();
      } finally {
        resolve();
      }
    };

    try {
      theme = resolveTheme(options.theme);
      renderer = await createCliRenderer({
        externalOutputMode: "passthrough",
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        useKittyKeyboard: {},
        autoFocus: true,
        useMouse: true,
        openConsoleOnError: false,
        backgroundColor: theme.background,
      });
      await render(() => h(OpenTuiApp, { agent, args, options, onExit: exit }), renderer);
    } catch (error) {
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
}) {
  const dimensions = useTerminalDimensions();
  const registry = props.options.registry!;
  const skills = props.options.skillRegistry!;
  let currentMessages = compactDisplayMessages(reconstructDisplayMessages(props.agent.messages));
  const homeTip = HOME_TIPS[Math.floor(Math.random() * HOME_TIPS.length)] ?? HOME_TIPS[0]!;
  const homePrompt = HOME_PROMPTS[Math.floor(Math.random() * HOME_PROMPTS.length)] ?? HOME_PROMPTS[0]!;
  let promptText = "";
  const [isRunning, setIsRunning] = createSignal(false);
  const [streamingContent, setStreamingContent] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [streamingTools, setStreamingTools] = createSignal<DisplayToolCall[]>([]);
  const [todos, setTodos] = createSignal<Todo[]>(props.agent.getTodos());
  const [mode, setMode] = createSignal<PermissionMode>(props.agent.mode);
  const [notice, setNotice] = createSignal("");
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
  let previousPickerForKey: Extract<PickerState, { kind: "select" }> | undefined;
  let prompt: TextareaRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  let transcript: TextRenderable | undefined;
  let dock: TextRenderable | undefined;
  let approvalRoot: BoxRenderable | undefined;
  let approvalHeaderTitle: TextRenderable | undefined;
  let approvalMetaIcon: TextRenderable | undefined;
  let approvalMetaTitle: TextRenderable | undefined;
  let approvalSubtitle: TextRenderable | undefined;
  let approvalPreviewScroll: ScrollBoxRenderable | undefined;
  let approvalPreviewText: TextRenderable | undefined;
  const approvalOptionBoxes: Array<BoxRenderable | undefined> = [];
  const approvalOptionTexts: Array<TextRenderable | undefined> = [];
  let pickerFrame: BoxRenderable | undefined;
  let selectList: SelectRenderable | undefined;

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

  const forceApprovalUI = () => {
    const approval = pendingApproval();
    const plan = pendingPlan();
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
          setPendingApproval({ request, resolve });
          forceApprovalUI();
        });
    }
  };

  installInteractiveHandlers();

  createEffect(() => {
    installInteractiveHandlers();
  });

  onMount(() => {
    setTimeout(() => {
      prompt?.focus();
      scrollbox?.scrollTo(scrollbox.scrollHeight);
    }, 25);
  });

  onCleanup(() => {
    if (props.options.planHandlerRef) props.options.planHandlerRef.current = undefined;
    if (props.options.approvalHandlerRef) props.options.approvalHandlerRef.current = undefined;
  });

  useKeyboard((event: any) => {
    const name = String(event.name || "").toLowerCase();
    if (event.ctrl && name === "c") {
      props.onExit();
      return;
    }

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

    const approval = pendingApproval();
    if (approval) {
      if (name === "left" || name === "right" || name === "up" || name === "down" || name === "h" || name === "l") {
        const opts = approvalOptionsFor(approval.request);
        const idx = approvalOptionIdx();
        const next = name === "left" || name === "up" || name === "h"
          ? (idx - 1 + opts.length) % opts.length
          : (idx + 1) % opts.length;
        setApprovalOptionIdx(next);
        forceApprovalUI();
        event.preventDefault?.();
        return;
      }
      if (name === "return" || name === "enter") {
        resolveApprovalSelection();
      }
      if (name === "escape") {
        pendingApprovalRef = undefined;
        setPendingApproval(undefined);
        setApprovalOptionIdx(0);
        forceApprovalUI();
        approval.resolve({ action: "reject", feedback: "Rejected by user." });
      }
      event.preventDefault?.();
      return;
    }

    if (name === "tab" && event.shift) {
      const next = getNextPermissionMode(props.agent.mode, { bypassEnabled: props.options.bypassEnabled });
      props.agent.setMode(next);
      setMode(next);
      props.options.sessionManager?.appendMarker("mode_switch", next);
      event.preventDefault?.();
      return;
    }

    if (name === "tab" && !picker) {
      const next = getNextPermissionMode(props.agent.mode, { bypassEnabled: props.options.bypassEnabled });
      props.agent.setMode(next);
      setMode(next);
      props.options.sessionManager?.appendMarker("mode_switch", next);
      event.preventDefault?.();
      return;
    }

    if (event.ctrl && name === "p" && !picker && !isRunning()) {
      openCommandPalette();
      event.preventDefault?.();
      return;
    }
  }, {});

  function currentTranscriptMessages(extra?: DisplayMessage) {
    return extra ? [...currentMessages, extra] : currentMessages;
  }

  function transcriptOptions() {
    return {
      cwd: props.args.cwd,
      tip: homeTip,
      width: Math.max(20, dimensions().width - 4),
      plan: pendingPlan()?.plan,
      selectedOption: approvalOptionIdx(),
    };
  }

  function redrawTranscript(extra?: DisplayMessage) {
    if (transcript) {
      transcript.content = formatTranscript(currentTranscriptMessages(extra), transcriptOptions());
    }
    scrollbox?.requestRender();
    setTimeout(() => scrollbox?.scrollTo(scrollbox.scrollHeight), 50);
  }

  createEffect(() => {
    dimensions();
    redrawTranscript();
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
    if (selectList) {
      const state = picker?.kind === "select" && !picker.loading ? picker : undefined;
      const inlinePicker = isInlinePicker(state);
      selectList.visible = !!state;
      selectList.options = state ? state.items.map(toSelectOption) : [];
      selectList.selectedIndex = state ? state.index : 0;
      selectList.height = state ? selectHeight(state) : 0;
      selectList.backgroundColor = inlinePicker ? theme.backgroundPanel : theme.background;
      selectList.textColor = theme.text;
      selectList.focusedTextColor = theme.text;
      selectList.selectedBackgroundColor = inlinePicker ? theme.primary : theme.backgroundElement;
      selectList.selectedTextColor = inlinePicker ? contrastText(theme.primary) : theme.primary;
      selectList.descriptionColor = inlinePicker ? theme.textMuted : theme.textMuted;
      selectList.selectedDescriptionColor = inlinePicker ? contrastText(theme.primary) : theme.text;
      selectList.showDescription = state?.mode !== "file";
      selectList.showScrollIndicator = !inlinePicker;
      selectList.requestRender();
    }
    if (pickerFrame) {
      const state = picker?.kind === "select" && !picker.loading ? picker : undefined;
      const inlinePicker = isInlinePicker(state);
      pickerFrame.visible = !!state;
      pickerFrame.border = inlinePicker;
      pickerFrame.borderColor = inlinePicker ? theme.border : theme.background;
      pickerFrame.backgroundColor = inlinePicker ? theme.backgroundPanel : "#00000000";
      pickerFrame.title = undefined;
      pickerFrame.requestRender();
    }
    dock?.requestRender();
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
      prompt?.clear();
      prompt?.blur();
      redrawDock();
      return;
    }
    picker = undefined;
    redrawDock();
    setTimeout(() => prompt?.focus(), 0);
  }

  const addMessage = (role: DisplayMessage["role"], content: string) => {
    currentMessages = compactDisplayMessages([...currentMessages, { role, content }]);
    redrawTranscript();
  };

  const clearMessages = () => {
    currentMessages = [];
    redrawTranscript();
  };

  async function submitPrompt() {
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
    const raw = prompt?.plainText ?? "";
    const input = raw.trimEnd();
    if (!input.trim()) return;
    prompt?.clear();
    if (picker?.kind === "key") {
      closePicker();
      await executeSlash(`/key ${input}`);
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
    const nextValue = typeof value === "string" ? value : prompt?.plainText ?? "";
    promptText = nextValue;
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

    if (!commands.length) {
      if (picker?.kind === "select" && picker.mode === "slash") closePicker();
      return;
    }

    picker = {
      kind: "select",
      mode: "slash",
      title: "Commands",
      items: commands,
      index: Math.min(picker?.kind === "select" && picker.mode === "slash" ? picker.index : 0, commands.length - 1),
    };
    redrawDock();
  }

  function openCommandPalette() {
    const items = buildSlashItems();
    picker = {
      kind: "select",
      mode: "slash",
      title: "Commands",
      items,
      allItems: items,
      index: 0,
    };
    prompt?.clear();
    promptText = "";
    prompt?.focus();
    redrawDock();
  }

  function buildSlashItems(query = ""): PickerItem[] {
    return slashRegistry.list()
      .filter((command) => !query || command.name.toLowerCase().startsWith(query))
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
    if (kind === "key") {
      picker = {
        kind: "key",
        title: providerId ? `Enter API key for ${providerId}` : "Enter API key",
        providerId,
        previous: previousPickerForKey,
      };
      previousPickerForKey = undefined;
      prompt?.clear();
      prompt?.focus();
      redrawDock();
      return;
    }

    const selectKind = kind as Exclude<PickerMode, "key">;
    prompt?.clear();
    promptText = "";
    const immediateItems = buildPickerItems(selectKind);
    picker = {
      kind: "select",
      mode: selectKind,
      title: pickerTitle(selectKind),
      items: immediateItems,
      allItems: immediateItems,
      index: preferredPickerIndex(selectKind, immediateItems),
      loading: false,
    };
    prompt?.focus();
    redrawDock();
  }

  async function runPickerItem(item: PickerItem) {
    if (picker?.kind === "select" && picker.mode === "file") {
      applyFileSuggestion(item.value);
      return;
    }
    if (picker?.kind === "select" && picker.mode === "slash") {
      prompt?.clear();
      closePicker();
      await executeSlash(item.command);
      return;
    }
    if (item.next === "key") {
      picker = { kind: "key", title: `Enter API key for ${item.value}`, providerId: item.value };
      prompt?.clear();
      prompt?.focus();
      redrawDock();
      return;
    }
    if (picker?.kind === "select" && picker.mode === "provider-add") {
      previousPickerForKey = { ...picker, items: [...picker.items], allItems: picker.allItems ? [...picker.allItems] : undefined };
    }
    prompt?.clear();
    closePicker();
    await executeSlash(item.command);
  }

  function buildPickerItems(kind: Exclude<PickerMode, "key">): PickerItem[] {
    if (kind === "slash") return [];
    if (kind === "model") {
      const items: PickerItem[] = [];
      for (const provider of registry.getEnabled()) {
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
          items.push({
            label: model.name,
            detail: `${provider.name}${props.agent.model === `${provider.id}:${model.id}` ? " · current" : ""}`,
            value: `${provider.id}:${model.id}`,
            command: `/model ${provider.id}:${model.id}`,
          });
        }
      }
      const currentModel = props.agent.model;
      if (currentModel && !items.some((item) => item.value === currentModel)) {
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
      return registry.getConfigured().map((provider) => ({
        label: provider.name,
        detail: `${provider.id}${provider.id === registry.getDefault()?.id ? " · default" : ""}${provider.apiKey ? "" : " · needs key"}`,
        value: provider.id,
        command: `/provider --set ${provider.id}`,
      }));
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

    currentMessages = compactDisplayMessages([...currentMessages, { role: "user", content: displayInput }]);
    redrawTranscript();
    setIsRunning(true);
    setStreamingContent("");
    setStreamingReasoning("");
    setStreamingTools([]);

    let assistantContent = "";
    let assistantReasoning = "";
    const toolCalls: DisplayToolCall[] = [];
    let runError: string | undefined;
    try {
      for await (const event of props.agent.run(actualInput, props.args.cwd)) {
        if (event.type === "text_delta") {
          assistantContent += event.content;
          setStreamingContent(assistantContent);
          redrawTranscript({ role: "assistant", content: assistantContent, reasoning: assistantReasoning || undefined, toolCalls: toolCalls.length ? [...toolCalls] : undefined });
        } else if (event.type === "reasoning_delta") {
          assistantReasoning += event.content;
          setStreamingReasoning(assistantReasoning);
          redrawTranscript({ role: "assistant", content: assistantContent, reasoning: assistantReasoning || undefined, toolCalls: toolCalls.length ? [...toolCalls] : undefined });
        } else if (event.type === "tool_start") {
          toolCalls.push({ id: event.id, name: event.name, args: event.args });
          setStreamingTools([...toolCalls]);
          redrawTranscript({ role: "assistant", content: assistantContent, reasoning: assistantReasoning || undefined, toolCalls: [...toolCalls] });
        } else if (event.type === "tool_end") {
          const call = toolCalls.find((item) => item.id === event.id);
          if (call) {
            call.result = event.result.content;
            call.isError = event.result.isError;
            setStreamingTools([...toolCalls]);
            redrawTranscript({ role: "assistant", content: assistantContent, reasoning: assistantReasoning || undefined, toolCalls: [...toolCalls] });
          }
        } else if (event.type === "todos_updated") {
          setTodos(event.todos);
        } else if (event.type === "mode_changed") {
          setMode(event.mode);
          props.options.sessionManager?.appendMarker("mode_switch", event.mode);
        } else if (event.type === "turn_end") {
          currentMessages = compactDisplayMessages([...currentMessages, {
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            toolCalls: toolCalls.length ? [...toolCalls] : undefined,
          }]);
          redrawTranscript();
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          setStreamingContent("");
          setStreamingReasoning("");
          setStreamingTools([]);
        }
      }
    } catch (error: any) {
      runError = error?.message || String(error);
    } finally {
      pendingApprovalRef = undefined;
      setPendingApproval(undefined);
      setApprovalOptionIdx(0);
      setIsRunning(false);
      setStreamingContent("");
      setStreamingReasoning("");
      setStreamingTools([]);
      currentMessages = compactDisplayMessages(reconstructDisplayMessages(props.agent.messages));
      if (runError) {
        currentMessages = compactDisplayMessages([...currentMessages, { role: "error", content: runError }]);
      }
      redrawTranscript();
      redrawDock();
      setTimeout(() => prompt?.focus(), 0);
    }
  }

  return h("box", { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background }, () => {
    const approval = pendingApproval();
    return [
    h("box", { flexDirection: "column", flexGrow: 1, minHeight: 0, paddingLeft: 2, paddingRight: 2, paddingBottom: 1 },
      h("scrollbox", {
        ref: (ref: ScrollBoxRenderable) => { scrollbox = ref; },
        stickyScroll: true,
        stickyStart: "bottom",
        flexGrow: 1,
        minHeight: 0,
      },
        h("box", { height: 1 }),
        h("text", {
          ref: (ref: TextRenderable) => {
            transcript = ref;
            transcript.content = formatTranscript(currentMessages, transcriptOptions());
          },
          fg: theme.text,
          wrapMode: "word",
          content: "",
        }),
      ),
      todos().length ? renderTodos(todos()) : null,

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
      ),
      notice() ? h("text", { fg: theme.warning }, notice()) : null,
      h("box", {
        ref: (ref: BoxRenderable) => { approvalRoot = ref; },
        visible: !!approval,
        backgroundColor: theme.backgroundPanel,
        border: ["left"],
        borderColor: theme.warning,
        marginTop: 1,
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
              content: approval ? (getApprovalPanelMeta(approval.request).preview || "") : "",
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
      renderPrompt({
        ref: (ref) => { prompt = ref; },
        onSubmit: submitPrompt,
        onContentChange: onPromptContentChange,
        onKeyDown: handlePickerKey,
        onUiKeyDown: (event: any) => {
          const name = String(event.name || "").toLowerCase();
          const approval = pendingApproval();
          if (approval && (name === "left" || name === "right" || name === "up" || name === "down" || name === "h" || name === "l")) {
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
          return false;
        },
        getText: () => prompt?.plainText ?? "",
        disabled: () => isRunning() && !pendingApproval() && !pendingPlan(),
        mode,
        model: () => displayModel(props.agent.model) || "no model",
        placeholder: () => {
          const approval = pendingApproval();
          if (approval) return "Press Enter to approve or Esc to reject";
          const plan = pendingPlan();
          if (plan) return "Press Enter to approve plan or Esc to reject";
          return `Ask anything... "${homePrompt}"`;
        },
      }),
    ),
    renderFooter({
      cwd: props.args.cwd,
      provider: () => props.agent.providerId || registry.getDefault()?.id || "unknown",
      model: () => displayModel(props.agent.model) || "no model",
      mode,
      running: isRunning,
    }),
  ];
  });
}

function renderPrompt(input: {
  ref: (ref: TextareaRenderable) => void;
  onSubmit: () => void;
  onContentChange: (value?: unknown) => void;
  onKeyDown: (event: any) => boolean;
  onUiKeyDown: (event: any) => boolean;
  getText: () => string;
  disabled: () => boolean;
  mode: () => PermissionMode;
  model: () => string;
  placeholder: () => string;
}) {
  return h("box", { flexDirection: "column", flexShrink: 0, marginTop: 1 },
    h("box", { border: ["left"], borderColor: theme.primary, backgroundColor: theme.backgroundElement },
      h("box", { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, backgroundColor: theme.backgroundElement },
        h("textarea", {
          ref: input.ref,
          focused: true,
          placeholder: input.placeholder(),
          placeholderColor: theme.textMuted,
          textColor: theme.text,
          focusedTextColor: theme.text,
          backgroundColor: theme.backgroundElement,
          focusedBackgroundColor: theme.backgroundElement,
          minHeight: 1,
          maxHeight: 6,
          onContentChange: () => input.onContentChange(input.getText()),
          keyBindings: [
            { name: "return", action: "submit" },
            { name: "linefeed", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ],
          onKeyDown: (event: any) => {
            if (input.onUiKeyDown(event)) return;
            if (input.onKeyDown(event)) return;
            if (input.disabled()) event.preventDefault();
            setTimeout(() => input.onContentChange(input.getText()), 0);
          },
          onSubmit: input.onSubmit,
        }),
        h("box", { flexDirection: "row", flexShrink: 0, paddingTop: 1, gap: 1, justifyContent: "space-between" },
          h("box", { flexDirection: "row", gap: 1 },
            h("text", { fg: theme.primary }, input.mode() === "plan" ? "Plan" : "Build"),
            h("text", { fg: theme.textMuted }, "·"),
            h("text", { fg: theme.text }, input.model),
          ),
        ),
      ),
    ),
    h("box", { height: 1, border: ["left"], borderColor: theme.primary },
      h("box", { height: 1, border: ["bottom"], borderColor: theme.backgroundElement }),
    ),
    h("box", { width: "100%", flexDirection: "row", justifyContent: "space-between" },
      () => input.disabled() ? h("text", { fg: theme.textMuted }, "esc interrupt") : h("text", { fg: theme.textMuted }, ""),
      h("box", { flexDirection: "row", gap: 2 },
        h("text", { fg: theme.text }, "⇧↵ ", h("span", { fg: theme.textMuted }, "newline")),
        h("text", { fg: theme.text }, "tab ", h("span", { fg: theme.textMuted }, "agents")),
        h("text", { fg: theme.text }, "ctrl+p ", h("span", { fg: theme.textMuted }, "commands")),
        h("text", { fg: theme.text }, "@ ", h("span", { fg: theme.textMuted }, "files")),
      ),
    ),
  );
}

function renderMessage(message: DisplayMessage, index: number) {
  if (message.role === "user") return renderUserMessage(message, index);
  if (message.role === "error") {
    return h("box", { border: ["left"], borderColor: theme.error, marginTop: 1, paddingLeft: 2, paddingTop: 1, paddingBottom: 1, backgroundColor: theme.backgroundPanel },
      h("text", { fg: theme.error, wrapMode: "word" }, message.content),
    );
  }
  return renderAssistantMessage(message);
}

function renderUserMessage(message: DisplayMessage, index: number) {
  return h("box", {
    border: ["left"],
    borderColor: theme.messageUserBorder,
    marginTop: index === 0 ? 0 : 1,
    backgroundColor: theme.backgroundPanel,
  },
    h("box", { paddingTop: 1, paddingBottom: 1, paddingLeft: 2, backgroundColor: theme.backgroundPanel, flexShrink: 0 },
      h("text", { fg: theme.messageUserText, wrapMode: "word" }, message.content || " "),
    ),
  );
}

function renderAssistantMessage(message: DisplayMessage) {
  const children: Child[] = [];
  if (message.reasoning) {
    children.push(h("box", { paddingLeft: 2, marginTop: 1, border: ["left"], borderColor: theme.messageThinkingBorder },
      h("text", { fg: theme.messageThinkingText, wrapMode: "word" }, `Thinking: ${truncate(message.reasoning.trim(), 800)}`),
    ));
  }
  for (const tool of message.toolCalls ?? []) children.push(renderTool(tool));
  if (message.content.trim()) {
    children.push(h("box", { paddingLeft: 3, marginTop: 1 },
      h("text", { fg: theme.messageAssistantText, wrapMode: "word" }, message.content.trim()),
    ));
    children.push(h("box", { paddingLeft: 3 },
      h("text", { fg: theme.messageAssistantAccent }, "▣ ", h("span", { fg: theme.text }, "Build")),
    ));
  }
  if (!children.length) return null;
  return h("box", { flexDirection: "column", flexShrink: 0 }, children);
}

function renderTool(tool: DisplayToolCall) {
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
  const color = toolColor(tool);
  return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column" },
    h("text", { fg: color },
      `${tool.result ? "" : "~ "}${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
    ),
    () => tool.result ? h("text", { fg: tool.isError ? theme.toolError : theme.textMuted, wrapMode: "word" }, `  ${summarizeToolResult(tool)}`) : null,
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
}) {
  return h("box", { flexShrink: 0, height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row" },
    h("text", { fg: theme.border }, "─ "),
    h("text", { fg: theme.textMuted }, `${shortCwd(input.cwd)}  ${input.running() ? "running" : "idle"}`),
    () => input.mode() !== "default" ? h("text", { fg: theme.warning }, `  ${input.mode()} · ⇧⇥`) : null,
    h("box", { flexGrow: 1 }),
    h("text", { fg: theme.textMuted }, `${input.provider()} · ${input.model()}`),
  );
}

function pickerTitle(kind: Exclude<PickerMode, "key">) {
  switch (kind) {
    case "model":
      return "Select Model";
    case "provider":
      return "Select Provider";
    case "provider-add":
      return "Add Provider";
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

function selectHeight(state: Extract<PickerState, { kind: "select" }>) {
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
  tip: string;
  width: number;
  plan?: string;
  selectedOption?: number;
};

function renderTranscript(messages: DisplayMessage[], options?: TranscriptOptions) {
  const visibleMessages = messages.filter(hasRenderableMessage);
  if (!visibleMessages.length) return renderHomeTranscript(options);
  return visibleMessages.map((message, index) => renderMessage(message, index));
}

function renderHomeTranscript(options?: TranscriptOptions) {
  const width = Math.max(20, options?.width ?? 80);
  const cwd = options?.cwd ? shortCwd(options.cwd) : "";
  const tip = options?.tip ?? HOME_TIPS[0]!;
  return h("box", { flexDirection: "column", flexShrink: 0 },
    h("text", { fg: theme.text }, ""),
    h("text", { fg: theme.text }, ""),
    ...HOME_LOGO.map((line) => h("text", { fg: theme.primary }, centerLine(line, width))),
    h("text", { fg: theme.text }, ""),
    h("text", { fg: theme.warning }, centerLine(`● Tip  ${tip}`, width)),
    cwd ? h("text", { fg: theme.textMuted }, centerLine(`  ${cwd}`, width)) : null,
  );
}

function formatTranscript(messages: DisplayMessage[], options?: TranscriptOptions): StyledText {
  const visibleMessages = messages.filter(hasRenderableMessage);
  if (!visibleMessages.length) return formatHomeTranscript(options);
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
    if (message.reasoning) {
      appendBlank();
      append("│  ", theme.messageThinkingBorder);
      append("Thinking: ", theme.messageThinkingText);
      appendLine(truncate(message.reasoning.trim(), 500), theme.messageThinkingText);
    }
    for (const tool of message.toolCalls ?? []) {
      appendBlank();
      const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
      const color = toolColor(tool);
      append(`   ${tool.result ? "" : "~ "}${icon} `, color);
      append(displayToolName(tool.name), color);
      const header = toolHeader(tool);
      if (header) append(` ${header}`, theme.toolText);
      appendLine("");
      append("     ", theme.borderSubtle);
      appendLine(summarizeToolResult(tool), tool.isError ? theme.toolError : theme.textMuted);
    }
    if (message.content.trim()) {
      appendBlank();
      for (const line of message.content.trim().split(/\r?\n/)) {
        append("   ", theme.borderSubtle);
        appendLine(line || " ", theme.messageAssistantText);
      }
      append("   ▣ ", theme.messageAssistantAccent);
      appendLine("Build", theme.text);
    }
  }
  if (options?.plan) appendPlanTranscript(chunks, options.plan, options.selectedOption ?? 0);
  return new StyledText(chunks);
}

function hasRenderableMessage(message: DisplayMessage) {
  if (message.role === "error") return !!message.content.trim();
  if (message.role === "user") return !!message.content.trim();
  if (message.reasoning?.trim()) return true;
  if (message.content.trim()) return true;
  return (message.toolCalls?.length ?? 0) > 0;
}

function formatHomeTranscript(options?: TranscriptOptions): StyledText {
  const width = Math.max(20, options?.width ?? 80);
  const cwd = options?.cwd ? shortCwd(options.cwd) : "";
  const tip = options?.tip ?? HOME_TIPS[0]!;
  const chunks: StyledText["chunks"] = [];
  const appendCentered = (line: string, color: string) => {
    chunks.push(fg(color)(`${centerLine(line, width)}\n`));
  };
  appendCentered("", theme.text);
  appendCentered("", theme.text);
  for (const line of HOME_LOGO) appendCentered(line, theme.primary);
  appendCentered("", theme.text);
  appendCentered(`● Tip  ${tip}`, theme.warning);
  if (cwd) appendCentered(`  ${cwd}`, theme.textMuted);
  return new StyledText(chunks);
}

function centerLine(line: string, width: number) {
  const pad = Math.max(0, Math.floor((width - plainWidth(line)) / 2));
  return `${" ".repeat(pad)}${line}`;
}

function plainWidth(line: string) {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length;
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
  chunks.push(fg(theme.warning)("┃\n"));
  for (const line of lines) {
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
    };
  }

  return {
    icon: "→",
    title: `Write ${path}`,
    subtitle: "",
    preview: request.content || "No content provided",
    previewHeight: 8,
    previewColor: request.content ? theme.toolText : theme.textMuted,
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
  if (!tool.result) return theme.toolPending;
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

function summarizeToolResult(tool: DisplayToolCall): string {
  if (!tool.result) return "pending";
  if (tool.isError) return truncate(tool.result.split("\n").find(Boolean) || "error", 120);
  const lines = tool.result.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim()).length;
  if (tool.name === "edit") return "patched file";
  if (tool.name === "write") return "wrote file";
  if (tool.name === "bash") return lines ? `${lines} line${lines === 1 ? "" : "s"} output` : "done";
  return lines ? `${lines} line${lines === 1 ? "" : "s"}` : "done";
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, Math.max(1, max - 1)).trimEnd() + "…" : value;
}

function shortCwd(cwd: string) {
  const home = process.env.HOME;
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}
