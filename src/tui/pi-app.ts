/**
 * Bubble pi-tui vertical slice (Phase 4).
 *
 * The smallest complete conversation loop on the vendored renderer:
 * welcome header, transcript, composer, submit, streaming tail, interrupt
 * (Ctrl+C), exit (double Ctrl+C). It consumes the extracted
 * BubbleTuiController — this file owns rendering only, no runtime logic.
 *
 * Launched exclusively by the e2e harness (BUBBLE_TUI=pi) until Phase 10's
 * cutover; the Ink TUI remains the default production entry point.
 */
import process from "node:process";
import { ProcessTerminal, TuiMainScreen, Text, VStack, type TUI } from "@bubblebrain-ai/pi-tui";
import { Editor } from "@bubblebrain-ai/pi-tui";
import { BubbleTuiController } from "./controller/controller.js";
import { isMultiplexedTerminalLike } from "./terminal/multiplexer.js";

export interface PiTuiAppOptions {
  controller: BubbleTuiController;
}

export interface PiTuiAppHandle {
  stop(): void;
  exited: Promise<void>;
}

export function startPiTuiApp(options: PiTuiAppOptions): PiTuiAppHandle {
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal);
  tui.start();

  const header = new Text("Bubble (pi-tui slice)", 1, 0);
  const transcriptBox = new VStack([]);
  const statusLine = new Text("ready", 1, 0);
  const editor = new Editor(tui, {
    borderColor: (str: string) => str,
    selectList: {
      selectedPrefix: () => "› ",
      selectedText: (str: string) => str,
      description: (str: string) => str,
      scrollInfo: (str: string) => str,
      noMatch: (str: string) => str,
    },
  });

  editor.onSubmit = (text: string) => {
    if (!text.trim()) return;
    void options.controller.runTurn(text, process.cwd());
  };

  tui.addChild(header);
  tui.addChild(transcriptBox);
  tui.addChild(editor);
  tui.addChild(statusLine);
  tui.setFocus(editor);

  const renderSnapshot = () => {
    // Rebuild the transcript container: VStack exposes addChild/removeChild.
    for (const child of [...transcriptBox.children]) {
      transcriptBox.removeChild(child);
    }
    for (const message of options.controller.getTranscript()) {
      transcriptBox.addChild(new Text(message.content, 1, 0));
    }
    const running = options.controller.isRunning();
    statusLine.setText(
      running
        ? "streaming — Ctrl+C to interrupt, double Ctrl+C to exit"
        : "ready — Enter to send",
    );
    tui.requestRender();
  };

  options.controller.subscribe(renderSnapshot);
  renderSnapshot();

  let exitedResolve: () => void;
  const exited = new Promise<void>((resolve) => {
    exitedResolve = resolve;
  });
  let ctrlCArmed = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    options.controller.shutdown("user-quit");
    tui.stop();
    exitedResolve();
  };

  tui.addInputListener((data: string) => {
    if (data !== "\x03") return undefined;
    if (ctrlCArmed) {
      stop();
      return { consume: true };
    }
    ctrlCArmed = true;
    setTimeout(() => {
      ctrlCArmed = false;
    }, 1_500);
  });

  process.once("SIGTERM", stop);

  return { stop, exited };
}

void isMultiplexedTerminalLike;
