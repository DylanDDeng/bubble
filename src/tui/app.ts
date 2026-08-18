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
  TuiMainScreen,
  Text,
  VStack,
  SelectList,
  Editor,
  Loader,
  Markdown,
  type MarkdownTheme,
  type SelectItem,
  type TUI,
  type Component,
} from "@bubblebrain-ai/pi-tui";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";
import { BubbleTuiController } from "./controller/controller.js";
import { OverlayRequestController } from "./controller/overlay-controller.js";
import { renderTranscript, defaultTranscriptTheme } from "./components/transcript.js";
import { formatContextUsageLabel, friendlyCwd, sessionBasename } from "./formatting/summary.js";
import type { Agent } from "../agent.js";
import type { SessionManager } from "../session.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { QuestionController, QuestionEvent } from "../question/controller.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { DisplayMessage } from "./model/display-history.js";

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
  skillRegistry?: unknown;
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
  private readonly streamBox = new VStack([]);
  private readonly markdown = new Markdown("", 0, 0, MD_THEME);
  private readonly loader: Loader;
  private readonly footer = new Text("", 1, 0);
  private readonly welcomeBox = new VStack([]);
  private readonly overlays: OverlayRequestController;
  private readonly history: string[] = [];
  private showReasoning = false;
  private verboseTrace = false;
  private queuedCount = 0;
  private steerCount = 0;
  private disposed = false;

  constructor(private readonly options: PiTuiAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TuiMainScreen(terminal);
    this.editor = new Editor(this.tui, EDITOR_THEME);
    this.loader = new Loader(this.tui, (s) => chalk.cyan(s), (s) => chalk.dim(s), "Thinking…");
    this.overlays = new OverlayRequestController({ questionController: options.questionController });

    this.installBlockingHandlers();
    this.buildLayout();
    this.wireInput();
    this.renderWelcome();
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
      questionController.subscribe((event: QuestionEvent) => {
        if (event.type === "asked") {
          void this.questionDialog(event.request.id, event.request.questions.map((q) => q.question));
        }
      });
    }
  }

  private buildLayout(): void {
    this.tui.addChild(this.welcomeBox);
    this.tui.addChild(this.transcriptBox);
    this.tui.addChild(this.streamBox);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.footer);
    this.tui.setFocus(this.editor);

    this.editor.onSubmit = (text: string) => this.handleSubmit(text);
    this.options.controller.subscribe(() => this.renderSnapshot());
  }

  private wireInput(): void {
    let ctrlCArmed = false;
    this.tui.addInputListener((data: string) => {
      if (data === "\x03") {
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
      this.steerCount += 1;
      void controller.runTurn(trimmed, process.cwd()).finally(() => this.renderSnapshot());
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
      void this.enterFullscreen();
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
      options.controller.appendDisplayMessage({ key: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role, content });
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
    this.appendTranscriptRow({ key: `notice-${Date.now()}`, role: "assistant", content: text });
  }

  private appendTranscriptRow(message: DisplayMessage): void {
    this.options.controller.appendDisplayMessage(message);
  }

  private renderWelcome(): void {
    const { agent, updateNotice } = this.options;
    const session = sessionBasename(this.options.sessionManager.getSessionFile());
    const rows = [
      new Text(chalk.cyan("Bubble") + chalk.dim(` · pi-tui · ${agent.model}`), 1, 0),
      new Text(chalk.dim(`cwd ${friendlyCwd(process.cwd())}${session ? ` · session ${session}` : ""}`), 1, 0),
    ];
    if (updateNotice) rows.push(new Text(chalk.yellow(updateNotice), 1, 0));
    rows.push(new Text("", 1, 0));
    this.welcomeBox.children.length = 0;
    for (const row of rows) this.welcomeBox.addChild(row);
  }

  /** Rows already committed to the append-only scrollback stream. */
  private committedRows = 0;
  private streamingActive = false;

  renderSnapshot(): void {
    if (this.disposed) return;
    const columns = this.tui.terminal.columns || process.stdout.columns || 80;
    const transcript = this.options.controller.getTranscript();
    const rows = renderTranscript(transcript, {
      columns,
      showReasoning: this.showReasoning,
      verboseTrace: this.verboseTrace,
      theme: defaultTranscriptTheme,
      markdownRenderer: (text, width) => {
        this.markdown.setText(text);
        return this.markdown.render(width);
      },
    });

    // TuiMainScreen is append-only: settled rows commit to scrollback exactly
    // once. Rebuilding the whole box on every notify would re-emit them
    // (the duplicated-message bug). So: append only new trailing rows.
    if (rows.length > this.committedRows) {
      for (const row of rows.slice(this.committedRows)) {
        this.transcriptBox.addChild(new Text(row, 0, 0));
      }
      this.committedRows = rows.length;
    } else if (rows.length < this.committedRows) {
      // /clear: the stream restarts from scratch.
      this.transcriptBox.children.length = 0;
      this.committedRows = 0;
      for (const row of rows) this.transcriptBox.addChild(new Text(row, 0, 0));
      this.committedRows = rows.length;
    }
    this.renderStreamingTail(columns);
    this.footer.setText(this.renderFooterLine(columns));
    this.tui.requestRender();
  }

  /**
   * Live streaming region between the committed transcript and the composer.
   * Rebuilt freely each flush — it stays inside the viewport (clamped tail),
   * so the main-screen renderer updates it in place and never commits it to
   * scrollback; the full content commits once at turn end instead.
   */
  private renderStreamingTail(columns: number): void {
    const controller = this.options.controller;
    const tail = controller.isRunning() ? controller.getStreamingTail() : null;

    if (!tail) {
      if (this.streamingActive) {
        this.streamingActive = false;
        this.loader.stop();
        this.tui.removeChild(this.loader);
        this.streamBox.children.length = 0;
      }
      return;
    }

    if (!this.streamingActive) {
      this.streamingActive = true;
      this.tui.addChild(this.loader); // loader lands above the editor
      this.loader.start();
    }

    const status = tail.content
      ? "Streaming…"
      : tail.toolCount > 0 && tail.lastToolName
        ? `Running ${tail.lastToolName}…`
        : tail.reasoning
          ? "Thinking…"
          : "Connecting…";
    this.loader.setMessage(status);

    const previewRows = Math.max(2, Math.min(8, (this.tui.terminal.rows || 24) - 8));
    const lines: string[] = [];
    if (tail.reasoning && !tail.content) {
      const clamped = tail.reasoning.split("\n").slice(-2);
      for (const line of clamped) lines.push(chalk.dim(`  ${line.slice(0, columns - 4)}`));
    }
    if (tail.content) {
      this.markdown.setText(tail.content);
      const rendered = this.markdown.render(Math.max(20, columns - 4));
      if (rendered.length > previewRows) {
        lines.push(chalk.dim("  …"));
        lines.push(...rendered.slice(-previewRows));
      } else {
        lines.push(...rendered);
      }
    }
    if (tail.toolCount > 0 && tail.lastToolName && !tail.content) {
      lines.push(chalk.dim(`  ⚙ ${tail.lastToolName} (tool ${tail.toolCount})`));
    }

    this.streamBox.children.length = 0;
    for (const line of lines) this.streamBox.addChild(new Text(line, 0, 0));
  }

  private renderFooterLine(columns: number): string {
    const { agent } = this.options;
    const usage = formatContextUsageLabel(agent.getContextUsageSnapshot());
    const cwd = friendlyCwd(process.cwd());
    const parts = [chalk.cyan(agent.model), chalk.dim(cwd), chalk.dim(usage)];
    if (this.steerCount) parts.push(chalk.yellow(`steer ×${this.steerCount}`));
    if (this.queuedCount) parts.push(chalk.yellow(`queue ×${this.queuedCount}`));
    const line = parts.join(chalk.dim(" │ "));
    return line.length > columns ? line.slice(0, columns) : line;
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

  private selectOverlay(items: SelectItem[], title: string): Promise<SelectItem | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, 8, EDITOR_THEME.selectList, {});
      const header = new Text(chalk.cyan(title), 1, 0);
      const box = new VStack([header, list]);
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
    this.tui.showOverlay(new VStack([preview]), { anchor: "center" });
    const choice = await this.selectOverlay(
      [
        { value: "approve", label: "Approve", description: "Proceed with the plan" },
        { value: "reject", label: "Reject", description: "Reject and ask for changes" },
      ],
      "Plan approval — Enter to confirm, Esc to reject",
    );
    return choice?.value === "approve";
  }

  private async approvalDialog(_request: ApprovalRequest): Promise<boolean> {
    const title = chalk.cyan("Tool approval");
    const choice = await this.selectOverlay(
      [
        { value: "approve", label: "Allow once" },
        { value: "always", label: "Always allow" },
        { value: "reject", label: "Deny" },
      ],
      title,
    );
    return choice?.value === "approve" || choice?.value === "always";
  }

  private async questionDialog(id: string, questions: string[]): Promise<void> {
    const questionController = this.options.questionController;
    if (!questionController) return;
    const answers: string[][] = [];
    for (const question of questions) {
      const answer = await this.textOverlay(`? ${question}`);
      answers.push([(answer ?? "").trim()].filter((line) => line.length > 0));
    }
    questionController.reply(id, answers);
  }

  private textOverlay(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const header = new Text(chalk.cyan(prompt), 1, 0);
      const input = new Editor(this.tui, EDITOR_THEME);
      const box = new VStack([header, input]);
      const handle = this.tui.showOverlay(box, { anchor: "center" });
      input.onSubmit = (text: string) => {
        handle.hide();
        resolve(text);
      };
      this.tui.setFocus(input);
    });
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
    this.options.controller.shutdown("user-quit");
    this.overlays.dispose();
    this.options.callbacks.onExitRequest();
    this.tui.stop();
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
