/**
 * Bubble production TUI on the vendored pi-tui renderer.
 *
 * Replaces the Ink App (src/tui-ink/app.tsx) with the same product surface:
 * transcript (user cards, assistant text, reasoning, tool traces), composer
 * with native history, queue/steer while running, status footer, blocking
 * overlays (plan approval, tool approval, questions), model/theme pickers,
 * task wake notices, and clean terminal lifecycle on exit.
 *
 * All runtime logic flows through BubbleTuiController + OverlayRequestController;
 * this file owns rendering and input routing only.
 */
import process from "node:process";
import chalk from "chalk";
import {
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  Text,
  VStack,
  SelectList,
  Editor,
  Input,
  ScrollView,
  Markdown,
  type MarkdownTheme,
  type SelectItem,
  type TUI,
  type TuiMode,
  type Terminal,
  type Component,
  matchesKey,
  isKeyRelease,
  isViewportTUI,
} from "@bubblebrain-ai/pi-tui";
import { StreamingMessageComponent } from "./components/streaming-message.js";
import { ResponsiveTranscriptComponent } from "./components/responsive-transcript.js";
import { WelcomeBannerComponent } from "./components/welcome.js";
import { ApprovalDialogComponent, type ApprovalDialogChoice } from "./components/approval-dialog.js";
import { QuestionDialogComponent } from "./components/question-dialog.js";
import { ProviderKeyInputComponent } from "./components/provider-key-input.js";
import {
  RewindPickerComponent,
  type RewindPickerPoint,
} from "./components/rewind-picker.js";
import {
  TaskStatusBarComponent,
  TasksPaneComponent,
  type SubagentPaneItem,
  type TaskPaneItem,
  type WorkflowPaneItem,
} from "./components/tasks-pane.js";
import { WorkflowInspectorComponent, type WorkflowInspectorSnapshot } from "./components/workflow-inspector.js";
import { SubagentInspectorComponent } from "./components/subagent-inspector.js";
import { TaskInspectorComponent } from "./components/task-inspector.js";
import { ContextInfoComponent } from "./components/context-info.js";
import { StatsPanelComponent } from "./components/stats-panel.js";
import { SkillsPanelComponent } from "./components/skills-panel.js";
import { SessionPickerComponent } from "./components/session-picker.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";
import type { ContextUsageSnapshot } from "../context/usage.js";
import { collectUsageStatsBundle } from "../stats/usage.js";
import { BubbleTuiController } from "./controller/controller.js";
import { OverlayRequestController } from "./controller/overlay-controller.js";
import { defaultTranscriptTheme, projectTranscript, type TranscriptRenderOptions } from "./components/transcript.js";
import { friendlyCwd, sessionBasename } from "./formatting/summary.js";
import { formatExternalRuntimeFooterLabel, ResponsiveFooterComponent } from "./footer.js";
import { ComposerAutocompleteProvider } from "./composer-autocomplete.js";
import { COMPOSER_EDITOR_OPTIONS, COMPOSER_EDITOR_THEME } from "./composer-style.js";
import type { Agent } from "../agent.js";
import { SessionManager } from "../session.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { QuestionController, QuestionEvent, QuestionRequest } from "../question/controller.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { DisplayMessage } from "./model/display-history.js";
import { TraceInteractionState, type TraceAction } from "./model/trace-interaction.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { getNextPermissionMode } from "../permission/mode.js";
import { maskKey } from "../config.js";
import { copyToClipboard } from "../clipboard.js";
import type { RewindScope } from "../rewind.js";

export interface PiAppCallbacks {
  onExitRequest(): void;
  onClearTranscript(): void;
  onThemeToggle(): void;
  onThemeModeChange?(mode: import("../config.js").ThemeMode): void;
  onCompact?(): void;
}

export interface PiTuiAppOptions {
  agent: Agent;
  sessionManager: SessionManager;
  registry?: ProviderRegistry;
  createProvider?: (providerId: string, apiKey: string, baseURL: string) => unknown;
  skillRegistry?: SkillRegistry;
  bashAllowlist?: unknown;
  settingsManager?: unknown;
  hookController?: unknown;
  mcpManager?: unknown;
  lspService?: unknown;
  questionController?: QuestionController;
  planHandlerRef?: { current?: (plan: string) => Promise<{ action: "approve" | "reject"; reason?: string }> };
  approvalHandlerRef?: { current?: (request: ApprovalRequest) => Promise<ApprovalDecision> };
  controller: BubbleTuiController;
  callbacks: PiAppCallbacks;
  updateNotice?: string;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: string) => Promise<string>;
  runMemoryRefresh?: (scope?: string) => Promise<string>;
  /** Test/embedded host injection; production uses ProcessTerminal. */
  terminal?: Terminal;
  /** Renderer selected before the first terminal paint. Production defaults to fullscreen. */
  uiMode?: TuiMode;
  /** Non-blocking git lookup used to populate the footer after first paint. */
  resolveGitBranch?: (cwd: string) => Promise<string | undefined>;
}

const EDITOR_THEME = {
  borderColor: (str: string) => chalk.cyan.dim(str),
  selectList: {
    selectedPrefix: () => chalk.cyan("› "),
    unselectedPrefix: () => "  ",
    selectedText: (str: string) => str,
    description: (str: string) => chalk.dim(str),
    scrollInfo: (str: string) => chalk.dim(str),
    noMatch: (str: string) => chalk.dim(str),
  },
};

const MD_THEME: MarkdownTheme = {
  heading: (t) => chalk.bold.cyan(t),
  link: (t) => chalk.underline.cyan(t),
  linkUrl: (t) => chalk.dim(t),
  code: (t) => chalk.yellow(t),
  codeBlock: (t) => chalk(t),
  codeBlockBorder: (t) => chalk.cyan.dim(t),
  quote: (t) => chalk.dim(t),
  quoteBorder: (t) => chalk.cyan.dim(t),
  hr: (t) => chalk.dim(t),
  listBullet: (t) => chalk.cyan(t),
  bold: (t) => chalk.bold(t),
  italic: (t) => chalk.italic(t),
  strikethrough: (t) => chalk.strikethrough(t),
  underline: (t) => chalk.underline(t),
};

export class PiTuiApp {
  private readonly tui: TUI;
  private readonly editor: Editor;
  private readonly composerSlot = new VStack([]);
  private viewportScroll: ScrollView | null = null;
  private readonly transcriptBox = new VStack([]);
  private readonly streamingMessage = new StreamingMessageComponent(
    8,
    () => this.tui.requestRender(),
    (action) => this.handleTraceAction(action),
  );
  private readonly markdown = new Markdown("", 0, 0, MD_THEME);
  private readonly markdownRenderer = (text: string, width: number): string[] => {
    this.markdown.setText(text);
    return this.markdown.render(width);
  };
  private readonly settledTranscript: ResponsiveTranscriptComponent;
  private readonly welcome: WelcomeBannerComponent;
  private readonly footer: ResponsiveFooterComponent;
  private readonly tasksPane: TasksPaneComponent;
  private readonly taskStatusBar: TaskStatusBarComponent;
  private readonly traceInteraction = new TraceInteractionState();
  private readonly overlays: OverlayRequestController;
  private readonly history: string[] = [];
  private gitBranch: string | undefined;
  private metadataManager: SessionManager | null = null;
  private metadataUnsubscribe: (() => void) | null = null;
  private showReasoning = false;
  private verboseTrace = false;
  private controllerUnsubscribe: (() => void) | null = null;
  private questionUnsubscribe: (() => void) | null = null;
  private activeQuestion: { id: string; close: () => void } | null = null;
  private readonly questionQueue: QuestionRequest[] = [];
  private providerKeyPhase: {
    input: Input;
    component: ProviderKeyInputComponent;
    submitting: boolean;
  } | null = null;
  private rewindPhase: {
    component: RewindPickerComponent;
    draft: string;
    previousScrollTop: number;
  } | null = null;
  private rewindPreviewMessageIndex: number | undefined;
  private disposed = false;

  constructor(private readonly options: PiTuiAppOptions) {
    const terminal = options.terminal ?? new ProcessTerminal();
    // Pick the renderer before start(). Entering fullscreen after the regular
    // renderer has painted necessarily exposes a main-screen frame first.
    // Constructing TuiAltScreen here makes its 1049h transition the first UI
    // write and keeps the entire product surface on one application instance.
    this.tui = (options.uiMode ?? "fullscreen") === "fullscreen"
      ? new TuiAltScreen(terminal, undefined, undefined, { mouseMotion: "all" })
      : new TuiMainScreen(terminal);
    this.editor = new Editor(this.tui, COMPOSER_EDITOR_THEME, COMPOSER_EDITOR_OPTIONS);
    this.editor.setAutocompleteProvider(new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => slashRegistry.list(),
      skills: () => this.options.skillRegistry?.summaries() ?? [],
      uiMode: () => this.tui.mode,
      registry: this.options.registry,
      thinkingLevel: () => this.options.agent.thinking,
      providerId: () => this.options.agent.providerId,
      onModelSuggestionsChanged: () => {
        if (!this.disposed) this.editor.refreshAutocomplete();
      },
    }));
    this.settledTranscript = new ResponsiveTranscriptComponent(
      () => ({
        messages: this.options.controller.getTranscript(),
        options: this.transcriptRenderOptions(),
      }),
      { onTraceAction: (action) => this.handleTraceAction(action) },
    );
    this.welcome = new WelcomeBannerComponent(() => {
      const { agent, updateNotice } = this.options;
      return {
        cwd: friendlyCwd(process.cwd()),
        session: sessionBasename(this.activeSessionManager().getSessionFile()),
        model: agent.model,
        provider: agent.providerId,
        thinking: agent.thinking,
        updateNotice,
      };
    });
    this.footer = new ResponsiveFooterComponent(() => {
      const extra: string[] = [];
      const steerCount = this.options.controller.pendingSteerCount();
      const queuedCount = this.options.controller.queuedInputCount();
      if (steerCount) extra.push(chalk.yellow(`steer ×${steerCount}`));
      if (queuedCount) extra.push(chalk.yellow(`queue ×${queuedCount}`));
      const session = this.activeSessionManager();
      const metadata = typeof session?.getMetadata === "function" ? session.getMetadata() : undefined;
      const runtimeLabel = formatExternalRuntimeFooterLabel(metadata?.externalRuntime);
      return {
        agent: this.options.agent,
        cwd: friendlyCwd(process.cwd()),
        branch: this.gitBranch,
        sessionTitle: runtimeLabel ? undefined : metadata?.title,
        runtimeLabel,
        extra,
        mode: this.options.agent.mode,
        goalLine: runtimeLabel ? undefined : this.options.controller.getGoalIndicator?.(),
        // At two rows or fewer, preserve the focused editor body + border.
        hidden: this.tui.terminal.rows <= 2,
      };
    });
    this.tasksPane = new TasksPaneComponent(
      () => ({
        groups: this.options.controller.getSubagentGroups?.() ?? [],
        workflows: this.options.controller.getWorkflows?.() ?? [],
        tasks: this.options.controller.getBackgroundTasks?.() ?? [],
      }),
      () => this.tui.terminal.rows,
      {
        onRender: () => this.renderSnapshot(),
        onOpenWorkflow: (item) => this.openWorkflowInspector(item),
        onOpenSubagent: (item) => this.openSubagentInspector(item),
        onOpenTask: (item) => this.openTaskInspector(item),
        onStopWorkflow: (id) => this.options.controller.stopWorkflow(id),
        onStopSubagent: (id) => this.options.controller.stopSubagent(id),
        onStopTask: (id) => this.options.controller.stopBackgroundTask(id),
        onEscape: () => {
          this.tasksPane.focused = false;
          this.tui.setFocus(this.editor);
          this.renderSnapshot();
        },
      },
    );
    this.taskStatusBar = new TaskStatusBarComponent(this.tasksPane);
    this.overlays = new OverlayRequestController({ questionController: options.questionController });

    this.syncMetadataSubscription();
    this.installBlockingHandlers();
    this.buildLayout();
    this.wireInput();
    this.renderSnapshot();
    void options.resolveGitBranch?.(process.cwd()).then((branch) => {
      if (this.disposed) return;
      this.gitBranch = branch?.trim() || undefined;
      this.renderSnapshot();
    }).catch(() => undefined);
  }

  private activeSessionManager(): SessionManager {
    return this.options.controller.getSessionManager?.() ?? this.options.sessionManager;
  }

  private syncMetadataSubscription(): void {
    const manager = this.activeSessionManager();
    if (manager === this.metadataManager) return;
    this.metadataUnsubscribe?.();
    this.metadataManager = manager;
    this.metadataUnsubscribe = typeof manager?.subscribeMetadata === "function"
      ? manager.subscribeMetadata(() => this.renderSnapshot())
      : null;
  }

  private installBlockingHandlers(): void {
    const { planHandlerRef, approvalHandlerRef, questionController } = this.options;
    if (planHandlerRef) {
      planHandlerRef.current = async (plan: string) => {
        const decision = await this.planDialog(plan);
        return decision ? { action: "approve" as const } : { action: "reject" as const, reason: "User rejected the plan." };
      };
    }
    if (approvalHandlerRef) {
      approvalHandlerRef.current = async (request: ApprovalRequest) => {
        const approved = await this.approvalDialog(request);
        return approved
          ? { action: "approve" as const }
          : { action: "reject" as const, feedback: "User denied the tool call." };
      };
    }
    if (questionController) {
      this.questionUnsubscribe = questionController.subscribe((event: QuestionEvent) => {
        if (event.type === "asked") {
          this.questionQueue.push(event.request);
          this.openNextQuestion();
          return;
        }
        this.removeQueuedQuestion(event.request.id);
        if (this.activeQuestion?.id === event.request.id) {
          this.activeQuestion.close();
        }
      });
    }
  }

  private buildLayout(): void {
    // Keep the live component permanently after the settled transcript. It
    // renders zero rows while idle. Appending it per turn eventually placed
    // the same component reference in the tree multiple times and let settled
    // rows land after it, breaking spacing/order on later turns.
    this.transcriptBox.addChild(this.settledTranscript);
    this.transcriptBox.addChild(this.streamingMessage);
    this.composerSlot.addChild(this.editor);
    if (isViewportTUI(this.tui)) {
      // Fullscreen owns a bounded viewport. History scrolls while the composer
      // and footer stay docked. The activity lane is a permanent one-row
      // boundary: spinner text changes, its geometry never does.
      const document = new VStack([this.welcome, this.transcriptBox]);
      const scroll = new ScrollView(document, { follow: "end", primary: true });
      this.viewportScroll = scroll;
      this.tui.setLayoutRoot(new VStack([
        { component: scroll, basis: 0, grow: 1, minSize: 0 },
        { component: this.taskStatusBar, basis: "auto", shrink: 0 },
        { component: this.tasksPane, basis: "auto", shrink: 0 },
        { component: this.streamingMessage.activityLane, basis: "auto", shrink: 0 },
        { component: this.composerSlot, basis: "auto", shrink: 0 },
        { component: this.footer, basis: "auto", shrink: 0 },
      ]));
    } else {
      this.tui.addChild(this.welcome);
      this.tui.addChild(this.transcriptBox);
      this.tui.addChild(this.taskStatusBar);
      this.tui.addChild(this.tasksPane);
      this.tui.addChild(this.streamingMessage.activityLane);
      this.tui.addChild(this.composerSlot);
      this.tui.addChild(this.footer);
    }
    this.tui.setFocus(this.editor);

    this.editor.onSubmit = (text: string) => this.handleSubmit(text);
    this.controllerUnsubscribe = this.options.controller.subscribe(() => {
      this.syncMetadataSubscription();
      this.renderSnapshot();
    });
  }

  private wireInput(): void {
    let ctrlCArmed = false;
    let rewindEscapeArmed = false;
    this.tui.addInputListener((data: string) => {
      // Global shortcuts act on key presses only. Kitty keyboard protocol also
      // reports releases; allowing those through can trigger a shortcut twice.
      if (isKeyRelease(data)) return { consume: true };
      // Modal dialogs own their complete keyboard contract. In particular,
      // an approval arrives while a run is active, so letting the global
      // Escape/Ctrl+C handler run first would cancel the agent and strand the
      // unresolved permission request instead of rejecting the dialog.
      if (this.tui.hasOverlay()) return undefined;
      // The inline credential phase owns all of its input. In particular,
      // Escape returns to /provider instead of cancelling an unrelated run,
      // and Shift+Tab must not change permissions while a key is being typed.
      if (this.providerKeyPhase) return undefined;
      if (this.rewindPhase) return undefined;
      if (matchesKey(data, "ctrl+g")) {
        if (this.tasksPane.isOpen() && this.tasksPane.focused) {
          this.tasksPane.close();
          this.tasksPane.focused = false;
          this.tui.setFocus(this.editor);
        } else {
          if (!this.tasksPane.isOpen()) this.tasksPane.toggle(true);
          this.tasksPane.focused = true;
          this.tui.setFocus(this.tasksPane);
        }
        this.renderSnapshot();
        return { consume: true };
      }
      // A focused Tasks Pane owns Escape. It returns focus to the composer;
      // it must never fall through and cancel the running parent Agent.
      if (this.tasksPane.focused && matchesKey(data, "escape")) return undefined;
      if (matchesKey(data, "shift+tab")) {
        this.options.agent.setMode(getNextPermissionMode(this.options.agent.mode));
        this.renderSnapshot();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.options.controller.cancelActiveRun()) {
        // Ink parity: Escape interrupts an active run. When idle, leave the
        // key unconsumed so the editor/autocomplete layer can handle it.
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.options.controller.isBusy?.()) {
        // A second Escape while the provider is acknowledging Compact
        // cancellation must not arm rewind or leak into the editor.
        return { consume: true };
      }
      if (matchesKey(data, "escape") && !this.options.controller.isRunning() && !this.editor.getText()) {
        if (rewindEscapeArmed) {
          rewindEscapeArmed = false;
          this.openRewindPicker();
          return { consume: true };
        }
        rewindEscapeArmed = true;
        setTimeout(() => { rewindEscapeArmed = false; }, 650);
        return undefined;
      }
      rewindEscapeArmed = false;
      if (matchesKey(data, "ctrl+c")) {
        // Match Ink: the first Ctrl+C interrupts the active run. Requiring a
        // second keypress here made cancellation feel like a quit gesture and
        // left the tool trace running behind the composer.
        if (this.options.controller.cancelActiveRun()) {
          ctrlCArmed = false;
          return { consume: true };
        }
        if (this.options.controller.isBusy?.()) return { consume: true };
        if (ctrlCArmed) {
          this.dispose();
          return { consume: true };
        }
        ctrlCArmed = true;
        setTimeout(() => {
          ctrlCArmed = false;
        }, 1_500);
        return { consume: true };
      }
      if (data === "\x14") {
        this.showReasoning = !this.showReasoning;
        this.renderSnapshot();
        return { consume: true };
      }
      if (data === "\x0f") {
        this.verboseTrace = !this.verboseTrace;
        this.renderSnapshot();
        return { consume: true };
      }
      return undefined;
    });
  }

  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.editor.addToHistory(trimmed);
    this.history.unshift(trimmed);

    if (trimmed.startsWith("/")) {
      void this.handleCommand(trimmed);
      return;
    }

    const controller = this.options.controller;
    if (controller.isRunning()) {
      // Enter while running steers the current turn; Tab-equivalent queueing
      // is exposed via the /queue command until a dedicated keybinding lands.
      controller.steer(trimmed);
      this.renderSnapshot();
    } else if (controller.queueAfterCommand?.(trimmed)) {
      this.renderSnapshot();
    } else {
      this.pushUserRow(trimmed);
      void controller.runTurn(trimmed, process.cwd()).finally(() => this.renderSnapshot());
    }
  }

  private async handleCommand(command: string): Promise<void> {
    const [name, ...rest] = command.slice(1).split(/\s+/);
    const args = rest.join(" ");

    // pi-tui-local commands first (renderer-specific modes).
    if (name === "fullscreen") {
      if (this.tui.mode === "fullscreen") {
        this.pushNotice("Already in fullscreen mode");
        this.renderSnapshot();
        return;
      }
      void this.enterFullscreen();
      return;
    }

    const skillInvocation = this.options.skillRegistry
      ? parseSkillInvocation(command, this.options.skillRegistry)
      : undefined;
    if (skillInvocation) {
      this.pushUserRow(command);
      const controller = this.options.controller;
      if (controller.isRunning()) {
        controller.steer(skillInvocation.actualPrompt);
        this.renderSnapshot();
      } else {
        void controller.runTurn(skillInvocation.actualPrompt, process.cwd()).finally(() => this.renderSnapshot());
      }
      return;
    }

    // Everything else routes through the shared registry (21 builtin
    // commands + MCP dynamic prompts + skill fallback) — the same surface
    // the Ink TUI exposed.
    const compactCommand = name === "compact";
    let compactSignal: AbortSignal | undefined;
    try {
      if (compactCommand) compactSignal = this.options.controller.beginCommandActivity?.("compact");
      const ctx = this.buildSlashContext(compactSignal);
      const outcome = await slashRegistry.execute(`/${name}${args ? ` ${args}` : ""}`, ctx);
      if (compactCommand) {
        const text = outcome.result ?? (outcome.handled ? undefined : `Unknown command: /${name}`);
        const compactionSummary = outcome.detail?.kind === "compaction-summary"
          ? outcome.detail.content.trim()
          : "";
        this.options.controller.finishCommandActivity?.("compact", text ? {
          key: `compact-${Date.now()}`,
          role: text.startsWith("Error:") ? "error" : "assistant",
          content: text,
          syntheticKind: text.startsWith("Error:")
            ? undefined
            : compactionSummary
              ? "ui_compact_summary"
              : "ui_notice",
          compactionSummary: compactionSummary || undefined,
        } : undefined);
        void this.options.controller.drainQueuedInputs?.(process.cwd());
        return;
      }
      if (outcome.inject) {
        // Command produced model-facing input (e.g. /rewind restore).
        void this.handleSubmit(outcome.inject);
      } else if (outcome.result) {
        this.pushNotice(outcome.result);
      } else if (!outcome.handled) {
        this.pushNotice(`Unknown command: /${name}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (compactCommand && compactSignal) {
        this.options.controller.finishCommandActivity?.("compact", {
          key: `compact-error-${Date.now()}`,
          role: "error",
          content: text,
        });
      } else {
        this.pushNotice(text);
      }
    } finally {
      if (compactSignal && this.options.controller.getCommandActivity?.()?.kind === "compact") {
        this.options.controller.finishCommandActivity?.("compact");
      }
      this.renderSnapshot();
    }
  }

  private buildSlashContext(compactionAbortSignal?: AbortSignal): SlashCommandContext {
    const options = this.options;
    const agent = options.agent;
    const addMessage = (role: "user" | "assistant" | "error", content: string) => {
      options.controller.appendDisplayMessage({
        key: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role,
        content,
        syntheticKind: role === "assistant" ? "ui_notice" : undefined,
      });
    };
    return {
      agent,
      addMessage,
      clearMessages: () => options.controller.clearTranscript(),
      cwd: process.cwd(),
      exit: () => this.dispose(),
      // Embedded/test hosts created before session switching may only expose
      // the constructor manager; production controllers provide the live one.
      sessionManager: (options.controller.getSessionManager?.() ?? options.sessionManager) as never,
      createProvider: options.createProvider as never,
      openPicker: (mode, providerId) => {
        if (mode === "model" || mode === "provider") {
          // A bare picker command can still arrive from a fast Enter or a
          // non-composer command host. Keep pi-tui on the shared inline
          // command surface instead of falling back to a centered overlay.
          this.editor.setText(mode === "model" ? "/model " : "/provider ");
          this.editor.refreshAutocomplete();
        } else if (mode === "key" && providerId) {
          this.openProviderKeyPhase(providerId);
        } else if (mode === "skill") {
          this.openSkills();
        }
      },
      registry: options.registry as never,
      skillRegistry: options.skillRegistry as never,
      bashAllowlist: options.bashAllowlist as never,
      settingsManager: options.settingsManager as never,
      hookController: options.hookController as never,
      mcpManager: options.mcpManager as never,
      lspService: options.lspService as never,
      flushMemory: options.flushMemory,
      runMemoryCompaction: options.runMemoryCompaction,
      runMemorySummary: options.runMemorySummary,
      runMemoryRefresh: options.runMemoryRefresh,
      setThemeMode: (mode) => {
        options.callbacks.onThemeToggle();
        options.callbacks.onThemeModeChange?.(mode);
      },
      openFeedback: () => this.pushNotice("feedback dialog: coming to the pi TUI"),
      openStats: () => this.openStats(),
      ...(this.tui.mode === "fullscreen"
        ? { openContextInfo: (snapshot: ContextUsageSnapshot) => this.openContextInfo(snapshot) }
        : {}),
      handleGoalCommand: (input) => options.controller.handleGoalCommand(input, process.cwd()),
      openRewindPicker: () => this.openRewindPicker(),
      fillComposer: (text) => {
        this.editor.setText(text);
        this.tui.setFocus(this.editor);
      },
      rebuildTranscript: () => options.controller.rebuildTranscriptFromAgent(),
      openSessionPicker: () => this.openSessionPicker(),
      compactionProgress: () => {},
      compactionAbortSignal,
    } as SlashCommandContext;
  }

  private pushUserRow(text: string): void {
    this.appendTranscriptRow({ key: `user-${this.history.length}`, role: "user", content: text });
  }

  private pushNotice(text: string): void {
    this.appendTranscriptRow({
      key: `notice-${Date.now()}`,
      role: "assistant",
      content: text,
      syntheticKind: "ui_notice",
    });
  }

  private appendTranscriptRow(message: DisplayMessage): void {
    this.options.controller.appendDisplayMessage(message);
  }

  private streamingMounted = false;

  /** One display policy feeds both committed history and the live row pool. */
  private transcriptRenderOptions(): Omit<TranscriptRenderOptions, "columns"> {
    return {
      showReasoning: this.showReasoning,
      verboseTrace: this.verboseTrace,
      traceInteraction: this.traceInteraction,
      dimFromMessageIndex: this.rewindPreviewMessageIndex,
      theme: defaultTranscriptTheme,
      // Stable identity lets the settled transcript cache survive composer-only
      // frames. The stateful Markdown instance is still updated on cache misses.
      markdownRenderer: this.markdownRenderer,
    };
  }

  renderSnapshot(): void {
    if (this.disposed) return;
    const columns = this.tui.terminal.columns || process.stdout.columns || 80;
    this.updateStreamingRegion(columns);
    this.tui.requestRender();
  }

  /**
   * The streaming preview is a persistent row-pool component mounted as the
   * transcript's LAST child (upstream AssistantMessageComponent pattern).
   * Rows are only ever setText — re-creating components per frame is what
   * leaked every intermediate prefix into scrollback (verified with a
   * VirtualTerminal matrix). On turn end it collapses to zero rows in the
   * same frame the settled message commits, so the full answer replaces the
   * preview with no duplicate.
   */
  private updateStreamingRegion(columns: number): void {
    const controller = this.options.controller;
    const tail = controller.isRunning() ? controller.getStreamingTail() : null;
    const commandActivity = controller.getCommandActivity?.() ?? null;

    if (tail) {
      if (!this.streamingMounted) {
        this.streamingMounted = true;
        this.streamingMessage.startSpinner();
      }
      this.streamingMessage.noteWidth(columns);
      this.streamingMessage.update(tail, columns, this.transcriptRenderOptions());
    } else if (commandActivity) {
      if (!this.streamingMounted) {
        this.streamingMounted = true;
        this.streamingMessage.startSpinner();
      }
      this.streamingMessage.noteWidth(columns);
      this.streamingMessage.updateCommandActivity(
        commandActivity.kind === "compact" ? "Compacting" : commandActivity.kind,
        commandActivity.status === "cancelling",
        columns,
      );
    } else if (this.streamingMounted) {
      this.streamingMounted = false;
      this.streamingMessage.clearToNothing();
    }
  }

  // ---- Fullscreen mode ----------------------------------------------------

  private fullscreen: import("./fullscreen.js").FullscreenApp | null = null;

  /**
   * Switch to the alternate-screen transcript view. The main screen stays
   * mounted but paused (stopped renderer); both modes subscribe to the same
   * controller so the transcript stays in sync. Escape / Ctrl+C / /fullscreen
   * return here.
   */
  private async enterFullscreen(): Promise<void> {
    if (this.fullscreen) return;
    this.tui.stop();
    const { FullscreenApp } = await import("./fullscreen.js");
    this.fullscreen = new FullscreenApp({
      controller: this.options.controller,
      agent: this.options.agent,
      onExit: () => this.exitFullscreen(),
      onCommand: (command) => {
        // Pickers and dialogs are owned by the main-screen TUI. Return to it
        // before executing so every slash command uses the same registry and
        // never leaks into the model as ordinary fullscreen input.
        this.exitFullscreen();
        void this.handleCommand(command);
      },
      terminal: this.options.terminal,
      traceInteraction: this.traceInteraction,
    });
    this.fullscreen.start();
  }

  private exitFullscreen(): void {
    if (!this.fullscreen) return;
    this.fullscreen.dispose();
    this.fullscreen = null;
    this.tui.start();
    this.renderSnapshot();
  }

  // ---- Overlays -----------------------------------------------------------

  private openStats(): void {
    let handle: { hide(): void } | undefined;
    const component = new StatsPanelComponent(collectUsageStatsBundle(), {
      getTerminalRows: () => this.tui.terminal.rows,
      onClose: () => handle?.hide(),
      onRender: () => this.renderSnapshot(),
    });
    handle = this.tui.showOverlay(component, {
      anchor: "center",
      width: "65%",
      minWidth: 44,
      maxWidth: 100,
      maxHeight: 30,
      margin: { top: 2, right: 0, bottom: 2, left: 0 },
    });
    this.tui.setFocus(component);
  }

  private openSkills(): void {
    const skillRegistry = this.options.skillRegistry;
    if (!skillRegistry) {
      this.pushNotice("No skill registry is attached to this session.");
      return;
    }
    let handle: { hide(): void } | undefined;
    const component = new SkillsPanelComponent(skillRegistry, {
      getTerminalRows: () => this.tui.terminal.rows,
      onClose: () => handle?.hide(),
      onRender: () => this.renderSnapshot(),
      onSkillsChanged: () => {
        this.options.agent.setSkillSummaries(skillRegistry.summaries());
        this.editor.refreshAutocomplete();
        this.renderSnapshot();
      },
    });
    handle = this.tui.showOverlay(component, {
      anchor: "center",
      width: "65%",
      minWidth: 40,
      maxWidth: 160,
      maxHeight: 34,
      margin: { top: 3, right: 0, bottom: 3, left: 0 },
      dismissOnOutsideClick: true,
    });
    this.tui.setFocus(component);
  }

  private openSessionPicker(): void {
    if (this.options.controller.isBusy?.()) {
      this.appendTranscriptRow({
        key: `session-error-${Date.now()}`,
        role: "error",
        content: "Stop the current run before switching sessions.",
      });
      return;
    }

    const activeFile = this.activeSessionManager().getSessionFile();
    const currentSessions = SessionManager.summarizeSessionsForCwd(process.cwd());
    const allSessions = SessionManager.listAllSessions();
    let handle: { hide(): void } | undefined;
    const close = () => {
      handle?.hide();
      this.tui.setFocus(this.editor);
      this.renderSnapshot();
    };
    const fail = (prefix: string, error?: string) => {
      close();
      this.appendTranscriptRow({
        key: `session-error-${Date.now()}`,
        role: "error",
        content: `${prefix}: ${error || "unknown error"}`,
      });
    };
    const component = new SessionPickerComponent({
      currentCwd: process.cwd(),
      currentSessions,
      allSessions,
      activeFile,
      getTerminalRows: () => this.tui.terminal.rows,
      onClose: close,
      onNewSession: () => {
        const outcome = this.options.controller.createFreshSession(process.cwd());
        if (!outcome.ok) {
          fail("Failed to start a new session", outcome.error);
          return;
        }
        this.editor.setText("");
        this.viewportScroll?.scrollToEnd();
        close();
      },
      onSelect: (file) => {
        if (file === this.activeSessionManager().getSessionFile()) {
          close();
          return;
        }
        const summary = allSessions.find((session) => session.file === file);
        const displayName = summary?.title || summary?.preview || sessionBasename(file) || "Session";
        const outcome = this.options.controller.switchSession({
          targetFile: file,
          notice: `⤷ Resumed session: ${displayName}`,
        });
        if (!outcome.ok) {
          fail("Failed to switch session", outcome.error);
          return;
        }
        this.editor.setText("");
        this.viewportScroll?.scrollToEnd();
        close();
      },
      onRender: () => this.renderSnapshot(),
    });
    handle = this.tui.showOverlay(component, {
      anchor: "center",
      width: "70%",
      minWidth: 40,
      maxWidth: 120,
      maxHeight: 30,
      margin: { top: 2, right: 0, bottom: 2, left: 0 },
      dismissOnOutsideClick: true,
    });
    this.tui.setFocus(component);
  }

  private openContextInfo(snapshot: ContextUsageSnapshot): void {
    let handle: { hide(): void } | undefined;
    const messages = this.options.agent.messages;
    const turnCount = messages.filter((message) => message.role === "user").length;
    const toolCallCount = messages.reduce((count, message) => (
      count + (message.role === "assistant" ? message.toolCalls?.length ?? 0 : 0)
    ), 0);
    const compactionCount = this.options.agent.getCompactionStats().fired;
    const mcpStates = (this.options.mcpManager as {
      getStates?: () => unknown[];
    } | undefined)?.getStates?.() ?? [];
    const sessionId = sessionBasename(this.activeSessionManager().getSessionFile());
    const component = new ContextInfoComponent({
      snapshot,
      sessionId,
      cwd: friendlyCwd(process.cwd()),
      thinking: this.options.agent.thinking,
      permissionMode: this.options.agent.mode,
      turnCount,
      toolCallCount,
      compactionCount,
      mcpServerCount: mcpStates.length,
    }, {
      getTerminalRows: () => this.tui.terminal.rows,
      onClose: () => handle?.hide(),
      onRender: () => this.renderSnapshot(),
      ...(sessionId ? { copySessionId: () => copyToClipboard(sessionId) } : {}),
    });
    handle = this.tui.showOverlay(component, {
      anchor: "center",
      width: "65%",
      minWidth: 44,
      maxWidth: 100,
      maxHeight: 30,
      margin: { top: 2, right: 0, bottom: 2, left: 0 },
    });
    this.tui.setFocus(component);
  }

  private selectOverlay(items: SelectItem[], title: string, preview?: Component): Promise<SelectItem | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, 8, EDITOR_THEME.selectList, {});
      const header = new Text(chalk.cyan(title), 1, 0);
      const box = new VStack(preview ? [header, preview, list] : [header, list]);
      const handle = this.tui.showOverlay(box, { anchor: "center" });
      list.onSelect = (item) => {
        handle.hide();
        resolve(item);
      };
      list.onCancel = () => {
        handle.hide();
        resolve(null);
      };
      this.tui.setFocus(list);
    });
  }

  private openProviderKeyPhase(providerId: string): void {
    const registry = this.options.registry;
    const provider = registry?.getConfigured().find((candidate) => candidate.id === providerId);
    if (!registry || !provider) {
      this.pushNotice(`Provider ${providerId} could not be prepared for API key setup.`);
      this.renderSnapshot();
      return;
    }

    this.closeProviderKeyPhase(false);
    const input = new Input({ prompt: "◆ ", mask: "•" });
    const component = new ProviderKeyInputComponent(input, provider.name);
    const phase = { input, component, submitting: false };
    this.providerKeyPhase = phase;
    this.composerSlot.removeChild(this.editor);
    this.composerSlot.addChild(component);

    input.onEscape = () => this.closeProviderKeyPhase(true);
    input.onBackspaceAtStart = () => this.closeProviderKeyPhase(true);
    input.onSubmit = (rawKey) => {
      const key = rawKey.replace(/[\r\n\t]/g, "").trim();
      if (!key || phase.submitting || this.providerKeyPhase !== phase) return;
      phase.submitting = true;
      this.closeProviderKeyPhase(false);
      void this.saveProviderKey(providerId, key);
    };
    this.tui.setFocus(input);
    this.renderSnapshot();
  }

  private closeProviderKeyPhase(returnToProviderPicker: boolean): void {
    const phase = this.providerKeyPhase;
    if (!phase) return;

    // Erase the component-owned copy before releasing the phase. The caller
    // may retain the submitted value just long enough to persist it, but UI
    // state never keeps the raw credential after this point.
    phase.input.setValue("");
    phase.input.onSubmit = undefined;
    phase.input.onEscape = undefined;
    phase.input.onBackspaceAtStart = undefined;
    this.composerSlot.removeChild(phase.component);
    this.composerSlot.addChild(this.editor);
    this.providerKeyPhase = null;

    this.editor.setText(returnToProviderPicker ? "/provider " : "");
    if (returnToProviderPicker) this.editor.refreshAutocomplete();
    this.tui.setFocus(this.editor);
    this.renderSnapshot();
  }

  private async saveProviderKey(providerId: string, key: string): Promise<void> {
    const registry = this.options.registry;
    if (!registry) return;

    try {
      registry.updateProviderKey(providerId, key);
      const provider = registry.getConfigured().find((candidate) => candidate.id === providerId);
      if (!provider) throw new Error("provider disappeared after saving credentials");

      // Saving credentials configures the provider; it must not partially
      // mutate the active route. Provider + model + thinking + prompt + session
      // move together only through the shared /model switch transaction.
      registry.setDefault(providerId);

      this.pushNotice(
        `API key updated for ${provider.name} to ${maskKey(key)}. Use /model to select a compatible model.`,
      );
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(key, "[redacted]");
      this.pushNotice(`Failed to update API key for ${providerId}: ${message}`);
    }
    this.renderSnapshot();
  }

  private openRewindPicker(): void {
    if (this.rewindPhase || this.providerKeyPhase || this.disposed) return;
    const controller = this.options.controller;
    const points = controller.isRunning() ? [] : this.collectRewindPoints();
    if (!controller.isRunning() && points.length === 0) {
      this.pushNotice("Nothing to rewind: no user messages in this session.");
      this.renderSnapshot();
      return;
    }

    const draft = this.editor.getText();
    const component = new RewindPickerComponent(
      controller.isRunning() ? "cancel-offer" : "picker",
      points,
      {
        getTerminalRows: () => this.tui.terminal.rows,
        onPreview: (point, scope) => this.previewRewindPoint(point, scope),
        onScopeChange: (point, scope) => this.previewRewindPoint(point, scope),
        onCancel: () => this.closeRewindPicker(true),
        onCancelRun: () => void this.cancelRunForRewind(component),
        onConfirm: (point, scope) => void this.executeRewindFromPicker(component, point, scope),
        onRender: () => this.renderSnapshot(),
      },
    );
    this.rewindPhase = {
      component,
      draft,
      previousScrollTop: this.viewportScroll?.scrollTop ?? 0,
    };
    this.composerSlot.removeChild(this.editor);
    this.composerSlot.addChild(component);
    this.tui.setFocus(component);
    const selected = component.getSelectedPoint();
    if (selected) this.previewRewindPoint(selected, "all");
    this.renderSnapshot();
  }

  private collectRewindPoints(): RewindPickerPoint[] {
    const session = this.options.controller.getSessionManager();
    const turns = session.listUserTurns();
    const checkpoints = session.getCheckpoints();
    return turns.map((turn, turnIndex) => ({
      turn,
      turnIndex,
      fileCount: checkpoints.filesTouchedAt(turn.id).length,
    }));
  }

  private async cancelRunForRewind(component: RewindPickerComponent): Promise<void> {
    if (this.rewindPhase?.component !== component || component.getPhase() !== "cancel-offer") return;
    component.showLoading();
    this.options.controller.cancelActiveRun("Cancelled before rewind");
    await this.waitForControllerIdle();
    if (this.rewindPhase?.component !== component || this.disposed) return;
    component.showPicker(this.collectRewindPoints());
  }

  private waitForControllerIdle(): Promise<void> {
    const controller = this.options.controller;
    if (!controller.isRunning()) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = controller.subscribe(() => {
        if (controller.isRunning()) return;
        unsubscribe();
        resolve();
      });
      // The run can settle between the first check and subscription.
      if (!controller.isRunning()) {
        unsubscribe();
        resolve();
      }
    });
  }

  private async executeRewindFromPicker(
    component: RewindPickerComponent,
    point: RewindPickerPoint,
    scope: RewindScope,
  ): Promise<void> {
    if (this.rewindPhase?.component !== component || component.getPhase() === "executing") return;
    component.showExecuting();
    try {
      const result = await this.options.controller.rewindToTurn(point.turn.id, scope);
      const targetText = result.target.text;
      const restoredDraft = this.rewindPhase?.draft ?? "";
      // Swap the panel, final composer value, transcript dim, and focus before
      // requesting the success paint. This prevents an empty-composer frame
      // between "Rewinding..." and the restored prompt.
      this.closeRewindPicker(false, scope === "code" ? restoredDraft : targetText, false);
      this.viewportScroll?.scrollToEnd();

      const fileCount = result.files.restored.length + result.files.deleted.length;
      const failed = result.files.failed.length;
      if (scope === "code") {
        this.pushNotice(
          failed > 0
            ? `Files restored with ${failed} failure${failed === 1 ? "" : "s"}.`
            : fileCount > 0
              ? `Restored ${fileCount} file${fileCount === 1 ? "" : "s"}.`
              : "No tracked file edits to undo.",
        );
      } else {
        const fileSuffix = scope === "all"
          ? failed > 0
            ? ` · ${failed} file restore failure${failed === 1 ? "" : "s"}`
            : fileCount > 0
              ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"} restored`
              : " · no tracked file edits"
          : "";
        this.pushNotice(`Reverted conversation${fileSuffix}`);
      }
      this.renderSnapshot();
    } catch (error) {
      if (this.rewindPhase?.component !== component) return;
      component.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private closeRewindPicker(restoreDraft: boolean, replacementText?: string, render = true): void {
    const phase = this.rewindPhase;
    if (!phase) return;
    this.composerSlot.removeChild(phase.component);
    this.composerSlot.addChild(this.editor);
    this.rewindPhase = null;
    this.rewindPreviewMessageIndex = undefined;
    if (restoreDraft || replacementText !== undefined) {
      this.editor.setText(restoreDraft ? phase.draft : replacementText ?? "");
    }
    if (restoreDraft) {
      this.viewportScroll?.scrollTo(phase.previousScrollTop, { disableFollow: true });
    }
    this.tui.setFocus(this.editor);
    if (render) this.renderSnapshot();
  }

  private previewRewindPoint(point: RewindPickerPoint | undefined, scope: RewindScope): void {
    if (!point) {
      this.rewindPreviewMessageIndex = undefined;
      this.renderSnapshot();
      return;
    }
    const transcript = this.options.controller.getTranscript();
    const userIndexes = transcript
      .map((message, index) => message.role === "user" ? index : -1)
      .filter((index) => index >= 0);
    const turnCount = this.options.controller.getSessionManager().listUserTurns().length;
    const relevantUsers = userIndexes.slice(Math.max(0, userIndexes.length - turnCount));
    const messageIndex = relevantUsers[point.turnIndex];
    this.rewindPreviewMessageIndex = scope === "code" ? undefined : messageIndex;

    if (messageIndex !== undefined && this.viewportScroll) {
      const columns = this.tui.terminal.columns || process.stdout.columns || 80;
      const rowsBefore = this.welcome.render(columns).length + projectTranscript(
        transcript.slice(0, messageIndex),
        { ...this.transcriptRenderOptions(), columns, trailingSpacer: false, dimFromMessageIndex: undefined },
      ).rows.length;
      const centeredTop = rowsBefore - Math.floor(this.viewportScroll.viewportHeight / 2);
      this.viewportScroll.scrollTo(centeredTop, { disableFollow: true });
    }
    this.renderSnapshot();
  }

  private async planDialog(plan: string): Promise<boolean> {
    const preview = new Text(plan.split("\n").slice(0, 10).join("\n"), 1, 0);
    const choice = await this.selectOverlay(
      [
        { value: "approve", label: "Approve", description: "Proceed with the plan" },
        { value: "reject", label: "Reject", description: "Reject and ask for changes" },
      ],
      "Plan approval — Enter to confirm, Esc to reject",
      preview,
    );
    return choice?.value === "approve";
  }

  private openWorkflowInspector(item: WorkflowPaneItem): void {
    let handle: { hide(): void } | undefined;
    const getSnapshot = (): WorkflowInspectorSnapshot => {
      const workflow = this.options.controller.getWorkflows().find((candidate) => candidate.runId === item.id);
      const group = this.options.controller.getSubagentGroups().find((candidate) => (
        candidate.kind === "workflow" && (candidate.runId === item.id || candidate.id === item.id)
      ));
      const members = workflow?.snapshots.length
        ? workflow.snapshots.map((snapshot) => ({
            subAgentId: snapshot.agentId,
            agentName: snapshot.agentName,
            nickname: snapshot.nickname,
            status: snapshot.status,
            category: snapshot.category,
            phase: snapshot.phase,
            route: snapshot.route,
            task: snapshot.task,
            summary: snapshot.summary,
            toolNotes: snapshot.toolNotes,
            error: snapshot.error,
            usage: snapshot.usage,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
          }))
        : group?.members ?? item.members;
      return {
        id: item.id,
        title: workflow?.title ?? group?.label ?? item.title,
        status: workflow?.status ?? item.status,
        members,
        createdAt: workflow?.createdAt ?? item.createdAt,
        updatedAt: workflow?.updatedAt ?? item.updatedAt,
      };
    };
    const component = new WorkflowInspectorComponent({
      getSnapshot,
      getTerminalRows: () => this.tui.terminal.rows,
      onClose: () => handle?.hide(),
      onOpenAgent: (agentId) => {
        handle?.hide();
        const member = getSnapshot().members.find((candidate) => candidate.subAgentId === agentId);
        if (!member) return;
        this.openSubagentInspector({
          kind: "subagent",
          id: agentId,
          title: member.nickname ?? member.agentName ?? "subagent",
          status: member.status ?? "running",
          member,
        }, () => this.openWorkflowInspector(item));
      },
      onStop: (runId) => this.options.controller.stopWorkflow(runId),
      onRender: () => this.renderSnapshot(),
    });
    handle = this.tui.showOverlay(component, {
      width: "100%",
      maxHeight: "100%",
      margin: 1,
    });
    this.tui.setFocus(component);
  }

  private openSubagentInspector(item: SubagentPaneItem, onClose?: () => void): void {
    let handle: { hide(): void } | undefined;
    const allAgentIds = () => this.options.controller.getSubagentGroups()
      .flatMap((group) => group.members)
      .map((member) => member.subAgentId)
      .filter((id): id is string => !!id);
    const close = () => {
      handle?.hide();
      onClose?.();
    };
    const component = new SubagentInspectorComponent({
      agentId: item.id,
      controller: this.options.controller,
      getMember: () => this.options.controller.getSubagentGroups()
        .flatMap((group) => group.members)
        .find((member) => member.subAgentId === item.id) ?? item.member,
      getTerminalRows: () => this.tui.terminal.rows,
      renderOptions: () => this.transcriptRenderOptions(),
      onClose: close,
      onNavigate: (direction) => {
        const ids = allAgentIds();
        const current = ids.indexOf(item.id);
        if (current < 0 || ids.length < 2) return;
        const nextId = ids[(current + direction + ids.length) % ids.length]!;
        const member = this.options.controller.getSubagentGroups().flatMap((group) => group.members).find((candidate) => candidate.subAgentId === nextId);
        if (!member) return;
        handle?.hide();
        this.openSubagentInspector({
          kind: "subagent",
          id: nextId,
          title: member.nickname ?? member.agentName ?? "subagent",
          status: member.status ?? "running",
          member,
        }, onClose);
      },
      onRender: () => this.renderSnapshot(),
    });
    handle = this.tui.showOverlay(component, {
      width: "100%",
      maxHeight: "100%",
      margin: 1,
    });
    this.tui.setFocus(component);
  }

  private handleTraceAction(action: TraceAction): void {
    if (action.kind !== "open-subagent") return;
    const member = this.options.controller.getSubagentGroups()
      .flatMap((group) => group.members)
      .find((candidate) => candidate.subAgentId === action.subAgentId);
    if (!member) return;
    this.openSubagentInspector({
      kind: "subagent",
      id: action.subAgentId,
      title: member.nickname ?? member.agentName ?? "subagent",
      status: member.status ?? "running",
      member,
    });
  }

  private openTaskInspector(item: TaskPaneItem): void {
    let handle: { hide(): void } | undefined;
    const component = new TaskInspectorComponent({
      id: item.id,
      title: item.title,
      getStatus: () => this.options.controller.getBackgroundTasks().find((task) => task.id === item.id)?.status ?? item.status,
      getOutput: () => this.options.controller.getBackgroundTaskOutput(item.id),
      getTerminalRows: () => this.tui.terminal.rows,
      onClose: () => handle?.hide(),
      onStop: () => this.options.controller.stopBackgroundTask(item.id),
      onRender: () => this.renderSnapshot(),
    });
    handle = this.tui.showOverlay(component, {
      width: "100%",
      maxHeight: "100%",
      margin: 1,
    });
    this.tui.setFocus(component);
  }

  private approvalDialog(request: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = new ApprovalDialogComponent(request, () => this.tui.terminal.rows);
      const handle = this.tui.showOverlay(dialog, {
        anchor: "bottom-center",
        width: "100%",
        margin: { left: 1, right: 1 },
      });
      const finish = (choice: ApprovalDialogChoice) => {
        handle.hide();
        if (choice === "approve_always") {
          this.options.agent.setMode("bypassPermissions");
        }
        resolve(choice === "approve_once" || choice === "approve_always");
      };
      dialog.onSelect = finish;
      dialog.onCancel = () => finish("reject");
      this.tui.setFocus(dialog);
    });
  }

  private openNextQuestion(): void {
    if (this.disposed || this.activeQuestion) return;
    const request = this.questionQueue.shift();
    if (!request) return;
    const questionController = this.options.questionController;
    if (!questionController) return;
    const dialog = new QuestionDialogComponent(request, () => this.tui.terminal.rows);
    const handle = this.tui.showOverlay(dialog, {
      anchor: "bottom-center",
      width: "100%",
      margin: { left: 1, right: 1 },
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      handle.hide();
      if (this.activeQuestion?.id === request.id) this.activeQuestion = null;
      this.openNextQuestion();
    };
    this.activeQuestion = { id: request.id, close };
    dialog.onSubmit = (answers) => {
      close();
      questionController.reply(request.id, answers);
    };
    dialog.onCancel = () => {
      close();
      questionController.reject(request.id);
    };
    this.tui.setFocus(dialog);
  }

  private removeQueuedQuestion(id: string): void {
    const index = this.questionQueue.findIndex((request) => request.id === id);
    if (index >= 0) this.questionQueue.splice(index, 1);
  }

  // ---- Lifecycle ----------------------------------------------------------

  start(): void {
    this.tui.start();
    this.renderSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controllerUnsubscribe?.();
    this.controllerUnsubscribe = null;
    this.metadataUnsubscribe?.();
    this.metadataUnsubscribe = null;
    this.metadataManager = null;
    this.questionUnsubscribe?.();
    this.questionUnsubscribe = null;
    this.activeQuestion?.close();
    this.activeQuestion = null;
    this.questionQueue.length = 0;
    if (this.providerKeyPhase) {
      this.providerKeyPhase.input.setValue("");
      this.providerKeyPhase = null;
    }
    this.options.questionController?.rejectAll();
    // Root lifecycle events (notably SIGTERM) can dispose the app while the
    // alternate screen is still open. Tear it down directly so its controller
    // listener, spinner timers, and terminal mode cannot outlive the root app.
    this.fullscreen?.dispose();
    this.fullscreen = null;
    this.streamingMessage.dispose();
    this.tasksPane.dispose();
    this.options.controller.shutdown("user-quit");
    this.overlays.dispose();
    this.options.callbacks.onExitRequest();
    // The fullscreen frame is transient application chrome. Reprinting it
    // into the restored main buffer leaves the docked composer above the
    // post-session summary. Exit the alternate screen without exporting that
    // frame; regular mode keeps its native scrollback behavior unchanged.
    this.tui.stop({ preserveScreen: this.tui.mode === "fullscreen" });
  }

  async waitUntilExit(): Promise<void> {
    await new Promise<void>((resolve) => {
      const original = this.dispose.bind(this);
      this.dispose = () => {
        original();
        resolve();
      };
    });
  }
}

void ({} as Component | undefined);
