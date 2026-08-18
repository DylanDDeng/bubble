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
import chalk from "chalk";
import {
  ProcessTerminal,
  TuiAltScreen,
  Text,
  VStack,
  ScrollView,
  Editor,
} from "@bubblebrain-ai/pi-tui";
import { renderTranscript, defaultTranscriptTheme } from "./components/transcript.js";
import type { BubbleTuiController } from "./controller/controller.js";
import { renderFooterLine } from "./footer.js";

export interface FullscreenAppOptions {
  controller: BubbleTuiController;
  agent: { model: string; getContextUsageSnapshot(): { usedTokens: number; contextWindow?: number } };
  onExit(): void;
}

export class FullscreenApp {
  private readonly tui: TuiAltScreen;
  private readonly transcriptBox = new VStack([]);
  private readonly editor: Editor;
  private readonly footer = new Text("", 1, 0);
  private committedRows = 0;
  private disposed = false;

  constructor(private readonly options: FullscreenAppOptions) {
    const terminal = new ProcessTerminal();
    this.tui = new TuiAltScreen(terminal);
    this.editor = new Editor(this.tui, {
      borderColor: (str: string) => chalk.cyan.dim(str),
      selectList: {
        selectedPrefix: () => chalk.cyan("› "),
        selectedText: (str: string) => str,
        description: (str: string) => chalk.dim(str),
        scrollInfo: (str: string) => chalk.dim(str),
        noMatch: (str: string) => chalk.dim(str),
      },
    });
    this.buildLayout();
    this.options.controller.subscribe(() => this.render());
  }

  private buildLayout(): void {
    const scroll = new ScrollView(this.transcriptBox, { follow: "end", primary: true });
    const layout = new VStack([scroll, this.editor, this.footer]);
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
      this.options.controller.appendDisplayMessage({ key: `user-${Date.now()}`, role: "user", content: trimmed });
      void this.options.controller.runTurn(trimmed, process.cwd());
    };

    this.tui.addInputListener((data: string) => {
      if (data === "\x1b") {
        this.options.onExit();
        return { consume: true };
      }
      if (data === "\x03") {
        this.options.onExit();
        return { consume: true };
      }
      return undefined;
    });
  }

  render(): void {
    if (this.disposed) return;
    const columns = this.tui.terminal.columns || process.stdout.columns || 80;
    const rows = renderTranscript(this.options.controller.getTranscript(), {
      columns,
      theme: defaultTranscriptTheme,
    });
    // Fullscreen keeps the full document in the scroll view — unlike the
    // main screen there is no scrollback commit, so a rebuild is fine, but
    // appending only the delta keeps renders cheap.
    if (rows.length > this.committedRows) {
      for (const row of rows.slice(this.committedRows)) this.transcriptBox.addChild(new Text(row, 0, 0));
      this.committedRows = rows.length;
    } else if (rows.length < this.committedRows) {
      this.transcriptBox.children.length = 0;
      for (const row of rows) this.transcriptBox.addChild(new Text(row, 0, 0));
      this.committedRows = rows.length;
    }
    this.footer.setText(renderFooterLine(this.options.agent, columns));
    this.tui.requestRender();
  }

  start(): void {
    this.tui.start();
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tui.stop();
  }

  async waitUntilExit(): Promise<void> {
    await new Promise<void>(() => {
      // Exit is driven by onExit (Escape/Ctrl+C//fullscreen); the promise
      // resolves via dispose() from the host.
    });
  }
}
