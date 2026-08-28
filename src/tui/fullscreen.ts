/**
 * Fullscreen (alternate-screen) mode on TuiAltScreen (rewrite/pi-tui).
 *
 * Complements the default main-screen chat flow: instead of appending to
 * scrollback, the whole transcript lives in a viewport with follow-end,
 * mouse-wheel scrolling, click-drag selection, and Ctrl+F transcript search
 * (all provided by TuiAltScreen + ScrollView). The composer stays docked at
 * the bottom via a layout root: [transcript scroll view, editor, footer].
 *
 * Toggle with /fullscreen; Escape exits back to the main screen.
 */
import process from "node:process";
import {
  ProcessTerminal,
  TuiAltScreen,
  type Terminal,
  VStack,
  ScrollView,
  Editor,
  Markdown,
  matchesKey,
  isKeyRelease,
} from "@bubblebrain-ai/pi-tui";
import { ResponsiveTranscriptComponent } from "./components/responsive-transcript.js";
import { StreamingMessageComponent } from "./components/streaming-message.js";
import { createTranscriptTheme, type TranscriptRenderOptions, type TranscriptTheme } from "./components/transcript.js";
import type { BubbleTuiController } from "./controller/controller.js";
import { ResponsiveFooterComponent } from "./footer.js";
import { getNextPermissionMode } from "../permission/mode.js";
import type { Agent } from "../agent.js";
import { COMPOSER_EDITOR_OPTIONS, createComposerEditorTheme } from "./composer-style.js";
import { TraceInteractionState } from "./model/trace-interaction.js";
import type { ComposerController } from "./controller/composer-controller.js";
import { ComposerImagePreviewComponent, ImageViewerComponent } from "./components/image-preview.js";
import { createAssistantMarkdownTheme } from "./markdown-style.js";
import { darkTheme, type Theme } from "./model/theme.js";
import { TuiAnimationClock } from "./animation-clock.js";

export interface FullscreenAppOptions {
  controller: BubbleTuiController;
  agent: Pick<Agent, "model" | "mode" | "setMode" | "getContextUsageSnapshot">;
  onExit(): void;
  /** Route non-mode slash commands through the main app's shared registry. */
  onCommand(command: string): void;
  /** Test/embedded host injection; production uses ProcessTerminal. */
  terminal?: Terminal;
  /** Preserve tool-group folds when switching from the regular renderer. */
  traceInteraction?: TraceInteractionState;
  /** Shared semantic composer state when transitioning from the main renderer. */
  composer?: ComposerController;
  /** Shared live palette when this view is entered from the regular renderer. */
  getTheme?: () => Theme;
}

export class FullscreenApp {
  private readonly tui: TuiAltScreen;
  private readonly transcript: ResponsiveTranscriptComponent;
  private readonly streamingMessage: StreamingMessageComponent;
  private readonly animationClock: TuiAnimationClock;
  private readonly editor: Editor;
  private readonly composerPreview?: ComposerImagePreviewComponent;
  private readonly footer: ResponsiveFooterComponent;
  private readonly traceInteraction: TraceInteractionState;
  private readonly markdown: Markdown;
  private readonly transcriptTheme: TranscriptTheme;
  private readonly markdownRenderer = (text: string, width: number): string[] => {
    this.markdown.setText(text);
    return this.markdown.render(width);
  };
  private readonly unsubscribe: () => void;
  private showReasoning = false;
  private verboseTrace = false;
  private disposed = false;
  private streamingMounted = false;

  constructor(private readonly options: FullscreenAppOptions) {
    const terminal = options.terminal ?? new ProcessTerminal();
    const getTheme = options.getTheme ?? (() => darkTheme);
    this.transcriptTheme = createTranscriptTheme(getTheme);
    this.markdown = new Markdown("", 0, 0, createAssistantMarkdownTheme(getTheme));
    this.traceInteraction = options.traceInteraction ?? new TraceInteractionState();
    // Trace hover depends on no-button pointer motion, including inside tmux.
    this.tui = new TuiAltScreen(terminal, undefined, undefined, { mouseMotion: "all" });
    this.editor = new Editor(this.tui, createComposerEditorTheme(getTheme), COMPOSER_EDITOR_OPTIONS);
    this.composerPreview = options.composer
      ? new ComposerImagePreviewComponent(() => options.composer?.previewAttachment(), getTheme)
      : undefined;
    this.transcript = new ResponsiveTranscriptComponent(
      () => ({
        messages: this.options.controller.getTranscript(),
        options: this.transcriptRenderOptions(),
      }),
      {
        onTraceAction: (action) => {
          if (action.kind !== "open-image") return;
          const message = this.options.controller.getTranscript().find((candidate) => candidate.key === action.messageKey);
          const image = message?.images?.find((candidate) => candidate.label === action.imageLabel);
          if (image) this.openImageViewer(image);
        },
      },
    );
    this.streamingMessage = new StreamingMessageComponent(
      8,
      () => this.tui.requestRender(),
      undefined,
      getTheme,
    );
    this.animationClock = new TuiAnimationClock((elapsedMs) => {
      if (this.streamingMessage.advanceAnimationFrame(elapsedMs)) this.tui.requestRender();
    });
    this.footer = new ResponsiveFooterComponent(() => ({
      agent: this.options.agent,
      mode: this.options.agent.mode,
      goalLine: this.options.controller.getGoalIndicator?.(),
      hidden: this.tui.terminal.rows <= 2,
      theme: getTheme(),
    }));
    this.buildLayout();
    this.unsubscribe = this.options.controller.subscribe(() => this.render());
  }

  private buildLayout(): void {
    // The live tail belongs inside the scrolling transcript. Its activity lane
    // stays docked above the composer and keeps one row both running and idle,
    // so clearing the spinner cannot pull settled content downward.
    const transcriptBody = new VStack([this.transcript, this.streamingMessage]);
    const scroll = new ScrollView(transcriptBody, { follow: "end", primary: true });
    const layout = new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 0 },
      { component: this.streamingMessage.activityLane, basis: "auto", shrink: 0 },
      ...(this.composerPreview ? [{ component: this.composerPreview, basis: "auto" as const, shrink: 0 }] : []),
      { component: this.editor, basis: "auto", shrink: 0 },
      { component: this.footer, basis: "auto", shrink: 0 },
    ]);
    this.tui.setLayoutRoot(layout);
    this.tui.setFocus(this.editor);

    if (this.options.composer) {
      this.options.composer.attachEditor(this.editor);
      this.options.composer.setOpenImageHandler((image) => this.openImageViewer(image));
    } else this.editor.onSubmit = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      this.editor.addToHistory(trimmed);
      if (trimmed === "/fullscreen" || trimmed === "/main") {
        this.options.onExit();
        return;
      }
      if (trimmed.startsWith("/")) {
        this.options.onCommand(trimmed);
        return;
      }
      if (this.options.controller.isRunning()) {
        this.options.controller.steer(trimmed);
      } else if (this.options.controller.queueAfterCommand?.(trimmed)) {
        this.render();
      } else {
        this.options.controller.appendDisplayMessage({ key: `user-${Date.now()}`, role: "user", content: trimmed });
        void this.options.controller.runTurn(trimmed, process.cwd());
      }
    };

    this.tui.addInputListener((data: string) => {
      // Kitty reports key releases separately. Global shortcuts must only run
      // on the press or Escape would cancel the run and exit on key-up.
      if (isKeyRelease(data)) return { consume: true };
      if (matchesKey(data, "shift+tab")) {
        this.options.agent.setMode(getNextPermissionMode(this.options.agent.mode));
        this.render();
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        if (this.options.controller.cancelActiveRun()) {
          return { consume: true };
        }
        if (this.options.controller.isBusy?.()) return { consume: true };
        this.options.onExit();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        if (this.options.controller.cancelActiveRun()) {
          return { consume: true };
        }
        if (this.options.controller.isBusy?.()) return { consume: true };
        this.options.onExit();
        return { consume: true };
      }
      if (data === "\x14") {
        this.showReasoning = !this.showReasoning;
        this.render();
        return { consume: true };
      }
      if (data === "\x0f") {
        this.verboseTrace = !this.verboseTrace;
        this.render();
        return { consume: true };
      }
      return undefined;
    });
  }

  private openImageViewer(image: import("./controller/composer-controller.js").ComposerDraftAttachment | import("./model/image-attachment.js").DisplayImageAttachment): void {
    let handle: { hide(): void } | undefined;
    const close = () => {
      handle?.hide();
      this.tui.setFocus(this.editor);
      this.render();
    };
    const component = new ImageViewerComponent(image, close, () => this.tui.terminal.rows, this.options.getTheme);
    handle = this.tui.showOverlay(component, {
      anchor: "center",
      width: "70%",
      minWidth: 36,
      maxWidth: 110,
      maxHeight: "85%",
      margin: 1,
      dismissOnOutsideClick: true,
    });
    this.tui.setFocus(component);
  }

  render(): void {
    if (this.disposed) return;
    const columns = this.tui.terminal.columns || process.stdout.columns || 80;
    const tail = this.options.controller.isRunning()
      ? this.options.controller.getStreamingTail()
      : null;
    const commandActivity = this.options.controller.getCommandActivity?.() ?? null;
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
    this.animationClock.setActive(this.streamingMessage.isAnimationActive());
    this.tui.requestRender();
  }

  private transcriptRenderOptions(): Omit<TranscriptRenderOptions, "columns"> {
    return {
      theme: this.transcriptTheme,
      showReasoning: this.showReasoning,
      verboseTrace: this.verboseTrace,
      traceInteraction: this.traceInteraction,
      markdownRenderer: this.markdownRenderer,
      // While running, this separates settled history from the live surface.
      // Once settled, the permanent blank activity lane owns the dock gap.
      trailingSpacer: this.options.controller.isRunning(),
    };
  }

  start(): void {
    this.tui.start();
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.animationClock.dispose();
    this.streamingMessage.dispose();
    // Returning to the host/main renderer must not copy the fullscreen dock
    // (composer + footer) into terminal scrollback.
    this.tui.stop({ preserveScreen: true });
  }

  async waitUntilExit(): Promise<void> {
    await new Promise<void>(() => {
      // Exit is driven by onExit (Escape/Ctrl+C//fullscreen); the promise
      // resolves via dispose() from the host.
    });
  }
}
