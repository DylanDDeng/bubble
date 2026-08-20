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
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";
import { BubbleTuiController } from "./controller/controller.js";
import { OverlayRequestController } from "./controller/overlay-controller.js";
import { defaultTranscriptTheme, type TranscriptRenderOptions } from "./components/transcript.js";
import { friendlyCwd, sessionBasename } from "./formatting/summary.js";
import { ResponsiveFooterComponent } from "./footer.js";
import { ComposerAutocompleteProvider } from "./composer-autocomplete.js";
import { COMPOSER_EDITOR_OPTIONS, COMPOSER_EDITOR_THEME } from "./composer-style.js";
import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { QuestionController, QuestionEvent, QuestionRequest } from "../question/controller.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { DisplayMessage } from "./model/display-history.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseSkillInvocation } from "../skills/invocation.js";
import { getNextPermissionMode } from "../permission/mode.js";

export interface PiAppCallbacks {
  onExitRequest(): void;
  onClearTranscript(): void;
  onModelSelect(modelId: string): void;
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
  private readonly transcriptBox = new VStack([]);
  private readonly streamingMessage = new StreamingMessageComponent(8, () => this.tui.requestRender());
  private readonly markdown = new Markdown("", 0, 0, MD_THEME);
  private readonly settledTranscript: ResponsiveTranscriptComponent;
  private readonly welcome: WelcomeBannerComponent;
  private readonly footer: ResponsiveFooterComponent;
  private readonly overlays: OverlayRequestController;
  private readonly history: string[] = [];
  private showReasoning = false;
  private verboseTrace = false;
  private controllerUnsubscribe: (() => void) | null = null;
  private questionUnsubscribe: (() => void) | null = null;
  private activeQuestion: { id: string; close: () => void } | null = null;
  private readonly questionQueue: QuestionRequest[] = [];
  private disposed = false;

  constructor(private readonly options: PiTuiAppOptions) {
    const terminal = options.terminal ?? new ProcessTerminal();
    // Pick the renderer before start(). Entering fullscreen after the regular
    // renderer has painted necessarily exposes a main-screen frame first.
    // Constructing TuiAltScreen here makes its 1049h transition the first UI
    // write and keeps the entire product surface on one application instance.
    this.tui = (options.uiMode ?? "fullscreen") === "fullscreen"
      ? new TuiAltScreen(terminal)
      : new TuiMainScreen(terminal);
    this.editor = new Editor(this.tui, COMPOSER_EDITOR_THEME, COMPOSER_EDITOR_OPTIONS);
    this.editor.setAutocompleteProvider(new ComposerAutocompleteProvider({
      cwd: process.cwd(),
      commands: () => slashRegistry.list(),
      skills: () => this.options.skillRegistry?.summaries() ?? [],
      uiMode: () => this.tui.mode,
    }));
    this.settledTranscript = new ResponsiveTranscriptComponent(() => ({
      messages: this.options.controller.getTranscript(),
      options: this.transcriptRenderOptions(),
    }));
    this.welcome = new WelcomeBannerComponent(() => {
      const { agent, updateNotice } = this.options;
      return {
        cwd: friendlyCwd(process.cwd()),
        session: sessionBasename(this.options.sessionManager.getSessionFile()),
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
      return {
        agent: this.options.agent,
        cwd: friendlyCwd(process.cwd()),
        extra,
        mode: this.options.agent.mode,
        // At two rows or fewer, preserve the focused editor body + border.
        hidden: this.tui.terminal.rows <= 2,
      };
    });
    this.overlays = new OverlayRequestController({ questionController: options.questionController });

    this.installBlockingHandlers();
    this.buildLayout();
    this.wireInput();
    this.renderSnapshot();
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
    if (isViewportTUI(this.tui)) {
      // Fullscreen owns a bounded viewport. History scrolls while the composer
      // and footer stay docked. The activity lane is a permanent one-row
      // boundary: spinner text changes, its geometry never does.
      const document = new VStack([this.welcome, this.transcriptBox]);
      const scroll = new ScrollView(document, { follow: "end", primary: true });
      this.tui.setLayoutRoot(new VStack([
        { component: scroll, basis: 0, grow: 1, minSize: 0 },
        { component: this.streamingMessage.activityLane, basis: "auto", shrink: 0 },
        { component: this.editor, basis: "auto", shrink: 0 },
        { component: this.footer, basis: "auto", shrink: 0 },
      ]));
    } else {
      this.tui.addChild(this.welcome);
      this.tui.addChild(this.transcriptBox);
      this.tui.addChild(this.streamingMessage.activityLane);
      this.tui.addChild(this.editor);
      this.tui.addChild(this.footer);
    }
    this.tui.setFocus(this.editor);

    this.editor.onSubmit = (text: string) => this.handleSubmit(text);
    this.controllerUnsubscribe = this.options.controller.subscribe(() => this.renderSnapshot());
  }

  private wireInput(): void {
    let ctrlCArmed = false;
    this.tui.addInputListener((data: string) => {
      // Global shortcuts act on key presses only. Kitty keyboard protocol also
      // reports releases; allowing those through can trigger a shortcut twice.
      if (isKeyRelease(data)) return { consume: true };
      // Modal dialogs own their complete keyboard contract. In particular,
      // an approval arrives while a run is active, so letting the global
      // Escape/Ctrl+C handler run first would cancel the agent and strand the
      // unresolved permission request instead of rejecting the dialog.
      if (this.tui.hasOverlay()) return undefined;
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
      if (matchesKey(data, "ctrl+c")) {
        // Match Ink: the first Ctrl+C interrupts the active run. Requiring a
        // second keypress here made cancellation feel like a quit gesture and
        // left the tool trace running behind the composer.
        if (this.options.controller.cancelActiveRun()) {
          ctrlCArmed = false;
          return { consume: true };
        }
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
    const ctx = this.buildSlashContext();
    const outcome = await slashRegistry.execute(`/${name}${args ? ` ${args}` : ""}`, ctx);
    if (outcome.inject) {
      // Command produced model-facing input (e.g. /rewind restore).
      void this.handleSubmit(outcome.inject);
    } else if (outcome.result) {
      this.pushNotice(outcome.result);
    } else if (!outcome.handled) {
      this.pushNotice(`Unknown command: /${name}`);
    }
    this.renderSnapshot();
  }

  private buildSlashContext(): SlashCommandContext {
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
      sessionManager: options.sessionManager as never,
      createProvider: options.createProvider as never,
      openPicker: (mode) => {
        if (mode === "model") void this.modelPicker();
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
      openStats: () => this.pushNotice("stats panel: coming to the pi TUI"),
      openRewindPicker: () => this.pushNotice("rewind picker: coming to the pi TUI"),
      openSessionPicker: () => this.pushNotice("session picker: coming to the pi TUI"),
      compactionProgress: () => {},
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
      theme: defaultTranscriptTheme,
      markdownRenderer: (text, width) => {
        this.markdown.setText(text);
        return this.markdown.render(width);
      },
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

    if (tail) {
      if (!this.streamingMounted) {
        this.streamingMounted = true;
        this.streamingMessage.startSpinner();
      }
      this.streamingMessage.noteWidth(columns);
      this.streamingMessage.update(tail, columns, this.transcriptRenderOptions());
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

  private async modelPicker(): Promise<void> {
    const registry = this.options.registry;
    if (!registry) {
      this.pushNotice("model registry unavailable");
      this.renderSnapshot();
      return;
    }
    const providers = registry.getConfigured().filter((provider) => provider.enabled && provider.apiKey);
    const items: SelectItem[] = [];
    for (const provider of providers) {
      const discovery = await registry.listModels(provider).catch(() => []);
      for (const model of discovery) {
        items.push({ value: model.id, label: model.name ?? model.id, description: provider.id });
      }
    }
    if (items.length === 0) {
      this.pushNotice("no models registered");
      this.renderSnapshot();
      return;
    }
    const choice = await this.selectOverlay(items, "Select model");
    if (choice) this.options.callbacks.onModelSelect(choice.value);
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
    this.questionUnsubscribe?.();
    this.questionUnsubscribe = null;
    this.activeQuestion?.close();
    this.activeQuestion = null;
    this.questionQueue.length = 0;
    this.options.questionController?.rejectAll();
    // Root lifecycle events (notably SIGTERM) can dispose the app while the
    // alternate screen is still open. Tear it down directly so its controller
    // listener, spinner timers, and terminal mode cannot outlive the root app.
    this.fullscreen?.dispose();
    this.fullscreen = null;
    this.streamingMessage.dispose();
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
