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
  matchesKey,
  isKeyRelease,
} from "@bubblebrain-ai/pi-tui";
import { ResponsiveTranscriptComponent } from "./components/responsive-transcript.js";
import { StreamingMessageComponent } from "./components/streaming-message.js";
import { defaultTranscriptTheme, type TranscriptRenderOptions } from "./components/transcript.js";
import type { BubbleTuiController } from "./controller/controller.js";
import { ResponsiveFooterComponent } from "./footer.js";
import { getNextPermissionMode } from "../permission/mode.js";
import type { Agent } from "../agent.js";
import { COMPOSER_EDITOR_OPTIONS, COMPOSER_EDITOR_THEME } from "./composer-style.js";
import { TraceInteractionState } from "./model/trace-interaction.js";

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
}

export class FullscreenApp {
  private readonly tui: TuiAltScreen;
  private readonly transcript: ResponsiveTranscriptComponent;
  private readonly streamingMessage: StreamingMessageComponent;
  private readonly editor: Editor;
  private readonly footer: ResponsiveFooterComponent;
  private readonly traceInteraction: TraceInteractionState;
  private readonly unsubscribe: () => void;
  private showReasoning = false;
  private verboseTrace = false;
  private disposed = false;
  private streamingMounted = false;

  constructor(private readonly options: FullscreenAppOptions) {
    const terminal = options.terminal ?? new ProcessTerminal();
    this.traceInteraction = options.traceInteraction ?? new TraceInteractionState();
    // Trace hover depends on no-button pointer motion, including inside tmux.
    this.tui = new TuiAltScreen(terminal, undefined, undefined, { mouseMotion: "all" });
    this.editor = new Editor(this.tui, COMPOSER_EDITOR_THEME, COMPOSER_EDITOR_OPTIONS);
    this.transcript = new ResponsiveTranscriptComponent(() => ({
      messages: this.options.controller.getTranscript(),
      options: this.transcriptRenderOptions(),
    }));
    this.streamingMessage = new StreamingMessageComponent(8, () => this.render());
    this.footer = new ResponsiveFooterComponent(() => ({
      agent: this.options.agent,
      mode: this.options.agent.mode,
      goalLine: this.options.controller.getGoalIndicator?.(),
      hidden: this.tui.terminal.rows <= 2,
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
      { component: this.editor, basis: "auto", shrink: 0 },
      { component: this.footer, basis: "auto", shrink: 0 },
    ]);
    this.tui.setLayoutRoot(layout);
    this.tui.setFocus(this.editor);

    this.editor.onSubmit = (text: string) => {
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
        this.options.onExit();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        if (this.options.controller.cancelActiveRun()) {
          return { consume: true };
        }
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

  render(): void {
    if (this.disposed) return;
    const columns = this.tui.terminal.columns || process.stdout.columns || 80;
    const tail = this.options.controller.isRunning()
      ? this.options.controller.getStreamingTail()
      : null;
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
    this.tui.requestRender();
  }

  private transcriptRenderOptions(): Omit<TranscriptRenderOptions, "columns"> {
    return {
      theme: defaultTranscriptTheme,
      showReasoning: this.showReasoning,
      verboseTrace: this.verboseTrace,
      traceInteraction: this.traceInteraction,
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
