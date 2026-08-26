/**
 * Startup `--resume` session picker on the vendored pi-tui renderer —
 * replaces src/tui-ink/run-session-picker.tsx at cutover. Same contract:
 * resolve the chosen session file, or undefined on cancel.
 */
import { Box, ProcessTerminal, TuiMainScreen, Text, VStack, SelectList, type SelectItem } from "@bubblebrain-ai/pi-tui";
import { SessionSummary } from "../session.js";
import { paletteFor } from "./model/theme.js";
import { themeBackground, themeDim, themeForeground } from "./model/theme-style.js";


export interface RunSessionPickerOptions {
  currentCwd: string;
  currentSessions: SessionSummary[];
  allSessions: SessionSummary[];
  resolvedTheme?: "light" | "dark";
  themeOverrides?: Record<string, string>;
}

export async function runSessionPicker(options: RunSessionPickerOptions): Promise<string | undefined> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const theme = paletteFor(options.resolvedTheme ?? "dark", options.themeOverrides);

  const items: SelectItem[] = [];
  for (const summary of options.currentSessions.slice(0, 10)) {
    items.push({
      value: summary.file,
      label: summary.title ?? summary.file.split("/").pop() ?? summary.file,
      description: "this project",
    });
  }
  const otherCount = options.allSessions.length - options.currentSessions.length;
  if (otherCount > 0) {
    for (const summary of options.allSessions.filter((s) => !options.currentSessions.includes(s)).slice(0, 10)) {
      items.push({
        value: summary.file,
        label: summary.title ?? summary.file.split("/").pop() ?? summary.file,
        description: "other project",
      });
    }
  }
  if (items.length === 0) return undefined;

  return new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined) => {
      try {
        tui.stop();
      } catch {
        /* already stopped */
      }
      resolve(value);
    };

    const header = new VStack([
      new Text(themeForeground(theme.accent, "Resume session"), 1, 0),
      new Text(themeDim(theme.dim, "Enter to select · Esc to start fresh"), 1, 0),
    ]);
    const list = new SelectList(items, 10, {
      selectedPrefix: () => themeForeground(theme.accent, "› "),
      selectedText: (str: string) => themeForeground(theme.inputText, str),
      description: (str: string) => themeDim(theme.dim, str),
      scrollInfo: (str: string) => themeDim(theme.dim, str),
      noMatch: (str: string) => themeDim(theme.dim, str),
    }, {});
    const content = new VStack([header, list]);
    const box = theme.background
      ? new Box(0, 0, (text) => themeBackground(theme.background, text))
      : new Box(0, 0);
    box.addChild(content);

    list.onSelect = (item) => finish(item.value);
    list.onCancel = () => finish(undefined);

    tui.addChild(box);
    tui.start();
    tui.setFocus(list);
  });
}
