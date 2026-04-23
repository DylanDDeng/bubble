import {
  createCliRenderer,
  type CliRenderer,
  type ScrollBoxRenderable,
  type SelectOption,
  type SelectRenderable,
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
import type { BashAllowlist } from "../approval/session-cache.js";
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
}

const theme = {
  primary: "#fab283",
  accent: "#9d7cd8",
  secondary: "#5c9cf5",
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  border: "#484848",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
};

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
  let picker: PickerState | undefined;
  let previousPickerForKey: Extract<PickerState, { kind: "select" }> | undefined;
  let prompt: TextareaRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  let transcript: TextRenderable | undefined;
  let dock: TextRenderable | undefined;
  let selectList: SelectRenderable | undefined;

  createEffect(() => {
    if (props.options.planHandlerRef) {
      props.options.planHandlerRef.current = (plan: string) =>
        new Promise<PlanDecision>((resolve) => setPendingPlan({ plan, resolve }));
    }
    if (props.options.approvalHandlerRef) {
      props.options.approvalHandlerRef.current = (request: ApprovalRequest) =>
        new Promise<ApprovalDecision>((resolve) => setPendingApproval({ request, resolve }));
    }
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
      if (name === "y" || name === "return" || name === "enter") {
        setPendingPlan(undefined);
        plan.resolve({ action: "approve", plan: plan.plan });
      }
      if (name === "n" || name === "escape") {
        setPendingPlan(undefined);
        plan.resolve({ action: "reject", reason: "Rejected by user." });
      }
      event.preventDefault?.();
      return;
    }

    const approval = pendingApproval();
    if (approval) {
      if (name === "y" || name === "return" || name === "enter") {
        setPendingApproval(undefined);
        approval.resolve({ action: "approve" });
      }
      if (name === "n" || name === "escape") {
        setPendingApproval(undefined);
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
    }
  }, {});

  function currentTranscriptMessages(extra?: DisplayMessage) {
    return extra ? [...currentMessages, extra] : currentMessages;
  }

  function redrawTranscript(extra?: DisplayMessage) {
    if (transcript) {
      transcript.content = formatTranscript(currentTranscriptMessages(extra));
    }
    scrollbox?.requestRender();
    setTimeout(() => scrollbox?.scrollTo(scrollbox.scrollHeight), 0);
  }

  function redrawDock() {
    if (dock) dock.content = formatDock(picker);
    if (selectList) {
      const state = picker?.kind === "select" && !picker.loading ? picker : undefined;
      selectList.visible = !!state;
      selectList.options = state ? state.items.map(toSelectOption) : [];
      selectList.selectedIndex = state ? state.index : 0;
      selectList.height = state ? selectHeight(state) : 0;
      selectList.requestRender();
    }
    dock?.requestRender();
  }

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
    prompt?.clear();
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
    if (isRunning() || pendingPlan() || pendingApproval()) return;
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
          items: matches.map((command) => ({
            label: `/${command.name}`,
            detail: command.description,
            value: command.name,
            command: `/${command.name}`,
          })),
          index: 0,
        };
        redrawDock();
        return;
      }
    }
    await handleInput(input);
  }

  function onPromptContentChange(value: string) {
    promptText = value;
    if (picker?.kind === "key") return;
    if (picker?.kind === "select" && picker.mode !== "slash" && picker.mode !== "file") {
      filterActivePicker(value);
      return;
    }

    const trimmedBeforeCursor = value;
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
    const commands = slashRegistry.list()
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .map((command): PickerItem => ({
        label: `/${command.name}`,
        detail: command.description,
        value: command.name,
        command: `/${command.name}`,
      }));

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

  function filterActivePicker(value: string) {
    if (!picker || picker.kind !== "select") return;
    const source = picker.allItems ?? picker.items;
    const query = value.trim().toLowerCase();
    const nextItems = query
      ? source.filter((item) => {
        const haystack = `${item.label} ${item.detail ?? ""} ${item.value}`.toLowerCase();
        return haystack.includes(query);
      })
      : source;
    picker.items = nextItems;
    picker.index = Math.min(Math.max(0, picker.index), Math.max(0, nextItems.length - 1));
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
    picker = { kind: "select", mode: selectKind, title: pickerTitle(selectKind), items: immediateItems, allItems: immediateItems, index: 0, loading: false };
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
            detail: provider.name,
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
        detail: provider.id === registry.getDefault()?.id ? "default" : provider.id,
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
      addMessage("error", error?.message || String(error));
    } finally {
      setIsRunning(false);
      setStreamingContent("");
      setStreamingReasoning("");
      setStreamingTools([]);
      setTimeout(() => prompt?.focus(), 0);
    }
  }

  return h("box", { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background }, () => [
    h("box", { flexGrow: 1, minHeight: 0, paddingLeft: 2, paddingRight: 2, paddingBottom: 1 },
      h("scrollbox", {
        ref: (ref: ScrollBoxRenderable) => { scrollbox = ref; },
        stickyScroll: true,
        stickyStart: "bottom",
        flexGrow: 1,
      },
        h("box", { height: 1 }),
        h("text", {
          ref: (ref: TextRenderable) => { transcript = ref; },
          fg: theme.text,
          wrapMode: "word",
          content: formatTranscript(currentMessages),
        }),
      ),
      todos().length ? renderTodos(todos()) : null,
      pendingPlan() ? renderPlanPrompt(pendingPlan()!.plan) : null,
      pendingApproval() ? renderApprovalPrompt(pendingApproval()!.request) : null,
      h("text", {
        ref: (ref: TextRenderable) => { dock = ref; },
        fg: theme.text,
        wrapMode: "word",
        content: formatDock(picker),
      }),
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
      notice() ? h("text", { fg: theme.warning }, notice()) : null,
      renderPrompt({
        ref: (ref) => { prompt = ref; },
        onSubmit: submitPrompt,
        onContentChange: onPromptContentChange,
        onKeyDown: handlePickerKey,
        getText: () => prompt?.plainText ?? "",
        disabled: isRunning,
        mode,
        model: () => displayModel(props.agent.model) || "no model",
      }),
    ),
    renderFooter({
      cwd: props.args.cwd,
      provider: () => props.agent.providerId || registry.getDefault()?.id || "unknown",
      model: () => displayModel(props.agent.model) || "no model",
      mode,
      running: isRunning,
    }),
  ]);
}

function renderPrompt(input: {
  ref: (ref: TextareaRenderable) => void;
  onSubmit: () => void;
  onContentChange: (value: string) => void;
  onKeyDown: (event: any) => boolean;
  getText: () => string;
  disabled: () => boolean;
  mode: () => PermissionMode;
  model: () => string;
}) {
  return h("box", { flexDirection: "column", flexShrink: 0, marginTop: 1 },
    h("box", { border: ["left"], borderColor: theme.primary, backgroundColor: theme.backgroundElement },
      h("box", { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, backgroundColor: theme.backgroundElement },
        h("textarea", {
          ref: input.ref,
          focused: true,
          placeholder: "What should Bubble do?",
          placeholderColor: theme.textMuted,
          textColor: theme.text,
          focusedTextColor: theme.text,
          backgroundColor: theme.backgroundElement,
          focusedBackgroundColor: theme.backgroundElement,
          minHeight: 1,
          maxHeight: 6,
          onContentChange: input.onContentChange,
          keyBindings: [
            { name: "return", action: "submit" },
            { name: "linefeed", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ],
          onKeyDown: (event: any) => {
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
        h("text", { fg: theme.text }, "/ ", h("span", { fg: theme.textMuted }, "commands")),
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
    borderColor: theme.primary,
    marginTop: index === 0 ? 0 : 1,
    backgroundColor: theme.backgroundPanel,
  },
    h("box", { paddingTop: 1, paddingBottom: 1, paddingLeft: 2, backgroundColor: theme.backgroundPanel, flexShrink: 0 },
      h("text", { fg: theme.text, wrapMode: "word" }, message.content || " "),
    ),
  );
}

function renderAssistantMessage(message: DisplayMessage) {
  const children: Child[] = [];
  if (message.reasoning) {
    children.push(h("box", { paddingLeft: 2, marginTop: 1, border: ["left"], borderColor: theme.backgroundElement },
      h("text", { fg: theme.textMuted, wrapMode: "word" }, `_Thinking:_ ${truncate(message.reasoning.trim(), 800)}`),
    ));
  }
  for (const tool of message.toolCalls ?? []) children.push(renderTool(tool));
  if (message.content.trim()) {
    children.push(h("box", { paddingLeft: 3, marginTop: 1 },
      h("text", { fg: theme.text, wrapMode: "word" }, message.content.trim()),
    ));
    children.push(h("box", { paddingLeft: 3 },
      h("text", { fg: theme.primary }, "▣ ", h("span", { fg: theme.text }, "Build")),
    ));
  }
  if (!children.length) children.push(h("box", { paddingLeft: 3, marginTop: 1 }, h("text", { fg: theme.primary }, "▣ Bubble")));
  return h("box", { flexDirection: "column", flexShrink: 0 }, children);
}

function renderTool(tool: DisplayToolCall) {
  const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
  return h("box", { paddingLeft: 3, marginTop: 1, flexDirection: "column" },
    h("text", { fg: tool.isError ? theme.error : tool.result ? theme.textMuted : theme.text },
      `${tool.result ? "" : "~ "}${icon} ${displayToolName(tool.name)}${toolHeader(tool) ? ` ${toolHeader(tool)}` : ""}`,
    ),
    () => tool.result ? h("text", { fg: tool.isError ? theme.error : theme.textMuted, wrapMode: "word" }, `  ${summarizeToolResult(tool)}`) : null,
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

function renderApprovalPrompt(request: ApprovalRequest) {
  const preview = request.type === "bash"
    ? `$ ${request.command}`
    : request.type === "edit"
      ? `${request.path}\n${truncate(request.diff, 1200)}`
      : `${request.path}\n${truncate(request.content, 1200)}`;
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
    h("text", { fg: theme.warning }, `◆ Permission request · ${request.type}`),
    h("text", { fg: theme.text, wrapMode: "word", marginTop: 1 }, preview),
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

function formatDock(state: PickerState | undefined) {
  if (!state) return "";
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

function formatTranscript(messages: DisplayMessage[]) {
  if (!messages.length) return "";
  const blocks: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      blocks.push(formatUserTranscript(message.content, index));
      continue;
    }
    if (message.role === "error") {
      blocks.push(`│  Error\n│  ${message.content}`);
      continue;
    }
    if (message.reasoning) {
      blocks.push(`│  Thinking: ${truncate(message.reasoning.trim(), 500)}`);
    }
    for (const tool of message.toolCalls ?? []) {
      const icon = tool.name === "bash" ? "$" : tool.name === "edit" || tool.name === "write" ? "✎" : "●";
      blocks.push(`   ${icon} ${displayToolName(tool.name)} ${toolHeader(tool)}\n     ${summarizeToolResult(tool)}`);
    }
    if (message.content.trim()) {
      blocks.push(`   ${message.content.trim()}\n   ▣ Build`);
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

function formatUserTranscript(content: string, index: number) {
  const margin = index === 0 ? "" : "\n";
  const lines = content.split(/\r?\n/);
  return `${margin}│\n${lines.map((line) => `│  ${line || " "}`).join("\n")}\n│`;
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
